import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../test/render';
import ChangeRoleModal from './change-role-modal';
import { I18nProvider } from '../../../lib/i18n';
import type { ManagedUser } from './user-table';

const user = (over: Partial<ManagedUser> = {}): ManagedUser => ({
  id: 'u-target',
  email: 'ana@acme.com',
  firstName: 'Ana',
  lastName: null,
  company: null,
  role: 'VIEWER',
  pendingInvite: false,
  store: { id: 'store-1', name: 'Centro' },
  createdAt: '2026-01-01T00:00:00Z',
  deactivatedAt: null,
  ...over,
});

const modal = (target: ManagedUser, roles = ['ADMIN', 'EDITOR', 'VIEWER']) => (
  <I18nProvider>
    <ChangeRoleModal user={target} assignableRoles={roles} onSubmit={async () => {}} onClose={() => {}} />
  </I18nProvider>
);

/**
 * The effective-access preview (Phase 8 B): what the person WILL be able to
 * do is stated before the change is saved, computed by the same predicates
 * the screens gate on — not a hand-written role description.
 */
describe('ChangeRoleModal access preview', () => {
  afterEach(() => cleanupAll());

  it('previews the selected role before anything is saved', async () => {
    const view = await renderComponent(modal(user()));
    // First offerable role is ADMIN: branch operations yes, company commands no.
    const preview = view.get('role-access-preview');
    expect(preview.textContent).toContain('After this change');
    const granted = view.all('role-preview-yes').map((node) => node.textContent);
    const refused = view.all('role-preview-no').map((node) => node.textContent);
    expect(granted.join(' ')).toContain('See stock and movements');
    expect(refused.join(' ')).toContain('Issue company-wide stock commands');
  });

  it('warns when the chosen role needs a store the target does not have', async () => {
    const unbound = user({ store: null, role: 'SUPER_ADMIN' });
    const view = await renderComponent(modal(unbound, ['ADMIN', 'EDITOR']));
    expect(view.get('role-needs-store').textContent).toMatch(/assign a store first/i);
  });

  it('shows no warning when the target already has its store', async () => {
    const view = await renderComponent(modal(user()));
    expect(view.find('role-needs-store')).toBeNull();
  });
});
