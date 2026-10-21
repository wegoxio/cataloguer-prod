import { fakeTransactionalEm } from './support/test-transaction';
import { ExecutionStore, RowApplication, UnitApplier, executePlan } from '../import-executor';
import { CommittedCheckpoint, PlannedBatch, PlannedUnit } from '../batch-planner';
import { CancellationToken } from '../cancellation';
import { BatchBudget } from '../batch-budget';
import { ReportRow } from '../import-report';
import { RowOutcome } from '../../entities/import-row-result.entity';

/** The approver an execution runs under; appliers attribute writes to them. */
const APPROVER = '00000000-0000-4000-8000-000000000001';

/**
 * Running an approved plan, tested where the bugs actually live: the ORDER of
 * things.
 *
 * Whether a checkpoint commits with its batch, whether the lease is beaten
 * inside a transaction, whether a resumed run trusts a counter or the
 * checkpoints — none of that needs a database to answer, and answering it here
 * means the answers are readable.
 */

const PLAN_HASH = 'plan-hash-1';
const SOURCE_TABLE = 'Productos';

const row = (n: number): PlannedUnit => ({ kind: 'ROW', sourceRows: [n], mutations: { row: n } });
const family = (rows: number[]): PlannedUnit => ({ kind: 'FAMILY', sourceRows: rows, mutations: { family: rows } });

/** A store that records the order things happened in. */
function makeStore(over: Partial<ExecutionStore> = {}) {
  const events: string[] = [];
  const checkpoints: CommittedCheckpoint[] = [];
  let recorded: ReportRow[] = [];
  let finished: { outcome: string; headline: string } | null = null;

  const store: ExecutionStore = {
    loadCheckpoints: async () => checkpoints,
    commitBatch: async (_executionId, batch, work) => {
      events.push(`open:${batch.index}`);
      const results = await work(fakeTransactionalEm());
      // The checkpoint is written INSIDE this transaction, with the work.
      checkpoints.push({ batchIndex: batch.index, batchFingerprint: batch.fingerprint });
      events.push(`commit:${batch.index}`);
      return results;
    },
    recordRowResults: async (_executionId, rows) => {
      events.push('results');
      recorded = rows;
    },
    finish: async (_executionId, outcome, report) => {
      events.push(`finish:${outcome}`);
      finished = { outcome, headline: report.headline };
    },
    ...over,
  };

  return {
    store,
    events,
    checkpoints,
    get recorded() {
      return recorded;
    },
    get finished() {
      return finished;
    },
  };
}

/** An applier that succeeds, recording which units it was given. */
function makeApplier(behaviour?: (unit: PlannedUnit) => RowApplication[]) {
  const seen: PlannedUnit[] = [];
  const applier: UnitApplier = {
    apply: async (unit: PlannedUnit) => {
      seen.push(unit);
      return (
        behaviour?.(unit) ??
        unit.sourceRows.map((sourceRow) => ({
          sourceRow,
          outcome: RowOutcome.CREATED,
          targetType: 'product',
          targetId: `product-${sourceRow}`,
        }))
      );
    },
  };
  return { applier, seen };
}

function runParams(over: Partial<Parameters<typeof executePlan>[0]> = {}) {
  const store = makeStore();
  const { applier, seen } = makeApplier();
  const cancellation = new CancellationToken();
  const beat = jest.fn().mockResolvedValue(true);
  let clock = 0;

  const params = {
    executionId: 'exec-1',
    organizationId: 'org-1',
    importType: 'PRODUCTS',
    approvedByUserId: APPROVER,
    planHash: PLAN_HASH,
    sourceTable: SOURCE_TABLE,
    units: [row(2), row(3), row(4), row(5)],
    applier,
    store: store.store,
    cancellation,
    beat,
    // Fast enough that the budget stays at its ceiling; timing is measured
    // elsewhere, and racing a real clock here would make these flaky.
    budget: new BatchBudget(30_000, 1, 2),
    now: () => (clock += 1),
    ...over,
  };

  return { params, store, seen, cancellation, beat };
}

describe('a clean run', () => {
  it('applies every unit and reports every row', async () => {
    const { params, store } = runParams();
    const result = await executePlan(params);

    expect(result.outcome).toBe('COMPLETED');
    expect(result.batchesCommitted).toBe(result.batchesPlanned);
    expect(store.recorded.map((r) => r.sourceRow)).toEqual([2, 3, 4, 5]);
    expect(store.recorded.every((r) => r.outcome === RowOutcome.CREATED)).toBe(true);
  });

  it('records the target so a wrong record can be found afterwards', async () => {
    const { params, store } = runParams();
    await executePlan(params);
    expect(store.recorded[0]).toMatchObject({ targetType: 'product', targetId: 'product-2' });
  });

  it('finishes only after the row results are safely recorded', async () => {
    // A run marked finished with no row results is one nobody can ask
    // questions about.
    const { params, store } = runParams();
    await executePlan(params);
    expect(store.events.indexOf('results')).toBeLessThan(store.events.indexOf('finish:COMPLETED'));
  });

  it('says plainly in the report that everything landed', async () => {
    const { params, store } = runParams();
    await executePlan(params);
    expect(store.finished?.headline).toBe('All 4 rows were imported.');
  });
});

describe('the checkpoint commits WITH the batch', () => {
  it('never writes a checkpoint outside the batch transaction', async () => {
    // A checkpoint written afterwards can be lost in between, and the batch
    // then runs a second time.
    const { params, store } = runParams();
    await executePlan(params);
    // Every commit is bracketed by its own open; nothing happens between a
    // batch's work and its checkpoint.
    expect(store.events.filter((e) => e.startsWith('open:') || e.startsWith('commit:'))).toEqual([
      'open:0',
      'commit:0',
      'open:1',
      'commit:1',
    ]);
  });

  it('leaves no checkpoint for a batch that threw', async () => {
    const store = makeStore({
      commitBatch: async (_id, _batch, work) => {
        await work(fakeTransactionalEm());
        throw new Error('the database refused');
      },
    });
    const { params } = runParams({ store: store.store });
    const result = await executePlan(params);

    expect(result.outcome).toBe('FAILED');
    expect(store.checkpoints).toEqual([]);
  });
});

describe('resuming', () => {
  it('never re-applies a batch that already committed', async () => {
    // Driven by the checkpoint, not by a counter: a worker that died after
    // committing but before updating a counter would otherwise redo it.
    const store = makeStore({
      loadCheckpoints: async () => [{ batchIndex: 0, batchFingerprint: fingerprintOfFirstBatch() }],
    });
    const { params, seen } = runParams({ store: store.store });
    const result = await executePlan(params);

    expect(result.outcome).toBe('COMPLETED');
    // Only the second batch's rows were applied this time.
    expect(seen.flatMap((u) => u.sourceRows)).toEqual([4, 5]);
  });

  it('accounts for the rows a previous run committed without re-reporting them', async () => {
    const store = makeStore({
      loadCheckpoints: async () => [{ batchIndex: 0, batchFingerprint: fingerprintOfFirstBatch() }],
    });
    const { params } = runParams({ store: store.store });
    await executePlan(params);

    // Rows 2 and 3 belong to the earlier run. They must not appear as this
    // run's work, and equally must not be reported as unreached.
    expect(store.recorded.map((r) => r.sourceRow)).toEqual([4, 5]);
  });

  it('STOPS when a checkpoint does not match the current plan', async () => {
    // The plan changed under a partly-executed run. Continuing would apply work
    // the committed half never anticipated.
    const store = makeStore({
      loadCheckpoints: async () => [{ batchIndex: 0, batchFingerprint: 'a-different-plan' }],
    });
    const { params, seen } = runParams({ store: store.store });
    const result = await executePlan(params);

    expect(result.outcome).toBe('FAILED');
    expect(result.conflict).toMatchObject({ batchIndex: 0, found: 'a-different-plan' });
    // Nothing was applied at all.
    expect(seen).toEqual([]);
  });

  it('explains a plan conflict in words a person can act on', async () => {
    const store = makeStore({
      loadCheckpoints: async () => [{ batchIndex: 0, batchFingerprint: 'a-different-plan' }],
    });
    const { params } = runParams({ store: store.store });
    await executePlan(params);

    expect(store.recorded[0].reason).toMatch(/plan changed after part of this run/);
    expect(store.recorded.every((r) => r.outcome === RowOutcome.BLOCKED)).toBe(true);
  });
});

describe('cancellation', () => {
  it('stops between batches and keeps what committed', async () => {
    const { params, cancellation } = runParams();
    // Requested before the run starts, so it stops at the first boundary.
    cancellation.request('Ana');
    const result = await executePlan(params);

    expect(result.outcome).toBe('CANCELLED');
    expect(result.batchesCommitted).toBe(0);
    expect(cancellation.stopped).toBe(true);
  });

  it('gives every unreached row a result explaining why', async () => {
    const { params, cancellation, store } = runParams();
    cancellation.request('Ana');
    await executePlan(params);

    expect(store.recorded).toHaveLength(4);
    expect(store.recorded[0].reason).toMatch(/Ana/);
    expect(store.recorded.every((r) => r.outcome === RowOutcome.SKIPPED)).toBe(true);
  });

  it('accounts for rows in a batch it stopped PART WAY through', async () => {
    // The case a batch-based accounting gets wrong: the batch commits the units
    // it had already applied, so it IS committed — while some of its rows were
    // never touched. Those rows must still get a result.
    const cancellation = new CancellationToken();
    let applied = 0;
    const applier: UnitApplier = {
      apply: async (unit) => {
        applied++;
        // Cancel after the first unit of the first batch.
        if (applied === 1) cancellation.request('Ana');
        return unit.sourceRows.map((sourceRow) => ({ sourceRow, outcome: RowOutcome.CREATED }));
      },
    };

    const store = makeStore();
    const { params } = runParams({ applier, cancellation, store: store.store });
    await executePlan(params);

    // Every planned row has exactly one result, and none is missing.
    expect(store.recorded.map((r) => r.sourceRow)).toEqual([2, 3, 4, 5]);
    expect(store.recorded.filter((r) => r.outcome === RowOutcome.CREATED).map((r) => r.sourceRow)).toEqual([2]);
    expect(store.recorded.filter((r) => r.outcome === RowOutcome.SKIPPED).map((r) => r.sourceRow)).toEqual([3, 4, 5]);
  });

  it('never stops in the middle of an atomic unit', async () => {
    // A family committed half is a parent without its children. The unit runs
    // to completion once started, whatever has been requested.
    const cancellation = new CancellationToken();
    cancellation.request('Ana');
    const { applier } = makeApplier();
    const store = makeStore();
    const { params } = runParams({
      units: [family([2, 3, 4])],
      applier,
      cancellation,
      store: store.store,
    });
    await executePlan(params);

    // Either the family was applied whole or not at all — never partly.
    const familyRows = store.recorded.filter((r) => r.outcome === RowOutcome.CREATED).map((r) => r.sourceRow);
    expect(familyRows.length === 0 || familyRows.length === 3).toBe(true);
  });
});

describe('the lease', () => {
  it('beats between batches, never inside one', async () => {
    // An UPDATE on the lease row inside an open transaction is invisible to
    // every other worker until it commits, so the lease would look expired to
    // the reaper for the whole batch.
    const beatEvents: string[] = [];
    const store = makeStore({
      commitBatch: async (_id, batch, work) => {
        beatEvents.push(`open:${batch.index}`);
        const results = await work(fakeTransactionalEm());
        beatEvents.push(`commit:${batch.index}`);
        return results;
      },
    });
    const beat = jest.fn().mockImplementation(async () => {
      beatEvents.push('beat');
      return true;
    });
    // A clock that jumps a full heartbeat interval on every read, so a beat is
    // due at every opportunity.
    let clock = 0;
    const { params } = runParams({ store: store.store, beat, now: () => (clock += 30_000) });
    await executePlan(params);

    for (let i = 0; i < beatEvents.length; i++) {
      if (beatEvents[i] !== 'beat') continue;
      // No beat may sit between an open and its commit.
      const before = beatEvents.slice(0, i);
      const opens = before.filter((e) => e.startsWith('open:')).length;
      const commits = before.filter((e) => e.startsWith('commit:')).length;
      expect(opens).toBe(commits);
    }
  });

  it('stops when the lease has been lost rather than writing on', async () => {
    // Continuing would mean two workers applying the same plan.
    const beat = jest.fn().mockResolvedValue(false);
    const store = makeStore();
    let clock = 0;
    const { params, seen: unitsApplied } = runParams({
      beat,
      store: store.store,
      now: () => (clock += 30_000),
    });
    const result = await executePlan(params);

    expect(result.outcome).toBe('ABANDONED');
    expect(unitsApplied).toEqual([]);
    expect(store.recorded.every((r) => r.reason?.includes('Another worker took over'))).toBe(true);
  });
});

describe('a batch that fails', () => {
  it('reports its rows as failed rather than leaving them unaccounted for', async () => {
    const store = makeStore({
      commitBatch: async () => {
        throw new Error('the database refused');
      },
    });
    const { params } = runParams({ store: store.store });
    const result = await executePlan(params);

    expect(result.outcome).toBe('FAILED');
    // The first batch's rows failed; the rest were never reached.
    const failed = store.recorded.filter((r) => r.outcome === RowOutcome.FAILED).map((r) => r.sourceRow);
    expect(failed).toEqual([2, 3]);
    expect(store.recorded).toHaveLength(4);
  });

  it('carries the database’s own message into the report', async () => {
    const store = makeStore({
      commitBatch: async () => {
        throw new Error('duplicate key value violates unique constraint');
      },
    });
    const { params } = runParams({ store: store.store });
    await executePlan(params);
    expect(store.recorded[0].reason).toContain('duplicate key');
  });

  it('keeps the batches that committed before it', async () => {
    let calls = 0;
    const store = makeStore({
      commitBatch: async (_id, _batch, work) => {
        calls++;
        if (calls === 2) throw new Error('the database refused');
        const results = await work(fakeTransactionalEm());
        return results;
      },
    });
    const { params } = runParams({ store: store.store });
    const result = await executePlan(params);

    expect(result.outcome).toBe('FAILED');
    expect(result.batchesCommitted).toBe(1);
    expect(store.recorded.filter((r) => r.outcome === RowOutcome.CREATED).map((r) => r.sourceRow)).toEqual([2, 3]);
  });
});

describe('a row the applier could not import', () => {
  it('keeps the rest of the batch', async () => {
    // A row that cannot be imported is reported, not thrown — throwing would
    // roll back the whole batch for one bad row.
    const applier: UnitApplier = {
      apply: async (unit) =>
        unit.sourceRows.map((sourceRow) => ({
          sourceRow,
          outcome: sourceRow === 3 ? RowOutcome.FAILED : RowOutcome.CREATED,
          reason: sourceRow === 3 ? 'the price is not a number' : null,
        })),
    };
    const store = makeStore();
    const { params } = runParams({ applier, store: store.store });
    const result = await executePlan(params);

    expect(result.outcome).toBe('COMPLETED');
    expect(store.recorded.filter((r) => r.outcome === RowOutcome.CREATED)).toHaveLength(3);
    expect(store.recorded.find((r) => r.sourceRow === 3)?.reason).toBe('the price is not a number');
  });
});

describe('every planned row is accounted for', () => {
  it('holds however the run ended', async () => {
    // The one guarantee that makes the report trustworthy. "I do not know what
    // happened to row 4" is the answer this must never give.
    const scenarios: { name: string; build: () => ReturnType<typeof runParams> }[] = [
      { name: 'clean', build: () => runParams() },
      {
        name: 'cancelled',
        build: () => {
          const r = runParams();
          r.cancellation.request('Ana');
          return r;
        },
      },
      {
        name: 'failed',
        build: () => {
          const throwing = makeStore({
            commitBatch: async () => {
              throw new Error('nope');
            },
          });
          const built = runParams({ store: throwing.store });
          // `runParams` makes its own store for the default case; this scenario
          // must be asserted against the one it actually ran with.
          return { ...built, store: throwing };
        },
      },
    ];

    for (const scenario of scenarios) {
      const built = scenario.build();
      await executePlan(built.params);
      const rows = built.store.recorded.map((r) => r.sourceRow).sort((a, b) => a - b);
      expect({ scenario: scenario.name, rows }).toEqual({ scenario: scenario.name, rows: [2, 3, 4, 5] });
    }
  });

  it('gives each row exactly one result', async () => {
    const { params, store } = runParams();
    await executePlan(params);
    const seen = new Set(store.recorded.map((r) => r.sourceRow));
    expect(seen.size).toBe(store.recorded.length);
  });
});

describe('an empty plan', () => {
  it('finishes without pretending anything happened', async () => {
    const { params, store } = runParams({ units: [] });
    const result = await executePlan(params);
    expect(result.outcome).toBe('COMPLETED');
    expect(store.recorded).toEqual([]);
    expect(store.finished?.headline).toMatch(/no rows to import/);
  });
});

/**
 * The fingerprint the planner gives the first batch under these params.
 *
 * Recomputed rather than hardcoded so a change to the hashing does not silently
 * turn the resume tests into tests of nothing.
 */
function fingerprintOfFirstBatch(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { planBatches } = require('../batch-planner') as {
    planBatches: (h: string, u: PlannedUnit[], n: number) => PlannedBatch[];
  };
  return planBatches(PLAN_HASH, [row(2), row(3), row(4), row(5)], 2)[0].fingerprint;
}
