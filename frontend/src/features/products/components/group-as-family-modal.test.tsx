import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { renderComponent, cleanupAll, click, type as typeInto } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import GroupAsFamilyModal, { proposeLabel, groupBlockedReason } from './group-as-family-modal';
import type { FamilyMemberDraft } from './group-as-family-modal';
import type { Product } from '../types/product.types';

const p = (o: Partial<Product>): Product =>
  ({ id: 'x', name: 'n', slug: 's', price: 10, status: 'PUBLISHED', ...o }) as Product;

const S = p({ id: 's', name: 'Camiseta Small', price: 10 });
const M = p({ id: 'm', name: 'Camiseta Medium', price: 20 });
const t = (k: string) => k;

afterEach(() => cleanupAll());

const modal = (selected: Product[] = [S, M], over: Partial<React.ComponentProps<typeof GroupAsFamilyModal>> = {}) =>
  renderComponent(
    <I18nProvider>
      <GroupAsFamilyModal
        selected={selected}
        onCancel={() => undefined}
        onValidate={async () => null}
        onConfirm={async () => 'new-parent'}
        {...over}
      />
    </I18nProvider>,
  );

/**
 * Grouping creates a NEW card and sacrifices nothing.
 *
 * Promoting one of the selected items was rejected: a parent is not
 * purchasable, so promoting "Small" would have removed Small from sale.
 */
describe('group as parent and children', () => {
  describe('which selections may be grouped', () => {
    it('needs at least two items', () => {
      expect(groupBlockedReason([S], t)).toMatch(/at least two/i);
      expect(groupBlockedReason([S, M], t)).toBeNull();
    });

    it('refuses anything that is not standalone', () => {
      const child = p({ id: 'c', parent: { id: 'card', name: 'Card' } });
      const parent = p({ id: 'k', children: [{ id: 'a', name: 'A' }] });
      expect(groupBlockedReason([S, child], t)).toMatch(/standalone/i);
      expect(groupBlockedReason([S, parent], t)).toMatch(/standalone/i);
    });

    it('refuses a mix of published and draft, and says to align them', () => {
      const draft = p({ id: 'd', status: 'DRAFT' });
      expect(groupBlockedReason([S, draft], t)).toMatch(/published or all draft/i);
      // All-draft is fine.
      expect(groupBlockedReason([draft, p({ id: 'e', status: 'DRAFT' })], t)).toBeNull();
    });
  });

  describe('label proposals', () => {
    it('proposes what the name adds to the card name', () => {
      expect(proposeLabel('Camiseta Small', 'Camiseta')).toBe('Small');
      expect(proposeLabel('Silla Nordic Verde', 'Silla Nordic')).toBe('Verde');
    });

    it('ignores case when stripping the shared part', () => {
      expect(proposeLabel('CAMISETA Small', 'camiseta')).toBe('Small');
    });

    it('falls back to the whole name when nothing is shared', () => {
      expect(proposeLabel('Verde', 'Silla')).toBe('Verde');
      expect(proposeLabel('Verde', '')).toBe('Verde');
    });

    it('never proposes an empty label', () => {
      expect(proposeLabel('Camiseta', 'Camiseta')).toBe('Camiseta');
    });
  });

  describe('the preview states what will happen', () => {
    it('says a non-purchasable card is created and the items stay purchasable', async () => {
      const { get } = await modal();
      const text = get('group-preview').textContent ?? '';
      expect(text).toMatch(/never sold/i);
      expect(text).toMatch(/stays purchasable/i);
      expect(text).toMatch(/derived from them/i);
    });

    it('says whether the new parent will be Published or Draft', async () => {
      const published = await modal();
      expect(published.get('group-preview-status').textContent).toMatch(/Published/);
      cleanupAll();
      const draft = await modal([p({ id: 'a', status: 'DRAFT' }), p({ id: 'b', status: 'DRAFT' })]);
      expect(draft.get('group-preview-status').textContent).toMatch(/Draft/);
    });

    it('does not claim the copied price is what a customer pays', async () => {
      const { get } = await modal();
      expect(get('group-preview-price').textContent).toMatch(/sorting only/i);
      expect(get('group-preview-price').textContent).toMatch(/each child/i);
    });
  });

  describe('labels the reader must fix before confirming', () => {
    it('refuses to confirm without a parent name', async () => {
      const { get } = await modal();
      expect((get('group-confirm') as HTMLButtonElement).disabled).toBe(true);
      expect(get('group-problem').textContent).toMatch(/needs a name/i);
    });

    it('refuses a blank label', async () => {
      const { get } = await modal();
      await typeInto(get('group-parent-name'), 'Camiseta');
      await typeInto(get('group-label-s'), '   ');
      expect(get('group-problem').textContent).toMatch(/needs a label/i);
      expect((get('group-confirm') as HTMLButtonElement).disabled).toBe(true);
    });

    it('refuses two labels that differ only in case', async () => {
      const { get } = await modal();
      await typeInto(get('group-parent-name'), 'Camiseta');
      await typeInto(get('group-label-s'), 'Verde');
      await typeInto(get('group-label-m'), 'verde');
      expect(get('group-problem').textContent).toMatch(/same label/i);
      expect((get('group-confirm') as HTMLButtonElement).disabled).toBe(true);
    });

    it('enables confirmation once the name and labels are usable', async () => {
      const { get } = await modal();
      await typeInto(get('group-parent-name'), 'Camiseta');
      await typeInto(get('group-label-s'), 'Small');
      await typeInto(get('group-label-m'), 'Medium');
      expect((get('group-confirm') as HTMLButtonElement).disabled).toBe(false);
    });
  });

  describe('confirmation', () => {
    it('sends the entered name and every child label', async () => {
      const onConfirm = vi.fn(async (_name: string, _members: FamilyMemberDraft[]) => 'new-parent');
      const { get } = await modal([S, M], { onConfirm });
      await typeInto(get('group-parent-name'), 'Camiseta');
      await typeInto(get('group-label-s'), 'Small');
      await typeInto(get('group-label-m'), 'Medium');
      await click(get('group-confirm'));
      expect(onConfirm).toHaveBeenCalledWith('Camiseta', [
        { id: 's', label: 'Small' },
        { id: 'm', label: 'Medium' },
      ]);
    });

    it('shows the backend refusal and stays open', async () => {
      const onConfirm = vi.fn(async () => {
        throw new Error('"Camiseta Small" is already a child of another parent');
      });
      const { get, find } = await modal([S, M], { onConfirm });
      await typeInto(get('group-parent-name'), 'Camiseta');
      await typeInto(get('group-label-s'), 'Small');
      await typeInto(get('group-label-m'), 'Medium');
      await click(get('group-confirm'));
      expect(get('group-problem').textContent).toMatch(/already a child/i);
      // The modal is still there, with the reader's work intact.
      expect(find('group-modal')).not.toBeNull();
      expect((get('group-parent-name') as HTMLInputElement).value).toBe('Camiseta');
    });

    it('relays the ADVISORY preflight verdict without deciding for itself', async () => {
      const onValidate = vi.fn(async () => 'That item belongs to no store');
      const { get } = await modal([S, M], { onValidate });
      await typeInto(get('group-parent-name'), 'Camiseta');
      await typeInto(get('group-label-s'), 'Small');
      await typeInto(get('group-label-m'), 'Medium');
      // React listens for `focusout`, not the non-bubbling native `blur`.
      await act(async () => {
        get('group-label-m').dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
      expect(onValidate).toHaveBeenCalledWith('Camiseta', [
        { id: 's', label: 'Small' },
        { id: 'm', label: 'Medium' },
      ]);
      // The interface RELAYS the verdict; it does not decide for itself.
      expect(get('group-problem').textContent).toContain('belongs to no store');
    });
  });

  /**
   * A backend answer is about the exact text it was asked with. Once that text
   * changes, an answer still on screen is about something nobody is proposing.
   */
  describe('a stale advisory refusal does not outlive the input it judged', () => {
    const refuse = async () => 'That item belongs to no store';
    const settle = async (el: Element) =>
      act(async () => {
        el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });

    it('clears when the parent NAME changes', async () => {
      const { get, find } = await modal([S, M], { onValidate: refuse });
      await typeInto(get('group-parent-name'), 'Camiseta');
      await typeInto(get('group-label-s'), 'Small');
      await typeInto(get('group-label-m'), 'Medium');
      await settle(get('group-label-m'));
      expect(get('group-problem').textContent).toContain('belongs to no store');

      await typeInto(get('group-parent-name'), 'Camiseta v2');
      expect(find('group-problem')).toBeNull();
    });

    it('clears when a CHILD LABEL changes', async () => {
      const { get, find } = await modal([S, M], { onValidate: refuse });
      await typeInto(get('group-parent-name'), 'Camiseta');
      await typeInto(get('group-label-s'), 'Small');
      await typeInto(get('group-label-m'), 'Medium');
      await settle(get('group-label-m'));
      expect(get('group-problem').textContent).toContain('belongs to no store');

      await typeInto(get('group-label-m'), 'Mediana');
      expect(find('group-problem')).toBeNull();
    });

    it('keeps a verdict that is still about the input on screen', async () => {
      const { get } = await modal([S, M], { onValidate: refuse });
      await typeInto(get('group-parent-name'), 'Camiseta');
      await typeInto(get('group-label-s'), 'Small');
      await typeInto(get('group-label-m'), 'Medium');
      await settle(get('group-label-m'));
      // Focus moving around is not an edit: the answer still applies.
      await settle(get('group-parent-name'));
      expect(get('group-problem').textContent).toContain('belongs to no store');
    });

    it('discards a verdict that arrives about superseded input', async () => {
      let release: (value: string | null) => void = () => undefined;
      const onValidate = vi.fn(
        () =>
          new Promise<string | null>((resolve) => {
            release = resolve;
          }),
      );
      const { get, find } = await modal([S, M], { onValidate });
      await typeInto(get('group-parent-name'), 'Camiseta');
      await typeInto(get('group-label-s'), 'Small');
      await typeInto(get('group-label-m'), 'Medium');
      await settle(get('group-label-m'));

      // The reader types on while the check is in flight, and only then does
      // the answer to the OLD text come back.
      await typeInto(get('group-parent-name'), 'Camiseta v2');
      await act(async () => {
        release('That item belongs to no store');
      });
      expect(find('group-problem')).toBeNull();
    });
  });

  describe('accessibility', () => {
    it('is a labelled dialog', async () => {
      const { get } = await modal();
      // The shared Modal supplies the dialog itself: role, aria-modal, the
      // overlay that keeps the fixed bulk bar off the buttons, the focus trap
      // and Escape. This asserts the content is INSIDE one.
      const dialog = get('group-modal').closest('[role="dialog"]');
      expect(dialog).not.toBeNull();
      expect(dialog!.getAttribute('aria-modal')).toBe('true');
      expect(dialog!.getAttribute('aria-label')).toBeTruthy();
    });

    it('gives every label input an accessible name naming its item', async () => {
      const { get } = await modal();
      expect(get('group-label-s').getAttribute('aria-label')).toContain('Camiseta Small');
    });

    it('announces the problem and binds it to the disabled confirm', async () => {
      const { get, container } = await modal();
      expect(get('group-problem').getAttribute('role')).toBe('alert');
      const describedBy = get('group-confirm').getAttribute('aria-describedby');
      expect(describedBy).toBe('group-problem-desc');
      expect(container.querySelector(`#${describedBy}`)?.textContent).toMatch(/needs a name/i);
    });
  });
});

/**
 * The SAME modal, opened from a suggestion.
 *
 * PR D folded suggestions into Items rather than keeping a second grouping
 * workflow, which means a suggestion opens this modal — one preflight, one
 * preview, one set of refusals. A proposal is a starting point, never a
 * decision, so everything it fills in stays editable.
 */
describe('opened from a suggestion', () => {
  const seeded = (over: Partial<React.ComponentProps<typeof GroupAsFamilyModal>> = {}) =>
    modal([S, M], {
      initialName: 'Camiseta',
      initialLabels: { s: 'Small', m: 'Medium' },
      ...over,
    });

  it('starts with the suggested name and labels', async () => {
    const r = await seeded();
    expect((r.get('group-parent-name') as HTMLInputElement).value).toBe('Camiseta');
    expect((r.get('group-label-s') as HTMLInputElement).value).toBe('Small');
    expect((r.get('group-label-m') as HTMLInputElement).value).toBe('Medium');
  });

  /**
   * Labels normally follow the card name until the reader edits one. A
   * suggested label is already a decision somebody may keep, so the proposal
   * effect must not overwrite it on the first render.
   */
  it('does not overwrite a suggested label with a proposal', async () => {
    const r = await seeded({ initialLabels: { s: 'Pequeña', m: 'Mediana' } });
    expect((r.get('group-label-s') as HTMLInputElement).value).toBe('Pequeña');
    expect((r.get('group-label-m') as HTMLInputElement).value).toBe('Mediana');
  });

  it('lets the reader change both', async () => {
    const sent: { name: string; members: { id: string; label: string }[] }[] = [];
    const r = await seeded({
      onConfirm: async (name, members) => {
        sent.push({ name, members });
        return 'new-parent';
      },
    });
    await typeInto(r.get('group-parent-name'), 'Camiseta lisa');
    await typeInto(r.get('group-label-s'), 'S');
    await click(r.get('group-confirm'));
    expect(sent).toEqual([
      { name: 'Camiseta lisa', members: [{ id: 's', label: 'S' }, { id: 'm', label: 'Medium' }] },
    ]);
  });

  /**
   * Readiness is ADVISORY: the catalogue can move between reading it and
   * pressing the button, so the authoritative refusal still arrives here.
   */
  it('shows the refusal when the catalogue moved after the suggestion was read', async () => {
    const r = await seeded({
      onConfirm: async () => {
        throw new Error('"Camiseta Small" is in no shop.');
      },
    });
    await click(r.get('group-confirm'));
    expect(r.get('group-problem').textContent).toMatch(/in no shop/i);
  });
});

/**
 * EDITING WHAT EACH CHILD IS CALLED, WHILE GROUPING.
 *
 * Reviewing the items is the moment somebody notices that one is called
 * "Camiseta Small" and should simply be "Small". Two different questions are
 * being asked about the same item — what it is called, and the single word the
 * selector shows for it — so they are two labelled fields, and editing one
 * must never be mistaken for editing the other.
 */
describe('child item names', () => {
  const nameField = (r: any, id: string) => r.get(`group-name-${id}`) as HTMLInputElement;
  const labelField = (r: any, id: string) => r.get(`group-label-${id}`) as HTMLInputElement;
  const confirmButton = (r: any) =>
    Array.from(r.container.querySelectorAll('button')).find((b: any) =>
      /group|crear|create/i.test((b.textContent || '').trim()),
    ) as HTMLButtonElement;

  it('starts each field at the item current name, tied to that item', async () => {
    const r = await modal();
    expect(nameField(r, 's').value).toBe('Camiseta Small');
    expect(nameField(r, 'm').value).toBe('Camiseta Medium');
    // The accessible name is the VISIBLE label plus which item it is, so the
    // two fields for one item are distinguishable by more than their owner.
    expect(nameField(r, 's').getAttribute('aria-labelledby')).toBe('group-name-label-s group-name-owner-s');
    expect(r.container.querySelector('#group-name-label-s')?.textContent).toBe('Item name');
    expect(r.container.querySelector('#group-name-owner-s')?.textContent).toBe('Camiseta Small');
    expect(labelField(r, 's').getAttribute('aria-label')).toBe('Label for Camiseta Small');
    // And the two fields are distinguishable by their own visible labels.
    expect(r.container.textContent).toContain('Item name');
    expect(r.container.textContent).toContain('Selector label');
  });

  it('sends no name at all when nothing was edited', async () => {
    const onConfirm = vi.fn(async (_name: string, _members: FamilyMemberDraft[]) => 'new-parent');
    const r = await modal([S, M], { onConfirm });
    await typeInto(r.get('group-parent-name'), 'Camiseta');
    await click(confirmButton(r));
    const [, members] = onConfirm.mock.calls[0];
    expect(members.map((m: any) => m.name)).toEqual([undefined, undefined]);
    expect(members.map((m: any) => m.id)).toEqual(['s', 'm']);
  });

  it('sends the rename for the one child that was edited', async () => {
    const onConfirm = vi.fn(async (_name: string, _members: FamilyMemberDraft[]) => 'new-parent');
    const r = await modal([S, M], { onConfirm });
    await typeInto(r.get('group-parent-name'), 'Camiseta');
    await typeInto(nameField(r, 's'), 'Small');
    await click(confirmButton(r));
    const [, members] = onConfirm.mock.calls[0];
    expect(members).toEqual([
      { id: 's', label: expect.any(String), name: 'Small' },
      { id: 'm', label: expect.any(String) },
    ]);
  });

  it('sends every rename when several children were edited', async () => {
    const onConfirm = vi.fn(async (_name: string, _members: FamilyMemberDraft[]) => 'new-parent');
    const r = await modal([S, M], { onConfirm });
    await typeInto(r.get('group-parent-name'), 'Camiseta');
    await typeInto(nameField(r, 's'), 'Small');
    await typeInto(nameField(r, 'm'), 'Medium');
    await click(confirmButton(r));
    const [parentName, members] = onConfirm.mock.calls[0];
    expect(parentName, 'the parent name travels with them').toBe('Camiseta');
    expect(members.map((m: any) => m.name)).toEqual(['Small', 'Medium']);
  });

  it('keeps the selector label a separate field from the name', async () => {
    const onConfirm = vi.fn(async (_name: string, _members: FamilyMemberDraft[]) => 'new-parent');
    const r = await modal([S, M], { onConfirm });
    await typeInto(r.get('group-parent-name'), 'Camiseta');
    await typeInto(nameField(r, 's'), 'Small');
    await typeInto(labelField(r, 's'), 'S');
    await click(confirmButton(r));
    const [, members] = onConfirm.mock.calls[0];
    expect(members[0]).toEqual({ id: 's', label: 'S', name: 'Small' });
    // Editing the name did not rewrite the label, nor the other way round.
    expect(nameField(r, 's').value).toBe('Small');
    expect(labelField(r, 's').value).toBe('S');
  });

  it('refuses an empty name, under the field it is about, and does not submit', async () => {
    const onConfirm = vi.fn(async (_name: string, _members: FamilyMemberDraft[]) => 'new-parent');
    const r = await modal([S, M], { onConfirm });
    await typeInto(r.get('group-parent-name'), 'Camiseta');
    await typeInto(nameField(r, 's'), '   ');
    const problem = r.get('group-name-problem-s');
    expect(problem.textContent).toBe('An item needs a name.');
    expect(problem.getAttribute('role')).toBe('alert');
    expect(nameField(r, 's').getAttribute('aria-invalid')).toBe('true');
    expect(nameField(r, 's').getAttribute('aria-describedby')).toBe('group-name-problem-s');
    // The other child is untouched by its neighbour's problem.
    expect(r.find('group-name-problem-m')).toBeNull();
    await click(confirmButton(r));
    expect(onConfirm, 'nothing was sent').not.toHaveBeenCalled();
  });

  it('refuses a name past the column limit', async () => {
    const onConfirm = vi.fn(async (_name: string, _members: FamilyMemberDraft[]) => 'new-parent');
    const r = await modal([S, M], { onConfirm });
    await typeInto(r.get('group-parent-name'), 'Camiseta');
    await typeInto(nameField(r, 's'), 'x'.repeat(256));
    expect(r.get('group-name-problem-s').textContent).toBe('A name can be at most 255 characters.');
    await click(confirmButton(r));
    expect(onConfirm).not.toHaveBeenCalled();
    // Exactly the limit is accepted.
    await typeInto(nameField(r, 's'), 'y'.repeat(255));
    expect(r.find('group-name-problem-s')).toBeNull();
  });

  it('warns about two identical names without blocking the save', async () => {
    const onConfirm = vi.fn(async (_name: string, _members: FamilyMemberDraft[]) => 'new-parent');
    const r = await modal([S, M], { onConfirm });
    await typeInto(r.get('group-parent-name'), 'Camiseta');
    await typeInto(nameField(r, 's'), 'Uno');
    await typeInto(nameField(r, 'm'), 'Uno');
    expect(r.get('group-duplicate-names')).not.toBeNull();
    await click(confirmButton(r));
    expect(onConfirm, 'allowed, because ordinary items may share a name').toHaveBeenCalled();
  });

  it('keeps the entered names when the save fails, and claims no success', async () => {
    const onConfirm = vi.fn(async () => {
      throw new Error('the catalogue moved under you');
    });
    const r = await modal([S, M], { onConfirm });
    await typeInto(r.get('group-parent-name'), 'Camiseta');
    await typeInto(nameField(r, 's'), 'Small');
    await click(confirmButton(r));
    expect(nameField(r, 's').value, 'the typing survives for correction').toBe('Small');
    expect(r.get('group-problem').textContent).toContain('the catalogue moved under you');
  });

  it('cancelling sends nothing at all', async () => {
    const onConfirm = vi.fn(async (_name: string, _members: FamilyMemberDraft[]) => 'new-parent');
    const onCancel = vi.fn();
    const r = await modal([S, M], { onConfirm, onCancel });
    await typeInto(nameField(r, 's'), 'Small');
    const cancel = Array.from(r.container.querySelectorAll('button')).find((b: any) =>
      /cancel|cancelar/i.test((b.textContent || '').trim()),
    ) as HTMLButtonElement;
    await click(cancel);
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  /**
   * OPENING THE MODAL IS NOT EDITING. A stored name that happens to carry
   * padding must come back exactly as it was stored unless somebody typed in
   * the field, or merely reviewing a grouping would silently rewrite names.
   */
  it('never renames a child whose field was not touched, padding and all', async () => {
    const padded = p({ id: 'pad', name: ' Silla Roja ', price: 5 });
    const onConfirm = vi.fn(async (_name: string, _members: FamilyMemberDraft[]) => 'new-parent');
    const r = await modal([padded, M], { onConfirm });
    await typeInto(r.get('group-parent-name'), 'Silla');
    await click(confirmButton(r));
    const [, members] = onConfirm.mock.calls[0];
    expect(members[0], 'no name at all was sent').toEqual({ id: 'pad', label: expect.any(String) });
    expect(members[0].name).toBeUndefined();
  });

  it('sends the rename when the reader does edit a padded name, and shows what will be saved', async () => {
    const padded = p({ id: 'pad', name: ' Silla Roja ', price: 5 });
    const onConfirm = vi.fn(async (_name: string, _members: FamilyMemberDraft[]) => 'new-parent');
    const r = await modal([padded, M], { onConfirm });
    await typeInto(r.get('group-parent-name'), 'Silla');
    await typeInto(nameField(r, 'pad'), '  Silla Roja  ');
    // On leaving the field it settles on exactly what the request will carry.
    await act(async () => {
      // React delegates blur through focusout, not the non-bubbling blur.
      nameField(r, 'pad').dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(nameField(r, 'pad').value).toBe('Silla Roja');
    await click(confirmButton(r));
    const [, members] = onConfirm.mock.calls[0];
    expect(members[0].name).toBe('Silla Roja');
  });

  it('counts a name in characters, not UTF-16 units, so an emoji costs one', async () => {
    const onConfirm = vi.fn(async (_name: string, _members: FamilyMemberDraft[]) => 'new-parent');
    const r = await modal([S, M], { onConfirm });
    await typeInto(r.get('group-parent-name'), 'Camiseta');
    // 255 emoji are 510 UTF-16 units and 255 characters: the column and the
    // endpoint both accept them, so the field must not refuse them.
    await typeInto(nameField(r, 's'), '🙂'.repeat(255));
    expect(r.find('group-name-problem-s')).toBeNull();
    await typeInto(nameField(r, 's'), '🙂'.repeat(256));
    expect(r.get('group-name-problem-s').textContent).toBe('A name can be at most 255 characters.');
  });

  it('states an empty name once, beside its field and nowhere else', async () => {
    const r = await modal([S, M]);
    await typeInto(r.get('group-parent-name'), 'Camiseta');
    await typeInto(nameField(r, 's'), '   ');
    const alerts = Array.from(r.container.querySelectorAll('[role="alert"]')).map((n) => n.textContent);
    expect(alerts.filter((a) => a === 'An item needs a name.')).toHaveLength(1);
    // The panel at the bottom does not repeat it.
    expect(r.find('group-problem')).toBeNull();
  });

  it('has a Spanish entry for every string it added', async () => {
    const { ES } = await import('../../../lib/translations.es');
    for (const key of [
      'Each child: its name, and what the selector shows',
      'Item name',
      'Selector label',
      'Name for {name}',
      'An item needs a name.',
      'A name can be at most 255 characters.',
      'Two children would end up with the same name. That is allowed, but check it is what you meant.',
    ]) {
      expect(ES[key], `missing Spanish for "${key}"`).toBeTruthy();
      expect(ES[key]).not.toBe(key);
    }
  });
});
