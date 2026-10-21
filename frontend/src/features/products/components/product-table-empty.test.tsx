import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import ProductTable from './product-table';
import type { Product } from '../types/product.types';

// Forward EVERY prop: a mock that keeps only href silently drops data-testid
// and would make a present element look absent.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

/**
 * TWO different empties, and they used to be one message.
 *
 * "No products found. Create your first product or adjust the filters above."
 * was said to somebody who has never added anything AND to somebody whose
 * filter is one checkbox too narrow, offered neither of them a way out, and
 * was the last empty state in the dashboard still in English.
 */

const noop = () => undefined;
const table = (over: Record<string, unknown> = {}) =>
  renderComponent(
    <I18nProvider>
      <ProductTable
        products={[]}
        canManage
        canArchive
        onEdit={noop}
        onArchive={noop}
        onRestore={noop}
        onRemove={noop}
        selectedProductIds={[]}
        onToggleSelect={noop}
        onToggleSelectAll={noop}
        {...(over as any)}
      />
    </I18nProvider>,
  );

afterEach(() => cleanupAll());

describe('an empty items table says which empty it is', () => {
  it('with no filters, says the catalogue is empty', async () => {
    const r = await table({ filtered: false });
    expect(r.find('empty-catalogue')).not.toBeNull();
    expect(r.find('empty-filtered')).toBeNull();
    expect(r.text()).toMatch(/no items yet/i);
  });

  it('with a filter on, says the filters hid them', async () => {
    const r = await table({ filtered: true });
    expect(r.find('empty-filtered')).not.toBeNull();
    expect(r.find('empty-catalogue')).toBeNull();
    expect(r.text()).toMatch(/match these filters/i);
  });

  it('never offers Clear filters when no filter is on', async () => {
    const r = await table({ filtered: false, onClearFilters: noop });
    expect(r.find('empty-clear-filters')).toBeNull();
  });

  it('never offers Add Item from the filtered empty — the items may exist', async () => {
    const r = await table({ filtered: true, onAddItem: noop, onClearFilters: noop });
    expect(r.find('empty-add-item')).toBeNull();
  });

  describe('the way out', () => {
    it('clears the filters when asked', async () => {
      let cleared = 0;
      const r = await table({
        filtered: true,
        onClearFilters: () => {
          cleared += 1;
        },
      });
      await click(r.get('empty-clear-filters'));
      expect(cleared).toBe(1);
    });

    it('starts a new item when asked', async () => {
      let adding = 0;
      const r = await table({
        filtered: false,
        onAddItem: () => {
          adding += 1;
        },
      });
      await click(r.get('empty-add-item'));
      expect(adding).toBe(1);
    });

    /**
     * The server refuses creation for a reader. An action that always fails is
     * worse than no action at all.
     */
    it('does not offer Add Item to somebody who may not create', async () => {
      const r = await table({ filtered: false, canManage: false, onAddItem: noop });
      expect(r.find('empty-add-item')).toBeNull();
      // The state itself is still shown, and still says which empty it is.
      expect(r.find('empty-catalogue')).not.toBeNull();
    });

    it('shows a plain empty state when the page offers no handler', async () => {
      const r = await table({ filtered: false });
      expect(r.find('empty-catalogue')).not.toBeNull();
      expect(r.find('empty-add-item')).toBeNull();
    });
  });

  it('shows neither empty state once there are items', async () => {
    const product = { id: 'x', name: 'Lámpara', slug: 'lampara', price: 10, status: 'PUBLISHED' } as Product;
    const r = await table({ products: [product], filtered: true });
    expect(r.find('empty-catalogue')).toBeNull();
    expect(r.find('empty-filtered')).toBeNull();
    expect(r.text()).toMatch(/Lámpara/);
  });
});
