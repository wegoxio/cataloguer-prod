import {
  effectiveBillingStatus,
  effectivePlanPriceUsd,
  isComplimentaryPlan,
  limitsOf,
  PLAN_LIMIT_KEYS,
  planPhrase,
  PLANS,
  tenantOfferedPlans,
} from '../plans';

/**
 * PLAN GRATIS IS BÁSICO AT A PERMANENT ZERO PRICE (owner decision).
 *
 * The commercial fields are the only fields allowed to differ. Everything else
 * on a plan is an operational limit, and those must be identical to Básico's.
 * The test is written over the OBJECT, not over today's two limit names, so a
 * limit added to Básico later and forgotten on Plan Gratis fails here.
 */
const COMMERCIAL_KEYS = ['key', 'name', 'priceUsd', 'offeredToTenants', 'complimentary'];
const operational = (plan: object) =>
  Object.fromEntries(Object.entries(plan).filter(([key]) => !COMMERCIAL_KEYS.includes(key)));

describe('Plan Gratis (GRATIS)', () => {
  it('exists with the owner-given name, a zero price, and is complimentary', () => {
    expect(PLANS.GRATIS).toMatchObject({ key: 'GRATIS', name: 'Plan Gratis', priceUsd: 0, complimentary: true });
  });

  it('has EXACTLY the effective limits of Básico — every non-commercial field, not a hand-picked list', () => {
    expect(operational(PLANS.GRATIS)).toEqual(operational(PLANS.BASICO));
    expect(limitsOf(PLANS.GRATIS)).toEqual(limitsOf(PLANS.BASICO));
    expect(limitsOf(PLANS.GRATIS)).toEqual({ maxWebsites: 1, maxTeamUsers: 3 });
  });

  it('names every operational field in PLAN_LIMIT_KEYS, so limitsOf cannot silently miss one', () => {
    for (const plan of Object.values(PLANS)) {
      expect(Object.keys(operational(plan)).sort()).toEqual([...PLAN_LIMIT_KEYS].sort());
    }
  });

  it('is the only complimentary plan, and no paid plan changed', () => {
    expect(
      Object.values(PLANS)
        .filter((plan) => plan.complimentary)
        .map((plan) => plan.key),
    ).toEqual(['GRATIS']);
    expect(PLANS.BASICO).toMatchObject({ priceUsd: 30, maxWebsites: 1, maxTeamUsers: 3, complimentary: false });
    expect(PLANS.CRECIMIENTO).toMatchObject({ priceUsd: 50, maxWebsites: 3, maxTeamUsers: 10 });
    expect(PLANS.MULTIMARCA).toMatchObject({ priceUsd: 70, maxWebsites: 5, maxTeamUsers: 20 });
    expect(PLANS.CORPORATIVO).toMatchObject({ priceUsd: null, maxWebsites: null, maxTeamUsers: null });
  });

  it('is permanently zero: no contractual override can price it', () => {
    expect(effectivePlanPriceUsd(PLANS.GRATIS)).toBe(0);
    expect(
      effectivePlanPriceUsd(PLANS.GRATIS, { monthlyPriceUsdOverride: '15.00', monthlyPriceOverridePlan: 'GRATIS' }),
    ).toBe(0);
    // The existing DesignHof contract on Básico is unchanged.
    expect(
      effectivePlanPriceUsd(PLANS.BASICO, { monthlyPriceUsdOverride: '0.00', monthlyPriceOverridePlan: 'BASICO' }),
    ).toBe(0);
    expect(effectivePlanPriceUsd(PLANS.BASICO)).toBe(30);
  });

  it('is never offered to tenants; every plan they could see before still is', () => {
    const offered = tenantOfferedPlans().map((plan) => plan.key);
    expect(offered).not.toContain('GRATIS');
    expect(offered).toEqual(['BASICO', 'CRECIMIENTO', 'MULTIMARCA', 'CORPORATIVO']);
  });

  it('is recognised only by its own key', () => {
    expect(isComplimentaryPlan('GRATIS')).toBe(true);
    for (const key of ['BASICO', 'CRECIMIENTO', 'MULTIMARCA', 'CORPORATIVO', 'FREE', 'gratis', '', null, undefined]) {
      expect(isComplimentaryPlan(key as string | null | undefined)).toBe(false);
    }
  });

  it('is never read-only for payment, whatever the stored billing status', () => {
    for (const stored of ['PENDING_FIRST_PAYMENT', 'SUSPENDED', 'ACTIVE', null]) {
      expect(effectiveBillingStatus({ plan: 'GRATIS', billingStatus: stored })).toBe('ACTIVE');
    }
    expect(effectiveBillingStatus({ plan: 'BASICO', billingStatus: 'PENDING_FIRST_PAYMENT' })).toBe(
      'PENDING_FIRST_PAYMENT',
    );
    expect(effectiveBillingStatus({ plan: 'BASICO', billingStatus: 'SUSPENDED' })).toBe('SUSPENDED');
    expect(effectiveBillingStatus(null)).toBe('ACTIVE');
  });

  it('reads naturally in limit messages', () => {
    expect(planPhrase(PLANS.BASICO)).toBe('Básico plan');
    expect(planPhrase(PLANS.GRATIS)).toBe('Plan Gratis');
  });
});
