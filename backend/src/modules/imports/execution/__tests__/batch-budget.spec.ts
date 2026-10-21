import {
  ASSUMED_MS_PER_ROW,
  BatchBudget,
  HeartbeatPacer,
  MIN_BATCH_ROWS,
  SAFE_BATCH_WINDOW_MS,
  SAFE_LEASE_FRACTION,
} from '../batch-budget';
import { DEFAULT_BATCH_ROWS } from '../batch-planner';
import { HEARTBEAT_INTERVAL_MS, LEASE_DURATION_MS } from '../../worker/import-lease.service';

describe('the safe window', () => {
  it('is half a lease, not most of one', () => {
    // The margin absorbs what the projection cannot see: a unit slower than
    // those already measured, and the fact that the lease clock started before
    // the batch did. Sizing to 90% of a lease is right on average and loses the
    // lease regularly.
    expect(SAFE_LEASE_FRACTION).toBe(0.5);
    expect(SAFE_BATCH_WINDOW_MS).toBe(LEASE_DURATION_MS / 2);
  });

  it('leaves room for at least one heartbeat inside a full-length batch', () => {
    expect(SAFE_BATCH_WINDOW_MS).toBeGreaterThan(HEARTBEAT_INTERVAL_MS);
  });
});

describe('sizing a batch from what the database is actually doing', () => {
  it('starts pessimistic rather than at the ceiling', () => {
    // The first batch is the one no observation has corrected. A local-only
    // measurement would have started at 200 rows; the measured statement count
    // against a realistic round trip says 74.
    const budget = new BatchBudget();
    expect(ASSUMED_MS_PER_ROW).toBeGreaterThan(100);
    expect(budget.nextBatchRows()).toBeLessThan(DEFAULT_BATCH_ROWS);
    expect(budget.projectedMs(budget.nextBatchRows())).toBeLessThanOrEqual(SAFE_BATCH_WINDOW_MS);
  });

  it('never proposes a batch projected to outlast the safe window', () => {
    for (const msPerRow of [0.1, 1, 12, 60, 402, 1_000, 30_000, 120_000]) {
      const budget = new BatchBudget(SAFE_BATCH_WINDOW_MS, msPerRow);
      const rows = budget.nextBatchRows();
      expect(rows).toBeGreaterThanOrEqual(MIN_BATCH_ROWS);
      if (rows > MIN_BATCH_ROWS) {
        expect(budget.projectedMs(rows)).toBeLessThanOrEqual(SAFE_BATCH_WINDOW_MS);
      }
    }
  });

  it('never exceeds the ceiling however fast the database is', () => {
    // The ceiling is not about time. The mutation payload and the report have
    // to stay inside the stated body limit, so a fast database is not a licence
    // to build a batch nobody can describe in a response.
    const budget = new BatchBudget(SAFE_BATCH_WINDOW_MS, 0.001);
    expect(budget.nextBatchRows()).toBe(DEFAULT_BATCH_ROWS);
  });

  it('never proposes zero rows, however slow the database is', () => {
    // A batch of zero is not caution, it is a stalled import that never reports
    // progress and never fails either.
    const budget = new BatchBudget(SAFE_BATCH_WINDOW_MS, 10 * 60 * 1000);
    expect(budget.nextBatchRows()).toBe(MIN_BATCH_ROWS);
  });
});

describe('reacting to what actually happened', () => {
  it('adopts a slowdown immediately and in full', () => {
    // Direct evidence about the database we are talking to right now. Smoothing
    // it would keep proposing large batches for several batches after the
    // slowdown began — precisely when it matters.
    const budget = new BatchBudget(SAFE_BATCH_WINDOW_MS, 10);
    const before = budget.nextBatchRows();
    budget.observe({ rows: 100, elapsedMs: 50_000 }); // 500 ms/row
    expect(budget.estimatedMsPerRow).toBe(500);
    expect(budget.nextBatchRows()).toBeLessThan(before);
    expect(budget.nextBatchRows()).toBe(60);
  });

  it('grows back gradually, not on one lucky batch', () => {
    const budget = new BatchBudget(SAFE_BATCH_WINDOW_MS, 400);
    budget.observe({ rows: 50, elapsedMs: 50 }); // 1 ms/row — suspiciously fast
    // Half-way, not all the way: one warm-cache batch is not evidence the next
    // will be fast.
    expect(budget.estimatedMsPerRow).toBeCloseTo(200.5, 1);
    expect(budget.estimatedMsPerRow).toBeGreaterThan(1);
  });

  it('converges on a genuinely fast database within a few batches', () => {
    const budget = new BatchBudget(SAFE_BATCH_WINDOW_MS, ASSUMED_MS_PER_ROW);
    for (let i = 0; i < 8; i++) budget.observe({ rows: 100, elapsedMs: 150 }); // 1.5 ms/row
    expect(budget.nextBatchRows()).toBe(DEFAULT_BATCH_ROWS);
  });

  it('ignores nonsense readings instead of poisoning the estimate', () => {
    const budget = new BatchBudget(SAFE_BATCH_WINDOW_MS, 50);
    budget.observe({ rows: 0, elapsedMs: 1000 });
    budget.observe({ rows: -5, elapsedMs: 1000 });
    budget.observe({ rows: 10, elapsedMs: -1 });
    budget.observe({ rows: 10, elapsedMs: Number.NaN });
    expect(budget.estimatedMsPerRow).toBe(50);
  });
});

describe('a single unit that cannot be split', () => {
  it('is recognised when it will not fit on its own', () => {
    // A family of 300 variants is one indivisible unit — splitting it could
    // commit a parent without its children. If it will not fit, the answer is
    // to beat DURING the unit, not to shrink the batch.
    const budget = new BatchBudget(SAFE_BATCH_WINDOW_MS, 402);
    expect(budget.unitExceedsWindow(300)).toBe(true);
    expect(budget.unitExceedsWindow(10)).toBe(false);
  });

  it('still yields a batch of one rather than refusing to proceed', () => {
    const budget = new BatchBudget(SAFE_BATCH_WINDOW_MS, 402);
    expect(budget.nextBatchRows()).toBeGreaterThanOrEqual(MIN_BATCH_ROWS);
  });
});

describe('pacing the heartbeat without owning a timer', () => {
  it('does not beat before the interval has passed', async () => {
    const pacer = new HeartbeatPacer(0);
    const beat = jest.fn().mockResolvedValue(true);
    await pacer.beatIfDue(HEARTBEAT_INTERVAL_MS - 1, beat);
    expect(beat).not.toHaveBeenCalled();
  });

  it('beats once the interval has passed, and resets from that moment', async () => {
    const pacer = new HeartbeatPacer(0);
    const beat = jest.fn().mockResolvedValue(true);

    await pacer.beatIfDue(HEARTBEAT_INTERVAL_MS, beat);
    expect(beat).toHaveBeenCalledTimes(1);

    await pacer.beatIfDue(HEARTBEAT_INTERVAL_MS + 1, beat);
    expect(beat).toHaveBeenCalledTimes(1);

    await pacer.beatIfDue(HEARTBEAT_INTERVAL_MS * 2, beat);
    expect(beat).toHaveBeenCalledTimes(2);
  });

  it('reports a lost lease so the worker can stop at its next safe point', async () => {
    const pacer = new HeartbeatPacer(0);
    const lost = jest.fn().mockResolvedValue(false);
    await expect(pacer.beatIfDue(HEARTBEAT_INTERVAL_MS, lost)).resolves.toBe(false);
  });

  it('reports held when no beat was needed', async () => {
    const pacer = new HeartbeatPacer(0);
    const beat = jest.fn().mockResolvedValue(false);
    // Nothing was attempted, so nothing can be claimed lost.
    await expect(pacer.beatIfDue(1, beat)).resolves.toBe(true);
  });

  it('stops beating when the work stops progressing', async () => {
    // The property a background timer would destroy. Beats ride on the worker's
    // own thread of control, so work that is stuck stops renewing and the lease
    // expires — which is the entire purpose of a lease.
    const pacer = new HeartbeatPacer(0);
    const beat = jest.fn().mockResolvedValue(true);
    // The worker never reaches another safe point, so `beatIfDue` is never
    // called again however much wall-clock time passes.
    expect(beat).not.toHaveBeenCalled();
    expect(pacer.due(HEARTBEAT_INTERVAL_MS * 100)).toBe(true);
  });
});
