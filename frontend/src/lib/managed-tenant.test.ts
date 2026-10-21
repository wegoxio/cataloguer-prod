import { beforeEach, describe, expect, it } from 'vitest';
import {
  enterManagedTenant,
  exitManagedTenant,
  getManagedTenant,
  narrowToStore,
  selectedStoreId,
  tenantHeaders,
} from './managed-tenant';

/**
 * The branch selector, tested as the two rules it actually rests on.
 *
 * The deployed defect these cover: a store-less ORGANIZATION_MANAGER could open
 * the selector, pick a branch, and nothing happened — the control snapped back
 * to "Todas las sucursales". `narrowToStore` returned silently because only the
 * platform owner's "enter company" flow ever seeded the stored tenant, and a
 * manager has no such step. The selector is exactly for that role, so it was
 * inert for everyone who needed it.
 *
 * A manager with TWO branches is the shape under test, because with one branch
 * "no effect" and "already correct" are indistinguishable.
 */

const ORG = 'org-tutienda';
const STORE_A = 'store-a';
const STORE_B = 'store-b';

const managerScope = {
  organizationId: ORG,
  allowedStoreIds: [STORE_A, STORE_B],
};

beforeEach(() => {
  window.localStorage.clear();
  exitManagedTenant();
});

describe('narrowToStore', () => {
  it('narrows a store-less ORGANIZATION_MANAGER that has never entered a company', () => {
    expect(getManagedTenant()).toBeNull();

    narrowToStore(STORE_B, 'Store B', { organizationId: ORG, organizationName: 'TuTienda' });

    const stored = getManagedTenant();
    expect(stored?.organizationId).toBe(ORG);
    expect(stored?.storeId).toBe(STORE_B);
    expect(stored?.storeName).toBe('Store B');
  });

  it('survives a reload — the value is persisted, not component state', () => {
    narrowToStore(STORE_B, 'Store B', { organizationId: ORG, organizationName: 'TuTienda' });

    // A reload keeps localStorage and drops every module-level cache.
    const raw = window.localStorage.getItem('wegox-managed-tenant');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).storeId).toBe(STORE_B);
  });

  it('sends the narrowed branch as a request header', () => {
    narrowToStore(STORE_B, 'Store B', { organizationId: ORG, organizationName: 'TuTienda' });

    expect(tenantHeaders()).toEqual({
      'X-Managed-Organization': ORG,
      'X-Managed-Store': STORE_B,
    });
  });

  it('widens back to all branches without losing the organization', () => {
    narrowToStore(STORE_B, 'Store B', { organizationId: ORG, organizationName: 'TuTienda' });
    narrowToStore(null, null, { organizationId: ORG, organizationName: 'TuTienda' });

    expect(getManagedTenant()?.organizationId).toBe(ORG);
    expect(getManagedTenant()?.storeId).toBeNull();
    expect(tenantHeaders()['X-Managed-Store']).toBeUndefined();
  });

  it('keeps the platform owner path unchanged — an entered company still wins', () => {
    enterManagedTenant({ organizationId: 'org-client', organizationName: 'A Client' });

    // No `own` argument, exactly as the owner flow calls it.
    narrowToStore(STORE_A, 'Store A');

    expect(getManagedTenant()?.organizationId).toBe('org-client');
    expect(getManagedTenant()?.storeId).toBe(STORE_A);
  });

  it('still does nothing when there is neither a stored tenant nor an organization', () => {
    narrowToStore(STORE_B, 'Store B', null);
    expect(getManagedTenant()).toBeNull();
  });
});

describe('selectedStoreId', () => {
  it('shows the branch a manager narrowed to', () => {
    narrowToStore(STORE_B, 'Store B', { organizationId: ORG, organizationName: 'TuTienda' });
    expect(selectedStoreId(getManagedTenant(), managerScope)).toBe(STORE_B);
  });

  it('shows "all branches" when nothing is narrowed', () => {
    expect(selectedStoreId(null, managerScope)).toBe('');
  });

  it('refuses a stored branch belonging to another organization', () => {
    enterManagedTenant({
      organizationId: 'org-somebody-else',
      organizationName: 'Somebody Else',
      storeId: STORE_B,
      storeName: 'Store B',
    });
    expect(selectedStoreId(getManagedTenant(), managerScope)).toBe('');
  });

  it('refuses a branch outside the actor’s allowed set', () => {
    enterManagedTenant({
      organizationId: ORG,
      organizationName: 'TuTienda',
      storeId: 'store-not-mine',
      storeName: 'Not Mine',
    });
    expect(selectedStoreId(getManagedTenant(), managerScope)).toBe('');
  });

  it('shows nothing when there is no resolved scope at all', () => {
    narrowToStore(STORE_B, 'Store B', { organizationId: ORG, organizationName: 'TuTienda' });
    expect(selectedStoreId(getManagedTenant(), null)).toBe('');
  });
});
