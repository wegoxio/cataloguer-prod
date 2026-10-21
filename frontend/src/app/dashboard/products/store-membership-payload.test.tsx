import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click, type, flush } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';

/**
 * WHAT ACTUALLY GOES ON THE WIRE (#282).
 *
 * The component test proves the form hands membership over only when the actor
 * may replace it. This proves the page turns that into a REQUEST BODY with the
 * properties absent — which is the thing the endpoint reads. A body carrying
 * `storeIds: []`, or the product's current stores restated, is refused exactly
 * like the defect was:
 *
 *     Replacing store membership is a company-wide operation.
 *
 * The scope is what decides, so the mocked `useAuth` is the switch each case
 * flips. Nothing here infers authority from how many stores exist.
 */

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) =>
    React.createElement('a', rest, children),
}));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../../../components/ui/toast', () => ({ useToast: () => toast }));

const STORES = [
  { id: 'store-a', name: 'Main', slug: 'main', archivedAt: null },
  { id: 'store-b', name: 'Outlet', slug: 'outlet', archivedAt: null },
];
let visibleStores = STORES;
vi.mock('../../../lib/use-website-config', () => ({
  useStores: () => ({ stores: visibleStores }),
  buildWebsiteUrl: () => 'https://example.test',
}));

/** The resolved scope under test: `storeId` set == branch-scoped. */
let scope: Record<string, unknown> = {};
vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'admin@elite.example', role: 'ADMIN' },
    scope,
    accessToken: 'token',
  }),
}));

const PRODUCT = {
  id: 'p-1',
  name: 'Lámpara',
  status: 'DRAFT',
  price: 10,
  stockQuantity: 0,
  trackInventory: false,
  stores: [{ id: 'store-a', name: 'Main' }],
  categories: [],
  children: [],
};

let calls: { path: string; method: string; body: any }[] = [];
vi.mock('../../../lib/api-client', () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    if (path.startsWith('/products?')) {
      return { data: { items: [PRODUCT], totalPages: 1, total: 1 } };
    }
    if (path.startsWith('/categories')) return { data: { items: [] } };
    if (path.startsWith('/products/family-suggestions')) return { data: [] };
    return { data: PRODUCT };
  },
}));

import ProductsPage from './page';

const BRANCH = {
  platform: false,
  role: 'ADMIN',
  organizationId: 'org-1',
  storeId: 'store-a',
  allowedStoreIds: ['store-a'],
};
const COMPANY_WIDE = {
  platform: false,
  role: 'ORGANIZATION_MANAGER',
  organizationId: 'org-1',
  storeId: null,
  allowedStoreIds: ['store-a', 'store-b'],
};

const page = () =>
  renderComponent(
    <I18nProvider>
      <ProductsPage />
    </I18nProvider>,
  );

const button = (r: { container: HTMLElement }, label: RegExp): HTMLElement => {
  const found = Array.from(r.container.querySelectorAll('button')).find((b) => label.test(b.textContent ?? ''));
  if (!found) throw new Error(`no button matching ${label}`);
  return found as HTMLElement;
};

/**
 * Opens the editor through the page's OWN supported entry point — the
 * `?edit=<id>` deep link the item detail page uses — rather than hunting for an
 * icon in the table. The route under test is the save, not the way in.
 */
const openEditor = async () => {
  window.history.replaceState({}, '', '/dashboard/products?edit=p-1');
  const r = await page();
  await flush();
  await flush();
  return r;
};

const submitForm = async (r: { container: HTMLElement }) => {
  const form = r.container.querySelector('form');
  if (!form) throw new Error('the editor did not open');
  await (await import('react')).act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await flush();
};

const productWrite = () => calls.find((c) => c.method === 'PATCH' || (c.method === 'POST' && c.path === '/products'));

describe('#282 · the request body carries membership only for a company-wide actor', () => {
  beforeEach(() => {
    calls = [];
    visibleStores = STORES;
    toast.success.mockReset();
    toast.error.mockReset();
  });
  afterEach(() => cleanupAll());

  it('BRANCH-SCOPED edit: the PATCH body has neither storeIds nor storePrices', async () => {
    scope = BRANCH;
    const r = await openEditor();
    await submitForm(r);

    const write = productWrite();
    expect(write?.method).toBe('PATCH');
    expect(write?.path).toBe('/products/p-1');
    expect(Object.keys(write!.body)).not.toContain('storeIds');
    expect(Object.keys(write!.body)).not.toContain('storePrices');
    // Serialized, because the endpoint reads the JSON and not our object.
    expect(JSON.stringify(write!.body)).not.toMatch(/storeIds|storePrices/);
    // The rest of the edit is intact — this is not a crippled form.
    expect(write!.body.name).toBe('Lámpara');
    expect(write!.body).toHaveProperty('status');
    expect(write!.body).toHaveProperty('price');
  });

  it('COMPANY-WIDE edit: the PATCH body still carries both, unchanged', async () => {
    scope = COMPANY_WIDE;
    const r = await openEditor();
    await submitForm(r);

    const write = productWrite();
    expect(write?.method).toBe('PATCH');
    expect(Object.keys(write!.body)).toContain('storeIds');
    expect(Object.keys(write!.body)).toContain('storePrices');
    expect(write!.body.storeIds).toEqual(['store-a']);
  });

  it.each([
    ['one-store company', [STORES[0]]],
    ['multi-store company', STORES],
  ])('a branch-scoped actor in a %s omits both', async (_label, stores) => {
    scope = BRANCH;
    visibleStores = stores;
    const r = await openEditor();
    await submitForm(r);

    const write = productWrite();
    expect(JSON.stringify(write!.body)).not.toMatch(/storeIds|storePrices/);
  });

  it('BRANCH-SCOPED create: the POST body omits both, so the backend assigns the resolved store', async () => {
    scope = BRANCH;
    const r = await page();
    await click(button(r, /Add Item|Nuevo art/));
    await flush();
    const nameInput = r.container.querySelector<HTMLElement>('input[name="name"]');
    const priceInput = r.container.querySelector<HTMLElement>('input[name="price"]');
    if (!nameInput || !priceInput) throw new Error('the create form did not open');
    await type(nameInput, 'Nueva');
    await type(priceInput, '25');
    await submitForm(r);

    const write = productWrite();
    expect(write?.method).toBe('POST');
    expect(write?.path).toBe('/products');
    expect(JSON.stringify(write!.body)).not.toMatch(/storeIds|storePrices/);
  });
});
