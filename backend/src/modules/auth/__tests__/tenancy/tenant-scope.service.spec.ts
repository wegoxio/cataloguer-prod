import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TenantScopeService } from '../../tenancy/tenant-scope.service';
import { scopeAllowsStore } from '../../tenancy/tenant-scope';

/**
 * Two organizations, so "belongs to another company" is a real case rather
 * than a hypothetical: ACME owns store-a1 and store-a2, RIVAL owns store-b1.
 */
const STORES: Record<string, any> = {
  'store-a1': { id: 'store-a1', organization: { id: 'org-acme' } },
  'store-a2': { id: 'store-a2', organization: { id: 'org-acme' } },
  'store-b1': { id: 'store-b1', organization: { id: 'org-rival' } },
};

describe('TenantScopeService', () => {
  let service: TenantScopeService;

  beforeEach(() => {
    // #294: entering a company by header now loads the organization row (a
    // removed company is filtered out, so it reads as not found) and reads the
    // branch's stored company column. Every company named by these fixtures is
    // live, so both reads answer from the same STORES map.
    const entityManager = {
      findOne: jest.fn(async (_entity: unknown, where: any) => ({ id: where.id })),
      execute: jest.fn(async (sql: string, params: unknown[]) =>
        String(sql).includes('from organizations')
          ? [{ live: 1 }]
          : [{ organization_id: STORES[params[0] as string]?.organization?.id ?? null }],
      ),
    };
    const repo: any = {
      findOne: jest.fn(async (where: any) => STORES[where.id] ?? null),
      find: jest.fn(async (where: any) =>
        Object.values(STORES).filter((s) => s.organization.id === where.organization),
      ),
      getEntityManager: () => entityManager,
    };
    service = new TenantScopeService(repo);
  });

  // #156: tenant users carry their own organization binding — that is what
  // scope resolution reads; the store is only their branch pin.
  const user = (role: string, storeId?: string, organizationId?: string) => ({
    id: 'u1',
    role: { name: role },
    store: storeId ? STORES[storeId] : null,
    organization: organizationId ? { id: organizationId } : null,
  });

  describe('SUPER_ADMIN (platform)', () => {
    it('is unrestricted with no headers', async () => {
      const scope = await service.resolve(user('SUPER_ADMIN'));

      expect(scope).toMatchObject({ platform: true, organizationId: null, storeId: null, allowedStoreIds: [] });
      expect(scopeAllowsStore(scope, 'store-b1')).toBe(true);
    });

    it('remains platform when carrying only an organization binding (no store)', async () => {
      // #194 permits the binding; isPlatform depends on the store alone
      const scope = await service.resolve(user('SUPER_ADMIN', undefined, 'org-acme'));

      expect(scope.platform).toBe(true);
      expect(scopeAllowsStore(scope, 'store-b1')).toBe(true);
    });

    it('narrows to one company when managing it', async () => {
      const scope = await service.resolve(user('SUPER_ADMIN'), { 'x-managed-organization': 'org-acme' });

      expect(scope.organizationId).toBe('org-acme');
      expect(scope.allowedStoreIds.sort()).toEqual(['store-a1', 'store-a2']);
      // Narrowed on purpose: the rival's store is no longer in reach
      expect(scopeAllowsStore(scope, 'store-b1')).toBe(false);
    });

    it('derives the company from the store when only a store is named', async () => {
      const scope = await service.resolve(user('SUPER_ADMIN'), { 'x-managed-store': 'store-b1' });

      expect(scope.organizationId).toBe('org-rival');
      expect(scope.storeId).toBe('store-b1');
    });

    it('refuses headers that contradict each other', async () => {
      await expect(
        service.resolve(user('SUPER_ADMIN'), {
          'x-managed-organization': 'org-acme',
          'x-managed-store': 'store-b1',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('404s on a store that does not exist', async () => {
      await expect(service.resolve(user('SUPER_ADMIN'), { 'x-managed-store': 'store-ghost' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('SUPER_ADMIN carrying a store (permitted binding)', () => {
    it('is store-scoped, organization derived FROM the store — exactly as before #156', async () => {
      const scope = await service.resolve(user('SUPER_ADMIN', 'store-a1'));

      expect(scope).toMatchObject({
        platform: false,
        organizationId: 'org-acme',
        storeId: 'store-a1',
        allowedStoreIds: ['store-a1'],
      });
    });

    it('its own organization binding plays no part in the derivation', async () => {
      // Divergent user.organization must NOT override the store's company
      const scope = await service.resolve(user('SUPER_ADMIN', 'store-a1', 'org-rival'));

      expect(scope.organizationId).toBe('org-acme');
      expect(scope.allowedStoreIds).toEqual(['store-a1']);
      expect(scopeAllowsStore(scope, 'store-b1')).toBe(false);
    });
  });

  describe('ORGANIZATION_MANAGER (canonical: organization, no store)', () => {
    it('reaches every branch of its own company', async () => {
      const scope = await service.resolve(user('ORGANIZATION_MANAGER', undefined, 'org-acme'));

      expect(scope.platform).toBe(false);
      expect(scope.organizationId).toBe('org-acme');
      expect(scope.allowedStoreIds.sort()).toEqual(['store-a1', 'store-a2']);
    });

    it('may narrow to a branch of its company', async () => {
      const scope = await service.resolve(user('ORGANIZATION_MANAGER', undefined, 'org-acme'), {
        'x-managed-store': 'store-a2',
      });

      expect(scope.storeId).toBe('store-a2');
    });

    it('is refused a branch of another company', async () => {
      await expect(
        service.resolve(user('ORGANIZATION_MANAGER', undefined, 'org-acme'), { 'x-managed-store': 'store-b1' }),
      ).rejects.toThrow('That store belongs to another organization');
    });
  });

  // #156: ADMIN is a STORE-LEVEL role — the binding rules pin it to a branch,
  // and scope resolution now agrees instead of handing it every sibling.
  describe.each(['STORE_ADMIN', 'ADMIN', 'EDITOR', 'VIEWER'])('%s (branch level)', (role) => {
    it('is pinned to its own branch', async () => {
      const scope = await service.resolve(user(role, 'store-a1', 'org-acme'));

      expect(scope).toMatchObject({
        platform: false,
        organizationId: 'org-acme',
        storeId: 'store-a1',
        allowedStoreIds: ['store-a1'],
      });
    });

    it('cannot reach a sibling branch of the same company', async () => {
      await expect(
        service.resolve(user(role, 'store-a1', 'org-acme'), { 'x-managed-store': 'store-a2' }),
      ).rejects.toThrow('You can only act on your own store');
    });

    it('a sibling is out of reach through scopeAllowsStore too', async () => {
      const scope = await service.resolve(user(role, 'store-a1', 'org-acme'));

      expect(scopeAllowsStore(scope, 'store-a2')).toBe(false);
      expect(scopeAllowsStore(scope, 'store-b1')).toBe(false);
    });

    it('cannot reach another company', async () => {
      await expect(
        service.resolve(user(role, 'store-a1', 'org-acme'), { 'x-managed-store': 'store-b1' }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('its organization binding does NOT widen it beyond its store (#156)', async () => {
      // The organization is present (it must be, per the invariant) — and the
      // allowed set is still exactly the own branch.
      const scope = await service.resolve(user(role, 'store-a1', 'org-acme'));

      expect(scope.allowedStoreIds).toEqual(['store-a1']);
    });
  });

  describe('a tenant cannot nominate its own tenancy', () => {
    it('ignores X-Managed-Organization from a tenant user', async () => {
      const scope = await service.resolve(user('ADMIN', 'store-a1', 'org-acme'), {
        'x-managed-organization': 'org-rival',
      });

      // Organization comes from the user's own bindings, never from the header
      expect(scope.organizationId).toBe('org-acme');
    });
  });
});
