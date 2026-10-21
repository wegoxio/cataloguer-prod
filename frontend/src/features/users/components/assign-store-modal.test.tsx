import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../test/render';
import AssignStoreModal from './assign-store-modal';
import { I18nProvider } from '../../../lib/i18n';
import type { SessionScope } from '../../../lib/permissions';
import type { ManagedUser } from './user-table';

let currentScope: SessionScope | null = null;
vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ scope: currentScope, accessToken: 'token', user: { id: 'actor' } }),
}));

const MANAGER: SessionScope = {
  platform: false,
  role: 'ORGANIZATION_MANAGER',
  organizationId: 'org-1',
  storeId: null,
  allowedStoreIds: ['store-1', 'store-2'],
};

const STORES = [
  { id: 'store-1', name: 'Centro' },
  { id: 'store-2', name: 'Norte' },
];

const target = (over: Partial<ManagedUser> = {}): ManagedUser => ({
  id: 'u-target',
  email: 'ana@acme.com',
  firstName: 'Ana',
  lastName: null,
  company: null,
  role: 'ADMIN',
  pendingInvite: false,
  store: { id: 'store-1', name: 'Centro' },
  createdAt: '2026-01-01T00:00:00Z',
  deactivatedAt: null,
  ...over,
});

const modal = (user: ManagedUser) => (
  <I18nProvider>
    <AssignStoreModal user={user} stores={STORES} onSubmit={() => {}} onClose={() => {}} />
  </I18nProvider>
);

describe('AssignStoreModal', () => {
  beforeEach(() => {
    currentScope = MANAGER;
  });
  afterEach(() => cleanupAll());

  it('offers exactly ONE binding — a single select, no multi-store control', async () => {
    // P9D-01 (multi-store administration) is a Phase 9 decision. Nothing on
    // this dialog may imply it exists: one select, no checkboxes, no way to
    // hold two branches at once.
    const view = await renderComponent(modal(target()));
    const selects = view.container.querySelectorAll('select');
    expect(selects).toHaveLength(1);
    expect(selects[0].multiple).toBe(false);
    expect(view.container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);
  });

  it('states the effect of the pending choice: this store, and only there', async () => {
    const view = await renderComponent(modal(target()));
    expect(view.get('store-access-preview').textContent).toMatch(/works inside Centro, and only there/);
  });

  it('a tenant role cannot be offered "no store"', async () => {
    const view = await renderComponent(modal(target()));
    const empty = view.container.querySelector<HTMLOptionElement>('option[value=""]');
    expect(empty?.disabled).toBe(true);
  });

  it('a NARROWED manager may only offer the branch it selected', async () => {
    currentScope = { ...MANAGER, storeId: 'store-2' };
    const view = await renderComponent(modal(target({ store: null, role: 'ADMIN' })));
    const offered = Array.from(view.container.querySelectorAll('option'))
      .map((option) => option.value)
      .filter(Boolean);
    expect(offered).toEqual(['store-2']);
  });
});
