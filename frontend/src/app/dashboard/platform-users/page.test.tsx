import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click, select, type, flush, settle } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';

/**
 * THE PLATFORM DIRECTORY, FROM THE SCREEN'S SIDE (#275).
 *
 * The server proves pagination and isolation; this proves the screen ASKS for
 * them — that a filter reaches the request rather than a client-side `filter()`,
 * that the browser never holds more than the page it was given, and that the
 * page fails closed for every actor but an unscoped platform owner.
 */
const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace }) }));
vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) =>
    React.createElement('a', rest, children),
}));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../../../components/ui/toast', () => ({ useToast: () => toast }));

let scope: Record<string, unknown> | null = null;
vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ user: { id: 'owner-1', email: 'owner@wegox.com', role: 'SUPER_ADMIN' }, scope, accessToken: 'tok' }),
}));

let calls: { path: string; method: string; body: unknown }[] = [];
let pageResponse: unknown;
let changeRejects: Error | null = null;
let changeResponse: unknown;
let organizationLookupFails = false;
let organizationLookupTotal: number | null = null;
let storeLookupFails = false;
let storeLookupPage: unknown;

/**
 * Answers held open, so the ORDER they resolve in can be dictated rather than
 * hoped for. A test that only ever sees requests answer in the order they were
 * sent cannot prove anything about the case that actually breaks screens.
 */
type Deferred = { resolve: (value: unknown) => void; path: string };
let held: Deferred[] | null = null;

const lookupPage = (items: { id: string; name: string }[], total = items.length) => ({
  items,
  total,
  limit: 20,
  truncated: total > items.length,
});

vi.mock('../../../lib/api-client', () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    if (path.startsWith('/organizations/lookup')) {
      if (organizationLookupFails) throw new Error('The company list could not be read');
      const items = [{ id: 'org-1', name: 'Acme' }, { id: 'org-2', name: 'Rival' }];
      return { data: lookupPage(items, organizationLookupTotal ?? items.length) };
    }
    if (path.includes('/stores/lookup')) {
      if (storeLookupFails) throw new Error('The branch list could not be read');
      return { data: storeLookupPage };
    }
    if (path.includes('/access')) {
      if (changeRejects) throw changeRejects;
      return { data: changeResponse };
    }
    if (path.startsWith('/users/platform')) {
      if (held) {
        return new Promise((resolve) => held!.push({ path, resolve: (value) => resolve(value) }));
      }
      return { data: pageResponse };
    }
    return { data: null };
  },
}));

import PlatformUsersPage from './page';

const UNSCOPED_OWNER = {
  platform: true,
  role: 'SUPER_ADMIN',
  organizationId: null,
  storeId: null,
  allowedStoreIds: [],
};
const OWNER_IN_COMPANY = { ...UNSCOPED_OWNER, organizationId: 'org-1' };
const MANAGER = {
  platform: false,
  role: 'ORGANIZATION_MANAGER',
  organizationId: 'org-1',
  storeId: null,
  allowedStoreIds: [],
};

const row = (over: Record<string, unknown> = {}) => ({
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
  ...over,
});

const page = () =>
  renderComponent(
    <I18nProvider>
      <PlatformUsersPage />
    </I18nProvider>,
  );

const listCalls = () => calls.filter((c) => c.path.startsWith('/users/platform'));
const lastQuery = () => new URLSearchParams(listCalls()[listCalls().length - 1].path.split('?')[1]);
const el = (r: { container: HTMLElement }, testId: string) =>
  r.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

describe('#275 · Platform Users page', () => {
  beforeEach(() => {
    calls = [];
    scope = UNSCOPED_OWNER;
    changeRejects = null;
    changeResponse = row({ role: 'ORGANIZATION_MANAGER', store: null });
    organizationLookupFails = false;
    organizationLookupTotal = null;
    storeLookupFails = false;
    storeLookupPage = lookupPage([{ id: 'store-a', name: 'Centro' }, { id: 'store-b', name: 'Norte' }]);
    held = null;
    pageResponse = { items: [row()], total: 1, page: 1, limit: 25, totalPages: 1 };
    toast.success.mockReset();
    toast.error.mockReset();
    replace.mockReset();
  });
  afterEach(() => cleanupAll());

  describe('authority', () => {
    it('renders for an UNSCOPED platform owner', async () => {
      const r = await page();
      await flush();
      expect(r.text()).toMatch(/Platform Users/);
      expect(listCalls().length).toBeGreaterThan(0);
    });

    it.each([
      ['a platform owner acting inside a company', OWNER_IN_COMPANY],
      ['an organization manager', MANAGER],
    ])('renders NOTHING and requests NOTHING for %s', async (_label, actorScope) => {
      scope = actorScope as never;
      const r = await page();
      await flush();
      // Fails closed on the CALL, not only on the render: no request is made
      // at all, so a permissive server could not leak through this screen.
      expect(listCalls()).toHaveLength(0);
      expect(r.container.textContent).toBe('');
      expect(replace).toHaveBeenCalledWith('/dashboard');
    });

    it('requests nothing while the scope is still unresolved', async () => {
      scope = null;
      await page();
      await flush();
      expect(listCalls()).toHaveLength(0);
      // Not yet known is not the same as "not the owner": no redirect either.
      expect(replace).not.toHaveBeenCalled();
    });
  });

  describe('pagination is the SERVER’s', () => {
    it('asks for one bounded page and holds only what came back', async () => {
      pageResponse = { items: [row(), row({ id: 'u-2', email: 'b@acme.com' })], total: 97, page: 1, limit: 25, totalPages: 4 };
      const r = await page();
      await flush();
      const query = lastQuery();
      expect(query.get('page')).toBe('1');
      expect(query.get('limit')).toBe('25');
      // The browser shows two rows out of ninety-seven; it never asked for 97.
      expect(el(r, 'platform-users-count')!.textContent).toMatch(/2 .* 97/);
    });

    it('changing page re-asks the server rather than slicing a cached list', async () => {
      pageResponse = { items: [row()], total: 97, page: 1, limit: 25, totalPages: 4 };
      const r = await page();
      await flush();
      const before = listCalls().length;
      const next = Array.from(r.container.querySelectorAll('button')).find((b) => /Next|Siguiente/i.test(b.textContent ?? ''));
      await click(next!);
      await flush();
      expect(listCalls().length).toBeGreaterThan(before);
      expect(lastQuery().get('page')).toBe('2');
    });

    it('a filter change returns to page one', async () => {
      pageResponse = { items: [row()], total: 97, page: 2, limit: 25, totalPages: 4 };
      const r = await page();
      await flush();
      await select(el(r, 'filter-role'), 'EDITOR');
      await flush();
      expect(lastQuery().get('page')).toBe('1');
    });
  });

  describe('filters reach the request', () => {
    it.each([
      ['filter-role', 'EDITOR', 'role', 'EDITOR'],
      ['filter-status', 'deactivated', 'status', 'deactivated'],
      ['filter-invitation', 'pending', 'invitation', 'pending'],
      ['filter-organization', 'org-2', 'organizationId', 'org-2'],
    ])('%s becomes a query parameter', async (testId, value, param, expected) => {
      const r = await page();
      await flush();
      await select(el(r, testId), value);
      await flush();
      expect(lastQuery().get(param)).toBe(expected);
    });

    it('the branch filter is disabled until a company is chosen, then scoped to it', async () => {
      const r = await page();
      await flush();
      expect((el(r, 'filter-store') as HTMLSelectElement).disabled).toBe(true);

      await select(el(r, 'filter-organization'), 'org-1');
      await flush();
      expect((el(r, 'filter-store') as HTMLSelectElement).disabled).toBe(false);
      // Branches are read for THAT company by path — never every branch on the
      // platform, and never by switching this session's tenant.
      expect(calls.some((c) => c.path.startsWith('/organizations/org-1/stores/lookup'))).toBe(true);

      await select(el(r, 'filter-store'), 'store-b');
      await flush();
      expect(lastQuery().get('storeId')).toBe('store-b');
    });

    it('an untouched filter is OMITTED rather than sent blank', async () => {
      await page();
      await flush();
      const query = lastQuery();
      expect(query.get('role')).toBeNull();
      expect(query.get('organizationId')).toBeNull();
      expect(query.get('storeId')).toBeNull();
      expect(query.get('search')).toBeNull();
      // `active` is the default the server already applies; sending it would be
      // noise, and `invitation=all` means "do not filter".
      expect(query.get('status')).toBeNull();
      expect(query.get('invitation')).toBeNull();
    });
  });

  describe('a stale answer never wins', () => {
    /**
     * THE ORDER RESPONSES ARRIVE IN IS NOT THE ORDER THEY WERE SENT IN.
     *
     * A broad filter is slow and a narrow one is fast, so the request the
     * operator no longer cares about routinely lands last. These tests answer
     * the OLDER request second, on purpose — the arrangement that used to leave
     * the screen showing results for filters that were no longer on it, with
     * nothing on screen saying so.
     */
    it('an older user page answering LAST does not replace the newer one', async () => {
      held = [];
      const r = await page();
      await flush();

      // Two reads in flight: the initial one, then a narrowed one.
      await select(el(r, 'filter-role'), 'EDITOR');
      await flush();
      expect(held.length).toBe(2);

      const [first, second] = held;
      expect(second.path).toContain('role=EDITOR');

      // Newer answers first...
      second.resolve({ data: { items: [row({ id: 'u-new', email: 'newer@acme.com' })], total: 1, page: 1, limit: 25, totalPages: 1 } });
      await flush();
      // ...then the older one lands, describing filters nobody is looking at.
      first.resolve({ data: { items: [row({ id: 'u-old', email: 'older@acme.com' })], total: 1, page: 1, limit: 25, totalPages: 1 } });
      await flush();

      expect(r.text()).toMatch(/newer@acme.com/);
      expect(r.text()).not.toMatch(/older@acme.com/);
    });

    it('a superseded read does not clear the loading state of the live one', async () => {
      held = [];
      const r = await page();
      await flush();
      await select(el(r, 'filter-role'), 'EDITOR');
      await flush();

      // Only the OLDER request answers. The newer one is still in flight, so
      // the screen must still say it is loading rather than show a stale page.
      held[0].resolve({ data: { items: [row({ id: 'u-old', email: 'older@acme.com' })], total: 1, page: 1, limit: 25, totalPages: 1 } });
      await flush();
      expect(el(r, 'platform-users-loading')).not.toBeNull();
      expect(r.text()).not.toMatch(/older@acme.com/);
    });

    it('switching company twice never displays or submits the first company’s branch', async () => {
      const r = await page();
      await flush();

      storeLookupPage = lookupPage([{ id: 'store-a', name: 'Centro' }]);
      await select(el(r, 'filter-organization'), 'org-1');
      await flush();
      await select(el(r, 'filter-store'), 'store-a');
      await flush();
      expect(lastQuery().get('storeId')).toBe('store-a');

      // A different company, whose branches are entirely different.
      storeLookupPage = lookupPage([{ id: 'store-z', name: 'Zona' }]);
      await select(el(r, 'filter-organization'), 'org-2');
      await flush();

      const offered = Array.from(
        r.container.querySelectorAll<HTMLOptionElement>('[data-testid="filter-store"] option'),
      ).map((o) => o.value);
      expect(offered).not.toContain('store-a');
      expect(offered).toContain('store-z');
      // And the branch is gone from the REQUEST too, not merely from the list.
      expect(lastQuery().get('storeId')).toBeNull();
      expect(lastQuery().get('organizationId')).toBe('org-2');
    });
  });

  describe('a lookup that failed is not a lookup that found nothing', () => {
    it('a failed COMPANY lookup says so and offers a retry — it does not show zero companies', async () => {
      organizationLookupFails = true;
      const r = await page();
      await flush();

      const state = el(r, 'filter-organization-state')!;
      expect(state.textContent).toMatch(/could not be read/);
      expect(el(r, 'filter-organization-retry')).not.toBeNull();
      // The control is unusable rather than an empty, confident selector.
      expect((el(r, 'filter-organization') as HTMLSelectElement).disabled).toBe(true);
      // And the DIRECTORY itself is unaffected: one failed selector must not
      // take the page down with it.
      expect(el(r, 'platform-users-error')).toBeNull();

      organizationLookupFails = false;
      await click(el(r, 'filter-organization-retry'));
      await flush();
      expect((el(r, 'filter-organization') as HTMLSelectElement).disabled).toBe(false);
      expect(
        Array.from(r.container.querySelectorAll<HTMLOptionElement>('[data-testid="filter-organization"] option')).map(
          (o) => o.value,
        ),
      ).toEqual(['', 'org-1', 'org-2']);
    });

    it('a failed BRANCH lookup leaves the branch filter unusable, not empty-and-usable', async () => {
      storeLookupFails = true;
      const r = await page();
      await flush();
      await select(el(r, 'filter-organization'), 'org-1');
      await flush();

      expect(el(r, 'filter-store-state')!.textContent).toMatch(/could not be read/);
      expect((el(r, 'filter-store') as HTMLSelectElement).disabled).toBe(true);
    });

    it('an empty answer is a real, stated result — "nothing matches"', async () => {
      storeLookupPage = lookupPage([]);
      const r = await page();
      await flush();
      await select(el(r, 'filter-organization'), 'org-1');
      await flush();
      expect(el(r, 'filter-store-state')!.textContent).toMatch(/Nothing matches/i);
      expect(el(r, 'filter-store-retry')).toBeNull();
    });
  });

  describe('the company filter is bounded', () => {
    it('asks for a bounded page and never for every organization', async () => {
      await page();
      await flush();
      const lookups = calls.filter((c) => c.path.startsWith('/organizations/lookup'));
      expect(lookups.length).toBeGreaterThan(0);
      expect(new URLSearchParams(lookups[0].path.split('?')[1]).get('limit')).toBe('20');
      // The unbounded listing is never touched by this screen.
      expect(calls.some((c) => c.path === '/organizations')).toBe(false);
    });

    it('typing narrows it SERVER-SIDE rather than filtering what was already fetched', async () => {
      const r = await page();
      await flush();
      await type(el(r, 'filter-organization-search'), 'riv');
      await settle();
      const lookups = calls.filter((c) => c.path.startsWith('/organizations/lookup'));
      expect(lookups.some((c) => c.path.includes('search=riv'))).toBe(true);
    });

    it('says how many of how many when the answer is truncated, rather than passing 20 off as all', async () => {
      // The endpoint returned a bounded page; the platform holds 137 companies.
      organizationLookupTotal = 137;
      const r = await page();
      await flush();
      const state = el(r, 'filter-organization-state')!.textContent ?? '';
      expect(state).toMatch(/Showing\s*2\s*of\s*137/);
      expect(state).toMatch(/type to narrow/i);
    });
  });

  describe('what a row says', () => {
    it('shows organization, branch, role, status and invitation truthfully', async () => {
      pageResponse = {
        items: [
          row({ id: 'u-1', email: 'ana@acme.com', role: 'ADMIN' }),
          row({ id: 'u-2', email: 'jefe@acme.com', role: 'ORGANIZATION_MANAGER', store: null }),
          row({ id: 'u-3', email: 'nuevo@acme.com', pendingInvite: true }),
          row({ id: 'u-4', email: 'ido@acme.com', deactivatedAt: '2026-02-02T00:00:00Z' }),
        ],
        total: 4,
        page: 1,
        limit: 25,
        totalPages: 1,
      };
      const r = await page();
      await flush();
      const text = r.text();
      expect(text).toMatch(/ana@acme.com/);
      expect(text).toMatch(/Acme/);
      expect(text).toMatch(/Centro/);
      // A manager has no branch, and the cell SAYS so rather than being blank.
      expect(text).toMatch(/Company-wide/);
      expect(text).toMatch(/Invitation pending/);
      expect(text).toMatch(/Deactivated/);
      /**
       * THE SCREEN NEVER CLAIMS ANYONE SIGNED IN.
       *
       * `pendingInvite: false` means only that a password exists — set by the
       * person, by a reset, or by an administrator. The row says "No pending
       * invitation" and nothing more.
       */
      expect(text).toMatch(/No pending invitation/);
      expect(text).not.toMatch(/Signed in already/i);
      expect(text).not.toMatch(/accepted/i);
    });

    it('a person whose password an ADMINISTRATOR set is never described as having signed in', async () => {
      // `PATCH /users/:id/password` sets someone else's password: the row
      // leaves "pending" without that person doing anything at all.
      pageResponse = {
        items: [row({ id: 'u-9', email: 'reset@acme.com', pendingInvite: false })],
        total: 1,
        page: 1,
        limit: 25,
        totalPages: 1,
      };
      const r = await page();
      await flush();
      expect(r.text()).toMatch(/No pending invitation/);
      expect(r.text()).not.toMatch(/Signed in already|accepted|entró/i);
    });

    it('the invitation filter offers no state the data cannot prove', async () => {
      const r = await page();
      await flush();
      const values = Array.from(
        r.container.querySelectorAll<HTMLOptionElement>('[data-testid="filter-invitation"] option'),
      );
      expect(values.map((o) => o.value)).toEqual(['all', 'pending', 'none']);
      expect(values.map((o) => o.textContent)).toEqual([
        'Any invitation state',
        'Invitation pending',
        'No pending invitation',
      ]);
    });

    it('the truthful invitation state reaches the request', async () => {
      const r = await page();
      await flush();
      await select(el(r, 'filter-invitation'), 'none');
      await flush();
      expect(lastQuery().get('invitation')).toBe('none');
    });

    it('renders no secret of any kind', async () => {
      const r = await page();
      await flush();
      expect(r.container.innerHTML).not.toMatch(/passwordHash|tokenHash|\$argon2/i);
    });
  });

  describe('changing access', () => {
    const openModal = async (r: Awaited<ReturnType<typeof page>>) => {
      await click(el(r, 'change-access-u-1'));
      await flush();
    };

    it('reads the TARGET company’s branches when the modal opens', async () => {
      const r = await page();
      await flush();
      await openModal(r);
      expect(calls.some((c) => c.path.startsWith('/organizations/org-1/stores/lookup'))).toBe(true);
      expect(el(r, 'current-access')).not.toBeNull();
    });

    it('sends the atomic contract body to the deployed endpoint', async () => {
      const r = await page();
      await flush();
      await openModal(r);
      await select(el(r, 'access-role'), 'EDITOR');
      await click(el(r, 'submit-access'));
      await flush();

      const patch = calls.find((c) => c.method === 'PATCH');
      expect(patch?.path).toBe('/organizations/org-1/users/u-1/access');
      expect(patch?.body).toEqual({ role: 'EDITOR', storeId: 'store-a' });
    });

    it('sends the keyboard somewhere real once the change commits', async () => {
      /**
       * The modal hands focus back to whatever opened it — but a committed
       * change re-reads the list, so that button has been destroyed and
       * rebuilt. Focusing a detached node silently drops focus to
       * `document.body`, leaving a keyboard user at the top of the document
       * with no announcement. The outcome is a real destination AND the
       * sentence stating what the server committed.
       */
      const r = await page();
      await flush();
      await click(el(r, 'change-access-u-1'));
      await flush();
      await select(el(r, 'access-role'), 'EDITOR');
      await click(el(r, 'submit-access'));
      await flush();

      const outcome = el(r, 'access-outcome')!;
      expect(document.activeElement).toBe(outcome);
      expect(outcome.getAttribute('role')).toBe('status');
      expect(outcome.getAttribute('aria-live')).toBe('polite');
    });

    it('claims NOTHING before the server commits, then shows the committed result', async () => {
      // The server answers with something DIFFERENT from what was requested —
      // VIEWER in another branch. The screen must show the SERVER's answer, so
      // an outcome built from the request would be visibly wrong here.
      changeResponse = row({ role: 'VIEWER', store: { id: 'store-b', name: 'Norte' } });
      const r = await page();
      await flush();
      const before = listCalls().length;
      await openModal(r);
      await select(el(r, 'access-role'), 'EDITOR');
      await click(el(r, 'submit-access'));
      await flush();

      // Modal closed, list re-read from the server, outcome states the
      // COMMITTED role and scope — not the one that was requested.
      expect(el(r, 'submit-access')).toBeNull();
      expect(listCalls().length).toBeGreaterThan(before);
      const outcome = el(r, 'access-outcome')!.textContent ?? '';
      // Both halves of the committed access, not just the branch.
      expect(outcome).toMatch(/Branch:\s*Acme · Norte/);
      expect(outcome).toMatch(/ana@acme.com/);
      expect(outcome).not.toMatch(/Centro/);
      expect(toast.success).toHaveBeenCalled();
    });

    it('a refusal keeps the modal open, shows the server’s words, and claims no success', async () => {
      changeRejects = new Error('An organization must keep at least one active manager');
      const r = await page();
      await flush();
      await openModal(r);
      await select(el(r, 'access-role'), 'VIEWER');
      await click(el(r, 'submit-access'));
      await flush();

      expect(el(r, 'submit-access')).not.toBeNull();
      expect(el(r, 'access-error')!.textContent).toBe('An organization must keep at least one active manager');
      expect(toast.success).not.toHaveBeenCalled();
      expect(el(r, 'access-outcome')).toBeNull();
    });

    it('offers no Change access for a user with no company — the contract has no subject', async () => {
      pageResponse = { items: [row({ id: 'u-9', organization: null, store: null, role: 'SUPER_ADMIN' })], total: 1, page: 1, limit: 25, totalPages: 1 };
      const r = await page();
      await flush();
      expect(el(r, 'change-access-u-9')).toBeNull();
    });
  });

  it('says so plainly when nothing matches', async () => {
    pageResponse = { items: [], total: 0, page: 1, limit: 25, totalPages: 1 };
    const r = await page();
    await flush();
    expect(r.text()).toMatch(/No users match these filters/i);
  });

  it('surfaces a load failure instead of rendering an empty directory', async () => {
    pageResponse = undefined;
    const r = await page();
    await flush();
    // An undefined page is not "no users": the screen must not present a
    // failure as an empty population.
    expect(el(r, 'platform-users-error') || el(r, 'platform-users-loading')).not.toBeNull();
  });
});
