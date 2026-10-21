import { BadRequestException, ConflictException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Organization } from '../../organizations/entities/organization.entity';
import { Store } from '../../stores/entities/store.entity';
import { User } from '../../users/entities/user.entity';
import { DEFAULT_PLAN, isComplimentaryPlan, PlanDefinition, planPhrase, PLANS } from '../../stores/plans';

export interface PlanUsage {
  websites: number;
  teamUsers: number;
}

/**
 * BUS-001's single commercial-policy boundary.
 *
 * Limits belong to an organization. Every operation which increases a
 * limited resource takes the same transaction-scoped advisory lock before it
 * counts and writes, so two concurrent requests cannot both consume the last
 * slot. Product/content publication is intentionally absent: no current plan
 * defines a publication or product limit.
 */
export interface LatestCheckoutAttempt {
  status: string;
  failureCode: string | null;
  completedEventId: string | null;
}

export type UnresolvedCheckoutReason = 'checkout_in_progress' | 'unreconciled_subscription' | 'completed_unrecorded';

/** Pure: whether a company's latest checkout attempt could still be, or become, a paid subscription. */
export function unresolvedCheckoutReason(latest: LatestCheckoutAttempt | null): UnresolvedCheckoutReason | null {
  if (!latest) return null;
  if (latest.status === 'creating' || latest.status === 'open') return 'checkout_in_progress';
  if (latest.status === 'failed' && latest.failureCode === 'unreconciled') return 'unreconciled_subscription';
  if (latest.status === 'completed' && !latest.completedEventId) return 'completed_unrecorded';
  return null;
}

const UNRESOLVED_CHECKOUT_MESSAGES: Record<UnresolvedCheckoutReason, (plan: string) => string> = {
  checkout_in_progress: (plan) =>
    `A card checkout is in progress for this company. ${plan} can be assigned once it completes, expires or fails.`,
  unreconciled_subscription: (plan) =>
    `Card billing reported a live subscription for this company that was never recorded. Reconcile it before assigning ${plan}.`,
  completed_unrecorded: (plan) =>
    `A card checkout for this company completed without being recorded. Reconcile it before assigning ${plan}.`,
};

export class OrganizationPlanPolicy {
  static planOf(organization: Pick<Organization, 'plan'>): PlanDefinition {
    return PLANS[organization.plan] ?? PLANS[DEFAULT_PLAN];
  }

  static async lock(em: EntityManager, organizationId: string): Promise<void> {
    await em.execute(`select pg_advisory_xact_lock(hashtextextended(?, 0))`, [`plan-capacity:${organizationId}`]);
  }

  static async usage(em: EntityManager, organizationId: string): Promise<PlanUsage> {
    const [websites, teamUsers] = await Promise.all([
      em.count(Store, { organization: organizationId, archivedAt: null }),
      em.count(User, { organization: organizationId, deletedAt: null }),
    ]);
    return { websites, teamUsers };
  }

  static async requireOrganization(em: EntityManager, organizationId: string): Promise<Organization> {
    const organization = await em.findOne(Organization, { id: organizationId, archivedAt: null });
    if (!organization) throw new BadRequestException('Organization not found or archived');
    return organization;
  }

  static async assertWebsiteSlot(em: EntityManager, organization: Organization): Promise<void> {
    const plan = this.planOf(organization);
    if (plan.maxWebsites === null) return;
    const websites = await em.count(Store, { organization: organization.id, archivedAt: null });
    if (websites >= plan.maxWebsites) {
      throw new BadRequestException(
        `The ${planPhrase(plan)} includes ${this.units(plan.maxWebsites, 'website')}. Archive a website or upgrade the plan before adding another.`,
      );
    }
  }

  static async assertTeamUserSlot(em: EntityManager, organization: Organization): Promise<void> {
    const plan = this.planOf(organization);
    if (plan.maxTeamUsers === null) return;
    const teamUsers = await em.count(User, { organization: organization.id, deletedAt: null });
    if (teamUsers >= plan.maxTeamUsers) {
      throw new BadRequestException(
        `The ${planPhrase(plan)} includes ${this.units(plan.maxTeamUsers, 'team member')}. Deactivate a team member or upgrade the plan before adding another.`,
      );
    }
  }

  static async assertPlanChange(em: EntityManager, organization: Organization, target: PlanDefinition): Promise<void> {
    const usage = await this.usage(em, organization.id);
    const excessWebsites = target.maxWebsites === null ? 0 : Math.max(0, usage.websites - target.maxWebsites);
    const excessUsers = target.maxTeamUsers === null ? 0 : Math.max(0, usage.teamUsers - target.maxTeamUsers);
    if (excessWebsites === 0 && excessUsers === 0) return;

    const actions: string[] = [];
    if (excessWebsites > 0) actions.push(`archive ${this.units(excessWebsites, 'website')}`);
    if (excessUsers > 0) actions.push(`deactivate ${this.units(excessUsers, 'team member')}`);
    throw new BadRequestException(
      `Your current usage does not fit the ${planPhrase(target)}. To switch plans, ${this.join(actions)} first.`,
    );
  }

  /**
   * The billing status a plan assignment leaves behind. A complimentary plan
   * (Plan Gratis) is never waiting for payment: assigning it sets ACTIVE, and
   * an explicit request for any other status on it is refused, never ignored.
   * Every other plan keeps the requested status, or the current one.
   */
  static billingStatusFor(planKey: string, requested: string | undefined, current: string): string {
    if (!isComplimentaryPlan(planKey)) return requested ?? current;
    if (requested !== undefined && requested !== 'ACTIVE') {
      throw new BadRequestException(`${PLANS[planKey].name} is never billed, so its billing status is always ACTIVE`);
    }
    return 'ACTIVE';
  }

  /**
   * THE PLAN GRATIS CONCURRENCY CONTRACT, assignment side (#318).
   *
   * A company is never moved onto a complimentary plan while card billing for
   * it could still become, or already be, a paid subscription:
   *
   *   - a recorded subscription: cancel it first, in the payment portal;
   *   - its LATEST checkout attempt is `creating` or `open`: a session exists or
   *     may exist at Stripe, and could still be paid;
   *   - its latest attempt FAILED as `unreconciled`: Stripe reported a live
   *     subscription this system never recorded;
   *   - its latest attempt COMPLETED without a recorded event: a paid session
   *     whose outcome was never applied.
   *
   * A `failed` attempt with any other code (no session was created), an
   * `expired` one, or a completion recorded through its event does not block.
   *
   * Callers MUST hold the organization-plan lock (and the row lock): checkout
   * commits its attempt under the same plan lock, so whichever commits first
   * is what the other sees. Refusals are 409 with a stable `reason` and carry
   * no Stripe identifier.
   */
  static async assertComplimentaryAssignable(
    db: Pick<EntityManager, 'execute'>,
    organization: { id: string; stripeSubscriptionId?: string | null },
    planKey: string,
  ): Promise<void> {
    if (!isComplimentaryPlan(planKey)) return;
    const name = PLANS[planKey].name;
    if (organization.stripeSubscriptionId) {
      throw new ConflictException({
        statusCode: 409,
        reason: 'card_subscription',
        message: `This company still has a card subscription. Cancel it before moving the company to ${name}.`,
      });
    }
    const [latest] = (await db.execute(
      `select status, failure_code as "failureCode", completed_event_id as "completedEventId"
         from billing_checkout_attempts where organization_id = ?::uuid
        order by created_at desc, updated_at desc limit 1`,
      [organization.id],
    )) as LatestCheckoutAttempt[];
    const reason = unresolvedCheckoutReason(latest ?? null);
    if (reason) {
      throw new ConflictException({ statusCode: 409, reason, message: UNRESOLVED_CHECKOUT_MESSAGES[reason](name) });
    }
  }

  private static units(count: number, noun: string): string {
    return `${count} ${noun}${count === 1 ? '' : 's'}`;
  }

  private static join(actions: string[]): string {
    return actions.length === 2 ? `${actions[0]} and ${actions[1]}` : actions[0];
  }
}
