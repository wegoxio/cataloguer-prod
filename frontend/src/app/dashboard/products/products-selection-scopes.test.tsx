import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click, type, flush, settle } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';

/**
 * WHAT IS SELECTED, AND WHAT THAT MEANS.
 *
 * Two selections look identical as a number and are not the same thing: the
 * rows on the page in front of the reader, and every item the current filters
 * match across every page. A bulk action that mistakes one for the other
 * reaches items nobody looked at, so the difference is state, it is written on
 * screen in words, and it is bound to the scope it was taken for.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) =>
    React.createElement('a', rest, children),
}));
const toast = { success: vi.fn(), error: vi.fn(), undo: vi.fn() };
vi.mock('../../../components/ui/toast', () => ({ useToast: () => toast }));
vi.mock('../../../lib/use-website-config', () => ({
  useStores: () => ({
    stores: [
      { id: 'store-a', name: 'EliteToGo', slug: 'elite', archivedAt: null },
      { id: 'store-b', name: 'TuTienda', slug: 'tutienda', archivedAt: null },
    ],
  }),
  buildWebsiteUrl: () => 'https://example.test',
}));
vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'manager@elite.example', role: 'ORGANIZATION_MANAGER' },
    scope: {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId: 'org-1',
      storeId: null,
      allowedStoreIds: ['store-a', 'store-b'],
    },
    accessToken: 'token',
  }),
}));

/** Every rows request and every ids request, as the page sent them. */
let listRequests: URLSearchParams[] = [];
let idsRequests: URLSearchParams[] = [];
/** How the stubbed `/products/ids` answers. */
let idsAnswer: { ids: string[]; total: number; truncated: boolean } | null = null;
/** Deferred mode for the ids snapshot: answers are released by the test. */
let deferIds = false;
let parkedIds: { params: URLSearchParams; release: () => void }[] = [];
/** Every chunk a bulk action sent, and which one (1-based) should fail. */
let bulkChunks: string[][] = [];
let bulkFailChunk: number | null = null;
/** How many ids the server refuses inside each chunk it does answer. */
let bulkPerIdFailures = 0;
/** Deferred mode for bulk chunks, so a run can be caught mid-flight. */
let deferBulk = false;
let parkedBulk: { chunk: string[]; release: () => void }[] = [];
let totalRows = 60; // 25 per page → 3 pages

const pageItems = (pageNumber: number, total: number, prefix = 'p') => {
  const first = (pageNumber - 1) * 25;
  const count = Math.max(0, Math.min(25, total - first));
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${first + i + 1}`,
    name: `Item ${first + i + 1}`,
    slug: `item-${first + i + 1}`,
    status: 'PUBLISHED',
    price: 10,
    stockQuantity: 1,
    trackInventory: false,
  }));
};

vi.mock('../../../lib/api-client', () => ({
  apiFetch: (path: string, init?: any) =>
    new Promise((resolve, reject) => {
      if (path.startsWith('/products/ids')) {
        const params = new URLSearchParams(path.slice('/products/ids?'.length));
        idsRequests.push(params);
        const search = params.get('search');
        const count = search === 'few' ? 40 : totalRows;
        const answer =
          idsAnswer ?? {
            ids: Array.from({ length: count }, (_, i) => (search === 'few' ? `f-${i + 1}` : `p-${i + 1}`)),
            total: count,
            truncated: false,
          };
        // Deferred: the test releases it, so a snapshot can land late.
        if (deferIds) return parkedIds.push({ params, release: () => resolve(answer) });
        return resolve(answer);
      }
      if (path.startsWith('/products?')) {
        const params = new URLSearchParams(path.slice('/products?'.length));
        listRequests.push(params);
        const pageNumber = Number(params.get('page') ?? '1');
        const search = params.get('search');
        // 'few' still spans two pages, so the cross-page choice is offered.
        const total = search === 'zzz' ? 0 : search === 'few' ? 40 : totalRows;
        return resolve({
          items: pageItems(pageNumber, total, search === 'few' ? 'f' : 'p'),
          total,
          page: pageNumber,
          limit: 25,
          totalPages: Math.max(1, Math.ceil(total / 25)),
        });
      }
      if (path.startsWith('/bulk/products/')) {
        const chunk: string[] = JSON.parse(init?.body ?? '{}').ids ?? [];
        bulkChunks.push(chunk);
        const failing = bulkFailChunk !== null && bulkChunks.length === bulkFailChunk;
        // Deferred: the test decides when this chunk answers.
        if (deferBulk) {
          return parkedBulk.push({
            chunk,
            release: () =>
              failing
                ? reject(new Error('gateway timeout'))
                : resolve({
                    successCount: chunk.length,
                    failedCount: 0,
                    successes: chunk,
                    failures: [],
                  }),
          });
        }
        if (failing) {
          return reject(new Error('gateway timeout'));
        }
        const refused = chunk.slice(0, bulkPerIdFailures);
        const applied = chunk.slice(bulkPerIdFailures);
        return resolve({
          successCount: applied.length,
          failedCount: refused.length,
          successes: applied,
          failures: refused.map((id) => ({ id, message: 'refused' })),
        });
      }
      if (path.startsWith('/categories')) return resolve({ items: [] });
      if (path.startsWith('/products/family-suggestions')) return resolve({ data: [], readyCount: 0, blockedCount: 0 });
      resolve({ data: null });
    }),
}));

import ProductsPage from './page';

const mount = async (search = '') => {
  window.history.replaceState({}, '', `/dashboard/products${search}`);
  const r = await renderComponent(
    <I18nProvider>
      <ProductsPage />
    </I18nProvider>,
  );
  for (let i = 0; i < 4; i += 1) await flush();
  return r;
};
const settleAll = async () => {
  for (let i = 0; i < 4; i += 1) await flush();
};
/** The header checkbox: the only control that selects a whole page at once. */
const headerBox = (r: any) => r.container.querySelector('thead input[type="checkbox"]') as HTMLInputElement;
const rowBoxes = (r: any) =>
  Array.from(r.container.querySelectorAll('tbody input[type="checkbox"]')) as HTMLInputElement[];
const scopeText = (r: any) => r.find('selection-summary')?.textContent ?? null;
const scopeKind = (r: any) => r.find('selection-summary')?.getAttribute('data-selection-scope') ?? null;
const selectedCount = (r: any) => rowBoxes(r).filter((b) => b.checked).length;
const searchBox = (r: any) => r.container.querySelector('input[placeholder^="Search by name"]');
/** The count the summary states, which for a cross-page selection is not the page's. */
const startQuickAction = async (r: any, label: string) => {
  const bar = r.get('bulk-bar');
  const button = Array.from(bar.querySelectorAll('button')).find(
    (b: any) => (b.textContent || '').trim() === label,
  );
  if (!button) throw new Error(`no bulk action button labelled "${label}"`);
  await click(button as any);
};
const runQuickAction = async (r: any, label: string) => {
  // Scoped to the bulk bar: rows carry their own Archive button, which opens a
  // confirmation for one product rather than running a bulk action.
  const bar = r.get('bulk-bar');
  const button = Array.from(bar.querySelectorAll('button')).find(
    (b: any) => (b.textContent || '').trim() === label,
  );
  if (!button) throw new Error(`no bulk action button labelled "${label}"`);
  await click(button as any);
  for (let i = 0; i < 6; i += 1) await flush();
};
/** The count the summary states, which for a cross-page selection is not the page's. */
const selectedCountFromSummary = (r: any) => {
  const text = scopeText(r) ?? '';
  const first = text.replace(/,/g, '').match(/\d+/);
  return first ? Number(first[0]) : 0;
};

describe('Items selection scopes', () => {
  beforeEach(() => {
    listRequests = [];
    idsRequests = [];
    idsAnswer = null;
    deferIds = false;
    parkedIds = [];
    bulkChunks = [];
    bulkFailChunk = null;
    bulkPerIdFailures = 0;
    deferBulk = false;
    parkedBulk = [];
    totalRows = 60;
  });
  afterEach(() => {
    cleanupAll();
    window.history.replaceState({}, '', '/dashboard/products');
    vi.clearAllMocks();
  });

  it('selecting the page says so, and says how many', async () => {
    const r = await mount();
    await click(headerBox(r));
    await settleAll();
    expect(scopeKind(r)).toBe('page');
    expect(scopeText(r)).toContain('25 items selected on this page');
    expect(selectedCount(r)).toBe(25);
    // The other choice is offered, named with the real matching total.
    // No filter narrows the list, so there is nothing to "match": it says items.
    expect(r.get('select-all-matching').textContent).toBe('Select all 60 items');
  });

  it('a page selection dies when the reader leaves the page', async () => {
    const r = await mount();
    await click(headerBox(r));
    await settleAll();
    await click(r.get('page-2'));
    await settleAll();
    expect(r.find('selection-summary'), 'nothing is selected on the new page').toBeNull();
    expect(selectedCount(r)).toBe(0);
  });

  it('everything-that-matches is fetched once, named, and SURVIVES paging', async () => {
    const r = await mount();
    await click(headerBox(r));
    await settleAll();
    await click(r.get('select-all-matching'));
    await settleAll();
    expect(idsRequests).toHaveLength(1);
    expect(scopeKind(r)).toBe('matching');
    expect(scopeText(r)).toContain('All 60 items selected');
    // Page 2: the selection is still the whole match, and its rows are ticked.
    await click(r.get('page-2'));
    await settleAll();
    expect(scopeKind(r), 'the cross-page selection outlives the page').toBe('matching');
    expect(scopeText(r)).toContain('All 60 items selected');
    expect(selectedCount(r)).toBe(25);
    expect(idsRequests, 'and is not re-fetched for each page').toHaveLength(1);
  });

  it('the ids request carries exactly the filters the list was showing', async () => {
    const r = await mount();
    const box = r.container.querySelector('input[placeholder^="Search by name"]');
    await type(box, 'few');
    await settle(450);
    await settleAll();
    await click(headerBox(r));
    await settleAll();
    await click(r.get('select-all-matching'));
    await settleAll();
    const ids = idsRequests[0];
    const list = listRequests[listRequests.length - 1];
    expect(ids.get('search')).toBe('few');
    expect(ids.get('search')).toBe(list.get('search'));
    // The ids snapshot is page-independent: it must not carry a page.
    expect(ids.get('page')).toBeNull();
  });

  it('stepping back to this page releases the cross-page scope', async () => {
    const r = await mount();
    await click(headerBox(r));
    await settleAll();
    await click(r.get('select-all-matching'));
    await settleAll();
    await click(r.get('select-page-only'));
    await settleAll();
    expect(scopeKind(r)).toBe('page');
    expect(scopeText(r)).toContain('25 items selected on this page');
    // And it behaves like a page selection again.
    await click(r.get('page-2'));
    await settleAll();
    expect(r.find('selection-summary')).toBeNull();
  });

  it('clearing removes the selection and its scope', async () => {
    const r = await mount();
    await click(headerBox(r));
    await settleAll();
    await click(r.get('select-all-matching'));
    await settleAll();
    await click(r.get('clear-selection'));
    await settleAll();
    expect(r.find('selection-summary')).toBeNull();
    expect(selectedCount(r)).toBe(0);
  });

  it('a search drops a cross-page selection rather than carrying it into new filters', async () => {
    const r = await mount();
    await click(headerBox(r));
    await settleAll();
    await click(r.get('select-all-matching'));
    await settleAll();
    expect(scopeKind(r)).toBe('matching');
    const box = r.container.querySelector('input[placeholder^="Search by name"]');
    await type(box, 'few');
    await settle(450);
    await settleAll();
    expect(r.find('selection-summary'), 'the old scope cannot describe new filters').toBeNull();
    expect(selectedCount(r)).toBe(0);
  });

  it('a branch change drops a cross-page selection too', async () => {
    const r = await mount();
    await click(headerBox(r));
    await settleAll();
    await click(r.get('select-all-matching'));
    await settleAll();
    const toggle = Array.from(r.container.querySelectorAll('button')).find((b: any) =>
      (b.textContent || '').includes('Filters'),
    );
    await click(toggle as any);
    await settleAll();
    const branch = Array.from(r.container.querySelectorAll('select')).find((s: any) =>
      Array.from(s.options).some((o: any) => o.value === 'store-a'),
    );
    expect(branch, 'the branch filter is on screen').toBeTruthy();
    (branch as HTMLSelectElement).value = 'store-a';
    (branch as HTMLSelectElement).dispatchEvent(new Event('change', { bubbles: true }));
    await settleAll();
    expect(r.find('selection-summary')).toBeNull();
  });

  it('REFUSES a snapshot the server could not complete, and keeps what was selected', async () => {
    const r = await mount();
    await click(headerBox(r));
    await settleAll();
    idsAnswer = { ids: Array.from({ length: 10000 }, (_, i) => `p-${i + 1}`), total: 25_000, truncated: true };
    await click(r.get('select-all-matching'));
    await settleAll();
    // Nothing pretends to be "all matching".
    expect(scopeKind(r), 'still the page selection it was').toBe('page');
    expect(selectedCount(r)).toBe(25);
    const warning = r.get('selection-too-large');
    expect(warning.getAttribute('role')).toBe('alert');
    expect(warning.textContent).toContain('25,000');
    expect(warning.textContent).toContain('10,000');
  });

  it('offers no cross-page choice when the filters already fit on one page', async () => {
    totalRows = 10;
    const r = await mount();
    await click(headerBox(r));
    await settleAll();
    expect(scopeText(r)).toContain('10 items selected on this page');
    expect(r.find('select-all-matching'), 'page and all-matching would be the same set').toBeNull();
  });

  it('shows nothing at all when no row is selected, including with zero results', async () => {
    const r = await mount();
    expect(r.find('selection-summary')).toBeNull();
    const box = r.container.querySelector('input[placeholder^="Search by name"]');
    await type(box, 'zzz');
    await settle(450);
    await settleAll();
    expect(r.find('selection-summary')).toBeNull();
    expect(r.find('select-all-matching')).toBeNull();
  });

  it('ticking one row selects that row and nothing else — no cascade to children', async () => {
    const r = await mount();
    const boxes = rowBoxes(r);
    await click(boxes[0]);
    await settleAll();
    expect(selectedCount(r), 'exactly the row that was ticked').toBe(1);
    expect(scopeText(r)).toContain('1 item selected on this page');
    await click(boxes[1]);
    await settleAll();
    expect(selectedCount(r)).toBe(2);
    // Untick one: the count follows, the scope stays a page scope.
    await click(boxes[0]);
    await settleAll();
    expect(selectedCount(r)).toBe(1);
    expect(scopeKind(r)).toBe('page');
  });

  it('the header checkbox reports the page, not the cross-page selection', async () => {
    const r = await mount();
    const boxes = rowBoxes(r);
    await click(boxes[0]);
    await settleAll();
    expect(headerBox(r).indeterminate, 'some of this page').toBe(true);
    await click(headerBox(r));
    await settleAll();
    expect(headerBox(r).checked, 'all of this page').toBe(true);
    expect(headerBox(r).indeterminate).toBe(false);
  });

  it('announces the selection through a live region', async () => {
    const r = await mount();
    await click(headerBox(r));
    await settleAll();
    // The live region is always mounted and holds text only, so the FIRST
    // selection is announced too and its buttons are not re-read each time.
    const live = r.get('selection-announcement');
    expect(live.getAttribute('role')).toBe('status');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.textContent).toContain('25 items selected on this page');
    expect(live.querySelector('button'), 'no controls inside the live region').toBeNull();
    expect(r.get('selection-summary').getAttribute('role'), 'the visible line is not a second region').toBeNull();
  });

  /**
   * NOTHING OF A SELECTION MAY OUTLIVE ITS CLEARING.
   *
   * Clearing only the ids used to leave the cross-page record armed. The next
   * row the reader ticked then inherited a scope it never had: it survived a
   * page change and was described as every matching item. Every path that
   * means "the selection is gone" must end all of it.
   */
  describe('clearing ends every part of the selection', () => {
    const takeMatchingThenClear = async (r: any, clearTestId: string) => {
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      expect(scopeKind(r)).toBe('matching');
      await click(r.get(clearTestId));
      await settleAll();
      expect(r.find('selection-summary')).toBeNull();
    };
    /** One row ticked after a clear must behave as a plain page selection. */
    const oneRowIsPageScoped = async (r: any) => {
      await click(rowBoxes(r)[0]);
      await settleAll();
      expect(scopeKind(r), 'a fresh tick is a page selection').toBe('page');
      expect(scopeText(r)).toContain('1 item selected on this page');
      await click(r.get('page-2'));
      await settleAll();
      expect(r.find('selection-summary'), 'and it does not survive the page').toBeNull();
      expect(selectedCount(r)).toBe(0);
    };

    it('the summary Clear leaves no cross-page scope behind', async () => {
      const r = await mount();
      await takeMatchingThenClear(r, 'clear-selection');
      await oneRowIsPageScoped(r);
    });

    it('the bulk bar Clear leaves no cross-page scope behind', async () => {
      const r = await mount();
      await takeMatchingThenClear(r, 'bulk-clear');
      await oneRowIsPageScoped(r);
    });

    it('a finished bulk action leaves no cross-page scope behind', async () => {
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      const publish = Array.from(r.container.querySelectorAll('button')).find((b: any) =>
        (b.textContent || '').trim() === 'Publish',
      );
      expect(publish, 'the bar offers Publish').toBeTruthy();
      await click(publish as any);
      await settleAll();
      expect(r.find('selection-summary'), 'the action consumed the selection').toBeNull();
      await oneRowIsPageScoped(r);
    });
  });

  /**
   * A SNAPSHOT IS ONLY GOOD FOR THE SCOPE IT WAS TAKEN FOR. Between asking and
   * answering, the reader may have typed a new search. Applying the old answer
   * then selects ids from a list that is no longer on screen.
   */
  describe('a superseded snapshot never lands', () => {
    it('a slow snapshot of the old scope cannot select into the new one', async () => {
      deferIds = true;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      expect(parkedIds).toHaveLength(1);
      // The reader searches while the snapshot is still in flight.
      await type(searchBox(r), 'few');
      await settle(450);
      await settleAll();
      // The old scope's 60 ids arrive now.
      parkedIds[0].release();
      await settleAll();
      expect(r.find('selection-summary'), 'nothing was selected by the old answer').toBeNull();
      expect(selectedCount(r)).toBe(0);
      const onScreen = rowBoxes(r).length;
      expect(onScreen, 'the new scope is on screen').toBeGreaterThan(0);
    });

    it('a snapshot is dropped by a keystroke inside the search debounce window', async () => {
      deferIds = true;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      // Typing changes the filters immediately, long before the debounce and
      // before the scope itself moves.
      await type(searchBox(r), 'f');
      await settleAll();
      parkedIds[0].release();
      await settleAll();
      expect(r.find('selection-summary'), 'the keystroke already ended it').toBeNull();
      expect(selectedCount(r)).toBe(0);
    });

    it('the snapshot for the scope on screen still lands normally', async () => {
      deferIds = true;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      parkedIds[0].release();
      await settleAll();
      expect(scopeKind(r)).toBe('matching');
      expect(scopeText(r)).toContain('All 60 items selected');
    });
  });

  /**
   * A CONTROL THAT NEEDS THE RECORDS CANNOT RUN ON IDS ALONE. Grouping reads
   * names, roles and children; only the current page's products are loaded.
   * Grouping 25 of 60 because the rest were never fetched is the silent wrong
   * answer.
   */
  it('Group is refused for a cross-page selection, and says why', async () => {
    const r = await mount();
    await click(headerBox(r));
    await settleAll();
    await click(r.get('select-all-matching'));
    await settleAll();
    const group = r.get('bulk-group') as HTMLButtonElement;
    expect(group.disabled, 'it cannot group 25 of 60').toBe(true);
    const reason = r.get('bulk-group-blocked').textContent ?? '';
    expect(reason).toContain('60');
    expect(reason).toContain('one page');
    expect(group.getAttribute('aria-describedby')).toBe('bulk-group-blocked');
  });

  it('Group stays available for a selection whose records are all on screen', async () => {
    const r = await mount();
    await click(rowBoxes(r)[0]);
    await click(rowBoxes(r)[1]);
    await settleAll();
    expect((r.get('bulk-group') as HTMLButtonElement).disabled).toBe(false);
    expect(r.find('bulk-group-blocked')).toBeNull();
  });

  /**
   * THE WORDING FOLLOWS THE COUNT, NOT THE MODE. Unticking one of sixty leaves
   * fifty-nine, and calling that "every matching item" is false.
   */
  describe('the sentence stays true after a manual change', () => {
    it('unticking one of the matching selection says 59 of 60', async () => {
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      expect(scopeText(r)).toContain('All 60 items selected');
      await click(rowBoxes(r)[0]);
      await settleAll();
      expect(scopeText(r)).toContain('59 of 60 matching items selected');
      expect(scopeKind(r), 'still a cross-page selection, just an edited one').toBe('matching');
      expect(selectedCount(r)).toBe(24);
      expect(headerBox(r).indeterminate, 'and the header says some of this page').toBe(true);
    });

    it('the edited selection keeps its scope and its rows on a later page', async () => {
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      await click(rowBoxes(r)[0]);
      await settleAll();
      await click(r.get('page-2'));
      await settleAll();
      expect(scopeText(r)).toContain('59 of 60 matching items selected');
      expect(selectedCount(r), 'page 2 is untouched by the untick on page 1').toBe(25);
      expect(headerBox(r).checked).toBe(true);
      expect(headerBox(r).indeterminate).toBe(false);
    });

    it('reads one item in the singular and groups thousands', async () => {
      const r = await mount();
      await click(rowBoxes(r)[0]);
      await settleAll();
      expect(scopeText(r)).toContain('1 item selected on this page');
      expect(scopeText(r)).not.toContain('1 items');
    });
  });

  /**
   * A SELECTION MAY NOT OUTLIVE THE LIST IT DESCRIBES.
   *
   * A typed search changes the filters at once and the list only when the
   * debounce fires. In between, the old rows are still on screen. A selection
   * taken there is a selection of the old list, and when the new search lands
   * those ids describe nothing the reader can see.
   */
  describe('a selection cannot survive the search it was made under', () => {
    it('offers no cross-page choice while the typed search and the list disagree', async () => {
      const r = await mount();
      await type(searchBox(r), 'few');
      await settleAll(); // the debounce has NOT fired: old rows, new search text
      await click(headerBox(r));
      await settleAll();
      expect(r.find('select-all-matching'), 'the list is about to change under it').toBeNull();
      // Once the two agree, the offer returns — for the new scope.
      await settle(450);
      await settleAll();
      await click(headerBox(r));
      await settleAll();
      expect(r.get('select-all-matching').textContent).toContain('40');
    });

    it('a snapshot answered BEFORE the debounce cannot outlive it', async () => {
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      expect(scopeKind(r)).toBe('matching');
      // Now the reader searches; the snapshot is already applied.
      await type(searchBox(r), 'few');
      await settle(450);
      await settleAll();
      expect(r.find('selection-summary'), 'the old ids describe nothing on screen').toBeNull();
      expect(selectedCount(r)).toBe(0);
    });

    it('a snapshot answered AFTER the debounce never lands', async () => {
      deferIds = true;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      expect(parkedIds).toHaveLength(1);
      await type(searchBox(r), 'few');
      await settle(450);
      await settleAll();
      parkedIds[0].release(); // the old scope's 60 ids arrive now
      await settleAll();
      expect(r.find('selection-summary')).toBeNull();
      expect(selectedCount(r)).toBe(0);
    });

    it('no old-scope id can reach a bulk request under the new scope', async () => {
      deferIds = true;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      await type(searchBox(r), 'few');
      await settle(450);
      await settleAll();
      parkedIds[0].release();
      await settleAll();
      // Select the new scope's page and run an action.
      await click(headerBox(r));
      await settleAll();
      await runQuickAction(r, 'Publish');
      const sent = bulkChunks.flat();
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((id) => id.startsWith('f-')), 'every id belongs to the new scope').toBe(true);
      expect(sent.some((id) => id.startsWith('p-')), 'no old-scope id was sent').toBe(false);
    });
  });

  /**
   * A LATE SNAPSHOT MAY NOT OVERWRITE WHAT THE READER JUST SAID.
   *
   * Clearing, stepping back to the page, or ticking a box is a statement about
   * the selection. A snapshot still in flight was asked for before that
   * statement, so it is no longer wanted.
   */
  describe('a manual change cancels a snapshot already in flight', () => {
    const pendingSnapshot = async () => {
      deferIds = true;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      expect(parkedIds).toHaveLength(1);
      return r;
    };

    it('Clear wins over a snapshot that answers afterwards', async () => {
      const r = await pendingSnapshot();
      await click(r.get('clear-selection'));
      await settleAll();
      parkedIds[0].release();
      await settleAll();
      expect(r.find('selection-summary'), 'nothing came back').toBeNull();
      expect(selectedCount(r)).toBe(0);
      expect(headerBox(r).checked).toBe(false);
      expect(headerBox(r).indeterminate).toBe(false);
    });

    it('unticking a row wins, and only that row is missing', async () => {
      const r = await pendingSnapshot();
      await click(rowBoxes(r)[0]);
      await settleAll();
      parkedIds[0].release();
      await settleAll();
      expect(scopeKind(r), 'still the page selection the reader edited').toBe('page');
      expect(selectedCount(r)).toBe(24);
      expect(scopeText(r)).toContain('24 items selected on this page');
      expect(headerBox(r).indeterminate).toBe(true);
      // And a bulk action carries exactly those 24 ids, none from the snapshot.
      await runQuickAction(r, 'Publish');
      expect(bulkChunks.flat()).toHaveLength(24);
    });

    it('the header checkbox wins over a snapshot that answers afterwards', async () => {
      const r = await pendingSnapshot();
      await click(headerBox(r)); // unticks the whole page
      await settleAll();
      parkedIds[0].release();
      await settleAll();
      expect(r.find('selection-summary')).toBeNull();
      expect(selectedCount(r)).toBe(0);
      expect(headerBox(r).checked).toBe(false);
    });

    it('stepping back to this page wins over a snapshot that answers afterwards', async () => {
      const r = await pendingSnapshot();
      // A first snapshot lands so there is something to step back from.
      parkedIds[0].release();
      await settleAll();
      expect(scopeKind(r)).toBe('matching');
      await click(r.get('select-page-only'));
      await settleAll();
      expect(scopeKind(r)).toBe('page');
      expect(selectedCount(r)).toBe(25);
    });
  });

  /**
   * WHAT A STOPPED RUN LEAVES BEHIND, AND WHAT MAY BE DONE WITH IT.
   *
   * Three different things: what the server confirmed, the chunk whose answer
   * was lost, and the chunks never sent. Only the last is certainly untouched.
   */
  describe('a run that stops leaves a truthful remainder', () => {
    const selectAllOf = async (n: number) => {
      totalRows = n;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      expect(scopeKind(r)).toBe('matching');
      return r;
    };

    it('a MIDDLE chunk failure of 1,200 ids names confirmed, unconfirmed and never sent', async () => {
      const r = await selectAllOf(1200);
      bulkFailChunk = 2; // 500 + 500 + 200; the second request fails
      await runQuickAction(r, 'Publish');
      expect(bulkChunks.map((c) => c.length), 'bounded chunks, stopped at the failure').toEqual([500, 500]);
      expect(scopeKind(r), 'the remainder is a cross-page selection').toBe('remainder');
      // 500 unconfirmed + 200 never sent = 700 still selected for a safe action.
      expect(selectedCountFromSummary(r)).toBe(700);
      expect(scopeText(r)).toContain('700');
      expect(scopeText(r)).toContain('500');
      expect(scopeText(r)).toContain('200');
      expect(toast.error).toHaveBeenCalled();
    });

    it('the remainder survives paging instead of vanishing', async () => {
      const r = await selectAllOf(1200);
      bulkFailChunk = 2;
      await runQuickAction(r, 'Publish');
      expect(scopeKind(r)).toBe('remainder');
      await click(r.get('page-2'));
      await settleAll();
      expect(scopeKind(r), 'still there on another page').toBe('remainder');
      expect(scopeText(r)).toContain('700');
    });

    it('a retry carries only the remainder, never a confirmed id', async () => {
      const r = await selectAllOf(1200);
      bulkFailChunk = 2;
      await runQuickAction(r, 'Publish');
      const confirmed = bulkChunks[0];
      bulkChunks = [];
      bulkFailChunk = null;
      await runQuickAction(r, 'Publish');
      const retried = bulkChunks.flat();
      expect(retried).toHaveLength(700);
      for (const id of confirmed) expect(retried, 'a confirmed id is never re-sent').not.toContain(id);
      await settleAll();
      expect(r.find('selection-summary'), 'the run finished').toBeNull();
    });

    it('per-id refusals are reported beside an outright chunk failure', async () => {
      const r = await selectAllOf(1200);
      bulkFailChunk = 2;
      bulkPerIdFailures = 3; // the first chunk refuses three ids
      await runQuickAction(r, 'Publish');
      const message = (toast.error as any).mock.calls.at(-1)?.[0] ?? '';
      expect(message).toContain('497'); // 500 sent, 3 refused
      expect(message).toContain('3');
      expect(message).toContain('500'); // unconfirmed
      expect(message).toContain('200'); // never sent
    });

    it('ARCHIVE keeps the unconfirmed ids out of the selection, and says why', async () => {
      const r = await selectAllOf(1200);
      bulkFailChunk = 2;
      await runQuickAction(r, 'Archive');
      expect(scopeKind(r)).toBe('remainder');
      // Only the 200 never sent may be re-run: archiving twice is refused, so
      // re-sending the 500 unconfirmed would report real successes as failures.
      expect(selectedCountFromSummary(r)).toBe(200);
      expect(scopeText(r)).toContain('200');
      expect(scopeText(r)).toContain('500');
      expect(scopeText(r)).toContain('check those');
      bulkChunks = [];
      bulkFailChunk = null;
      await runQuickAction(r, 'Archive');
      expect(bulkChunks.flat(), 'the retry touches only what was never sent').toHaveLength(200);
    });

    it('clearing ends a remainder like any other selection', async () => {
      const r = await selectAllOf(1200);
      bulkFailChunk = 2;
      await runQuickAction(r, 'Publish');
      await click(r.get('clear-selection'));
      await settleAll();
      expect(r.find('selection-summary')).toBeNull();
      expect(selectedCount(r)).toBe(0);
    });

    it('changing the scope ends a remainder too', async () => {
      const r = await selectAllOf(1200);
      bulkFailChunk = 2;
      await runQuickAction(r, 'Publish');
      expect(scopeKind(r)).toBe('remainder');
      await type(searchBox(r), 'few');
      await settle(450);
      await settleAll();
      expect(r.find('selection-summary'), 'it belonged to the old scope').toBeNull();
    });
  });

  /**
   * A RUN THAT FINISHES LATE DOES NOT GET TO SPEAK FOR THE SELECTION.
   *
   * A run may take minutes. By the time it answers, the reader may have
   * cleared the selection, edited it, or moved to a different search. Its
   * results are still worth reading — under the scope it started in — but it
   * may not install ids into a list they do not belong to.
   */
  describe('a late completion cannot reach into a new scope', () => {
    const startRunOf = async (n: number, label = 'Publish') => {
      totalRows = n;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      deferBulk = true;
      await startQuickAction(r, label);
      await settleAll();
      return r;
    };
    const releaseAll = async () => {
      // Each release lets the runner reach the next chunk, which parks too.
      for (let guard = 0; guard < 10 && parkedBulk.length > 0; guard += 1) {
        const next = parkedBulk.shift()!;
        next.release();
        await settleAll();
      }
    };

    it('a 1,200-id run that fails chunk 2 after the search moved installs nothing', async () => {
      const r = await startRunOf(1200);
      bulkFailChunk = 2;
      // The reader searches while the run is in flight, and it settles.
      await type(searchBox(r), 'few');
      await settle(450);
      await settleAll();
      await releaseAll();
      // None of the 700 old-scope ids became a selection.
      expect(r.find('selection-summary'), 'the new scope has no selection').toBeNull();
      expect(selectedCount(r)).toBe(0);
      // The result is still reviewable.
      const report = r.get('run-report');
      expect(report).not.toBeNull();
      expect(report.textContent).toContain('500');
      // And an action in the new scope carries only new-scope ids.
      bulkChunks = [];
      deferBulk = false;
      bulkFailChunk = null;
      await click(headerBox(r));
      await settleAll();
      await runQuickAction(r, 'Publish');
      const sent = bulkChunks.flat();
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.every((id) => id.startsWith('f-')), 'no old-scope id reached it').toBe(true);
    });

    it('a Clear during the run is not undone by the completion', async () => {
      const r = await startRunOf(1200);
      bulkFailChunk = 2;
      await click(r.get('clear-selection'));
      await settleAll();
      await releaseAll();
      expect(r.find('selection-summary'), 'Clear stands').toBeNull();
      expect(selectedCount(r)).toBe(0);
      expect(r.find('run-report'), 'but the run is still readable').not.toBeNull();
    });

    it('a manual edit during the run is not undone by the completion', async () => {
      const r = await startRunOf(1200);
      bulkFailChunk = 2;
      await click(rowBoxes(r)[0]);
      await settleAll();
      const edited = selectedCount(r);
      await releaseAll();
      expect(selectedCount(r), 'the reader edit stands').toBe(edited);
      expect(scopeKind(r), 'not replaced by the run leftovers').toBe('matching');
      expect(scopeText(r), 'and it counts honestly').toContain('1,199 of 1,200');
    });

    it('a clean run whose selection changed does not clear the new selection', async () => {
      const r = await startRunOf(60);
      await click(r.get('clear-selection'));
      await settleAll();
      await click(rowBoxes(r)[0]);
      await settleAll();
      await releaseAll();
      expect(selectedCount(r), 'the row ticked mid-run is still ticked').toBe(1);
    });
  });

  /**
   * ONE RUN AT A TIME. Two clicks arrive before the first run has rendered
   * anything, so only a synchronous guard can stop the second.
   */
  describe('parallel runs are refused', () => {
    it('a double click on Publish sends one sequence of chunks', async () => {
      totalRows = 1200;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      deferBulk = true;
      const publish = Array.from(r.get('bulk-bar').querySelectorAll('button')).find(
        (b: any) => (b.textContent || '').trim() === 'Publish',
      ) as HTMLButtonElement;
      // Both clicks on the SAME element, as a real double click lands before
      // the bar has re-rendered into its running state.
      await click(publish);
      await click(publish);
      await settleAll();
      expect(parkedBulk, 'only the first run is in flight').toHaveLength(1);
      expect(r.find('bulk-running'), 'and the bar says so').not.toBeNull();
      for (let guard = 0; guard < 10 && parkedBulk.length > 0; guard += 1) {
        const next = parkedBulk.shift()!;
        next.release();
        await settleAll();
      }
      expect(bulkChunks.map((c) => c.length), 'one run of three chunks').toEqual([500, 500, 200]);
    });

    it('a second, different action while one runs is refused', async () => {
      totalRows = 60;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      deferBulk = true;
      const bar = r.get('bulk-bar');
      const buttons = Array.from(bar.querySelectorAll('button')) as HTMLButtonElement[];
      const publish = buttons.find((b) => (b.textContent || '').trim() === 'Publish')!;
      const archive = buttons.find((b) => (b.textContent || '').trim() === 'Archive')!;
      await click(publish);
      await click(archive);
      await settleAll();
      expect(bulkChunks, 'the second action never started').toHaveLength(1);
      parkedBulk.shift()!.release();
      await settleAll();
      expect(r.find('bulk-running'), 'the guard is released at the end').toBeNull();
    });

    it('a failed run releases the guard, so the next action can start', async () => {
      totalRows = 60;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      bulkFailChunk = 1;
      await runQuickAction(r, 'Publish');
      bulkFailChunk = null;
      bulkChunks = [];
      await runQuickAction(r, 'Publish');
      expect(bulkChunks.length, 'the guard did not stay locked').toBeGreaterThan(0);
    });
  });

  /**
   * AN ARCHIVE RUN THAT LOSES ITS ANSWER LEAVES IDS NOBODY CAN ACCOUNT FOR.
   * Nothing may be re-selected on their behalf, so the only place their
   * identity survives is a panel that outlives the toast and the bulk bar.
   */
  describe('unconfirmed archive ids stay identified', () => {
    it('a 60-id archive whose only chunk fails names all 60, with no selection left', async () => {
      totalRows = 60;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      bulkFailChunk = 1;
      await runQuickAction(r, 'Archive');
      // Nothing is safe to retry, so the bar and its selection are gone.
      expect(r.find('selection-summary'), 'nothing may be re-selected').toBeNull();
      // The panel stays, and names every id in doubt.
      const report = r.get('run-report');
      expect(report.getAttribute('role')).toBe('region');
      expect(r.all('run-report-unconfirmed-item')).toHaveLength(60);
      expect(report.textContent).toContain('archive');
      expect(report.textContent).toContain('cannot be safely repeated');
      // It survives a page change and only goes when dismissed.
      await settleAll();
      expect(r.find('run-report')).not.toBeNull();
      await click(r.get('run-report-dismiss'));
      await settleAll();
      expect(r.find('run-report')).toBeNull();
    });

    it('the FINAL chunk of a longer archive run failing still names its ids', async () => {
      totalRows = 1200;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      bulkFailChunk = 3; // 500 + 500 + 200; the last one fails
      await runQuickAction(r, 'Archive');
      expect(r.all('run-report-unconfirmed-item'), 'the last chunk is in doubt').toHaveLength(200);
      expect(r.get('run-report-summary').textContent).toContain('1,000'); // confirmed
      expect(r.get('run-report-summary').textContent).toContain('200');
      expect(r.find('selection-summary'), 'nothing was never-sent, so nothing to retry').toBeNull();
    });

    it('a retry-safe action says its unconfirmed ids can simply be re-run', async () => {
      totalRows = 60;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      bulkFailChunk = 1;
      await runQuickAction(r, 'Publish');
      expect(r.get('run-report').textContent).toContain('safe');
      expect(r.all('run-report-unconfirmed-item')).toHaveLength(60);
    });
  });

  /**
   * AN EDITED REMAINDER IS STILL A CROSS-PAGE SELECTION. A 1,200-id run that
   * stops on chunk 2 leaves 700 ids (p-501 … p-1200), none of them on the
   * first pages. Ticking a row there must not relabel all of them "on this
   * page", and the next page change must not quietly drop the retry set.
   */
  describe('an edited remainder', () => {
    const stopWithRemainder = async () => {
      totalRows = 1200;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      bulkFailChunk = 2;
      await runQuickAction(r, 'Publish');
      expect(scopeKind(r)).toBe('remainder');
      bulkFailChunk = null;
      return r;
    };

    it('a header tick keeps it a cross-page selection and says so', async () => {
      const r = await stopWithRemainder();
      await click(headerBox(r));
      await settleAll();
      expect(scopeKind(r), 'an edited set is not that run leftovers').toBe('edited');
      expect(scopeText(r)).toContain('725 items selected across pages');
      expect(scopeText(r)).not.toContain('on this page');
    });

    it('a row ticked on page 2 joins the 700, and all 701 survive the next page change', async () => {
      const r = await stopWithRemainder();
      await click(r.get('page-2'));
      await settleAll();
      expect(scopeKind(r), 'the remainder survives paging').toBe('remainder');
      await click(rowBoxes(r)[0]); // p-26, confirmed in chunk 1, not in the remainder
      await settleAll();
      expect(scopeKind(r)).toBe('edited');
      expect(scopeText(r)).toContain('701 items selected across pages');
      expect(selectedCount(r), 'only the ticked row is on this page').toBe(1);

      await click(r.get('page-3'));
      await settleAll();
      expect(scopeKind(r), 'paging does not drop an edited cross-page set').toBe('edited');
      expect(scopeText(r)).toContain('701 items selected across pages');
      expect(selectedCount(r), 'nothing on page 3 is selected').toBe(0);

      await click(r.get('page-2'));
      await settleAll();
      expect(rowBoxes(r)[0].checked, 'the ticked row is still ticked on its own page').toBe(true);
      expect(selectedCount(r)).toBe(1);

      // Every one of the 701 ids reaches the next action.
      bulkChunks = [];
      await runQuickAction(r, 'Draft');
      const sent = bulkChunks.flat();
      expect(sent).toHaveLength(701);
      expect(sent).toContain('p-26');
      expect(sent).toContain('p-501');
      expect(sent).toContain('p-1200');
      expect(sent).not.toContain('p-1');
    });

    it('Clear ends an edited selection', async () => {
      const r = await stopWithRemainder();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('clear-selection'));
      await settleAll();
      expect(r.find('selection-summary')).toBeNull();
      // And nothing is left armed: one tick is a page selection again.
      await click(rowBoxes(r)[0]);
      await settleAll();
      expect(scopeKind(r)).toBe('page');
      await click(r.get('page-2'));
      await settleAll();
      expect(r.find('selection-summary'), 'a page tick dies on the next page').toBeNull();
    });

    it('a scope change ends an edited selection', async () => {
      const r = await stopWithRemainder();
      await click(headerBox(r));
      await settleAll();
      expect(scopeKind(r)).toBe('edited');
      await type(searchBox(r), 'few');
      await settle(450);
      await settleAll();
      expect(r.find('selection-summary')).toBeNull();
    });

  });

  it('a cross-page selection unticked to nothing by hand leaves nothing armed', async () => {
    totalRows = 30; // 25 + 5
    const r = await mount();
    await click(headerBox(r));
    await settleAll();
    await click(r.get('select-all-matching'));
    await settleAll();
    expect(scopeKind(r)).toBe('matching');
    await click(headerBox(r)); // untick page 1: 5 left, all on page 2
    await settleAll();
    await click(r.get('page-2'));
    await settleAll();
    await click(headerBox(r)); // untick page 2: nothing left
    await settleAll();
    expect(r.find('selection-summary')).toBeNull();
    // A fresh tick is a page selection, not an heir to the emptied one.
    await click(rowBoxes(r)[0]);
    await settleAll();
    expect(scopeKind(r)).toBe('page');
    await click(r.get('page-1'));
    await settleAll();
    expect(r.find('selection-summary'), 'a page tick dies on the next page').toBeNull();
  });

  describe('the run report belongs to the latest run', () => {
    it('a successful Publish after an archive report replaces it', async () => {
      totalRows = 60;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      bulkFailChunk = 1;
      await runQuickAction(r, 'Archive');
      expect(r.get('run-report').textContent).toContain('archive');
      bulkFailChunk = null;
      bulkChunks = [];
      await click(headerBox(r));
      await settleAll();
      await runQuickAction(r, 'Publish');
      expect(bulkChunks.flat()).toHaveLength(25);
      expect(r.find('run-report'), 'the archive details are not the last bulk action').toBeNull();
    });

    it('a stopped run without refusals shows no generic 0 / 0 panel beside its report', async () => {
      totalRows = 60;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      bulkFailChunk = 1;
      await runQuickAction(r, 'Archive');
      expect(r.find('run-report')).not.toBeNull();
      expect(r.container.textContent).not.toContain('Bulk Operation Results');
    });

    it('a stopped run WITH refusals keeps their details beside the report', async () => {
      totalRows = 1200;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      bulkPerIdFailures = 2;
      bulkFailChunk = 2;
      await runQuickAction(r, 'Archive');
      expect(r.get('run-report-summary').textContent).toContain('2 refused');
      expect(r.container.textContent).toContain('Bulk Operation Results');
      expect(r.container.textContent).toContain('Details of failures');
    });

    it('each unconfirmed id links to its Item page', async () => {
      totalRows = 60;
      const r = await mount();
      await click(headerBox(r));
      await settleAll();
      await click(r.get('select-all-matching'));
      await settleAll();
      bulkFailChunk = 1;
      await runQuickAction(r, 'Archive');
      const links = r.all('run-report-unconfirmed-item').map((li: Element) => li.querySelector('a')?.getAttribute('href'));
      expect(links).toHaveLength(60);
      expect(links[0]).toBe('/dashboard/products/p-1');
      expect(links[59]).toBe('/dashboard/products/p-60');
    });
  });

  /**
   * ONE RUN AT A TIME, WEBSITE PUBLICATION INCLUDED. The publication result's
   * "retry the not attempted" runs outside the dialog that otherwise covers
   * the bar, so it shares the bar's running state.
   */
  it('a website-publication retry is not offered while a bar action runs', async () => {
    totalRows = 60;
    const r = await mount();
    await click(headerBox(r));
    await settleAll();
    await click(r.get('bulk-website-publication'));
    await settleAll();
    const storeSelect = r.get('wp-store') as HTMLSelectElement;
    storeSelect.value = 'store-a';
    storeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await settleAll();
    await click(r.get('wp-publish'));
    await settleAll();
    bulkFailChunk = 1; // the publication request fails outright
    await click(r.get('wp-submit'));
    await settleAll();
    expect(r.find('wp-retry'), 'the stopped publication offers its retry').not.toBeNull();

    bulkFailChunk = null;
    deferBulk = true;
    await click(headerBox(r));
    await settleAll();
    await startQuickAction(r, 'Publish');
    await settleAll();
    expect(r.find('bulk-running')).not.toBeNull();
    expect(r.find('wp-retry'), 'no second run while the bar runs').toBeNull();

    while (parkedBulk.length > 0) {
      parkedBulk.shift()!.release();
      await settleAll();
    }
    expect(r.find('bulk-running')).toBeNull();
    expect(r.find('wp-retry'), 'offered again once the bar run ends').not.toBeNull();
  });

  it('a clean run reports items as confirmed rather than updated', async () => {
    totalRows = 60;
    const r = await mount();
    await click(headerBox(r));
    await settleAll();
    await runQuickAction(r, 'Publish');
    const message = (toast.success as any).mock.calls.at(-1)?.[0] ?? '';
    expect(message).toContain('confirmed');
    expect(message).not.toContain('updated');
  });

  it('has a Spanish entry for every selection string', async () => {
    const { ES } = await import('../../../lib/translations.es');
    for (const key of [
      '{n} items selected on this page',
      '{n} items selected, every item matching these filters',
      'Select all {n} matching these filters',
      'Select only this page',
      'Clear selection',
      '{total} items match these filters, more than the {cap} that can be selected at once. Narrow the filters and try again.',
      '{n} items selected across pages',
      '1 item selected across pages',
    ]) {
      expect(ES[key], `missing Spanish for "${key}"`).toBeTruthy();
      expect(ES[key]).not.toBe(key);
    }
  });

  it('the Spanish run counts say confirmed, never updated', async () => {
    const { ES } = await import('../../../lib/translations.es');
    for (const key of [
      '{confirmed} confirmed, {failed} refused, {unconfirmed} unconfirmed, {notAttempted} never sent',
      '{action}: {confirmed} confirmed, {failed} refused, {unconfirmed} unconfirmed, {notAttempted} never sent',
      '{n} items confirmed',
      '{n} items confirmed, {failed} refused',
    ]) {
      expect(ES[key]).toContain('confirmados');
      expect(ES[key]).not.toContain('actualizados');
    }
  });
});
