import { TenantScope, isOrganizationAdministrator, hasOrganizationWideAuthority } from '../../tenancy/tenant-scope';

/**
 * The Phase 4 destructive-authority predicate, exhaustively (see the doc on
 * `isOrganizationAdministrator`): archive/restore/delete of shared catalogue
 * data belongs to the company administrator, decided by ROLE AND SCOPE
 * together — a role list alone cannot express "ADMIN but only company-wide",
 * and a scope test alone would let any future store-less role inherit the
 * power to delete another branch's work.
 */
describe('isOrganizationAdministrator (Phase 4)', () => {
  const scope = (over: Partial<TenantScope>): TenantScope => ({
    platform: false,
    organizationId: 'org-1',
    storeId: null,
    allowedStoreIds: [],
    role: 'ORGANIZATION_MANAGER',
    ...over,
  });

  it.each<[string, TenantScope | undefined, boolean]>([
    ['ORGANIZATION_MANAGER of its own company', scope({}), true],
    ['SUPER_ADMIN with X-Managed-Organization', scope({ platform: true, role: 'SUPER_ADMIN' }), true],
    [
      'SUPER_ADMIN unscoped (no company named)',
      scope({ platform: true, role: 'SUPER_ADMIN', organizationId: null }),
      false,
    ],
    ['SUPER_ADMIN narrowed to one store', scope({ platform: true, role: 'SUPER_ADMIN', storeId: 's1' }), false],
    ['store-bound ADMIN', scope({ role: 'ADMIN', storeId: 's1', allowedStoreIds: ['s1'] }), false],
    ['store-bound STORE_ADMIN', scope({ role: 'STORE_ADMIN', storeId: 's1', allowedStoreIds: ['s1'] }), false],
    ['EDITOR', scope({ role: 'EDITOR', storeId: 's1', allowedStoreIds: ['s1'] }), false],
    ['no scope at all (public / api-key route)', undefined, false],
    ['ORGANIZATION_MANAGER narrowed to one branch', scope({ storeId: 's1', allowedStoreIds: ['s1', 's2'] }), false],
    // A non-platform actor may not claim SUPER_ADMIN by role string alone.
    ['role SUPER_ADMIN without platform: true', scope({ role: 'SUPER_ADMIN' }), false],
    ['empty organizationId string', scope({ organizationId: '' as unknown as string }), false],
  ])('%s -> %s', (_who, s, expected) => {
    expect(isOrganizationAdministrator(s)).toBe(expected);
  });

  it('fails closed if storeId were ever undefined instead of null', () => {
    const drifted = scope({});
    delete (drifted as Partial<TenantScope>).storeId;
    expect(isOrganizationAdministrator(drifted)).toBe(false);
  });

  it('is strictly narrower than hasOrganizationWideAuthority, never wider', () => {
    // Every scope the new predicate grants, the old one grants too — the
    // reverse is deliberately false (a store-less EDITOR-shaped scope, say).
    const granted = [scope({}), scope({ platform: true, role: 'SUPER_ADMIN' })];
    for (const s of granted) {
      expect(isOrganizationAdministrator(s)).toBe(true);
      expect(hasOrganizationWideAuthority(s)).toBe(true);
    }
    const widerOnly = scope({ role: 'EDITOR' });
    expect(hasOrganizationWideAuthority(widerOnly)).toBe(true);
    expect(isOrganizationAdministrator(widerOnly)).toBe(false);
  });
});
