import {
  CANONICAL_ROLES,
  isOrganizationLevel,
  roleBindingError,
  STORE_ROLES,
  userBindingError,
} from '../../authorization/role-levels';

describe('role bindings (P0-04)', () => {
  it('defines the five persisted roles without spreading the legacy STORE_ADMIN alias', () => {
    expect(CANONICAL_ROLES).toEqual(['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN', 'EDITOR', 'VIEWER']);
    expect(CANONICAL_ROLES).not.toContain('STORE_ADMIN');
  });

  describe('only SUPER_ADMIN may be unbound', () => {
    it('accepts a SUPER_ADMIN with no organization and no store', () => {
      expect(roleBindingError('SUPER_ADMIN', {})).toBeNull();
    });

    it.each(['ORGANIZATION_MANAGER', ...STORE_ROLES])('refuses %s without an organization', (role) => {
      // This is the hole the issue describes: no organization used to read as
      // "global" everywhere, so a tenant user behaved like the platform owner
      expect(roleBindingError(role, { storeId: 'store-1' })).toMatch(/must belong to an organization/);
    });
  });

  describe('branch-level roles must name their branch', () => {
    it.each(STORE_ROLES)('refuses %s without a store', (role) => {
      expect(roleBindingError(role, { organizationId: 'org-1' })).toMatch(/must belong to a store/);
    });

    it.each(STORE_ROLES)('accepts %s with both', (role) => {
      expect(roleBindingError(role, { organizationId: 'org-1', storeId: 'store-1' })).toBeNull();
    });
  });

  describe('ORGANIZATION_MANAGER spans the company', () => {
    it('is valid with an organization and no store', () => {
      expect(roleBindingError('ORGANIZATION_MANAGER', { organizationId: 'org-1' })).toBeNull();
    });

    it('is refused when pinned to a single store', () => {
      // Otherwise it is ambiguous which branch its actions belong to
      expect(roleBindingError('ORGANIZATION_MANAGER', { organizationId: 'org-1', storeId: 'store-1' })).toMatch(
        /cannot be pinned to a store/,
      );
    });

    it('is the only company-spanning role', () => {
      expect(isOrganizationLevel('ORGANIZATION_MANAGER')).toBe(true);
      expect(isOrganizationLevel('STORE_ADMIN')).toBe(false);
      expect(isOrganizationLevel('ADMIN')).toBe(false);
    });
  });

  describe('temporary ADMIN compatibility', () => {
    it('keeps ADMIN as a branch-level role so existing accounts stay valid', () => {
      expect(STORE_ROLES).toContain('ADMIN');
      expect(roleBindingError('ADMIN', { organizationId: 'org-1', storeId: 'store-1' })).toBeNull();
      expect(roleBindingError('ADMIN', { organizationId: 'org-1' })).toMatch(/must belong to a store/);
    });
  });

  // #156: presence is not enough — the store must belong to the same company
  describe('organization/store consistency', () => {
    it.each(STORE_ROLES)('refuses %s bound to a store of a different organization', (role) => {
      expect(
        roleBindingError(role, { organizationId: 'org-1', storeId: 'store-1', storeOrganizationId: 'org-2' }),
      ).toMatch(/different organization/);
    });

    it.each(STORE_ROLES)('refuses %s bound to a store that has no organization', (role) => {
      expect(
        roleBindingError(role, { organizationId: 'org-1', storeId: 'store-1', storeOrganizationId: null }),
      ).toMatch(/no organization/);
    });

    it('accepts a matching pair', () => {
      expect(
        roleBindingError('EDITOR', { organizationId: 'org-1', storeId: 'store-1', storeOrganizationId: 'org-1' }),
      ).toBeNull();
    });

    it('skips the rule when the store organization was not looked up (undefined)', () => {
      // Legacy callers that only know presence must not start failing
      expect(roleBindingError('EDITOR', { organizationId: 'org-1', storeId: 'store-1' })).toBeNull();
    });
  });

  describe('unknown roles fail closed', () => {
    it('refuses a role name outside the model even with full bindings', () => {
      expect(roleBindingError('MYSTERY', { organizationId: 'org-1', storeId: 'store-1' })).toMatch(/Unknown role/);
    });
  });
});

// #156: the persisted-user view of the same rules — one composition, no
// restatement, plus the archived-store rule the pure binding cannot see.
describe('userBindingError (#156)', () => {
  const org = { id: 'org-1' };
  const store = (overrides: Record<string, unknown> = {}) => ({
    id: 'store-1',
    archivedAt: null,
    organization: org,
    ...overrides,
  });

  describe('corrupt persisted states are rejected', () => {
    it('M1: store-role with no store', () => {
      expect(userBindingError({ role: { name: 'EDITOR' }, organization: org, store: null })).toMatch(
        /must belong to a store/,
      );
    });

    it('M2: tenant role with no organization at all', () => {
      expect(userBindingError({ role: { name: 'EDITOR' }, organization: null, store: null })).toMatch(
        /must belong to an organization/,
      );
    });

    it('M3: store belonging to a different organization', () => {
      expect(
        userBindingError({
          role: { name: 'EDITOR' },
          organization: org,
          store: store({ organization: { id: 'org-2' } }),
        }),
      ).toMatch(/different organization/);
    });

    it('M4: store with no organization of its own', () => {
      expect(
        userBindingError({ role: { name: 'EDITOR' }, organization: org, store: store({ organization: null }) }),
      ).toMatch(/no organization/);
    });

    it('M5: ORGANIZATION_MANAGER pinned to a store', () => {
      expect(userBindingError({ role: { name: 'ORGANIZATION_MANAGER' }, organization: org, store: store() })).toMatch(
        /cannot be pinned/,
      );
    });

    it('M6: binding to an archived store — for every role, the owner included', () => {
      const archived = store({ archivedAt: new Date() });
      expect(userBindingError({ role: { name: 'EDITOR' }, organization: org, store: archived })).toMatch(/archived/);
      expect(userBindingError({ role: { name: 'SUPER_ADMIN' }, organization: null, store: archived })).toMatch(
        /archived/,
      );
    });

    it('a user with no role at all', () => {
      expect(userBindingError({ role: null, organization: org, store: store() })).toMatch(/no role/);
    });

    it('an unknown persisted role name', () => {
      expect(userBindingError({ role: { name: 'LEGACY_ROLE' }, organization: org, store: store() })).toMatch(
        /Unknown role/,
      );
    });
  });

  describe('valid persisted states pass', () => {
    it('V1: unbound SUPER_ADMIN', () => {
      expect(userBindingError({ role: { name: 'SUPER_ADMIN' }, organization: null, store: null })).toBeNull();
    });

    it('V2: SUPER_ADMIN carrying bindings (#194 permits them, none validated)', () => {
      expect(userBindingError({ role: { name: 'SUPER_ADMIN' }, organization: org, store: store() })).toBeNull();
      expect(
        userBindingError({
          role: { name: 'SUPER_ADMIN' },
          organization: { id: 'org-other' },
          store: store(),
        }),
      ).toBeNull();
    });

    it('V3: canonical ORGANIZATION_MANAGER — organization, no store', () => {
      expect(userBindingError({ role: { name: 'ORGANIZATION_MANAGER' }, organization: org, store: null })).toBeNull();
    });

    it('V4: store-role with matching organization and active store', () => {
      expect(userBindingError({ role: { name: 'EDITOR' }, organization: org, store: store() })).toBeNull();
    });
  });

  describe('asking about a DIFFERENT role than the persisted one', () => {
    const orgOnlyUser = { role: { name: 'ORGANIZATION_MANAGER' }, organization: org, store: null };
    const boundUser = { role: { name: 'VIEWER' }, organization: org, store: store() };

    it('an organization-only user cannot become a store role', () => {
      expect(userBindingError(orgOnlyUser, 'EDITOR')).toMatch(/must belong to a store/);
    });

    it('a store-bound user cannot become ORGANIZATION_MANAGER', () => {
      expect(userBindingError(boundUser, 'ORGANIZATION_MANAGER')).toMatch(/cannot be pinned/);
    });

    it('a valid store-role to store-role transition passes', () => {
      expect(userBindingError(boundUser, 'EDITOR')).toBeNull();
    });
  });
});
