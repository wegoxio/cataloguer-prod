/**
 * The Stripe webhook transition table as ONE pure function (#248, PR B).
 *
 * Everything that decides what a verified Stripe event may do to a company's
 * billing state lives here, with no database, no network and no clock. The
 * orchestrator (`stripe.service.ts`) gathers the facts — the event's own
 * fields, the organization's CURRENT local state read under lock, the
 * subscription Stripe reports NOW — and this function answers with a
 * disposition, a reason and the effect to apply. Because it is pure it is
 * tested exhaustively, and because the orchestrator re-reads local state after
 * every Stripe call and before every write, the answer is always computed
 * from the state that is about to be changed.
 *
 * Vocabulary. S is the subscription the event speaks about; C is the
 * organization's current local subscription id; P is the previous one, kept
 * when a subscription ends so a former subscription is recognisable without a
 * network call. `live` means Stripe reports `active` or `trialing`.
 *
 * Invariant: a `requires_action` decision never carries a business effect.
 * The owner resolves it later through reapply, which recomputes from then-
 * current facts; nothing half-applied waits in the meantime.
 */
import { isComplimentaryPlan } from '../../stores/plans';

export type EventKind = 'checkout' | 'checkout_expired' | 'invoice' | 'deletion' | 'other';

export type Disposition = 'applied' | 'ignored' | 'requires_action' | 'unhandled';

export type Effect = 'activated' | 'restored' | 'adopted' | 'payment_recorded' | 'suspended' | 'none';

export interface SessionFacts {
  mode: string | null;
  status: string | null;
  paymentStatus: string | null;
  /** The plan key carried in the session metadata, if any. */
  plan: string | null;
}

export interface EventFacts {
  kind: EventKind;
  eventType: string;
  objectId: string | null;
  /** `metadata.organizationId` on the session or subscription, if present and well-formed. */
  organizationIdFromMetadata: string | null;
  /** The metadata named an organization in a shape that cannot be ours (not a UUID). */
  organizationIdMalformed?: boolean;
  /** The Stripe customer named by the object, if any. */
  customerId: string | null;
  /** S — the subscription the event speaks about, if any. */
  subscriptionId: string | null;
  session: SessionFacts | null;
}

export interface LocalOrganization {
  id: string;
  plan: string;
  billingStatus: string;
  customerId: string | null;
  /** C */
  current: string | null;
  /** P */
  previous: string | null;
  /** Non-archived stores; a payment row needs one. */
  storeCount: number;
}

export interface LocalFacts {
  /** The organization the event resolved to, or null. */
  organization: LocalOrganization | null;
  /** True when the event named one of our organizations that does not exist. */
  organizationNamedButUnknown: boolean;
  /** `payments` already holds this invoice id. */
  invoiceAlreadyRecorded: boolean;
  /** The ledger already holds an APPLIED event for this (type, object). */
  objectAlreadyApplied: boolean;
}

export type RetrievedSubscription =
  | {
      found: true;
      id: string;
      status: string;
      customerId: string | null;
      organizationIdFromMetadata: string | null;
      /** The price lookup key of the first item, if any. */
      lookupKey: string | null;
    }
  | { found: false };

/** Runs the same plan-capacity validation checkout uses, under the lock. */
export type PlanCheck = (plan: string) => 'ok' | 'refused';

export interface Decision {
  disposition: Disposition;
  reason: string;
  effect: Effect;
  /** Set when the effect changes the plan. */
  targetPlan?: string;
  /** Set when the effect changes C. */
  targetSubscription?: string;
}

const LIVE = new Set(['active', 'trialing']);

/** Maps a Stripe price lookup key back to a plan key. */
export const PLAN_BY_LOOKUP_KEY: Record<string, string> = {
  basico: 'BASICO',
  crecimiento: 'CRECIMIENTO',
  multimarca: 'MULTIMARCA',
};

const decision = (
  disposition: Disposition,
  reason: string,
  effect: Effect = 'none',
  extra: Partial<Decision> = {},
): Decision => ({
  disposition,
  reason,
  effect,
  ...extra,
});

/** The relation between S and the organization's local ids. */
export function relationOf(s: string | null, org: LocalOrganization | null): 'current' | 'former' | 'unknown' | 'none' {
  if (!s) return 'none';
  if (!org) return 'unknown';
  if (org.current === s) return 'current';
  if (org.previous === s) return 'former';
  return 'unknown';
}

/**
 * Whether the orchestrator must ask Stripe about S BEFORE opening the
 * transaction. Retrieval is required exactly where the table says the answer
 * depends on Stripe's current view: any transition that may set ACTIVE.
 */
export function retrievalRequired(event: EventFacts, local: LocalFacts, knownPlans: ReadonlySet<string>): boolean {
  const org = local.organization;
  if (!org) return false;
  const rel = relationOf(event.subscriptionId, org);
  if (event.kind === 'checkout') {
    const s = event.session;
    if (!s || s.mode !== 'subscription' || s.status !== 'complete') return false;
    if (s.paymentStatus !== 'paid') return false;
    if (!event.subscriptionId || !s.plan || !knownPlans.has(s.plan)) return false;
    if (rel === 'current' || rel === 'former' || local.objectAlreadyApplied) return false;
    return true;
  }
  if (event.kind === 'invoice') {
    if (!event.subscriptionId || local.invoiceAlreadyRecorded) return false;
    return rel === 'current' || rel === 'unknown';
  }
  return false;
}

/** The effects that would change a company's plan or leave it read-only. */
const PLAN_OR_STATUS_EFFECTS: ReadonlySet<Effect> = new Set<Effect>(['activated', 'adopted', 'suspended']);

/**
 * The transition table, under ONE overriding rule (Plan Gratis): a company on a
 * complimentary plan is never moved onto a paid plan by a Stripe event and is
 * never suspended by one. Only the platform owner changes that plan. Such an
 * event is recorded as `requires_action` with no effect, so the owner resolves
 * it deliberately; recording a payment or restoring ACTIVE stays allowed.
 */
export function decide(
  event: EventFacts,
  local: LocalFacts,
  retrieved: RetrievedSubscription | null,
  planCheck: PlanCheck,
  knownPlans: ReadonlySet<string>,
): Decision {
  const table = decideTable(event, local, retrieved, planCheck, knownPlans);
  const org = local.organization;
  if (org && isComplimentaryPlan(org.plan) && PLAN_OR_STATUS_EFFECTS.has(table.effect)) {
    return decision('requires_action', 'complimentary_plan');
  }
  return table;
}

/** The transition table. Pure; see the file comment. */
function decideTable(
  event: EventFacts,
  local: LocalFacts,
  retrieved: RetrievedSubscription | null,
  planCheck: PlanCheck,
  knownPlans: ReadonlySet<string>,
): Decision {
  if (event.kind === 'other') return decision('unhandled', 'acknowledged');

  const org = local.organization;
  if (!org) {
    if (local.organizationNamedButUnknown) return decision('requires_action', 'unknown_organization');
    // A payment-link session, a manual invoice, a subscription we never
    // issued: the shared account's other traffic. Never ours, never an alert.
    return decision('ignored', 'foreign');
  }

  const s = event.subscriptionId;
  const rel = relationOf(s, org);

  // checkout.session.expired (#248 PR C): Stripe closed the hosted page. No
  // plan or status can change on it; the orchestrator settles the company's
  // attempt for that session. Foreign and unknown companies were ruled above.
  if (event.kind === 'checkout_expired') return decision('ignored', 'session_expired');

  if (event.kind === 'checkout') {
    const session = event.session;
    if (!session || session.mode !== 'subscription') return decision('ignored', 'not_subscription_mode');
    if (session.paymentStatus === 'no_payment_required') return decision('requires_action', 'unexpected_no_payment');
    if (session.status !== 'complete' || session.paymentStatus !== 'paid')
      return decision('ignored', 'awaiting_payment');
    if (!s) return decision('requires_action', 'malformed_session');
    if (!session.plan || !knownPlans.has(session.plan)) return decision('requires_action', 'unknown_plan');
    if (rel === 'current') return decision('ignored', 'already_applied');
    if (rel === 'former') return decision('ignored', 'former_subscription');
    if (local.objectAlreadyApplied) return decision('ignored', 'object_already_applied');
    if (!retrieved) return decision('requires_action', 'retrieval_missing');
    if (!retrieved.found) return decision('requires_action', 'subscription_not_found');
    const ownership = ownershipVerdict(retrieved, s, org);
    if (ownership !== 'ok') return decision('requires_action', ownership);
    const live = LIVE.has(retrieved.status);
    if (org.current !== null) {
      return live ? decision('requires_action', 'multiple_live_subscriptions') : decision('ignored', 'stale_checkout');
    }
    if (retrieved.status === 'incomplete') return decision('ignored', 'awaiting_payment');
    if (!live) return decision('ignored', 'stale_checkout');
    // The price Stripe is actually charging must map to a plan we sell AND
    // agree with the plan the session claims. No mapping is not "no
    // objection": a subscription on an unrecognised price never activates.
    const planFromPrice = retrieved.lookupKey ? (PLAN_BY_LOOKUP_KEY[retrieved.lookupKey] ?? null) : null;
    if (!planFromPrice || !knownPlans.has(planFromPrice)) return decision('requires_action', 'price_unmapped');
    if (planFromPrice !== session.plan) return decision('requires_action', 'plan_mismatch');
    if (planCheck(session.plan) === 'refused') return decision('requires_action', 'plan_change_refused');
    return decision('applied', 'activated', 'activated', { targetPlan: session.plan, targetSubscription: s });
  }

  if (event.kind === 'invoice') {
    if (!s) return decision('requires_action', 'unknown_invoice_kind');
    // Two guards: the payments table (the row itself) and the ledger (an
    // APPLIED event for this invoice), so a deleted payment row cannot turn a
    // re-emitted invoice into a second application.
    if (local.invoiceAlreadyRecorded || local.objectAlreadyApplied)
      return decision('ignored', 'object_already_applied');
    if (org.storeCount === 0) return decision('requires_action', 'no_store');
    if (rel === 'former') return decision('applied', 'payment_recorded_former', 'payment_recorded');
    if (!retrieved) return decision('requires_action', 'retrieval_missing');
    if (!retrieved.found) return decision('requires_action', 'subscription_not_found');
    const ownership = ownershipVerdict(retrieved, s, org);
    if (ownership !== 'ok') return decision('requires_action', ownership);
    const live = LIVE.has(retrieved.status);
    if (rel === 'current') {
      // PRB-D4: a delayed invoice for the current subscription restores
      // ACTIVE only when Stripe confirms the subscription is live NOW. If it is
      // not, the payment is a fact worth recording; the status is left for the
      // deletion event (or reconciliation) to decide.
      return live
        ? decision('applied', 'restored', 'restored')
        : decision('applied', 'payment_recorded_not_live', 'payment_recorded');
    }
    // rel === 'unknown'
    if (org.current !== null) {
      return live
        ? decision('requires_action', 'multiple_live_subscriptions')
        : decision('applied', 'payment_recorded_former', 'payment_recorded');
    }
    if (!live) return decision('applied', 'payment_recorded_former', 'payment_recorded');
    // First-purchase race: the invoice arrived before checkout.session.completed.
    // Adoption is the same transition checkout performs, verified against the
    // live subscription and the same plan-capacity rule.
    const plan = retrieved.lookupKey ? (PLAN_BY_LOOKUP_KEY[retrieved.lookupKey] ?? null) : null;
    if (!plan || !knownPlans.has(plan)) return decision('requires_action', 'unknown_plan');
    if (planCheck(plan) === 'refused') return decision('requires_action', 'plan_change_refused');
    return decision('applied', 'adopted', 'adopted', { targetPlan: plan, targetSubscription: s });
  }

  // deletion
  if (!s) return decision('requires_action', 'malformed_subscription');
  if (rel === 'current') return decision('applied', 'suspended', 'suspended', { targetSubscription: s });
  if (rel === 'former') return decision('ignored', 'former_subscription');
  if (org.current !== null) return decision('ignored', 'superseded');
  // PRB-D8: metadata names this organization but nothing local matches.
  return decision('ignored', 'no_local_subscription');
}

/**
 * The ownership contract, enforced explicitly. Access is granted or restored
 * only when ALL of the evidence is present and agrees:
 *  - the retrieved subscription IS the subscription the event named;
 *  - its customer is the organization's customer (both known);
 *  - its `metadata.organizationId` names this organization.
 * Missing evidence is `ownership_unverified`; conflicting evidence is
 * `organization_mismatch`. Neither ever grants anything.
 */
export function ownershipVerdict(
  retrieved: Extract<RetrievedSubscription, { found: true }>,
  subscriptionId: string,
  org: LocalOrganization,
): 'ok' | 'ownership_unverified' | 'organization_mismatch' {
  if (retrieved.id !== subscriptionId) return 'organization_mismatch';
  if (retrieved.organizationIdFromMetadata && retrieved.organizationIdFromMetadata !== org.id)
    return 'organization_mismatch';
  if (org.customerId && retrieved.customerId && retrieved.customerId !== org.customerId) return 'organization_mismatch';
  if (!retrieved.organizationIdFromMetadata || !retrieved.customerId || !org.customerId) return 'ownership_unverified';
  return 'ok';
}
