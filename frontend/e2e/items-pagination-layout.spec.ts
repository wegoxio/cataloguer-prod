import { test, expect, type Page } from '@playwright/test';

/**
 * ITEMS PAGINATION IN A REAL BROWSER, on stubbed data.
 *
 * No backend and no production data: every API call is answered in the page.
 * Twenty pages of twenty-five rows, walked at a desktop, a tablet and a phone
 * width. What only a browser can show: the numbered window and its gaps as
 * laid out, the URL and the browser's own Back button, native disabled edges,
 * touch-sized targets, and that nothing spills past the document's width.
 */

const ORIGIN = 'http://localhost:3000';
const ORG = 'org-1';
const STORE = 'store-a';
const LIMIT = 25;

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' },
  body: JSON.stringify(body),
});

/** Rows the stub owns for a given search: 480 by default, 30 for "few", none for "zzz". */
function rowsFor(search: string | null): number {
  if (search === 'zzz') return 0;
  if (search === 'few') return 30;
  return 480;
}

/**
 * `delayMs` holds a page number back for that long before it is answered, so
 * a test can look at the screen WHILE a request is pending — the state a
 * stubbed answer that arrives instantly never lets it see. `failPages` answers
 * those page numbers with a server error instead of rows, after any delay.
 */
async function stub(page: Page, opts: { delayMs?: Record<string, number>; failPages?: string[] } = {}) {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace('/api/v1', '');
    const q = url.searchParams;

    if (p === '/auth/refresh')
      return route.fulfill(json({ data: { accessToken: 'stub', user: { id: 'u1', email: 'a@b.c', name: 'Ana' } } }));
    if (p === '/auth/me')
      return route.fulfill(
        json({
          data: {
            user: { id: 'u1', email: 'a@b.c', name: 'Ana' },
            scope: { platform: false, role: 'ORGANIZATION_MANAGER', organizationId: ORG, storeId: null, allowedStoreIds: [STORE] },
          },
        }),
      );
    if (p === '/products') {
      const total = rowsFor(q.get('search'));
      const pageNumber = Number(q.get('page') ?? '1');
      const delay = opts.delayMs?.[String(pageNumber)] ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      if (opts.failPages?.includes(String(pageNumber)))
        return route.fulfill({ ...json({ message: 'stubbed failure' }), status: 500 });
      const totalPages = Math.ceil(total / LIMIT);
      const first = (pageNumber - 1) * LIMIT;
      const count = Math.max(0, Math.min(LIMIT, total - first));
      const items = Array.from({ length: count }, (_, i) => ({
        id: `p-${pageNumber}-${i + 1}`,
        name: `Item ${pageNumber}-${i + 1}`,
        slug: `item-${pageNumber}-${i + 1}`,
        status: 'PUBLISHED',
        price: 10,
        stockQuantity: 1,
        trackInventory: false,
      }));
      return route.fulfill(json({ items, total, page: pageNumber, limit: LIMIT, totalPages }));
    }
    if (p === '/stores') return route.fulfill(json({ items: [{ id: STORE, name: 'Centro' }], total: 1 }));
    if (p === '/categories') return route.fulfill(json({ items: [], total: 0 }));
    return route.fulfill(json({ data: null, items: [], total: 0 }));
  });
  await page.addInitScript(() => window.localStorage.setItem('cataloguer.session', '1'));
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, narrow: false },
  { name: 'tablet', width: 768, height: 1024, narrow: false },
  { name: 'phone', width: 390, height: 844, narrow: true },
];

/** The numbered window as rendered: page numbers and "…" for a gap. */
async function windowText(page: Page): Promise<string> {
  return page
    .locator('[data-testid="pagination-controls"] > li')
    .evaluateAll((items) =>
      items
        .map((li) => (li.getAttribute('data-testid') === 'page-gap' ? '…' : li.querySelector('[data-testid^="page-"]')?.textContent?.trim() ?? ''))
        .filter((text) => /^(…|\d+)$/.test(text))
        .join(' '),
    );
}

async function assertNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(overflow.scroll, `${label}: horizontal overflow`).toBeLessThanOrEqual(overflow.client + 1);
}

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('walks the pages by number, edge and browser history, keeping the search', async ({ page }) => {
      await stub(page);
      await page.goto('/dashboard/products');
      await page.waitForSelector('[data-testid="pagination"]', { timeout: 30_000 });

      const nav = page.locator('[data-testid="pagination"]');
      await expect(nav).toHaveAttribute('aria-label', 'Pagination');
      await expect(page.locator('[data-testid="pagination-summary"]')).toHaveText('Page 1 of 20 · 480 items');
      expect(await windowText(page)).toBe(vp.narrow ? '1 2 3 4 … 20' : '1 2 3 4 5 6 … 20');
      await expect(page.locator('[data-testid="page-first"]')).toBeDisabled();
      await expect(page.locator('[data-testid="page-prev"]')).toBeDisabled();
      await expect(page.locator('[data-testid="page-next"]')).toBeEnabled();
      await expect(page.locator('[data-testid="page-last"]')).toBeEnabled();
      // Gaps are punctuation, never a control.
      const gaps = page.locator('[data-testid="page-gap"]');
      expect(await gaps.count()).toBe(1);
      await expect(gaps.first()).toHaveAttribute('aria-hidden', 'true');
      expect(await gaps.first().locator('button').count()).toBe(0);
      await assertNoHorizontalOverflow(page, `${vp.name}/page 1`);

      // Straight to a number: the URL says so and the window re-centres.
      await page.locator('[data-testid="page-4"]').click();
      await expect(page).toHaveURL(/\?page=4$/);
      await expect(page.locator('[data-testid="page-4"]')).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('tbody')).toContainText('Item 4-1');
      await page.locator('[data-testid="page-last"]').click();
      await expect(page).toHaveURL(/\?page=20$/);
      await expect(page.locator('[data-testid="pagination-summary"]')).toHaveText('Page 20 of 20 · 480 items');
      // The window keeps its size at the edge: three inner pages on a phone,
      // five elsewhere, so page 20 still shows the pages before it.
      expect(await windowText(page)).toBe(vp.narrow ? '1 … 17 18 19 20' : '1 … 15 16 17 18 19 20');
      await expect(page.locator('[data-testid="page-next"]')).toBeDisabled();
      await expect(page.locator('[data-testid="page-last"]')).toBeDisabled();
      await expect(page.locator('[data-testid="page-first"]')).toBeEnabled();
      await assertNoHorizontalOverflow(page, `${vp.name}/page 20`);

      // The middle: first and last stay, the current page has its neighbours.
      await page.locator('[data-testid="page-prev"]').click();
      await page.locator('[data-testid="page-18"]').click();
      await page.locator('[data-testid="page-first"]').click();
      await expect(page).toHaveURL(/\/dashboard\/products$/);
      await page.goto('/dashboard/products?page=10');
      await page.waitForSelector('[data-testid="page-10"][aria-current="page"]', { timeout: 30_000 });
      expect(await windowText(page)).toBe(vp.narrow ? '1 … 9 10 11 … 20' : '1 … 8 9 10 11 12 … 20');
      expect(await page.locator('[data-testid="page-gap"]').count()).toBe(2);
      expect(await page.locator('[aria-current="page"]').count()).toBe(1);

      // The browser's own Back button returns to the previous page.
      await page.locator('[data-testid="page-11"]').click();
      await expect(page).toHaveURL(/\?page=11$/);
      await page.goBack();
      await expect(page).toHaveURL(/\?page=10$/);
      await expect(page.locator('[data-testid="page-10"]')).toHaveAttribute('aria-current', 'page');
      await expect(page.locator('tbody')).toContainText('Item 10-1');
      await page.goForward();
      await expect(page).toHaveURL(/\?page=11$/);
      await expect(page.locator('[data-testid="page-11"]')).toHaveAttribute('aria-current', 'page');

      // A search keeps applying while moving, and a NEW search resets to page 1.
      await page.getByPlaceholder(/Search by name/).fill('few');
      await expect(page).toHaveURL(/\/dashboard\/products$/);
      await expect(page.locator('[data-testid="pagination-summary"]')).toHaveText('Page 1 of 2 · 30 items');
      await page.locator('[data-testid="page-2"]').click();
      await expect(page).toHaveURL(/\?page=2$/);
      await expect(page.locator('tbody')).toContainText('Item 2-1');
      await expect(page.locator('[data-testid="pagination-summary"]')).toHaveText('Page 2 of 2 · 30 items');

      // No rows: the empty state speaks, and there is no "Page 1 of 0".
      await page.getByPlaceholder(/Search by name/).fill('zzz');
      await page.waitForSelector('[data-testid="empty-filtered"]', { timeout: 30_000 });
      expect(await page.locator('[data-testid="pagination"]').count()).toBe(0);
      await assertNoHorizontalOverflow(page, `${vp.name}/empty`);
    });

    test('an out-of-range page in the address is clamped to the last real page', async ({ page }) => {
      await stub(page);
      await page.goto('/dashboard/products?page=50');
      await page.waitForSelector('[data-testid="page-20"][aria-current="page"]', { timeout: 30_000 });
      await expect(page).toHaveURL(/\?page=20$/);
      await expect(page.locator('tbody')).toContainText('Item 20-1');
      await expect(page.locator('[data-testid="pagination-summary"]')).toHaveText('Page 20 of 20 · 480 items');
    });

    test('reading the page from the address before the first render causes no hydration error', async ({ page }) => {
      const errors: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'error') errors.push(message.text());
      });
      page.on('pageerror', (error) => errors.push(error.message));
      await stub(page);
      await page.goto('/dashboard/products?page=8');
      await page.waitForSelector('[data-testid="page-8"][aria-current="page"]', { timeout: 30_000 });
      const hydration = errors.filter((text) => /hydrat/i.test(text));
      expect(hydration, hydration.join('\n')).toEqual([]);
    });

    test('every control is a named button with a touch-sized, focusable target', async ({ page }) => {
      await stub(page);
      await page.goto('/dashboard/products?page=8');
      await page.waitForSelector('[data-testid="page-8"][aria-current="page"]', { timeout: 30_000 });
      const controls = await page.locator('[data-testid="pagination-controls"] button').evaluateAll((buttons) =>
        buttons.map((b) => {
          const r = b.getBoundingClientRect();
          return { name: b.getAttribute('aria-label'), w: r.width, h: r.height, disabled: (b as HTMLButtonElement).disabled };
        }),
      );
      expect(controls.length).toBeGreaterThanOrEqual(7);
      for (const c of controls) {
        expect(c.name, 'every control is named in words').toMatch(/page/i);
        expect(c.h, `${c.name} tall enough to tap`).toBeGreaterThanOrEqual(36);
        expect(c.w, `${c.name} wide enough to tap`).toBeGreaterThanOrEqual(36);
      }
      // Keyboard: Tab lands on the first enabled control and a visible focus ring appears.
      await page.locator('[data-testid="page-first"]').focus();
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        return { testid: el?.getAttribute('data-testid'), ring: el ? getComputedStyle(el).boxShadow : '' };
      });
      expect(focused.testid).toMatch(/^page-/);
      expect(focused.ring).not.toBe('none');
      await assertNoHorizontalOverflow(page, `${vp.name}/controls`);
      await page.screenshot({ path: `test-results/prb-screenshots/pagination-${vp.name}.png`, fullPage: true });
    });
  });
}

/**
 * WHAT HAPPENS WHILE A PAGE IS STILL LOADING, AND WHEN IT NEVER ARRIVES. The
 * page-9 answer is held back for a second, long enough to look. The controls
 * must stay mounted, the reader's focus must stay on the control they
 * activated, the rows already on screen must stay, dimmed and marked busy,
 * and everything that DESCRIBES those rows — the summary, the current-page
 * marker — must keep saying page 8 while the status line names page 9. Then
 * either page 9 arrives and rows, summary and marker move together, or it
 * fails and the screen stays on page 8, address included, with the error
 * shown and the controls still working.
 * Against a page that unmounted its list during every fetch this failed at
 * the first look: the navigation was gone and focus had fallen to the body.
 * Against a page with one page state for both, the pending summary and
 * marker already said 9 over page 8's rows, and a failure left them there.
 */
test.describe('keyboard focus while a page loads (1440px)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /** Page 8 on screen; page 9 activated by keyboard and still pending. */
  async function pendingNineFromEight(page: Page, opts: { failPages?: string[] } = {}) {
    await stub(page, { delayMs: { '9': 1000 }, ...opts });
    await page.goto('/dashboard/products?page=8');
    await page.waitForSelector('[data-testid="page-8"][aria-current="page"]', { timeout: 30_000 });
    const entries = await page.evaluate(() => window.history.length);

    await page.locator('[data-testid="page-9"]').focus();
    await page.keyboard.press('Enter');

    // Pending: the request is out, the answer is not back.
    await expect(page.locator('[data-testid="list-reloading"]')).toBeVisible();
    const pending = await page.evaluate(() => ({
      navigation: !!document.querySelector('[data-testid="pagination"]'),
      focused: document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null,
      busy: document.querySelector('[data-testid="list-body"]')?.getAttribute('aria-busy'),
      summary: document.querySelector('[data-testid="pagination-summary"]')?.textContent,
      current: document.querySelector('[aria-current="page"]')?.textContent,
      status: document.querySelector('[data-testid="list-reloading"]')?.textContent,
      firstRow: document.querySelector('tbody tr')?.textContent ?? '',
    }));
    expect(pending.navigation, 'pagination stays mounted while the page loads').toBe(true);
    expect(pending.focused, 'focus stays on the activated control while the page loads').toBe('page-9');
    expect(pending.busy, 'the rows still on screen are marked busy').toBe('true');
    expect(pending.summary, 'the summary describes the rows on screen').toBe('Page 8 of 20 · 480 items');
    expect(pending.current, 'the marker describes the rows on screen').toBe('8');
    expect(pending.status, 'the status line names the page on its way').toBe('Loading page 9 of 20…');
    expect(pending.firstRow, 'the previous rows stay on screen, dimmed, rather than collapsing').toContain('Item 8-1');
    await expect(page).toHaveURL(/\?page=9$/);
    return { entries };
  }

  test('activating a page number with Enter keeps focus on the control through the delayed load', async ({ page }) => {
    await pendingNineFromEight(page);

    // Done: the new rows, the new summary and marker, and focus where it was.
    await expect(page.locator('tbody')).toContainText('Item 9-1', { timeout: 15_000 });
    await expect(page.locator('[data-testid="list-reloading"]')).toHaveCount(0);
    const done = await page.evaluate(() => ({
      focused: document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? null,
      current: document.querySelector('[aria-current="page"]')?.textContent,
      busy: document.querySelector('[data-testid="list-body"]')?.getAttribute('aria-busy'),
      summary: document.querySelector('[data-testid="pagination-summary"]')?.textContent,
      error: !!document.querySelector('[data-testid="list-error"]'),
    }));
    expect(done.focused, 'focus is still on the control after the page loaded').toBe('page-9');
    expect(done.current).toBe('9');
    expect(done.busy).toBeNull();
    expect(done.summary).toBe('Page 9 of 20 · 480 items');
    expect(done.error).toBe(false);
    await expect(page.locator('tbody')).not.toContainText('Item 8-1');
  });

  test('when the delayed page fails, the screen stays on page 8 with the error shown and the controls usable', async ({ page }) => {
    const { entries } = await pendingNineFromEight(page, { failPages: ['9'] });

    // Failed: the rows are still page 8's, and so is everything that describes them.
    await expect(page.locator('[data-testid="list-error"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="list-reloading"]')).toHaveCount(0);
    await expect(page).toHaveURL(/\?page=8$/);
    const failed = await page.evaluate(() => ({
      entries: window.history.length,
      navigation: !!document.querySelector('[data-testid="pagination"]'),
      current: document.querySelector('[aria-current="page"]')?.textContent,
      busy: document.querySelector('[data-testid="list-body"]')?.getAttribute('aria-busy'),
      summary: document.querySelector('[data-testid="pagination-summary"]')?.textContent,
      firstRow: document.querySelector('tbody tr')?.textContent ?? '',
      alert: document.querySelector('[data-testid="list-error"]')?.getAttribute('role'),
    }));
    expect(failed.entries, 'the address was replaced, not pushed again').toBe(entries + 1);
    expect(failed.navigation, 'the controls are still there').toBe(true);
    expect(failed.current).toBe('8');
    expect(failed.busy).toBeNull();
    expect(failed.summary).toBe('Page 8 of 20 · 480 items');
    expect(failed.firstRow).toContain('Item 8-1');
    expect(failed.alert).toBe('alert');

    // Usable: the next choice is a fresh request that clears the error.
    await page.locator('[data-testid="page-10"]').click();
    await expect(page.locator('tbody')).toContainText('Item 10-1', { timeout: 15_000 });
    await expect(page).toHaveURL(/\?page=10$/);
    await expect(page.locator('[data-testid="pagination-summary"]')).toHaveText('Page 10 of 20 · 480 items');
    await expect(page.locator('[data-testid="list-error"]')).toHaveCount(0);
  });
});

/**
 * AN ADDRESS BEYOND THE LAST PAGE. The page-50 answer carries no rows: it is
 * the empty answer to a page that does not exist. Painting it would put an
 * empty table under a summary claiming a full page, so the only thing it may
 * do is move the address and the request to page 20. Page 20's answer is held
 * back for a second, long enough to look at the screen in between.
 */
test.describe('an out-of-range address never paints its empty answer (1440px)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('page 50 of 20 asks for page 20 and labels nothing until page 20 answers', async ({ page }) => {
    const asked: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/products')) asked.push(url.searchParams.get('page') ?? '1');
    });
    await stub(page, { delayMs: { '20': 1000 } });
    await page.goto('/dashboard/products?page=50');

    // While page 20 is on its way: the address is corrected, but nothing on
    // screen claims to be a page, and no empty table is labelled.
    await expect(page).toHaveURL(/\?page=20$/, { timeout: 30_000 });
    const during = await page.evaluate(() => ({
      navigation: !!document.querySelector('[data-testid="pagination"]'),
      summary: document.querySelector('[data-testid="pagination-summary"]')?.textContent ?? null,
      rows: document.querySelectorAll('tbody tr').length,
      body: document.body.innerText,
    }));
    expect(during.navigation, 'no page has been answered yet').toBe(false);
    expect(during.summary).toBeNull();
    expect(during.body, 'nothing claims page 20 yet').not.toContain('Page 20 of 20');

    // Only page 20's own answer moves rows, summary and marker.
    await expect(page.locator('tbody')).toContainText('Item 20-1', { timeout: 15_000 });
    await expect(page.locator('[data-testid="pagination-summary"]')).toHaveText('Page 20 of 20 · 480 items');
    await expect(page.locator('[data-testid="page-20"]')).toHaveAttribute('aria-current', 'page');
    await expect(page).toHaveURL(/\?page=20$/);
    // Development Strict Mode mounts twice, so an identical request can
    // repeat back to back; what matters is that the list never goes BACK to
    // the out-of-range page, which a clamp that painted itself would do.
    const walked = asked.filter((asked_page, i) => asked_page !== asked[i - 1]);
    expect(walked, `page 50 then page 20, nothing else (raw: ${asked.join(',')})`).toEqual(['50', '20']);
  });
});

/**
 * ADDRESSES THAT DO NOT NAME A PAGE. Whatever is in the query string, the
 * server is asked only for a canonical page, and the address is corrected.
 */
test.describe('malformed page addresses (1440px)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  for (const [raw, expectedRequest, expectedSearch] of [
    ['1e3', '1', ''],
    ['2.7', '1', ''],
    ['99999999999999999999', '1', ''],
    ['0002', '1', ''],
    ['+2', '1', ''],
    ['%202', '1', ''],
    ['7', '7', '?page=7'],
  ] as const) {
    test(`page=${raw} asks the server for page ${expectedRequest} and the address becomes "${expectedSearch}"`, async ({ page }) => {
      const requested: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.endsWith('/api/v1/products')) requested.push(url.searchParams.get('page') ?? '(none)');
      });
      await stub(page);
      await page.goto(`/dashboard/products?page=${raw}`);
      await page.waitForSelector(`[data-testid="page-${expectedRequest}"][aria-current="page"]`, { timeout: 30_000 });
      expect(requested[0]).toBe(expectedRequest);
      expect(requested.every((value) => /^[1-9]\d*$/.test(value) && Number(value) <= 100_000), 'never a malformed page on the wire').toBe(true);
      expect(new URL(page.url()).search).toBe(expectedSearch);
    });
  }
});
