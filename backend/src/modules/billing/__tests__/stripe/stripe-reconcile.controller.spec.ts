import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../../auth/decorators/roles.decorator';
import { PLATFORM_ROLE } from '../../../users/authorization/role-levels';
import { StripeReconcileController } from '../../stripe/stripe-reconcile.controller';
import { RECONCILE_BOUNDS, StripeReconcileService } from '../../stripe/stripe-reconcile.service';

/**
 * The reconciliation endpoint's authority, its read-only shape, and its bounds
 * (#248, PR D).
 *
 * The report spans every company, so platform authority is the whole gate: a
 * SUPER_ADMIN working INSIDE a managed company holds organization authority and
 * is refused with the same 404 an outsider gets. The service is faked here; the
 * real behaviour is proven on PostgreSQL.
 */
describe('StripeReconcileController — authority, shape and bounds', () => {
  const unscopedOwner = { platform: true, role: PLATFORM_ROLE, organizationId: null, storeId: null };
  const managedOwner = { platform: true, role: PLATFORM_ROLE, organizationId: 'org-managed', storeId: null };
  const admin = { platform: false, role: 'ADMIN', organizationId: 'org-1', storeId: null };
  const orgManager = { platform: false, role: 'ORGANIZATION_MANAGER', organizationId: 'org-1', storeId: null };
  let report: jest.Mock;
  let controller: StripeReconcileController;

  beforeEach(() => {
    report = jest.fn().mockResolvedValue({ generatedAt: 'now', bounds: {}, counts: {}, findings: [] });
    controller = new StripeReconcileController({ report } as unknown as StripeReconcileService);
  });
  const req = (scope: unknown) => ({ scope, user: { id: 'u1', email: 'owner@example.test' } });

  it('is guarded by JwtAuthGuard and RolesGuard and requires SUPER_ADMIN', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, StripeReconcileController)).toEqual([JwtAuthGuard, RolesGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, StripeReconcileController)).toEqual(['SUPER_ADMIN']);
  });

  it('exposes GET only — the report has no mutating verb at all', () => {
    const proto = StripeReconcileController.prototype as unknown as Record<string, unknown>;
    const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
    expect(handlers).toEqual(['report']);
    expect(Reflect.getMetadata(METHOD_METADATA, proto.report as object)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, StripeReconcileController)).toBe('billing/stripe-reconcile');
  });

  for (const [name, scope] of [
    ['a SUPER_ADMIN inside a managed company', managedOwner],
    ['an ADMIN', admin],
    ['an ORGANIZATION_MANAGER', orgManager],
    ['an absent scope', undefined],
  ] as const) {
    it(`${name} is refused with 404 and the service is never called`, async () => {
      await expect(controller.report(req(scope))).rejects.toThrow(NotFoundException);
      expect(report).not.toHaveBeenCalled();
    });
  }

  it('the unscoped platform owner is served, and the SERVER-MINTED request id is passed through', async () => {
    // `requestIdOf` reads `req.requestId`, which the middleware mints — never a
    // client header. Asserting the exact value pins that, where `expect.any`
    // would have passed for a constant.
    await controller.report({ ...req(unscopedOwner), requestId: 'server-minted-1' } as never);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ requestId: 'server-minted-1' });
  });

  it('a client-supplied x-request-id header is NOT adopted', async () => {
    await controller.report({ ...req(unscopedOwner), headers: { 'x-request-id': 'client-forged' } } as never);
    expect(report.mock.calls[0][0].requestId).not.toBe('client-forged');
  });

  it('bounds are optional and pass through untouched when valid', async () => {
    await controller.report(req(unscopedOwner), '25', '3');
    expect(report.mock.calls[0][0]).toMatchObject({ limit: 25, maxStripePages: 3 });
    report.mockClear();
    await controller.report(req(unscopedOwner));
    expect(report.mock.calls[0][0]).toMatchObject({ limit: undefined, maxStripePages: undefined });
  });

  it('an impossible bound is REFUSED rather than silently clamped', async () => {
    for (const bad of ['0', '-1', 'abc', '1.5', String(RECONCILE_BOUNDS.maxLimit + 1), '99999']) {
      await expect(controller.report(req(unscopedOwner), bad)).rejects.toThrow(BadRequestException);
    }
    await expect(
      controller.report(req(unscopedOwner), undefined, String(RECONCILE_BOUNDS.maxStripePages + 1)),
    ).rejects.toThrow(BadRequestException);
    expect(report).not.toHaveBeenCalled();
  });

  it('the refusal message names the bound and its range, and leaks nothing else', async () => {
    await expect(controller.report(req(unscopedOwner), '0')).rejects.toThrow(
      `limit must be between 1 and ${RECONCILE_BOUNDS.maxLimit}`,
    );
  });
});
