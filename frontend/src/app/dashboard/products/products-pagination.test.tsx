import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click, type, select, flush, settle } from '../../../test/render';
import { I18nProvider } from '../../../lib/i18n';

/**
 * THE ITEMS PAGE AROUND ITS PAGINATION.
 *
 * What the component cannot know on its own: that the page is read from the
 * URL and written back, that Back and Forward move it, that a filter change
 * sends the list to page 1 and REPLACES the entry, that an out-of-range page
 * is clamped after the fetch, that zero rows show no controls at all, and
 * that every request while moving keeps the reader's filters.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ children, ...rest }: { children?: React.ReactNode } & Record<string, unknown>) =>
    React.createElement('a', rest, children),
}));
const toast = { success: vi.fn(), error: vi.fn(), undo: vi.fn() };
vi.mock('../../../components/ui/toast', () => ({ useToast: () => toast }));
vi.mock('../../../lib/use-website-config', () => ({
  useStores: () => ({ stores: [{ id: 'store-a', name: 'EliteToGo', slug: 'elite', archivedAt: null }] }),
  buildWebsiteUrl: () => 'https://example.test',
}));
vi.mock('../../../lib/auth', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'manager@elite.example', role: 'ORGANIZATION_MANAGER' },
    scope: { platform: false, role: 'ORGANIZATION_MANAGER', organizationId: 'org-1', storeId: null, allowedStoreIds: ['store-a'] },
    accessToken: 'token',
  }),
}));

/** Every rows request, as the page sent it: which page, which filters. */
let requests: URLSearchParams[] = [];
/** How many rows the stub owns; 25 per page, as the page asks. */
let totalRows = 480;
/**
 * DEFERRED MODE: rows requests are parked here instead of answered, so a
 * test can answer them in whatever ORDER it likes, reject one, or answer
 * after the page is gone. The default mode answers at once, in order.
 */
type Parked = { params: URLSearchParams; resolve: (value: unknown) => void; reject: (error: Error) => void };
let deferred = false;
let parked: Parked[] = [];
const answerFor = (params: URLSearchParams, total = totalRows) => {
  const pageNumber = Number(params.get('page') ?? '1');
  const limit = Number(params.get('limit') ?? '25');
  const totalPages = Math.ceil(total / limit);
  const first = (pageNumber - 1) * limit;
  const count = Math.max(0, Math.min(limit, total - first));
  const items = Array.from({ length: count }, (_, i) => ({
    id: `p-${pageNumber}-${i + 1}`,
    name: `Item ${pageNumber}-${i + 1}`,
    slug: `item-${pageNumber}-${i + 1}`,
    status: 'PUBLISHED',
    price: 10,
    stockQuantity: 1,
    trackInventory: false,
  }));
  return { items, total, page: pageNumber, limit, totalPages };
};
vi.mock('../../../lib/api-client', () => ({
  apiFetch: (path: string) =>
    new Promise((resolve, reject) => {
      if (path.startsWith('/products?')) {
        const params = new URLSearchParams(path.slice('/products?'.length));
        requests.push(params);
        if (deferred) parked.push({ params, resolve, reject });
        else resolve(answerFor(params));
        return;
      }
      if (path.startsWith('/categories')) return resolve({ items: [] });
      if (path.startsWith('/products/family-suggestions')) return resolve({ data: [], readyCount: 0, blockedCount: 0 });
      resolve({ data: null });
    }),
}));

import ProductsPage from './page';

const pagesRequested = () => requests.map((p) => p.get('page'));
const mount = async (search: string) => {
  window.history.replaceState({}, '', `/dashboard/products${search}`);
  const r = await renderComponent(
    <I18nProvider>
      <ProductsPage />
    </I18nProvider>,
  );
  for (let i = 0; i < 4; i += 1) await flush();
  return r;
};

describe('Items page pagination', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  beforeEach(() => {
    requests = [];
    totalRows = 480;
    deferred = false;
    parked = [];
    unhandled.length = 0;
    process.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    cleanupAll();
    window.history.replaceState({}, '', '/dashboard/products');
  });

  it('reads the page from the URL, asks the server for that page, and marks it current', async () => {
    const r = await mount('?page=8');
    expect(pagesRequested()).toEqual(['8']);
    expect(r.get('pagination-summary').textContent).toBe('Page 8 of 20 · 480 items');
    expect(r.get('page-8').getAttribute('aria-current')).toBe('page');
    expect(r.container.textContent).toContain('Item 8-1');
    expect(window.location.search).toBe('?page=8');
    expect(unhandled).toEqual([]);
  });

  it('a click on a page number pushes a history entry and requests that page with the same filters', async () => {
    const r = await mount('?page=8');
    const entriesBefore = window.history.length;
    await click(r.get('page-9'));
    for (let i = 0; i < 3; i += 1) await flush();
    expect(pagesRequested()).toEqual(['8', '9']);
    expect(window.location.search).toBe('?page=9');
    expect(window.history.length).toBe(entriesBefore + 1);
    expect(r.get('page-9').getAttribute('aria-current')).toBe('page');
  });

  it('Back and Forward restore a fresh cached page without pushing or requesting it twice', async () => {
    const r = await mount('?page=8');
    await click(r.get('page-9'));
    for (let i = 0; i < 3; i += 1) await flush();
    const entries = window.history.length;
    // The browser has just gone back: the URL says 8 again and popstate fires.
    window.history.replaceState({}, '', '/dashboard/products?page=8');
    window.dispatchEvent(new PopStateEvent('popstate'));
    for (let i = 0; i < 3; i += 1) await flush();
    expect(pagesRequested()).toEqual(['8', '9']);
    expect(r.get('page-8').getAttribute('aria-current')).toBe('page');
    expect(r.container.textContent).toContain('Item 8-1');
    expect(window.history.length).toBe(entries);
  });

  it('First and Last reach page 1 and page 20; page 1 leaves the URL without a page parameter', async () => {
    const r = await mount('?page=8');
    await click(r.get('page-last'));
    for (let i = 0; i < 3; i += 1) await flush();
    expect(window.location.search).toBe('?page=20');
    expect(r.get('page-20').getAttribute('aria-current')).toBe('page');
    expect((r.get('page-next') as HTMLButtonElement).disabled).toBe(true);
    await click(r.get('page-first'));
    for (let i = 0; i < 3; i += 1) await flush();
    expect(window.location.search).toBe('');
    expect(r.get('page-1').getAttribute('aria-current')).toBe('page');
    expect((r.get('page-prev') as HTMLButtonElement).disabled).toBe(true);
    expect(pagesRequested()).toEqual(['8', '20', '1']);
  });

  it('a filter change sends the list to page 1 and replaces the URL entry', async () => {
    const r = await mount('?page=8');
    const entries = window.history.length;
    const search = r.container.querySelector('input[placeholder^="Search by name"]');
    await type(search, 'Item');
    await settle(450); // the search is debounced
    for (let i = 0; i < 3; i += 1) await flush();
    const last = requests[requests.length - 1];
    expect(last.get('page')).toBe('1');
    expect(last.get('search')).toBe('Item');
    expect(window.location.search).toBe('');
    expect(window.history.length).toBe(entries);
    expect(r.get('page-1').getAttribute('aria-current')).toBe('page');
  });

  it('an out-of-range page is clamped to the last real page after the fetch, replacing the URL', async () => {
    const r = await mount('?page=50');
    for (let i = 0; i < 3; i += 1) await flush();
    expect(pagesRequested()).toEqual(['50', '20']);
    expect(window.location.search).toBe('?page=20');
    expect(r.get('page-20').getAttribute('aria-current')).toBe('page');
    expect(r.container.textContent).toContain('Item 20-1');
  });

  /**
   * ONLY A CANONICAL PAGE REACHES THE SERVER. Everything else is page 1 with
   * the parameter removed, through the same replace path a reset uses — the
   * server never sees a fraction, an exponent, a sign, a leading zero,
   * whitespace, hexadecimal, text, or a number no catalogue could have.
   */
  it.each([
    ['2.7', 'a fraction'],
    ['1e3', 'an exponent'],
    ['99999999999999999999', 'an integer beyond the ceiling'],
    ['100001', 'one page above the ceiling'],
    ['0002', 'a leading zero'],
    ['+2', 'a sign'],
    ['%202', 'leading whitespace'],
    ['2%20', 'trailing whitespace'],
    ['0x10', 'hexadecimal'],
    ['0', 'zero'],
    ['-1', 'a negative'],
    ['abc', 'text'],
  ])('page=%s (%s) asks for page 1 and clears the parameter', async (raw) => {
    const r = await mount(`?page=${raw}`);
    expect(pagesRequested()).toEqual(['1']);
    expect(window.location.search).toBe('');
    expect(r.get('page-1').getAttribute('aria-current')).toBe('page');
  });

  it('page=100000, the ceiling itself, is asked for and then clamped like any page beyond the last', async () => {
    const r = await mount('?page=100000');
    for (let i = 0; i < 3; i += 1) await flush();
    expect(pagesRequested()).toEqual(['100000', '20']);
    expect(window.location.search).toBe('?page=20');
    expect(r.get('page-20').getAttribute('aria-current')).toBe('page');
  });

  it('a normal in-range page is asked for on the first request and kept in the address', async () => {
    const r = await mount('?page=7');
    expect(pagesRequested()).toEqual(['7']);
    expect(window.location.search).toBe('?page=7');
    expect(r.get('page-7').getAttribute('aria-current')).toBe('page');
  });

  describe('overlapping requests: the latest one owns the screen', () => {
    const settleAll = async () => {
      for (let i = 0; i < 4; i += 1) await flush();
    };
    /** A second navigation while the first is pending, the way Back/Forward deliver one. */
    const navigateFromAddress = async (pageNumber: number) => {
      window.history.replaceState({}, '', `/dashboard/products?page=${pageNumber}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
      await settleAll();
    };

    it('a slow OLDER success arriving after a newer one changes nothing', async () => {
      deferred = true;
      const r = await mount('?page=8');
      parked[0].resolve(answerFor(parked[0].params));
      await settleAll();
      await click(r.get('page-9'));
      await settleAll();
      await navigateFromAddress(10);
      const [nine, ten] = parked.slice(1);
      expect([nine.params.get('page'), ten.params.get('page')]).toEqual(['9', '10']);
      ten.resolve(answerFor(ten.params));
      await settleAll();
      expect(r.container.textContent).toContain('Item 10-1');
      expect(r.find('list-reloading')).toBeNull();
      nine.resolve(answerFor(nine.params));
      await settleAll();
      expect(r.container.textContent).toContain('Item 10-1');
      expect(r.container.textContent).not.toContain('Item 9-1');
      expect(r.get('page-10').getAttribute('aria-current')).toBe('page');
      expect(r.get('pagination-summary').textContent).toBe('Page 10 of 20 · 480 items');
    });

    it('a stale request that REJECTS shows no error and leaves the current load running', async () => {
      deferred = true;
      const r = await mount('?page=8');
      parked[0].resolve(answerFor(parked[0].params));
      await settleAll();
      await click(r.get('page-9'));
      await settleAll();
      await navigateFromAddress(10);
      const [nine, ten] = parked.slice(1);
      nine.reject(new Error('gateway timeout'));
      await settleAll();
      expect(r.container.textContent).not.toContain('gateway timeout');
      expect(r.find('list-reloading'), 'still loading the latest request').not.toBeNull();
      ten.resolve(answerFor(ten.params));
      await settleAll();
      expect(r.container.textContent).toContain('Item 10-1');
      expect(r.container.textContent).not.toContain('gateway timeout');
      expect(r.find('list-reloading')).toBeNull();
    });

    it('a stale answer with a SMALLER page count cannot clamp the list that was reset to page 1', async () => {
      deferred = true;
      const r = await mount('?page=11');
      parked[0].resolve(answerFor(parked[0].params));
      await settleAll();
      const search = r.container.querySelector('input[placeholder^="Search by name"]');
      await type(search, 'few');
      await settle(450);
      await settleAll();
      const withFew = parked.filter((p) => p.params.get('search') === 'few');
      expect(withFew.map((p) => p.params.get('page'))).toEqual(['11', '1']);
      const [stale, latest] = withFew;
      latest.resolve(answerFor(latest.params, 30));
      await settleAll();
      stale.resolve(answerFor(stale.params, 30)); // would clamp 11 → 2 if honoured
      await settleAll();
      expect(r.get('page-1').getAttribute('aria-current')).toBe('page');
      expect(r.get('pagination-summary').textContent).toBe('Page 1 of 2 · 30 items');
      expect(window.location.search).toBe('');
    });

    it('an answer that lands after the page is gone writes nothing', async () => {
      deferred = true;
      const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const r = await mount('?page=8');
        const late = parked[0];
        r.unmount();
        late.resolve(answerFor(late.params));
        await settleAll();
        expect(errors).not.toHaveBeenCalled();
        expect(unhandled).toEqual([]);
      } finally {
        errors.mockRestore();
      }
    });
  });

  /**
   * THE REQUESTED PAGE AND THE ANSWERED PAGE ARE TWO THINGS. While page 9 is
   * on its way from page 8 the rows on screen are page 8's, so the summary
   * and the current-page marker say 8; the status line is what names 9.
   * Only when page 9 is applied do rows, summary and marker move — together.
   * If page 9 never arrives, everything stays 8, including the request and
   * the address, and the reader is told why.
   */
  describe('the answered page is what the screen describes', () => {
    const settleAll = async () => {
      for (let i = 0; i < 4; i += 1) await flush();
    };
    /** Page 8 on screen, page 9 asked for by keyboard and still pending. */
    const pendingNineFromEight = async () => {
      deferred = true;
      const r = await mount('?page=8');
      parked[0].resolve(answerFor(parked[0].params));
      await settleAll();
      const nine = r.get('page-9') as HTMLButtonElement;
      nine.focus();
      await click(nine);
      await settleAll();
      return { r, nine, request: parked[parked.length - 1] };
    };

    it('while page 9 loads, the rows, the summary and the marker still say 8; the status line says 9', async () => {
      const { r, nine } = await pendingNineFromEight();
      expect(pagesRequested()).toEqual(['8', '9']);
      expect(window.location.search, 'the address may already name the navigation').toBe('?page=9');
      expect(r.find('pagination'), 'the controls stay mounted').not.toBeNull();
      expect(r.get('pagination-summary').textContent).toBe('Page 8 of 20 · 480 items');
      expect(r.get('page-8').getAttribute('aria-current')).toBe('page');
      expect(r.get('page-9').hasAttribute('aria-current')).toBe(false);
      expect(r.get('list-reloading').getAttribute('role')).toBe('status');
      expect(r.get('list-reloading').textContent).toBe('Loading page 9 of 20…');
      expect(r.get('list-body').getAttribute('aria-busy')).toBe('true');
      expect(r.container.textContent).toContain('Item 8-1');
      expect(r.container.textContent).not.toContain('Item 9-1');
      expect(document.activeElement, 'focus stays on the activated control').toBe(nine);
      expect(r.get('page-9'), 'the same control, not a remounted one').toBe(nine);
    });

    it('when page 9 arrives, rows, totals, summary and marker switch together', async () => {
      const { r, nine, request } = await pendingNineFromEight();
      request.resolve(answerFor(request.params));
      await settleAll();
      expect(r.container.textContent).toContain('Item 9-1');
      expect(r.container.textContent).not.toContain('Item 8-1');
      expect(r.get('pagination-summary').textContent).toBe('Page 9 of 20 · 480 items');
      expect(r.get('page-9').getAttribute('aria-current')).toBe('page');
      expect(r.get('list-body').hasAttribute('aria-busy')).toBe(false);
      expect(r.find('list-reloading')).toBeNull();
      expect(r.find('list-error')).toBeNull();
      expect(document.activeElement).toBe(nine);
      expect(window.location.search).toBe('?page=9');
    });

    it('when page 9 fails, the screen stays on page 8 — rows, request, address, summary, marker — with the error shown', async () => {
      const { r, request } = await pendingNineFromEight();
      const entries = window.history.length;
      request.reject(new Error('gateway timeout'));
      await settleAll();
      expect(r.container.textContent).toContain('Item 8-1');
      expect(window.location.search, 'the address is put back to the page on screen').toBe('?page=8');
      expect(window.history.length, 'replaced, not pushed').toBe(entries);
      expect(r.get('pagination-summary').textContent).toBe('Page 8 of 20 · 480 items');
      expect(r.get('page-8').getAttribute('aria-current')).toBe('page');
      expect(r.get('page-9').hasAttribute('aria-current')).toBe(false);
      expect(r.get('list-error').textContent).toContain('gateway timeout');
      expect(r.get('list-error').getAttribute('role')).toBe('alert');
      expect(r.find('list-reloading'), 'nothing is loading any more').toBeNull();
      expect(r.get('list-body').hasAttribute('aria-busy')).toBe(false);
      expect(pagesRequested(), 'rolling back does not fetch page 8 again').toEqual(['8', '9']);
      // The controls are usable: the next choice is a fresh request.
      await click(r.get('page-10'));
      await settleAll();
      expect(pagesRequested()).toEqual(['8', '9', '10']);
      expect(r.get('list-reloading').textContent).toBe('Loading page 10 of 20…');
      const ten = parked[parked.length - 1];
      ten.resolve(answerFor(ten.params));
      await settleAll();
      expect(r.container.textContent).toContain('Item 10-1');
      expect(r.get('pagination-summary').textContent).toBe('Page 10 of 20 · 480 items');
      expect(window.location.search).toBe('?page=10');
      expect(r.find('list-error'), 'a successful load clears the error').toBeNull();
    });

    it('a failed request can be asked for again: page 9 after a failed page 9 is a new request', async () => {
      const { r, request } = await pendingNineFromEight();
      request.reject(new Error('gateway timeout'));
      await settleAll();
      await click(r.get('page-9'));
      await settleAll();
      expect(pagesRequested()).toEqual(['8', '9', '9']);
      expect(window.location.search).toBe('?page=9');
      expect(r.find('list-error'), 'a new request clears the old error').toBeNull();
    });

    it('a STALE failure cannot roll back a NEWER success', async () => {
      const { r } = await pendingNineFromEight();
      // Back/Forward deliver page 10 while page 9 is still pending.
      window.history.replaceState({}, '', '/dashboard/products?page=10');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await settleAll();
      const [nine, ten] = parked.slice(1);
      expect([nine.params.get('page'), ten.params.get('page')]).toEqual(['9', '10']);
      ten.resolve(answerFor(ten.params));
      await settleAll();
      nine.reject(new Error('gateway timeout'));
      await settleAll();
      expect(r.container.textContent).toContain('Item 10-1');
      expect(r.get('pagination-summary').textContent).toBe('Page 10 of 20 · 480 items');
      expect(r.get('page-10').getAttribute('aria-current')).toBe('page');
      expect(window.location.search).toBe('?page=10');
      expect(r.find('list-error')).toBeNull();
      expect(pagesRequested()).toEqual(['8', '9', '10']);
    });

    it('an out-of-range answer is never painted: the clamped page is requested, and only its answer labels the screen', async () => {
      deferred = true;
      const r = await mount('?page=50');
      parked[0].resolve(answerFor(parked[0].params)); // 0 rows: page 50 of 20
      await settleAll();
      // The empty answer moved the intent and the address, and NOTHING else.
      expect(pagesRequested()).toEqual(['50', '20']);
      expect(window.location.search).toBe('?page=20');
      expect(r.find('pagination'), 'no page has been answered yet').toBeNull();
      expect(r.container.textContent).not.toContain('Page 20 of 20');
      expect(r.container.textContent, 'still the honest first-load state').toContain('Fetching product directory...');
      // Only page 20's own answer moves rows, totals, summary and marker.
      parked[1].resolve(answerFor(parked[1].params));
      await settleAll();
      expect(r.get('pagination-summary').textContent).toBe('Page 20 of 20 · 480 items');
      expect(r.get('page-20').getAttribute('aria-current')).toBe('page');
      expect(r.container.textContent).toContain('Item 20-1');
      expect(r.find('list-error')).toBeNull();
      expect(pagesRequested()).toEqual(['50', '20']);
    });

    it('before the first answer there is no answered page: no controls, no page label', async () => {
      deferred = true;
      const r = await mount('?page=8');
      expect(r.find('pagination')).toBeNull();
      expect(r.container.textContent).not.toContain('Page 8');
      expect(r.container.textContent).toContain('Fetching product directory...');
      parked[0].resolve(answerFor(parked[0].params));
      await settleAll();
      expect(r.get('pagination-summary').textContent).toBe('Page 8 of 20 · 480 items');
    });

    it('a failed first load has no page to fall back to: the requested page stands, with the error', async () => {
      deferred = true;
      const r = await mount('?page=8');
      parked[0].reject(new Error('gateway timeout'));
      await settleAll();
      expect(window.location.search).toBe('?page=8');
      expect(r.find('pagination')).toBeNull();
      expect(r.get('list-error').textContent).toContain('gateway timeout');
      expect(pagesRequested()).toEqual(['8']);
    });

    it('a filter change leaves the old rows unlabelled until the new scope answers', async () => {
      deferred = true;
      const r = await mount('?page=8');
      parked[0].resolve(answerFor(parked[0].params));
      await settleAll();
      const search = r.container.querySelector('input[placeholder^="Search by name"]');
      await type(search, 'few');
      await settle(450);
      await settleAll();
      // Pending: the old rows are still there, dimmed; nothing calls them a
      // page of the new filter, and the status line names only the page.
      expect(r.container.textContent).toContain('Item 8-1');
      expect(r.get('list-body').getAttribute('aria-busy')).toBe('true');
      expect(r.find('pagination'), 'no answered page for this scope yet').toBeNull();
      expect(r.container.textContent).not.toContain('Page 1 of 20');
      expect(r.get('list-reloading').textContent).toBe('Loading page 1…');
      expect(window.location.search).toBe('');
      const latest = parked[parked.length - 1];
      expect(latest.params.get('search')).toBe('few');
      expect(latest.params.get('page')).toBe('1');
      latest.resolve(answerFor(latest.params, 30));
      await settleAll();
      expect(r.container.textContent).toContain('Item 1-1');
      expect(r.get('pagination-summary').textContent).toBe('Page 1 of 2 · 30 items');
      expect(r.get('page-1').getAttribute('aria-current')).toBe('page');
    });

    it('a failed first load of a new scope keeps the old rows unlabelled, on the requested page 1', async () => {
      deferred = true;
      const r = await mount('?page=8');
      parked[0].resolve(answerFor(parked[0].params));
      await settleAll();
      const search = r.container.querySelector('input[placeholder^="Search by name"]');
      await type(search, 'few');
      await settle(450);
      await settleAll();
      const latest = parked[parked.length - 1];
      latest.reject(new Error('gateway timeout'));
      await settleAll();
      expect(r.find('pagination')).toBeNull();
      expect(window.location.search, 'nothing to go back to: page 1 stands').toBe('');
      expect(r.get('list-error').textContent).toContain('gateway timeout');
      expect(r.container.textContent).toContain('Item 8-1');
    });

    it('has a Spanish entry for the loading lines', async () => {
      const { ES } = await import('../../../lib/translations.es');
      for (const key of ['Loading page {page} of {totalPages}…', 'Loading page {page}…']) {
        expect(ES[key], `missing Spanish for "${key}"`).toBeTruthy();
        expect(ES[key]).not.toBe(key);
      }
    });
  });

  /**
   * NEWER INTENT BEATS AN OLDER ANSWER.
   *
   * A request is started by an effect, one commit after the reader chose the
   * page. In that gap the OLD request is still the last one that started, so
   * a ticket alone cannot tell that the reader has moved on. It used to roll
   * them back to the page they had left and ask the server for it again. The
   * page the reader wants is now tracked as it is chosen, not as it renders,
   * so an older answer that lands in the gap is simply obsolete.
   */
  describe('the page the reader is waiting for', () => {
    const settleAll = async () => {
      for (let i = 0; i < 4; i += 1) await flush();
    };
    const pendingNineFromEight = async () => {
      deferred = true;
      const r = await mount('?page=8');
      parked[0].resolve(answerFor(parked[0].params));
      await settleAll();
      await click(r.get('page-9'));
      await settleAll();
      return { r, request: parked[parked.length - 1] };
    };
    const typeSearch = async (r: any, value: string) => {
      await type(r.container.querySelector('input[placeholder^="Search by name"]'), value);
      await settle(450);
      await settleAll();
    };
    /**
     * Every request as "page|search|status". A filter change fires one
     * request for the page the reader was on before the reset to page 1
     * reaches the next render; that request carries the NEW scope, which is
     * what tells it apart from a rollback re-fetching the old page. It is
     * discarded on arrival and predates this work.
     */
    const requestSignatures = () =>
      requests.map((p) => `${p.get('page')}|${p.get('search') ?? ''}|${p.get('status') ?? ''}`);
    const openFilters = async (r: any) => {
      const toggle = Array.from(r.container.querySelectorAll('button')).find((b: any) =>
        (b.textContent || '').includes('Filters'),
      );
      expect(toggle, 'the filter panel has a toggle').toBeTruthy();
      await click(toggle as any);
      await settleAll();
    };

    it('a page-9 failure that lands AFTER page 10 was chosen changes nothing, and page 10 arrives', async () => {
      const { r, request } = await pendingNineFromEight();
      // The failure and the next choice land in the same turn: page 10 has
      // been chosen, but its request has not started yet.
      request.reject(new Error('gateway timeout'));
      await click(r.get('page-10'));
      await settleAll();
      // Page 8 is NOT asked for again and no page-9 error reaches the screen.
      expect(pagesRequested()).toEqual(['8', '9', '10']);
      expect(r.find('list-error'), 'the abandoned page 9 says nothing').toBeNull();
      expect(r.container.textContent, 'page 8 is still displayed while 10 loads').toContain('Item 8-1');
      expect(r.get('pagination-summary').textContent).toBe('Page 8 of 20 · 480 items');
      expect(r.get('list-body').getAttribute('aria-busy')).toBe('true');
      const ten = parked[parked.length - 1];
      expect(ten.params.get('page')).toBe('10');
      ten.resolve(answerFor(ten.params));
      await settleAll();
      expect(pagesRequested(), 'no extra page-8 request, ever').toEqual(['8', '9', '10']);
      expect(window.location.search).toBe('?page=10');
      expect(r.get('pagination-summary').textContent).toBe('Page 10 of 20 · 480 items');
      expect(r.get('page-10').getAttribute('aria-current')).toBe('page');
      expect(r.container.textContent).toContain('Item 10-1');
      expect(r.container.textContent).not.toContain('Item 8-1');
      expect(r.find('list-error')).toBeNull();
      expect(r.find('list-reloading')).toBeNull();
      expect(r.get('list-body').hasAttribute('aria-busy')).toBe(false);
    });

    it('a page-9 failure that lands after a SEARCH was typed neither rolls back nor re-asks for page 8', async () => {
      const { r, request } = await pendingNineFromEight();
      request.reject(new Error('gateway timeout'));
      await typeSearch(r, 'few');
      // No request repeats page 8 in the OLD scope: the rollback asked for
      // nothing, and the only page-8 request carries the new search.
      expect(requestSignatures()).toEqual(['8||', '9||', '8|few|', '1|few|']);
      const latest = parked[parked.length - 1];
      expect(latest.params.get('search')).toBe('few');
      expect(r.find('pagination'), 'no answered page for the new scope').toBeNull();
      latest.resolve(answerFor(latest.params, 30));
      await settleAll();
      expect(requestSignatures()).toEqual(['8||', '9||', '8|few|', '1|few|']);
      expect(r.get('pagination-summary').textContent).toBe('Page 1 of 2 · 30 items');
      expect(r.get('page-1').getAttribute('aria-current')).toBe('page');
      expect(window.location.search).toBe('');
      expect(r.find('list-error')).toBeNull();
    });

    it('a page-9 failure that lands after a FILTER was changed neither rolls back nor re-asks for page 8', async () => {
      const { r, request } = await pendingNineFromEight();
      request.reject(new Error('gateway timeout'));
      await openFilters(r);
      const status = Array.from(r.container.querySelectorAll('select')).find((s: any) =>
        Array.from(s.options).some((o: any) => o.value === 'DRAFT'),
      );
      expect(status, 'the status filter is on screen').toBeTruthy();
      await select(status as any, 'DRAFT');
      await settleAll();
      // Again: no page-8 request in the old scope, so nothing rolled back.
      expect(requestSignatures()).toEqual(['8||', '9||', '8||DRAFT', '1||DRAFT']);
      const latest = parked[parked.length - 1];
      expect(latest.params.get('status')).toBe('DRAFT');
      expect(latest.params.get('page')).toBe('1');
      expect(r.find('pagination'), 'no answered page for the new scope').toBeNull();
      expect(r.container.textContent, 'the old rows stay, unlabelled').toContain('Item 8-1');
      latest.resolve(answerFor(latest.params, 30));
      await settleAll();
      expect(r.get('pagination-summary').textContent).toBe('Page 1 of 2 · 30 items');
      expect(window.location.search).toBe('');
      expect(r.find('list-error')).toBeNull();
    });

    it('a rollback is followed immediately by a new navigation, which is never suppressed', async () => {
      const { r, request } = await pendingNineFromEight();
      request.reject(new Error('gateway timeout'));
      await settleAll();
      // Rolled back and settled: page 8, no refetch, error on screen.
      expect(pagesRequested()).toEqual(['8', '9']);
      expect(window.location.search).toBe('?page=8');
      expect(r.get('list-error').textContent).toContain('gateway timeout');
      expect(r.find('list-reloading'), 'nothing is loading').toBeNull();
      expect(r.get('list-body').hasAttribute('aria-busy')).toBe(false);
      // The very next choice fetches.
      await click(r.get('page-10'));
      await settleAll();
      expect(pagesRequested()).toEqual(['8', '9', '10']);
      expect(r.get('list-reloading').textContent).toBe('Loading page 10 of 20…');
      const ten = parked[parked.length - 1];
      ten.resolve(answerFor(ten.params));
      await settleAll();
      expect(r.get('pagination-summary').textContent).toBe('Page 10 of 20 · 480 items');
      expect(r.find('list-error'), 'a genuine request clears the error').toBeNull();
      expect(window.location.search).toBe('?page=10');
    });

    it('two failures in rapid succession each roll back once, and never re-ask for the displayed page', async () => {
      const { r, request } = await pendingNineFromEight();
      request.reject(new Error('first timeout'));
      await settleAll();
      await click(r.get('page-10'));
      await settleAll();
      parked[parked.length - 1].reject(new Error('second timeout'));
      await settleAll();
      expect(pagesRequested(), 'two attempts, no rollback fetches').toEqual(['8', '9', '10']);
      expect(window.location.search).toBe('?page=8');
      expect(r.get('pagination-summary').textContent).toBe('Page 8 of 20 · 480 items');
      expect(r.get('page-8').getAttribute('aria-current')).toBe('page');
      expect(r.container.textContent).toContain('Item 8-1');
      expect(r.get('list-error').textContent).toContain('second timeout');
      expect(r.find('list-reloading')).toBeNull();
      // Still navigable after both.
      await click(r.get('page-6'));
      await settleAll();
      expect(pagesRequested()).toEqual(['8', '9', '10', '6']);
    });

    it('a stale failure changes nothing, and Back still moves the list', async () => {
      const { r, request } = await pendingNineFromEight();
      await click(r.get('page-10'));
      await settleAll();
      const ten = parked[parked.length - 1];
      ten.resolve(answerFor(ten.params));
      await settleAll();
      expect(r.get('pagination-summary').textContent).toBe('Page 10 of 20 · 480 items');
      // The abandoned page-9 request fails long after page 10 was painted.
      request.reject(new Error('very late timeout'));
      await settleAll();
      expect(r.get('pagination-summary').textContent).toBe('Page 10 of 20 · 480 items');
      expect(window.location.search).toBe('?page=10');
      expect(r.find('list-error')).toBeNull();
      expect(pagesRequested()).toEqual(['8', '9', '10']);
      // Back to page 9 still asks for page 9.
      window.history.replaceState({}, '', '/dashboard/products?page=9');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await settleAll();
      expect(pagesRequested()).toEqual(['8', '9', '10', '9']);
      const nine = parked[parked.length - 1];
      nine.resolve(answerFor(nine.params));
      await settleAll();
      expect(r.get('pagination-summary').textContent).toBe('Page 9 of 20 · 480 items');
    });

    it('Back onto the page already displayed asks for nothing and leaves nothing loading', async () => {
      const { r, request } = await pendingNineFromEight();
      // While page 9 is in flight the reader goes Back to page 8, which is
      // what the screen already shows.
      window.history.replaceState({}, '', '/dashboard/products?page=8');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await settleAll();
      expect(pagesRequested(), 'the displayed page is not re-fetched').toEqual(['8', '9']);
      expect(r.find('list-reloading'), 'and nothing is left loading').toBeNull();
      expect(r.get('list-body').hasAttribute('aria-busy')).toBe(false);
      expect(r.get('pagination-summary').textContent).toBe('Page 8 of 20 · 480 items');
      // The abandoned request cannot write when it finally fails.
      request.reject(new Error('abandoned'));
      await settleAll();
      expect(r.find('list-error')).toBeNull();
      expect(window.location.search).toBe('?page=8');
    });

    it('a clamped request that fails falls back to the page still displayed', async () => {
      deferred = true;
      const r = await mount('?page=8');
      parked[0].resolve(answerFor(parked[0].params));
      await settleAll();
      // A stale link, opened from the address: page 50 of 20.
      window.history.replaceState({}, '', '/dashboard/products?page=50');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await settleAll();
      parked[parked.length - 1].resolve(answerFor(parked[parked.length - 1].params));
      await settleAll();
      expect(pagesRequested()).toEqual(['8', '50', '20']);
      expect(window.location.search).toBe('?page=20');
      // The out-of-range answer painted nothing: page 8 is still the screen.
      expect(r.get('pagination-summary').textContent).toBe('Page 8 of 20 · 480 items');
      expect(r.container.textContent).toContain('Item 8-1');
      parked[parked.length - 1].reject(new Error('gateway timeout'));
      await settleAll();
      expect(window.location.search, 'back to the page on screen').toBe('?page=8');
      expect(r.get('pagination-summary').textContent).toBe('Page 8 of 20 · 480 items');
      expect(r.get('page-8').getAttribute('aria-current')).toBe('page');
      expect(r.container.textContent).toContain('Item 8-1');
      expect(r.get('list-error').textContent).toContain('gateway timeout');
      expect(pagesRequested(), 'the rollback asks for nothing').toEqual(['8', '50', '20']);
      expect(r.find('list-reloading')).toBeNull();
    });

    it('a clamped request that fails with nothing answered yet shows the honest empty failure', async () => {
      deferred = true;
      const r = await mount('?page=50');
      parked[0].resolve(answerFor(parked[0].params));
      await settleAll();
      parked[1].reject(new Error('gateway timeout'));
      await settleAll();
      expect(pagesRequested()).toEqual(['50', '20']);
      expect(r.find('pagination'), 'nothing was ever answered').toBeNull();
      expect(r.container.textContent).not.toContain('Page 20 of 20');
      expect(r.container.querySelectorAll('tbody tr')).toHaveLength(0);
      expect(r.get('list-error').textContent).toContain('gateway timeout');
      expect(r.find('list-reloading')).toBeNull();
      expect(window.location.search).toBe('?page=20');
    });

    it('a stale out-of-range answer cannot clamp a newer choice', async () => {
      deferred = true;
      const r = await mount('?page=8');
      parked[0].resolve(answerFor(parked[0].params));
      await settleAll();
      window.history.replaceState({}, '', '/dashboard/products?page=50');
      window.dispatchEvent(new PopStateEvent('popstate'));
      await settleAll();
      const outOfRange = parked[parked.length - 1];
      // The reader moves on before that answer lands.
      await click(r.get('page-6'));
      await settleAll();
      outOfRange.resolve(answerFor(outOfRange.params));
      await settleAll();
      expect(window.location.search, 'the stale clamp did not touch the address').toBe('?page=6');
      expect(pagesRequested()).toEqual(['8', '50', '6']);
      const six = parked[parked.length - 1];
      six.resolve(answerFor(six.params));
      await settleAll();
      expect(r.get('pagination-summary').textContent).toBe('Page 6 of 20 · 480 items');
      expect(r.get('page-6').getAttribute('aria-current')).toBe('page');
      expect(window.location.search).toBe('?page=6');
    });

    it('under Strict Mode a rollback still suppresses nothing that follows it', async () => {
      deferred = true;
      window.history.replaceState({}, '', '/dashboard/products?page=8');
      const r = await renderComponent(
        <React.StrictMode>
          <I18nProvider>
            <ProductsPage />
          </I18nProvider>
        </React.StrictMode>,
      );
      for (let i = 0; i < 4; i += 1) await flush();
      for (const p of parked) p.resolve(answerFor(p.params));
      await settleAll();
      expect(r.get('pagination-summary').textContent).toBe('Page 8 of 20 · 480 items');
      const beforeClick = requests.length;
      await click(r.get('page-9'));
      await settleAll();
      expect(requests.length, 'one request for the navigation').toBe(beforeClick + 1);
      parked[parked.length - 1].reject(new Error('gateway timeout'));
      await settleAll();
      expect(requests.length, 'the rollback asks for nothing').toBe(beforeClick + 1);
      expect(window.location.search).toBe('?page=8');
      expect(r.get('list-error').textContent).toContain('gateway timeout');
      await click(r.get('page-10'));
      await settleAll();
      expect(requests.length, 'the next navigation is not suppressed').toBe(beforeClick + 2);
      expect(requests[requests.length - 1].get('page')).toBe('10');
    });

    /**
     * WHOSE ERROR IS IT? An error belongs to the scope whose request failed.
     * Returning to a scope whose page is still on screen needs no request, and
     * only a request clears the error, so the banner from an abandoned search
     * would sit over the list the reader came back to. Changing the scope
     * drops it. A failed page change inside ONE scope is the opposite case:
     * its banner is the reason the reader is still on the old page, and
     * nothing in the rollback may take it away.
     */
    it('clearing a failed search brings the old list back without its error, and without a request', async () => {
      deferred = true;
      const r = await mount('');
      parked[0].resolve(answerFor(parked[0].params));
      await settleAll();
      expect(r.get('pagination-summary').textContent).toBe('Page 1 of 20 · 480 items');
      // A search whose request fails.
      await typeSearch(r, 'few');
      const failed = parked[parked.length - 1];
      expect(failed.params.get('search')).toBe('few');
      failed.reject(new Error('gateway timeout'));
      await settleAll();
      expect(r.get('list-error').textContent).toContain('gateway timeout');
      expect(r.find('pagination'), 'nothing was answered for the search').toBeNull();
      expect(r.container.textContent, 'the old rows are still there, unlabelled').toContain('Item 1-1');
      // Clearing it returns to a scope whose page 1 is already on screen.
      const before = requests.length;
      await typeSearch(r, '');
      expect(requests.length, 'the answer already on screen is reused').toBe(before);
      expect(r.find('list-error'), 'the search error went with the search').toBeNull();
      expect(r.get('pagination-summary').textContent).toBe('Page 1 of 20 · 480 items');
      expect(r.get('page-1').getAttribute('aria-current')).toBe('page');
      expect(r.container.textContent).toContain('Item 1-1');
      expect(r.find('list-reloading'), 'nothing is loading').toBeNull();
      expect(r.get('list-body').hasAttribute('aria-busy')).toBe(false);
      expect(window.location.search).toBe('');
    });

    it('a failed page change keeps its error: the scope never changed', async () => {
      const { r, request } = await pendingNineFromEight();
      request.reject(new Error('gateway timeout'));
      await settleAll();
      // The rollback puts the intent back on page 8, which runs the effect
      // that finds page 8 already displayed. That run must not take the
      // banner with it: it is why the reader is still on page 8.
      expect(r.get('list-error').textContent).toContain('gateway timeout');
      expect(r.get('pagination-summary').textContent).toBe('Page 8 of 20 · 480 items');
      expect(pagesRequested()).toEqual(['8', '9']);
      await settleAll();
      expect(r.get('list-error').textContent, 'still there after further renders').toContain('gateway timeout');
      // And a scope change is what finally clears it.
      await typeSearch(r, 'few');
      expect(r.find('list-error')).toBeNull();
    });

    it('unmounting after a rollback leaves nothing behind for the next mount', async () => {
      const { r, request } = await pendingNineFromEight();
      request.reject(new Error('gateway timeout'));
      await settleAll();
      r.unmount();
      await settleAll();
      expect(unhandled).toEqual([]);
      requests = [];
      parked = [];
      deferred = false;
      const again = await mount('?page=5');
      expect(pagesRequested(), 'a fresh mount fetches normally').toEqual(['5']);
      expect(again.get('pagination-summary').textContent).toBe('Page 5 of 20 · 480 items');
      expect(again.find('list-error')).toBeNull();
    });
  });

  it('zero rows show the empty state and no pagination at all', async () => {
    totalRows = 0;
    const r = await mount('');
    expect(r.find('pagination')).toBeNull();
    expect(r.find('empty-catalogue')).not.toBeNull();
    expect(r.container.textContent).not.toContain('Page 1 of 0');
  });

  it('keeps a deep-linked filter AND the page, and carries the filter through every page change', async () => {
    const r = await mount('?status=DRAFT&page=3');
    for (let i = 0; i < 3; i += 1) await flush();
    // The deep link settling is not a filter change: page 3 survives it.
    const draftRequests = requests.filter((p) => p.get('status') === 'DRAFT');
    expect(draftRequests.length).toBeGreaterThan(0);
    expect(draftRequests[draftRequests.length - 1].get('page')).toBe('3');
    expect(pagesRequested()).not.toContain('1');
    expect(r.get('page-3').getAttribute('aria-current')).toBe('page');
    await click(r.get('page-4'));
    for (let i = 0; i < 3; i += 1) await flush();
    const last = requests[requests.length - 1];
    expect(last.get('status')).toBe('DRAFT');
    expect(last.get('page')).toBe('4');
    expect(window.location.search).toBe('?status=DRAFT&page=4');
  });

  it('a single page of results shows the summary and no page controls', async () => {
    totalRows = 12;
    const r = await mount('');
    expect(r.get('pagination-summary').textContent).toBe('Page 1 of 1 · 12 items');
    expect(r.find('pagination-controls')).toBeNull();
  });
});
