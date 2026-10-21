'use client';

import React from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { useT } from '../../lib/i18n';
import { cn } from '../../lib/cn';

export interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /**
   * Rows across every page. When given, the summary reads "Page X of Y · N
   * items" and a single page still shows that line; when absent the component
   * keeps its old silence on a single page, so callers that never asked for a
   * count see nothing new.
   */
  total?: number;
  /** Pages shown on each side of the current one at ordinary widths. */
  siblings?: number;
}

export type PageSlot = number | 'gap';

/**
 * The compact window of page numbers.
 *
 * Page 1 and the last page are always there. Around the current page sit
 * `siblings` pages on each side, and near an edge the window slides rather
 * than shrinks, so the same number of slots is visible on page 2 as on page
 * 10. A gap stands only for TWO or more omitted pages: a single omitted page
 * is shown as itself, because "…" is no shorter than the number it would
 * hide. No page appears twice, and no gap sits beside the page it would hide.
 *
 *   20 pages, page 2  → 1 2 3 4 5 6 … 20
 *   20 pages, page 8  → 1 … 6 7 8 9 10 … 20
 *   20 pages, page 19 → 1 … 15 16 17 18 19 20
 *   8 pages, any page → 1 2 3 4 5 6 7 8
 */
export function pageWindow(page: number, totalPages: number, siblings = 2): PageSlot[] {
  const last = Math.max(1, Math.floor(totalPages));
  const current = Math.min(Math.max(1, Math.floor(page)), last);
  const inner = 2 * siblings + 1;
  // Every page fits when a gap could hide at most one page anyway.
  if (last <= inner + 2) return Array.from({ length: last }, (_, i) => i + 1);
  let start = Math.max(2, current - siblings);
  const end = Math.min(last - 1, start + inner - 1);
  start = Math.max(2, end - inner + 1);
  const slots: PageSlot[] = [1];
  if (start > 3) slots.push('gap');
  else for (let p = 2; p < start; p += 1) slots.push(p);
  for (let p = start; p <= end; p += 1) slots.push(p);
  if (end < last - 2) slots.push('gap');
  else for (let p = end + 1; p < last; p += 1) slots.push(p);
  slots.push(last);
  return slots;
}

/**
 * Whether the viewport is narrow, from the same breakpoint Tailwind's `sm:`
 * uses, read through matchMedia so the window shrinks on a phone without a
 * resize listener of its own. A DOM without matchMedia (tests, the server)
 * reads as wide.
 */
function useNarrowViewport(): boolean {
  const query = '(max-width: 639px)';
  const subscribe = React.useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
      const media = window.matchMedia(query);
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    [query],
  );
  const read = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false;
  return React.useSyncExternalStore(subscribe, read, () => false);
}

const control =
  'inline-flex items-center justify-center min-h-9 min-w-9 px-2 rounded-lg border text-xs font-semibold transition-colors ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-40 disabled:cursor-not-allowed';
const plain = 'border-slate-200 bg-white text-slate-700 hover:bg-slate-100 disabled:hover:bg-white';
const active = 'border-primary bg-primary text-white';

/**
 * First / previous / numbered window / next / last, with "Page X of Y".
 *
 * Every control is a real button with a text name: the arrows are decoration
 * and the label carries the meaning. Disabled edges use the native attribute,
 * so they leave the tab order the way every disabled button does. Gaps are
 * hidden from assistive technology entirely — they are punctuation, not a
 * control, and nothing should stop on them. The current page is a button too,
 * marked `aria-current="page"`, so a reader hears where they are.
 */
export default function Pagination({ page, totalPages, onPageChange, total, siblings = 2 }: PaginationProps) {
  const t = useT();
  const narrow = useNarrowViewport();
  const last = Math.max(1, Math.floor(totalPages) || 1);
  const current = Math.min(Math.max(1, Math.floor(page) || 1), last);

  // Zero rows: the list's own empty state speaks, and "Page 1 of 0" would be
  // a lie. One page without a count: the old silence. One page with a count:
  // the summary line alone.
  if (total === 0) return null;
  if (last <= 1 && total === undefined) return null;

  const summary =
    total !== undefined
      ? t('Page {page} of {totalPages} · {total} items', { page: current, totalPages: last, total })
      : t('Page {page} of {totalPages}', { page: current, totalPages: last });

  const go = (target: number) => {
    const next = Math.min(Math.max(1, target), last);
    if (next !== current) onPageChange(next);
  };

  const slots = last > 1 ? pageWindow(current, last, narrow ? 1 : siblings) : [];

  return (
    <nav
      aria-label={t('Pagination')}
      data-testid="pagination"
      className="flex flex-wrap items-center justify-between gap-3 bg-slate-50 p-3 sm:p-4 border border-slate-200 rounded-md"
    >
      <p className="text-xs text-slate-500 font-semibold" data-testid="pagination-summary">
        {summary}
      </p>
      {last > 1 && (
        <ul className="flex flex-wrap items-center gap-1" data-testid="pagination-controls">
          <li>
            <button
              type="button"
              className={cn(control, plain)}
              disabled={current <= 1}
              aria-label={t('First page')}
              title={t('First page')}
              data-testid="page-first"
              onClick={() => go(1)}
            >
              <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
            </button>
          </li>
          <li>
            <button
              type="button"
              className={cn(control, plain)}
              disabled={current <= 1}
              aria-label={t('Previous page')}
              title={t('Previous page')}
              data-testid="page-prev"
              onClick={() => go(current - 1)}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{t('Previous')}</span>
            </button>
          </li>
          {slots.map((slot, index) =>
            slot === 'gap' ? (
              <li
                key={`gap-${index}`}
                aria-hidden="true"
                data-testid="page-gap"
                className="min-w-6 text-center text-slate-400 select-none"
              >
                …
              </li>
            ) : (
              <li key={slot}>
                <button
                  type="button"
                  className={cn(control, slot === current ? active : plain)}
                  aria-current={slot === current ? 'page' : undefined}
                  aria-label={slot === current ? t('Page {n}, current page', { n: slot }) : t('Go to page {n}', { n: slot })}
                  data-testid={`page-${slot}`}
                  onClick={() => go(slot)}
                >
                  {slot}
                </button>
              </li>
            ),
          )}
          <li>
            <button
              type="button"
              className={cn(control, plain)}
              disabled={current >= last}
              aria-label={t('Next page')}
              title={t('Next page')}
              data-testid="page-next"
              onClick={() => go(current + 1)}
            >
              <span className="hidden sm:inline">{t('Next')}</span>
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </li>
          <li>
            <button
              type="button"
              className={cn(control, plain)}
              disabled={current >= last}
              aria-label={t('Last page')}
              title={t('Last page')}
              data-testid="page-last"
              onClick={() => go(last)}
            >
              <ChevronsRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </li>
        </ul>
      )}
    </nav>
  );
}
