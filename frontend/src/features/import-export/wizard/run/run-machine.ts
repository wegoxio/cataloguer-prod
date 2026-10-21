import type {
  Approval,
  CreatedPlan,
  ExecutionStatus,
  PlanLifecycle,
  ReportSummary,
  RowResult,
} from '../api/lifecycle.service';

/**
 * The run, from a durable plan to a report.
 *
 * The mapping editor decides what an import MEANS. This decides what happens to
 * it, and it is the half where mistakes are expensive: everything past approval
 * writes to a real catalogue.
 *
 * It is a reducer for the same reason the mapping is — the rules below are
 * rules about a sequence of events, and a sequence is far easier to test as a
 * sequence than through a screen. Four of them are load-bearing:
 *
 *  - **The proof is spent, not kept.** The approval returns a single-use proof
 *    for a catalogue-wide write. It is held in memory, dropped the moment
 *    execution starts, and never persisted or rendered.
 *  - **Editing retracts everything.** A plan is a hash of specific decisions and
 *    an approval attests to a specific plan, so any edit drops both. The
 *    alternative is approving what you were shown rather than what you built.
 *  - **Status never rewinds.** Poll responses can arrive out of order and a
 *    worker's logs can lag its commits. A snapshot that knows LESS than one we
 *    already have is ignored, and nothing moves out of a terminal state.
 *  - **Cancelling is a request.** The batch in flight finishes. Saying "stopped"
 *    when the truthful word is "stopping" is how somebody concludes a write
 *    did not happen when it did.
 */

export type RunPhase =
  /** Still editing. The plan does not exist yet. */
  | 'IDLE'
  | 'PLANNING'
  /** A durable plan exists and is waiting for a person to approve it. */
  | 'PLANNED'
  | 'APPROVING'
  /** Approved, proof in hand, nothing written yet. */
  | 'APPROVED'
  | 'STARTING'
  /** Writing. Status comes from the server, not from this machine. */
  | 'RUNNING'
  /** Cancellation asked for; the batch in flight is still finishing. */
  | 'CANCELLING'
  /** Interrupted and safe to continue from the last checkpoint. */
  | 'RESUMABLE'
  /** Reached a terminal outcome. */
  | 'SETTLED';

export interface RunState {
  phase: RunPhase;
  plan: CreatedPlan | null;
  /** The approval WITHOUT its proof — an id and an expiry are safe to show. */
  approval: Omit<Approval, 'proof'> | null;
  /**
   * The single-use proof.
   *
   * Memory only. It is never written to progress storage, never put in a URL,
   * and never rendered; for its lifetime it authorises a write across the whole
   * catalogue, and it is cleared as soon as it has been spent.
   */
  proof: string | null;
  execution: ExecutionStatus | null;
  rows: RowResult[];
  report: ReportSummary | null;
  /** What the server said about a cancellation request, in its own words. */
  cancelNotice: string | null;
  /**
   * Whether a read of the results is in flight.
   *
   * Kept so the control can be replaced by a status while it is out. Pressing
   * View results five times used to send five pairs of requests, which is what
   * the Package B logs show: rows and report, over and over, answering 200
   * every time onto a screen with nowhere to put them.
   */
  resultsLoading: boolean;
  /**
   * Whether the results have already been read.
   *
   * Once they have, the answer is on screen and the question is not worth
   * asking again — the rows of a finished run do not change.
   */
  resultsLoaded: boolean;
  /**
   * What the SERVER says this plan's state is.
   *
   * Held beside the phase rather than instead of it, because the two answer
   * different questions: the phase is what this browser has done since the page
   * opened, and this is what has happened to the plan over its whole life,
   * including in other sessions and on other days. When they disagree the
   * server's answer is the one that decides what may be offered — a plan whose
   * approval was consumed two days ago is not approvable however new this tab
   * is.
   */
  lifecycle: PlanLifecycle | null;
  /** The last refusal, in tenant-facing words. */
  error: string | null;
}

export type RunAction =
  | { type: 'PLAN_REQUESTED' }
  | { type: 'PLAN_CREATED'; plan: CreatedPlan }
  /**
   * A plan the SERVER already had, opened for review.
   *
   * The same active plan as one this machine built. Without it, plan review
   * held its plan in its own state while the machine held none — and
   * `approve()`, which reads the machine's, returned at its first line. The
   * button was on screen, wired, and dead.
   */
  | { type: 'PLAN_LOADED'; plan: CreatedPlan }
  | { type: 'LIFECYCLE_OBSERVED'; lifecycle: PlanLifecycle }
  | { type: 'APPROVAL_REQUESTED' }
  | { type: 'APPROVAL_GRANTED'; approval: Approval }
  | { type: 'EXECUTION_REQUESTED' }
  | { type: 'EXECUTION_STARTED'; executionId: string }
  | { type: 'STATUS_OBSERVED'; status: ExecutionStatus }
  | { type: 'CANCEL_REQUESTED' }
  | { type: 'CANCEL_ACKNOWLEDGED'; notice: string }
  | { type: 'RESUME_REQUESTED' }
  | { type: 'RESULTS_REQUESTED' }
  | { type: 'RESULTS_LOADED'; rows: RowResult[]; report: ReportSummary }
  /**
   * A REAL change to the decisions the plan was built from.
   *
   * Dispatched on a value difference, never on a re-render: the editor's state
   * objects are rebuilt constantly and identity said nothing about whether
   * anything had actually changed.
   */
  | { type: 'PLAN_INVALIDATED' }
  /**
   * The approval has been withdrawn on the server, at somebody's request.
   *
   * The only way past an approved plan, and deliberately separate from
   * `PLAN_INVALIDATED` so that no automatic path can reach it.
   */
  | { type: 'PLAN_RELEASED' }
  | { type: 'FAILED'; message: string };

export const TERMINAL_STATUSES = ['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED'] as const;

export function isTerminal(status: ExecutionStatus['status']): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function initialRunState(): RunState {
  return {
    phase: 'IDLE',
    plan: null,
    lifecycle: null,
    approval: null,
    proof: null,
    execution: null,
    rows: [],
    report: null,
    cancelNotice: null,
    resultsLoading: false,
    resultsLoaded: false,
    error: null,
  };
}

/**
 * Does this snapshot know more than the one we hold?
 *
 * Polling is not ordered. Two requests in flight can answer in either order, so
 * a response describing an EARLIER moment must be dropped rather than applied —
 * otherwise a finished import can appear to go back to running, and somebody
 * watching it decides to intervene in something that is already done.
 */
export function supersedes(previous: ExecutionStatus | null, next: ExecutionStatus): boolean {
  if (!previous) return true;
  // A snapshot of a DIFFERENT run always wins: it is the run we just started or
  // resumed, and the old one's progress says nothing about it.
  if (previous.id !== next.id) return true;
  if (isTerminal(previous.status) && !isTerminal(next.status)) return false;
  return next.batchesCompleted >= previous.batchesCompleted;
}

function phaseFor(status: ExecutionStatus): RunPhase {
  if (isTerminal(status.status)) return 'SETTLED';
  if (status.status === 'ABANDONED') return status.resumable ? 'RESUMABLE' : 'SETTLED';
  if (status.cancelRequested) return 'CANCELLING';
  return 'RUNNING';
}

export function runReducer(state: RunState, action: RunAction): RunState {
  switch (action.type) {
    case 'PLAN_REQUESTED':
      return { ...state, phase: 'PLANNING', error: null };

    case 'LIFECYCLE_OBSERVED':
      return { ...state, lifecycle: action.lifecycle };

    case 'PLAN_CREATED':
      // A plan whose readiness the server refuses does not advance. The server
      // revalidates before it writes anyway, but showing an approve button over
      // a plan that cannot run invites a click that can only be refused.
      return {
        ...state,
        phase: action.plan.readiness.allowed ? 'PLANNED' : 'IDLE',
        plan: action.plan,
        approval: null,
        proof: null,
        error: action.plan.readiness.allowed ? null : (action.plan.readiness.reason ?? null),
      };

    case 'PLAN_LOADED':
      // Deliberately the same shape as PLAN_CREATED. One active plan, one set
      // of actions, one path through approval — two would drift, and the
      // drift is what shipped a dead button.
      return {
        ...state,
        phase: action.plan.readiness.allowed ? 'PLANNED' : 'IDLE',
        plan: action.plan,
        approval: null,
        proof: null,
        error: action.plan.readiness.allowed ? null : (action.plan.readiness.reason ?? null),
      };

    case 'APPROVAL_REQUESTED':
      return { ...state, phase: 'APPROVING', error: null };

    case 'APPROVAL_GRANTED': {
      const { proof, ...rest } = action.approval;
      return { ...state, phase: 'APPROVED', approval: rest, proof, error: null };
    }

    case 'EXECUTION_REQUESTED':
      return { ...state, phase: 'STARTING', error: null };

    case 'EXECUTION_STARTED':
      // The proof is spent here. It cannot be used a second time and keeping it
      // only widens the window in which a copy of it exists.
      return {
        ...state,
        phase: 'RUNNING',
        proof: null,
        cancelNotice: null,
        // The previous run's answers do not describe this one.
        rows: [],
        report: null,
        resultsLoading: false,
        resultsLoaded: false,
        execution: {
          id: action.executionId,
          planId: state.plan?.id ?? '',
          status: 'QUEUED',
          batchesCompleted: 0,
          batchesTotal: 0,
          rows: { created: 0, updated: 0, skipped: 0, failed: 0 },
          cancelRequested: false,
          resumable: false,
          failureReason: null,
          startedAt: null,
          finishedAt: null,
          checkpoints: [],
        },
      };

    case 'STATUS_OBSERVED':
      if (!supersedes(state.execution, action.status)) return state;
      return { ...state, execution: action.status, phase: phaseFor(action.status) };

    case 'CANCEL_REQUESTED':
      // Deliberately NOT terminal. Work continues until the batch in flight
      // commits, and the screen must keep saying so.
      return { ...state, phase: 'CANCELLING', error: null };

    case 'CANCEL_ACKNOWLEDGED':
      return { ...state, cancelNotice: action.notice };

    case 'RESUME_REQUESTED':
      return { ...state, phase: 'STARTING', error: null };

    case 'RESULTS_REQUESTED':
      return { ...state, resultsLoading: true, error: null };

    case 'RESULTS_LOADED':
      return { ...state, rows: action.rows, report: action.report, resultsLoading: false, resultsLoaded: true };

    case 'PLAN_INVALIDATED':
      // The lifecycle described a plan these edits have just replaced. Keeping
      // it would let a previous plan's terminal state govern a new one.
      //
      // REFUSED once anything has been authorised or written. This used to
      // guard against a run only, and that was not enough: the approval proof
      // is single-use, held in memory and nowhere else, so an automatic
      // invalidation firing between the approval and the lifecycle refetch
      // destroyed the only copy of it. The plan stayed APPROVED on the server,
      // this machine reset to IDLE, and the screen offered nothing at all —
      // precisely how plan `bcdb9687…` was stranded.
      //
      // Past this point an edit is a decision somebody makes explicitly, and it
      // goes through withdrawal, which is audited. See `PLAN_RELEASED`.
      if (state.execution || state.proof || state.approval) return state;
      return { ...state, phase: 'IDLE', plan: null, lifecycle: null, approval: null, proof: null, error: null };

    case 'PLAN_RELEASED':
      // The authorisation is gone — withdrawn on the server, deliberately, by
      // somebody who was shown what it meant. Only now may the machine drop the
      // plan it was attached to.
      //
      // Still never over a run: an execution outranks every authorisation
      // question, this one included.
      if (state.execution) return state;
      return { ...state, phase: 'IDLE', plan: null, lifecycle: null, approval: null, proof: null, error: null };

    case 'FAILED':
      // The proof goes with the failure. If starting execution failed we cannot
      // know whether the server consumed it, and re-presenting a possibly-spent
      // proof produces a confusing second refusal rather than a clear one.
      return {
        ...state,
        phase: state.execution ? state.phase : 'IDLE',
        proof: null,
        // Released on failure, so the control returns and can be pressed again.
        // A stuck spinner is another way to render a state with no way out.
        resultsLoading: false,
        error: action.message,
      };

    default:
      return state;
  }
}

/** Whether a poll should still be issued. */
export function shouldPoll(state: RunState): boolean {
  return state.phase === 'RUNNING' || state.phase === 'CANCELLING' || state.phase === 'STARTING';
}

/**
 * What the run is doing, for someone watching it.
 *
 * Written from the execution row and its checkpoints, which is what the server
 * has committed — never from a log line, which can lag a commit by minutes and
 * would otherwise report a finished import as still running.
 */
export function describeRun(state: RunState): string {
  const execution = state.execution;
  if (!execution) {
    switch (state.phase) {
      case 'PLANNING':
        return 'Preparing your import…';
      case 'PLANNED':
        return 'Ready to import. Nothing has been changed yet.';
      case 'APPROVING':
        return 'Confirming…';
      case 'APPROVED':
        return 'Approved. Nothing has been changed yet.';
      default:
        return 'Nothing has been changed yet.';
    }
  }

  const done = execution.batchesCompleted;
  const total = execution.batchesTotal;
  const progress = total > 0 ? ` ${done} of ${total} batches are done.` : '';

  switch (execution.status) {
    case 'QUEUED':
      return 'Your import is queued and will start in a moment.';
    case 'RUNNING':
      return execution.cancelRequested
        ? `Stopping after the batch that is running now.${progress}`
        : `Importing.${progress}`;
    case 'COMPLETED':
      return `Finished. ${describeRows(execution)}`;
    case 'PARTIALLY_COMPLETED':
      return `Finished with some rows left out. ${describeRows(execution)}`;
    case 'CANCELLED':
      return `Stopped at your request.${progress} ${describeRows(execution)}`;
    case 'FAILED':
      return `Stopped by a problem.${progress} ${describeRows(execution)}`;
    case 'ABANDONED':
      return execution.resumable
        ? `This import stopped before it finished.${progress} You can continue it from where it stopped.`
        : `This import stopped before it finished.${progress}`;
    default:
      return 'Importing.';
  }
}

function describeRows(execution: ExecutionStatus): string {
  const { created, updated, skipped, failed } = execution.rows;
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} added`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (skipped > 0) parts.push(`${skipped} left unchanged`);
  if (failed > 0) parts.push(`${failed} could not be imported`);
  return parts.length > 0 ? `${parts.join(', ')}.` : 'No rows were changed.';
}

export const proofIsHeld = (state: RunState): boolean => state.proof !== null;
