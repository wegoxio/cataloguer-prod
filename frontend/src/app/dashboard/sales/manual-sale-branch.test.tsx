import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click, select, flush } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import SalesPage from './page';

/**
 * #295 G1 acceptance correction — the manual sale ("Add Sale") shares the
 * invoice editor's branch decision. The first case is the same production
 * failure: a company-wide actor with one live branch sent no branch.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) => React.createElement('a', rest, children),
}));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('../../../components/ui/toast', () => ({ useToast: () => toast }));
let auth: { user: unknown; scope: unknown; accessToken: string } = { user: null, scope: null, accessToken: 't' };
vi.mock('../../../lib/auth', () => ({ useAuth: () => auth }));
let storesState: { stores: unknown[]; loaded: boolean } = { stores: [], loaded: true };
vi.mock('../../../lib/use-website-config', () => ({ useStores: () => ({ ...storesState, refresh: () => undefined }) }));
const calls: { path: string; method: string; body?: any }[] = [];
vi.mock('../../../lib/api-client', () => ({
  apiFetch: async (path: string, init?: { method?: string; body?: string }) => {
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body) : undefined });
    if (path.startsWith('/products')) return { items: [{ id: 'p-1', name: 'Thing', price: '5.00', salePrice: null }] };
    if (path === '/sales' && init?.method === 'POST') return { data: { orderNumber: '1001', totalUsd: '5.00' } };
    if (path.startsWith('/sales')) return { items: [], total: 0, page: 1, limit: 100, totalPages: 1 };
    if (path.startsWith('/invoices')) return { items: [], total: 0 };
    return { data: null };
  },
}));

const live = (id: string, name = `Branch ${id}`) => ({ id, name, archivedAt: null, removedAt: null });
const companyManager = (allowed: string[]) => ({ platform: false, role: 'ORGANIZATION_MANAGER', organizationId: 'org-1', storeId: null, allowedStoreIds: allowed });
const managedOwner = (allowed: string[]) => ({ platform: true, role: 'SUPER_ADMIN', organizationId: 'org-1', storeId: null, allowedStoreIds: allowed });
const salePosts = () => calls.filter((c) => c.method === 'POST' && c.path === '/sales');

const openSale = async () => {
  const view = await renderComponent(React.createElement(I18nProvider, null, React.createElement(SalesPage)));
  await flush();
  await flush();
  const opener = Array.from(view.container.querySelectorAll('button')).find((b) => /Add Sale|Añadir venta/.test(b.textContent ?? ''));
  if (!opener) throw new Error('no Add Sale button');
  await click(opener);
  await flush();
  await flush();
  return view;
};
const pickItem = async () => {
  const itemSelect = Array.from(document.querySelectorAll('select')).find((s) => Array.from(s.options).some((o) => o.value === 'p-1'));
  if (!itemSelect) throw new Error('item picker has no catalogue option');
  await select(itemSelect, 'p-1');
  await flush();
};
const submit = (view: { get: (id: string) => HTMLElement }) => view.get('sale-submit') as HTMLButtonElement;

describe('Manual sale — branch target (#295 G1 acceptance)', () => {
  beforeEach(() => {
    cleanupAll();
    calls.length = 0;
    toast.error.mockReset();
    toast.success.mockReset();
    window.localStorage.setItem('wegox-lang', 'en');
    storesState = { stores: [live('b-1', 'Centro')], loaded: true };
    auth = { user: { id: 'u-1', store: null }, scope: companyManager(['b-1']), accessToken: 't' };
  });

  it.each([
    ['an organization manager', companyManager(['b-1'])],
    ['the owner acting as the company ("All branches")', managedOwner(['b-1'])],
  ])('THE ACCEPTANCE FAILURE — %s with exactly one live branch: the sale is recorded on it without a picker', async (_label, scope) => {
    auth = { ...auth, scope };
    const view = await openSale();
    expect(view.find('branch-target-picker')).toBeNull();
    expect(view.get('branch-target-single').textContent).toContain('Centro');
    await pickItem();
    expect(submit(view).disabled).toBe(false);
    await click(submit(view));
    await flush();
    expect(salePosts()).toHaveLength(1);
    expect(salePosts()[0].body.storeId).toBe('b-1');
  });

  it('several live branches: nothing is sent until one is chosen; the chosen branch is sent', async () => {
    storesState = { stores: [live('b-1'), live('b-2')], loaded: true };
    auth = { ...auth, scope: companyManager(['b-1', 'b-2']) };
    const view = await openSale();
    expect(view.find('branch-target-picker')).not.toBeNull();
    await select(view.get('branch-target-picker'), 'b-2');
    await flush();
    await flush();
    await pickItem();
    await click(submit(view));
    await flush();
    expect(salePosts()[0].body.storeId).toBe('b-2');
  });

  it('several live branches with no choice yet: the submit is disabled and no sale is sent', async () => {
    storesState = { stores: [live('b-1'), live('b-2')], loaded: true };
    auth = { ...auth, scope: companyManager(['b-1', 'b-2']) };
    const view = await openSale();
    await pickItem().catch(() => undefined);
    expect(submit(view).disabled).toBe(true);
    await click(submit(view));
    await flush();
    expect(salePosts()).toHaveLength(0);
  });

  it('zero live branches: a truthful blocked state, the submit is disabled, and no sale is sent', async () => {
    storesState = { stores: [{ id: 'b-a', name: 'Old', archivedAt: '2026-09-01T00:00:00Z', removedAt: null }], loaded: true };
    auth = { ...auth, scope: companyManager([]) };
    const view = await openSale();
    expect(view.find('branch-target-none')).not.toBeNull();
    expect(submit(view).disabled).toBe(true);
    await click(submit(view));
    await flush();
    expect(salePosts()).toHaveLength(0);
  });

  it('a branch-bound actor records the sale on its own branch', async () => {
    storesState = { stores: [live('b-1'), live('b-2')], loaded: true };
    auth = { user: { id: 'u-2', store: { id: 'b-2' } }, scope: { platform: false, role: 'ADMIN', organizationId: 'org-1', storeId: 'b-2', allowedStoreIds: ['b-2'] }, accessToken: 't' };
    const view = await openSale();
    expect(view.find('branch-target-picker')).toBeNull();
    await pickItem();
    await click(submit(view));
    await flush();
    expect(salePosts()[0].body.storeId).toBe('b-2');
  });
});
