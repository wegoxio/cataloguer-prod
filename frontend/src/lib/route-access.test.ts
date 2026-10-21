import { describe, expect, it } from 'vitest';
import { mayOpenDashboardRoute } from './route-access';
import type { SessionScope } from './permissions';

const unscopedOwner: SessionScope = {
  platform: true,
  role: 'SUPER_ADMIN',
  organizationId: null,
  storeId: null,
  allowedStoreIds: [],
};

const organizationManager: SessionScope = {
  platform: false,
  role: 'ORGANIZATION_MANAGER',
  organizationId: 'org-1',
  storeId: null,
  allowedStoreIds: ['store-1'],
};

describe('dashboard route access', () => {
  it('keeps the store administration surface available to the unscoped platform owner', () => {
    expect(mayOpenDashboardRoute('/dashboard/website', unscopedOwner)).toBe(true);
  });

  it('does not let an unscoped platform owner work in a catalogue before choosing a company', () => {
    expect(mayOpenDashboardRoute('/dashboard/products', unscopedOwner)).toBe(false);
    expect(mayOpenDashboardRoute('/dashboard/categories', unscopedOwner)).toBe(false);
  });

  it('opens tenant catalogue routes after the backend resolves an organization', () => {
    expect(mayOpenDashboardRoute('/dashboard/products/item-1', organizationManager)).toBe(true);
    expect(mayOpenDashboardRoute('/dashboard/sales', organizationManager)).toBe(true);
  });

  it('denies unknown dashboard paths instead of silently exposing them', () => {
    expect(mayOpenDashboardRoute('/dashboard/retired-module', organizationManager)).toBe(false);
  });
});
