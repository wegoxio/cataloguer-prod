import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click } from '../../test/render';
import { I18nProvider } from '../../lib/i18n';
import Pagination, { pageWindow } from './pagination';

afterEach(() => cleanupAll());

/**
 * The compact window is a pure function, so its shape is pinned exactly:
 * first and last always, the current page with its neighbours, a gap only
 * where two or more pages are skipped, never a duplicate.
 */
describe('pageWindow', () => {
  it('shows every page while they all fit', () => {
    expect(pageWindow(1, 1)).toEqual([1]);
    expect(pageWindow(1, 2)).toEqual([1, 2]);
    expect(pageWindow(2, 2)).toEqual([1, 2]);
    expect(pageWindow(1, 4)).toEqual([1, 2, 3, 4]);
    expect(pageWindow(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('slides the window near the start, the middle and the end of many pages', () => {
    expect(pageWindow(1, 20)).toEqual([1, 2, 3, 4, 5, 6, 'gap', 20]);
    expect(pageWindow(2, 20)).toEqual([1, 2, 3, 4, 5, 6, 'gap', 20]);
    expect(pageWindow(8, 20)).toEqual([1, 'gap', 6, 7, 8, 9, 10, 'gap', 20]);
    expect(pageWindow(19, 20)).toEqual([1, 'gap', 15, 16, 17, 18, 19, 20]);
    expect(pageWindow(20, 20)).toEqual([1, 'gap', 15, 16, 17, 18, 19, 20]);
  });

  it('shows a single skipped page as itself instead of a gap that would be no shorter', () => {
    // Page 5 of 20: the window is 3..7; only page 2 sits between 1 and 3.
    expect(pageWindow(5, 20)).toEqual([1, 2, 3, 4, 5, 6, 7, 'gap', 20]);
    // Page 16 of 20: the window is 14..18; only page 19 sits between 18 and 20.
    expect(pageWindow(16, 20)).toEqual([1, 'gap', 14, 15, 16, 17, 18, 19, 20]);
    // Eight pages: a gap could hide at most one page, so all eight are shown.
    expect(pageWindow(1, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(pageWindow(8, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('narrows to one sibling for a small screen', () => {
    expect(pageWindow(2, 20, 1)).toEqual([1, 2, 3, 4, 'gap', 20]);
    expect(pageWindow(10, 20, 1)).toEqual([1, 'gap', 9, 10, 11, 'gap', 20]);
    expect(pageWindow(19, 20, 1)).toEqual([1, 'gap', 17, 18, 19, 20]);
  });

  it('never repeats a page and never puts a gap beside the page it would hide', () => {
    for (let total = 1; total <= 40; total += 1) {
      for (let current = 1; current <= total; current += 1) {
        for (const siblings of [1, 2, 3]) {
          const slots = pageWindow(current, total, siblings);
          const numbers = slots.filter((s): s is number => typeof s === 'number');
          expect(new Set(numbers).size, `${current}/${total}/${siblings} duplicates`).toBe(numbers.length);
          expect(numbers[0]).toBe(1);
          expect(numbers[numbers.length - 1]).toBe(total);
          expect(numbers).toContain(current);
          slots.forEach((slot, i) => {
            if (slot !== 'gap') return;
            const before = slots[i - 1] as number;
            const after = slots[i + 1] as number;
            expect(after - before, `${current}/${total}/${siblings} gap hides fewer than two pages`).toBeGreaterThanOrEqual(3);
          });
        }
      }
    }
  });

  it('clamps an out-of-range current page into the window', () => {
    expect(pageWindow(50, 20)).toEqual([1, 'gap', 15, 16, 17, 18, 19, 20]);
    expect(pageWindow(0, 20)).toEqual([1, 2, 3, 4, 5, 6, 'gap', 20]);
  });
});

const render = (props: Partial<React.ComponentProps<typeof Pagination>> = {}) =>
  renderComponent(
    <I18nProvider>
      <Pagination page={1} totalPages={1} onPageChange={() => undefined} {...props} />
    </I18nProvider>,
  );

describe('Pagination', () => {
  it('renders nothing for zero rows — never "Page 1 of 0"', async () => {
    const r = await render({ page: 1, totalPages: 0, total: 0 });
    expect(r.find('pagination')).toBeNull();
    expect(r.container.textContent).toBe('');
  });

  it('renders nothing for one page when no count was given (the older callers)', async () => {
    const r = await render({ page: 1, totalPages: 1 });
    expect(r.find('pagination')).toBeNull();
  });

  it('renders the summary alone for one page with a count', async () => {
    const r = await render({ page: 1, totalPages: 1, total: 12 });
    expect(r.get('pagination-summary').textContent).toBe('Page 1 of 1 · 12 items');
    expect(r.find('pagination-controls')).toBeNull();
  });

  it('is a named navigation landmark with every control named in words', async () => {
    const r = await render({ page: 1, totalPages: 2, total: 30 });
    const nav = r.get('pagination');
    expect(nav.tagName).toBe('NAV');
    expect(nav.getAttribute('aria-label')).toBe('Pagination');
    expect(r.get('page-first').getAttribute('aria-label')).toBe('First page');
    expect(r.get('page-prev').getAttribute('aria-label')).toBe('Previous page');
    expect(r.get('page-next').getAttribute('aria-label')).toBe('Next page');
    expect(r.get('page-last').getAttribute('aria-label')).toBe('Last page');
    expect(r.get('page-2').getAttribute('aria-label')).toBe('Go to page 2');
    expect(r.get('page-1').getAttribute('aria-label')).toBe('Page 1, current page');
  });

  it('disables First and Previous on page 1, and Next and Last on the final page', async () => {
    const first = await render({ page: 1, totalPages: 5, total: 101 });
    expect((first.get('page-first') as HTMLButtonElement).disabled).toBe(true);
    expect((first.get('page-prev') as HTMLButtonElement).disabled).toBe(true);
    expect((first.get('page-next') as HTMLButtonElement).disabled).toBe(false);
    expect((first.get('page-last') as HTMLButtonElement).disabled).toBe(false);
    cleanupAll();
    const last = await render({ page: 5, totalPages: 5, total: 101 });
    expect((last.get('page-first') as HTMLButtonElement).disabled).toBe(false);
    expect((last.get('page-prev') as HTMLButtonElement).disabled).toBe(false);
    expect((last.get('page-next') as HTMLButtonElement).disabled).toBe(true);
    expect((last.get('page-last') as HTMLButtonElement).disabled).toBe(true);
  });

  it('marks only the current page with aria-current="page"', async () => {
    const r = await render({ page: 3, totalPages: 5, total: 101 });
    const current = Array.from(r.container.querySelectorAll('[aria-current="page"]'));
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toBe('3');
    expect(r.get('pagination-summary').textContent).toBe('Page 3 of 5 · 101 items');
  });

  it('renders gaps as punctuation hidden from assistive technology, never as buttons', async () => {
    const r = await render({ page: 8, totalPages: 20, total: 480 });
    const gaps = r.all('page-gap');
    expect(gaps).toHaveLength(2);
    for (const gap of gaps) {
      expect(gap.tagName).toBe('LI');
      expect(gap.getAttribute('aria-hidden')).toBe('true');
      expect(gap.querySelector('button')).toBeNull();
      expect(gap.hasAttribute('tabindex')).toBe(false);
    }
    const numbers = Array.from(r.container.querySelectorAll('[data-testid^="page-"]'))
      .filter((el) => /^page-\d+$/.test(el.getAttribute('data-testid') ?? ''))
      .map((el) => el.textContent);
    expect(numbers).toEqual(['1', '6', '7', '8', '9', '10', '20']);
  });

  it('navigates by number, by First and by Last, and ignores a click on the current page', async () => {
    const onPageChange = vi.fn();
    const r = await render({ page: 8, totalPages: 20, total: 480, onPageChange });
    await click(r.get('page-10'));
    await click(r.get('page-first'));
    await click(r.get('page-last'));
    await click(r.get('page-prev'));
    await click(r.get('page-next'));
    await click(r.get('page-8'));
    expect(onPageChange.mock.calls.map((c) => c[0])).toEqual([10, 1, 20, 7, 9]);
  });

  it('shows every page number when few pages exist', async () => {
    const r = await render({ page: 2, totalPages: 4, total: 90 });
    expect(r.all('page-gap')).toHaveLength(0);
    expect(['1', '2', '3', '4'].map((n) => r.get(`page-${n}`).textContent)).toEqual(['1', '2', '3', '4']);
  });

  it('has a Spanish entry for every string it uses', async () => {
    const { ES } = await import('../../lib/translations.es');
    for (const key of [
      'Pagination',
      'First page',
      'Previous page',
      'Next page',
      'Last page',
      'Previous',
      'Next',
      'Go to page {n}',
      'Page {n}, current page',
      'Page {page} of {totalPages}',
      'Page {page} of {totalPages} · {total} items',
    ]) {
      expect(ES[key], `missing Spanish for "${key}"`).toBeTruthy();
      expect(ES[key]).not.toBe(key);
    }
  });
});
