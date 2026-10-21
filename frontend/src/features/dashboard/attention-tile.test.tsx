import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../test/render';
import { I18nProvider } from '../../lib/i18n';
import AttentionTile, { readySuggestionCount } from './attention-tile';
import { ES } from '../../lib/translations.es';

// Forward EVERY prop: a mock that keeps only href silently drops data-testid.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: any) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const Icon = () => <svg />;

const tile = (over: Partial<React.ComponentProps<typeof AttentionTile>> = {}) =>
  renderComponent(
    <I18nProvider>
      <AttentionTile
        href="/dashboard/products?suggestions=open"
        icon={Icon}
        count={3}
        testId="tile"
        labelOne="possible parent product to review"
        label="possible parent products to review"
        goodLabel="nothing waiting to be grouped"
        unknownLabel="possible parent products could not be checked"
        {...over}
      />
    </I18nProvider>,
  );

afterEach(() => cleanupAll());

/**
 * A tile says one of THREE things, and it used to say two.
 *
 * Zero was drawn as a green link to a page whose only content was an empty
 * state — pressing "nothing waiting to be grouped" landed on what reads as a
 * broken page. A failed request was drawn amber with the problem wording, so
 * not knowing looked like a backlog.
 */
describe('the attention tile', () => {
  describe('something waits', () => {
    it('is a link, and names the work', async () => {
      const r = await tile({ count: 3 });
      const node = r.get('tile');
      expect(node.dataset.state).toBe('actionable');
      expect(node.tagName).toBe('A');
      expect(node.getAttribute('href')).toBe('/dashboard/products?suggestions=open');
      expect(r.text()).toMatch(/3/);
      expect(r.text()).toMatch(/possible parent products to review/);
    });
  });

  describe('nothing waits', () => {
    it('is not a link, and cannot be pressed', async () => {
      const r = await tile({ count: 0 });
      const node = r.get('tile');
      expect(node.dataset.state).toBe('clean');
      expect(node.tagName).not.toBe('A');
      expect(node.getAttribute('href')).toBeNull();
      expect(node.getAttribute('aria-disabled')).toBe('true');
    });

    it('says the good news, not the problem wording', async () => {
      const r = await tile({ count: 0 });
      expect(r.text()).toMatch(/nothing waiting to be grouped/);
      expect(r.text()).not.toMatch(/to review/);
    });

    it('does not look clickable', async () => {
      const r = await tile({ count: 0 });
      const className = r.get('tile').className;
      expect(className).toMatch(/cursor-default/);
      expect(className).not.toMatch(/hover:shadow-pop/);
      expect(className).not.toMatch(/amber/);
    });
  });

  describe('we do not know', () => {
    it('is neutral and inert, not an amber backlog', async () => {
      const r = await tile({ count: null });
      const node = r.get('tile');
      expect(node.dataset.state).toBe('unknown');
      expect(node.tagName).not.toBe('A');
      expect(node.getAttribute('aria-disabled')).toBe('true');
      expect(node.className).not.toMatch(/amber/);
    });

    it('shows a dash rather than a number it does not have', async () => {
      const r = await tile({ count: null });
      expect(r.text()).toMatch(/—/);
      expect(r.text()).toMatch(/could not be checked/);
      expect(r.text()).not.toMatch(/nothing waiting/);
    });

    it('falls back to a neutral sentence when no wording was given', async () => {
      const r = await tile({ count: null, unknownLabel: undefined });
      expect(r.text()).toMatch(/could not be checked just now/);
    });
  });

  /**
   * ONE IS ITS OWN CAPTION.
   *
   * The number and the caption are two elements, but a reader sees one phrase:
   * "1" above "possible parent products to review" reads as "1 possible parent
   * products to review", which is what the owner saw. Every tile whose caption
   * depends on a positive count therefore carries both forms — and the clean
   * and unknown sentences, which are not counts, are left exactly as they were.
   */
  describe('count agreement, tile by tile', () => {
    /**
     * The six tiles as the dashboard passes them. Captions are the EXISTING
     * wording with number agreement applied and nothing renamed.
     */
    const TILES = [
      {
        name: 'drafts',
        one: 'draft not yet published',
        many: 'drafts not yet published',
        clean: 'no drafts pending — all published',
        oneEs: 'borrador sin publicar',
        manyEs: 'borradores sin publicar',
        cleanEs: 'sin borradores pendientes — todo publicado',
      },
      {
        name: 'missing photos',
        one: 'item without photos',
        many: 'items without photos',
        clean: 'every product has photos',
        oneEs: 'artículo sin fotos',
        manyEs: 'artículos sin fotos',
        cleanEs: 'todos los productos tienen fotos',
      },
      {
        name: 'missing category',
        one: 'item without a category',
        many: 'items without a category',
        clean: 'everything categorized',
        oneEs: 'artículo sin categoría',
        manyEs: 'artículos sin categoría',
        cleanEs: 'todo está categorizado',
      },
      {
        name: 'missing required fields',
        one: 'item missing required fields',
        many: 'items missing required fields',
        clean: 'every required field answered',
        oneEs: 'artículo con campos obligatorios sin responder',
        manyEs: 'artículos con campos obligatorios sin responder',
        cleanEs: 'todos los campos obligatorios respondidos',
      },
      {
        name: 'low stock',
        one: 'item low on stock (5 or fewer)',
        many: 'items low on stock (5 or fewer)',
        clean: 'stock levels are healthy',
        oneEs: 'artículo con poco inventario (5 o menos)',
        manyEs: 'artículos con poco inventario (5 o menos)',
        cleanEs: 'niveles de inventario saludables',
      },
      {
        name: 'grouping suggestions',
        one: 'possible parent product to review',
        many: 'possible parent products to review',
        clean: 'nothing waiting to be grouped',
        oneEs: 'posible producto padre por revisar',
        manyEs: 'posibles productos padre por revisar',
        cleanEs: 'nada pendiente de agrupar',
      },
    ];

    /**
     * The tile is handed captions the PAGE has already translated, so which
     * caption it CHOOSES is this component's job and the Spanish wording is the
     * translation table's. They are asserted separately, below and at the end.
     */
    const render = async (tile: (typeof TILES)[number], count: number | null) => {
      const r = await renderComponent(
        <I18nProvider>
          <AttentionTile
            href="/dashboard/products"
            icon={Icon}
            count={count}
            testId="tile"
            labelOne={tile.one}
            label={tile.many}
            goodLabel={tile.clean}
          />
        </I18nProvider>,
      );
      return r.text();
    };

    for (const tile of TILES) {
      describe(tile.name, () => {
        it('at one, reads the singular', async () => {
          expect(await render(tile, 1)).toBe(`1${tile.one}`);
        });

        it('at two or more, reads the plural', async () => {
          expect(await render(tile, 2)).toBe(`2${tile.many}`);
          expect(await render(tile, 14)).toBe(`14${tile.many}`);
        });

        it('at zero, keeps its existing clean sentence untouched', async () => {
          expect(await render(tile, 0)).toBe(`0${tile.clean}`);
        });

        it('at unknown, keeps the neutral sentence and the dash', async () => {
          expect(await render(tile, null)).toBe('—could not be checked just now');
        });

        it('never renders a count against the wrong caption', async () => {
          const single = await render(tile, 1);
          expect(single).not.toContain(tile.many);
          const plural = await render(tile, 3);
          expect(plural).not.toBe(`3${tile.one}`);
        });

        it('has a Spanish singular, plural and clean sentence, all distinct', () => {
          expect(ES[tile.one]).toBe(tile.oneEs);
          expect(ES[tile.many]).toBe(tile.manyEs);
          expect(ES[tile.clean]).toBe(tile.cleanEs);
          // Spanish inflects too: the two counted forms are different strings.
          expect(ES[tile.one]).not.toBe(ES[tile.many]);
        });
      });
    }

    /** The exact phrase the owner saw. */
    it('never renders "1 possible parent products"', async () => {
      const grouping = TILES[TILES.length - 1];
      const text = await render(grouping, 1);
      expect(text).toBe('1possible parent product to review');
      expect(text).not.toContain('possible parent products');
    });

    /**
     * The Spanish half of the same claim: every counted caption has both forms
     * and they differ, and no clean or unknown sentence was disturbed.
     */
    it('every counted caption is translated in both numbers, and no clean sentence moved', () => {
      for (const tile of TILES) {
        expect(ES[tile.one], `missing Spanish singular for "${tile.one}"`).toBeTruthy();
        expect(ES[tile.many], `missing Spanish plural for "${tile.many}"`).toBeTruthy();
        expect(ES[tile.one]).not.toBe(ES[tile.many]);
      }
      // The wording that is NOT a count is byte-for-byte what it always was.
      expect(ES['nothing waiting to be grouped']).toBe('nada pendiente de agrupar');
      expect(ES['stock levels are healthy']).toBe('niveles de inventario saludables');
      expect(ES['every required field answered']).toBe('todos los campos obligatorios respondidos');
      expect(ES['every product has photos']).toBe('todos los productos tienen fotos');
      expect(ES['everything categorized']).toBe('todo está categorizado');
      expect(ES['no drafts pending — all published']).toBe('sin borradores pendientes — todo publicado');
      expect(ES['possible parent products could not be checked']).toBe(
        'no se pudieron comprobar los posibles productos padre',
      );
      expect(ES['could not be checked just now']).toBe('no se pudo comprobar ahora mismo');
    });

    it('the unknown state ignores both captions entirely', async () => {
      const r = await tile({ count: null });
      const text = r.text();
      expect(text).toContain('possible parent products could not be checked');
      expect(text).not.toContain('possible parent product to review');
      expect(text).toContain('—');
    });
  });

  /**
   * Counting a blocked suggestion here would promise work the create endpoint
   * refuses.
   */
  describe('what the grouping tile counts', () => {
    it('takes the backend count when it is given', () => {
      expect(readySuggestionCount({ data: [{}, {}, {}], readyCount: 1 })).toBe(1);
      expect(readySuggestionCount({ data: [], readyCount: 0 })).toBe(0);
    });

    it('counts only READY when the backend did not', () => {
      expect(
        readySuggestionCount({
          data: [{ readiness: 'READY' }, { readiness: 'BLOCKED' }, { readiness: 'READY' }],
        }),
      ).toBe(2);
    });

    it('treats an older backend, with no verdict at all, as all ready', () => {
      expect(readySuggestionCount({ data: [{}, {}] })).toBe(2);
    });

    it('reads a failed request as zero here, and the caller turns that into unknown', () => {
      expect(readySuggestionCount(null)).toBe(0);
    });

    it('shows the neutral-success tile when every suggestion is blocked', async () => {
      const count = readySuggestionCount({ data: [{ readiness: 'BLOCKED' }, { readiness: 'BLOCKED' }] });
      expect(count).toBe(0);
      const r = await tile({ count });
      expect(r.get('tile').dataset.state).toBe('clean');
      expect(r.get('tile').tagName).not.toBe('A');
    });
  });
});
