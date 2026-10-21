import { describe, it, expect, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { renderComponent, cleanupAll, flush, type } from '../../../test/render';
import ProductForm, { type ProductFormSubmission } from './product-form';
import { I18nProvider } from '../../../lib/i18n';
import { ES } from '../../../lib/translations.es';
import type { StoreRecord } from '../../../lib/use-website-config';
import type { Product } from '../types/product.types';

/**
 * WHO MAY REPLACE COMPANY-WIDE MEMBERSHIP, AND WHAT THE OTHERS SEND (#282).
 *
 * `storeIds` replaces a product's whole membership set, so the endpoint refuses
 * its mere PRESENCE from a branch-scoped actor — deliberately, and pinned by
 * `store-membership-authority.spec.ts`. This form used to echo the product's
 * current stores back on every save, so a store-bound ADMIN could not change a
 * status, a name or a price: every edit returned "Replacing store membership is
 * a company-wide operation."
 *
 * The assertions below are about the PAYLOAD KEYS, not about values. "Absent"
 * is the contract; an empty array or the current membership restated would both
 * reproduce the defect.
 */

const STORES: StoreRecord[] = [
  { id: 'store-a', name: 'Main', slug: 'main' } as StoreRecord,
  { id: 'store-b', name: 'Outlet', slug: 'outlet' } as StoreRecord,
];
const ONE_STORE: StoreRecord[] = [STORES[0]];

const product = (over: Partial<Product> = {}): Product =>
  ({
    id: 'p-1',
    name: 'Lámpara',
    status: 'DRAFT',
    price: 10,
    stockQuantity: 0,
    trackInventory: false,
    stores: [{ id: 'store-a', name: 'Main' }],
    categories: [],
    ...over,
  }) as Product;

const render = (opts: {
  canAssignStores: boolean;
  stores?: StoreRecord[];
  initialValues?: Product | null;
  onSubmit?: (d: ProductFormSubmission) => Promise<void>;
}) =>
  renderComponent(
    <I18nProvider>
      <ProductForm
        initialValues={opts.initialValues ?? null}
        categories={[]}
        stores={opts.stores ?? STORES}
        canAssignStores={opts.canAssignStores}
        onSubmit={opts.onSubmit ?? (async () => undefined)}
        onCancel={() => undefined}
      />
    </I18nProvider>,
  );

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
  await flush();
};

const field = (r: { container: HTMLElement }, name: string): HTMLElement => {
  const node = r.container.querySelector<HTMLElement>(`input[name="${name}"]`);
  if (!node) throw new Error(`no input named ${name}`);
  return node;
};
const nameField = (r: { container: HTMLElement }) => field(r, 'name');

/** A creatable product: the schema requires a name and a numeric price. */
const fillNew = async (r: { container: HTMLElement }, name = 'Nueva') => {
  await type(nameField(r), name);
  await type(field(r, 'price'), '25');
};

describe('#282 · store membership is offered only to an actor who may replace it', () => {
  afterEach(() => cleanupAll());

  describe('company-wide actor — unchanged behaviour', () => {
    it('shows the branch section and SENDS both membership properties', async () => {
      const onSubmit = vi.fn(async (_data: ProductFormSubmission) => undefined);
      const r = await render({ canAssignStores: true, initialValues: product(), onSubmit });

      expect(r.container.querySelector('[data-testid="form-branch-section"]')).not.toBeNull();
      expect(r.container.querySelector('[data-testid="form-branch-readonly"]')).toBeNull();

      await save(r);
      const sent = onSubmit.mock.calls[0][0];
      expect('storeIds' in sent).toBe(true);
      expect('storePrices' in sent).toBe(true);
      expect(sent.storeIds).toEqual(['store-a']);
    });

    it('sends membership on CREATE too', async () => {
      const onSubmit = vi.fn(async (_data: ProductFormSubmission) => undefined);
      const r = await render({ canAssignStores: true, onSubmit });
      await fillNew(r);
      await save(r);
      const sent = onSubmit.mock.calls[0][0];
      expect('storeIds' in sent).toBe(true);
      expect('storePrices' in sent).toBe(true);
    });
  });

  describe('narrowed actor — the properties are ABSENT, not empty', () => {
    it('EDIT omits storeIds and storePrices entirely', async () => {
      const onSubmit = vi.fn(async (_data: ProductFormSubmission) => undefined);
      const r = await render({ canAssignStores: false, initialValues: product(), onSubmit });
      await save(r);

      const sent = onSubmit.mock.calls[0][0];
      // The keys must not exist. `storeIds: []` and `storeIds: ['store-a']`
      // both reproduce the defect, so "absent" is asserted, not "falsy".
      expect('storeIds' in sent).toBe(false);
      expect('storePrices' in sent).toBe(false);
      expect(JSON.stringify(sent)).not.toMatch(/storeIds|storePrices/);
    });

    it('CREATE omits them too — the backend assigns the resolved store', async () => {
      const onSubmit = vi.fn(async (_data: ProductFormSubmission) => undefined);
      const r = await render({ canAssignStores: false, onSubmit });
      await fillNew(r);
      await save(r);

      const sent = onSubmit.mock.calls[0][0];
      expect('storeIds' in sent).toBe(false);
      expect('storePrices' in sent).toBe(false);
    });

    it('replaces the controls with truthful read-only context', async () => {
      const r = await render({ canAssignStores: false, initialValues: product() });

      expect(r.container.querySelector('[data-testid="form-branch-section"]')).toBeNull();
      const note = r.container.querySelector('[data-testid="form-branch-readonly"]');
      expect(note).not.toBeNull();
      expect(note!.textContent).toMatch(/set for the whole company and are not edited here/i);
      expect(note!.textContent).toMatch(/leaves them exactly as they are/i);

      // No membership control survives, and no per-branch price input either:
      // a disabled checkbox would still be a control for something this actor
      // may not decide. Asserted by looking for a checkbox LABELLED with a
      // store name, which is what the branch section renders.
      const storeLabelled = Array.from(r.container.querySelectorAll('label')).filter((l) =>
        STORES.some((s) => (l.textContent ?? '').includes(s.name)),
      );
      expect(storeLabelled).toHaveLength(0);
      expect(r.container.querySelectorAll('input[placeholder="Price (base)"]')).toHaveLength(0);
      expect(r.container.querySelectorAll('input[placeholder="Sale (base)"]')).toHaveLength(0);
      // And the note claims nothing about which branches carry the item: a
      // narrowed actor cannot see its siblings, so naming them would be a
      // half-truth dressed as context.
      expect(note!.textContent).not.toMatch(/Outlet|Main/);
    });

    it('ordinary edits stay possible — name, status and price are still editable', async () => {
      const onSubmit = vi.fn(async (_data: ProductFormSubmission) => undefined);
      const r = await render({ canAssignStores: false, initialValues: product(), onSubmit });

      expect(r.container.querySelector('select[name="status"], select')).not.toBeNull();
      const priceInputs = Array.from(r.container.querySelectorAll('input[type="number"]'));
      expect(priceInputs.length).toBeGreaterThan(0);

      await type(nameField(r), 'Lámpara grande');
      await save(r);
      const sent = onSubmit.mock.calls[0][0];
      expect(sent.name).toBe('Lámpara grande');
      expect('storeIds' in sent).toBe(false);
    });
  });

  /**
   * Authority follows the resolved SCOPE, never the store count. A one-store
   * company is not a special case — it is one branch away from being a
   * multi-store company, and a rule that read the count would change on the day
   * a second branch is created.
   */
  describe('identical in one-store and multi-store companies', () => {
    it.each([
      ['one-store', ONE_STORE],
      ['multi-store', STORES],
    ])('narrowed actor in a %s company: hidden and omitted', async (_label, stores) => {
      const onSubmit = vi.fn(async (_data: ProductFormSubmission) => undefined);
      const r = await render({ canAssignStores: false, stores, initialValues: product(), onSubmit });

      expect(r.container.querySelector('[data-testid="form-branch-section"]')).toBeNull();
      expect(r.container.querySelector('[data-testid="form-branch-readonly"]')).not.toBeNull();
      await save(r);
      const sent = onSubmit.mock.calls[0][0];
      expect('storeIds' in sent).toBe(false);
      expect('storePrices' in sent).toBe(false);
    });

    it.each([
      ['one-store', ONE_STORE],
      ['multi-store', STORES],
    ])('company-wide actor in a %s company: shown and sent', async (_label, stores) => {
      const onSubmit = vi.fn(async (_data: ProductFormSubmission) => undefined);
      const r = await render({ canAssignStores: true, stores, initialValues: product(), onSubmit });

      expect(r.container.querySelector('[data-testid="form-branch-section"]')).not.toBeNull();
      await save(r);
      expect('storeIds' in (onSubmit.mock.calls[0][0])).toBe(true);
    });
  });

  /**
   * LAYOUT CANNOT CHANGE AUTHORITY.
   *
   * jsdom has no layout engine, so "renders at 390px" cannot be asserted by
   * measuring. What CAN be asserted is the only way a width could change what
   * is on screen here: a responsive visibility class. Neither block carries
   * one, so what a narrow viewport shows is what a wide one shows.
   */
  it('neither block is hidden or revealed by viewport width', async () => {
    const narrowed = await render({ canAssignStores: false, initialValues: product() });
    const wide = await render({ canAssignStores: true, initialValues: product() });
    const responsive = /(^|\s)(hidden|sm:|md:|lg:|xl:)/;

    const note = narrowed.container.querySelector('[data-testid="form-branch-readonly"]')!;
    const section = wide.container.querySelector('[data-testid="form-branch-section"]')!;
    expect(note.className).not.toMatch(responsive);
    expect(section.className).not.toMatch(responsive);
    // And no ancestor of either hides it at a breakpoint.
    for (const start of [note, section]) {
      let node: Element | null = start.parentElement;
      while (node && node.tagName !== 'FORM') {
        expect(node.className ?? '').not.toMatch(responsive);
        node = node.parentElement;
      }
    }
  });

  it('a parent card is unaffected — it already omits what it does not own', async () => {
    const onSubmit = vi.fn(async (_data: ProductFormSubmission) => undefined);
    const card = product({ id: 'card', children: [{ id: 'c1', name: 'S' }] as never });
    const r = await render({ canAssignStores: true, initialValues: card, onSubmit });

    expect(r.container.querySelector('[data-testid="form-card-note"]')).not.toBeNull();
    expect(r.container.querySelector('[data-testid="form-branch-section"]')).toBeNull();
    await save(r);
    const sent = onSubmit.mock.calls[0][0];
    expect('storeIds' in sent).toBe(false);
  });

  it('the read-only note is stated in both languages', () => {
    for (const key of [
      'Set by each branch',
      'Which branches carry this item, and the price each one charges, are set for the whole company and are not edited here.',
      'Saving this form leaves them exactly as they are.',
    ]) {
      expect(ES[key], `missing Spanish for "${key}"`).toBeTruthy();
    }
  });
});
