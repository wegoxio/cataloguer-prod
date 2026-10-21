import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { renderComponent, click, type as typeInto, cleanupAll, settle, flush } from '../../../test/render';
import ProductFamilyPanel, { familyRoleOf, type FamilyView } from './product-family-panel';
import { I18nProvider } from '../../../lib/i18n';
import { ToastProvider } from '../../../components/ui/toast';
import type { SessionScope } from '../../../lib/permissions';
import type { Product } from '../types/product.types';

const fetchMock = vi.fn();
vi.mock('../../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));

const ORG = 'org-1';
const scopeFor = (overrides: Partial<SessionScope>): SessionScope => ({
  platform: false,
  role: 'ORGANIZATION_MANAGER',
  organizationId: ORG,
  storeId: null,
  allowedStoreIds: ['store-a'],
  ...overrides,
});

const MANAGER = scopeFor({});
const VIEWER = scopeFor({ role: 'VIEWER', storeId: 'store-a' });

const MODEL: Product = { id: 'model-1', name: 'Nordic chair', slug: 'nordic-chair', status: 'PUBLISHED' };
const FAMILY: FamilyView = {
  parentId: 'model-1',
  parentName: 'Nordic chair',
  members: [
    { id: 'child-1', name: 'Nordic chair green', optionLabel: 'Green', price: 100, trackInventory: true, stockQuantity: 2 },
    { id: 'child-2', name: 'Nordic chair blue', optionLabel: null, price: 100, trackInventory: false },
  ],
};

const panel = (props: Partial<React.ComponentProps<typeof ProductFamilyPanel>> = {}) => (
  <I18nProvider>
    <ToastProvider>
      <ProductFamilyPanel product={MODEL} family={FAMILY} accessToken="token" scope={MANAGER} {...props} />
    </ToastProvider>
  </I18nProvider>
);

describe('family role (P5-W4 capability 3)', () => {
  it('reads the three roles without guessing', () => {
    expect(familyRoleOf({ ...MODEL, children: [{ id: 'c', name: 'c' } as Product] })).toBe('PARENT');
    expect(familyRoleOf({ ...MODEL, parent: 'model-1' })).toBe('CHILD');
    expect(familyRoleOf({ ...MODEL, parent: { id: 'model-1', name: 'x' } })).toBe('CHILD');
    expect(familyRoleOf(MODEL)).toBe('STANDALONE');
  });
});

describe('family panel: terminology and rendering (P5-W4)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ data: { id: 'new-child' } });
  });
  afterEach(() => cleanupAll());

  it('uses parent / child / standalone and none of the retired words (ADR 018)', async () => {
    const view = await renderComponent(panel({}));
    const text = view.text().toLowerCase();
    expect(text).toContain('parent');
    expect(text).toContain('child');
    // Three retired words, not one. "variant" went with ADR 009's model;
    // "model" and "version" are retired as USER-FACING role names by the
    // owner direction recorded in ADR 018. `family` survives only as an
    // internal collective term — routes, services, test ids — and must never
    // reach the screen as a product role.
    expect(text).not.toContain('variant');
    expect(text).not.toContain('version');
    expect(text).not.toContain('model');
  });

  it('says plainly when a product is standalone rather than showing an empty family', async () => {
    const view = await renderComponent(panel({ family: null }));
    expect(view.text().toLowerCase()).toContain('standalone product');
    expect(view.find('family-dissolve')).toBeNull();
  });

  it('offers no family administration to a VIEWER', async () => {
    const view = await renderComponent(panel({ scope: VIEWER }));
    // The family is still readable; changing it is not offered.
    expect(view.text()).toContain('Nordic chair green');
    expect(view.find('family-dissolve')).toBeNull();
    expect(view.find('family-create-toggle')).toBeNull();
    expect(view.find('family-remove-child-1')).toBeNull();
  });
});

describe('family panel: creating a version (P5-W4 capability 3)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });
  afterEach(() => cleanupAll());

  it('creates an ordinary DRAFT product in no branch, then joins it to the family', async () => {
    fetchMock.mockImplementation((path: string) => {
      if (path === '/products') return Promise.resolve({ data: { id: 'child-3' } });
      return Promise.resolve({ data: { member: { id: 'child-3' } } });
    });
    const onChanged = vi.fn();
    const view = await renderComponent(panel({ onChanged }));

    await click(view.get('family-create-toggle'));
    const form = view.get('family-create-form');
    const inputs = form.querySelectorAll('input');
    await typeInto(inputs[0], 'Nordic chair red');
    await typeInto(inputs[1], 'Red');
    await click(view.get('family-create-submit'));

    const [createPath, createOptions] = fetchMock.mock.calls[0];
    expect(createPath).toBe('/products');
    const body = JSON.parse((createOptions as { body: string }).body);
    // Born as a draft, in no branch, with no price claimed for it.
    expect(body).toMatchObject({ name: 'Nordic chair red', status: 'DRAFT', storeIds: [] });

    const [joinPath, joinOptions] = fetchMock.mock.calls[1];
    expect(joinPath).toBe('/products/model-1/family/members');
    expect(JSON.parse((joinOptions as { body: string }).body)).toEqual({ productId: 'child-3', label: 'Red' });
    expect(onChanged).toHaveBeenCalled();
  });

  it('refuses to create a version with no name or no selector label', async () => {
    const view = await renderComponent(panel({}));
    await click(view.get('family-create-toggle'));
    await click(view.get('family-create-submit'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports the truth when the product was created but the join failed', async () => {
    fetchMock.mockImplementation((path: string) => {
      if (path === '/products') return Promise.resolve({ data: { id: 'child-4' } });
      return Promise.reject(new Error('nope'));
    });
    const view = await renderComponent(panel({}));
    await click(view.get('family-create-toggle'));
    const inputs = view.get('family-create-form').querySelectorAll('input');
    await typeInto(inputs[0], 'Nordic chair black');
    await typeInto(inputs[1], 'Black');
    await click(view.get('family-create-submit'));

    // Two calls were attempted, and the panel does not claim success.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).toMatch(/standalone draft/i);
  });
});

describe('family panel: handler-level enforcement (P5-W5)', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ data: {} });
  });
  afterEach(() => cleanupAll());

  it('refuses a create triggered after the scope loses authority', async () => {
    const view = await renderComponent(panel({}));
    await click(view.get('family-create-toggle'));
    const inputs = view.get('family-create-form').querySelectorAll('input');
    await typeInto(inputs[0], 'Nordic chair grey');
    await typeInto(inputs[1], 'Grey');
    const submit = view.get('family-create-submit');

    await view.rerender(panel({ scope: VIEWER }));
    fetchMock.mockClear();
    await click(submit);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  /**
   * TRUTHFUL GUIDANCE.
   *
   * The panel used to tell a standalone item's reader to "group it with others
   * from the item list". No such action exists anywhere in the item list, so
   * the instruction could not be followed. Until grouping ships the panel
   * states the fact and stops — and must not grow a dead or fake call to
   * action in the meantime.
   */
  describe('standalone guidance is truthful', () => {
    const standalone = { id: 'solo', name: 'Lámpara', slug: 'lampara' } as unknown as Product;

    it('says plainly that the item has no parent and no children', async () => {
      const { get } = await renderComponent(
        <I18nProvider>
          <ToastProvider>
            <ProductFamilyPanel product={standalone} family={null} accessToken="t" scope={MANAGER} />
          </ToastProvider>
        </I18nProvider>,
      );
      expect(get('standalone-explainer').textContent).toBe(
        'This is a standalone product: it has no parent and no children.',
      );
    });

    it('claims no action that does not exist', async () => {
      const { container } = await renderComponent(
        <I18nProvider>
          <ToastProvider>
            <ProductFamilyPanel product={standalone} family={null} accessToken="t" scope={MANAGER} />
          </ToastProvider>
        </I18nProvider>,
      );
      const text = container.textContent ?? '';
      expect(text).not.toContain('from the item list');
      expect(text).not.toMatch(/Group it with others/i);
    });

    it('offers no dead or fake call to action', async () => {
      const { container } = await renderComponent(
        <I18nProvider>
          <ToastProvider>
            <ProductFamilyPanel product={standalone} family={null} accessToken="t" scope={MANAGER} />
          </ToastProvider>
        </I18nProvider>,
      );
      // The one action that exists is a real one — joining a group that
      // already exists — and it is the only thing offered: one enabled button
      // that opens a dialog, no field and no link on the page itself.
      const buttons = Array.from(container.querySelectorAll('button'));
      expect(buttons.map((button) => button.textContent)).toEqual(['Add to an existing group']);
      expect(buttons[0].disabled).toBe(false);
      expect(buttons[0].getAttribute('aria-haspopup')).toBe('dialog');
      expect(container.querySelectorAll('a').length).toBe(0);
      expect(container.querySelectorAll('input').length).toBe(0);
    });

    it('offers a VIEWER the fact and nothing else', async () => {
      const view = await renderComponent(
        <I18nProvider>
          <ToastProvider>
            <ProductFamilyPanel product={standalone} family={null} accessToken="t" scope={VIEWER} />
          </ToastProvider>
        </I18nProvider>,
      );
      expect(view.find('standalone-explainer')).not.toBeNull();
      expect(view.find('family-join')).toBeNull();
      expect(view.container.querySelectorAll('input').length).toBe(0);
    });
  });

  // Joining an existing group from a standalone item is a dialog of its own:
  // `join-group-modal.test.tsx`.

  describe('the group’s own add-a-child refusal', () => {
    // Braces on purpose: `mockReset()` returns the mock, and a hook that
    // RETURNS a function hands vitest a teardown to call — with no arguments.
    beforeEach(() => {
      fetchMock.mockReset();
    });
    afterEach(() => cleanupAll());

    it('is shown where the form is, and the pick survives it', async () => {
      const onChanged = vi.fn();
      fetchMock.mockImplementation((path: string) =>
        path.startsWith('/products?')
          ? Promise.resolve({ items: [{ id: 'solo-9', name: 'Nordic stool', price: 40 }] })
          : Promise.reject(Object.assign(new Error('"Nordic stool" belongs to no store, so it cannot become a child product'), { status: 400 })),
      );
      const view = await renderComponent(panel({ onChanged }));
      await typeInto(view.container.querySelector('input[aria-label="Search items by name or SKU..."]'), 'Nord');
      await settle(400);
      await click(view.get('family-candidate-solo-9'));
      await typeInto(view.container.querySelector('input[aria-label="Shows as"]'), 'Stool');
      await click(view.get('family-add-submit'));
      await flush();

      expect(view.get('family-add-refusal').textContent).toContain('belongs to no store');
      expect(view.find('family-add-refusal-retry')).toBeNull();
      expect(view.find('family-add-submit')).not.toBeNull();
      expect(onChanged).not.toHaveBeenCalled();

      // A refusal belongs to the request that met it (#344).
      await typeInto(view.container.querySelector('input[aria-label="Shows as"]'), 'Stools');
      expect(view.find('family-add-refusal')).toBeNull();
    });

    it('asks only for the branch an actor works in, when it works in one (#344)', async () => {
      fetchMock.mockResolvedValue({ items: [] });
      const narrowed = scopeFor({ storeId: 'store-a' });
      const view = await renderComponent(panel({ scope: narrowed }));
      await typeInto(view.container.querySelector('input[aria-label="Search items by name or SKU..."]'), 'Nord');
      await settle(400);
      const params = new URL(`http://x${fetchMock.mock.calls[0][0]}`).searchParams;
      expect(params.get('family')).toBe('standalone');
      expect(params.get('storeId')).toBe('store-a');
    });

    it('a slow answer for an older query never replaces a newer one (#344)', async () => {
      let answerFirst!: (value: unknown) => void;
      fetchMock.mockImplementation((path: string) => {
        const search = new URL(`http://x${path}`).searchParams.get('search');
        if (search === 'No') return new Promise((resolve) => (answerFirst = resolve));
        return Promise.resolve({ items: [{ id: 'solo-new', name: 'Nordic stool', price: 40 }] });
      });
      const view = await renderComponent(panel());
      const search = view.container.querySelector('input[aria-label="Search items by name or SKU..."]');
      await typeInto(search, 'No');
      await settle(400);
      await typeInto(search, 'Nordic');
      await settle(400);
      await act(async () => answerFirst({ items: [{ id: 'solo-old', name: 'Notebook', price: 5 }] }));
      await flush();
      expect(view.find('family-candidate-solo-new')).not.toBeNull();
      expect(view.find('family-candidate-solo-old')).toBeNull();
    });
  });
  /**
   * NAVIGATION BETWEEN A FAMILY'S MEMBERS.
   *
   * Both directions already worked; NEITHER was tested. A reader on a child
   * must be able to reach its parent, and a reader on a parent must be able to
   * reach each child — with real links, so they are keyboard-reachable, open in
   * a new tab, and can be copied.
   */
  describe('family navigation', () => {
    it('a PARENT lists its children and links to each one', async () => {
      const { container } = await renderComponent(panel());
      const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
      expect(hrefs).toContain('/dashboard/products/child-1');
      expect(hrefs).toContain('/dashboard/products/child-2');
      // Each child is named, not just linked by id.
      expect(container.textContent).toContain('Nordic chair green');
      expect(container.textContent).toContain('Nordic chair blue');
    });

    it('does not link the row the reader is already on', async () => {
      // The parent's own row is the current page; a link back to itself is
      // navigation that goes nowhere.
      const onChild = await renderComponent(
        panel({ product: { id: 'child-1', name: 'Nordic chair green', slug: 'g', status: 'PUBLISHED' } as Product }),
      );
      const selfLink = Array.from(onChild.container.querySelectorAll('a')).find(
        (a) => a.getAttribute('href') === '/dashboard/products/child-1',
      );
      expect(selfLink).toBeUndefined();
    });

    it('a CHILD names its parent and links to it', async () => {
      const { container } = await renderComponent(
        panel({ product: { id: 'child-1', name: 'Nordic chair green', slug: 'g', status: 'PUBLISHED' } as Product }),
      );
      const parentLink = Array.from(container.querySelectorAll('a')).find(
        (a) => a.getAttribute('href') === '/dashboard/products/model-1',
      );
      expect(parentLink).toBeTruthy();
      expect(parentLink?.textContent).toContain('Nordic chair');
    });

    it('both directions use real anchors, so they are keyboard reachable', async () => {
      const { container } = await renderComponent(
        panel({ product: { id: 'child-1', name: 'Nordic chair green', slug: 'g', status: 'PUBLISHED' } as Product }),
      );
      const links = Array.from(container.querySelectorAll('a')).filter((a) =>
        a.getAttribute('href')?.startsWith('/dashboard/products/'),
      );
      expect(links.length).toBeGreaterThan(0);
      for (const link of links) {
        expect(link.tagName).toBe('A');
        // No anchor is removed from the tab order.
        expect(link.getAttribute('tabindex')).not.toBe('-1');
      }
    });
  });
});
