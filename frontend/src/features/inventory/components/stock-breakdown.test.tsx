import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import StockBreakdown from './stock-breakdown';
import type { ProductStock } from '../inventory-api';

/**
 * The distinction this panel exists to make (ADR 013 decisions 15 and 18):
 * OWNED is not SELLABLE. Units can be reserved for a customer, committed to a
 * transfer, travelling, or damaged — owned in every case, sellable in none.
 * The old panel showed a single held figure and the words "Worked out from the
 * ledger" where the sellable number belonged, which is how a website ends up
 * promising stock that cannot ship.
 */
const stockOf = (over: Partial<ProductStock> = {}): ProductStock => ({
  productId: 'p-1',
  organizationTotal: 20,
  sellable: 12,
  warehouseRemainder: 5,
  perStore: [
    { storeId: 's-1', storeName: 'Centro', held: 9 },
    { storeId: 's-2', storeName: 'Norte', held: 6 },
  ],
  reserved: 3,
  transferCommitted: 2,
  inTransit: 0,
  nonSellable: 3,
  ...over,
});

const panel = (stock: ProductStock) => (
  <I18nProvider>
    <StockBreakdown stock={stock} />
  </I18nProvider>
);

describe('StockBreakdown', () => {
  afterEach(() => cleanupAll());

  it('states owned and sellable as different numbers', async () => {
    const view = await renderComponent(panel(stockOf()));
    const text = view.text();
    expect(text).toContain('20'); // owned by the company
    expect(text).toContain('12'); // sellable now
    expect(text).toMatch(/Sellable now/i);
  });

  it('names every bucket that is holding stock back', async () => {
    const view = await renderComponent(panel(stockOf()));
    const buckets = view.find('withheld-buckets');
    expect(buckets).not.toBeNull();
    const text = buckets!.textContent ?? '';
    expect(text).toMatch(/Reserved/i);
    expect(text).toMatch(/Committed/i);
    expect(text).toMatch(/Damaged|not sellable/i);
  });

  it('says nothing about held-back stock when none is held back', async () => {
    const view = await renderComponent(
      panel(stockOf({ reserved: 0, transferCommitted: 0, inTransit: 0, nonSellable: 0, sellable: 20 })),
    );
    expect(view.find('withheld-buckets')).toBeNull();
  });

  it('lists what each branch holds', async () => {
    const view = await renderComponent(panel(stockOf()));
    const text = view.text();
    expect(text).toContain('Centro');
    expect(text).toContain('Norte');
  });

  it('warns when the branches and the warehouse do not add up to the company total', async () => {
    // 9 + 6 + 5 = 20 balances; make the company own more than is accounted for
    const view = await renderComponent(panel(stockOf({ organizationTotal: 24 })));
    const warning = view.find('reconciliation-warning');
    expect(warning).not.toBeNull();
    expect(warning!.textContent).toMatch(/do not add up/i);
  });

  it('stays quiet when the figures reconcile', async () => {
    const view = await renderComponent(panel(stockOf()));
    expect(view.find('reconciliation-warning')).toBeNull();
  });

  it('handles an item no branch holds without inventing a row', async () => {
    const view = await renderComponent(
      panel(stockOf({ perStore: [], organizationTotal: 5, warehouseRemainder: 5, sellable: 5, reserved: 0, transferCommitted: 0, inTransit: 0, nonSellable: 0 })),
    );
    expect(view.text()).toMatch(/No branch holds this item yet/i);
  });
});
