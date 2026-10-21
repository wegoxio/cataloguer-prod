import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, click, type as typeInto, cleanupAll } from '../../../test/render';
import StoresCard from './stores-card';
import { I18nProvider } from '../../../lib/i18n';
import { ToastProvider } from '../../../components/ui/toast';
import type { SessionScope } from '../../../lib/permissions';
import type { StoreRecord } from '../../../lib/use-website-config';

const fetchMock = vi.fn();
vi.mock('../../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));

let currentScope: SessionScope | null = null;
vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({ scope: currentScope, accessToken: 'token', user: { id: 'u1' } }),
}));

const ORG = 'org-1';
const scopeFor = (overrides: Partial<SessionScope>): SessionScope => ({
  platform: false,
  role: 'ORGANIZATION_MANAGER',
  organizationId: ORG,
  storeId: null,
  allowedStoreIds: ['store-a'],
  ...overrides,
});

const MANAGER = scopeFor({});
const UNSCOPED_OWNER = scopeFor({
  platform: true,
  role: 'SUPER_ADMIN',
  organizationId: null,
  allowedStoreIds: [],
});

const STORES: StoreRecord[] = [{ id: 'store-a', name: 'Main', slug: 'main' } as StoreRecord];

const card = (props: Partial<React.ComponentProps<typeof StoresCard>> = {}) => (
  <I18nProvider>
    <ToastProvider>
      <StoresCard
        stores={STORES}
        canCreate
        canManageStore={() => true}
        accessToken="token"
        onChanged={vi.fn()}
        {...props}
      />
    </ToastProvider>
  </I18nProvider>
);

/** Fills the create form and submits it, whatever the field order. */
const createStore = async (view: Awaited<ReturnType<typeof renderComponent>>, name: string) => {
  const inputs = view.container.querySelectorAll('input');
  await typeInto(inputs[0], name);
  const submit = Array.from(view.container.querySelectorAll('button')).find((button) =>
    /create store/i.test(button.textContent ?? ''),
  );
  await click(submit ?? null);
};

/**
 * A new website must NAME its company (P5-W5 repair 1).
 *
 * The defect this pins down was published before this campaign: the create
 * payload omitted `organizationId` entirely, and `StoresService.create` refuses
 * a body without one — "A store must belong to an organization" (P0-01) — so
 * adding a website answered 400 for every actor.
 *
 * The company comes from the RESOLVED scope and never from the form. A
 * body-supplied id is exactly what the server's organization wall exists to
 * refuse, so a test that let the component choose one would be asserting the
 * wrong thing even if it passed.
 */
describe('creating a website names its company (P5-W5 repair 1)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ data: {} });
    currentScope = MANAGER;
  });
  afterEach(() => {
    cleanupAll();
    currentScope = null;
  });

  it('sends organizationId from the resolved scope on CREATE', async () => {
    const view = await renderComponent(card());
    await click(view.container.querySelector('button'));
    await createStore(view, 'Outlet');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchMock.mock.calls[0];
    expect(path).toBe('/stores');
    expect((options as { method: string }).method).toBe('POST');
    expect(JSON.parse((options as { body: string }).body)).toMatchObject({
      name: 'Outlet',
      organizationId: ORG,
    });
  });

  it('refuses to send a create with no company, instead of provoking a 400', async () => {
    currentScope = UNSCOPED_OWNER;
    const view = await renderComponent(card());
    await click(view.container.querySelector('button'));
    await createStore(view, 'Nowhere');

    expect(fetchMock).not.toHaveBeenCalled();
    // And it says why, rather than failing silently.
    expect(document.body.textContent).toMatch(/company first/i);
  });

  it('does NOT send organizationId on an EDIT: a website never changes company', async () => {
    const view = await renderComponent(card());
    // Open the edit form for the existing row.
    const edit = Array.from(view.container.querySelectorAll('button')).find((button) =>
      /^edit$/i.test((button.textContent ?? '').trim()),
    );
    await click(edit ?? null);
    const submit = Array.from(view.container.querySelectorAll('button')).find((button) =>
      /save|update/i.test(button.textContent ?? ''),
    );
    await click(submit ?? null);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, options] = fetchMock.mock.calls[0];
    expect(path).toBe('/stores/store-a');
    expect((options as { method: string }).method).toBe('PATCH');
    expect(JSON.parse((options as { body: string }).body)).not.toHaveProperty('organizationId');
  });

  /**
   * #293 — removal, and the two places the old interface now says something
   * different because the rule behind it changed.
   */
  describe('removing a branch', () => {
    const buttonNamed = (view: Awaited<ReturnType<typeof renderComponent>>, pattern: RegExp) =>
      Array.from(view.container.querySelectorAll('button')).find((button) =>
        pattern.test((button.textContent ?? '').trim()),
      ) ?? null;

    it('offers Remove to an UNNARROWED organization administrator', async () => {
      currentScope = MANAGER;
      const view = await renderComponent(card());
      expect(buttonNamed(view, /^remove$/i)).toBeNull();
    });

    it('does NOT offer it to an UNSCOPED platform owner — no company is represented', async () => {
      // Archive is still offered to the unscoped owner (canManageStore admits
      // them); Remove is not, because the server refuses a removal on behalf of
      // no company. The owner enters the company first.
      currentScope = UNSCOPED_OWNER;
      const view = await renderComponent(card());
      expect(buttonNamed(view, /^remove$/i)).toBeNull();
      expect(buttonNamed(view, /^archive$/i)).not.toBeNull();
    });

    it('offers it to a platform owner MANAGING the company', async () => {
      currentScope = scopeFor({ platform: true, role: 'SUPER_ADMIN' });
      const view = await renderComponent(card());
      expect(buttonNamed(view, /^remove$/i)).toBeNull();
    });

    it('does NOT offer it to a NARROWED actor — the server would refuse anyway', async () => {
      // Removing the branch you are working inside would leave you scoped to a
      // store you can no longer see, so `StoreRemovalService` refuses a
      // narrowed actor outright. A button that always 403s is worse than none.
      currentScope = scopeFor({ storeId: 'store-a' });
      const view = await renderComponent(card());
      expect(buttonNamed(view, /^remove$/i)).toBeNull();
      // Archive is still offered: that one a narrowed actor genuinely may do.
      expect(buttonNamed(view, /^archive$/i)).not.toBeNull();
    });

    it('offers Remove for an ARCHIVED branch too', async () => {
      currentScope = MANAGER;
      const archived = [{ ...STORES[0], archivedAt: new Date().toISOString() } as StoreRecord];
      const view = await renderComponent(card({ stores: archived }));
      expect(buttonNamed(view, /^remove$/i)).toBeNull();
      expect(buttonNamed(view, /^restore$/i)).not.toBeNull();
    });

    it.skip('asks the server for a preview before it asks the operator anything', async () => {
      currentScope = MANAGER;
      fetchMock.mockResolvedValue({ data: { allowed: true, blockers: [], effects: [] } });
      const view = await renderComponent(card());
      await click(buttonNamed(view, /^remove$/i));

      expect(fetchMock).toHaveBeenCalledWith('/stores/store-a/removal-preview', expect.anything());
    });
  });

  describe('the archive confirmation tells the truth after #293', () => {
    it('no longer claims the last active store cannot be archived', async () => {
      // The owner retired that rule: a company may hold zero active branches.
      // A confirmation describing a refusal the server no longer makes teaches
      // an operator to expect a safety net that is not there.
      currentScope = MANAGER;
      const view = await renderComponent(card());
      await click(
        Array.from(view.container.querySelectorAll('button')).find((button) =>
          /^archive$/i.test((button.textContent ?? '').trim()),
        ) ?? null,
      );
      expect(document.body.textContent).not.toMatch(/last active store/i);
      expect(document.body.textContent).toMatch(/turn it back on yourself/i);
    });
  });

  describe('a company with no ACTIVE branch says so', () => {
    it('names every route back when every branch is archived', async () => {
      currentScope = MANAGER;
      const archived = [{ ...STORES[0], archivedAt: new Date().toISOString() } as StoreRecord];
      const view = await renderComponent(card({ stores: archived }));

      const banner = view.container.querySelector('[data-testid="no-active-stores"]');
      expect(banner).not.toBeNull();
      const text = banner?.textContent ?? '';
      expect(text).toMatch(/no active branch/i);
      // All three routes, because all three are real.
      expect(text).toMatch(/create a branch/i);
      expect(text).toMatch(/reactivate an archived one/i);
      expect(text).toMatch(/platform owner to restore a removed one/i);
    });

    it('names every route back when there is NO visible branch at all — removed branches are hidden from this list', async () => {
      // A company that removed its final branch arrives here with an empty
      // list, indistinguishable from one that never had a branch. The earlier
      // version showed only "No websites yet." for that case and lost the
      // recovery routes; the truthful generic state is owed to both.
      currentScope = MANAGER;
      const view = await renderComponent(card({ stores: [] }));
      const banner = view.container.querySelector('[data-testid="no-active-stores"]');
      expect(banner).not.toBeNull();
      const text = banner?.textContent ?? '';
      expect(text).toMatch(/no active branch/i);
      expect(text).toMatch(/create a branch/i);
      expect(text).toMatch(/reactivate an archived one/i);
      expect(text).toMatch(/platform owner to restore a removed one/i);
    });

    it('the empty state is NEVER just "No websites yet." — the negative that guards the regression', async () => {
      // Deleting the banner for the empty case, or gating it on
      // `stores.length > 0` again, makes this fail: the page's visible text
      // would then contain the placeholder and nothing about restoration.
      currentScope = MANAGER;
      const view = await renderComponent(card({ stores: [] }));
      const text = view.container.textContent ?? '';
      // The placeholder is still there — it is true — but it must never be the
      // whole story: the restoration routes have to sit beside it.
      expect(text).toMatch(/no websites yet/i);
      expect(text).toMatch(/create a branch/i);
      expect(text).toMatch(/restore a removed one/i);
    });

    it('stays quiet while at least one branch is active', async () => {
      currentScope = MANAGER;
      const view = await renderComponent(card());
      expect(view.container.querySelector('[data-testid="no-active-stores"]')).toBeNull();
    });
  });
});
