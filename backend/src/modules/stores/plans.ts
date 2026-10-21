/**
 * Catalog commercial plans (agreed 2026-07-10). The plan lives on
 * the client organization; limits are enforced server-side. `maxWebsites`
 * counts non-archived stores across the organization and `maxTeamUsers`
 * counts all non-deactivated users belonging to that organization.
 */
export interface PlanLimits {
  maxWebsites: number | null; // null = unlimited
  maxTeamUsers: number | null;
}

export interface PlanDefinition extends PlanLimits {
  key: string;
  name: string;
  priceUsd: number | null; // null = custom pricing
  /**
   * Whether tenants may see and choose this plan: the Billing page's plan
   * list, card checkout and "request this plan". A plan that is not offered is
   * assigned only by the unscoped platform owner.
   */
  offeredToTenants: boolean;
  /**
   * A complimentary plan's price is permanently zero. It is never checked
   * out, never needs a Stripe customer, subscription or payment, and never
   * leaves the panel read-only while "waiting for payment".
   */
  complimentary: boolean;
}

/**
 * THE ONE CANONICAL LIMIT POLICY PER TIER.
 *
 * Plan Gratis is Básico at a permanent zero price, so both entries take their
 * limits from the SAME frozen object. A limit added to or changed on the Básico
 * tier reaches Plan Gratis by construction; `plans.spec.ts` proves the two
 * effective limit sets are identical so a later hand-edit cannot drift them.
 */
const LIMITS = {
  BASICO: Object.freeze({ maxWebsites: 1, maxTeamUsers: 3 }),
  CRECIMIENTO: Object.freeze({ maxWebsites: 3, maxTeamUsers: 10 }),
  MULTIMARCA: Object.freeze({ maxWebsites: 5, maxTeamUsers: 20 }),
  CORPORATIVO: Object.freeze({ maxWebsites: null, maxTeamUsers: null }),
} satisfies Record<string, Readonly<PlanLimits>>;

export const PLANS: Record<string, PlanDefinition> = {
  BASICO: {
    key: 'BASICO',
    name: 'Básico',
    priceUsd: 30,
    ...LIMITS.BASICO,
    offeredToTenants: true,
    complimentary: false,
  },
  CRECIMIENTO: {
    key: 'CRECIMIENTO',
    name: 'Crecimiento',
    priceUsd: 50,
    ...LIMITS.CRECIMIENTO,
    offeredToTenants: true,
    complimentary: false,
  },
  MULTIMARCA: {
    key: 'MULTIMARCA',
    name: 'Multimarca',
    priceUsd: 70,
    ...LIMITS.MULTIMARCA,
    offeredToTenants: true,
    complimentary: false,
  },
  CORPORATIVO: {
    key: 'CORPORATIVO',
    name: 'Corporativo',
    priceUsd: null,
    ...LIMITS.CORPORATIVO,
    offeredToTenants: true,
    complimentary: false,
  },
  GRATIS: {
    key: 'GRATIS',
    name: 'Plan Gratis',
    priceUsd: 0,
    ...LIMITS.BASICO,
    offeredToTenants: false,
    complimentary: true,
  },
};

export const DEFAULT_PLAN = 'BASICO';

/** Every operational limit a plan carries; the commercial fields are everything else. */
export const PLAN_LIMIT_KEYS: readonly (keyof PlanLimits)[] = ['maxWebsites', 'maxTeamUsers'];

/** "the Básico plan", but "Plan Gratis" — never "the Plan Gratis plan". */
export function planPhrase(plan: Pick<PlanDefinition, 'name'>): string {
  return /^plan\b/i.test(plan.name) ? plan.name : `${plan.name} plan`;
}

export function limitsOf(plan: PlanDefinition): PlanLimits {
  return { maxWebsites: plan.maxWebsites, maxTeamUsers: plan.maxTeamUsers };
}

export function isComplimentaryPlan(planKey: string | null | undefined): boolean {
  return typeof planKey === 'string' && PLANS[planKey]?.complimentary === true;
}

/** The plans a tenant may see or choose. Never includes a complimentary plan. */
export function tenantOfferedPlans(): PlanDefinition[] {
  return Object.values(PLANS).filter((plan) => plan.offeredToTenants && !plan.complimentary);
}

export function effectivePlanPriceUsd(
  plan: PlanDefinition,
  organization?: {
    monthlyPriceUsdOverride?: string | null;
    monthlyPriceOverridePlan?: string | null;
  },
): number | null {
  // Permanently zero: no contractual override can put a price on it.
  if (plan.complimentary) return 0;
  const override = organization?.monthlyPriceUsdOverride;
  return override === undefined || override === null || organization?.monthlyPriceOverridePlan !== plan.key
    ? plan.priceUsd
    : Number(override);
}

/**
 * The billing status every gate and screen must use. A company on a
 * complimentary plan is never waiting for payment, whatever an older row or a
 * late writer left in `billing_status`, so it is always ACTIVE here.
 */
export function effectiveBillingStatus(
  organization: { plan?: string | null; billingStatus?: string | null } | null | undefined,
): string {
  if (organization && isComplimentaryPlan(organization.plan)) return 'ACTIVE';
  return organization?.billingStatus ?? 'ACTIVE';
}
