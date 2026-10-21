import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { BillingController } from '../../billing.controller';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../../auth/decorators/roles.decorator';
import { canReadCommercialTerms, TenantScope } from '../../../auth/tenancy/tenant-scope';

/**
 * P5-A2 family 3, D-4 and D-5.
 *
 * A subscription and its payment history describe a client ORGANIZATION:
 *  - branch narrowing never changes which company is described;
 *  - a branch admin runs a store without seeing what the company pays;
 *  - the unscoped platform owner is not a paying tenant and receives NO tenant
 *    commercial rows — its aggregate view is a separate, unbuilt surface.
 *
 * The operational `billingStatus` is different: every staff member needs to
 * know the panel is read-only, so all five roles receive it with `plan: null`
 * when they hold no commercial authority.
 */

const ORG_A = 'org-a';
const STORE_A1 = 'store-a1';
const STORE_A2 = 'store-a2';

const scopeOf = (overrides: Partial<TenantScope>): TenantScope => ({
  platform: false,
  organizationId: null,
  storeId: null,
  allowedStoreIds: [],
  role: 'ADMIN',
  ...overrides,
});

const unscopedOwner = scopeOf({ platform: true, role: 'SUPER_ADMIN' });
const managedOwner = scopeOf({
  platform: true,
  role: 'SUPER_ADMIN',
  organizationId: ORG_A,
  allowedStoreIds: [STORE_A1, STORE_A2],
});
const narrowedManagedOwner = { ...managedOwner, storeId: STORE_A1 };
const orgManager = scopeOf({
  role: 'ORGANIZATION_MANAGER',
  organizationId: ORG_A,
  allowedStoreIds: [STORE_A1, STORE_A2],
});
const narrowedOrgManager = { ...orgManager, storeId: STORE_A1 };
const storeAdmin = scopeOf({ organizationId: ORG_A, storeId: STORE_A1, allowedStoreIds: [STORE_A1] });
const editor = scopeOf({ role: 'EDITOR', organizationId: ORG_A, storeId: STORE_A1, allowedStoreIds: [STORE_A1] });
const viewer = scopeOf({ role: 'VIEWER', organizationId: ORG_A, storeId: STORE_A1, allowedStoreIds: [STORE_A1] });

describe('commercial authority predicate (five-role matrix, narrowing included)', () => {
  it.each([
    ['ORGANIZATION_MANAGER, un-narrowed', orgManager, true],
    ['ORGANIZATION_MANAGER, narrowed to a branch', narrowedOrgManager, true],
    ['SUPER_ADMIN inside a managed organization', managedOwner, true],
    ['SUPER_ADMIN narrowed inside a managed organization', narrowedManagedOwner, true],
    ['SUPER_ADMIN unscoped', unscopedOwner, false],
    ['ADMIN', storeAdmin, false],
    ['EDITOR', editor, false],
    ['VIEWER', viewer, false],
  ])('%s → %s', (_label, scope, expected) => {
    expect(canReadCommercialTerms(scope as TenantScope)).toBe(expected);
  });

  it('grants nothing without a resolved scope, or without an organization', () => {
    expect(canReadCommercialTerms(undefined)).toBe(false);
    expect(canReadCommercialTerms(scopeOf({ role: 'ORGANIZATION_MANAGER', organizationId: null }))).toBe(false);
    expect(canReadCommercialTerms(scopeOf({ role: 'ORGANIZATION_MANAGER', organizationId: '' }))).toBe(false);
  });

  it('narrowing does NOT change the answer — the subscription is the organization’s', () => {
    expect(canReadCommercialTerms(orgManager)).toBe(canReadCommercialTerms(narrowedOrgManager));
    expect(canReadCommercialTerms(managedOwner)).toBe(canReadCommercialTerms(narrowedManagedOwner));
  });
});

describe('BillingController route authority (P5-A2 family 3)', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  const contextFor = (handler: (...args: any[]) => unknown, roleName: string): ExecutionContext =>
    ({
      getHandler: () => handler,
      getClass: () => BillingController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role: { name: roleName } } }) }),
    }) as unknown as ExecutionContext;

  const build = (organization: any = { id: ORG_A, plan: 'BASICO', billingStatus: 'SUSPENDED' }) => {
    const em = { findOne: jest.fn().mockResolvedValue(organization), persistAndFlush: jest.fn() };
    const paymentRepository: any = {
      getEntityManager: () => em,
      find: jest.fn().mockResolvedValue([]),
      create: jest.fn((data: any) => ({ ...data, id: 'pay-1' })),
    };
    const stripeService: any = {
      createCheckout: jest.fn().mockResolvedValue('https://stripe/checkout'),
      createPortal: jest.fn().mockResolvedValue('https://stripe/portal'),
      getStripeInfo: jest.fn().mockResolvedValue({ active: true }),
    };
    const audit = { recordAuditEntry: jest.fn() };
    const controller = new BillingController(paymentRepository, audit as any, stripeService);
    return { controller, em, paymentRepository, stripeService, audit };
  };

  describe('role metadata', () => {
    it.each([
      ['checkout', () => BillingController.prototype.checkout, ['SUPER_ADMIN', 'ORGANIZATION_MANAGER']],
      ['stripeInfo', () => BillingController.prototype.stripeInfo, ['SUPER_ADMIN', 'ORGANIZATION_MANAGER']],
      ['portal', () => BillingController.prototype.portal, ['SUPER_ADMIN', 'ORGANIZATION_MANAGER']],
      ['list', () => BillingController.prototype.list, ['SUPER_ADMIN', 'ORGANIZATION_MANAGER']],
      [
        'status',
        () => BillingController.prototype.status,
        ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN', 'EDITOR', 'VIEWER'],
      ],
      ['record', () => BillingController.prototype.record, ['SUPER_ADMIN']],
    ])('%s carries exactly its approved list', (_name, handler, expected) => {
      expect(reflector.get<string[]>(ROLES_KEY, handler())).toEqual(expected);
    });

    it.each(['ADMIN', 'EDITOR', 'VIEWER'])('RolesGuard refuses %s on payment history', (role) => {
      expect(() => guard.canActivate(contextFor(BillingController.prototype.list, role))).toThrow(ForbiddenException);
    });

    it('RolesGuard keeps the operational status open to every role', () => {
      for (const role of ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN', 'EDITOR', 'VIEWER']) {
        expect(guard.canActivate(contextFor(BillingController.prototype.status, role))).toBe(true);
      }
    });
  });

  describe('payment history is organization-level (D-5, closes F1)', () => {
    it('queries by organization, not by store', async () => {
      const { controller, paymentRepository } = build();
      await controller.list({ scope: orgManager });
      expect(paymentRepository.find).toHaveBeenCalledWith(
        { store: { organization: ORG_A } },
        expect.objectContaining({ limit: 100 }),
      );
    });

    it('is identical for a narrowed manager — branch selection is irrelevant', async () => {
      const { controller, paymentRepository } = build();
      await controller.list({ scope: narrowedOrgManager });
      expect(paymentRepository.find).toHaveBeenCalledWith(
        { store: { organization: ORG_A } },
        expect.objectContaining({ limit: 100 }),
      );
    });

    it('refuses the unscoped platform owner — never an unfiltered cross-tenant read', async () => {
      const { controller, paymentRepository } = build();
      await expect(controller.list({ scope: unscopedOwner })).rejects.toThrow(ForbiddenException);
      expect(paymentRepository.find).not.toHaveBeenCalled();
    });

    it('refuses a request with no resolved scope', async () => {
      const { controller, paymentRepository } = build();
      await expect(controller.list({})).rejects.toThrow(ForbiddenException);
      expect(paymentRepository.find).not.toHaveBeenCalled();
    });
  });

  describe('subscription operations are organization-identified (D-4)', () => {
    it('checkout, portal and stripe-info pass the organization id', async () => {
      const { controller, stripeService } = build();
      await controller.checkout({ scope: orgManager, user: { email: 'm@acme.com' } }, { plan: 'BASICO' } as any);
      await controller.portal({ scope: orgManager });
      await controller.stripeInfo({ scope: orgManager });
      expect(stripeService.createCheckout).toHaveBeenCalledWith(
        ORG_A,
        'BASICO',
        { id: null, email: 'm@acme.com' },
        { requestId: expect.any(String) },
      );
      expect(stripeService.createPortal).toHaveBeenCalledWith(ORG_A);
      expect(stripeService.getStripeInfo).toHaveBeenCalledWith(ORG_A);
    });

    it('an unscoped owner must enter a managed organization first', async () => {
      const { controller, stripeService } = build();
      await expect(controller.checkout({ scope: unscopedOwner, user: {} }, { plan: 'BASICO' } as any)).rejects.toThrow(
        /organization context/,
      );
      await expect(controller.portal({ scope: unscopedOwner })).rejects.toThrow(ForbiddenException);
      await expect(controller.stripeInfo({ scope: unscopedOwner })).rejects.toThrow(ForbiddenException);
      expect(stripeService.createCheckout).not.toHaveBeenCalled();
      expect(stripeService.createPortal).not.toHaveBeenCalled();
      expect(stripeService.getStripeInfo).not.toHaveBeenCalled();
    });
  });

  describe('status separates operational state from commercial terms', () => {
    it('serves the real billingStatus to a store admin, with plan withheld', async () => {
      const { controller } = build();
      const res: any = await controller.status({ scope: storeAdmin });
      expect(res.data.billingStatus).toBe('SUSPENDED');
      expect(res.data.plan).toBeNull();
    });

    it.each([
      ['EDITOR', editor],
      ['VIEWER', viewer],
    ])('serves %s the status without commercial terms', async (_label, scope) => {
      const { controller } = build();
      const res: any = await controller.status({ scope });
      expect(res.data.billingStatus).toBe('SUSPENDED');
      expect(res.data.plan).toBeNull();
    });

    it('serves the plan to an organization manager, narrowed or not', async () => {
      const { controller } = build();
      const wide: any = await controller.status({ scope: orgManager });
      const narrow: any = await controller.status({ scope: narrowedOrgManager });
      expect(wide.data.plan).toEqual(
        expect.objectContaining({ key: 'BASICO', maxWebsites: expect.anything(), maxTeamUsers: expect.anything() }),
      );
      expect(narrow.data.plan).toEqual(wide.data.plan);
    });

    it('serves the plan to a SUPER_ADMIN inside a managed organization', async () => {
      const { controller } = build();
      const res: any = await controller.status({ scope: managedOwner });
      expect(res.data.plan).not.toBeNull();
    });

    it('gives the unscoped owner the minimal placeholder and reads no organization', async () => {
      const { controller, em } = build();
      const res: any = await controller.status({ scope: unscopedOwner });
      expect(res.data).toEqual({ billingStatus: 'ACTIVE', plan: null });
      expect(em.findOne).not.toHaveBeenCalled();
    });
  });

  describe('recording a client payment is a platform control (F8)', () => {
    it('refuses a SUPER_ADMIN acting inside a managed organization', async () => {
      const { controller, paymentRepository } = build();
      await expect(
        controller.record({ scope: managedOwner, user: {} }, { storeId: STORE_A1, amountUsd: 10 } as any),
      ).rejects.toThrow(NotFoundException);
      expect(paymentRepository.create).not.toHaveBeenCalled();
    });

    it('refuses an organization manager', async () => {
      const { controller, paymentRepository } = build();
      await expect(
        controller.record({ scope: orgManager, user: {} }, { storeId: STORE_A1, amountUsd: 10 } as any),
      ).rejects.toThrow(NotFoundException);
      expect(paymentRepository.create).not.toHaveBeenCalled();
    });
  });
});
