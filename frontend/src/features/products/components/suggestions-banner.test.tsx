import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import SuggestionsBanner from './suggestions-banner';
import type { FamilySuggestion } from '../services/family-suggestions.service';

const suggestion = (over: Partial<FamilySuggestion> = {}): FamilySuggestion => ({
  name: 'Camiseta lisa',
  members: [
    { id: 'a', name: 'Camiseta lisa roja', label: 'Roja' },
    { id: 'b', name: 'Camiseta lisa azul', label: 'Azul' },
  ],
  readiness: 'READY',
  blockedReasons: [],
  ...over,
});

const blocked = (name: string) =>
  suggestion({ name, readiness: 'BLOCKED', blockedReasons: ['MEMBER_WITHOUT_STORE'] });

afterEach(() => cleanupAll());

const banner = (over: Partial<React.ComponentProps<typeof SuggestionsBanner>> = {}) =>
  renderComponent(
    <I18nProvider>
      <SuggestionsBanner
        suggestions={[suggestion()]}
        canManage
        open={false}
        onToggle={() => undefined}
        onReview={() => undefined}
        onDismiss={() => undefined}
        {...over}
      />
    </I18nProvider>,
  );

describe('the suggestions banner in Items', () => {
  describe('when it says nothing at all', () => {
    it('is silent while the answer is unknown', async () => {
      const r = await banner({ suggestions: null });
      expect(r.find('suggestions-banner')).toBeNull();
    });

    it('is silent when there is nothing to group — no broken empty banner', async () => {
      const r = await banner({ suggestions: [] });
      expect(r.find('suggestions-banner')).toBeNull();
    });

    it('still speaks to somebody who may only look', async () => {
      // Reading and acting are separate: the server already decided which
      // products this reader may see, and what those products look like
      // together is the same information.
      const r = await banner({ canManage: false });
      expect(r.find('suggestions-banner')).not.toBeNull();
    });
  });

  describe('a reader who may not group', () => {
    it('is offered no Review, Group or Dismiss control', async () => {
      const r = await banner({ canManage: false, open: true });
      expect(r.find('suggestion-review-open')).toBeNull();
      expect(r.find('suggestion-dismiss')).toBeNull();
      // …and the discovery itself is still readable.
      expect(r.get('suggestion-name').textContent).toBe('Camiseta lisa');
    });

    it('is not invited to "Review" something it cannot review', async () => {
      const closed = await banner({ canManage: false, open: false });
      expect(closed.get('suggestions-toggle').textContent).toBe('Show');
      const manager = await banner({ canManage: true, open: false });
      expect(manager.get('suggestions-toggle').textContent).toBe('Review');
    });

    it('gets the same wording as a manager once open', async () => {
      const r = await banner({ canManage: false, open: true });
      expect(r.get('suggestions-toggle').textContent).toBe('Hide');
    });
  });

  describe('what it counts', () => {
    it('counts the ready ones', async () => {
      const r = await banner({ suggestions: [suggestion({ name: 'Uno' }), suggestion({ name: 'Dos' })] });
      expect(r.get('suggestions-summary').textContent).toBe('2 groups of items look like one product.');
    });

    it('does not count a blocked one as waiting', async () => {
      const r = await banner({ suggestions: [suggestion({ name: 'Uno' }), blocked('Dos')] });
      expect(r.get('suggestions-summary').textContent).toBe('1 group of items looks like one product.');
    });

    /**
     * All blocked is not "nothing found": the discovery is real, it just needs
     * a correction first, and claiming zero groups would be untrue.
     */
    it('changes what it says when every suggestion is blocked', async () => {
      const r = await banner({ suggestions: [blocked('Uno'), blocked('Dos')] });
      expect(r.get('suggestions-summary').textContent).toMatch(/need a correction first/i);
      expect(r.get('suggestions-summary').textContent).not.toMatch(/look like one product\./);
      expect(r.find('suggestions-banner')).not.toBeNull();
    });
  });

  /**
   * ONE GROUP IS NOT "1 groups".
   *
   * The banner said "1 groups of items look like one product." — the noun and
   * the verb both disagreed with the number. The fix is two whole sentences
   * chosen by the count, not a suffix rule: English has to move `group`/`groups`
   * AND `looks`/`look`, and Spanish has to move `grupo`/`grupos` AND
   * `parece`/`parecen`. A rule that appends "s" gets every one of those wrong.
   */
  describe('singular and plural', () => {
    const readyGroups = (n: number) =>
      Array.from({ length: n }, (_, i) => suggestion({ name: `Grupo ${i}` }));

    describe('in English', () => {
      it('says "1 group … looks" for exactly one', async () => {
        const r = await banner({ suggestions: readyGroups(1) });
        expect(r.get('suggestions-summary').textContent).toBe('1 group of items looks like one product.');
      });

      it('says "2 groups … look" for more than one', async () => {
        const r = await banner({ suggestions: readyGroups(2) });
        expect(r.get('suggestions-summary').textContent).toBe('2 groups of items look like one product.');
      });

      it('keeps the plural sentence for larger counts', async () => {
        const r = await banner({ suggestions: readyGroups(7) });
        expect(r.get('suggestions-summary').textContent).toBe('7 groups of items look like one product.');
      });

      /** The exact defect, named so it cannot come back unnoticed. */
      it('never renders the ungrammatical "1 groups"', async () => {
        const r = await banner({ suggestions: readyGroups(1) });
        const text = r.get('suggestions-summary').textContent ?? '';
        expect(text).not.toMatch(/\b1 groups\b/);
        expect(text).not.toMatch(/\blook like\b/);
      });
    });

    describe('in Spanish', () => {
      const inSpanish = async (n: number) => {
        window.localStorage.setItem('wegox-lang', 'es');
        try {
          const r = await banner({ suggestions: readyGroups(n) });
          return r.get('suggestions-summary').textContent ?? '';
        } finally {
          window.localStorage.removeItem('wegox-lang');
        }
      };

      it('moves the noun AND the verb for one', async () => {
        expect(await inSpanish(1)).toBe('1 grupo de artículos parece un mismo producto.');
      });

      it('moves both again for more than one', async () => {
        expect(await inSpanish(3)).toBe('3 grupos de artículos parecen un mismo producto.');
      });

      it('never renders the ungrammatical "1 grupos"', async () => {
        const text = await inSpanish(1);
        expect(text).not.toMatch(/\b1 grupos\b/);
        expect(text).not.toMatch(/\bparecen\b/);
      });
    });

    /** The other two sentences the banner can say are untouched. */
    it('leaves the all-blocked wording alone in both languages', async () => {
      const english = await banner({ suggestions: [blocked('Uno'), blocked('Dos')] });
      expect(english.get('suggestions-summary').textContent).toBe(
        'Some items look like one product, but need a correction first.',
      );

      window.localStorage.setItem('wegox-lang', 'es');
      try {
        const spanish = await banner({ suggestions: [blocked('Uno')] });
        expect(spanish.get('suggestions-summary').textContent).toBe(
          'Algunos artículos parecen un mismo producto, pero necesitan una corrección primero.',
        );
      } finally {
        window.localStorage.removeItem('wegox-lang');
      }
    });
  });

  describe('opening and closing', () => {
    it('keeps the review out of the way until asked', async () => {
      const r = await banner({ open: false });
      expect(r.find('suggestion-review')).toBeNull();
      expect(r.get('suggestions-toggle').getAttribute('aria-expanded')).toBe('false');
    });

    it('shows the shared review when open, and says so to a screen reader', async () => {
      const r = await banner({ open: true });
      expect(r.find('suggestion-review')).not.toBeNull();
      const toggle = r.get('suggestions-toggle');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(toggle.getAttribute('aria-controls')).toBe('suggestions-panel');
      expect(r.container.querySelector('#suggestions-panel')).not.toBeNull();
    });

    it('asks the page to toggle rather than deciding for itself', async () => {
      let toggles = 0;
      const r = await banner({
        onToggle: () => {
          toggles += 1;
        },
      });
      await click(r.get('suggestions-toggle'));
      expect(toggles).toBe(1);
    });
  });

  describe('reviewing one', () => {
    it('hands the suggestion up untouched, so the page can open the shared modal', async () => {
      const seen: FamilySuggestion[] = [];
      const r = await banner({ open: true, onReview: (s) => seen.push(s) });
      await click(r.get('suggestion-review-open'));
      expect(seen).toHaveLength(1);
      expect(seen[0].name).toBe('Camiseta lisa');
      expect(seen[0].members.map((m) => [m.id, m.label])).toEqual([
        ['a', 'Roja'],
        ['b', 'Azul'],
      ]);
    });

    /**
     * The banner is given no way to change the items table's selection. It
     * takes no selection and no setter, so loading suggestions cannot tick a
     * checkbox nobody ticked.
     */
    it('is not given anything that could alter the table selection', async () => {
      const props = Object.keys({
        suggestions: null,
        canManage: true,
        open: false,
        onToggle: () => undefined,
        busyName: null,
        onReview: () => undefined,
        onDismiss: () => undefined,
      } satisfies Record<keyof React.ComponentProps<typeof SuggestionsBanner>, unknown>);
      expect(props.some((k) => /select/i.test(k))).toBe(false);
    });
  });
});
