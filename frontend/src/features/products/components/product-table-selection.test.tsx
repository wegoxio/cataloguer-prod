import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import ProductTable from './product-table';
import type { Product } from '../types/product.types';

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const p = (o: Partial<Product>): Product =>
  ({ id: 'x', name: 'n', slug: 's', price: 10, status: 'PUBLISHED', ...o }) as Product;

const A = p({ id: 'a', name: 'A', slug: 'a', branchLinks: [{ store: 'store-a', published: true }] });
const B = p({ id: 'b', name: 'B', slug: 'b', branchLinks: [{ store: { id: 'store-a' }, published: false }] });
const C = p({ id: 'c', name: 'C', slug: 'c', branchLinks: [{ store: 'store-b', published: true }] });

const noop = () => undefined;
const table = (selected: string[], over: Record<string, unknown> = {}) =>
  renderComponent(
    <I18nProvider>
      <ProductTable
        products={[A, B, C]}
        canManage
        canArchive
        onEdit={noop}
        onArchive={noop}
        onRestore={noop}
        onRemove={noop}
        selectedProductIds={selected}
        onToggleSelect={noop}
        onToggleSelectAll={noop}
        {...(over as any)}
      />
    </I18nProvider>,
  );

afterEach(() => cleanupAll());

/**
 * The header checkbox describes THIS PAGE by membership (ADR 029 supporting
 * fix). Comparing lengths broke after "select all N matching": every row on
 * the page was selected and the box showed unchecked.
 */
describe('the row checkboxes', () => {
  it('each one is named after its item, so a screen reader says which row it selects', async () => {
    const r = await table([]);
    const boxes = Array.from(r.container.querySelectorAll('tbody input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes.map((b) => b.getAttribute('aria-label'))).toEqual(['Select A', 'Select B', 'Select C']);
  });

  it('reflects the selection it was given', async () => {
    const r = await table(['b']);
    const boxes = Array.from(r.container.querySelectorAll('tbody input[type="checkbox"]')) as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([false, true, false]);
  });
});

describe('the page checkbox', () => {
  const box = (r: Awaited<ReturnType<typeof table>>) => r.get('select-all-on-page') as HTMLInputElement;

  it('is unchecked and not indeterminate with nothing selected', async () => {
    const r = await table([]);
    expect(box(r).checked).toBe(false);
    expect(box(r).indeterminate).toBe(false);
    expect(box(r).getAttribute('aria-checked')).toBe('false');
  });

  it('is indeterminate (aria-checked="mixed") when some rows on the page are selected', async () => {
    const r = await table(['a']);
    expect(box(r).checked).toBe(false);
    expect(box(r).indeterminate).toBe(true);
    expect(box(r).getAttribute('aria-checked')).toBe('mixed');
  });

  it('is checked when every row on the page is selected', async () => {
    const r = await table(['a', 'b', 'c']);
    expect(box(r).checked).toBe(true);
    expect(box(r).indeterminate).toBe(false);
  });

  it('stays checked when the selection also holds ids from OTHER pages', async () => {
    const r = await table(['a', 'b', 'c', 'other-page-1', 'other-page-2']);
    expect(box(r).checked).toBe(true);
    expect(box(r).indeterminate).toBe(false);
  });
});

describe('the branch-state badge', () => {
  it('is absent without a branch filter', async () => {
    const r = await table([]);
    expect(r.all('branch-state-')).toHaveLength(0);
  });

  it('says Published here / Hidden here for the filtered branch, from the row’s own link', async () => {
    const r = await table([], { branchFilterStoreId: 'store-a' });
    expect(r.get('branch-state-a').textContent).toBe('Published here');
    expect(r.get('branch-state-a').dataset.published).toBe('true');
    expect(r.get('branch-state-b').textContent).toBe('Hidden here');
    expect(r.get('branch-state-b').dataset.published).toBe('false');
    // C has no link for store-a: nothing is invented for it.
    expect(r.find('branch-state-c')).toBeNull();
  });
});
