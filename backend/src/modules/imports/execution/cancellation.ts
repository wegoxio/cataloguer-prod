/**
 * Stopping an import that is already running.
 *
 * "Cancel" means something specific here, and it is worth being blunt about it:
 * **it does not undo anything.** Batches that have committed stay committed.
 * There is no transaction spanning the run to roll back, deliberately — a run
 * that held one open for a hundred thousand rows would hold locks across the
 * whole catalogue for minutes and could not survive a worker restart.
 *
 * So cancellation stops the run at the next safe boundary and reports exactly
 * how far it got. The person is then in the same position as after any partial
 * run: the report says what landed, and the repair is forward.
 *
 * The alternative — killing the worker mid-batch — is worse in every way. The
 * batch's transaction rolls back, which sounds clean, but the run then has no
 * checkpoint for it and no row results, so the report cannot say whether those
 * rows were applied. "I do not know what happened to rows 400–600" is the one
 * answer an import must never give.
 */

export type CancellationState = 'RUNNING' | 'CANCEL_REQUESTED' | 'CANCELLED';

/** Points at which a run may stop without leaving anything half-written. */
export type SafeBoundary =
  /** Between batches: the previous batch has committed and checkpointed. */
  | 'BETWEEN_BATCHES'
  /** Between atomic units inside a batch, before the unit has been started. */
  | 'BETWEEN_UNITS';

export interface CancellationDecision {
  stop: boolean;
  /** Recorded on the execution so the report can explain the shape of the run. */
  reason?: string;
}

/**
 * A cancellation flag the worker polls at boundaries it declares safe.
 *
 * Polled rather than pushed, and checked by the worker rather than imposed on
 * it, for the same reason the heartbeat is caller-driven: the worker is the
 * only thing that knows where it is. An interrupt delivered at an arbitrary
 * moment would arrive in the middle of a unit as often as not.
 */
export class CancellationToken {
  private state: CancellationState = 'RUNNING';
  private requestedBy: string | null = null;

  /** Ask the run to stop. Returns false if it had already been asked. */
  request(by: string): boolean {
    if (this.state !== 'RUNNING') return false;
    this.state = 'CANCEL_REQUESTED';
    this.requestedBy = by;
    return true;
  }

  get requested(): boolean {
    return this.state !== 'RUNNING';
  }

  get cancelledBy(): string | null {
    return this.requestedBy;
  }

  /**
   * Whether to stop here.
   *
   * `BETWEEN_UNITS` is honoured as well as `BETWEEN_BATCHES` so a cancel during
   * a long batch does not have to wait for the whole batch to finish. Both are
   * genuinely safe: a unit is atomic, so stopping before one starts leaves
   * nothing partial — the batch simply commits fewer units than planned, which
   * the checkpoint records faithfully.
   */
  shouldStop(boundary: SafeBoundary): CancellationDecision {
    if (!this.requested) return { stop: false };
    const who = this.requestedBy ? `${this.requestedBy}'s` : 'your';
    // Which boundary stopped the run is not a detail. Stopping between batches
    // means the last batch landed whole; stopping between units means it
    // committed fewer rows than it planned to. An operator reconciling a
    // catalogue needs to know which.
    const where =
      boundary === 'BETWEEN_BATCHES'
        ? 'The last batch was completed in full.'
        : 'The batch in progress stopped part-way, committing only the rows it had already applied.';
    return {
      stop: true,
      reason: `Stopped at ${who} request. Everything imported before that point was kept. ${where}`,
    };
  }

  markStopped(): void {
    this.state = 'CANCELLED';
  }

  get stopped(): boolean {
    return this.state === 'CANCELLED';
  }
}

/**
 * How a run ended.
 *
 * `PARTIALLY_COMPLETED` is a first-class outcome, not a euphemism for failure.
 * Bounded execution commits durable batches by design, so a run that stops
 * early has done real, correct work — and calling it "failed" would tell the
 * person to redo all of it.
 */
export type RunOutcome = 'COMPLETED' | 'PARTIALLY_COMPLETED' | 'CANCELLED' | 'FAILED' | 'ABANDONED';

export function describeRunOutcome(
  outcome: RunOutcome,
  progress: { batchesCommitted: number; batchesPlanned: number },
): string {
  const { batchesCommitted, batchesPlanned } = progress;
  switch (outcome) {
    case 'COMPLETED':
      return 'The import finished. Every batch was applied.';
    case 'PARTIALLY_COMPLETED':
      return `The import stopped after ${batchesCommitted} of ${batchesPlanned} batches. What was applied is correct and does not need repeating.`;
    case 'CANCELLED':
      return `You stopped the import after ${batchesCommitted} of ${batchesPlanned} batches. What had already been imported was kept — cancelling does not undo it.`;
    case 'FAILED':
      return `The import stopped because of an error after ${batchesCommitted} of ${batchesPlanned} batches. What was applied before it is correct.`;
    case 'ABANDONED':
      // The lease expired without a release. The checkpoints are the truth
      // about what landed; the absence of logs is not evidence of anything.
      return `The import stopped unexpectedly after ${batchesCommitted} of ${batchesPlanned} batches. It can be resumed from where it stopped.`;
    default:
      return 'The import stopped.';
  }
}

/** Whether a run in this state may be picked up and continued. */
export function isResumable(outcome: RunOutcome): boolean {
  // A cancelled run is deliberately NOT resumable by default. Someone stopped
  // it on purpose, and quietly continuing it later would be the opposite of
  // what they asked for; starting a fresh run from the remaining rows is the
  // explicit act.
  return outcome === 'PARTIALLY_COMPLETED' || outcome === 'ABANDONED' || outcome === 'FAILED';
}
