import { test, expect, type Page } from '@playwright/test';

/**
 * SELECTION SCOPES IN A REAL BROWSER, on stubbed data.
 *
 * What only a browser shows: that the scope line is readable and reachable at
 * a desktop and a phone width, that the whole choice is operable from the
 * keyboard, and that a cross-page selection really does survive the browser's
 * own page navigation while a page selection really does not.
 */
const ORIGIN = 'http://localhost:3000';
const ORG = 'org-1';
const STORE = 'store-a';
const LIMIT = 25;
const TOTAL = 60;

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' },
  body: JSON.stringify(body),
});

/** Short ids by default; real-shaped UUIDs where their width is the point. */
const idOf = (n: number, long = false) => (long ? `3f6c2a1e-9b7d-4c5e-8a2f-${String(n).padStart(12, '0')}` : `p-${n}`);

const rows = (pageNumber: number, long = false) => {
  const first = (pageNumber - 1) * LIMIT;
  const count = Math.max(0, Math.min(LIMIT, TOTAL - first));
  return Array.from({ length: count }, (_, i) => ({
    id: idOf(first + i + 1, long),
    name: `Item ${first + i + 1}`,
    slug: `item-${first + i + 1}`,
    status: 'PUBLISHED',
    price: 10,
    stockQuantity: 1,
    trackInventory: false,
  }));
};

/**
 * `truncated` makes the stub answer as a catalogue too large to select.
 * `bulkFails` makes every bulk request fail outright, as a gateway timeout
 * does, and `longIds` gives the items UUID-shaped ids.
 */
async function stub(page: Page, opts: { truncated?: boolean; bulkFails?: boolean; longIds?: boolean } = {}) {
  const long = opts.longIds === true;
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
    if (p === '/products/ids') {
      if (opts.truncated)
        return route.fulfill(
          json({ ids: Array.from({ length: 10000 }, (_, i) => `p-${i + 1}`), total: 25000, truncated: true }),
        );
      return route.fulfill(
        json({ ids: Array.from({ length: TOTAL }, (_, i) => idOf(i + 1, long)), total: TOTAL, truncated: false }),
      );
    }
    if (p === '/products') {
      const pageNumber = Number(q.get('page') ?? '1');
      return route.fulfill(
        json({ items: rows(pageNumber, long), total: TOTAL, page: pageNumber, limit: LIMIT, totalPages: Math.ceil(TOTAL / LIMIT) }),
      );
    }
    if (opts.bulkFails && p.startsWith('/bulk/products/'))
      return route.fulfill({ ...json({ message: 'Gateway Timeout' }), status: 504 });
    if (p === '/stores') return route.fulfill(json({ items: [{ id: STORE, name: 'Centro' }], total: 1 }));
    if (p === '/categories') return route.fulfill(json({ items: [], total: 0 }));
    return route.fulfill(json({ data: null, items: [], total: 0 }));
  });
  await page.addInitScript(() => window.localStorage.setItem('cataloguer.session', '1'));
}

const ready = async (page: Page) => {
  await page.waitForSelector('[data-testid="page-1"][aria-current="page"]', { timeout: 30_000 });
};
const selectPage = async (page: Page) => {
  await page.locator('thead input[type="checkbox"]').click();
  await expect(page.locator('[data-testid="selection-summary"]')).toBeVisible();
};

for (const vp of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
]) {
  test.describe(`${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('the scope is written in words, and the other choice sits beside it', async ({ page }) => {
      await stub(page);
      await page.goto('/dashboard/products');
      await ready(page);
      await selectPage(page);

      const summary = page.locator('[data-testid="selection-summary"]');
      await expect(summary).toHaveAttribute('data-selection-scope', 'page');
      await expect(summary).toContainText('25 items selected on this page');
      await expect(page.locator('[data-testid="select-all-matching"]')).toContainText('Select all 60');

      // Nothing spills sideways at either width.
      const overflow = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(overflow.scroll, `${vp.name}: horizontal overflow`).toBeLessThanOrEqual(overflow.client + 1);
    });

    test('choosing every matching item changes the words, not just the number', async ({ page }) => {
      await stub(page);
      await page.goto('/dashboard/products');
      await ready(page);
      await selectPage(page);
      await page.locator('[data-testid="select-all-matching"]').click();

      const summary = page.locator('[data-testid="selection-summary"]');
      await expect(summary).toHaveAttribute('data-selection-scope', 'matching');
      await expect(summary).toContainText('All 60 items selected');
      await expect(page.locator('[data-testid="select-page-only"]')).toBeVisible();
    });
  });
}

test.describe('what survives a page change (1440px)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('a page selection does not survive, and a matching selection does', async ({ page }) => {
    await stub(page);
    await page.goto('/dashboard/products');
    await ready(page);

    // A page selection is gone on page 2.
    await selectPage(page);
    await page.locator('[data-testid="page-2"]').click();
    await page.waitForSelector('[data-testid="page-2"][aria-current="page"]');
    await expect(page.locator('[data-testid="selection-summary"]')).toHaveCount(0);

    // A matching selection is still there, and still ticks the new page.
    await selectPage(page);
    await page.locator('[data-testid="select-all-matching"]').click();
    await expect(page.locator('[data-testid="selection-summary"]')).toHaveAttribute('data-selection-scope', 'matching');
    await page.locator('[data-testid="page-3"]').click();
    await page.waitForSelector('[data-testid="page-3"][aria-current="page"]');
    await expect(page.locator('[data-testid="selection-summary"]')).toHaveAttribute('data-selection-scope', 'matching');
    await expect(page.locator('[data-testid="selection-summary"]')).toContainText('All 60 items selected');
    const ticked = await page.locator('tbody input[type="checkbox"]:checked').count();
    expect(ticked, 'the rows of the new page are part of the selection').toBe(10);

    // The browser's own Back button lands on page 2 with the selection intact.
    await page.goBack();
    await page.waitForSelector('[data-testid="page-2"][aria-current="page"]');
    await expect(page.locator('[data-testid="selection-summary"]')).toHaveAttribute('data-selection-scope', 'matching');
  });
});

test.describe('keyboard and refusal (1440px)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the whole choice is reachable and operable from the keyboard', async ({ page }) => {
    await stub(page);
    await page.goto('/dashboard/products');
    await ready(page);

    // Select the page with the keyboard alone.
    await page.locator('thead input[type="checkbox"]').focus();
    await page.keyboard.press('Space');
    await expect(page.locator('[data-testid="selection-summary"]')).toBeVisible();

    // Reach the cross-page choice by tabbing and activate it with Enter.
    await page.locator('[data-testid="select-all-matching"]').focus();
    const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid'));
    expect(focused).toBe('select-all-matching');
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="selection-summary"]')).toHaveAttribute('data-selection-scope', 'matching');

    // And step back to the page selection, also from the keyboard.
    await page.locator('[data-testid="select-page-only"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="selection-summary"]')).toHaveAttribute('data-selection-scope', 'page');
  });

  test('a catalogue too large to select is refused in words, and the page selection stands', async ({ page }) => {
    await stub(page, { truncated: true });
    await page.goto('/dashboard/products');
    await ready(page);
    await selectPage(page);
    await page.locator('[data-testid="select-all-matching"]').click();

    const warning = page.locator('[data-testid="selection-too-large"]');
    await expect(warning).toBeVisible();
    await expect(warning).toHaveAttribute('role', 'alert');
    await expect(warning).toContainText('25,000');
    // Nothing claims to be "all matching", and what was selected is untouched.
    await expect(page.locator('[data-testid="selection-summary"]')).toHaveAttribute('data-selection-scope', 'page');
    const ticked = await page.locator('tbody input[type="checkbox"]:checked').count();
    expect(ticked).toBe(25);
  });
});

/*
 * THE RUN REPORT AT A PHONE WIDTH. An archive whose only request fails
 * leaves 60 unconfirmed ids and nothing else to hold them. At 390px the
 * content column is narrow (the fixed sidebar keeps its width there), so the
 * report must wrap: Dismiss whole and inside the viewport, every UUID broken
 * inside its list rather than widening it, and the page itself never
 * scrolling sideways.
 */
test.describe('run report (390px)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('Dismiss and every unconfirmed id stay usable', async ({ page }) => {
    await stub(page, { bulkFails: true, longIds: true });
    await page.goto('/dashboard/products');
    await ready(page);
    await selectPage(page);
    await page.locator('[data-testid="select-all-matching"]').click();
    await expect(page.locator('[data-testid="selection-summary"]')).toHaveAttribute('data-selection-scope', 'matching');
    await page.locator('[data-testid="bulk-bar"] button', { hasText: /^Archive$/ }).click();

    const report = page.locator('[data-testid="run-report"]');
    await expect(report).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="run-report-unconfirmed-item"]')).toHaveCount(60);
    // The generic "0 successes, 0 failures" panel is not shown beside it.
    await expect(page.getByText('Bulk Operation Results')).toHaveCount(0);

    const m = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="run-report"]') as HTMLElement;
      const list = box.querySelector('ul') as HTMLElement;
      const dismiss = (document.querySelector('[data-testid="run-report-dismiss"]') as HTMLElement).getBoundingClientRect();
      const b = box.getBoundingClientRect();
      return {
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        listOverflow: list.scrollWidth - list.clientWidth,
        dismissInsideBox: dismiss.left >= b.left && dismiss.right <= b.right,
        dismissInsideViewport: dismiss.left >= 0 && dismiss.right <= window.innerWidth,
      };
    });
    expect(m.pageOverflow, 'the page never scrolls sideways').toBe(0);
    expect(m.listOverflow, 'every id breaks inside its list').toBeLessThanOrEqual(0);
    expect(m.dismissInsideBox, 'Dismiss is whole, inside the report').toBe(true);
    expect(m.dismissInsideViewport, 'Dismiss is on screen').toBe(true);

    // Each id opens its Item page.
    await expect(page.locator('[data-testid="run-report-unconfirmed-item"] a').first()).toHaveAttribute(
      'href',
      '/dashboard/products/3f6c2a1e-9b7d-4c5e-8a2f-000000000001',
    );

    // Reachable and operable from the keyboard.
    await page.locator('[data-testid="run-report-dismiss"]').focus();
    await page.keyboard.press('Enter');
    await expect(report).toHaveCount(0);
  });
});
