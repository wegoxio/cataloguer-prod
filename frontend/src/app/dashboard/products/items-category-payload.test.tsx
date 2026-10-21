import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { renderComponent, cleanupAll, click, flush } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';

/**
 * THE CATEGORIES A SAVE CARRIES.
 *
 * The form has always computed `categoryIds` from the ticked boxes, and this
 * page dropped them, sending the legacy single-category key instead — for
 * which the form has no input, so its value was always `null`. The endpoint
 * treats a PRESENT-AND-NULL `categoryId` as "replace with nothing", so a save
 * cleared the item's categories whatever field was being edited, and ticking
 * a category could never stick: the selection never left the browser.
 *
 * The contract now: an existing item sends `categoryIds` ONLY when the ticked
 * set differs from the complete set it was opened with (archived categories
 * included, order ignored), and then sends it whole — `[]` when the reader
 * unticked everything. An unchanged set sends neither `categoryIds` nor
 * `categoryId`. Creation always sends the form's set.
 *
 * These tests read the BODY, because the body is the promise. Asserting on
 * the screen would pass against a page that sends the wrong thing and then
 * re-renders from its own optimistic state.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) =>
    React.createElement('a', rest, children),
}));
const toast = { success: vi.fn(), error: vi.fn(), undo: vi.fn() };
vi.mock('../../../components/ui/toast', () => ({ useToast: () => toast }));
vi.mock('../../../lib/use-website-config', () => ({
  useStores: () => ({ stores: [{ id: 'store-a', name: 'EliteToGo', slug: 'elite', archivedAt: null }] }),
  buildWebsiteUrl: () => 'https://example.test',
}));

/** The acting scope. A store-bound actor has no company-wide store authority. */
let storeScoped = false;
vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'manager@elite.example', role: 'ORGANIZATION_MANAGER' },
    scope: {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId: 'org-1',
      storeId: storeScoped ? 'store-a' : null,
      allowedStoreIds: ['store-a'],
    },
    accessToken: 'token',
  }),
}));

const SALSAS = { id: 'cat-salsas', name: 'Salsas', archivedAt: null };
const ENTRADAS = { id: 'cat-entradas', name: 'Entradas', archivedAt: null };
/** Archived, but still linked to items filed under it before it was archived. */
const TEMPORADA = { id: 'cat-temporada', name: 'Temporada', archivedAt: '2026-09-01T00:00:00.000Z' };

/** A standalone item, already filed under Salsas. */
const standalone = (categories: unknown[] = [SALSAS]) => ({
  id: 'prod-1',
  name: 'Salsa Agridulce',
  slug: 'salsa-agridulce',
  status: 'PUBLISHED',
  price: 4,
  stockQuantity: 0,
  trackInventory: false,
  categories,
});

/** A family card: the form hides stock and sale price for one of these. */
const card = () => ({
  ...standalone(),
  id: 'prod-card',
  name: 'Alioli',
  children: [{ id: 'child-1', name: 'Alioli (Pequeña)' }],
});

let rows: Record<string, unknown>[] = [];
/** What `GET /products/:id` answers, for the `?edit=` deep link. */
let detail: Record<string, unknown> | null = null;
/** Every write the page made, captured verbatim. */
let writes: { path: string; method: string; body: Record<string, unknown> }[] = [];

vi.mock('../../../lib/api-client', () => ({
  apiFetch: (path: string, options: { method?: string; body?: string } = {}) => {
    const method = options.method ?? 'GET';
    if (method !== 'GET') {
      writes.push({ path, method, body: options.body ? JSON.parse(options.body) : {} });
      return Promise.resolve({ data: null });
    }
    if (path.startsWith('/products?'))
      return Promise.resolve({ items: rows, total: rows.length, page: 1, limit: 25, totalPages: 1 });
    // As the endpoint does: archived categories only when asked for, and this
    // page does not ask — so an archived filing never renders as a checkbox.
    if (path.startsWith('/categories'))
      return Promise.resolve({
        items: path.includes('includeArchived=true') ? [SALSAS, ENTRADAS, TEMPORADA] : [SALSAS, ENTRADAS],
      });
    if (path.startsWith('/products/family-suggestions'))
      return Promise.resolve({ data: [], readyCount: 0, blockedCount: 0 });
    if (detail && path === `/products/${detail.id}`) return Promise.resolve({ data: detail });
    return Promise.resolve({ data: null });
  },
}));

import ProductsPage from './page';

const mount = async (url = '/dashboard/products') => {
  window.history.replaceState({}, '', url);
  const r = await renderComponent(
    <I18nProvider>
      <ProductsPage />
    </I18nProvider>,
  );
  for (let i = 0; i < 6; i += 1) await flush();
  return r;
};

/** Opens the row's editor through the same Edit control a reader uses. */
const openEditor = async (r: { container: HTMLElement }) => {
  const edit = Array.from(r.container.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === 'Edit',
  );
  if (!edit) throw new Error('no Edit button on the row');
  await click(edit);
  for (let i = 0; i < 3; i += 1) await flush();
};

/** Opens an empty form through the Add Item control. */
const openCreate = async (r: { container: HTMLElement }) => {
  const add = Array.from(r.container.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === 'Add Item',
  );
  if (!add) throw new Error('no Add Item button');
  await click(add);
  for (let i = 0; i < 3; i += 1) await flush();
};

const typeInto = async (r: { container: HTMLElement }, name: string, value: string) => {
  const input = r.container.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (!input) throw new Error(`no ${name} input`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await flush();
};

/**
 * Submits through the FORM, not the button: jsdom does not implement implicit
 * form submission from a click, so a button click would silently assert
 * nothing. React's `onSubmit` listens on the form element itself.
 */
const save = async (r: { container: HTMLElement }) => {
  const form = r.container.querySelector('form');
  if (!form) throw new Error('no form');
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  for (let i = 0; i < 4; i += 1) await flush();
};

/** The category checkbox labelled `name`. */
const categoryBox = (r: { container: HTMLElement }, name: string) => {
  const box = Array.from(r.container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find(
    (b) => (b.closest('label')?.textContent?.trim() ?? '') === name,
  );
  if (!box) throw new Error(`no ${name} checkbox`);
  return box;
};

const toggle = async (box: HTMLInputElement) => {
  await click(box);
  await flush();
};

const lastBody = () => {
  expect(writes.length, 'exactly one write left the page').toBe(1);
  return writes[0].body;
};

const has = (body: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(body, key);

/** The body says nothing about categories: neither the new key nor the legacy one. */
const expectNoCategoryKeys = (body: Record<string, unknown>) => {
  expect(has(body, 'categoryIds'), 'categoryIds must be absent for an unchanged set').toBe(false);
  expect(has(body, 'categoryId'), 'the legacy categoryId must never be sent').toBe(false);
};

const sorted = (ids: unknown) => [...(ids as string[])].sort();

describe('the categories an Items save carries', () => {
  beforeEach(() => {
    rows = [standalone()];
    detail = null;
    writes = [];
    storeScoped = false;
  });
  afterEach(() => {
    cleanupAll();
    window.history.replaceState({}, '', '/dashboard/products');
  });

  describe('an existing item whose set did not change', () => {
    it('says nothing about categories on a price-only save', async () => {
      const r = await mount();
      await openEditor(r);
      await typeInto(r, 'price', '9');
      await save(r);

      const body = lastBody();
      expect(writes[0].method).toBe('PATCH');
      expect(body.price).toBe(9);
      expectNoCategoryKeys(body);
    });

    it('says nothing for a multi-category item either', async () => {
      rows = [standalone([SALSAS, ENTRADAS])];
      const r = await mount();
      await openEditor(r);
      await typeInto(r, 'price', '9');
      await save(r);

      expectNoCategoryKeys(lastBody());
    });

    it('does not count a different order as a change', async () => {
      // Opened as [Entradas, Salsas]; unticking and re-ticking Entradas leaves
      // the form holding [Salsas, Entradas] — the same set in another order.
      rows = [standalone([ENTRADAS, SALSAS])];
      const r = await mount();
      await openEditor(r);
      await toggle(categoryBox(r, ENTRADAS.name));
      await toggle(categoryBox(r, ENTRADAS.name));
      await save(r);

      expectNoCategoryKeys(lastBody());
    });

    it('says nothing when the unchanged set holds an archived category', async () => {
      // The endpoint refuses an archived category anywhere in `categoryIds`, so
      // restating this set would turn a price-only save into an error. The
      // archived id is not on screen but IS in the form's set, so this also
      // proves the comparison is against the complete original set: comparing
      // against the visible categories alone would see a change here.
      rows = [standalone([SALSAS, TEMPORADA])];
      const r = await mount();
      await openEditor(r);
      await typeInto(r, 'price', '9');
      await save(r);

      expectNoCategoryKeys(lastBody());
    });

    it('says nothing from a family card, which sends fewer fields', async () => {
      rows = [card()];
      const r = await mount();
      await openEditor(r);
      await save(r);

      const body = lastBody();
      expect(has(body, 'stockQuantity'), 'the card branch ran').toBe(false);
      expectNoCategoryKeys(body);
    });

    it('says nothing for an actor without company-wide store authority', async () => {
      storeScoped = true;
      const r = await mount();
      await openEditor(r);
      await save(r);

      const body = lastBody();
      expectNoCategoryKeys(body);
      // #282: a branch actor still sends no membership keys at all.
      expect(has(body, 'storeIds')).toBe(false);
    });
  });

  describe('an existing item whose set changed', () => {
    it('sends the whole new set when a category is added', async () => {
      const r = await mount();
      await openEditor(r);
      await toggle(categoryBox(r, ENTRADAS.name));
      await save(r);

      const body = lastBody();
      expect(sorted(body.categoryIds)).toEqual(sorted([SALSAS.id, ENTRADAS.id]));
      expect(has(body, 'categoryId')).toBe(false);
    });

    it('sends the remaining set when one of several is removed', async () => {
      rows = [standalone([SALSAS, ENTRADAS])];
      const r = await mount();
      await openEditor(r);
      await toggle(categoryBox(r, ENTRADAS.name));
      await save(r);

      expect(lastBody().categoryIds).toEqual([SALSAS.id]);
    });

    it('sends an empty list when the reader deliberately unassigns every category', async () => {
      rows = [standalone([SALSAS, ENTRADAS])];
      const r = await mount();
      await openEditor(r);
      await toggle(categoryBox(r, SALSAS.name));
      await toggle(categoryBox(r, ENTRADAS.name));
      await save(r);

      const body = lastBody();
      // `[]` is the reader's decision and must be distinguishable from silence,
      // which would leave the old filing in place.
      expect(has(body, 'categoryIds')).toBe(true);
      expect(body.categoryIds).toEqual([]);
      expect(has(body, 'categoryId')).toBe(false);
    });

    it('sends the change from a family card', async () => {
      rows = [card()];
      const r = await mount();
      await openEditor(r);
      await toggle(categoryBox(r, ENTRADAS.name));
      await save(r);

      expect(sorted(lastBody().categoryIds)).toEqual(sorted([SALSAS.id, ENTRADAS.id]));
    });

    it('sends the change for an actor without company-wide store authority', async () => {
      storeScoped = true;
      const r = await mount();
      await openEditor(r);
      await toggle(categoryBox(r, SALSAS.name));
      await save(r);

      const body = lastBody();
      expect(body.categoryIds).toEqual([]);
      expect(has(body, 'storeIds')).toBe(false);
    });
  });

  describe('the ?edit= deep link', () => {
    // The row list is EMPTY, so the only source of the item's categories is the
    // fetched detail: nothing here can be satisfied from a list row.
    beforeEach(() => {
      rows = [];
      detail = standalone([SALSAS, ENTRADAS]);
    });

    it('compares against the fetched set and says nothing when it is unchanged', async () => {
      const r = await mount('/dashboard/products?edit=prod-1');
      await typeInto(r, 'price', '9');
      await save(r);

      const body = lastBody();
      expect(writes[0].path).toBe('/products/prod-1');
      expect(body.price).toBe(9);
      expectNoCategoryKeys(body);
    });

    it('sends the remaining set when the reader removes one', async () => {
      const r = await mount('/dashboard/products?edit=prod-1');
      await toggle(categoryBox(r, SALSAS.name));
      await save(r);

      expect(lastBody().categoryIds).toEqual([ENTRADAS.id]);
    });
  });

  describe('creating an item', () => {
    beforeEach(() => {
      rows = [];
    });

    it('sends an empty list when nothing is ticked', async () => {
      const r = await mount();
      await openCreate(r);
      await typeInto(r, 'name', 'Salsa de Ajo');
      await save(r);

      const body = lastBody();
      expect(writes[0].method).toBe('POST');
      expect(has(body, 'categoryIds')).toBe(true);
      expect(body.categoryIds).toEqual([]);
      expect(has(body, 'categoryId')).toBe(false);
    });

    it('sends the ticked set', async () => {
      const r = await mount();
      await openCreate(r);
      await typeInto(r, 'name', 'Salsa de Ajo');
      await toggle(categoryBox(r, SALSAS.name));
      await toggle(categoryBox(r, ENTRADAS.name));
      await save(r);

      const body = lastBody();
      expect(writes[0].method).toBe('POST');
      expect(sorted(body.categoryIds)).toEqual(sorted([SALSAS.id, ENTRADAS.id]));
    });
  });
});
