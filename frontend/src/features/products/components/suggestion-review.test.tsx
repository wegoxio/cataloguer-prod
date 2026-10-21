import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';
import SuggestionReview, { blockedReasonText } from './suggestion-review';
import {
  isSuggestionReady,
  type FamilySuggestion,
  type SuggestionBlockedReason,
} from '../services/family-suggestions.service';

/**
 * ONE suggestion-review experience.
 *
 * `/dashboard/products/groups` used to own a second grouping workflow — its
 * own list and a one-click "Group them" straight to the create endpoint, with
 * no preflight, no preview and no editable labels. This component is the
 * single review, and what it must never do is create anything itself or
 * promise an acceptance the backend refuses.
 */

const member = (over: Partial<FamilySuggestion['members'][number]> = {}) => ({
  id: 'a',
  name: 'Camiseta lisa roja',
  label: 'Roja',
  ...over,
});

const suggestion = (over: Partial<FamilySuggestion> = {}): FamilySuggestion => ({
  name: 'Camiseta lisa',
  members: [member({ id: 'a', label: 'Roja' }), member({ id: 'b', name: 'Camiseta lisa azul', label: 'Azul' })],
  readiness: 'READY',
  blockedReasons: [],
  ...over,
});

const identity = (k: string) => k;

afterEach(() => cleanupAll());

const review = (over: Partial<React.ComponentProps<typeof SuggestionReview>> = {}) =>
  renderComponent(
    <I18nProvider>
      <SuggestionReview
        suggestions={[suggestion()]}
        canManage
        onReview={() => undefined}
        onDismiss={() => undefined}
        {...over}
      />
    </I18nProvider>,
  );

describe('reviewing a suggested parent', () => {
  describe('the three things the list can be', () => {
    it('says it is still loading rather than saying there is nothing', async () => {
      const r = await review({ suggestions: null });
      expect(r.find('suggestions-loading')).not.toBeNull();
      expect(r.find('suggestions-empty')).toBeNull();
      expect(r.find('suggestion-review')).toBeNull();
    });

    it('shows a real empty state, not a blank page, when there is nothing to group', async () => {
      const r = await review({ suggestions: [] });
      expect(r.find('suggestions-empty')).not.toBeNull();
      expect(r.text()).toMatch(/nothing to group/i);
    });

    it('shows the first suggestion when there is one', async () => {
      const r = await review();
      expect(r.get('suggestion-name').textContent).toBe('Camiseta lisa');
      expect(r.text()).toMatch(/1 of 1/);
    });
  });

  describe('moving between suggestions', () => {
    const three = [
      suggestion({ name: 'Uno' }),
      suggestion({ name: 'Dos' }),
      suggestion({ name: 'Tres' }),
    ];

    it('hides the arrows entirely when there is only one', async () => {
      const r = await review();
      expect(r.find('suggestion-next')).toBeNull();
      expect(r.find('suggestion-prev')).toBeNull();
    });

    it('walks forwards and backwards, and stops at both ends', async () => {
      const r = await review({ suggestions: three });
      expect((r.get('suggestion-prev') as HTMLButtonElement).disabled).toBe(true);

      await click(r.get('suggestion-next'));
      expect(r.get('suggestion-name').textContent).toBe('Dos');
      expect(r.text()).toMatch(/2 of 3/);

      await click(r.get('suggestion-next'));
      expect(r.get('suggestion-name').textContent).toBe('Tres');
      expect((r.get('suggestion-next') as HTMLButtonElement).disabled).toBe(true);

      await click(r.get('suggestion-prev'));
      expect(r.get('suggestion-name').textContent).toBe('Dos');
    });

    /**
     * Grouping and dismissing both shorten the list. Staying on an index that
     * no longer exists is how "3 of 2" and a blank card happen.
     */
    it('falls back to the last one when the list shrinks underneath it', async () => {
      const r = await review({ suggestions: three });
      await click(r.get('suggestion-next'));
      await click(r.get('suggestion-next'));
      expect(r.get('suggestion-name').textContent).toBe('Tres');

      await r.rerender(
        <I18nProvider>
          <SuggestionReview
            suggestions={three.slice(0, 2)}
            canManage
            onReview={() => undefined}
            onDismiss={() => undefined}
          />
        </I18nProvider>,
      );
      expect(r.get('suggestion-name').textContent).toBe('Dos');
      expect(r.text()).toMatch(/2 of 2/);
    });
  });

  describe('a blocked suggestion', () => {
    const blocked = (reasons: SuggestionBlockedReason[], members?: FamilySuggestion['members']) =>
      suggestion({ readiness: 'BLOCKED', blockedReasons: reasons, ...(members ? { members } : {}) });

    it('stays visible — it is still useful discovery', async () => {
      const r = await review({ suggestions: [blocked(['MEMBER_WITHOUT_STORE'])] });
      expect(r.find('suggestion-review')).not.toBeNull();
      expect(r.get('suggestion-name').textContent).toBe('Camiseta lisa');
    });

    it('cannot be accepted from here', async () => {
      let opened = 0;
      const r = await review({
        suggestions: [blocked(['MIXED_PUBLICATION_STATUS'])],
        onReview: () => {
          opened += 1;
        },
      });
      const button = r.get('suggestion-review-open') as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      await click(button);
      expect(opened).toBe(0);
    });

    it('says why, and points a screen reader at the reason', async () => {
      const r = await review({ suggestions: [blocked(['SPECIFICATION_CONFLICT', 'DUPLICATE_LABEL'])] });
      const panel = r.get('suggestion-blocked');
      expect(panel.getAttribute('role')).toBe('status');
      expect(r.find('blocked-reason-SPECIFICATION_CONFLICT')).not.toBeNull();
      expect(r.find('blocked-reason-DUPLICATE_LABEL')).not.toBeNull();

      const described = r.get('suggestion-review-open').getAttribute('aria-describedby');
      expect(described).toBe('suggestion-blocked-desc');
      expect(r.container.querySelector(`#${described}`)?.textContent).toMatch(/specification|shopper/i);
    });

    it('names WHICH member is the problem, not only that there is one', async () => {
      const r = await review({
        suggestions: [
          blocked(['MEMBER_WITHOUT_STORE', 'MIXED_PUBLICATION_STATUS'], [
            member({ id: 'a', status: 'DRAFT', hasStore: true }),
            member({ id: 'b', status: 'PUBLISHED', hasStore: false }),
            member({ id: 'c', status: 'PUBLISHED', hasStore: true, hasSpecificationConflict: true }),
          ]),
        ],
      });
      expect(r.find('member-draft-a')).not.toBeNull();
      expect(r.find('member-draft-b')).toBeNull();
      expect(r.find('member-no-store-b')).not.toBeNull();
      expect(r.find('member-no-store-a')).toBeNull();
      expect(r.find('member-conflict-c')).not.toBeNull();
    });

    it('can still be dismissed — "no" is an answer to a blocked group too', async () => {
      let dismissed: string | null = null;
      const r = await review({
        suggestions: [blocked(['TOO_FEW_MEMBERS'])],
        onDismiss: (s) => {
          dismissed = s.name;
        },
      });
      await click(r.get('suggestion-dismiss'));
      expect(dismissed).toBe('Camiseta lisa');
    });
  });

  describe('accepting one', () => {
    it('hands the whole suggestion up, and never creates anything itself', async () => {
      const seen: FamilySuggestion[] = [];
      const r = await review({ onReview: (s) => seen.push(s) });
      await click(r.get('suggestion-review-open'));
      expect(seen).toHaveLength(1);
      expect(seen[0].name).toBe('Camiseta lisa');
      expect(seen[0].members.map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('waits while its own suggestion is being acted on', async () => {
      const r = await review({ busyName: 'Camiseta lisa' });
      expect((r.get('suggestion-review-open') as HTMLButtonElement).disabled).toBe(true);
      expect((r.get('suggestion-dismiss') as HTMLButtonElement).disabled).toBe(true);
    });

    it('offers nothing to somebody who may not group', async () => {
      const r = await review({ canManage: false });
      expect(r.find('suggestion-review-open')).toBeNull();
      expect(r.find('suggestion-dismiss')).toBeNull();
      // The discovery itself is still readable.
      expect(r.get('suggestion-name').textContent).toBe('Camiseta lisa');
    });
  });

  describe('the readiness verdict comes from the backend', () => {
    it('translates every reason in the closed vocabulary', () => {
      const reasons: SuggestionBlockedReason[] = [
        'MIXED_PUBLICATION_STATUS',
        'MEMBER_WITHOUT_STORE',
        'SPECIFICATION_CONFLICT',
        'DUPLICATE_LABEL',
        'TOO_FEW_MEMBERS',
      ];
      const texts = reasons.map((r) => blockedReasonText(r, identity));
      expect(new Set(texts).size).toBe(reasons.length);
      texts.forEach((text) => expect(text).not.toBe('This group cannot be created yet.'));
    });

    it('says something rather than nothing for a reason it has never heard of', () => {
      expect(blockedReasonText('SOMETHING_NEW' as SuggestionBlockedReason, identity)).toBe(
        'This group cannot be created yet.',
      );
    });

    /** An older backend sends no verdict; that is how it always behaved. */
    it('treats an absent verdict as ready', async () => {
      expect(isSuggestionReady({ name: 'x', members: [] })).toBe(true);
      const r = await review({ suggestions: [{ name: 'x', members: [member()] }] });
      expect((r.get('suggestion-review-open') as HTMLButtonElement).disabled).toBe(false);
      expect(r.find('suggestion-blocked')).toBeNull();
    });
  });
});
