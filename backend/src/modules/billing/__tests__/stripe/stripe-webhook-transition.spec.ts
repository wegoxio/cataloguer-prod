import {
  decide,
  Decision,
  EventFacts,
  LocalFacts,
  LocalOrganization,
  relationOf,
  retrievalRequired,
  RetrievedSubscription,
} from '../../stripe/stripe-webhook-transition';

/**
 * The transition table, row by row, and then every combination the inputs can
 * take. The function is pure, so the exhaustive sweep is cheap; it proves the
 * two invariants the ledger relies on — a `requires_action` never carries an
 * effect, an `applied` always does — hold for inputs nobody wrote a row for.
 */
const PLANS = new Set(['BASICO', 'CRECIMIENTO', 'MULTIMARCA', 'CORPORATIVO']);
const ok = () => 'ok' as const;
const refused = () => 'refused' as const;

const org = (over: Partial<LocalOrganization> = {}): LocalOrganization => ({
  id: 'org-1',
  plan: 'BASICO',
  billingStatus: 'ACTIVE',
  customerId: 'cus_1',
  current: null,
  previous: null,
  storeCount: 1,
  ...over,
});

const local = (organization: LocalOrganization | null, over: Partial<LocalFacts> = {}): LocalFacts => ({
  organization,
  organizationNamedButUnknown: false,
  invoiceAlreadyRecorded: false,
  objectAlreadyApplied: false,
  ...over,
});

const checkout = (
  over: Partial<EventFacts> = {},
  session: Partial<NonNullable<EventFacts['session']>> = {},
): EventFacts => ({
  kind: 'checkout',
  eventType: 'checkout.session.completed',
  objectId: 'cs_1',
  organizationIdFromMetadata: 'org-1',
  customerId: 'cus_1',
  subscriptionId: 'sub_new',
  session: { mode: 'subscription', status: 'complete', paymentStatus: 'paid', plan: 'CRECIMIENTO', ...session },
  ...over,
});

const invoice = (over: Partial<EventFacts> = {}): EventFacts => ({
  kind: 'invoice',
  eventType: 'invoice.paid',
  objectId: 'in_1',
  organizationIdFromMetadata: null,
  customerId: 'cus_1',
  subscriptionId: 'sub_cur',
  session: null,
  ...over,
});

const deletion = (over: Partial<EventFacts> = {}): EventFacts => ({
  kind: 'deletion',
  eventType: 'customer.subscription.deleted',
  objectId: 'sub_cur',
  organizationIdFromMetadata: 'org-1',
  customerId: 'cus_1',
  subscriptionId: 'sub_cur',
  session: null,
  ...over,
});

const live = (over: Partial<Extract<RetrievedSubscription, { found: true }>> = {}): RetrievedSubscription => ({
  found: true,
  id: 'sub_new',
  status: 'active',
  customerId: 'cus_1',
  organizationIdFromMetadata: 'org-1',
  lookupKey: 'crecimiento',
  ...over,
});

const expectDecision = (
  d: Decision,
  disposition: Decision['disposition'],
  reason: string,
  effect: Decision['effect'] = 'none',
) => {
  expect({ disposition: d.disposition, reason: d.reason, effect: d.effect }).toEqual({ disposition, reason, effect });
};

describe('relationOf', () => {
  it('names S against the local ids', () => {
    expect(relationOf(null, org())).toBe('none');
    expect(relationOf('sub_x', null)).toBe('unknown');
    expect(relationOf('sub_cur', org({ current: 'sub_cur' }))).toBe('current');
    expect(relationOf('sub_old', org({ previous: 'sub_old' }))).toBe('former');
    expect(relationOf('sub_x', org({ current: 'sub_cur', previous: 'sub_old' }))).toBe('unknown');
  });
});

describe('retrievalRequired — exactly the rows that may set ACTIVE ask Stripe first', () => {
  it('checkout: only a complete, paid, subscription-mode session for an unknown S with a known plan', () => {
    expect(retrievalRequired(checkout(), local(org()), PLANS)).toBe(true);
    expect(retrievalRequired(checkout({}, { paymentStatus: 'unpaid' }), local(org()), PLANS)).toBe(false);
    expect(retrievalRequired(checkout({}, { status: 'open' }), local(org()), PLANS)).toBe(false);
    expect(retrievalRequired(checkout({}, { mode: 'payment' }), local(org()), PLANS)).toBe(false);
    expect(retrievalRequired(checkout({}, { plan: 'NOPE' }), local(org()), PLANS)).toBe(false);
    expect(retrievalRequired(checkout({ subscriptionId: null }), local(org()), PLANS)).toBe(false);
    expect(retrievalRequired(checkout({ subscriptionId: 'sub_cur' }), local(org({ current: 'sub_cur' })), PLANS)).toBe(
      false,
    );
    expect(retrievalRequired(checkout({ subscriptionId: 'sub_old' }), local(org({ previous: 'sub_old' })), PLANS)).toBe(
      false,
    );
    expect(retrievalRequired(checkout(), local(org(), { objectAlreadyApplied: true }), PLANS)).toBe(false);
    expect(retrievalRequired(checkout(), local(null), PLANS)).toBe(false);
  });

  it('invoice: current OR unknown S (never former, never an already-recorded invoice)', () => {
    expect(retrievalRequired(invoice(), local(org({ current: 'sub_cur' })), PLANS)).toBe(true);
    expect(retrievalRequired(invoice({ subscriptionId: 'sub_x' }), local(org()), PLANS)).toBe(true);
    expect(retrievalRequired(invoice({ subscriptionId: 'sub_old' }), local(org({ previous: 'sub_old' })), PLANS)).toBe(
      false,
    );
    expect(
      retrievalRequired(invoice(), local(org({ current: 'sub_cur' }), { invoiceAlreadyRecorded: true }), PLANS),
    ).toBe(false);
    expect(retrievalRequired(invoice({ subscriptionId: null }), local(org()), PLANS)).toBe(false);
  });

  it('deletion and unhandled types never retrieve', () => {
    expect(retrievalRequired(deletion(), local(org({ current: 'sub_cur' })), PLANS)).toBe(false);
    expect(retrievalRequired({ ...deletion(), kind: 'other' }, local(org()), PLANS)).toBe(false);
  });
});

describe('the transition table', () => {
  describe('shared-account traffic and unknown organizations', () => {
    it('no organization and no metadata: foreign, no effect', () => {
      expectDecision(
        decide(checkout({ organizationIdFromMetadata: null }, { mode: 'payment' }), local(null), null, ok, PLANS),
        'ignored',
        'foreign',
      );
      expectDecision(
        decide(invoice({ customerId: 'cus_other', subscriptionId: null }), local(null), null, ok, PLANS),
        'ignored',
        'foreign',
      );
    });
    it('metadata names an organization that does not exist: requires_action', () => {
      expectDecision(
        decide(checkout(), local(null, { organizationNamedButUnknown: true }), null, ok, PLANS),
        'requires_action',
        'unknown_organization',
      );
    });
    it('unhandled types are acknowledged', () => {
      expectDecision(
        decide({ ...deletion(), kind: 'other' }, local(org()), null, ok, PLANS),
        'unhandled',
        'acknowledged',
      );
    });
  });

  describe('checkout.session.completed', () => {
    it('payment-mode or incomplete or unpaid sessions do nothing', () => {
      expectDecision(
        decide(checkout({}, { mode: 'payment' }), local(org()), null, ok, PLANS),
        'ignored',
        'not_subscription_mode',
      );
      expectDecision(
        decide(checkout({}, { status: 'open' }), local(org()), null, ok, PLANS),
        'ignored',
        'awaiting_payment',
      );
      expectDecision(
        decide(checkout({}, { paymentStatus: 'unpaid' }), local(org()), null, ok, PLANS),
        'ignored',
        'awaiting_payment',
      );
    });
    it('no_payment_required is an unexpected configuration, not an activation', () => {
      expectDecision(
        decide(checkout({}, { paymentStatus: 'no_payment_required' }), local(org()), null, ok, PLANS),
        'requires_action',
        'unexpected_no_payment',
      );
    });
    it('malformed sessions and unknown plans wait for the owner', () => {
      expectDecision(
        decide(checkout({ subscriptionId: null }), local(org()), null, ok, PLANS),
        'requires_action',
        'malformed_session',
      );
      expectDecision(
        decide(checkout({}, { plan: 'NOPE' }), local(org()), null, ok, PLANS),
        'requires_action',
        'unknown_plan',
      );
      expectDecision(
        decide(checkout({}, { plan: null }), local(org()), null, ok, PLANS),
        'requires_action',
        'unknown_plan',
      );
    });
    it('S = C is already applied; S = P is a former subscription; an applied object is not re-applied', () => {
      expectDecision(
        decide(checkout({ subscriptionId: 'sub_cur' }), local(org({ current: 'sub_cur' })), null, ok, PLANS),
        'ignored',
        'already_applied',
      );
      expectDecision(
        decide(checkout({ subscriptionId: 'sub_old' }), local(org({ previous: 'sub_old' })), null, ok, PLANS),
        'ignored',
        'former_subscription',
      );
      expectDecision(
        decide(checkout(), local(org(), { objectAlreadyApplied: true }), null, ok, PLANS),
        'ignored',
        'object_already_applied',
      );
    });
    it('a missing retrieval is never silently trusted', () => {
      expectDecision(decide(checkout(), local(org()), null, ok, PLANS), 'requires_action', 'retrieval_missing');
      expectDecision(
        decide(checkout(), local(org()), { found: false }, ok, PLANS),
        'requires_action',
        'subscription_not_found',
      );
    });
    it('ownership mismatch by metadata, by customer, or by the subscription not being the one named', () => {
      expectDecision(
        decide(checkout(), local(org()), live({ organizationIdFromMetadata: 'org-2' }), ok, PLANS),
        'requires_action',
        'organization_mismatch',
      );
      expectDecision(
        decide(checkout(), local(org()), live({ customerId: 'cus_2' }), ok, PLANS),
        'requires_action',
        'organization_mismatch',
      );
      expectDecision(
        decide(checkout(), local(org()), live({ id: 'sub_somebody_elses' }), ok, PLANS),
        'requires_action',
        'organization_mismatch',
      );
    });
    it('MISSING ownership evidence never grants access: no metadata, no customer on Stripe, no customer locally', () => {
      expectDecision(
        decide(checkout(), local(org()), live({ organizationIdFromMetadata: null }), ok, PLANS),
        'requires_action',
        'ownership_unverified',
      );
      expectDecision(
        decide(checkout(), local(org()), live({ customerId: null }), ok, PLANS),
        'requires_action',
        'ownership_unverified',
      );
      expectDecision(
        decide(checkout(), local(org({ customerId: null })), live(), ok, PLANS),
        'requires_action',
        'ownership_unverified',
      );
      // The same contract guards restoration and adoption on invoice.paid.
      expectDecision(
        decide(
          invoice(),
          local(org({ current: 'sub_cur', billingStatus: 'SUSPENDED' })),
          live({ id: 'sub_cur', organizationIdFromMetadata: null }),
          ok,
          PLANS,
        ),
        'requires_action',
        'ownership_unverified',
      );
      expectDecision(
        decide(invoice({ subscriptionId: 'sub_new' }), local(org()), live({ customerId: null }), ok, PLANS),
        'requires_action',
        'ownership_unverified',
      );
    });
    it('C null: live activates (plan permitting); incomplete waits; dead is a stale checkout', () => {
      const d = decide(checkout(), local(org()), live(), ok, PLANS);
      expectDecision(d, 'applied', 'activated', 'activated');
      expect(d.targetPlan).toBe('CRECIMIENTO');
      expect(d.targetSubscription).toBe('sub_new');
      expectDecision(
        decide(checkout(), local(org()), live(), refused, PLANS),
        'requires_action',
        'plan_change_refused',
      );
      expectDecision(
        decide(checkout(), local(org()), live({ status: 'incomplete' }), ok, PLANS),
        'ignored',
        'awaiting_payment',
      );
      for (const status of ['canceled', 'incomplete_expired', 'unpaid', 'past_due']) {
        expectDecision(decide(checkout(), local(org()), live({ status }), ok, PLANS), 'ignored', 'stale_checkout');
      }
    });
    it('the price on the live subscription must MAP to a plan and agree with the session plan — never fail open', () => {
      // known but different plan
      expectDecision(
        decide(checkout(), local(org()), live({ lookupKey: 'basico' }), ok, PLANS),
        'requires_action',
        'plan_mismatch',
      );
      // missing lookup key
      expectDecision(
        decide(checkout(), local(org()), live({ lookupKey: null }), ok, PLANS),
        'requires_action',
        'price_unmapped',
      );
      // unknown lookup key
      expectDecision(
        decide(checkout(), local(org()), live({ lookupKey: 'gold_legacy' }), ok, PLANS),
        'requires_action',
        'price_unmapped',
      );
      // agreeing mapping is the only activating shape
      expectDecision(
        decide(checkout(), local(org()), live({ lookupKey: 'crecimiento' }), ok, PLANS),
        'applied',
        'activated',
        'activated',
      );
    });
    it('C set to another subscription: a second live one needs the owner; a dead one is stale', () => {
      expectDecision(
        decide(checkout(), local(org({ current: 'sub_cur' })), live(), ok, PLANS),
        'requires_action',
        'multiple_live_subscriptions',
      );
      expectDecision(
        decide(checkout(), local(org({ current: 'sub_cur' })), live({ status: 'canceled' }), ok, PLANS),
        'ignored',
        'stale_checkout',
      );
    });
  });

  describe('invoice.paid', () => {
    it('an invoice without a subscription that names us needs the owner', () => {
      expectDecision(
        decide(invoice({ subscriptionId: null }), local(org()), null, ok, PLANS),
        'requires_action',
        'unknown_invoice_kind',
      );
    });
    it('an invoice already APPLIED in the ledger is not recorded twice even after its payment row was deleted', () => {
      expectDecision(
        decide(
          invoice(),
          local(org({ current: 'sub_cur' }), { objectAlreadyApplied: true }),
          live({ id: 'sub_cur' }),
          ok,
          PLANS,
        ),
        'ignored',
        'object_already_applied',
      );
    });
    it('an already recorded invoice is not recorded twice', () => {
      expectDecision(
        decide(invoice(), local(org({ current: 'sub_cur' }), { invoiceAlreadyRecorded: true }), null, ok, PLANS),
        'ignored',
        'object_already_applied',
      );
    });
    it('no store to hang the payment on: requires_action, no row', () => {
      expectDecision(
        decide(invoice(), local(org({ current: 'sub_cur', storeCount: 0 })), live({ id: 'sub_cur' }), ok, PLANS),
        'requires_action',
        'no_store',
      );
    });
    it('S = P: the payment is recorded, nothing else moves, no retrieval needed', () => {
      expectDecision(
        decide(invoice({ subscriptionId: 'sub_old' }), local(org({ previous: 'sub_old' })), null, ok, PLANS),
        'applied',
        'payment_recorded_former',
        'payment_recorded',
      );
    });
    it('S = C restores ACTIVE only when Stripe says the subscription is live NOW (PRB-D4)', () => {
      const suspended = org({ current: 'sub_cur', billingStatus: 'SUSPENDED' });
      expectDecision(
        decide(invoice(), local(suspended), live({ id: 'sub_cur' }), ok, PLANS),
        'applied',
        'restored',
        'restored',
      );
      for (const status of ['canceled', 'unpaid', 'past_due', 'incomplete_expired', 'incomplete']) {
        expectDecision(
          decide(invoice(), local(suspended), live({ id: 'sub_cur', status }), ok, PLANS),
          'applied',
          'payment_recorded_not_live',
          'payment_recorded',
        );
      }
      expectDecision(
        decide(invoice(), local(suspended), { found: false }, ok, PLANS),
        'requires_action',
        'subscription_not_found',
      );
      expectDecision(decide(invoice(), local(suspended), null, ok, PLANS), 'requires_action', 'retrieval_missing');
      expectDecision(
        decide(invoice(), local(suspended), live({ id: 'sub_cur', customerId: 'cus_2' }), ok, PLANS),
        'requires_action',
        'organization_mismatch',
      );
    });
    it('S unknown, C null: invoice-first adoption runs the same plan rule as checkout', () => {
      const d = decide(invoice({ subscriptionId: 'sub_new' }), local(org()), live(), ok, PLANS);
      expectDecision(d, 'applied', 'adopted', 'adopted');
      expect(d.targetPlan).toBe('CRECIMIENTO');
      expect(d.targetSubscription).toBe('sub_new');
      expectDecision(
        decide(invoice({ subscriptionId: 'sub_new' }), local(org()), live(), refused, PLANS),
        'requires_action',
        'plan_change_refused',
      );
      expectDecision(
        decide(invoice({ subscriptionId: 'sub_new' }), local(org()), live({ lookupKey: null }), ok, PLANS),
        'requires_action',
        'unknown_plan',
      );
      expectDecision(
        decide(invoice({ subscriptionId: 'sub_new' }), local(org()), live({ status: 'canceled' }), ok, PLANS),
        'applied',
        'payment_recorded_former',
        'payment_recorded',
      );
    });
    it('S unknown, C set: a second live subscription needs the owner; a dead one is just a payment', () => {
      expectDecision(
        decide(invoice({ subscriptionId: 'sub_new' }), local(org({ current: 'sub_cur' })), live(), ok, PLANS),
        'requires_action',
        'multiple_live_subscriptions',
      );
      expectDecision(
        decide(
          invoice({ subscriptionId: 'sub_new' }),
          local(org({ current: 'sub_cur' })),
          live({ status: 'canceled' }),
          ok,
          PLANS,
        ),
        'applied',
        'payment_recorded_former',
        'payment_recorded',
      );
    });
  });

  describe('customer.subscription.deleted', () => {
    it('S = C suspends and remembers the subscription as the previous one', () => {
      const d = decide(deletion(), local(org({ current: 'sub_cur' })), null, ok, PLANS);
      expectDecision(d, 'applied', 'suspended', 'suspended');
      expect(d.targetSubscription).toBe('sub_cur');
    });
    it('S = P, or unknown with C null: former subscription (report only, PRB-D8 when metadata matches)', () => {
      expectDecision(
        decide(
          deletion({ subscriptionId: 'sub_old', objectId: 'sub_old' }),
          local(org({ previous: 'sub_old' })),
          null,
          ok,
          PLANS,
        ),
        'ignored',
        'former_subscription',
      );
      expectDecision(
        decide(deletion({ subscriptionId: 'sub_x', objectId: 'sub_x' }), local(org()), null, ok, PLANS),
        'ignored',
        'no_local_subscription',
      );
    });
    it('S ≠ C with C set: superseded', () => {
      expectDecision(
        decide(
          deletion({ subscriptionId: 'sub_old', objectId: 'sub_old' }),
          local(org({ current: 'sub_cur' })),
          null,
          ok,
          PLANS,
        ),
        'ignored',
        'superseded',
      );
    });
    it('a deletion without an id is malformed', () => {
      expectDecision(
        decide(deletion({ subscriptionId: null }), local(org()), null, ok, PLANS),
        'requires_action',
        'malformed_subscription',
      );
    });
  });
});

describe('checkout.session.expired (#248 PR C)', () => {
  const expired = (over: Partial<EventFacts> = {}): EventFacts => ({
    ...checkout(
      { eventType: 'checkout.session.expired', subscriptionId: null },
      { status: 'expired', paymentStatus: 'unpaid' },
    ),
    kind: 'checkout_expired',
    ...over,
  });

  it('is ignored as session_expired for our company: no effect, no retrieval', () => {
    expect(retrievalRequired(expired(), local(org()), PLANS)).toBe(false);
    expect(decide(expired(), local(org()), null, ok, PLANS)).toEqual<Decision>({
      disposition: 'ignored',
      reason: 'session_expired',
      effect: 'none',
    });
  });

  it('changes nothing even when the company holds a subscription or the guards would refuse', () => {
    expect(decide(expired(), local(org({ current: 'sub_cur' })), null, refused, PLANS)).toMatchObject({
      disposition: 'ignored',
      reason: 'session_expired',
      effect: 'none',
    });
  });

  it("a foreign expired session stays foreign; an unknown named company is still the owner's question", () => {
    expect(decide(expired({ organizationIdFromMetadata: null }), local(null), null, ok, PLANS)).toMatchObject({
      disposition: 'ignored',
      reason: 'foreign',
    });
    expect(decide(expired(), local(null, { organizationNamedButUnknown: true }), null, ok, PLANS)).toMatchObject({
      disposition: 'requires_action',
      reason: 'unknown_organization',
    });
  });
});

describe('exhaustive sweep: the invariants hold for every combination', () => {
  const kinds: EventFacts['kind'][] = ['checkout', 'checkout_expired', 'invoice', 'deletion', 'other'];
  const subs = [null, 'sub_cur', 'sub_old', 'sub_x'];
  const orgs: (LocalOrganization | null)[] = [
    null,
    org(),
    org({ current: 'sub_cur' }),
    org({ previous: 'sub_old' }),
    org({ current: 'sub_cur', previous: 'sub_old' }),
    org({ storeCount: 0, current: 'sub_cur' }),
    org({ customerId: null }),
  ];
  const retrievals: (RetrievedSubscription | null)[] = [
    null,
    { found: false },
    ...['active', 'trialing', 'incomplete', 'canceled', 'past_due', 'unpaid', 'incomplete_expired', 'paused'].map(
      (status) => live({ status }),
    ),
    live({ customerId: 'cus_2' }),
    live({ organizationIdFromMetadata: 'org-2' }),
    live({ lookupKey: 'basico' }),
    live({ lookupKey: null }),
  ];
  const sessions = [
    { mode: 'subscription', status: 'complete', paymentStatus: 'paid', plan: 'CRECIMIENTO' },
    { mode: 'subscription', status: 'complete', paymentStatus: 'unpaid', plan: 'CRECIMIENTO' },
    { mode: 'subscription', status: 'complete', paymentStatus: 'no_payment_required', plan: 'CRECIMIENTO' },
    { mode: 'subscription', status: 'open', paymentStatus: 'unpaid', plan: 'CRECIMIENTO' },
    { mode: 'payment', status: 'complete', paymentStatus: 'paid', plan: null },
    { mode: 'subscription', status: 'complete', paymentStatus: 'paid', plan: 'NOPE' },
  ];
  const flags = [
    { organizationNamedButUnknown: false, invoiceAlreadyRecorded: false, objectAlreadyApplied: false },
    { organizationNamedButUnknown: true, invoiceAlreadyRecorded: false, objectAlreadyApplied: false },
    { organizationNamedButUnknown: false, invoiceAlreadyRecorded: true, objectAlreadyApplied: false },
    { organizationNamedButUnknown: false, invoiceAlreadyRecorded: false, objectAlreadyApplied: true },
  ];
  const checks = [ok, refused];

  it('never throws; requires_action never carries an effect; applied always does; ignored/unhandled never do', () => {
    let count = 0;
    for (const kind of kinds)
      for (const sub of subs)
        for (const o of orgs)
          for (const r of retrievals)
            for (const s of sessions)
              for (const f of flags)
                for (const c of checks) {
                  const event: EventFacts = {
                    kind,
                    eventType: kind,
                    objectId: 'obj',
                    organizationIdFromMetadata: o ? o.id : null,
                    customerId: o?.customerId ?? null,
                    subscriptionId: sub,
                    session: kind === 'checkout' ? s : null,
                  };
                  const d = decide(event, { organization: o, ...f }, r, c, PLANS);
                  count++;
                  expect(['applied', 'ignored', 'requires_action', 'unhandled']).toContain(d.disposition);
                  expect(typeof d.reason).toBe('string');
                  if (d.disposition === 'requires_action') expect(d.effect).toBe('none');
                  if (d.disposition === 'applied') expect(d.effect).not.toBe('none');
                  if (d.disposition === 'ignored' || d.disposition === 'unhandled') expect(d.effect).toBe('none');
                  if (d.effect === 'activated' || d.effect === 'adopted') {
                    expect(d.targetPlan && PLANS.has(d.targetPlan)).toBe(true);
                    expect(d.targetSubscription).toBe(sub);
                    // Never activated onto a non-live or foreign subscription
                    expect(r && r.found && ['active', 'trialing'].includes(r.status)).toBe(true);
                    expect(o && o.current === null).toBe(true);
                  }
                  if (d.effect === 'restored')
                    expect(r && r.found && ['active', 'trialing'].includes(r.status)).toBe(true);
                  if (d.effect === 'suspended') expect(o && o.current === sub).toBe(true);
                  if (d.effect !== 'none') expect(o).not.toBeNull();
                  if (d.reason === 'foreign') expect(o).toBeNull();
                }
    expect(count).toBeGreaterThan(20_000);
  });
});

describe("Plan Gratis: a Stripe event never changes a complimentary company's plan or status", () => {
  const gratis = (over: Partial<LocalOrganization> = {}) => org({ plan: 'GRATIS', ...over });
  const basico = (over: Partial<LocalOrganization> = {}) => org({ plan: 'BASICO', ...over });

  // Each row is proven twice: on Básico the table applies the effect (so the
  // inputs are real), on Plan Gratis the same inputs are held for the owner.
  const rows: {
    name: string;
    event: EventFacts;
    organization: (o: typeof org) => LocalOrganization;
    retrieved: RetrievedSubscription | null;
    effect: Decision['effect'];
  }[] = [
    {
      name: 'checkout activation',
      event: checkout(),
      organization: (o) => o({ current: null }),
      retrieved: live(),
      effect: 'activated',
    },
    {
      name: 'invoice adoption (first-purchase race)',
      event: invoice({ subscriptionId: 'sub_new' }),
      organization: (o) => o({ current: null }),
      retrieved: live({ id: 'sub_new' }),
      effect: 'adopted',
    },
    {
      name: 'subscription deletion',
      event: deletion(),
      organization: (o) => o({ current: 'sub_cur' }),
      retrieved: null,
      effect: 'suspended',
    },
  ];

  for (const row of rows) {
    it(`${row.name}: applied on Básico, requires_action with no effect on Plan Gratis`, () => {
      const onBasico = decide(row.event, local(row.organization(basico)), row.retrieved, ok, PLANS);
      expect(onBasico.effect).toBe(row.effect);
      const onGratis = decide(row.event, local(row.organization(gratis)), row.retrieved, ok, PLANS);
      expectDecision(onGratis, 'requires_action', 'complimentary_plan');
      expect(onGratis.targetPlan).toBeUndefined();
      expect(onGratis.targetSubscription).toBeUndefined();
    });
  }

  it('recording a payment or restoring ACTIVE is still allowed — neither changes the plan or suspends', () => {
    const restored = decide(invoice(), local(gratis({ current: 'sub_cur' })), live({ id: 'sub_cur' }), ok, PLANS);
    expectDecision(restored, 'applied', 'restored', 'restored');
    const former = decide(
      invoice({ subscriptionId: 'sub_old' }),
      local(gratis({ previous: 'sub_old' })),
      null,
      ok,
      PLANS,
    );
    expectDecision(former, 'applied', 'payment_recorded_former', 'payment_recorded');
  });

  it('across a sweep of inputs, no decision for Plan Gratis activates, adopts or suspends', () => {
    const events = [
      checkout(),
      checkout({}, { plan: 'BASICO' }),
      invoice(),
      invoice({ subscriptionId: 'sub_new' }),
      deletion(),
    ];
    const organizations = [
      gratis(),
      gratis({ current: 'sub_cur' }),
      gratis({ previous: 'sub_cur' }),
      gratis({ current: 'sub_new' }),
    ];
    const retrievals: (RetrievedSubscription | null)[] = [
      null,
      live(),
      live({ id: 'sub_cur' }),
      live({ status: 'canceled' }),
    ];
    for (const event of events)
      for (const organization of organizations)
        for (const retrieved of retrievals)
          for (const check of [ok, refused]) {
            const decision = decide(event, local(organization), retrieved, check, PLANS);
            expect(['activated', 'adopted', 'suspended']).not.toContain(decision.effect);
            if (decision.disposition === 'requires_action') expect(decision.effect).toBe('none');
          }
  });
});
