import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click, type, select } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import { ES } from '../../../lib/translations.es';
import ChangeAccessModal from './change-access-modal';
import type { PlatformUserRow } from '../services/platform-users.service';
import type { BoundedLookup } from '../use-bounded-lookup';
import type { TenantRef } from '../services/platform-users.service';

/**
 * THE MODAL OFFERS ONLY WHAT THE CONTRACT ACCEPTS (#275).
 *
 * The assertions below are about what can be SELECTED, not only about what is
 * rejected: "invalid combinations are unselectable, not merely refused on
 * submit" is the requirement, and a disabled-but-present option would fail it
 * just as surely as an accepted one.
 */
const setSearch = vi.fn();
const retry = vi.fn();

/**
 * The branch list arrives as a BOUNDED LOOKUP, not an array, so the modal can
 * tell "no branches" apart from "we could not find out". Archived branches are
 * absent because the endpoint excludes them — proved in
 * `backend/src/modules/users/platform-users-directory.pg.spec.ts`, against the
 * database, rather than by a client-side filter that could be removed here
 * without any test noticing.
 */
const lookup = (over: Partial<BoundedLookup<TenantRef>> = {}): BoundedLookup<TenantRef> => ({
  state: 'ready',
  items: [
    { id: 'store-a', name: 'Centro' },
    { id: 'store-b', name: 'Norte' },
  ],
  total: 2,
  truncated: false,
  error: null,
  search: '',
  setSearch,
  retry,
  ...over,
});

const branchAdmin: PlatformUserRow = {
  id: 'u-1',
  email: 'ana@acme.com',
  firstName: 'Ana',
  lastName: null,
  company: 'Acme',
  role: 'ADMIN',
  organization: { id: 'org-1', name: 'Acme' },
  store: { id: 'store-a', name: 'Centro' },
  pendingInvite: false,
  deactivatedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const manager: PlatformUserRow = {
  ...branchAdmin,
  id: 'u-2',
  email: 'jefe@acme.com',
  role: 'ORGANIZATION_MANAGER',
  store: null,
};

const render = (user: PlatformUserRow, props: Partial<React.ComponentProps<typeof ChangeAccessModal>> = {}) =>
  renderComponent(
    <I18nProvider>
      <ChangeAccessModal
        user={user}
        storeLookup={props.storeLookup ?? lookup()}
        onCancel={props.onCancel ?? (() => undefined)}
        onSubmit={props.onSubmit ?? (() => undefined)}
        busy={props.busy}
        error={props.error}
      />
    </I18nProvider>,
  );

const options = (r: { container: HTMLElement }, testId: string): string[] =>
  Array.from(r.container.querySelectorAll<HTMLSelectElement>(`[data-testid="${testId}"] option`)).map((o) => o.value);
const el = (r: { container: HTMLElement }, testId: string) =>
  r.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const submitButton = (r: { container: HTMLElement }) =>
  r.container.querySelector<HTMLButtonElement>('[data-testid="submit-access"]')!;

describe('#275 · Change access modal', () => {
  afterEach(() => cleanupAll());

  it('states the current access as a sentence', async () => {
    const r = await render(branchAdmin);
    expect(el(r, 'current-access')!.textContent).toMatch(/Branch:\s*Acme · Centro/);
    const m = await render(manager);
    expect(el(m, 'current-access')!.textContent).toMatch(/Company-wide in Acme/);
  });

  it('BRANCH shape offers only branch roles — the manager is ABSENT, not disabled', async () => {
    const r = await render(branchAdmin);
    expect(options(r, 'access-role')).toEqual(['ADMIN', 'EDITOR', 'VIEWER']);
    expect(options(r, 'access-role')).not.toContain('ORGANIZATION_MANAGER');
  });

  it('ORGANIZATION shape offers only the manager, and hides the branch selector', async () => {
    const r = await render(manager);
    expect(options(r, 'access-role')).toEqual(['ORGANIZATION_MANAGER']);
    expect(el(r, 'access-store')).toBeNull();
  });

  it('switching the shape re-derives the role, so no illegal pair can be held', async () => {
    const r = await render(branchAdmin);
    await click(el(r, 'shape-ORGANIZATION'));
    expect(options(r, 'access-role')).toEqual(['ORGANIZATION_MANAGER']);
    expect(el(r, 'access-store')).toBeNull();
    await click(el(r, 'shape-BRANCH'));
    expect(options(r, 'access-role')).toEqual(['ADMIN', 'EDITOR', 'VIEWER']);
    expect(el(r, 'access-store')).not.toBeNull();
  });

  it('STORE_ADMIN and SUPER_ADMIN appear NOWHERE in the modal', async () => {
    const r = await render(branchAdmin);
    const markup = r.container.innerHTML;
    expect(markup).not.toMatch(/STORE_ADMIN/);
    expect(markup).not.toMatch(/SUPER_ADMIN/);
    await click(el(r, 'shape-ORGANIZATION'));
    expect(r.container.innerHTML).not.toMatch(/STORE_ADMIN|SUPER_ADMIN/);
  });

  it('offers exactly the branches the bounded lookup returned', async () => {
    const r = await render(branchAdmin);
    expect(options(r, 'access-store')).toEqual(['', 'store-a', 'store-b']);
  });

  describe('the branch list is bounded, and its state is never guessed', () => {
    it('says how many of how many when the answer was truncated', async () => {
      const r = await render(branchAdmin, {
        storeLookup: lookup({ total: 40, truncated: true }),
      });
      expect(el(r, 'access-store-state')!.textContent).toMatch(/Showing\s*2\s*of\s*40/);
      expect(el(r, 'access-store-state')!.textContent).toMatch(/type to narrow/i);
    });

    it('a FAILED lookup blocks the change instead of offering an empty branch list', async () => {
      const onSubmit = vi.fn();
      const r = await render(branchAdmin, {
        onSubmit,
        storeLookup: lookup({ state: 'failed', items: [], total: 0, error: 'The list could not be read' }),
      });
      expect(el(r, 'access-store-state')!.textContent).toMatch(/could not be read/);
      expect(el(r, 'access-store-retry')).not.toBeNull();
      // The only option left would be the pinned current branch, which would
      // make "no change" look like the only possible answer.
      expect(submitButton(r).disabled).toBe(true);
      await click(submitButton(r));
      expect(onSubmit).not.toHaveBeenCalled();
    });

    it('retrying asks again', async () => {
      retry.mockReset();
      const r = await render(branchAdmin, {
        storeLookup: lookup({ state: 'failed', items: [], total: 0, error: 'boom' }),
      });
      await click(el(r, 'access-store-retry'));
      expect(retry).toHaveBeenCalled();
    });

    it('keeps the person’s CURRENT branch selectable even when a search excludes it', async () => {
      const onSubmit = vi.fn();
      const r = await render(branchAdmin, {
        onSubmit,
        // A search for "norte" returns only Norte; Centro — the branch they are
        // in today — must not silently vanish from under the operator.
        storeLookup: lookup({ items: [{ id: 'store-b', name: 'Norte' }], total: 1, search: 'norte' }),
      });
      expect(options(r, 'access-store')).toContain('store-a');
      await select(el(r, 'access-role'), 'EDITOR');
      await click(submitButton(r));
      expect(onSubmit).toHaveBeenCalledWith({ role: 'EDITOR', storeId: 'store-a' });
    });

    it('drops a held branch that is no longer offered, rather than submitting it', async () => {
      const onSubmit = vi.fn();
      // No pinned branch (the person is company-wide today) and the lookup
      // answered with a different company's branches removed entirely.
      const r = await render(
        { ...branchAdmin, store: null },
        { onSubmit, storeLookup: lookup({ items: [], total: 0 }) },
      );
      expect(options(r, 'access-store')).toEqual(['']);
      expect(el(r, 'selection-problem')!.textContent).toMatch(/choose the branch/i);
      expect(submitButton(r).disabled).toBe(true);
    });
  });

  it('a branch role with no branch chosen cannot be submitted, and says why', async () => {
    const onSubmit = vi.fn();
    const r = await render({ ...branchAdmin, store: null }, { onSubmit });
    expect(el(r, 'selection-problem')!.textContent).toMatch(/choose the branch/i);
    expect(submitButton(r).disabled).toBe(true);
    await click(submitButton(r));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('an unchanged selection cannot be submitted', async () => {
    const r = await render(branchAdmin);
    expect(submitButton(r).disabled).toBe(true);
    expect(el(r, 'unchanged-note')).not.toBeNull();
  });

  it('a legal change submits the exact contract body', async () => {
    const onSubmit = vi.fn();
    const r = await render(branchAdmin, { onSubmit });
    await select(el(r, 'access-role'), 'EDITOR');
    await click(submitButton(r));
    expect(onSubmit).toHaveBeenCalledWith({ role: 'EDITOR', storeId: 'store-a' });
  });

  it('promotion sends storeId: null — present, and null', async () => {
    const onSubmit = vi.fn();
    const r = await render(branchAdmin, { onSubmit });
    await click(el(r, 'shape-ORGANIZATION'));
    await type(r.container.querySelector('input[name="confirmEscalation"]'), 'PROMOTE');
    await click(submitButton(r));
    expect(onSubmit).toHaveBeenCalledWith({ role: 'ORGANIZATION_MANAGER', storeId: null });
  });

  describe('escalation', () => {
    it('is gated by a typed confirmation', async () => {
      const onSubmit = vi.fn();
      const r = await render(branchAdmin, { onSubmit });
      await click(el(r, 'shape-ORGANIZATION'));
      expect(el(r, 'escalation-gate')).not.toBeNull();
      expect(submitButton(r).disabled).toBe(true);

      await type(r.container.querySelector('input[name="confirmEscalation"]'), 'promote please');
      expect(submitButton(r).disabled).toBe(true);

      await type(r.container.querySelector('input[name="confirmEscalation"]'), 'PROMOTE');
      expect(submitButton(r).disabled).toBe(false);
    });

    it('is NOT demanded for an ordinary change', async () => {
      const r = await render(branchAdmin);
      await select(el(r, 'access-role'), 'VIEWER');
      expect(el(r, 'escalation-gate')).toBeNull();
      expect(submitButton(r).disabled).toBe(false);
    });
  });

  it('always warns that the sessions end', async () => {
    const r = await render(branchAdmin);
    expect(el(r, 'session-warning')!.textContent).toMatch(/sessions will be ended|sign in again/i);
  });

  it('previews what is gained and lost, from the real capability predicates', async () => {
    const r = await render(branchAdmin);
    await click(el(r, 'shape-ORGANIZATION'));
    const preview = el(r, 'access-preview')!;
    expect(preview).not.toBeNull();
    // A branch ADMIN cannot see company-wide metrics; a manager can. The line
    // is computed by the same predicate the metrics screen gates on.
    const gained = preview.querySelectorAll('[data-changed="yes"]');
    expect(gained.length).toBeGreaterThan(0);
  });

  it('shows the server refusal as given, and invents nothing', async () => {
    const message = 'An organization must keep at least one active manager';
    const r = await render(branchAdmin, { error: message });
    expect(el(r, 'access-error')!.textContent).toBe(message);
  });

  it('renders roles as WORDS, never as enum constants', async () => {
    const r = await render(branchAdmin);
    const roleOptions = Array.from(r.container.querySelectorAll('[data-testid="access-role"] option'));
    expect(roleOptions.map((o) => o.textContent)).toEqual(['Branch administrator', 'Editor', 'Viewer']);
    // The VALUES stay the contract's enum — that is what goes on the wire.
    expect(roleOptions.map((o) => (o as HTMLOptionElement).value)).toEqual(['ADMIN', 'EDITOR', 'VIEWER']);
  });

  it('every string it renders exists in Spanish', () => {
    for (const key of [
      'Change access',
      'Access shape',
      'Organization-wide',
      'One branch',
      'Role',
      'Branch',
      'Choose a branch',
      'Find a branch',
      'Type to narrow',
      'Showing',
      'of',
      'type to narrow the list',
      'Nothing matches this search.',
      'Try again',
      'Loading…',
      'After this change they can',
      'All of this person’s sessions will be ended. They must sign in again.',
      'This grants authority over the whole company. Type PROMOTE to confirm.',
      'Choose a role.',
      'This role works in one branch, so choose the branch.',
      'This is the access they already have.',
      'Company-wide in',
      'Branch:',
      'Today:',
      // The LABELS are the dictionary keys, because English is the key
      // language: feeding `t()` an enum would print the enum in English.
      'Organization Manager',
      'Branch administrator',
      'Editor',
      'Viewer',
    ]) {
      expect(ES[key], `missing Spanish for "${key}"`).toBeTruthy();
    }
  });
});
