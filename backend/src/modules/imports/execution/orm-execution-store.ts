import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { CommittedCheckpoint, PlannedBatch } from './batch-planner';
import { txExecute } from './tx';
import { ExecutionStore, RowApplication } from './import-executor';
import { ReportRow, ImportReport } from './import-report';
import { RunOutcome } from './cancellation';
import { ImportExecutionStatus } from '../entities/import-execution.entity';
import { RowOutcome } from '../entities/import-row-result.entity';

/**
 * The row-result insert, defined once so it cannot disagree with itself.
 *
 * This used to be a hand-written column list beside a hand-written tuple of
 * `?`s and a hand-written `values.push`. Adding one column meant editing three
 * places that nothing checked against each other — and when exactly that was
 * attempted, the column list gained `effects` while the tuple did not, so every
 * insert had eleven columns and ten values and every row of a run reported
 * FAILED.
 *
 * The columns are now the single source: the tuple is generated from their
 * count, and `rowResultValues` returns one value per column in the same order.
 * A mismatch is no longer a thing a person can write.
 */
const ROW_RESULT_COLUMNS = [
  'organization_id',
  'execution_id',
  'source_table',
  'source_row',
  'outcome',
  'target_type',
  'target_id',
  'match_provenance',
  'reason',
  'effects',
] as const;

/** `created_at` is `now()`, not a bound parameter, so it is appended separately. */
const ROW_RESULT_TUPLE = `(${ROW_RESULT_COLUMNS.map((c) => (c === 'effects' ? '?::jsonb' : '?')).join(', ')}, now())`;

function rowResultValues(organizationId: string, executionId: string, row: ReportRow): unknown[] {
  const values = [
    organizationId,
    executionId,
    row.sourceTable,
    row.sourceRow,
    row.outcome,
    row.targetType ?? null,
    row.targetId ?? null,
    row.matchProvenance ?? null,
    row.reason ?? null,
    // Serialised here rather than by the driver: the column is jsonb and the
    // value is a plain object, and `?::jsonb` wants text.
    row.effects ? JSON.stringify(row.effects) : null,
  ];
  // Cheap, and it is the assertion the previous attempt did not have.
  if (values.length !== ROW_RESULT_COLUMNS.length) {
    throw new Error(`Row-result insert is malformed: ${ROW_RESULT_COLUMNS.length} columns, ${values.length} values.`);
  }
  return values;
}

/**
 * The executor's storage, against the real database.
 *
 * Everything here exists to make one guarantee true: **the checkpoint and the
 * batch's mutations commit together.** If the checkpoint were written in its
 * own transaction it could be lost between the two, and a resumed run would
 * apply the batch a second time — creating duplicate products or double-posting
 * a sale.
 *
 * That is why `commitBatch` opens the transaction itself rather than letting
 * the caller do it. The applier runs inside; the checkpoint is inserted inside;
 * one commit ends both. There is no arrangement of calls a caller can make that
 * separates them.
 */
@Injectable()
export class OrmExecutionStore implements ExecutionStore {
  constructor(private readonly em: EntityManager) {}

  async loadCheckpoints(executionId: string): Promise<CommittedCheckpoint[]> {
    const rows = await this.em
      .getConnection()
      .execute<
        { batch_index: number; batch_fingerprint: string }[]
      >(`select batch_index, batch_fingerprint from import_checkpoints where execution_id = ? order by batch_index`, [executionId]);
    return rows.map((row) => ({
      batchIndex: Number(row.batch_index),
      batchFingerprint: row.batch_fingerprint,
    }));
  }

  /**
   * Run one batch and checkpoint it, atomically.
   *
   * The insert is `on conflict do nothing` against the partial unique index on
   * (execution, batch_index). Two workers racing the same batch is not supposed
   * to happen — the lease exists to prevent it — but the lease is a lease, not
   * a lock, and a mis-timed steal is explicitly a case the design tolerates. If
   * it happens, the loser's transaction finds the checkpoint already present
   * and rolls back rather than committing a duplicate.
   */
  async commitBatch(
    executionId: string,
    batch: PlannedBatch,
    work: (em: EntityManager) => Promise<RowApplication[]>,
  ): Promise<RowApplication[]> {
    return this.em.transactional(async (em) => {
      // The forked manager goes to the appliers. Handing them `this.em` — or
      // letting them keep the one from their own constructor — is what made
      // every catalogue write in this "transaction" autocommit.
      const results = await work(em as EntityManager);

      const counts = tallyOutcomes(results);
      const inserted = await txExecute<{ id: string }[]>(
        em as EntityManager,
        `insert into import_checkpoints
           (execution_id, batch_index, first_row, last_row, batch_fingerprint,
            rows_created, rows_updated, rows_skipped, rows_failed, committed_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, now())
         on conflict (execution_id, batch_index) do nothing
         returning id`,
        [
          executionId,
          batch.index,
          batch.firstRow,
          batch.lastRow,
          batch.fingerprint,
          counts.created,
          counts.updated,
          counts.skipped,
          counts.failed,
        ],
      );

      if (!Array.isArray(inserted) || inserted.length === 0) {
        // Somebody else committed this batch while we were applying it. Ours
        // must not land on top: throwing rolls back everything this
        // transaction did, which is exactly the outcome that keeps the batch
        // applied exactly once.
        throw new BatchAlreadyCommittedError(batch.index);
      }

      // The running tally on the execution row, updated in the same
      // transaction so a reader never sees a count that disagrees with the
      // checkpoints.
      await txExecute(
        em as EntityManager,
        `update import_executions
            set batches_completed = batches_completed + 1,
                rows_created = rows_created + ?,
                rows_updated = rows_updated + ?,
                rows_skipped = rows_skipped + ?,
                rows_failed  = rows_failed  + ?,
                updated_at = now()
          where id = ?`,
        [counts.created, counts.updated, counts.skipped, counts.failed, executionId],
      );

      return results;
    });
  }

  /**
   * Write one result per source row.
   *
   * `on conflict do nothing` against the unique index on
   * (execution, source_table, source_row) is what makes a retried or resumed
   * run idempotent here too: a row that already has a verdict keeps the one it
   * was given, because the FIRST answer is the one that describes what actually
   * happened.
   */
  async recordRowResults(executionId: string, rows: ReportRow[]): Promise<void> {
    if (rows.length === 0) return;

    const organizationId = await this.organizationOf(executionId);

    // Chunked so a hundred-thousand-row report does not become one statement
    // with half a million parameters, which Postgres refuses.
    const CHUNK = 500;
    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK);
      const values: unknown[] = [];
      const placeholders = chunk
        .map((row) => {
          values.push(...rowResultValues(organizationId, executionId, row));
          return ROW_RESULT_TUPLE;
        })
        .join(', ');

      await this.em.getConnection().execute(
        `insert into import_row_results (${ROW_RESULT_COLUMNS.join(', ')}, created_at)
         values ${placeholders}
         on conflict (execution_id, source_table, source_row) do nothing`,
        values,
      );
    }
  }

  /**
   * Record how the run ended.
   *
   * Conditional on the run not already being finished. A late report — a worker
   * that was slow to write its summary while another decided the run was
   * abandoned — must not overwrite a terminal state that was already recorded,
   * or the history would say the run completed when a second worker has since
   * resumed and finished it.
   */
  async finish(executionId: string, outcome: RunOutcome, report: ImportReport): Promise<void> {
    // `batches_total` is the number of BATCHES, and it used to be given the
    // number of ROWS. One batch of six rows was therefore reported as six
    // batches, and the screen said "1 of 6 batches committed" for a run that
    // had exactly one batch in it. Rows, batches and checkpoints are three
    // different things and only one of them belongs in this column.
    //
    // Counted from the checkpoints, because a checkpoint IS a committed batch;
    // deriving it from anything else would be a second opinion about a fact the
    // table already holds.
    const [batches] = await this.em
      .getConnection()
      .execute<{ n: string }[]>(`select count(*) as n from import_checkpoints where execution_id = ?`, [executionId]);

    await this.em.getConnection().execute(
      `update import_executions
          set status = ?,
              failure_reason = ?,
              batches_total = ?,
              finished_at = now(),
              lease_owner = null,
              lease_expires_at = null,
              updated_at = now()
        where id = ?
          and status in ('QUEUED', 'RUNNING')`,
      [
        STATUS_FOR[outcome],
        // The headline, not a stack trace. This column is read by the history
        // screen and by whoever is asked what happened.
        outcome === 'COMPLETED' ? null : report.headline,
        Number(batches?.n ?? 0),
        executionId,
      ],
    );
  }

  private async organizationOf(executionId: string): Promise<string> {
    const rows = await this.em
      .getConnection()
      .execute<
        { organization_id: string }[]
      >(`select organization_id from import_executions where id = ?`, [executionId]);
    const organizationId = rows[0]?.organization_id;
    if (!organizationId) throw new Error(`Execution ${executionId} has no organization`);
    return organizationId;
  }
}

/** Raised when another worker committed this batch first. */
export class BatchAlreadyCommittedError extends Error {
  constructor(readonly batchIndex: number) {
    super(`Batch ${batchIndex} was already committed by another worker.`);
    this.name = 'BatchAlreadyCommittedError';
  }
}

const STATUS_FOR: Record<RunOutcome, ImportExecutionStatus> = {
  COMPLETED: ImportExecutionStatus.COMPLETED,
  PARTIALLY_COMPLETED: ImportExecutionStatus.PARTIALLY_COMPLETED,
  CANCELLED: ImportExecutionStatus.CANCELLED,
  FAILED: ImportExecutionStatus.FAILED,
  ABANDONED: ImportExecutionStatus.ABANDONED,
};

export function tallyOutcomes(results: RowApplication[]): {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
} {
  const counts = { created: 0, updated: 0, skipped: 0, failed: 0 };
  for (const result of results) {
    switch (result.outcome) {
      case RowOutcome.CREATED:
        counts.created++;
        break;
      case RowOutcome.UPDATED:
        counts.updated++;
        break;
      case RowOutcome.SKIPPED:
        counts.skipped++;
        break;
      // BLOCKED and UNRESOLVED are counted with failures on the execution row:
      // the column means "did not reach the catalogue", and splitting it four
      // ways on a summary row nobody reads would help nobody.
      default:
        counts.failed++;
        break;
    }
  }
  return counts;
}
