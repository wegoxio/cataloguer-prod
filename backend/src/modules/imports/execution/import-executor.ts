import { BatchBudget } from './batch-budget';
import { CancellationToken, RunOutcome } from './cancellation';
import { CommittedCheckpoint, PlannedBatch, PlannedUnit, decideResume, planBatches } from './batch-planner';
import { ReportRow, buildReport, type ImportReport } from './import-report';
import { RowOutcome } from '../entities/import-row-result.entity';
import { EntityManager } from '@mikro-orm/postgresql';
import { assertInTransaction } from './tx';
import { HeartbeatPacer } from './batch-budget';

/**
 * Running an approved plan.
 *
 * The orchestration is deliberately separated from everything it talks to — the
 * database, the lease, the code that actually writes a product — because the
 * bugs that matter here are all in the ORDER of things, not in any one step.
 * Whether a checkpoint is written before or after a commit, whether the lease
 * is beaten inside or outside a transaction, whether a resumed run trusts a
 * counter or the checkpoints: those are the questions, and they are answerable
 * without a database.
 *
 * The invariants the whole thing exists to hold:
 *
 *  1. **A committed batch is never re-applied.** Not because a counter says so —
 *     a worker that died after committing but before updating a counter would
 *     redo it — but because its checkpoint exists.
 *  2. **The checkpoint commits WITH the batch**, in the same transaction. A
 *     checkpoint written afterwards can be lost between the two, and then the
 *     batch runs twice.
 *  3. **The lease is beaten only outside a transaction**, or the renewal is
 *     invisible to the reaper until the transaction commits.
 *  4. **Every row gets a result**, including rows the run never reached. A row
 *     with no result is a row nobody can answer a question about.
 */

/** What one atomic unit did, as the applier reports it. */
/**
 * What one row actually did, thing by thing.
 *
 * A row reporting `CREATED` used to mean "a product was created" and nothing
 * more — which is how a run created a product, listed it in no shop, assigned
 * no category, and reported success. Each effect now states its own outcome, so
 * silence stops being indistinguishable from success.
 *
 * Names, not identifiers: this is read by the person who ran the import.
 */
export type EffectState =
  | 'CREATED'
  | 'UPDATED'
  | 'UNCHANGED'
  | 'EXISTING'
  | 'NOT_REQUESTED'
  | 'ZERO_NO_MOVEMENT'
  | 'BLOCKED'
  | 'ROLLED_BACK';

export interface RowEffects {
  product?: { state: EffectState; sku?: string | null };
  storeAssociation?: {
    state: EffectState;
    storeName?: string | null;
    /** Always false: an import never publishes. A constant, not a setting. */
    published: false;
  };
  categories?: {
    state: EffectState;
    /** Paths this import CREATED because they did not exist. */
    created?: string[];
    /** Paths that already existed and were reused. */
    reused?: string[];
    /** Paths linked to this product by this row. */
    associated?: string[];
    /** Paths that could not be applied. */
    blocked?: string[];
  };
  inventory?: {
    state: EffectState;
    locationName?: string | null;
    locationKind?: string | null;
    quantity?: number;
  };
}

export interface RowApplication {
  sourceRow: number;
  outcome: RowOutcome;
  targetType?: string | null;
  targetId?: string | null;
  matchProvenance?: string | null;
  reason?: string | null;
  /** What happened to each thing this row touched. */
  effects?: RowEffects | null;
}

export interface ApplyContext {
  organizationId: string;
  executionId: string;
  importType: string;
  /**
   * The entity manager for THIS batch's transaction.
   *
   * Required, and required to be the forked one `commitBatch` opened rather
   * than the root one an applier holds in its constructor. Every read and
   * write an applier performs must go through it: writes so they roll back
   * together, and reads so a row written earlier in the same batch is visible
   * to the row that depends on it.
   */
  em: EntityManager;
  /**
   * The person whose approval this execution is running under.
   *
   * Carried into the appliers because some writes must be ATTRIBUTABLE to a
   * human rather than to the system — an inventory posting most of all, where
   * the principal is part of the command's identity and a system origin would
   * say nobody decided the stock was correct.
   */
  approvedByUserId: string;
  /**
   * The advisory keys this batch took before its first write, when its applier
   * takes any. Absent for an applier that does not, and for a caller that
   * applies a unit without preparing a batch.
   */
  batchLocks?: BatchLocks;
}

/**
 * What a batch holds from its first statement to its commit.
 *
 * `stores` and `cards` are the keys named up front. `created` is every product
 * this transaction has inserted: nothing outside it can see those rows, so a
 * key named after one of them cannot be waited on by anybody and is the one
 * kind a batch may still take once it has started writing.
 */
export interface BatchLocks {
  stores: Set<string>;
  cards: Set<string>;
  created: Set<string>;
  /** The same keys as the guard speaks of them, for a guard that is told what is held. */
  keys: { ns: number; key: number }[];
}

/**
 * Whatever actually writes to the catalogue.
 *
 * One per import type. The executor knows nothing about products, receipts or
 * sales — it knows about batches, checkpoints and leases, and that separation
 * is what lets a fourth import type be added without touching any of this.
 */
export interface UnitApplier {
  /**
   * Apply one atomic unit. Called INSIDE the batch's transaction.
   *
   * Throwing rolls the whole batch back, so an applier should throw only when
   * the batch genuinely cannot continue. A row that simply cannot be imported
   * is reported as a FAILED application, which keeps the rest of the batch.
   */
  apply(unit: PlannedUnit, context: ApplyContext): Promise<RowApplication[]>;

  /**
   * Take every advisory key the batch will need, BEFORE its first write.
   *
   * Called once, as the first thing the batch's transaction does. A batch is
   * one transaction and its keys live until it commits, so keys taken unit by
   * unit are taken after the previous unit's rows were written — the opposite
   * order to every writer that takes its key and then writes. Optional: an
   * applier that takes no such keys has nothing to prepare.
   *
   * Throwing `LockSetWidenedError`, or failing to get a key inside the lock
   * timeout, rolls back a transaction that has written nothing, and the
   * executor starts the batch again.
   */
  prepareBatch?(units: PlannedUnit[], context: ApplyContext): Promise<void>;
}

/**
 * How many times one batch is attempted before it is reported as failed.
 *
 * Three TOTAL transactions, the same number every other lock-retrying writer
 * uses. Only two outcomes are retried, and both are outcomes of WAITING rather
 * than of the data: a key set that turned out wider than what was taken, and a
 * key that could not be had inside the lock timeout. A deadlock is not retried
 * — it means two transactions took their locks in opposite orders, which is a
 * defect to be told about and not a delay to be absorbed.
 */
export const MAX_BATCH_LOCK_ATTEMPTS = 3;

/** PostgreSQL's `lock_not_available`: the lock timeout expired while waiting. */
const LOCK_NOT_AVAILABLE = '55P03';

/** True for the two outcomes a fresh transaction can be expected to cure. */
export function isLockWaitOutcome(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === 'LockSetWidenedError' || candidate.code === LOCK_NOT_AVAILABLE;
}

/** The storage the executor needs, narrowed to what it actually uses. */
export interface ExecutionStore {
  /** Checkpoints already committed for this execution. */
  loadCheckpoints(executionId: string): Promise<CommittedCheckpoint[]>;
  /**
   * Run `work` in one transaction, and write the checkpoint inside it.
   *
   * The checkpoint and the batch's mutations must commit or roll back
   * together; a checkpoint written in a separate transaction can be lost in
   * between, and the batch then runs a second time.
   */
  commitBatch(
    executionId: string,
    batch: PlannedBatch,
    work: (em: EntityManager) => Promise<RowApplication[]>,
  ): Promise<RowApplication[]>;
  /** Persist row results. Called outside the batch transaction. */
  recordRowResults(executionId: string, rows: ReportRow[]): Promise<void>;
  /** Record how the run ended. */
  finish(executionId: string, outcome: RunOutcome, summary: ImportReport): Promise<void>;
}

export interface ExecuteParams {
  executionId: string;
  organizationId: string;
  importType: string;
  /** The approver, carried through to every applier. See `ApplyContext`. */
  approvedByUserId: string;
  planHash: string;
  sourceTable: string;
  units: PlannedUnit[];
  applier: UnitApplier;
  store: ExecutionStore;
  cancellation: CancellationToken;
  /** Renews the lease. Returns false once the lease has been lost. */
  beat: () => Promise<boolean>;
  budget?: BatchBudget;
  /** Injected so tests state the clock rather than racing it. */
  now?: () => number;
}

export interface ExecuteResult {
  outcome: RunOutcome;
  report: ImportReport;
  batchesCommitted: number;
  batchesPlanned: number;
  /** Set when a resumed run found a checkpoint that does not match the plan. */
  conflict?: { batchIndex: number; expected: string; found: string };
}

export async function executePlan(params: ExecuteParams): Promise<ExecuteResult> {
  const now = params.now ?? (() => Date.now());
  const budget = params.budget ?? new BatchBudget();
  const pacer = new HeartbeatPacer(now());

  // Sized from what the previous batch actually cost rather than from a
  // constant, because a row is not a unit of time. See batch-budget.ts.
  const batches = planBatches(params.planHash, params.units, budget.nextBatchRows());
  const committed = await params.store.loadCheckpoints(params.executionId);
  const resume = decideResume(batches, committed);

  if (resume.conflict) {
    // The plan changed under a partly-executed run. Continuing would apply work
    // the committed half never anticipated, so the run stops for a human rather
    // than guessing which version is right.
    // Rows in already-committed batches were applied by the earlier run and
    // are not this run's to report on; everything else is refused.
    const alreadyApplied = new Set(
      batches
        .filter((b) => resume.alreadyCommitted.includes(b.index))
        .flatMap((b) => b.units.flatMap((u) => u.sourceRows)),
    );
    const rows = unreachedRows(
      batches,
      alreadyApplied,
      params.sourceTable,
      'The import plan changed after part of this run had already been applied. A person needs to decide how to continue.',
      RowOutcome.BLOCKED,
    );
    await params.store.recordRowResults(params.executionId, rows);
    const report = buildReport(rows);
    await params.store.finish(params.executionId, 'FAILED', report);
    return {
      outcome: 'FAILED',
      report,
      batchesCommitted: resume.alreadyCommitted.length,
      batchesPlanned: batches.length,
      conflict: resume.conflict,
    };
  }

  const applied: ReportRow[] = [];
  const committedIndexes = new Set(resume.alreadyCommitted);
  // Rows a PREVIOUS run already committed. They are not re-applied and not
  // re-reported, but they must not be counted as unreached either.
  const carriedOver = new Set(
    batches
      .filter((b) => resume.alreadyCommitted.includes(b.index))
      .flatMap((b) => b.units.flatMap((u) => u.sourceRows)),
  );
  let outcome: RunOutcome = 'COMPLETED';
  let stopReason: string | null = null;

  for (const batch of resume.pending) {
    // Between batches: the previous one has committed and checkpointed, and no
    // transaction is open, so both the beat and the cancellation check are safe.
    const decision = params.cancellation.shouldStop('BETWEEN_BATCHES');
    if (decision.stop) {
      outcome = 'CANCELLED';
      stopReason = decision.reason ?? 'Stopped at your request.';
      break;
    }

    const held = await pacer.beatIfDue(now(), params.beat);
    if (!held) {
      // Someone else owns this execution now. Writing on would mean two workers
      // applying the same plan, so we stop at this safe point.
      outcome = 'ABANDONED';
      stopReason = 'Another worker took over this import, so this one stopped.';
      break;
    }

    const startedAt = now();
    let leaseLostBetweenAttempts = false;
    try {
      let results: RowApplication[] | null = null;
      for (let attempt = 1; results === null; attempt += 1) {
        try {
          results = await params.store.commitBatch(params.executionId, batch, async (em) =>
            applyUnits(batch, params, em),
          );
        } catch (error) {
          // The transaction is gone and took everything with it, so a second
          // attempt starts from exactly where the first did. Nothing else is
          // retried: a refusal or a constraint would only fail again.
          if (!isLockWaitOutcome(error) || attempt >= MAX_BATCH_LOCK_ATTEMPTS) throw error;
          // No transaction is open here, so this is a safe point to renew the
          // lease — and a failed attempt has just spent time the lease did not
          // see, so it is renewed whether or not a beat was otherwise due.
          const held = await params.beat();
          pacer.recordBeat(now());
          if (!held) {
            leaseLostBetweenAttempts = true;
            break;
          }
        }
      }
      if (leaseLostBetweenAttempts || results === null) {
        outcome = 'ABANDONED';
        stopReason = 'Another worker took over this import, so this one stopped.';
        break;
      }
      applied.push(...results.map((r) => toReportRow(r, params.sourceTable)));
      committedIndexes.add(batch.index);
    } catch (error) {
      // The batch rolled back whole, so none of its rows were applied. They are
      // reported as failed rather than left unaccounted for.
      const message = isLockWaitOutcome(error)
        ? `This batch could not get hold of the products it changes after ${MAX_BATCH_LOCK_ATTEMPTS} attempts, ` +
          'because other changes to the same products kept getting there first. Nothing in this batch was ' +
          'applied. Run the import again.'
        : error instanceof Error
          ? error.message
          : 'The batch could not be applied.';
      applied.push(
        ...batch.units.flatMap((unit) =>
          unit.sourceRows.map((sourceRow) => ({
            sourceTable: params.sourceTable,
            sourceRow,
            outcome: RowOutcome.FAILED,
            reason: message,
            // Rolled back, and said so. Leaving effects null here would make a
            // row we KNOW was undone indistinguishable from one imported before
            // effects were recorded at all — the screen renders that as "not
            // recorded", which is a shrug where a fact belongs. These rows are
            // written after the transaction is gone, so this is the only place
            // the knowledge survives.
            effects: ROLLED_BACK_EFFECTS,
          })),
        ),
      );
      outcome = 'FAILED';
      stopReason = message;
      break;
    }

    // What that batch really cost, folded in before the next one is sized.
    budget.observe({ rows: batch.units.reduce((n, u) => n + u.sourceRows.length, 0), elapsedMs: now() - startedAt });
  }

  if (outcome === 'COMPLETED' && committedIndexes.size < batches.length) {
    outcome = 'PARTIALLY_COMPLETED';
  }

  // Every row gets a result, including the ones the run never reached. A row
  // with no result is a row nobody can answer a question about later.
  const accountedFor = new Set<number>([...carriedOver, ...applied.map((r) => r.sourceRow)]);
  const unreached = unreachedRows(
    batches,
    accountedFor,
    params.sourceTable,
    stopReason ?? 'The import stopped before reaching this row.',
    RowOutcome.SKIPPED,
  );
  const rows = [...applied, ...unreached].sort((a, b) => a.sourceRow - b.sourceRow);

  await params.store.recordRowResults(params.executionId, rows);
  if (outcome === 'CANCELLED') params.cancellation.markStopped();

  const report = buildReport(rows);
  await params.store.finish(params.executionId, outcome, report);

  return {
    outcome,
    report,
    batchesCommitted: committedIndexes.size,
    batchesPlanned: batches.length,
  };
}

/**
 * Apply the units of one batch, inside its transaction.
 *
 * Cancellation is honoured between units so a stop during a long batch does not
 * have to wait for the whole batch. It is NOT honoured mid-unit: a unit is
 * atomic, and stopping inside one is exactly the half-written state the design
 * exists to prevent.
 *
 * There is deliberately no heartbeat in here. The transaction is open, so an
 * UPDATE on the lease row would be invisible to every other worker until it
 * commits — the lease would look expired to the reaper for the whole batch.
 */
async function applyUnits(batch: PlannedBatch, params: ExecuteParams, em: EntityManager): Promise<RowApplication[]> {
  // The guarantee this whole path rests on, checked once per batch rather than
  // assumed. If the store ever hands over a non-transactional manager again,
  // every applier below would autocommit and no test would notice.
  assertInTransaction(em, 'A batch of import work');

  const context: ApplyContext = {
    organizationId: params.organizationId,
    executionId: params.executionId,
    importType: params.importType,
    approvedByUserId: params.approvedByUserId,
    em,
  };

  // Every key, before any unit writes anything.
  await params.applier.prepareBatch?.(batch.units, context);

  const results: RowApplication[] = [];
  for (const unit of batch.units) {
    if (params.cancellation.shouldStop('BETWEEN_UNITS').stop) {
      // The units already applied stay in this transaction and commit with it;
      // the rest are reported as not reached.
      break;
    }
    results.push(...(await params.applier.apply(unit, context)));
  }
  return results;
}

/**
 * What a row that was rolled back did: nothing, in every category.
 *
 * A frozen constant rather than a builder, because there is exactly one honest
 * answer here and it must not acquire per-row detail. A rolled-back row has no
 * product, no listing, no category and no stock, and claiming any specificity
 * about work that was undone would be inventing it.
 */
const ROLLED_BACK_EFFECTS: RowEffects = Object.freeze({
  product: { state: 'ROLLED_BACK' },
  storeAssociation: { state: 'ROLLED_BACK', published: false },
  categories: { state: 'ROLLED_BACK' },
  inventory: { state: 'ROLLED_BACK' },
}) as RowEffects;

/**
 * An applier's result, as the row the report and the database will hold.
 *
 * Every field an applier can produce has to be carried across. A field that is
 * silently dropped here is a fact the applier established, the transaction
 * committed, and the report then failed to mention — which is the exact class
 * of failure this whole effects mechanism exists to close, reappearing one
 * layer down.
 */
export function toReportRow(application: RowApplication, sourceTable: string): ReportRow {
  return {
    sourceTable,
    sourceRow: application.sourceRow,
    outcome: application.outcome,
    targetType: application.targetType ?? null,
    targetId: application.targetId ?? null,
    matchProvenance: application.matchProvenance ?? null,
    reason: application.reason ?? null,
    // Null rather than undefined: the column is nullable and "this run recorded
    // nothing" is a fact worth storing explicitly.
    effects: application.effects ?? null,
  };
}

/**
 * Every planned row that has no result yet.
 *
 * Deliberately computed from ROWS rather than from which batches committed. A
 * batch cancelled between units commits the units it had already applied, so it
 * IS a committed batch while some of its rows were never touched — and a
 * batch-based accounting would give those rows no result at all. A row with no
 * result is a row nobody can answer a question about, which is the one thing
 * this report must never produce.
 */
function unreachedRows(
  batches: PlannedBatch[],
  accountedFor: Set<number>,
  sourceTable: string,
  reason: string,
  outcome: RowOutcome,
): ReportRow[] {
  const rows: ReportRow[] = [];
  for (const batch of batches) {
    for (const unit of batch.units) {
      for (const sourceRow of unit.sourceRows) {
        if (accountedFor.has(sourceRow)) continue;
        rows.push({ sourceTable, sourceRow, outcome, reason });
      }
    }
  }
  return rows;
}
