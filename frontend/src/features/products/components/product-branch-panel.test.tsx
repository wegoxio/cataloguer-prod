import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, click, cleanupAll } from '../../../test/render';
import ProductBranchPanel, { STORE_OWNED_FIELDS, toBranchRows } from './product-branch-panel';
import { I18nProvider } from '../../../lib/i18n';
import { ToastProvider } from '../../../components/ui/toast';
import type { SessionScope } from '../../../lib/permissions';
import type { Product } from '../types/product.types';
import type { StoreRecord } from '../../../lib/use-website-config';

const fetchMock = vi.fn();
vi.mock('../../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));

const ORG = 'org-1';
const MAIN = 'store-main';
const OUTLET = 'store-outlet';

const scopeFor = (overrides: Partial<SessionScope>): SessionScope => ({
  platform: false,
  role: 'ORGANIZATION_MANAGER',
  organizationId: ORG,
  storeId: null,
  allowedStoreIds: [MAIN, OUTLET],
  ...overrides,
});

const MANAGER = scopeFor({});
const NARROWED_MANAGER = scopeFor({ storeId: MAIN });
const ADMIN_MAIN = scopeFor({ role: 'ADMIN', storeId: MAIN, allowedStoreIds: [MAIN] });
const VIEWER = scopeFor({ role: 'VIEWER', storeId: MAIN, allowedStoreIds: [MAIN] });

const STORES: StoreRecord[] = [
  { id: MAIN, name: 'Main', slug: 'main' } as StoreRecord,
  { id: OUTLET, name: 'Outlet', slug: 'outlet' } as StoreRecord,
  { id: 'store-gone', name: 'Closed', slug: 'closed', archivedAt: '2026-01-01' } as StoreRecord,
];

const PRODUCT: Product = {
  id: 'p-1',
  name: 'Nordic chair',
  slug: 'nordic-chair',
  status: 'PUBLISHED',
  price: 100,
  branchLinks: [
    { store: MAIN, published: true, price: 90, salePrice: null, stockQuantity: 4, trackInventory: true, leadTimeDays: 7 },
  ],
};

const panel = (props: Partial<React.ComponentProps<typeof ProductBranchPanel>> = {}) => (
  <I18nProvider>
    <ToastProvider>
      <ProductBranchPanel product={PRODUCT} stores={STORES} accessToken="token" scope={MANAGER} {...props} />
    </ToastProvider>
  </I18nProvider>
);

describe('branch rows (P5-W4 capability 4)', () => {
  it('names exactly the seven store-owned fields the roadmap names', () => {
    expect([...STORE_OWNED_FIELDS]).toEqual([
      'price',
      'salePrice',
      'stockQuantity',
      'published',
      'availableQuantity',
      'trackInventory',
      'leadTimeDays',
    ]);
  });

  it('lists every ACTIVE branch, linked or not, and omits archived ones', () => {
    const rows = toBranchRows(PRODUCT, STORES);
    expect(rows.map((row) => row.storeId)).toEqual([MAIN, OUTLET]);
    expect(rows[0].linked).toBe(true);
    // Absence is the fact an operator needs, so an unlinked branch is a row.
    expect(rows[1].linked).toBe(false);
    expect(rows[1].published).toBe(false);
  });

  it('reads a null branch price as "the company base price applies"', () => {
    const rows = toBranchRows(PRODUCT, STORES);
    expect(rows[0].price).toBe(90);
    expect(rows[1].price).toBeNull();
  });

  it('keeps an unstated lead time null rather than defaulting it to zero', () => {
    const rows = toBranchRows(
      { ...PRODUCT, branchLinks: [{ store: MAIN, published: true }] },
      STORES,
    );
    expect(rows[0].leadTimeDays).toBeNull();
  });
});

describe('branch panel: separation of what a branch owns (P5-W5)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ data: {} });
  });
  afterEach(() => cleanupAll());

  it('shows availability as DERIVED and never as an editable field', async () => {
    const view = await renderComponent(panel({}));
    const available = view.get(`branch-available-${MAIN}`);
    // Derived, so there is nothing to type into.
    expect(available.querySelector('input')).toBeNull();
    // Phase 8: the figure itself is read from the ledger by the Stock card on
    // the item page. This slot points there rather than naming a number it
    // does not have — two places claiming the same figure is how they drift.
    expect(available.textContent).toMatch(/stock/i);
  });

  it('shows both branches to a NARROWED actor but only lets it edit its own', async () => {
    const view = await renderComponent(panel({ scope: NARROWED_MANAGER }));
    // A sibling branch's figures are legitimately useful information.
    expect(view.find(`branch-row-${OUTLET}`)).not.toBeNull();
    // ...but not its to change.
    expect(view.find(`branch-save-${MAIN}`)).not.toBeNull();
    expect(view.find(`branch-link-${OUTLET}`)).toBeNull();
    expect(view.find(`branch-save-${OUTLET}`)).toBeNull();
  });

  it('lets an un-narrowed manager act on every branch its scope allows', async () => {
    const view = await renderComponent(panel({ scope: MANAGER }));
    expect(view.find(`branch-save-${MAIN}`)).not.toBeNull();
    expect(view.find(`branch-link-${OUTLET}`)).not.toBeNull();
  });

  it('offers a branch ADMIN only its own branch', async () => {
    const view = await renderComponent(panel({ scope: ADMIN_MAIN }));
    expect(view.find(`branch-save-${MAIN}`)).not.toBeNull();
    expect(view.find(`branch-link-${OUTLET}`)).toBeNull();
  });

  it('offers a VIEWER nothing to change anywhere', async () => {
    const view = await renderComponent(panel({ scope: VIEWER }));
    expect(view.find(`branch-save-${MAIN}`)).toBeNull();
    expect(view.find(`branch-publish-${MAIN}`)).toBeNull();
    expect(view.find(`branch-unlink-${MAIN}`)).toBeNull();
  });
});

describe('branch panel: handler-level enforcement (P5-W5)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ data: {} });
  });
  afterEach(() => cleanupAll());

  it('names the branch explicitly in the request it issues', async () => {
    const view = await renderComponent(panel({}));
    await click(view.get(`branch-publish-${MAIN}`));
    expect(fetchMock).toHaveBeenCalledWith(
      `/products/p-1/stores/${MAIN}`,
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ published: false }) }),
    );
  });

  it('refuses when the actor narrows away from the branch after the control was rendered', async () => {
    const view = await renderComponent(panel({ scope: MANAGER }));
    const outletLink = view.get(`branch-link-${OUTLET}`);
    // The scope narrows to Main; the Outlet control is stale in the operator's
    // hands, and the handler — not the render — has to refuse it.
    await view.rerender(panel({ scope: NARROWED_MANAGER }));
    fetchMock.mockClear();
    await click(outletLink);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a write with no access token instead of issuing an unauthenticated request', async () => {
    const view = await renderComponent(panel({ accessToken: null }));
    await click(view.get(`branch-publish-${MAIN}`));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
