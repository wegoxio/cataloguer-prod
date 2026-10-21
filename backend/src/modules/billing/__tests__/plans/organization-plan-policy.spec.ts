import { BadRequestException } from '@nestjs/common';
import { OrganizationPlanPolicy, unresolvedCheckoutReason } from '../../plans/organization-plan-policy';
import { effectivePlanPriceUsd, PLANS } from '../../../stores/plans';

describe('BUS-001 organization plan business matrix', () => {
  const organization: any = { id: 'org-1', name: 'Acme', plan: 'BASICO', archivedAt: null };
  let em: any;

  beforeEach(() => {
    em = { count: jest.fn(), execute: jest.fn(), findOne: jest.fn().mockResolvedValue(organization) };
  });

  it('defines limits at organization level and leaves publication unlimited', () => {
    expect(PLANS.BASICO).toMatchObject({ maxWebsites: 1, maxTeamUsers: 3 });
    expect(PLANS.BASICO).not.toHaveProperty('maxProducts');
    expect(PLANS.BASICO).not.toHaveProperty('maxPublishedProducts');
  });

  it('counts non-archived websites across the organization', async () => {
    em.count.mockResolvedValueOnce(1);

    await expect(OrganizationPlanPolicy.assertWebsiteSlot(em, organization)).rejects.toThrow(
      'Archive a website or upgrade the plan',
    );
    expect(em.count).toHaveBeenCalledWith(expect.anything(), { organization: 'org-1', archivedAt: null });
  });

  it('counts all active team members across the organization, not one store', async () => {
    em.count.mockResolvedValueOnce(3);

    await expect(OrganizationPlanPolicy.assertTeamUserSlot(em, organization)).rejects.toThrow(
      'Deactivate a team member or upgrade the plan',
    );
    expect(em.count).toHaveBeenCalledWith(expect.anything(), { organization: 'org-1', deletedAt: null });
  });

  it('allows capacity while usage remains below both limits', async () => {
    em.count.mockResolvedValue(0);

    await expect(OrganizationPlanPolicy.assertWebsiteSlot(em, organization)).resolves.toBeUndefined();
    await expect(OrganizationPlanPolicy.assertTeamUserSlot(em, organization)).resolves.toBeUndefined();
  });

  it('blocks a downgrade and says exactly what must be archived and deactivated', async () => {
    em.count.mockResolvedValueOnce(3).mockResolvedValueOnce(5);

    const error = await OrganizationPlanPolicy.assertPlanChange(em, organization, PLANS.BASICO).catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toBe(
      'Your current usage does not fit the Básico plan. To switch plans, archive 2 websites and deactivate 2 team members first.',
    );
  });

  it('allows a plan change when current organization usage fits', async () => {
    em.count.mockResolvedValueOnce(1).mockResolvedValueOnce(3);
    await expect(OrganizationPlanPolicy.assertPlanChange(em, organization, PLANS.BASICO)).resolves.toBeUndefined();
  });

  it('uses one transaction-scoped organization lock for competing capacity changes', async () => {
    await OrganizationPlanPolicy.lock(em, 'org-1');
    expect(em.execute).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['plan-capacity:org-1']);
  });

  it('gives DesignHof Basic limits at a zero contractual price without changing global Basic pricing', () => {
    expect(effectivePlanPriceUsd(PLANS.BASICO)).toBe(30);
    const designHof = { monthlyPriceUsdOverride: '0.00', monthlyPriceOverridePlan: 'BASICO' };
    expect(effectivePlanPriceUsd(PLANS.BASICO, designHof)).toBe(0);
    expect(effectivePlanPriceUsd(PLANS.CRECIMIENTO, designHof)).toBe(50);
    expect(PLANS.BASICO.maxWebsites).toBe(1);
    expect(PLANS.BASICO.maxTeamUsers).toBe(3);
  });
});

describe('Plan Gratis under the organization plan policy', () => {
  const organization = (plan: string): any => ({ id: 'org-1', name: 'Acme', plan, archivedAt: null });
  const outcome = async (run: () => Promise<unknown>) =>
    run().then(
      () => 'allowed',
      (error) => (error instanceof BadRequestException ? 'refused' : `threw ${error}`),
    );

  it('refuses and allows EXACTLY where Básico does, for every website and team-member count around the limits', async () => {
    for (const websites of [0, 1, 2]) {
      for (const teamUsers of [0, 2, 3, 4]) {
        const results: Record<string, string[]> = {};
        for (const plan of ['BASICO', 'GRATIS']) {
          const em: any = { count: jest.fn(), execute: jest.fn() };
          em.count.mockImplementation((_entity: unknown, where: Record<string, unknown>) =>
            Promise.resolve('archivedAt' in where ? websites : teamUsers),
          );
          results[plan] = [
            await outcome(() => OrganizationPlanPolicy.assertWebsiteSlot(em, organization(plan))),
            await outcome(() => OrganizationPlanPolicy.assertTeamUserSlot(em, organization(plan))),
            await outcome(() => OrganizationPlanPolicy.assertPlanChange(em, organization('CRECIMIENTO'), PLANS[plan])),
          ];
        }
        expect({ websites, teamUsers, gratis: results.GRATIS }).toEqual({
          websites,
          teamUsers,
          gratis: results.BASICO,
        });
      }
    }
  });

  it('names the plan naturally when it refuses', async () => {
    const em: any = { count: jest.fn().mockResolvedValue(1), execute: jest.fn() };
    await expect(OrganizationPlanPolicy.assertWebsiteSlot(em, organization('GRATIS'))).rejects.toThrow(
      'The Plan Gratis includes 1 website.',
    );
  });

  it('is always ACTIVE: assigning it sets ACTIVE and an explicit other status is refused', () => {
    expect(OrganizationPlanPolicy.billingStatusFor('GRATIS', undefined, 'PENDING_FIRST_PAYMENT')).toBe('ACTIVE');
    expect(OrganizationPlanPolicy.billingStatusFor('GRATIS', 'ACTIVE', 'SUSPENDED')).toBe('ACTIVE');
    for (const requested of ['PENDING_FIRST_PAYMENT', 'SUSPENDED']) {
      expect(() => OrganizationPlanPolicy.billingStatusFor('GRATIS', requested, 'ACTIVE')).toThrow(BadRequestException);
    }
    // Every other plan is untouched by the rule.
    expect(OrganizationPlanPolicy.billingStatusFor('BASICO', undefined, 'PENDING_FIRST_PAYMENT')).toBe(
      'PENDING_FIRST_PAYMENT',
    );
    expect(OrganizationPlanPolicy.billingStatusFor('BASICO', 'SUSPENDED', 'ACTIVE')).toBe('SUSPENDED');
  });

  it('cannot be assigned to a company that still has a card subscription', async () => {
    const db = { execute: jest.fn().mockResolvedValue([]) };
    await expect(
      OrganizationPlanPolicy.assertComplimentaryAssignable(
        db as any,
        { id: 'org-1', stripeSubscriptionId: 'sub_1' },
        'GRATIS',
      ),
    ).rejects.toThrow('This company still has a card subscription');
    await expect(
      OrganizationPlanPolicy.assertComplimentaryAssignable(
        db as any,
        { id: 'org-1', stripeSubscriptionId: null },
        'GRATIS',
      ),
    ).resolves.toBeUndefined();
    await expect(
      OrganizationPlanPolicy.assertComplimentaryAssignable(
        db as any,
        { id: 'org-1', stripeSubscriptionId: 'sub_1' },
        'BASICO',
      ),
    ).resolves.toBeUndefined();
    // A paid plan never reads checkout state at all.
    expect(db.execute).toHaveBeenCalledTimes(1);
  });

  it('refuses while the latest checkout could still be, or become, a paid subscription — and only then', async () => {
    const cases: [Record<string, unknown> | null, string | null][] = [
      [null, null],
      [{ status: 'creating', failureCode: null, completedEventId: null }, 'checkout_in_progress'],
      [{ status: 'open', failureCode: null, completedEventId: null }, 'checkout_in_progress'],
      [{ status: 'failed', failureCode: 'unreconciled', completedEventId: null }, 'unreconciled_subscription'],
      [{ status: 'completed', failureCode: null, completedEventId: null }, 'completed_unrecorded'],
      [{ status: 'failed', failureCode: 'StripeInvalidRequestError', completedEventId: null }, null],
      [{ status: 'failed', failureCode: 'no_url', completedEventId: null }, null],
      [{ status: 'expired', failureCode: null, completedEventId: null }, null],
      [{ status: 'completed', failureCode: null, completedEventId: 'evt_1' }, null],
    ];
    for (const [latest, reason] of cases) {
      expect({ latest, reason: unresolvedCheckoutReason(latest as any) }).toEqual({ latest, reason });
      const db = { execute: jest.fn().mockResolvedValue(latest ? [latest] : []) };
      const outcome = await OrganizationPlanPolicy.assertComplimentaryAssignable(
        db as any,
        { id: 'org-1' },
        'GRATIS',
      ).then(
        () => null,
        (error) => (error as { getResponse: () => { reason: string } }).getResponse().reason,
      );
      expect({ latest, outcome }).toEqual({ latest, outcome: reason });
    }
  });
});
