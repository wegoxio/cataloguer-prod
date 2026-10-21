import type { PlanLifecycle } from '../api/lifecycle.service';

/**
 * What may be done with an import, decided once.
 *
 * Every control on the run surface used to be gated by an expression of its
 * own, joined to the server's answer with `&&`. The two disagreed, and every
 * disagreement rendered as a control that was simply absent — which is
 * indistinguishable, to the person looking at it, from a screen that has
 * finished loading and is telling them there is nothing to do.
 *
 * That is how plan `bcdb9687…` came to say "Approved and ready to run" with no
 * action anywhere on the page: the server said APPROVED, the client's own phase
 * had been reset to IDLE by an unrelated re-render, and the button required
 * both. Nothing was wrong with the import. Nothing was wrong with the server.
 * The screen simply had no way to say what it knew.
 *
 * So capability is derived HERE, from the server's lifecycle, once, and nothing
 * else decides it. The client's phase is allowed to describe what is in flight
 * — a request that has been sent and not yet answered — because that is a fact
 * about this browser and nowhere else. It is not allowed to decide whether an
 * approved plan may run.
 *
 * Two rules hold above all others:
 *
 *  - **A run outranks everything.** Once an execution exists, the only honest
 *    subject of the screen is that run — not the authorisation that permitted
 *    it, and not how to recover a proof that has already been spent.
 *  - **No reachable state renders nothing.** Every state below resolves to at
 *    least one action, or to a status that explicitly needs none. A state that
 *    could produce neither is a defect, and `projectPlanActions` names it as
 *    one rather than rendering an empty page.
 */

/** Everything the surface can offer. One id per control, across both entries. */
export type PlanActionId =
  | 'APPROVE'
  | 'START'
  | 'WITHDRAW'
  | 'EDIT_MAPPING'
  | 'CANCEL_RUN'
  | 'RESUME_RUN'
  | 'VIEW_RESULTS';

/**
 * Why the surface looks the way it does.
 *
 *  - `ACTIONABLE` — waiting for a person; at least one action is offered.
 *  - `IN_FLIGHT` — a request is out, or a run is going; no action is required
 *    and the screen updates itself.
 *  - `TERMINAL` — finished. Some terminal states still offer a way to read the
 *    result, which is an action but not an obligation.
 *  - `BLOCKED` — the state is not yet known, or is contradictory. Never silent.
 */
export type PlanSurfaceKind = 'ACTIONABLE' | 'IN_FLIGHT' | 'TERMINAL' | 'BLOCKED';

/** A request this browser has sent and not yet had answered. */
export type InFlight = 'NONE' | 'PLANNING' | 'APPROVING' | 'STARTING' | 'WITHDRAWING' | 'CANCELLING';

export interface PlanActionInput {
  /**
   * The server's answer. The authority for every durable capability.
   *
   * `null` means it has not been read yet — which is a BLOCKED surface, never
   * an empty one, and never an optimistic one.
   */
  lifecycle: PlanLifecycle | null;
  /** Whether THIS browser still holds the single-use approval proof. */
  proofHeld: boolean;
  /** A request in flight, from the client machine. Presentation only. */
  inFlight: InFlight;
  /**
   * The run THIS browser has seen, if any.
   *
   * It can know before the lifecycle does: `startExecution` answers, and the
   * refetch that follows it is a second round trip. For the width of that gap
   * the machine knows more than the server's last answer, and a recovery panel
   * offered in that window claims nothing has been written while a run is
   * already writing.
   *
   * The STATUS is carried, not merely the fact of a run. A boolean could say
   * "something is happening" but not that the thing which happened was an
   * abandoned lease with committed work behind it — which is the difference
   * between offering Stop and offering Continue.
   */
  observedExecution: { status: string; resumable: boolean; cancelRequested: boolean } | null;
  /**
   * Whether the run's results have been read, or are being read.
   *
   * `View results` is a question, and once it has been answered the answer is
   * on screen — a finished run's rows do not change. Offering it again invites
   * the duplicate requests the Package B logs show: five pairs of rows and
   * report in three seconds, every one answering 200.
   */
  results?: { loaded: boolean; loading: boolean };
}

export interface PlanSurface {
  kind: PlanSurfaceKind;
  /** The one-line subject of the screen. */
  headline: string;
  /** What it means and what happens next, in the reader's terms. */
  detail: string;
  /** Offered controls, in the order they should appear. */
  actions: PlanActionId[];
  /**
   * True when the absence of actions is the correct answer rather than a gap.
   *
   * The invariant this file exists to keep is `actions.length > 0 ||
   * requiresNoAction`. A surface that satisfies neither is impossible by
   * construction below, and asserted in the tests.
   */
  requiresNoAction: boolean;
  /**
   * Which row decided this, when the plan's own status column disagrees.
   *
   * Null when there is nothing to explain. Populated when the projection
   * overrode the stored status — a plan reading APPROVED whose execution
   * COMPLETED two days ago, the shape production is actually in — because
   * somebody comparing the screen against the database deserves to know which
   * of the two won and why.
   */
  provenance: string | null;
  /**
   * A contradiction between inputs, named.
   *
   * Null in every ordinary case. When two inputs cannot both be true — a proof
   * held for a plan the server says was never approved, most of all — the
   * surface normalises to the server's answer and records what it ignored, so
   * the reconciliation is visible rather than silent.
   */
  normalized: string | null;
}

const TERMINAL_STATES = ['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED'] as const;

export function isTerminalLifecycle(state: PlanLifecycle['state']): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state);
}

/**
 * The surface, from the server's answer and this browser's in-flight work.
 *
 * Deliberately pure and total: same inputs, same output, no clock, no fetch, no
 * React. Every branch below returns, so there is no path that falls off the end
 * into an empty screen.
 */
export function projectPlanActions(input: PlanActionInput): PlanSurface {
  const { lifecycle, proofHeld, inFlight, observedExecution } = input;
  const results = input.results ?? { loaded: false, loading: false };
  // Asked and answered, or asked and waiting: either way, not worth asking again.
  const mayRead: PlanActionId[] = results.loaded || results.loading ? [] : ['VIEW_RESULTS'];

  // ---- not known yet ------------------------------------------------------
  //
  // Fails CLOSED and says so. The hopeful default — assuming approvable until
  // told otherwise — is exactly how an Approve button appeared on an import
  // that had already run.
  if (!lifecycle) {
    return {
      kind: 'BLOCKED',
      headline: 'Checking what may be done with this import…',
      detail: 'Reading its current state from the server. Nothing has been changed.',
      actions: [],
      requiresNoAction: true,
      provenance: null,
      normalized: null,
    };
  }

  // ---- a run outranks everything -----------------------------------------
  //
  // Checked before in-flight requests and before the approval, because a run
  // that exists is the most authoritative fact available about this plan.
  /*
    A run that stopped part-way and can be continued.

    Neither COMPLETED nor RUNNING: work was committed and more remains. The
    lifecycle calls this PARTIALLY_COMPLETED; the machine sees it first as an
    ABANDONED execution that reports itself resumable. Either source is enough,
    because both describe the same interrupted run.
  */
  const resumable =
    lifecycle.state === 'PARTIALLY_COMPLETED' ||
    (observedExecution?.status === 'ABANDONED' && observedExecution.resumable);

  const observedTerminal =
    observedExecution !== null && isTerminalLifecycle(observedExecution.status as PlanLifecycle['state']);
  const terminal = isTerminalLifecycle(lifecycle.state) || observedTerminal || resumable;
  const running = !terminal && (observedExecution !== null || lifecycle.state === 'EXECUTING');

  /*
    Which row won, said out loud when it matters.

    The plan's status column is not advanced by anything after a run, so a
    finished import can sit at APPROVED for days. When the projection overrules
    that column, the reader is told — otherwise the screen and the database
    disagree and there is nothing on the page to explain why.
  */
  const provenance =
    lifecycle.statusIsStale && lifecycle.authority === 'EXECUTION'
      ? `This is what the run itself records. The plan's own status still says ${lifecycle.storedStatus}.`
      : lifecycle.statusIsStale
        ? `Read from the approval. The plan's own status still says ${lifecycle.storedStatus}.`
        : null;

  if (terminal) {
    /*
      Whichever source actually holds the terminal answer.

      The lifecycle can still say APPROVED while the machine holds a COMPLETED
      execution — this runner finishes in seconds, so the refetch after starting
      routinely lands after the run is over. Reading the headline off the
      lifecycle alone produced the generic "This import has finished." for a run
      whose outcome was perfectly well known.
    */
    const effective = isTerminalLifecycle(lifecycle.state)
      ? lifecycle.state
      : ((observedExecution?.status ?? lifecycle.state) as PlanLifecycle['state']);
    return {
      kind: 'TERMINAL',
      headline: resumable
        ? 'This import partly ran. Some rows were written and some were not.'
        : terminalHeadline(effective),
      detail: resumable
        ? 'Some rows were written and some were not. Resume the run rather than starting a new one, so the rows already in your catalogue are not written twice.'
        : terminalDetail(lifecycle),
      actions: resumable ? ['RESUME_RUN', ...mayRead] : mayRead,
      requiresNoAction: true,
      provenance,
      normalized: proofHeld ? 'A held approval proof was ignored: this plan has already run.' : null,
    };
  }

  if (running) {
    const stopping =
      inFlight === 'CANCELLING' ||
      Boolean(lifecycle.execution?.cancelRequested) ||
      Boolean(observedExecution?.cancelRequested);
    return {
      kind: 'IN_FLIGHT',
      headline: stopping ? 'Stopping after the batch that is running now' : 'This import is running.',
      detail: stopping
        ? 'The batch in flight will finish before it stops. What it writes is kept.'
        : 'It cannot be approved or started again. You can stop it from the run itself.',
      actions: stopping ? [] : ['CANCEL_RUN'],
      requiresNoAction: true,
      provenance,
      normalized: proofHeld ? 'A held approval proof was ignored: it has already been spent on this run.' : null,
    };
  }

  // ---- a request this browser has sent ------------------------------------
  //
  // Presentation only, and only reached when no run exists. It describes the
  // wait; it never decides a capability.
  if (inFlight === 'APPROVING' || inFlight === 'STARTING' || inFlight === 'WITHDRAWING' || inFlight === 'PLANNING') {
    return {
      kind: 'IN_FLIGHT',
      headline: inFlightHeadline(inFlight),
      detail: 'Waiting for the server. Nothing has been written to your catalogue.',
      actions: [],
      requiresNoAction: true,
      provenance: null,
      normalized: null,
    };
  }

  // ---- no run: the server's state decides ---------------------------------
  switch (lifecycle.state) {
    case 'APPROVED':
      // The one place the proof matters, and the only capability it gates.
      // `/execute` cannot be called without it, so offering Start without one
      // would be offering a button that could only fail.
      return proofHeld
        ? {
            kind: 'ACTIONABLE',
            headline: 'Approved. Nothing has been written yet.',
            detail: 'Starting it applies exactly the plan you approved. This approval may be used once.',
            actions: ['START'],
            requiresNoAction: false,
            provenance,
            normalized: null,
          }
        : {
            kind: 'ACTIONABLE',
            headline: 'This approval was created in another or refreshed tab, so its one-time authorization is unavailable.',
            detail:
              'Nothing has been written to your catalogue. Withdraw the approval and approve again to continue — the plan itself is unchanged.',
            actions: ['WITHDRAW'],
            requiresNoAction: false,
            provenance,
            normalized: null,
          };

    case 'PREPARED':
      return {
        kind: 'ACTIONABLE',
        headline: 'Ready to import. Nothing has been changed yet.',
        detail: 'Approving authorises one run of exactly these decisions.',
        actions: ['APPROVE', 'EDIT_MAPPING'],
        requiresNoAction: false,
        // A proof for a plan the server reports as unapproved cannot be spent:
        // the approval behind it was withdrawn, expired or belongs to a plan
        // this one replaced. The server's answer wins and the proof is dropped.
        provenance,
        normalized: proofHeld
          ? 'A held approval proof was ignored: the server reports this plan as not approved.'
          : null,
      };

    case 'APPROVAL_SPENT':
      return {
        kind: 'TERMINAL',
        headline: spentHeadline(lifecycle.approval?.state ?? null),
        detail:
          'An approval authorises one run and cannot be reused. Change something in the mapping to prepare a new plan.',
        actions: ['EDIT_MAPPING'],
        requiresNoAction: true,
        provenance,
        normalized: proofHeld ? 'A held approval proof was ignored: this approval can no longer be used.' : null,
      };

    default:
      // Every declared state is handled above. This is reached only by a state
      // a newer server has invented, and it renders as a named unknown rather
      // than as an empty page.
      return {
        kind: 'BLOCKED',
        headline: 'This import is in a state this page does not recognise.',
        detail: 'Nothing has been changed. Reload the page, or open it from the import history.',
        actions: [],
        requiresNoAction: true,
        provenance,
        normalized: `Unrecognised lifecycle state "${String(lifecycle.state)}".`,
      };
  }
}

/**
 * The invariant, as a function.
 *
 * Exported so the property test asserts the same rule the surface is built on,
 * rather than a restatement of it that could drift.
 */
export function surfaceIsHabitable(surface: PlanSurface): boolean {
  return surface.actions.length > 0 || surface.requiresNoAction;
}

/**
 * What a finished run means, in the words the reader needs.
 *
 * The date is included when the server has one, because the single most useful
 * fact about a plan that reports COMPLETED while its own status column still
 * says APPROVED is WHEN it ran — that is what tells somebody this is the import
 * they are thinking of rather than a different one.
 */
function terminalDetail(lifecycle: PlanLifecycle): string {
  const finished = lifecycle.execution?.finishedAt ?? null;
  const when = finished ? new Date(finished).toLocaleString() : null;
  switch (lifecycle.state) {
    case 'COMPLETED':
      return when
        ? `These exact decisions were imported on ${when}. The report below is that run.`
        : 'These exact decisions have already been imported. The report below is that run.';
    case 'PARTIALLY_COMPLETED':
      return 'Some rows were written and some were not. Resume the run rather than starting a new one, so the rows already in your catalogue are not written twice.';
    case 'FAILED':
      return 'The report below says what went wrong and how far it got. Nothing further has been written.';
    case 'CANCELLED':
      return 'Anything imported before it stopped is kept. The report below says what that was.';
    default:
      return 'Nothing further will be written by this import.';
  }
}

/**
 * What a finished run means for the catalogue.
 *
 * The two surfaces this replaces had two vocabularies for the same four
 * states — "Already executed" on one, "This import has run. Your catalogue has
 * been updated." on the other. The second is kept because it answers the
 * question the reader actually has, which is not what the system did but what
 * happened to their data.
 */
function terminalHeadline(state: PlanLifecycle['state']): string {
  switch (state) {
    case 'COMPLETED':
      return 'This import has run. Your catalogue has been updated.';
    case 'PARTIALLY_COMPLETED':
      return 'This import partly ran. Some rows were written and some were not.';
    case 'FAILED':
      return 'This import failed. Some rows may already have been written.';
    case 'CANCELLED':
      return 'This import was stopped. Anything already imported is kept.';
    default:
      return 'This import has finished.';
  }
}

function spentHeadline(approval: string | null): string {
  if (approval === 'CONSUMED') return 'This approval has already been used';
  if (approval === 'REVOKED') return 'This approval was withdrawn';
  return 'This approval has expired';
}

function inFlightHeadline(inFlight: InFlight): string {
  switch (inFlight) {
    case 'APPROVING':
      return 'Approving…';
    case 'STARTING':
      return 'Starting the import…';
    case 'WITHDRAWING':
      return 'Withdrawing the approval…';
    default:
      return 'Preparing your import…';
  }
}
