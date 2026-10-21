import { DEFAULT_BATCH_ROWS, PlannedUnit, decideResume, planBatches } from '../batch-planner';

const row = (n: number): PlannedUnit => ({ kind: 'ROW', sourceRows: [n], mutations: { row: n } });
const family = (rows: number[]): PlannedUnit => ({ kind: 'FAMILY', sourceRows: rows, mutations: { family: rows } });

const rowsFrom = (from: number, count: number) => Array.from({ length: count }, (_, i) => row(from + i));

describe('batch planning', () => {
  it('packs rows up to the batch size', () => {
    const batches = planBatches('plan-1', rowsFrom(2, 500), 200);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toMatchObject({ index: 0, firstRow: 2, lastRow: 201 });
    expect(batches[1]).toMatchObject({ index: 1, firstRow: 202, lastRow: 401 });
    expect(batches[2]).toMatchObject({ index: 2, firstRow: 402, lastRow: 501 });
  });

  it('NEVER splits a family across a boundary', () => {
    // A family split across batches could resume with a parent that has only
    // some of its children — a card that sells nothing.
    const units = [...rowsFrom(1, 9), family([10, 11, 12])];
    const batches = planBatches('plan-1', units, 10);
    expect(batches).toHaveLength(2);
    expect(batches[0].units).toHaveLength(9);
    const familyBatch = batches[1].units[0];
    expect(familyBatch.kind).toBe('FAMILY');
    expect(familyBatch.sourceRows).toEqual([10, 11, 12]);
  });

  it('lets a batch exceed the target rather than break a unit', () => {
    const batches = planBatches('plan-1', [family([1, 2, 3, 4, 5])], 2);
    expect(batches).toHaveLength(1);
    expect(batches[0].units[0].sourceRows).toHaveLength(5);
  });

  it('gives every batch a fingerprint bound to its plan and index', () => {
    const a = planBatches('plan-a', rowsFrom(1, 4), 2);
    const b = planBatches('plan-b', rowsFrom(1, 4), 2);
    expect(a[0].fingerprint).not.toBe(a[1].fingerprint);
    // A checkpoint from one plan cannot be honoured by another.
    expect(a[0].fingerprint).not.toBe(b[0].fingerprint);
  });

  it('produces nothing for an empty plan', () => {
    expect(planBatches('plan-1', [])).toEqual([]);
  });

  it('treats the default as a CEILING that the budget may lower', () => {
    // This used to assert `DEFAULT_BATCH_ROWS === 200` and call that proof the
    // batch fits inside a lease. It proved nothing: a row is not a unit of
    // time. The measurement lives in `batch-lease-timing.pg.spec.ts` and the
    // per-run decision lives in `BatchBudget`; all this constant does is bound
    // the mutation payload and the report.
    expect(planBatches('plan-1', rowsFrom(1, 500), 25)).toHaveLength(20);
    expect(planBatches('plan-1', rowsFrom(1, 500)).length).toBe(Math.ceil(500 / DEFAULT_BATCH_ROWS));
  });
});

describe('resume', () => {
  const batches = planBatches('plan-1', rowsFrom(1, 10), 2); // 5 batches

  it('runs everything when nothing has committed', () => {
    const d = decideResume(batches, []);
    expect(d.pending).toHaveLength(5);
    expect(d.alreadyCommitted).toEqual([]);
  });

  it('skips batches that already committed, driven by checkpoints not a counter', () => {
    // A worker that died after committing batch 1 but before updating a
    // progress column must not redo it.
    const committed = [
      { batchIndex: 0, batchFingerprint: batches[0].fingerprint },
      { batchIndex: 1, batchFingerprint: batches[1].fingerprint },
    ];
    const d = decideResume(batches, committed);
    expect(d.alreadyCommitted).toEqual([0, 1]);
    expect(d.pending.map((b) => b.index)).toEqual([2, 3, 4]);
  });

  it('resumes correctly when checkpoints arrive out of order', () => {
    const committed = [
      { batchIndex: 2, batchFingerprint: batches[2].fingerprint },
      { batchIndex: 0, batchFingerprint: batches[0].fingerprint },
    ];
    const d = decideResume(batches, committed);
    expect(d.alreadyCommitted).toEqual([0, 2]);
    expect(d.pending.map((b) => b.index)).toEqual([1, 3, 4]);
  });

  it('STOPS when a committed batch does not match the current plan', () => {
    // The plan changed under a partly-executed run. Continuing would apply work
    // the committed half never anticipated.
    const committed = [{ batchIndex: 0, batchFingerprint: 'something-else' }];
    const d = decideResume(batches, committed);
    expect(d.conflict).toMatchObject({ batchIndex: 0, found: 'something-else' });
    expect(d.pending).toEqual([]);
  });

  it('treats a fully committed run as nothing left to do', () => {
    const committed = batches.map((b) => ({ batchIndex: b.index, batchFingerprint: b.fingerprint }));
    const d = decideResume(batches, committed);
    expect(d.pending).toEqual([]);
    expect(d.alreadyCommitted).toHaveLength(5);
    expect(d.conflict).toBeUndefined();
  });

  it('never re-runs a committed batch merely because logs are missing', () => {
    // The rule inherited from the cutover work: the checkpoint is the truth,
    // not the log. A committed batch stays committed even with no other trace.
    const committed = [{ batchIndex: 0, batchFingerprint: batches[0].fingerprint }];
    expect(decideResume(batches, committed).pending.map((b) => b.index)).not.toContain(0);
  });
});
