import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click, type as typeInto } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import CreateParentCardForm from './create-parent-card-form';
import ProductForm from './product-form';
import type { Product } from '../types/product.types';

const p = (o: Partial<Product>): Product =>
  ({ id: 'x', name: 'n', slug: 's', price: 10, status: 'PUBLISHED', ...o }) as Product;

const S = p({ id: 's', name: 'Camiseta Small', price: 10 });
const M = p({ id: 'm', name: 'Camiseta Medium', price: 20 });

afterEach(() => cleanupAll());

const form = (over: Partial<React.ComponentProps<typeof CreateParentCardForm>> = {}) =>
  renderComponent(
    <I18nProvider>
      <CreateParentCardForm
        candidates={[S, M]}
        searching={false}
        onSearch={() => undefined}
        onCancel={() => undefined}
        onCreate={async () => 'new-card'}
        {...over}
      />
    </I18nProvider>,
  );

/**
 * Creating a card is ONE act.
 *
 * A card with no children is not an incomplete card, it is a live sellable
 * product: every guard in the system treats a childless product as ordinary.
 * So there is no state in this journey where a card exists without them.
 */
describe('creating a parent card from Add Item', () => {
  describe('what it refuses to save', () => {
    it('needs a name', async () => {
      const { get } = await form();
      expect(get('card-problem').textContent).toMatch(/needs a name/i);
      expect((get('card-create') as HTMLButtonElement).disabled).toBe(true);
    });

    it('needs at least TWO children — one is not a family', async () => {
      const { get, find } = await form();
      await typeInto(get('card-name'), 'Camiseta');
      await click(get('card-candidate-s'));
      // The selection must have REGISTERED before the message means anything:
      // a chosen child gets its own label input. Without this the assertion
      // below passes on an empty selection, which is a different rule.
      expect(find('card-label-s')).not.toBeNull();
      expect(get('card-problem').textContent).toMatch(/at least two/i);
      expect((get('card-create') as HTMLButtonElement).disabled).toBe(true);
    });

    it('refuses a mix of published and draft children', async () => {
      const { get, find } = await form({ candidates: [S, p({ id: 'd', name: 'Camiseta Draft', status: 'DRAFT' })] });
      await typeInto(get('card-name'), 'Camiseta');
      await click(get('card-candidate-s'));
      await click(get('card-candidate-d'));
      // Both selections registered — otherwise "not all published" would be
      // true of a selection that never happened.
      expect(find('card-label-s')).not.toBeNull();
      expect(find('card-label-d')).not.toBeNull();
      expect(get('card-problem').textContent).toMatch(/published or all draft/i);
      expect((get('card-create') as HTMLButtonElement).disabled).toBe(true);
    });

    it('refuses two children showing the same label', async () => {
      const { get } = await form();
      await typeInto(get('card-name'), 'Camiseta');
      await click(get('card-candidate-s'));
      await click(get('card-candidate-m'));
      await typeInto(get('card-label-m'), 'Small');
      expect(get('card-problem').textContent).toMatch(/same label/i);
      expect((get('card-create') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe('what it sends', () => {
    it('sends the card AND its children in ONE call', async () => {
      const onCreate = vi.fn(async () => 'new-card');
      const { get } = await form({ onCreate });
      await typeInto(get('card-name'), 'Camiseta');
      await typeInto(get('card-description'), 'La ficha');
      await click(get('card-candidate-s'));
      await click(get('card-candidate-m'));
      await click(get('card-create'));

      expect(onCreate).toHaveBeenCalledTimes(1);
      expect(onCreate).toHaveBeenCalledWith({
        name: 'Camiseta',
        description: 'La ficha',
        metaTitle: undefined,
        metaDescription: undefined,
        members: [
          { id: 's', label: 'Small' },
          { id: 'm', label: 'Medium' },
        ],
      });
    });

    it('prefills each label from what the child’s name adds to the card name', async () => {
      const { get } = await form();
      await typeInto(get('card-name'), 'Camiseta');
      await click(get('card-candidate-s'));
      expect((get('card-label-s') as HTMLInputElement).value).toBe('Small');
    });
  });

  it('states what the card will be before it is made', async () => {
    const { get } = await form();
    await typeInto(get('card-name'), 'Camiseta');
    await click(get('card-candidate-s'));
    await click(get('card-candidate-m'));
    const preview = get('card-preview').textContent ?? '';
    expect(preview).toMatch(/never sold/i);
    expect(preview).toMatch(/own price and stock/i);
    expect(preview).toMatch(/shops its children are in/i);
    expect(preview).toMatch(/saved together/i);
    expect(get('card-preview-status').textContent).toMatch(/published|draft/i);
    expect(get('card-preview-price').textContent).toMatch(/sorting only/i);
  });
});

/**
 * Editing a card afterwards: the form shows what the card OWNS and explains
 * what it cannot have.
 */
describe('editing a parent card', () => {
  const card = p({ id: 'card', name: 'Camiseta', children: [{ id: 's', name: 'Camiseta Small' }] as never });
  const standalone = p({ id: 'solo', name: 'Lámpara' });

  const edit = (initialValues: Product) =>
    renderComponent(
      <I18nProvider>
        <ProductForm
          initialValues={initialValues}
          categories={[]}
          stores={[]}
          canAssignStores
          onSubmit={async () => undefined}
          onCancel={() => undefined}
        />
      </I18nProvider>,
    );

  it('hides stock, tracking and the per-shop section, and says why', async () => {
    const { find, get } = await edit(card);
    expect(find('form-stock-note')).toBeNull();
    expect(find('form-branch-section')).toBeNull();
    expect(get('form-card-note').textContent).toMatch(/never sold/i);
    expect(get('form-card-note').textContent).toMatch(/worked out from its child products/i);
  });

  it('shows the price as a SORTING price, and says it is never charged', async () => {
    const { get } = await edit(card);
    expect(get('form-card-price').textContent).toMatch(/sorting price/i);
    expect(get('form-card-price').textContent).toMatch(/never charged/i);
  });

  it('leaves an ordinary item’s form exactly as it was', async () => {
    const { find } = await edit(standalone);
    expect(find('form-stock-note')).not.toBeNull();
    expect(find('form-branch-section')).not.toBeNull();
    expect(find('form-card-note')).toBeNull();
    expect(find('form-card-price')).toBeNull();
  });
});
