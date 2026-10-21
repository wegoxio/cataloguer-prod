import {
  Classification,
  Finding,
  LIVE_STATUSES,
  LocalOrganizationFacts,
  SEVERITY,
  StripeSubscriptionFacts,
  classifyOpenItems,
  classifyOrganization,
  classifyOrphanSubscriptions,
  tally,
} from '../../stripe/stripe-reconcile';

/**
 * The reconciliation classifier, row by row and then over every combination.
 *
 * It is pure, so the sweep is cheap and proves the properties the report's
 * whole value rests on: a classification is deterministic, exactly one
 * subscription-shaped finding comes back per organization, severity is a fixed
 * property of the classification rather than a per-row judgement, and no
 * finding can carry anything but identifiers and closed vocabularies.
 */
const org = (over: Partial<LocalOrganizationFacts> = {}): LocalOrganizationFacts => ({
  organizationId: 'org-1',
  slug: 'acme',
  plan: 'BASICO',
  billingStatus: 'ACTIVE',
  customerId: 'cus_1',
  subscriptionId: null,
  previousSubscriptionId: null,
  archived: false,
  ...over,
});
const sub = (over: Partial<StripeSubscriptionFacts> = {}): StripeSubscriptionFacts => ({
  subscriptionId: 'sub_1',
  customerId: 'cus_1',
  status: 'active',
  planFromPrice: 'BASICO',
  ...over,
});

describe('classifyOrganization — the table', () => {
  it('a company with no Stripe customer and no subscription is simply not a card customer', () => {
    expect(classifyOrganization(org({ customerId: null }), [])).toMatchObject({
      classification: 'organization_without_customer',
      severity: 'info',
      organizationId: 'org-1',
    });
  });

  it('a recorded subscription with NO customer is a contradiction we must surface', () => {
    expect(classifyOrganization(org({ customerId: null, subscriptionId: 'sub_x' }), [])).toMatchObject({
      classification: 'subscription_missing_at_stripe',
      severity: 'action',
      reasonCode: 'no_customer_recorded',
    });
  });

  it('local subscription that Stripe does not return at all', () => {
    expect(
      classifyOrganization(org({ subscriptionId: 'sub_gone' }), [sub({ subscriptionId: 'sub_other' })]),
    ).toMatchObject({
      classification: 'subscription_missing_at_stripe',
      reasonCode: 'not_returned_by_stripe',
      subscriptionId: 'sub_gone',
    });
  });

  it('local subscription Stripe reports as not live', () => {
    for (const status of ['canceled', 'unpaid', 'past_due', 'incomplete', 'incomplete_expired', 'paused']) {
      expect(classifyOrganization(org({ subscriptionId: 'sub_1' }), [sub({ status })])).toMatchObject({
        classification: 'subscription_not_live',
        severity: 'action',
        stripeStatus: status,
        reasonCode: 'local_active_stripe_not_live',
      });
    }
  });

  it('a live subscription whose price maps to a DIFFERENT plan than we hold', () => {
    expect(
      classifyOrganization(org({ plan: 'BASICO', subscriptionId: 'sub_1' }), [sub({ planFromPrice: 'MULTIMARCA' })]),
    ).toMatchObject({
      classification: 'plan_mismatch',
      localPlan: 'BASICO',
      stripePlan: 'MULTIMARCA',
      reasonCode: 'price_plan_differs',
    });
  });

  it('a live subscription on an UNMAPPED price is not a mismatch — we cannot claim it disagrees', () => {
    expect(classifyOrganization(org({ subscriptionId: 'sub_1' }), [sub({ planFromPrice: null })])).toMatchObject({
      classification: 'in_sync',
      stripePlan: null,
    });
  });

  it('agreement is in_sync and carries no action', () => {
    expect(classifyOrganization(org({ plan: 'BASICO', subscriptionId: 'sub_1' }), [sub()])).toMatchObject({
      classification: 'in_sync',
      severity: 'none',
      stripeStatus: 'active',
    });
  });

  it('Stripe charging for an entitlement the ledger never recorded', () => {
    expect(classifyOrganization(org({ subscriptionId: null }), [sub()])).toMatchObject({
      classification: 'subscription_missing_locally',
      severity: 'action',
      reasonCode: 'live_at_stripe_only',
      subscriptionId: 'sub_1',
    });
  });

  it('TWO live subscriptions for one customer are named as such', () => {
    expect(
      classifyOrganization(org({ subscriptionId: null }), [
        sub(),
        sub({ subscriptionId: 'sub_2', status: 'trialing' }),
      ]),
    ).toMatchObject({ classification: 'subscription_missing_locally', reasonCode: 'multiple_live_at_stripe' });
  });

  it('dead subscriptions at Stripe with nothing local are NOT a finding', () => {
    expect(classifyOrganization(org({ subscriptionId: null }), [sub({ status: 'canceled' })])).toMatchObject({
      classification: 'in_sync',
      severity: 'none',
    });
  });

  it('trialing counts as live, exactly as the transition table treats it', () => {
    expect([...LIVE_STATUSES].sort()).toEqual(['active', 'trialing']);
    expect(classifyOrganization(org({ subscriptionId: null }), [sub({ status: 'trialing' })])).toMatchObject({
      classification: 'subscription_missing_locally',
    });
  });
});

describe('classifyOrphanSubscriptions', () => {
  it('a subscription whose customer is not one of ours is info, never an action', () => {
    const out = classifyOrphanSubscriptions([sub({ customerId: 'cus_stranger' })], new Set(['cus_1']));
    expect(out).toEqual([
      expect.objectContaining({
        classification: 'customer_not_ours',
        severity: 'info',
        organizationId: null,
        reasonCode: 'customer_not_an_organization',
      }),
    ]);
  });

  it('a subscription with no customer at all is also foreign', () => {
    expect(classifyOrphanSubscriptions([sub({ customerId: null })], new Set(['cus_1']))).toHaveLength(1);
  });

  it('our own customers produce nothing here', () => {
    expect(classifyOrphanSubscriptions([sub({ customerId: 'cus_1' })], new Set(['cus_1']))).toEqual([]);
  });
});

describe('classifyOpenItems', () => {
  const slugs = new Map([['org-1', 'acme']]);

  it('unresolved events, unreconciled attempts and stuck attempts each become one finding', () => {
    const out = classifyOpenItems(
      {
        unresolvedEvents: [
          {
            eventId: 'evt_1',
            eventType: 'checkout.session.completed',
            reasonCode: 'plan_change_refused',
            organizationId: 'org-1',
          },
        ],
        unreconciledAttempts: [{ attemptId: 'att-1', organizationId: 'org-1', failureCode: 'unreconciled' }],
        stuckOpenAttempts: [{ attemptId: 'att-2', organizationId: 'org-1', plan: 'BASICO' }],
      },
      slugs,
    );
    expect(out.map((f) => [f.classification, f.severity, f.organizationSlug])).toEqual([
      ['unresolved_event', 'action', 'acme'],
      ['attempt_unreconciled', 'action', 'acme'],
      ['attempt_stuck_open', 'info', 'acme'],
    ]);
    expect(out[0].reasonCode).toBe('plan_change_refused');
  });

  it('an event with no organization keeps a null slug rather than inventing one', () => {
    const [f] = classifyOpenItems(
      {
        unresolvedEvents: [
          { eventId: 'evt_2', eventType: 'invoice.paid', reasonCode: 'unknown_organization', organizationId: null },
        ],
        unreconciledAttempts: [],
        stuckOpenAttempts: [],
      },
      slugs,
    );
    expect(f).toMatchObject({ organizationId: null, organizationSlug: null });
  });
});

describe('tally', () => {
  it('always reports every classification, so two runs can be diffed', () => {
    const counts = tally([]);
    expect(Object.keys(counts).sort()).toEqual(Object.keys(SEVERITY).sort());
    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });
});

describe('exhaustive sweep: the invariants hold for every combination', () => {
  const plans = ['BASICO', 'CRECIMIENTO', null];
  const statuses = [
    'active',
    'trialing',
    'canceled',
    'unpaid',
    'past_due',
    'incomplete',
    'incomplete_expired',
    'paused',
  ];
  const localSubs = [null, 'sub_1', 'sub_missing'];
  const customers = [null, 'cus_1'];
  const stripeSets: StripeSubscriptionFacts[][] = [
    [],
    [sub()],
    [sub({ status: 'canceled' })],
    [sub(), sub({ subscriptionId: 'sub_2' })],
    [sub({ customerId: 'cus_other' })],
  ];

  it('never throws; severity always matches the classification; only identifiers are ever emitted', () => {
    let count = 0;
    const allowedKeys = [
      'classification',
      'severity',
      'organizationId',
      'organizationSlug',
      'subscriptionId',
      'stripeStatus',
      'localPlan',
      'stripePlan',
      'eventId',
      'attemptId',
      'reasonCode',
    ].sort();
    for (const plan of plans)
      for (const status of statuses)
        for (const localSub of localSubs)
          for (const customerId of customers)
            for (const set of stripeSets) {
              const f: Finding = classifyOrganization(
                org({ plan: plan ?? 'BASICO', subscriptionId: localSub, customerId }),
                set.map((s) => ({ ...s, status, planFromPrice: plan })),
              );
              count += 1;
              expect(Object.keys(f).sort()).toEqual(allowedKeys);
              expect(f.severity).toBe(SEVERITY[f.classification]);
              // Nothing free-text can appear: every string field is an id, a slug,
              // a plan key, a Stripe status or a reason code from the closed set.
              for (const v of Object.values(f)) {
                if (typeof v === 'string') expect(v).toMatch(/^[A-Za-z0-9_.:-]*$/);
              }
            }
    expect(count).toBe(plans.length * statuses.length * localSubs.length * customers.length * stripeSets.length);
  });

  it('is deterministic: the same inputs give the identical finding every time', () => {
    const inputs = org({ subscriptionId: 'sub_1', plan: 'BASICO' });
    const set = [sub({ planFromPrice: 'MULTIMARCA' })];
    const a = classifyOrganization(inputs, set);
    for (let i = 0; i < 25; i++) expect(classifyOrganization(inputs, set)).toEqual(a);
  });

  it('every classification in SEVERITY is reachable by some input, so the vocabulary is not aspirational', () => {
    const reached = new Set<Classification>();
    reached.add(classifyOrganization(org({ customerId: null }), []).classification);
    reached.add(classifyOrganization(org({ customerId: null, subscriptionId: 'sub_x' }), []).classification);
    reached.add(classifyOrganization(org({ subscriptionId: 'sub_1' }), [sub({ status: 'canceled' })]).classification);
    reached.add(
      classifyOrganization(org({ subscriptionId: 'sub_1', plan: 'BASICO' }), [sub({ planFromPrice: 'MULTIMARCA' })])
        .classification,
    );
    reached.add(classifyOrganization(org({ subscriptionId: null }), [sub()]).classification);
    reached.add(classifyOrganization(org({ subscriptionId: 'sub_1' }), [sub()]).classification);
    reached.add(classifyOrphanSubscriptions([sub({ customerId: 'cus_x' })], new Set()).at(0)!.classification);
    // The two classifications the review round added.
    reached.add(classifyOrganization(org({ customerId: 'cus_1' }), [], false).classification);
    reached.add(classifyOrganization(org({ archived: true }), [sub()]).classification);
    const open = classifyOpenItems(
      {
        unresolvedEvents: [{ eventId: 'e', eventType: 't', reasonCode: 'r', organizationId: null }],
        unreconciledAttempts: [{ attemptId: 'a', organizationId: 'org-1', failureCode: 'f' }],
        stuckOpenAttempts: [{ attemptId: 'b', organizationId: 'org-1', plan: 'BASICO' }],
      },
      new Map(),
    );
    for (const f of open) reached.add(f.classification);
    expect([...reached].sort()).toEqual(Object.keys(SEVERITY).sort());
  });
});
