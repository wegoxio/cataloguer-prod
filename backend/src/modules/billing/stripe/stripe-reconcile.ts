/**
 * The read-only reconciliation report (#248, PR D).
 *
 * It answers one question — where do Stripe and this database disagree? — and
 * it answers it without changing anything. Nothing here writes, retries,
 * reapplies, consumes an event or touches a Stripe object: the report is
 * evidence for a person, not a repair.
 *
 * The classifier below is PURE. It receives facts already gathered and returns
 * a finding, so every classification is deterministic, exhaustively testable,
 * and free of ordering or clock surprises. The service around it does the
 * gathering; the controller does authority.
 *
 * REDACTION IS A TYPE, NOT A HABIT. `Finding` can only hold identifiers and
 * closed vocabularies. There is deliberately no field a hosted checkout URL, a
 * customer email, a metadata value or a raw Stripe object could occupy.
 */

/** Every disagreement this report can name. Closed set; `in_sync` is the absence of one. */
export type Classification =
  | 'in_sync'
  | 'not_checked'
  | 'subscription_for_archived_organization'
  | 'unresolved_event'
  | 'attempt_unreconciled'
  | 'attempt_stuck_open'
  | 'subscription_missing_locally'
  | 'subscription_missing_at_stripe'
  | 'subscription_not_live'
  | 'plan_mismatch'
  | 'customer_not_ours'
  | 'organization_without_customer';

/** Severity is a fixed property of the classification, never a judgement made per row. */
export const SEVERITY: Record<Classification, 'none' | 'info' | 'action'> = {
  in_sync: 'none',
  // The sweep was truncated and this company's customer was never observed, so
  // NOTHING is claimed about it. Saying `in_sync` here would be a lie by
  // omission, which is the failure mode this classification exists to prevent.
  not_checked: 'info',
  subscription_for_archived_organization: 'action',
  unresolved_event: 'action',
  attempt_unreconciled: 'action',
  attempt_stuck_open: 'info',
  subscription_missing_locally: 'action',
  subscription_missing_at_stripe: 'action',
  subscription_not_live: 'action',
  plan_mismatch: 'action',
  customer_not_ours: 'info',
  organization_without_customer: 'info',
};

/** Stripe statuses this codebase treats as a live entitlement. Same set the transition table uses. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(['active', 'trialing']);

/** One organization as the database holds it. Identifiers and enums only. */
export interface LocalOrganizationFacts {
  organizationId: string;
  slug: string;
  plan: string;
  billingStatus: string;
  customerId: string | null;
  subscriptionId: string | null;
  previousSubscriptionId: string | null;
  /** Archived companies are still billed by Stripe if nobody cancelled. */
  archived: boolean;
}

/** One subscription as Stripe reports it. Identifiers and enums only — never the object. */
export interface StripeSubscriptionFacts {
  subscriptionId: string;
  customerId: string | null;
  status: string;
  /** The plan its price maps to, or null when the price is not one we sell. */
  planFromPrice: string | null;
}

/** Ledger and attempt rows that stand on their own, independent of any subscription. */
export interface OpenItemFacts {
  unresolvedEvents: { eventId: string; eventType: string; reasonCode: string; organizationId: string | null }[];
  unreconciledAttempts: { attemptId: string; organizationId: string; failureCode: string | null }[];
  stuckOpenAttempts: { attemptId: string; organizationId: string; plan: string }[];
}

/**
 * A single line of the report. Every field is an identifier, a closed
 * vocabulary, or null. Adding a free-text field here would be the moment this
 * report started leaking, so there is none.
 */
export interface Finding {
  classification: Classification;
  severity: 'none' | 'info' | 'action';
  organizationId: string | null;
  organizationSlug: string | null;
  subscriptionId: string | null;
  stripeStatus: string | null;
  localPlan: string | null;
  stripePlan: string | null;
  eventId: string | null;
  attemptId: string | null;
  /** A reason code from a closed set — never a message, never a Stripe error string. */
  reasonCode: string | null;
}

/**
 * A reason code is a short lower-case token. Codes minted in this file are
 * literals, but two of them arrive from database columns
 * (`stripe_events.reason_code`, `billing_checkout_attempts.failure_code`) which
 * carry no CHECK constraint. Anything that is not token-shaped is replaced
 * rather than passed through, so a stray value cannot reach a report or a log.
 */
const REASON_CODE = /^[a-z0-9_]{1,48}$/;
export function safeReasonCode(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  return REASON_CODE.test(raw) ? raw : 'unrecognised_reason_code';
}

const finding = (classification: Classification, over: Partial<Finding> = {}): Finding => ({
  classification,
  severity: SEVERITY[classification],
  organizationId: null,
  organizationSlug: null,
  subscriptionId: null,
  stripeStatus: null,
  localPlan: null,
  stripePlan: null,
  eventId: null,
  attemptId: null,
  reasonCode: null,
  ...over,
});

/**
 * Compares one organization against what Stripe reports for its customer.
 *
 * Order matters and is fixed: the most actionable disagreement wins, so a
 * single organization yields at most one subscription-shaped finding and the
 * result never depends on iteration order.
 */
export function classifyOrganization(
  local: LocalOrganizationFacts,
  stripeForCustomer: readonly StripeSubscriptionFacts[],
  /**
   * Whether Stripe's answer for THIS customer is complete. When the sweep was
   * truncated and no targeted lookup was made, absence proves nothing, so the
   * company is reported `not_checked` instead of being silently called in sync.
   */
  observed = true,
): Finding {
  const base = {
    organizationId: local.organizationId,
    organizationSlug: local.slug,
    localPlan: local.plan,
  };

  if (local.customerId && !observed) {
    return finding('not_checked', { ...base, subscriptionId: local.subscriptionId, reasonCode: 'report_truncated' });
  }

  if (local.archived) {
    // A deprovisioned company that Stripe is still charging is the disagreement
    // that would otherwise hide as "someone else's subscription".
    const live = stripeForCustomer.filter((s) => LIVE_STATUSES.has(s.status));
    return live.length > 0
      ? finding('subscription_for_archived_organization', {
          ...base,
          subscriptionId: live[0].subscriptionId,
          stripeStatus: live[0].status,
          stripePlan: live[0].planFromPrice,
          reasonCode: 'archived_but_still_billed',
        })
      : finding('in_sync', base);
  }

  if (!local.customerId) {
    // No customer means the company has never begun a card checkout. Only
    // interesting if we somehow recorded a subscription anyway.
    return local.subscriptionId
      ? finding('subscription_missing_at_stripe', {
          ...base,
          subscriptionId: local.subscriptionId,
          reasonCode: 'no_customer_recorded',
        })
      : finding('organization_without_customer', base);
  }

  const live = stripeForCustomer.filter((s) => LIVE_STATUSES.has(s.status));

  if (local.subscriptionId) {
    const named = stripeForCustomer.find((s) => s.subscriptionId === local.subscriptionId);
    if (!named) {
      return finding('subscription_missing_at_stripe', {
        ...base,
        subscriptionId: local.subscriptionId,
        reasonCode: 'not_returned_by_stripe',
      });
    }
    if (!LIVE_STATUSES.has(named.status)) {
      return finding('subscription_not_live', {
        ...base,
        subscriptionId: named.subscriptionId,
        stripeStatus: named.status,
        reasonCode: 'local_active_stripe_not_live',
      });
    }
    if (named.planFromPrice && named.planFromPrice !== local.plan) {
      return finding('plan_mismatch', {
        ...base,
        subscriptionId: named.subscriptionId,
        stripeStatus: named.status,
        stripePlan: named.planFromPrice,
        reasonCode: 'price_plan_differs',
      });
    }
    return finding('in_sync', {
      ...base,
      subscriptionId: named.subscriptionId,
      stripeStatus: named.status,
      stripePlan: named.planFromPrice,
    });
  }

  if (live.length > 0) {
    // Stripe is charging for an entitlement the ledger never recorded. This is
    // the case PR C's checkout guard refuses on, seen from the other side.
    return finding('subscription_missing_locally', {
      ...base,
      subscriptionId: live[0].subscriptionId,
      stripeStatus: live[0].status,
      stripePlan: live[0].planFromPrice,
      reasonCode: live.length > 1 ? 'multiple_live_at_stripe' : 'live_at_stripe_only',
    });
  }

  return finding('in_sync', base);
}

/**
 * Subscriptions Stripe returned whose customer maps to none of our
 * organizations. On a shared account this is ordinary foreign traffic, so it is
 * reported at `info` and never as an action.
 */
export function classifyOrphanSubscriptions(
  stripeSubscriptions: readonly StripeSubscriptionFacts[],
  knownCustomerIds: ReadonlySet<string>,
): Finding[] {
  return stripeSubscriptions
    .filter((s) => !s.customerId || !knownCustomerIds.has(s.customerId))
    .map((s) =>
      finding('customer_not_ours', {
        subscriptionId: s.subscriptionId,
        stripeStatus: s.status,
        stripePlan: s.planFromPrice,
        reasonCode: 'customer_not_an_organization',
      }),
    );
}

/** Ledger and attempt rows become findings verbatim: they are already our own facts. */
export function classifyOpenItems(open: OpenItemFacts, slugById: ReadonlyMap<string, string>): Finding[] {
  const slug = (id: string | null) => (id ? (slugById.get(id) ?? null) : null);
  return [
    ...open.unresolvedEvents.map((e) =>
      finding('unresolved_event', {
        organizationId: e.organizationId,
        organizationSlug: slug(e.organizationId),
        eventId: e.eventId,
        reasonCode: safeReasonCode(e.reasonCode),
      }),
    ),
    ...open.unreconciledAttempts.map((a) =>
      finding('attempt_unreconciled', {
        organizationId: a.organizationId,
        organizationSlug: slug(a.organizationId),
        attemptId: a.attemptId,
        reasonCode: safeReasonCode(a.failureCode),
      }),
    ),
    ...open.stuckOpenAttempts.map((a) =>
      finding('attempt_stuck_open', {
        organizationId: a.organizationId,
        organizationSlug: slug(a.organizationId),
        attemptId: a.attemptId,
        localPlan: a.plan,
        reasonCode: 'open_past_expiry',
      }),
    ),
  ];
}

/** Counts per classification, always with every key present so a consumer can diff two runs. */
export function tally(findings: readonly Finding[]): Record<Classification, number> {
  const counts = Object.fromEntries(Object.keys(SEVERITY).map((k) => [k, 0])) as Record<Classification, number>;
  for (const f of findings) counts[f.classification] += 1;
  return counts;
}
