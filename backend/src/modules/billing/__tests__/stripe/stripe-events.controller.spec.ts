import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../../auth/decorators/roles.decorator';
import { PLATFORM_ROLE } from '../../../users/authorization/role-levels';
import { StripeEventsController } from '../../stripe/stripe-events.controller';
import { StripeService } from '../../stripe/stripe.service';

/**
 * The reapply endpoint's authority and its outcome mapping (#248, PR B).
 *
 * The chain is the one every owner-only endpoint uses — JwtAuthGuard,
 * RolesGuard with SUPER_ADMIN, then `assertUnscopedPlatformOwner` so a
 * SUPER_ADMIN working INSIDE a managed company (organization authority) is
 * refused with the same 404 an outsider gets. This file pins that the chain
 * is actually attached and that each service outcome maps to the documented
 * status, with the service itself faked.
 */
describe('StripeEventsController — authority and outcome mapping', () => {
  const unscopedOwner = { platform: true, role: PLATFORM_ROLE, organizationId: null, storeId: null };
  const managedOwner = { platform: true, role: PLATFORM_ROLE, organizationId: 'org-managed', storeId: null };
  const admin = { platform: false, role: 'ADMIN', organizationId: 'org-1', storeId: null };
  let reapplyEvent: jest.Mock;
  let controller: StripeEventsController;

  beforeEach(() => {
    reapplyEvent = jest.fn();
    controller = new StripeEventsController({ reapplyEvent } as unknown as StripeService);
  });

  const req = (scope: unknown, user: unknown = { id: 'user-owner', email: 'owner@example.test' }) => ({ scope, user });

  it('is guarded by JwtAuthGuard and RolesGuard, and requires SUPER_ADMIN', () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, StripeEventsController) ?? [];
    expect(guards).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, StripeEventsController)).toEqual(['SUPER_ADMIN']);
  });

  it('a SUPER_ADMIN inside a managed company is refused (404), and the service is never called', async () => {
    await expect(controller.reapply(req(managedOwner), 'evt_1234567890')).rejects.toThrow(NotFoundException);
    expect(reapplyEvent).not.toHaveBeenCalled();
  });

  it('a non-platform scope is refused (404) even if the roles guard were misconfigured', async () => {
    await expect(controller.reapply(req(admin), 'evt_1234567890')).rejects.toThrow(NotFoundException);
    expect(reapplyEvent).not.toHaveBeenCalled();
  });

  it('a malformed event id is a 400 before any lookup', async () => {
    await expect(controller.reapply(req(unscopedOwner), 'in_1234567890')).rejects.toThrow(BadRequestException);
    await expect(controller.reapply(req(unscopedOwner), "evt_1'; drop table x--")).rejects.toThrow(BadRequestException);
    expect(reapplyEvent).not.toHaveBeenCalled();
  });

  it('a request without an acting user is a 400', async () => {
    await expect(controller.reapply(req(unscopedOwner, {}), 'evt_1234567890')).rejects.toThrow(BadRequestException);
    expect(reapplyEvent).not.toHaveBeenCalled();
  });

  it('maps not_found → 404, already_resolved → 409, no_change → 409 with the reason, resolved → 200 with the result', async () => {
    reapplyEvent.mockResolvedValueOnce({ kind: 'not_found' });
    await expect(controller.reapply(req(unscopedOwner), 'evt_1234567890')).rejects.toThrow(NotFoundException);
    reapplyEvent.mockResolvedValueOnce({ kind: 'already_resolved' });
    await expect(controller.reapply(req(unscopedOwner), 'evt_1234567890')).rejects.toThrow(ConflictException);
    reapplyEvent.mockResolvedValueOnce({ kind: 'no_change', reason: 'plan_change_refused' });
    await expect(controller.reapply(req(unscopedOwner), 'evt_1234567890')).rejects.toThrow(/plan_change_refused/);
    reapplyEvent.mockResolvedValueOnce({ kind: 'resolved', result: 'applied', reason: 'activated' });
    await expect(controller.reapply(req(unscopedOwner), 'evt_1234567890')).resolves.toEqual({
      data: { eventId: 'evt_1234567890', result: 'applied', reason: 'activated' },
    });
    expect(reapplyEvent).toHaveBeenLastCalledWith(
      'evt_1234567890',
      { id: 'user-owner', email: 'owner@example.test' },
      expect.any(String),
    );
  });
});
