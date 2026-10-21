import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../test/render';
import UserTable, { type ManagedUser } from './user-table';
import { I18nProvider } from '../../../lib/i18n';

const person = (over: Partial<ManagedUser>): ManagedUser => ({
  id: 'u-1',
  email: 'ana@acme.com',
  firstName: 'Ana',
  lastName: null,
  company: null,
  role: 'EDITOR',
  pendingInvite: false,
  store: { id: 'store-1', name: 'Centro' },
  createdAt: '2026-01-01T00:00:00Z',
  deactivatedAt: null,
  ...over,
});

const table = (users: ManagedUser[], actorId: string) => (
  <I18nProvider>
    <UserTable
      users={users}
      actorRole="ORGANIZATION_MANAGER"
      actorId={actorId}
      onEditRole={vi.fn()}
      onResetPassword={vi.fn()}
      onResendInvite={vi.fn()}
      onAssignStore={vi.fn()}
      onDeactivate={vi.fn()}
      onReactivate={vi.fn()}
    />
  </I18nProvider>
);

/**
 * Safe self-access-change (Phase 8 B): the server refuses self-management
 * outright ("You cannot manage your own account from here"), and the table
 * must agree — the actor's own row is labelled and offers no controls, so
 * there is nothing to click that the server would only refuse.
 */
describe('UserTable and the actor’s own row', () => {
  afterEach(() => cleanupAll());

  it('labels the actor’s row and renders no action for it, while peers keep theirs', async () => {
    const me = person({ id: 'me', email: 'boss@acme.com', role: 'ORGANIZATION_MANAGER', store: null });
    const peer = person({ id: 'u-2' });
    const view = await renderComponent(table([me, peer], 'me'));

    const rows = view.container.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('(you)');
    expect(rows[0].querySelectorAll('button')).toHaveLength(0);
    // The peer row still offers the management controls.
    expect(rows[1].querySelectorAll('button').length).toBeGreaterThan(0);
  });
});
