import { DEFAULT_BATCH_ROWS } from './batch-planner';
import { HEARTBEAT_INTERVAL_MS, LEASE_DURATION_MS } from '../worker/import-lease.service';

/**
 * Keeping a batch short enough that the lease survives it.
 *
 * The original claim was that "200 rows cannot plausibly outlive a 60-second
 * lease". That was an assertion, not a measurement, and it is the kind of
 * assertion that is true on a developer's loopback Postgres and false against a
 * pooled database two network hops away. A row is not a unit of time: the same
 * 200 rows are a fraction of a second locally and can be tens of seconds when
 * every statement pays a round trip.
 *
 * So the batch size is derived rather than declared. Each batch reports how long
 * it actually took, and the next batch is sized from that observation. A run
 * that starts slow shrinks its batches immediately instead of discovering the
 * problem by losing its lease halfway through a family.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It never grows the batch beyond {@link DEFAULT_BATCH_ROWS}. The body limit
 *    and the report size are bounded by the same number, so a fast database is
 *    not a reason to make a batch that cannot be described in a response.
 *  - It never schedules anything. The heartbeat stays caller-driven, because a
 *    timer is background machinery with no HTTP verb and maintenance mode
 *    cannot refuse it (the P5-X1 census forbids exactly that).
 */

/**
 * A batch must be projected to finish within this fraction of a lease.
 *
 * Half, not most of it. The margin absorbs the two things the projection cannot
 * see: a unit that is slower than the ones already measured, and the fact that
 * the lease clock started before the batch did. Sizing to 90% of a lease would
 * be correct on average and lose the lease regularly.
 */
export const SAFE_LEASE_FRACTION = 0.5;

/** The window a batch is sized to fit inside. */
export const SAFE_BATCH_WINDOW_MS = LEASE_DURATION_MS * SAFE_LEASE_FRACTION;

/**
 * Starting assumption before anything has been observed, in milliseconds per
 * row.
 *
 * Derived, not chosen. `batch-lease-timing.pg.spec.ts` measures the most
 * expensive representative unit — a product row with its categories, field
 * values and store allocation — at **10 statements per row** and 1.5 ms of
 * local work. Against the worst modelled round trip (40 ms, a cross-region hop
 * or a pooler under load) that is `1.5 + 10 × 40 ≈ 402` ms per row, so the
 * first batch is sized for 74 rows rather than 200.
 *
 * Pessimistic on purpose, and asymmetrically so. Guessing high costs a small
 * first batch that the very next observation corrects. Guessing low costs a
 * lost lease, a half-applied import and a resumed run — and the first batch is
 * the one batch no observation has corrected yet.
 *
 * A local-only measurement would have said 1.5 ms/row and sized the first batch
 * at the 200-row ceiling. That is the specific mistake this constant exists to
 * avoid: loopback hides the term that dominates in production.
 */
export const ASSUMED_MS_PER_ROW = 420;

/** Never go below this, or progress stops being progress. */
export const MIN_BATCH_ROWS = 1;

/**
 * How much weight a new observation carries.
 *
 * Deliberately high (0.5). This is not smoothing noise for a dashboard; it is
 * reacting to a database that has become slow. A slow-moving average would keep
 * proposing large batches for several batches after the slowdown began, which is
 * precisely when it matters.
 */
const OBSERVATION_WEIGHT = 0.5;

export interface BatchObservation {
  rows: number;
  elapsedMs: number;
}

export class BatchBudget {
  private msPerRow: number;

  constructor(
    private readonly safeWindowMs: number = SAFE_BATCH_WINDOW_MS,
    initialMsPerRow: number = ASSUMED_MS_PER_ROW,
    private readonly maxRows: number = DEFAULT_BATCH_ROWS,
  ) {
    this.msPerRow = initialMsPerRow;
  }

  /** Current cost estimate, exposed so a report can explain a small batch. */
  get estimatedMsPerRow(): number {
    return this.msPerRow;
  }

  /**
   * Fold in what a batch actually cost.
   *
   * Deliberately asymmetric. A slowdown is adopted in full and at once: it is
   * direct evidence about the database we are talking to right now, and the
   * penalty for ignoring it is a lost lease. A speed-up is folded in gradually,
   * because one batch that happened to hit warm cache is not evidence that the
   * next one will — and growing eagerly is exactly how a run ends up holding a
   * large batch at the moment the database slows down.
   */
  observe({ rows, elapsedMs }: BatchObservation): void {
    if (rows <= 0 || !Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    const observed = elapsedMs / rows;
    this.msPerRow =
      observed > this.msPerRow ? observed : this.msPerRow * (1 - OBSERVATION_WEIGHT) + observed * OBSERVATION_WEIGHT;
  }

  /** How many rows the next batch may contain. */
  nextBatchRows(): number {
    const projected = Math.floor(this.safeWindowMs / Math.max(this.msPerRow, 0.001));
    return Math.max(MIN_BATCH_ROWS, Math.min(this.maxRows, projected));
  }

  /** What the next batch of this size is expected to cost. */
  projectedMs(rows: number): number {
    return rows * this.msPerRow;
  }

  /**
   * Whether a single atomic unit is projected to outrun the safe window on its
   * own.
   *
   * This is the case the batch size cannot fix. A family of 300 variants is one
   * indivisible unit — splitting it could commit a parent without its children —
   * so if it will not fit, the answer is to beat during the unit, not to make
   * the batch smaller.
   */
  unitExceedsWindow(unitRows: number): boolean {
    return this.projectedMs(unitRows) > this.safeWindowMs;
  }
}

/**
 * Decides when the worker should beat, without owning a timer.
 *
 * The worker calls {@link due} at its safe points and beats when told to. That
 * keeps the heartbeat on the worker's own thread of control: if the work stops
 * making progress, the beats stop too, and the lease expires as it should. A
 * background timer would keep the lease alive precisely when the work is stuck,
 * which is the opposite of what a lease is for.
 */
export class HeartbeatPacer {
  private lastBeatAt: number;

  constructor(
    now: number,
    private readonly intervalMs: number = HEARTBEAT_INTERVAL_MS,
  ) {
    this.lastBeatAt = now;
  }

  due(now: number): boolean {
    return now - this.lastBeatAt >= this.intervalMs;
  }

  recordBeat(now: number): void {
    this.lastBeatAt = now;
  }

  /**
   * Beat if due, at a point the caller has declared safe.
   *
   * Returns whether the lease is still held; `true` when no beat was needed.
   * The caller is expected to stop on `false` rather than keep writing.
   *
   * IMPORTANT: only call this OUTSIDE a transaction. The heartbeat is an UPDATE
   * on the same connection, so beating inside an open transaction would leave
   * the renewal invisible to every other worker until that transaction commits —
   * the lease would look expired to a reaper the whole time, which is the exact
   * situation the heartbeat exists to prevent.
   */
  async beatIfDue(now: number, beat: () => Promise<boolean>): Promise<boolean> {
    if (!this.due(now)) return true;
    const held = await beat();
    this.recordBeat(now);
    return held;
  }
}
