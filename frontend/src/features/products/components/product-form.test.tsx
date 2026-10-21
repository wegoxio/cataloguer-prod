import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../test/render';
import ProductForm from './product-form';
import { I18nProvider } from '../../../lib/i18n';
import type { StoreRecord } from '../../../lib/use-website-config';
import type { Product } from '../types/product.types';

const STORES: StoreRecord[] = [
  { id: 'store-a', name: 'Main', slug: 'main' } as StoreRecord,
  { id: 'store-b', name: 'Outlet', slug: 'outlet' } as StoreRecord,
];

/** These cases describe a COMPANY-WIDE actor; #282 gave that an explicit name. */
const form = (initialValues: Product | null = null, canAssignStores = true) => (
  <I18nProvider>
    <ProductForm
      initialValues={initialValues}
      categories={[]}
      stores={STORES}
      canAssignStores={canAssignStores}
      onSubmit={vi.fn()}
      onCancel={vi.fn()}
    />
  </I18nProvider>
);

const labelled = (container: HTMLElement, label: string): HTMLInputElement | null => {
  const node = Array.from(container.querySelectorAll('label')).find((element) =>
    (element.textContent ?? '').trim().startsWith(label),
  );
  if (!node) return null;
  const id = node.getAttribute('for');
  return id ? container.querySelector<HTMLInputElement>(`#${CSS.escape(id)}`) : null;
};

describe('product form: company-owned and branch-owned are separated (P5-W4 capability 4)', () => {
  afterEach(() => cleanupAll());

  it('labels both halves explicitly', async () => {
    const view = await renderComponent(form());
    expect(view.get('form-company-section').textContent).toMatch(/Owned by the company/i);
    expect(view.get('form-branch-section').textContent).toMatch(/Set by each branch/i);
  });

  it('says that stock belongs to a BRANCH, not to the company', async () => {
    const view = await renderComponent(form());
    const note = view.get('form-stock-note').textContent ?? '';
    expect(note).toMatch(/held by a BRANCH/);
    expect(note).toMatch(/ledger/i);
  });

  it('names the seven branch-owned things where the operator will look for them', async () => {
    const view = await renderComponent(form());
    const branch = view.get('form-branch-section').textContent ?? '';
    for (const word of ['price', 'Units held', 'publication', 'inventory tracking', 'lead time']) {
      expect(branch.toLowerCase()).toContain(word.toLowerCase());
    }
  });
});

describe('product form: a new product is published NOWHERE (#188)', () => {
  afterEach(() => cleanupAll());

  const storeBoxes = (view: { get: (id: string) => HTMLElement }): HTMLInputElement[] =>
    Array.from(view.get('form-branch-section').querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));

  it('starts with every branch unticked, so one click cannot put the item on every website', async () => {
    const view = await renderComponent(form());
    const boxes = storeBoxes(view);
    expect(boxes).toHaveLength(STORES.length);
    expect(boxes.every((box) => box.checked)).toBe(false);
    expect(boxes.some((box) => box.checked)).toBe(false);
  });

  it('says out loud that the item will appear on no website while nothing is ticked', async () => {
    const view = await renderComponent(form());
    expect(view.get('form-branch-section').textContent).toMatch(/appear on NO website/i);
  });

  it('still mirrors the branches an EXISTING product already sits in', async () => {
    const view = await renderComponent(
      form({
        id: 'p-1',
        name: 'Chair',
        slug: 'chair',
        status: 'PUBLISHED',
        stores: [{ id: 'store-b', name: 'Outlet', slug: 'outlet' }],
      } as Product),
    );
    // Emptiness is the NEW-product rule, not a blanket one: an edit that
    // silently unpublished the item would be the same defect in reverse.
    expect(storeBoxes(view).map((box) => box.checked)).toEqual([false, true]);
    expect(view.get('form-branch-section').textContent).not.toMatch(/appear on NO website/i);
  });
});

describe('product form: SKU and manufacturer code are different identities (P5-W1)', () => {
  afterEach(() => cleanupAll());

  it('offers BOTH fields, separately', async () => {
    const view = await renderComponent(form());
    expect(labelled(view.container, 'SKU')).not.toBeNull();
    expect(labelled(view.container, 'Manufacturer code')).not.toBeNull();
  });

  it('says the manufacturer code is the supplier reference and need not be unique', async () => {
    const view = await renderComponent(form());
    const text = view.text();
    expect(text).toMatch(/supplier/i);
    expect(text).toMatch(/does not have to be unique|no tiene que ser única/i);
  });

  it('loads an existing manufacturer code into its own field, not into the SKU', async () => {
    const view = await renderComponent(
      form({
        id: 'p-1',
        name: 'Chair',
        slug: 'chair',
        status: 'PUBLISHED',
        sku: 'INT-1',
        manufacturerCode: 'KARE-71234',
      } as Product),
    );
    expect(labelled(view.container, 'SKU')?.value).toBe('INT-1');
    expect(labelled(view.container, 'Manufacturer code')?.value).toBe('KARE-71234');
  });
});
