import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BillingController } from '../../billing.controller';

/**
 * P5-A1 fail-closed (Option B): a manual payment records against a real client
 * store that belongs to a real organization. A failed lookup must never
 * silently become platform context, nothing may persist before the resolution
 * succeeds, and ownership derives from the AFFECTED STORE — never from
 * req.user / req.scope.
 */
describe('BillingController.record (P5-A1 fail-closed payment context)', () => {
  const dto = { storeId: 's1', amountUsd: 50, description: 'Zelle agosto', paidAt: '2026-08-18T00:00:00.000Z' };

  /**
   * The acting platform owner is UNSCOPED (P5-A2 family 3, F8: recording a
   * client payment is a platform commercial control), yet its user object
   * still carries a decoy store binding: if any of that leaked into the audit
   * context, the ownership assertion below would fail.
   */
  const req = {
    user: { id: 'owner-1', email: 'owner@wegox.io', store: { id: 'actor-store', organization: { id: 'actor-org' } } },
    scope: { platform: true, role: 'SUPER_ADMIN', organizationId: null, storeId: null, allowedStoreIds: [] },
  };

  const build = (storeLookup: any) => {
    const em = { findOne: jest.fn().mockResolvedValue(storeLookup), persistAndFlush: jest.fn() };
    const paymentRepository: any = {
      getEntityManager: () => em,
      create: jest.fn((data: any) => ({ ...data, id: 'pay-1' })),
    };
    const auditLogService = { recordAuditEntry: jest.fn().mockResolvedValue(undefined) };
    const controller = new BillingController(paymentRepository, auditLogService as any, {} as any);
    return { controller, em, paymentRepository, auditLogService };
  };

  it('refuses a missing store BEFORE payment creation, persistence, flush, or audit', async () => {
    const { controller, em, paymentRepository, auditLogService } = build(null);

    await expect(controller.record(req, dto as any)).rejects.toThrow(BadRequestException);
    await expect(controller.record(req, dto as any)).rejects.toThrow(/missing store/);

    expect(paymentRepository.create).not.toHaveBeenCalled(); // no payment row built
    expect(em.persistAndFlush).not.toHaveBeenCalled(); // nothing persisted
    expect(auditLogService.recordAuditEntry).not.toHaveBeenCalled(); // no audit row
  });

  it('refuses a store without an organization BEFORE payment creation, persistence, flush, or audit', async () => {
    const { controller, em, paymentRepository, auditLogService } = build({ id: 's1', organization: null });

    await expect(controller.record(req, dto as any)).rejects.toThrow(BadRequestException);
    await expect(controller.record(req, dto as any)).rejects.toThrow(/no organization/);

    expect(paymentRepository.create).not.toHaveBeenCalled();
    expect(em.persistAndFlush).not.toHaveBeenCalled();
    expect(auditLogService.recordAuditEntry).not.toHaveBeenCalled();
  });

  it('valid store+organization creates the payment, activates the organization, and audits concrete context', async () => {
    const organization = { id: 'org-1', billingStatus: 'SUSPENDED' };
    const { controller, em, paymentRepository, auditLogService } = build({ id: 's1', organization });

    const res = await controller.record(req, dto as any);

    expect(res).toEqual({ data: { id: 'pay-1' } });
    expect(paymentRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({ store: 's1', amountUsd: '50.00', status: 'PAID' }),
    );
    expect(organization.billingStatus).toBe('ACTIVE'); // recorded payment unlocks the client
    expect(em.persistAndFlush).toHaveBeenCalled();
    expect(auditLogService.recordAuditEntry).toHaveBeenCalledWith(
      'owner-1',
      'owner@wegox.io',
      expect.anything(),
      's1',
      expect.anything(),
      null,
      expect.stringContaining('50.00'),
      // Ownership derives from the AFFECTED store — never the actor's tenant
      { organizationId: 'org-1', storeId: 's1' },
    );
  });

  it('never derives the audit context from req.user or req.scope', async () => {
    const { controller, auditLogService } = build({ id: 's1', organization: { id: 'org-1' } });

    await controller.record(req, dto as any);

    const context = auditLogService.recordAuditEntry.mock.calls[0][7];
    expect(context.organizationId).not.toBe(req.user.store.organization.id);
    expect(context.storeId).not.toBe(req.user.store.id);
    expect(context).toEqual({ organizationId: 'org-1', storeId: 's1' });
  });

  /**
   * F8: a SUPER_ADMIN working inside a managed company holds ORGANIZATION
   * authority, not platform authority — recording a client's payment is not
   * theirs to do, and nothing may be written while proving it.
   */
  it('refuses a SUPER_ADMIN scoped into a managed organization, with zero mutation', async () => {
    const { controller, em, paymentRepository, auditLogService } = build({ id: 's1', organization: { id: 'org-1' } });
    const managedOrgOwner = {
      user: req.user,
      scope: {
        platform: true,
        role: 'SUPER_ADMIN',
        organizationId: 'org-1',
        storeId: null,
        allowedStoreIds: ['s1'],
      },
    };

    await expect(controller.record(managedOrgOwner, dto as any)).rejects.toThrow(NotFoundException);

    expect(em.findOne).not.toHaveBeenCalled();
    expect(paymentRepository.create).not.toHaveBeenCalled();
    expect(em.persistAndFlush).not.toHaveBeenCalled();
    expect(auditLogService.recordAuditEntry).not.toHaveBeenCalled();
  });

  it('refuses an actor with no resolved scope at all', async () => {
    const { controller, paymentRepository, auditLogService } = build({ id: 's1', organization: { id: 'org-1' } });

    await expect(controller.record({ user: req.user }, dto as any)).rejects.toThrow(NotFoundException);

    expect(paymentRepository.create).not.toHaveBeenCalled();
    expect(auditLogService.recordAuditEntry).not.toHaveBeenCalled();
  });
});
