/**
 * What state an import is REALLY in.
 *
 * A plan carries a status column, and that column lied. Nothing advanced it
 * after a run: plan `d5ec89ac…` sat at APPROVED for two days while its
 * execution had COMPLETED and its approval had been consumed inside the same
 * minute. The wizard read the column, believed it, and offered an Approve
 * button on an import that had already happened — with no way forward, because
 * the approval behind it was spent.
 *
 * So the column is no longer the answer. The EXECUTION is authoritative: it is
 * the record of what was actually done to the catalogue, it is written by the
 * runner at the moment it happens, and it cannot disagree with reality the way
 * a status nobody updates can. Where the two disagree, a terminal execution
 * wins and the column is treated as stale.
 *
 * This is deliberately a pure function over three rows. It has to be readable
 * at a glance and testable against every historical shape — including the
 * completed-but-plan-still-APPROVED shape that exists in production today.
 */

/** What the wizard renders, and what it may offer. */
export type PlanLifecycleState =
  /** Built and hashed; nobody has approved it. */
  | 'PREPARED'
  /** Approved and not yet started. The only state in which execution may begin. */
  | 'APPROVED'
  /** Queued or running. */
  | 'EXECUTING'
  | 'COMPLETED'
  | 'PARTIALLY_COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  /** Approved once, but the approval can no longer be used and no run survived it. */
  | 'APPROVAL_SPENT';

export type ApprovalState = 'NONE' | 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'REVOKED';

export interface PlanRow {
  status: string;
}

export interface ApprovalRow {
  expires_at: string | Date;
  consumed_at: string | Date | null;
  revoked_at: string | Date | null;
}

export interface ExecutionRow {
  status: string;
  finished_at: string | Date | null;
  cancel_requested?: boolean | null;
}

/** Terminal executions, in the order a run can end. */
const TERMINAL = new Set(['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED']);
const LIVE = new Set(['QUEUED', 'RUNNING']);

export function approvalState(approval: ApprovalRow | null, now: Date): ApprovalState {
  if (!approval) return 'NONE';
  // Revoked first: a revoked approval is revoked whether or not it also expired.
  if (approval.revoked_at) return 'REVOKED';
  if (approval.consumed_at) return 'CONSUMED';
  if (new Date(approval.expires_at).getTime() <= now.getTime()) return 'EXPIRED';
  return 'ACTIVE';
}

/**
 * The state to act on.
 *
 * `executions` is every execution for the plan, newest first. A plan can have
 * more than one only through resume, and the newest is the one that says where
 * the work got to.
 */
export function projectPlanLifecycle(input: {
  plan: PlanRow;
  approval: ApprovalRow | null;
  executions: ExecutionRow[];
  now: Date;
}): { state: PlanLifecycleState; approval: ApprovalState; authority: 'EXECUTION' | 'APPROVAL' | 'PLAN' } {
  const approval = approvalState(input.approval, input.now);
  const latest = input.executions[0] ?? null;

  // ---- the execution, when there is one -----------------------------------
  if (latest) {
    if (LIVE.has(latest.status)) return { state: 'EXECUTING', approval, authority: 'EXECUTION' };
    if (latest.status === 'ABANDONED') {
      // A lease that expired mid-run. Work was committed and more remains, so
      // it is neither running nor finished — it is a partial that can resume.
      return { state: 'PARTIALLY_COMPLETED', approval, authority: 'EXECUTION' };
    }
    if (TERMINAL.has(latest.status)) {
      return {
        state: latest.status as PlanLifecycleState,
        approval,
        authority: 'EXECUTION',
      };
    }
  }

  // ---- no execution: the approval decides ---------------------------------
  //
  // A consumed approval with no execution row should not happen — consumption
  // is what mints one — but "should not happen" is how the previous defect was
  // described too. It resolves to a state that offers nothing rather than to
  // an approve button.
  if (approval === 'CONSUMED') return { state: 'APPROVAL_SPENT', approval, authority: 'APPROVAL' };
  if (approval === 'EXPIRED') return { state: 'APPROVAL_SPENT', approval, authority: 'APPROVAL' };

  // A WITHDRAWN approval leaves the plan approvable again.
  //
  // Revocation withdraws the AUTHORISATION, not the plan: the mapping, the
  // decisions and the hash are untouched, and nothing was written. Treating it
  // as terminal is what turned a lost proof into a trap — an approval that
  // could not be spent, could not be cleared, and blocked re-approval for ever,
  // with expiry making it worse rather than better.
  //
  // Only with no execution. Once a run exists the execution is authoritative
  // and decides above this, so reaching here means nothing was ever started.
  if (approval === 'REVOKED') return { state: 'PREPARED', approval, authority: 'APPROVAL' };

  if (approval === 'ACTIVE') return { state: 'APPROVED', approval, authority: 'APPROVAL' };

  // ---- nothing has happened to it yet -------------------------------------
  // The column is consulted LAST and only for states no other row can contradict.
  if (input.plan.status === 'CANCELLED') return { state: 'CANCELLED', approval, authority: 'PLAN' };
  return { state: 'PREPARED', approval, authority: 'PLAN' };
}

/** Whether this state may be approved. The single question the wizard asks. */
export const mayApprove = (state: PlanLifecycleState): boolean => state === 'PREPARED';

/** Whether this state may start a run. */
export const mayExecute = (state: PlanLifecycleState): boolean => state === 'APPROVED';

/**
 * Whether the plan's own column disagrees with what really happened.
 *
 * Reported rather than repaired at read time: rewriting rows while answering a
 * GET is a mutation nobody asked for, and the backfill it implies is a
 * migration with its own authorization. This lets the disagreement be counted
 * and shown without anything being written.
 */
export function statusIsStale(plan: PlanRow, state: PlanLifecycleState): boolean {
  if (state === 'APPROVAL_SPENT') return false;
  // A plan whose approval was withdrawn reads APPROVED in the column and
  // PREPARED here. That is the projection working, not drift.
  if (state === 'PREPARED' && plan.status === 'APPROVED') return false;
  if (state === 'PREPARED') return !['DRAFT', 'READY'].includes(plan.status);
  return plan.status !== state;
}
