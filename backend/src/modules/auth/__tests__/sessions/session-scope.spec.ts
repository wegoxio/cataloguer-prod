import { AuthController } from '../../auth.controller';

/**
 * P5-A2 family 2 companion: `GET /auth/me` carries the resolved TenantScope so
 * the panel derives its capabilities from server truth instead of guessing
 * from the user object.
 *
 * Two properties are pinned here:
 *  1. the payload is a WHITELIST — a future TenantScope field must not appear;
 *  2. `scope` is a SEPARATE key, never merged into the session user.
 */
describe('GET /auth/me session scope (P5-A2 family 2 companion)', () => {
  // authService, usersService, configService — `me()` uses none of them.
  const controller = new AuthController({} as any, {} as any, { get: jest.fn() } as any);

  const user = {
    id: 'u1',
    email: 'manager@client.example',
    firstName: 'Ada',
    lastName: 'Lovelace',
    company: 'Alpha',
    role: { name: 'ORGANIZATION_MANAGER' },
    mfaEnabledAt: null,
    store: null,
  };

  const scopes = {
    platform: { platform: true, role: 'SUPER_ADMIN', organizationId: null, storeId: null, allowedStoreIds: [] },
    managedOrg: {
      platform: true,
      role: 'SUPER_ADMIN',
      organizationId: 'org-1',
      storeId: null,
      allowedStoreIds: ['store-1', 'store-2'],
    },
    orgManager: {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId: 'org-1',
      storeId: null,
      allowedStoreIds: ['store-1', 'store-2'],
    },
    narrowedManager: {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId: 'org-1',
      storeId: 'store-1',
      allowedStoreIds: ['store-1', 'store-2'],
    },
    storeAdmin: {
      platform: false,
      role: 'ADMIN',
      organizationId: 'org-1',
      storeId: 'store-1',
      allowedStoreIds: ['store-1'],
    },
  };

  const SCOPE_KEYS = ['platform', 'role', 'organizationId', 'storeId', 'allowedStoreIds'];

  it.each(Object.entries(scopes))('returns exactly the five whitelisted fields for %s', async (_name, scope) => {
    const res: any = await controller.me({ user, scope });
    expect(Object.keys(res.data.scope).sort()).toEqual([...SCOPE_KEYS].sort());
    expect(res.data.scope).toEqual({
      platform: scope.platform,
      role: scope.role,
      organizationId: scope.organizationId,
      storeId: scope.storeId,
      allowedStoreIds: scope.allowedStoreIds,
    });
  });

  it('does NOT echo a field the whitelist does not name', async () => {
    const decoy = {
      ...scopes.orgManager,
      impersonatedBy: 'root@wegox.io',
      internalToken: 'must-never-appear',
    };

    const res: any = await controller.me({ user, scope: decoy });

    expect(Object.keys(res.data.scope).sort()).toEqual([...SCOPE_KEYS].sort());
    expect(JSON.stringify(res.data.scope)).not.toContain('must-never-appear');
    expect(res.data.scope).not.toHaveProperty('impersonatedBy');
  });

  it('copies allowedStoreIds rather than aliasing the resolved scope', async () => {
    const live = { ...scopes.orgManager, allowedStoreIds: ['store-1'] };
    const res: any = await controller.me({ user, scope: live });

    live.allowedStoreIds.push('store-9');

    expect(res.data.scope.allowedStoreIds).toEqual(['store-1']);
  });

  it('returns scope: null when no scope was resolved — never a partial object', async () => {
    const res: any = await controller.me({ user });
    expect(res.data.scope).toBeNull();
  });

  it('keeps scope as a separate key and leaves the session user unchanged', async () => {
    const res: any = await controller.me({ user, scope: scopes.storeAdmin });

    expect(res.data).toMatchObject({
      id: 'u1',
      email: 'manager@client.example',
      firstName: 'Ada',
      lastName: 'Lovelace',
      company: 'Alpha',
      role: 'ORGANIZATION_MANAGER',
      mfaEnabled: false,
      store: null,
    });
    // the user half must not have absorbed any scope field
    for (const key of SCOPE_KEYS) {
      if (key === 'role') continue; // the user carries its own role name
      expect(res.data).not.toHaveProperty(key);
    }
  });

  it('never exposes credential or token material from the user record', async () => {
    const res: any = await controller.me({
      user: { ...user, passwordHash: 'argon2-hash', mfaSecret: 'totp-secret' },
      scope: scopes.orgManager,
    });

    const flat = JSON.stringify(res.data);
    expect(flat).not.toContain('argon2-hash');
    expect(flat).not.toContain('totp-secret');
  });
});
