import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from '../jwt-auth.guard';

const buildGuard = () => {
  // #291: every fixture in this file is a CURRENT session, so the token
  // claims the generation the fixtures carry. The generation boundary itself
  // is proved in jwt-authority-currency.spec.ts.
  const jwtService = { verifyAsync: jest.fn().mockResolvedValue({ sub: 'user-1', gen: 1 }) };
  // `findManagedStore` no longer exists on UsersService (P5-A3 deleted it with
  // the impersonation block). The mock keeps the key so the "never called"
  // assertions below remain meaningful rather than vacuously passing.
  // #294: the guard reads the member's company lifecycle from the stored
  // binding through the users service's entity manager; here that read
  // answers "an active company" so these suites keep testing what they test.
  const memberCompanyRead = {
    execute: jest.fn(async () => [
      { organizationId: 'org-1', archivedAt: null, mergedIntoOrganizationId: null, removedAt: null },
    ]),
  };
  const usersService = { findById: jest.fn(), findManagedStore: jest.fn(), entityManager: () => memberCompanyRead };
  const configService = { get: jest.fn().mockReturnValue('secret') };
  // P0-03: the guard also builds req.scope
  const tenantScopeService = {
    resolve: jest.fn().mockResolvedValue({
      platform: false,
      organizationId: 'org-1',
      storeId: 'store-1',
      allowedStoreIds: ['store-1'],
      role: 'ADMIN',
    }),
  };
  const guard = new JwtAuthGuard(
    jwtService as any,
    usersService as any,
    configService as any,
    tenantScopeService as any,
  );
  return { guard, jwtService, usersService, tenantScopeService };
};

const contextFor = (method: string, url: string) =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ method, url, headers: { authorization: 'Bearer token' } }),
    }),
  }) as any;

describe('JwtAuthGuard billing gate', () => {
  const { guard, usersService } = buildGuard();

  // #156: fixtures carry VALID bindings — the invariant is asserted first
  const org = (billingStatus: string) => ({ id: 'org-1', billingStatus });
  const tenantUser = (role: string, billingStatus: string) => ({
    id: 'user-1',
    email: 'client@example.com',
    authGeneration: 1,
    role: { name: role },
    organization: org(billingStatus),
    store: { id: 'store-1', archivedAt: null, organization: org(billingStatus) },
  });

  it('rejects requests without a token', async () => {
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({ method: 'GET', url: '/api/v1/products', headers: {} }) }),
    } as any;
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it('lets an ACTIVE company write anywhere', async () => {
    usersService.findById.mockResolvedValue(tenantUser('ADMIN', 'ACTIVE'));
    await expect(guard.canActivate(contextFor('POST', '/api/v1/products'))).resolves.toBe(true);
  });

  it('blocks writes while the first payment is pending', async () => {
    usersService.findById.mockResolvedValue(tenantUser('ADMIN', 'PENDING_FIRST_PAYMENT'));
    await expect(guard.canActivate(contextFor('POST', '/api/v1/products'))).rejects.toThrow(ForbiddenException);
  });

  it('blocks writes while SUSPENDED', async () => {
    usersService.findById.mockResolvedValue(tenantUser('ADMIN', 'SUSPENDED'));
    await expect(guard.canActivate(contextFor('DELETE', '/api/v1/categories/1'))).rejects.toThrow(ForbiddenException);
  });

  // #156: the store-less ORGANIZATION_MANAGER no longer bypasses billing —
  // its own organization gates it.
  it('blocks an unpaid ORGANIZATION_MANAGER from writing', async () => {
    usersService.findById.mockResolvedValue({
      id: 'om-1',
      email: 'manager@example.com',
      authGeneration: 1,
      role: { name: 'ORGANIZATION_MANAGER' },
      organization: org('PENDING_FIRST_PAYMENT'),
      store: null,
    });
    await expect(guard.canActivate(contextFor('POST', '/api/v1/products'))).rejects.toThrow(ForbiddenException);
  });

  it('still allows reading (GET) while unpaid', async () => {
    usersService.findById.mockResolvedValue(tenantUser('ADMIN', 'PENDING_FIRST_PAYMENT'));
    await expect(guard.canActivate(contextFor('GET', '/api/v1/products'))).resolves.toBe(true);
  });

  it('still allows paying (billing writes) while unpaid', async () => {
    usersService.findById.mockResolvedValue(tenantUser('ADMIN', 'PENDING_FIRST_PAYMENT'));
    await expect(guard.canActivate(contextFor('POST', '/api/v1/billing/checkout'))).resolves.toBe(true);
  });

  it('never gates the unbound platform owner', async () => {
    usersService.findById.mockResolvedValue({
      id: 'user-1',
      email: 'owner@wegox.com',
      authGeneration: 1,
      role: { name: 'SUPER_ADMIN' },
      organization: null,
      store: null,
    });
    await expect(guard.canActivate(contextFor('POST', '/api/v1/stores'))).resolves.toBe(true);
  });

  // #156: the exemption is by ROLE — a platform owner carrying bindings to an
  // unpaid company must never be write-blocked either.
  it('never gates a SUPER_ADMIN carrying bindings to an unpaid company', async () => {
    usersService.findById.mockResolvedValue({
      id: 'user-1',
      email: 'owner@wegox.com',
      authGeneration: 1,
      role: { name: 'SUPER_ADMIN' },
      organization: org('SUSPENDED'),
      store: { id: 'store-1', archivedAt: null, organization: org('SUSPENDED') },
    });
    await expect(guard.canActivate(contextFor('POST', '/api/v1/stores'))).resolves.toBe(true);
  });
});

// #156: the per-request fail-closed layer — corrupt persisted bindings are
// refused with a neutral 403 even while an access token is still live.
describe('JwtAuthGuard binding assertion (#156)', () => {
  const { guard, usersService } = buildGuard();
  const org = { id: 'org-1', billingStatus: 'ACTIVE' };
  const activeStore = { id: 'store-1', archivedAt: null, organization: org };

  const corruptCases: Array<[string, any]> = [
    ['M1 store-role with no store', { role: { name: 'EDITOR' }, organization: org, store: null }],
    ['M2 tenant role with no organization', { role: { name: 'EDITOR' }, organization: null, store: null }],
    [
      'M3 store of a different organization',
      { role: { name: 'EDITOR' }, organization: org, store: { ...activeStore, organization: { id: 'org-2' } } },
    ],
    [
      'M4 store with no organization',
      { role: { name: 'EDITOR' }, organization: org, store: { ...activeStore, organization: null } },
    ],
    [
      'M5 ORGANIZATION_MANAGER with a store',
      { role: { name: 'ORGANIZATION_MANAGER' }, organization: org, store: activeStore },
    ],
    [
      'M6 bound to an archived store',
      { role: { name: 'EDITOR' }, organization: org, store: { ...activeStore, archivedAt: new Date() } },
    ],
  ];

  it.each(corruptCases)('%s is refused with 403', async (_label, bindings) => {
    usersService.findById.mockResolvedValue({ id: 'user-1', email: 'x@x.com', authGeneration: 1, ...bindings });
    await expect(guard.canActivate(contextFor('GET', '/api/v1/products'))).rejects.toThrow(/not configured correctly/);
  });

  const validCases: Array<[string, any]> = [
    ['V1 unbound SUPER_ADMIN', { role: { name: 'SUPER_ADMIN' }, organization: null, store: null }],
    ['V2a SUPER_ADMIN with organization only', { role: { name: 'SUPER_ADMIN' }, organization: org, store: null }],
    ['V2b SUPER_ADMIN with a store', { role: { name: 'SUPER_ADMIN' }, organization: null, store: activeStore }],
    ['V3 canonical ORGANIZATION_MANAGER', { role: { name: 'ORGANIZATION_MANAGER' }, organization: org, store: null }],
    ['V4 store-role with matching bindings', { role: { name: 'EDITOR' }, organization: org, store: activeStore }],
  ];

  it.each(validCases)('%s passes', async (_label, bindings) => {
    usersService.findById.mockResolvedValue({ id: 'user-1', email: 'x@x.com', authGeneration: 1, ...bindings });
    await expect(guard.canActivate(contextFor('GET', '/api/v1/products'))).resolves.toBe(true);
  });
});

/**
 * P5-A3 RETIRED the legacy request-user impersonation.
 *
 * The guard used to rewrite `request.user` with a prototype view carrying the
 * managed store, so controllers reading `user.store` would see the company's
 * branch. Every consumer has since moved to the resolved `TenantScope`, so the
 * rewrite is gone: `request.user` is always the authenticated person, and
 * "manage company" lives entirely in `request.scope`.
 *
 * These cases previously asserted the impersonation; they now assert its
 * absence, and that the managed headers still reach scope resolution.
 */
describe('JwtAuthGuard: legacy impersonation is retired (P5-A3)', () => {
  const { guard, usersService, tenantScopeService } = buildGuard();

  beforeEach(() => {
    usersService.findManagedStore.mockClear();
    tenantScopeService.resolve.mockClear();
  });

  const contextWithHeader = (managed?: string) => {
    const request: any = {
      method: 'GET',
      url: '/api/v1/products',
      headers: { authorization: 'Bearer token', ...(managed ? { 'x-managed-store': managed } : {}) },
    };
    return { request, ctx: { switchToHttp: () => ({ getRequest: () => request }) } as any };
  };

  it('NEVER rewrites request.user for a managed store', async () => {
    const entity = { id: 'user-1', authGeneration: 1, role: { name: 'SUPER_ADMIN' }, store: null };
    usersService.findById.mockResolvedValue(entity);
    const { request, ctx } = contextWithHeader('store-9');
    await guard.canActivate(ctx);

    expect(request.user).toBe(entity); // the same object, not a prototype view
    expect(request.user.store).toBeNull(); // no store was grafted on
    expect(entity.store).toBeNull(); // and the tracked entity is untouched
  });

  it('never loads a managed store through the retired path', async () => {
    usersService.findById.mockResolvedValue({
      id: 'user-1',
      authGeneration: 1,
      role: { name: 'SUPER_ADMIN' },
      store: null,
    });
    const { ctx } = contextWithHeader('store-9');
    await guard.canActivate(ctx);
    expect(usersService.findManagedStore).not.toHaveBeenCalled();
  });

  it('the managed headers still reach TenantScope resolution — as INPUT, not authority', async () => {
    usersService.findById.mockResolvedValue({
      id: 'user-1',
      authGeneration: 1,
      role: { name: 'SUPER_ADMIN' },
      store: null,
    });
    const { request, ctx } = contextWithHeader('store-9');
    await guard.canActivate(ctx);
    expect(tenantScopeService.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      expect.objectContaining({ 'x-managed-store': 'store-9' }),
    );
    expect(request.scope).toBeDefined();
  });

  it('a store-bound user keeps its own permanent binding, header or not', async () => {
    const ownStore = { id: 'store-1', archivedAt: null, organization: { id: 'org-1', billingStatus: 'ACTIVE' } };
    usersService.findById.mockResolvedValue({
      id: 'user-2',
      authGeneration: 1,
      role: { name: 'SUPER_ADMIN' },
      store: ownStore,
    });
    const { request, ctx } = contextWithHeader('store-9');
    await guard.canActivate(ctx);
    expect(request.user.store.id).toBe('store-1');
    expect(usersService.findManagedStore).not.toHaveBeenCalled();
  });

  it('ignores the header for non-superadmin roles', async () => {
    // #156: the tenant user carries valid bindings — and still cannot use it
    const org = { id: 'org-1', billingStatus: 'ACTIVE' };
    usersService.findById.mockResolvedValue({
      id: 'user-3',
      authGeneration: 1,
      role: { name: 'ADMIN' },
      organization: org,
      store: { id: 'store-1', archivedAt: null, organization: org },
    });
    tenantScopeService.resolve.mockResolvedValue({
      platform: false,
      role: 'ADMIN',
      organizationId: 'org-1',
      storeId: 'store-1',
      allowedStoreIds: ['store-1'],
    });
    const { request, ctx } = contextWithHeader('store-9');
    await guard.canActivate(ctx);
    expect(request.user.store.id).toBe('store-1'); // own store, not the header's
    expect(usersService.findManagedStore).not.toHaveBeenCalled();
  });
});

describe('JwtAuthGuard billing gate: Plan Gratis is never read-only for payment', () => {
  const { guard, usersService } = buildGuard();
  const company = (plan: string, billingStatus: string) => ({ id: 'org-1', plan, billingStatus });
  const member = (role: string, plan: string, billingStatus: string) => ({
    id: 'user-1',
    email: 'client@example.com',
    authGeneration: 1,
    role: { name: role },
    organization: company(plan, billingStatus),
    store: { id: 'store-1', archivedAt: null, organization: company(plan, billingStatus) },
  });

  for (const stored of ['PENDING_FIRST_PAYMENT', 'SUSPENDED']) {
    it(`a Plan Gratis company writes even if its stored status is ${stored}`, async () => {
      usersService.findById.mockResolvedValue(member('ADMIN', 'GRATIS', stored));
      await expect(guard.canActivate(contextFor('POST', '/api/v1/products'))).resolves.toBe(true);
    });

    it(`the SAME stored status still blocks a Básico company (${stored})`, async () => {
      usersService.findById.mockResolvedValue(member('ADMIN', 'BASICO', stored));
      await expect(guard.canActivate(contextFor('POST', '/api/v1/products'))).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  }
});
