import { Reflector } from '@nestjs/core';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AuditLogController } from '../audit-log.controller';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { TenantScope } from '../../auth/tenancy/tenant-scope';

/**
 * P5-A2 family 1: the tenant view derives from the resolved TenantScope with
 * role/scope COHERENCE — never from field shape alone, and never from
 * `req.user.store` (the decoy test pins that). ORGANIZATION_MANAGER is now
 * admitted with its organization-wide view — or, when the resolver narrows it
 * to an own branch, the exact-store view of that branch (a restriction, never
 * an expansion). This flips the P5-A1 refusal test that was pinned for exactly
 * this boundary.
 */
describe('AuditLogController (P5-A2 family 1)', () => {
  const reflector = new Reflector();

  const guardContext = (roleName: string): ExecutionContext =>
    ({
      getHandler: () => AuditLogController.prototype.findAll,
      getClass: () => AuditLogController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role: { name: roleName } } }) }),
    }) as unknown as ExecutionContext;

  it('pins the listing role metadata to exactly SUPER_ADMIN, ADMIN and ORGANIZATION_MANAGER', () => {
    const roles = reflector.get<string[]>(ROLES_KEY, AuditLogController.prototype.findAll);
    expect(roles).toEqual(['SUPER_ADMIN', 'ADMIN', 'ORGANIZATION_MANAGER']);
  });

  it('RolesGuard admits SUPER_ADMIN, ADMIN and ORGANIZATION_MANAGER, refuses EDITOR and VIEWER', () => {
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(guardContext('SUPER_ADMIN'))).toBe(true);
    expect(guard.canActivate(guardContext('ADMIN'))).toBe(true);
    // The P5-A1 pinned refusal, flipped here by P5-A2 family 1 as planned
    expect(guard.canActivate(guardContext('ORGANIZATION_MANAGER'))).toBe(true);
    expect(() => guard.canActivate(guardContext('EDITOR'))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(guardContext('VIEWER'))).toThrow(ForbiddenException);
  });

  describe('tenant-view derivation from TenantScope', () => {
    const build = () => {
      const service = { findAll: jest.fn().mockResolvedValue({ items: [], total: 0 }) };
      const controller = new AuditLogController(service as any);
      return { service, controller };
    };

    const scoped = (scope: Partial<TenantScope>) => ({ scope: scope as TenantScope });

    it('unscoped platform SUPER_ADMIN: passes no tenant view — unfiltered listing', async () => {
      const { service, controller } = build();

      await controller.findAll(
        scoped({ platform: true, role: 'SUPER_ADMIN', organizationId: null, storeId: null, allowedStoreIds: [] }),
      );

      expect(service.findAll).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined);
    });

    it('ORGANIZATION_MANAGER: passes the organization-wide view of its own company', async () => {
      const { service, controller } = build();

      await controller.findAll(
        scoped({
          platform: false,
          role: 'ORGANIZATION_MANAGER',
          organizationId: 'org-a',
          storeId: null,
          allowedStoreIds: ['store-a1', 'store-a2'],
        }),
      );

      expect(service.findAll).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        kind: 'organization',
        organizationId: 'org-a',
      });
    });

    it('platform SUPER_ADMIN under a managed organization: organization-wide view, not unfiltered', async () => {
      const { service, controller } = build();

      await controller.findAll(
        scoped({
          platform: true,
          role: 'SUPER_ADMIN',
          organizationId: 'org-a',
          storeId: null,
          allowedStoreIds: ['store-a1', 'store-a2'],
        }),
      );

      expect(service.findAll).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        kind: 'organization',
        organizationId: 'org-a',
      });
    });

    it('store-bound ADMIN: passes the exact-store view', async () => {
      const { service, controller } = build();

      await controller.findAll(
        scoped({
          platform: false,
          role: 'ADMIN',
          organizationId: 'org-a',
          storeId: 'store-a1',
          allowedStoreIds: ['store-a1'],
        }),
      );

      expect(service.findAll).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        kind: 'store',
        organizationId: 'org-a',
        storeId: 'store-a1',
      });
    });

    it('platform SUPER_ADMIN narrowed to one managed store: exact-store view of that store', async () => {
      const { service, controller } = build();

      await controller.findAll(
        scoped({
          platform: true,
          role: 'SUPER_ADMIN',
          organizationId: 'org-a',
          storeId: 'store-a2',
          allowedStoreIds: ['store-a1', 'store-a2'],
        }),
      );

      expect(service.findAll).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        kind: 'store',
        organizationId: 'org-a',
        storeId: 'store-a2',
      });
    });

    it('ORGANIZATION_MANAGER narrowed to an own branch: exact-store view of that branch — a restriction, never an expansion', async () => {
      const { service, controller } = build();

      // The resolver legitimately narrows an OM via X-Managed-Store
      // (tenant-scope.service.ts `wantedStore ?? ownStore?.id`); the narrowed
      // view is a subset of the org-wide view the OM would otherwise get.
      await controller.findAll(
        scoped({
          platform: false,
          role: 'ORGANIZATION_MANAGER',
          organizationId: 'org-a',
          storeId: 'store-a1',
          allowedStoreIds: ['store-a1', 'store-a2'],
        }),
      );

      expect(service.findAll).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        kind: 'store',
        organizationId: 'org-a',
        storeId: 'store-a1',
      });
    });

    it('DECOY: req.user.store is never consulted — the view follows the scope alone', async () => {
      const { service, controller } = build();
      // A stale/foreign store binding on the user object must not leak into
      // the view; only the resolved scope decides.
      const req = {
        ...scoped({
          platform: false,
          role: 'ADMIN',
          organizationId: 'org-a',
          storeId: 'store-a1',
          allowedStoreIds: ['store-a1'],
        }),
        user: { store: { id: 'store-B9', organization: { id: 'org-B' } } },
      };

      await controller.findAll(req);

      expect(service.findAll).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
        kind: 'store',
        organizationId: 'org-a',
        storeId: 'store-a1',
      });
    });

    describe('coherence refusals — nothing outside the approved matrix is granted', () => {
      const refuse = async (req: any) => {
        const { service, controller } = build();
        await expect(controller.findAll(req)).rejects.toThrow(ForbiddenException);
        expect(service.findAll).not.toHaveBeenCalled();
      };

      it('refuses a request with no resolved scope at all', async () => {
        await refuse({ user: { store: { id: 'store-a1', organization: { id: 'org-a' } } } });
      });

      it('refuses ADMIN with an organization but no store — store-level role in an org-shaped scope', async () => {
        await refuse(
          scoped({
            platform: false,
            role: 'ADMIN',
            organizationId: 'org-a',
            storeId: null,
            allowedStoreIds: [],
          }),
        );
      });

      it('refuses ORGANIZATION_MANAGER narrowed to a store outside its allowedStoreIds', async () => {
        await refuse(
          scoped({
            platform: false,
            role: 'ORGANIZATION_MANAGER',
            organizationId: 'org-a',
            storeId: 'store-b1',
            allowedStoreIds: ['store-a1', 'store-a2'],
          }),
        );
      });

      it('refuses a store-shaped scope with no organization — never a platform view by accident', async () => {
        await refuse(
          scoped({
            platform: false,
            role: 'ADMIN',
            organizationId: null,
            storeId: 'store-a1',
            allowedStoreIds: ['store-a1'],
          }),
        );
      });

      it('refuses ADMIN whose storeId is not in its allowedStoreIds', async () => {
        await refuse(
          scoped({
            platform: false,
            role: 'ADMIN',
            organizationId: 'org-a',
            storeId: 'store-a2',
            allowedStoreIds: ['store-a1'],
          }),
        );
      });

      it('refuses a global-shaped scope whose platform flag is false — shape alone never grants', async () => {
        await refuse(
          scoped({
            platform: false,
            role: 'SUPER_ADMIN',
            organizationId: null,
            storeId: null,
            allowedStoreIds: [],
          }),
        );
      });

      it('refuses a platform-flagged non-SUPER_ADMIN global shape — role and flag must agree', async () => {
        await refuse(
          scoped({
            platform: true,
            role: 'ADMIN',
            organizationId: null,
            storeId: null,
            allowedStoreIds: [],
          }),
        );
      });
    });
  });
});
