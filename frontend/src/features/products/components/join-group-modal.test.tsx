import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import React from 'react';
import { renderComponent, click, type as typeInto, cleanupAll, settle, flush } from '../../../test/render';
import ProductFamilyPanel from './product-family-panel';
import { LABEL_MAX_LENGTH } from './join-group-modal';
import { I18nProvider } from '../../../lib/i18n';
import { ToastProvider } from '../../../components/ui/toast';
import type { SessionScope } from '../../../lib/permissions';
import type { Product } from '../types/product.types';

const fetchMock = vi.fn();
vi.mock('../../../lib/api-client', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));

const MANAGER: SessionScope = {
  platform: false,
  role: 'ORGANIZATION_MANAGER',
  organizationId: 'org-1',
  storeId: null,
  allowedStoreIds: ['store-a', 'store-b'],
};
/** The same manager, working inside one branch. */
const NARROWED: SessionScope = { ...MANAGER, storeId: 'store-a' };

const STANDALONE = { id: 'solo', name: 'Lámpara', slug: 'lampara', status: 'PUBLISHED' } as unknown as Product;
const CARD_1 = {
  id: 'card-1',
  name: 'Lámparas de pie',
  children: [
    { id: 'k1', name: 'a' },
    { id: 'k2', name: 'b' },
  ],
};
const CARD_2 = { id: 'card-2', name: 'Lámparas de mesa', children: [{ id: 'k3', name: 'c' }] };
const GROUPS = { items: [CARD_1, CARD_2] };

/** As `apiRequest` throws: the server's message, with `status` and the raw `body`. */
const refusal = (message: string, status: number, body: Record<string, unknown> = { statusCode: status, message }) =>
  Object.assign(new Error(message), { status, body });
const CHANGING = 'Store membership kept changing while this was being applied. Please try again.';
const HIDDEN =
  '"Lámparas de pie" is hidden in "Centro", where the published item "Lámpara" is visible. Attaching it would remove the item from that branch. Publish the parent there first, or hide the item there.';

const panel = (props: Partial<React.ComponentProps<typeof ProductFamilyPanel>> = {}) => (
  <I18nProvider>
    <ToastProvider>
      <ProductFamilyPanel product={STANDALONE} family={null} accessToken="t" scope={MANAGER} {...props} />
    </ToastProvider>
  </I18nProvider>
);

type View = Awaited<ReturnType<typeof renderComponent>>;
const dialogOf = (view: View) => view.container.querySelector<HTMLElement>('[role="dialog"]');
const searchOf = (view: View) => view.container.querySelector<HTMLInputElement>('#family-join-search');
const labelOf = (view: View) => view.container.querySelector<HTMLInputElement>('#family-join-label');
const statusOf = (view: View) => view.container.querySelector<HTMLElement>('#family-join-status')?.textContent ?? '';
const attachCalls = () => fetchMock.mock.calls.filter(([path]) => String(path).includes('/family/members'));
const searchCalls = () => fetchMock.mock.calls.filter(([path]) => String(path).startsWith('/products?'));
const pressEscape = async () => {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
};

const open = async (view: View) => {
  await click(view.get('family-join-open'));
  await flush();
};
const searchFor = async (view: View, text: string) => {
  await typeInto(searchOf(view), text);
  await settle(400);
};
const pickFirst = async (view: View) => {
  await searchFor(view, 'Lámp');
  await click(view.get('family-join-candidate-card-1'));
  await flush();
};

describe('adding a standalone item to an existing group, in a dialog', () => {
  // Braces on purpose: `mockReset()` returns the mock, and a hook that RETURNS
  // a function hands vitest a teardown to call — with no arguments.
  beforeEach(() => {
    fetchMock.mockReset();
  });
  afterEach(() => cleanupAll());

  describe('opening and closing', () => {
    it('the section offers one button; it opens a named, modal dialog with focus on the search', async () => {
      const view = await renderComponent(panel());
      const button = view.get('family-join-open');
      expect(button.textContent).toBe('Add to an existing group');
      expect(button.getAttribute('aria-haspopup')).toBe('dialog');
      expect(dialogOf(view)).toBeNull();

      await open(view);
      const dialog = dialogOf(view);
      expect(dialog?.getAttribute('aria-modal')).toBe('true');
      expect(dialog?.getAttribute('aria-label')).toBe('Add to an existing group');
      expect(document.activeElement).toBe(searchOf(view));
      // Nothing is asked for until there is something to ask.
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Escape closes it and hands focus back to the button that opened it', async () => {
      const view = await renderComponent(panel());
      view.get('family-join-open').focus();
      await open(view);
      await pressEscape();
      expect(dialogOf(view)).toBeNull();
      expect(document.activeElement).toBe(view.get('family-join-open'));
    });

    it('Cancel closes it too, and reopening starts from nothing', async () => {
      fetchMock.mockResolvedValue(GROUPS);
      const view = await renderComponent(panel());
      await open(view);
      await pickFirst(view);
      await typeInto(labelOf(view), 'Grande');
      await click(view.get('family-join-cancel'));
      expect(dialogOf(view)).toBeNull();

      await open(view);
      expect(searchOf(view)?.value).toBe('');
      expect(view.find('family-join-picked')).toBeNull();
      expect(attachCalls()).toHaveLength(0);
    });
  });

  describe('searching', () => {
    it('does not search below two characters, and says why', async () => {
      const view = await renderComponent(panel());
      await open(view);
      await searchFor(view, 'L');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(statusOf(view)).toBe('Type at least two characters to search for a group.');
    });

    it('asks for GROUPS only, company-wide for a company-wide actor, and shows each group’s name and child count', async () => {
      fetchMock.mockResolvedValue(GROUPS);
      const view = await renderComponent(panel());
      await open(view);
      await searchFor(view, 'Lámp');

      const [path, options] = searchCalls()[0];
      const params = new URL(`http://x${path}`).searchParams;
      expect(params.get('search')).toBe('Lámp');
      expect(params.get('family')).toBe('parent');
      expect(params.get('limit')).toBe('10');
      expect(params.has('storeId')).toBe(false);
      expect((options as { method: string }).method).toBe('GET');

      expect(statusOf(view)).toBe('2 groups found.');
      expect(view.get('family-join-candidate-card-1').textContent).toBe('Lámparas de pie2 children');
      expect(view.get('family-join-candidate-card-2').textContent).toBe('Lámparas de mesa1 child');
    });

    it('for an actor working inside one branch, asks only for groups in that branch (#344)', async () => {
      fetchMock.mockResolvedValue(GROUPS);
      const view = await renderComponent(panel({ scope: NARROWED }));
      await open(view);
      await searchFor(view, 'Lámp');
      const params = new URL(`http://x${searchCalls()[0][0]}`).searchParams;
      expect(params.get('storeId')).toBe('store-a');
    });

    it('says so when no group matches, and when the search itself failed', async () => {
      fetchMock.mockResolvedValueOnce({ items: [] }).mockRejectedValueOnce(new Error('network'));
      const view = await renderComponent(panel());
      await open(view);
      await searchFor(view, 'Zz');
      expect(statusOf(view)).toBe('No group matches “Zz”.');
      await searchFor(view, 'Zzz');
      expect(statusOf(view)).toBe('Groups could not be searched. Check your connection and try again.');
    });

    it('a slow answer for an older query never replaces a newer one (#344)', async () => {
      let answerFirst!: (value: unknown) => void;
      fetchMock.mockImplementation((path: string) => {
        const search = new URL(`http://x${path}`).searchParams.get('search');
        if (search === 'La') return new Promise((resolve) => (answerFirst = resolve));
        return Promise.resolve({ items: [CARD_2] });
      });
      const view = await renderComponent(panel());
      await open(view);
      await searchFor(view, 'La');
      await searchFor(view, 'Lamp');
      expect(view.find('family-join-candidate-card-2')).not.toBeNull();

      // The answer for "La" arrives last; the box says "Lamp".
      await act(async () => answerFirst({ items: [CARD_1] }));
      await flush();
      expect(view.find('family-join-candidate-card-1')).toBeNull();
      expect(view.find('family-join-candidate-card-2')).not.toBeNull();
      expect(statusOf(view)).toBe('1 group found.');
    });

    it('an answer that arrives after the query fell below two characters brings no list back (#344)', async () => {
      let answer!: (value: unknown) => void;
      fetchMock.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      const view = await renderComponent(panel());
      await open(view);
      await searchFor(view, 'Lá');
      await searchFor(view, 'L');
      await act(async () => answer(GROUPS));
      await flush();
      expect(view.find('family-join-candidate-card-1')).toBeNull();
      expect(statusOf(view)).toBe('Type at least two characters to search for a group.');
    });
  });

  describe('selecting and labelling', () => {
    it('shows the picked group with its child count and moves focus to "Shows as"; "Change group" goes back to the search', async () => {
      fetchMock.mockResolvedValue(GROUPS);
      const view = await renderComponent(panel());
      await open(view);
      await pickFirst(view);

      expect(view.get('family-join-picked-name').textContent).toBe('Lámparas de pie');
      expect(view.get('family-join-picked').textContent).toContain('2 children');
      expect(document.activeElement).toBe(labelOf(view));

      await click(view.get('family-join-change'));
      await settle(10);
      expect(view.find('family-join-picked')).toBeNull();
      expect(document.activeElement).toBe(searchOf(view));
      // The query and its results are still there.
      expect(searchOf(view)?.value).toBe('Lámp');
    });

    it('"Change group" with a group and a label chosen sends nothing: it is not a submit', async () => {
      fetchMock.mockResolvedValue(GROUPS);
      const view = await renderComponent(panel());
      await open(view);
      await pickFirst(view);
      await typeInto(labelOf(view), 'Grande');
      expect((view.get('family-join-submit') as HTMLButtonElement).disabled).toBe(false);

      await click(view.get('family-join-change'));
      await settle(10);
      expect(attachCalls()).toHaveLength(0);
      expect(dialogOf(view)).not.toBeNull();
      expect(view.find('family-join-picked')).toBeNull();
    });

    it('will not submit without a label, or with only spaces', async () => {
      fetchMock.mockResolvedValue(GROUPS);
      const view = await renderComponent(panel());
      await open(view);
      await pickFirst(view);
      const submit = view.get('family-join-submit') as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      await typeInto(labelOf(view), '   ');
      expect(submit.disabled).toBe(true);
      await click(submit);
      expect(attachCalls()).toHaveLength(0);
      await typeInto(labelOf(view), 'Grande');
      expect(submit.disabled).toBe(false);
    });

    it(`holds the label to ${LABEL_MAX_LENGTH} characters, the backend's limit, and counts them`, async () => {
      fetchMock.mockResolvedValue(GROUPS);
      const view = await renderComponent(panel());
      await open(view);
      await pickFirst(view);
      const input = labelOf(view) as HTMLInputElement;
      expect(input.getAttribute('maxlength')).toBe(String(LABEL_MAX_LENGTH));
      await typeInto(input, 'x'.repeat(LABEL_MAX_LENGTH + 20));
      expect(input.value).toHaveLength(LABEL_MAX_LENGTH);
      expect(view.get('family-join-label-count').textContent).toBe(`${LABEL_MAX_LENGTH}/${LABEL_MAX_LENGTH}`);
    });
  });

  describe('submitting', () => {
    it('names the group as parent and this item as member, with the label trimmed; then closes and refreshes', async () => {
      const onChanged = vi.fn();
      fetchMock.mockImplementation((path: string) =>
        path.startsWith('/products?') ? Promise.resolve(GROUPS) : Promise.resolve({ data: { member: { id: 'solo' } } }),
      );
      const view = await renderComponent(panel({ onChanged }));
      await open(view);
      await pickFirst(view);
      await typeInto(labelOf(view), '  Grande ');
      await click(view.get('family-join-submit'));
      await flush();

      expect(attachCalls()).toHaveLength(1);
      const [path, options] = attachCalls()[0];
      expect(path).toBe('/products/card-1/family/members');
      expect((options as { method: string }).method).toBe('POST');
      expect(JSON.parse((options as { body: string }).body)).toEqual({ productId: 'solo', label: 'Grande' });
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(dialogOf(view)).toBeNull();
      expect(document.body.textContent).toContain('Added to the group');
    });

    it('after a join, focus goes to the section heading — and follows it once the item reloads as a child', async () => {
      fetchMock.mockImplementation((path: string) =>
        path.startsWith('/products?') ? Promise.resolve(GROUPS) : Promise.resolve({ data: { member: { id: 'solo' } } }),
      );
      const view = await renderComponent(panel());
      view.get('family-join-open').focus();
      await open(view);
      await pickFirst(view);
      await typeInto(labelOf(view), 'Grande');
      await click(view.get('family-join-submit'));
      await flush();

      // The dialog would give focus back to the button; the button is about to go.
      expect(dialogOf(view)).toBeNull();
      expect(document.activeElement).toBe(view.get('family-heading'));

      // The page reads the item again: it is a child now, the section is rebuilt.
      await view.rerender(
        panel({
          product: { ...STANDALONE, parent: { id: 'card-1', name: 'Lámparas de pie' } } as unknown as Product,
          family: {
            parentId: 'card-1',
            parentName: 'Lámparas de pie',
            members: [
              { id: 'k1', name: 'a', optionLabel: 'A' },
              { id: 'solo', name: 'Lámpara', optionLabel: 'Grande' },
            ],
          },
        }),
      );
      await flush();
      expect(view.find('family-join-open')).toBeNull();
      const heading = view.get('family-heading');
      expect(heading.textContent).toContain('Lámparas de pie');
      expect(document.activeElement).toBe(heading);
    });

    it('the wish for the heading’s focus survives the page reload that unmounts the panel', async () => {
      fetchMock.mockImplementation((path: string) =>
        path.startsWith('/products?') ? Promise.resolve(GROUPS) : Promise.resolve({ data: { member: { id: 'solo' } } }),
      );
      const wishes: boolean[] = [];
      const first = await renderComponent(panel({ onFocusHeadingChange: (wanted) => wishes.push(wanted) }));
      await open(first);
      await pickFirst(first);
      await typeInto(labelOf(first), 'Grande');
      await click(first.get('family-join-submit'));
      await flush();
      expect(wishes).toEqual([true]);

      // The page shows "Loading…" while it reads the item again: this panel is gone.
      first.unmount();
      // A new panel, holding the page's wish, first sees the item before its family has loaded…
      const second = await renderComponent(
        panel({
          product: { ...STANDALONE, parent: { id: 'card-1', name: 'Lámparas de pie' } } as unknown as Product,
          focusHeading: true,
          onFocusHeadingChange: (wanted) => wishes.push(wanted),
        }),
      );
      expect(document.activeElement).toBe(second.get('family-heading'));
      expect(wishes).toEqual([true]);
      // …and once it has, the rebuilt heading has the focus and the wish is spent.
      await second.rerender(
        panel({
          product: { ...STANDALONE, parent: { id: 'card-1', name: 'Lámparas de pie' } } as unknown as Product,
          family: {
            parentId: 'card-1',
            parentName: 'Lámparas de pie',
            members: [{ id: 'solo', name: 'Lámpara', optionLabel: 'Grande' }],
          },
          focusHeading: true,
          onFocusHeadingChange: (wanted) => wishes.push(wanted),
        }),
      );
      await flush();
      expect(document.activeElement).toBe(second.get('family-heading'));
      expect(second.get('family-heading').textContent).toContain('Lámparas de pie');
      expect(wishes).toEqual([true, false]);
    });

    it('a wish for the heading that was never spent does not pull focus out of the dialog when it opens', async () => {
      // The reload after a join brought no family (the parent could not be
      // read, or the item is still standalone): the page still holds the wish.
      const wishes: boolean[] = [];
      // Held the way the detail page holds it: state, and its setter.
      function Page() {
        const [wish, setWish] = React.useState(true);
        return panel({
          focusHeading: wish,
          onFocusHeadingChange: (wanted) => {
            wishes.push(wanted);
            setWish(wanted);
          },
        });
      }
      const view = await renderComponent(<Page />);
      expect(document.activeElement).toBe(view.get('family-heading'));

      // A real click focuses the button it lands on; `.click()` here does not.
      view.get('family-join-open').focus();
      await open(view);
      expect(dialogOf(view)?.contains(document.activeElement)).toBe(true);
      expect(document.activeElement).toBe(searchOf(view));
      expect(wishes).toEqual([false]);

      await pressEscape();
      expect(dialogOf(view)).toBeNull();
      expect(document.activeElement).toBe(view.get('family-join-open'));
    });

    it('a refusal is shown in the dialog as the backend said it, with no retry, and the form kept', async () => {
      const onChanged = vi.fn();
      fetchMock.mockImplementation((path: string) =>
        path.startsWith('/products?') ? Promise.resolve(GROUPS) : Promise.reject(refusal(HIDDEN, 400)),
      );
      const view = await renderComponent(panel({ onChanged }));
      await open(view);
      await pickFirst(view);
      await typeInto(labelOf(view), 'Grande');
      await click(view.get('family-join-submit'));
      await flush();

      const notice = view.get('family-join-refusal');
      expect(notice.getAttribute('role')).toBe('alert');
      expect(dialogOf(view)?.contains(notice)).toBe(true);
      expect(notice.textContent).toContain('is hidden in "Centro"');
      expect(view.find('family-join-refusal-retry')).toBeNull();
      expect(view.get('family-join-picked-name').textContent).toBe('Lámparas de pie');
      expect(labelOf(view)?.value).toBe('Grande');
      expect(onChanged).not.toHaveBeenCalled();
    });

    it('after a permanent refusal the same request cannot be sent again — not by the button, not by Enter — until the label or the group changes', async () => {
      fetchMock.mockImplementation((path: string) =>
        path.startsWith('/products?') ? Promise.resolve(GROUPS) : Promise.reject(refusal(HIDDEN, 400)),
      );
      const view = await renderComponent(panel());
      await open(view);
      await pickFirst(view);
      await typeInto(labelOf(view), 'Grande');
      const submit = () => view.get('family-join-submit') as HTMLButtonElement;
      await click(submit());
      await flush();
      expect(view.find('family-join-refusal')).not.toBeNull();
      expect(submit().disabled).toBe(true);

      await click(submit());
      await act(async () => {
        view.get('family-join-modal').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      });
      await flush();
      expect(attachCalls()).toHaveLength(1);

      // A different label is a different request.
      await typeInto(labelOf(view), 'Grandes');
      expect(view.find('family-join-refusal')).toBeNull();
      expect(submit().disabled).toBe(false);

      // So is a different group: refuse again, then change the group.
      await click(submit());
      await flush();
      expect(submit().disabled).toBe(true);
      await click(view.get('family-join-change'));
      await settle(10);
      await click(view.get('family-join-candidate-card-2'));
      await flush();
      expect(view.find('family-join-refusal')).toBeNull();
      expect(submit().disabled).toBe(false);
      expect(attachCalls()).toHaveLength(2);
    });

    it('after the lock-retry exhaustion the request stays sendable: it is not permanent', async () => {
      fetchMock.mockImplementation((path: string) =>
        path.startsWith('/products?') ? Promise.resolve(GROUPS) : Promise.reject(refusal(CHANGING, 409)),
      );
      const view = await renderComponent(panel());
      await open(view);
      await pickFirst(view);
      await typeInto(labelOf(view), 'Grande');
      await click(view.get('family-join-submit'));
      await flush();
      expect(view.find('family-join-refusal-retry')).not.toBeNull();
      expect((view.get('family-join-submit') as HTMLButtonElement).disabled).toBe(false);
    });

    it('a refusal belongs to the request that met it: editing the label clears it (#344)', async () => {
      fetchMock.mockImplementation((path: string) =>
        path.startsWith('/products?') ? Promise.resolve(GROUPS) : Promise.reject(refusal(CHANGING, 409)),
      );
      const view = await renderComponent(panel());
      await open(view);
      await pickFirst(view);
      await typeInto(labelOf(view), 'Grande');
      await click(view.get('family-join-submit'));
      await flush();
      expect(view.find('family-join-refusal-retry')).not.toBeNull();

      await typeInto(labelOf(view), 'Grandes');
      expect(view.find('family-join-refusal')).toBeNull();
    });

    it('the lock-retry exhaustion is offered again, and the retry sends the same request', async () => {
      const onChanged = vi.fn();
      let attempts = 0;
      fetchMock.mockImplementation((path: string) => {
        if (path.startsWith('/products?')) return Promise.resolve(GROUPS);
        attempts += 1;
        return attempts === 1
          ? Promise.reject(refusal(CHANGING, 409))
          : Promise.resolve({ data: { member: { id: 'solo' } } });
      });
      const view = await renderComponent(panel({ onChanged }));
      await open(view);
      await pickFirst(view);
      await typeInto(labelOf(view), 'Grande');
      await click(view.get('family-join-submit'));
      await flush();
      expect(view.get('family-join-refusal').textContent).toContain('kept changing');

      await click(view.get('family-join-refusal-retry'));
      await flush();
      const bodies = attachCalls().map(([, options]) => JSON.parse((options as { body: string }).body));
      expect(bodies).toEqual([
        { productId: 'solo', label: 'Grande' },
        { productId: 'solo', label: 'Grande' },
      ]);
      expect(onChanged).toHaveBeenCalledTimes(1);
      expect(dialogOf(view)).toBeNull();
    });

    it('a lifecycle 409 — a 409 with a code — is a refusal, not a retry', async () => {
      const message =
        'That record has been removed, so this operation cannot reference it. Ask the platform owner to restore it first.';
      fetchMock.mockImplementation((path: string) =>
        path.startsWith('/products?')
          ? Promise.resolve(GROUPS)
          : Promise.reject(refusal(message, 409, { message, code: 'LIFECYCLE_RECORD_REMOVED' })),
      );
      const view = await renderComponent(panel());
      await open(view);
      await pickFirst(view);
      await typeInto(labelOf(view), 'Grande');
      await click(view.get('family-join-submit'));
      await flush();
      expect(view.get('family-join-refusal').textContent).toContain('That record has been removed');
      expect(view.find('family-join-refusal-retry')).toBeNull();
    });

    it('is busy while the request is in flight: no second request, no Cancel, and Escape does not close it', async () => {
      let release!: (value: unknown) => void;
      fetchMock.mockImplementation((path: string) =>
        path.startsWith('/products?') ? Promise.resolve(GROUPS) : new Promise((resolve) => (release = resolve)),
      );
      const view = await renderComponent(panel());
      await open(view);
      await pickFirst(view);
      await typeInto(labelOf(view), 'Grande');
      const submit = view.get('family-join-submit') as HTMLButtonElement;
      await click(submit);
      await flush();

      expect(submit.disabled).toBe(true);
      expect((view.get('family-join-cancel') as HTMLButtonElement).disabled).toBe(true);
      expect(labelOf(view)?.disabled).toBe(true);
      await click(submit);
      await pressEscape();
      expect(attachCalls()).toHaveLength(1);
      expect(dialogOf(view)).not.toBeNull();

      await act(async () => release({ data: { member: { id: 'solo' } } }));
      await flush();
      expect(dialogOf(view)).toBeNull();
    });
  });
});
