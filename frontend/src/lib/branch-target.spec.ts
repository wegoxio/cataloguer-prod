import { describe, it, expect } from 'vitest';
import { resolveBranchTarget } from './branch-target';

/**
 * #295 G1 acceptance — the branch a new invoice or manual sale is for. The
 * first case is the exact production failure: a company-wide actor with
 * "All branches" selected and exactly one live branch got no branch at all.
 */
const company = (allowed: string[]) => ({ platform: false, role: 'ORGANIZATION_MANAGER', organizationId: 'org-1', storeId: null, allowedStoreIds: allowed });
const managedOwner = (allowed: string[]) => ({ platform: true, role: 'SUPER_ADMIN', organizationId: 'org-1', storeId: null, allowedStoreIds: allowed });
const narrowed = { platform: true, role: 'SUPER_ADMIN', organizationId: 'org-1', storeId: 'b-1', allowedStoreIds: ['b-1', 'b-2'] };
const live = (id: string, name = id) => ({ id, name, archivedAt: null, removedAt: null });

describe('resolveBranchTarget', () => {
  it('company scope, "All branches", exactly one live branch → that branch, no picker (the acceptance failure)', () => {
    for (const scope of [company(['b-1']), managedOwner(['b-1'])]) {
      const target = resolveBranchTarget({ scope, stores: [live('b-1', 'Centro')], loaded: true, selected: '' });
      expect(target).toMatchObject({ state: 'single', storeId: 'b-1', showPicker: false, resolvedName: 'Centro', invalidated: false });
    }
  });

  it('a branch-bound actor uses its locked branch whatever the list holds', () => {
    const target = resolveBranchTarget({ scope: narrowed, stores: [live('b-1'), live('b-2')], loaded: true, selected: 'b-2' });
    expect(target).toMatchObject({ state: 'locked', storeId: 'b-1', showPicker: false });
    const legacy = resolveBranchTarget({ scope: { platform: false, role: 'ADMIN', organizationId: 'org-1', storeId: null, allowedStoreIds: ['b-9'] }, legacyStoreId: 'b-9', stores: [], loaded: false });
    expect(legacy).toMatchObject({ state: 'locked', storeId: 'b-9' });
  });

  it('several eligible branches require an explicit choice; a valid choice is kept', () => {
    const stores = [live('b-1'), live('b-2')];
    expect(resolveBranchTarget({ scope: company(['b-1', 'b-2']), stores, loaded: true })).toMatchObject({ state: 'choose', storeId: null, showPicker: true });
    expect(resolveBranchTarget({ scope: company(['b-1', 'b-2']), stores, loaded: true, selected: 'b-2' })).toMatchObject({ state: 'choose', storeId: 'b-2', showPicker: true, invalidated: false });
  });

  it('zero eligible branches → a blocked state with nothing to submit', () => {
    expect(resolveBranchTarget({ scope: company([]), stores: [], loaded: true })).toMatchObject({ state: 'none', storeId: null, showPicker: false });
  });

  it('archived, removed and out-of-scope branches are never eligible, so one live branch among them is still "single"', () => {
    const stores = [
      { id: 'b-arch', name: 'A', archivedAt: '2026-09-01T00:00:00Z', removedAt: null },
      { id: 'b-rem', name: 'R', archivedAt: null, removedAt: '2026-09-01T00:00:00Z' },
      live('b-foreign'),
      live('b-1', 'Centro'),
    ];
    const target = resolveBranchTarget({ scope: company(['b-arch', 'b-rem', 'b-1']), stores, loaded: true });
    expect(target).toMatchObject({ state: 'single', storeId: 'b-1' });
    expect(target.options.map((o) => o.id)).toEqual(['b-1']);
    expect(resolveBranchTarget({ scope: company(['b-arch']), stores: [stores[0]], loaded: true })).toMatchObject({ state: 'none', storeId: null });
  });

  it('a valid order-prefilled branch is preserved, with one branch or several', () => {
    expect(resolveBranchTarget({ scope: company(['b-1']), stores: [live('b-1')], loaded: true, selected: 'b-1' })).toMatchObject({ state: 'single', storeId: 'b-1', invalidated: false });
    expect(resolveBranchTarget({ scope: company(['b-1', 'b-2']), stores: [live('b-1'), live('b-2')], loaded: true, selected: 'b-1' })).toMatchObject({ storeId: 'b-1' });
  });

  it('a selection invalidated by a reload is dropped and blocks submission — never silently replaced, not even by the only remaining branch', () => {
    const before = resolveBranchTarget({ scope: company(['b-1', 'b-2']), stores: [live('b-1'), live('b-2')], loaded: true, selected: 'b-2' });
    expect(before.storeId).toBe('b-2');
    const after = resolveBranchTarget({
      scope: company(['b-1']),
      stores: [live('b-1'), { id: 'b-2', name: 'B', archivedAt: '2026-09-15T00:00:00Z', removedAt: null }],
      loaded: true,
      selected: 'b-2',
    });
    expect(after).toMatchObject({ state: 'choose', storeId: null, showPicker: true, invalidated: true });
    expect(after.options.map((o) => o.id)).toEqual(['b-1']);
    expect(resolveBranchTarget({ scope: company([]), stores: [], loaded: true, selected: 'b-2' })).toMatchObject({ state: 'none', storeId: null, invalidated: true });
  });

  it('while the branch list has not loaded, nothing may be submitted', () => {
    expect(resolveBranchTarget({ scope: company(['b-1']), stores: [], loaded: false })).toMatchObject({ state: 'loading', storeId: null, showPicker: false });
  });
});
