import { test, expect, type Page } from '@playwright/test';

/**
 * PR D in a real browser: suggestions folded into Items, and empty states that
 * say which empty they are.
 *
 * Stubbed data, no backend, nothing mutated. What this proves is what unit
 * tests cannot — that the journey LAYS OUT and is operable at a desktop width
 * and a narrow one, that the old `/groups` link still lands somewhere useful,
 * that a blocked suggestion cannot be submitted from anywhere, and that
 * reviewing one never ticks a checkbox nobody ticked.
 */

const ORIGIN = 'http://localhost:3000';
const ORG = 'org-1';
const STORE = 'store-a';

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' },
  body: JSON.stringify(body),
});

const ROJA = { id: 'solo-1', name: 'Camiseta lisa roja', slug: 'camiseta-lisa-roja', status: 'PUBLISHED', price: 80 };
const AZUL = { id: 'solo-2', name: 'Camiseta lisa azul', slug: 'camiseta-lisa-azul', status: 'PUBLISHED', price: 80 };
const VERDE = { id: 'solo-3', name: 'Gorra plana verde', slug: 'gorra-plana-verde', status: 'PUBLISHED', price: 20 };
const NEGRA = { id: 'solo-4', name: 'Gorra plana negra', slug: 'gorra-plana-negra', status: 'DRAFT', price: 20 };

interface StubSuggestion {
  name: string;
  readiness: 'READY' | 'BLOCKED';
  blockedReasons: string[];
  members: { id: string; name: string; label: string; price: number; status: string; hasStore: boolean }[];
}

const READY: StubSuggestion = {
  name: 'Camiseta lisa',
  readiness: 'READY',
  blockedReasons: [],
  members: [
    { id: 'solo-1', name: ROJA.name, label: 'Roja', price: 80, status: 'PUBLISHED', hasStore: true },
    { id: 'solo-2', name: AZUL.name, label: 'Azul', price: 80, status: 'PUBLISHED', hasStore: true },
  ],
};

const BLOCKED: StubSuggestion = {
  name: 'Gorra plana',
  readiness: 'BLOCKED',
  blockedReasons: ['MIXED_PUBLICATION_STATUS'],
  members: [
    { id: 'solo-3', name: VERDE.name, label: 'Verde', price: 20, status: 'PUBLISHED', hasStore: true },
    { id: 'solo-4', name: NEGRA.name, label: 'Negra', price: 20, status: 'DRAFT', hasStore: true },
  ],
};

interface StubOptions {
  /**
   * What `/products/family-suggestions` answers. The FIRST entry is returned
   * until something is written, then the next — a listing does not change
   * because it was read twice.
   */
  suggestions?: StubSuggestion[][];
  /** Rows the items table receives when no filter narrows it. */
  products?: unknown[];
  /** How `POST /products/families` answers. */
  createFails?: string;
  role?: string;
  /** Records every request the page made, for the assertions that need it. */
  seen?: string[];
}

async function stub(page: Page, options: StubOptions = {}) {
  const listings = options.suggestions ?? [[READY, BLOCKED]];
  let written = 0;
  const rows = options.products ?? [ROJA, AZUL, VERDE, NEGRA];

  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace('/api/v1', '');
    options.seen?.push(`${route.request().method()} ${p}`);

    if (p === '/auth/refresh')
      return route.fulfill(json({ data: { accessToken: 'stub', user: { id: 'u1', email: 'a@b.c', name: 'Ana' } } }));
    if (p === '/auth/me')
      return route.fulfill(
        json({
          data: {
            user: { id: 'u1', email: 'a@b.c', name: 'Ana' },
            scope: {
              platform: false,
              role: options.role ?? 'ORGANIZATION_MANAGER',
              organizationId: ORG,
              storeId: null,
              allowedStoreIds: [STORE],
            },
          },
        }),
      );
    if (p === '/products/family-suggestions') {
      // A refetch after grouping or dismissing sees the shorter list a real
      // backend would return; a refetch after nothing sees the same one.
      const data = listings[Math.min(written, listings.length - 1)];
      return route.fulfill(
        json({
          data,
          readyCount: data.filter((s) => s.readiness === 'READY').length,
          blockedCount: data.filter((s) => s.readiness !== 'READY').length,
        }),
      );
    }
    if (p === '/products/family-suggestions/dismiss') {
      written += 1;
      return route.fulfill(json({ data: { dismissed: true } }));
    }
    if (p === '/products/families/validate') return route.fulfill(json({ data: { problem: null } }));
    if (p === '/products/families') {
      if (options.createFails)
        return route.fulfill({
          status: 409,
          contentType: 'application/json',
          headers: { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' },
          body: JSON.stringify({ message: options.createFails }),
        });
      written += 1;
      return route.fulfill(json({ data: { id: 'new-card', name: 'Camiseta lisa', members: 2 } }));
    }
    if (p === '/products') {
      // A search that matches nothing is how the filtered-empty state is
      // reached — the SERVER decides, exactly as it does in production.
      const search = url.searchParams.get('search');
      const items = search ? [] : rows;
      return route.fulfill(json({ items, total: items.length, page: 1, limit: 100, totalPages: 1 }));
    }
    if (p === '/stores') return route.fulfill(json({ items: [{ id: STORE, name: 'Centro' }], total: 1 }));
    if (p === '/categories') return route.fulfill(json({ items: [], total: 0 }));
    return route.fulfill(json({ data: null, items: [], total: 0 }));
  });
  await page.addInitScript(() => window.localStorage.setItem('cataloguer.session', '1'));
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow', width: 390, height: 844 },
];

async function assertNoHorizontalOverflow(page: Page, label: string) {
  const o = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(o.scroll, `${label}: horizontal overflow`).toBeLessThanOrEqual(o.client + 1);
}

/**
 * Every control in the review is where a finger can reach it.
 *
 * The dashboard shell does not collapse its sidebar at 390px, so the content
 * column there is barely eighty pixels wide. A non-wrapping right-aligned row
 * overflows to the LEFT — which put the Review button underneath the nav,
 * visible and unclickable, because the nav swallowed the pointer. Overflow
 * alone does not catch that: the page did not scroll sideways, the button was
 * simply somewhere it could not be pressed.
 */
async function assertControlsClearOfTheNav(page: Page, label: string) {
  const overlapping = await page.evaluate(() => {
    const nav = document.querySelector('aside');
    if (!nav) return [];
    const bar = nav.getBoundingClientRect();
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="suggestion-review"] button, [data-testid="suggestions-banner"] button'),
    );
    return controls
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.left < bar.right && r.right > bar.left && r.top < bar.bottom && r.bottom > bar.top;
      })
      .map((el) => el.dataset.testid ?? el.textContent ?? '?');
  });
  expect(overlapping, `${label}: controls hidden behind the sidebar`).toEqual([]);
}

/** Land on Items with the suggestion review already open. */
async function openSuggestions(page: Page) {
  await page.goto('/dashboard/products');
  await page.waitForSelector('[data-testid="suggestions-banner"]', { timeout: 30_000 });
  await page.locator('[data-testid="suggestions-toggle"]').click();
  await page.waitForSelector('[data-testid="suggestion-review"]', { timeout: 15_000 });
}

for (const vp of VIEWPORTS) {
  test.describe(`suggestions live with the items · ${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('the banner counts only what can actually be grouped, and opens the review', async ({ page }) => {
      await stub(page);
      await page.goto('/dashboard/products');
      await page.waitForSelector('[data-testid="suggestions-banner"]', { timeout: 30_000 });

      // One READY and one BLOCKED: only the ready one is described as waiting.
      // One ready group, and the sentence agrees with the number: the banner
      // used to say "1 groups of items look like one product."
      await expect(page.locator('[data-testid="suggestions-summary"]')).toHaveText(
        '1 group of items looks like one product.',
      );
      await expect(page.locator('[data-testid="suggestion-review"]')).toHaveCount(0);

      await page.locator('[data-testid="suggestions-toggle"]').click();
      await expect(page.locator('[data-testid="suggestion-review"]')).toBeVisible();
      await expect(page.locator('[data-testid="suggestion-name"]')).toHaveText('Camiseta lisa');
      await assertNoHorizontalOverflow(page, `suggestions/${vp.name}`);
      await assertControlsClearOfTheNav(page, `suggestions/${vp.name}`);
      await page.screenshot({ path: `test-results/prd-screenshots/prd-suggestions-${vp.name}.png`, fullPage: true });
    });

    test('a blocked suggestion is shown, explained, and cannot be submitted', async ({ page }) => {
      const posted: string[] = [];
      await stub(page);
      page.on('request', (r) => {
        if (r.method() === 'POST' && r.url().includes('/products/families')) posted.push(r.url());
      });
      await openSuggestions(page);
      await page.locator('[data-testid="suggestion-next"]').click();
      await expect(page.locator('[data-testid="suggestion-name"]')).toHaveText('Gorra plana');

      await expect(page.locator('[data-testid="suggestion-blocked"]')).toBeVisible();
      await expect(page.locator('[data-testid="blocked-reason-MIXED_PUBLICATION_STATUS"]')).toContainText(
        /published or all draft/i,
      );
      // WHICH member, not only that there is one.
      await expect(page.locator('[data-testid="member-draft-solo-4"]')).toBeVisible();

      const open = page.locator('[data-testid="suggestion-review-open"]');
      await expect(open).toBeDisabled();
      await open.click({ force: true }).catch(() => undefined);
      await expect(page.locator('[data-testid="group-modal"]')).toHaveCount(0);
      expect(posted, 'a blocked suggestion must reach no writing endpoint').toHaveLength(0);
      await assertNoHorizontalOverflow(page, `blocked/${vp.name}`);
      await assertControlsClearOfTheNav(page, `blocked/${vp.name}`);
    });

    test('Review opens the SAME grouping modal, preseeded, without touching the table selection', async ({ page }) => {
      await stub(page);
      await openSuggestions(page);
      const ticked = () => page.locator('tbody input[type="checkbox"]:checked').count();
      expect(await ticked(), 'nothing was selected before Review').toBe(0);
      await assertControlsClearOfTheNav(page, `review/${vp.name}`);

      // An ORDINARY click: no force, no dispatchEvent. A control that has to be
      // forced is a control a person could not press.
      await page.locator('[data-testid="suggestion-review-open"]').click();
      await page.waitForSelector('[data-testid="group-modal"]', { timeout: 15_000 });

      // The modal manual grouping opens: same preflight, same preview, same
      // refusals — seeded with the suggestion's OWN members and name.
      await expect(page.locator('[data-testid="group-parent-name"]')).toHaveValue('Camiseta lisa');
      await expect(page.locator('[data-testid="group-label-solo-1"]')).toHaveValue('Roja');
      await expect(page.locator('[data-testid="group-label-solo-2"]')).toHaveValue('Azul');
      await expect(page.locator('[data-testid="group-preview"]')).toBeVisible();

      // The table's own selection is untouched: loading a suggestion must not
      // silently tick checkboxes somebody did not tick.
      expect(await ticked(), 'Review must not alter the items selection').toBe(0);
      await assertNoHorizontalOverflow(page, `review-modal/${vp.name}`);
      await page.screenshot({ path: `test-results/prd-screenshots/prd-review-modal-${vp.name}.png`, fullPage: true });
    });
  });
}

/**
 * SINGULAR AND PLURAL, rendered by the real component in a real browser.
 *
 * The unit tests pin the sentences; this pins that the count the banner
 * computes is the one that selects them, end to end through the page.
 */
test.describe('the banner counts and reads correctly', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('one ready group reads as a singular sentence', async ({ page }) => {
    await stub(page, { suggestions: [[READY, BLOCKED]] });
    await page.goto('/dashboard/products');
    await page.waitForSelector('[data-testid="suggestions-banner"]', { timeout: 30_000 });
    await expect(page.locator('[data-testid="suggestions-summary"]')).toHaveText(
      '1 group of items looks like one product.',
    );
  });

  test('two ready groups read as a plural sentence', async ({ page }) => {
    const second = { ...READY, name: 'Gorra lisa' };
    await stub(page, { suggestions: [[READY, second, BLOCKED]] });
    await page.goto('/dashboard/products');
    await page.waitForSelector('[data-testid="suggestions-banner"]', { timeout: 30_000 });
    await expect(page.locator('[data-testid="suggestions-summary"]')).toHaveText(
      '2 groups of items look like one product.',
    );
  });

  test('the all-blocked wording is untouched', async ({ page }) => {
    await stub(page, { suggestions: [[BLOCKED]] });
    await page.goto('/dashboard/products');
    await page.waitForSelector('[data-testid="suggestions-banner"]', { timeout: 30_000 });
    await expect(page.locator('[data-testid="suggestions-summary"]')).toHaveText(
      'Some items look like one product, but need a correction first.',
    );
  });
});

/**
 * THE TILE'S CAPTION, in a real browser.
 *
 * "1" above "possible parent products to review" reads as one phrase, and that
 * is the phrase the owner saw. The count and the caption have to agree.
 */
test.describe('the dashboard tile caption agrees with its count', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /**
   * The phrase a reader sees, not the string the DOM concatenates.
   *
   * A tile is exactly two paragraphs — the number, then the caption — stacked
   * with no whitespace between them, so `textContent` yields "1possible parent
   * product to review". Joining the two blocks with a single space is what the
   * eye does across the line break, and it is the only reading under which
   * "agrees with its count" means anything.
   */
  const phrase = async (tile: ReturnType<Page['locator']>) =>
    (await tile.locator('p').allTextContents()).join(' ').replace(/\s+/g, ' ').trim();

  test('one ready group reads "1 possible parent product to review"', async ({ page }) => {
    await stub(page, { suggestions: [[READY, BLOCKED]] });
    await page.goto('/dashboard');
    await page.waitForSelector('[data-testid="tile-groupable"]', { timeout: 30_000 });
    const tile = page.locator('[data-testid="tile-groupable"]');
    await expect(tile).toContainText('possible parent product to review');
    // The exact defect: never the plural caption against a count of one.
    await expect(tile).not.toContainText('possible parent products to review');
    expect(await phrase(tile)).toBe('1 possible parent product to review');
  });

  test('two ready groups read "2 possible parent products to review"', async ({ page }) => {
    const second = { ...READY, name: 'Gorra lisa' };
    await stub(page, { suggestions: [[READY, second, BLOCKED]] });
    await page.goto('/dashboard');
    await page.waitForSelector('[data-testid="tile-groupable"]', { timeout: 30_000 });
    const tile = page.locator('[data-testid="tile-groupable"]');
    expect(await phrase(tile)).toBe('2 possible parent products to review');
  });

  test('none ready keeps the clean sentence, inert and uninflected', async ({ page }) => {
    await stub(page, { suggestions: [[BLOCKED]] });
    await page.goto('/dashboard');
    await page.waitForSelector('[data-testid="tile-groupable"]', { timeout: 30_000 });
    const tile = page.locator('[data-testid="tile-groupable"]');
    await expect(tile).toHaveAttribute('data-state', 'clean');
    await expect(tile).toContainText('nothing waiting to be grouped');
    await expect(tile).not.toContainText('possible parent product');
  });

  test('an unreadable count keeps the neutral sentence', async ({ page }) => {
    await stub(page, { suggestions: [[READY]] });
    await page.route('**/api/v1/products/family-suggestions', (route) => route.abort());
    await page.goto('/dashboard');
    await page.waitForSelector('[data-testid="tile-groupable"]', { timeout: 30_000 });
    const tile = page.locator('[data-testid="tile-groupable"]');
    await expect(tile).toHaveAttribute('data-state', 'unknown');
    await expect(tile).toContainText(/could not be checked/i);
    await expect(tile).not.toContainText('possible parent product to review');
    await page.unroute('**/api/v1/products/family-suggestions');
  });
});

test.describe('acting on a suggestion', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('grouping one removes it, and refetches everything it changed', async ({ page }) => {
    const seen: string[] = [];
    // The second listing is what a backend returns once the family exists.
    await stub(page, { suggestions: [[READY, BLOCKED], [BLOCKED]], seen });
    await openSuggestions(page);
    await page.locator('[data-testid="suggestion-review-open"]').click();
    await page.waitForSelector('[data-testid="group-modal"]', { timeout: 15_000 });
    await page.locator('[data-testid="group-confirm"]').click();

    await expect(page.locator('[data-testid="group-modal"]')).toHaveCount(0);
    // The grouped suggestion is gone; the blocked one is what is left.
    await expect(page.locator('[data-testid="suggestion-name"]')).toHaveText('Gorra plana');
    await expect(page.locator('[data-testid="suggestions-summary"]')).toContainText(/correction first/i);

    // Both the suggestions and the items were re-read: the items are a family
    // now, and the counts move with them.
    const after = seen.slice(seen.indexOf('POST /products/families'));
    expect(after.filter((r) => r === 'GET /products/family-suggestions').length).toBeGreaterThanOrEqual(1);
    expect(after.filter((r) => r === 'GET /products').length).toBeGreaterThanOrEqual(1);
  });

  test('dismissing one removes it and does not create anything', async ({ page }) => {
    const seen: string[] = [];
    await stub(page, { suggestions: [[READY, BLOCKED], [BLOCKED]], seen });
    await openSuggestions(page);
    await page.locator('[data-testid="suggestion-dismiss"]').click();

    await expect(page.locator('[data-testid="suggestion-name"]')).toHaveText('Gorra plana');
    expect(seen).toContain('POST /products/family-suggestions/dismiss');
    expect(seen.filter((r) => r === 'POST /products/families')).toHaveLength(0);
    const after = seen.slice(seen.indexOf('POST /products/family-suggestions/dismiss'));
    expect(after.filter((r) => r === 'GET /products/family-suggestions').length).toBeGreaterThanOrEqual(1);
  });

  /**
   * Readiness is ADVISORY. The catalogue can move between reading it and
   * pressing the button, and the create endpoint inside its transaction is the
   * authoritative answer — so its refusal has to reach the reader.
   */
  test('a state change after loading is caught by the authoritative check', async ({ page }) => {
    await stub(page, { createFails: '"Camiseta lisa azul" is in no shop. A child product has to be sold somewhere.' });
    await openSuggestions(page);
    await page.locator('[data-testid="suggestion-review-open"]').click();
    await page.waitForSelector('[data-testid="group-modal"]', { timeout: 15_000 });
    await page.locator('[data-testid="group-confirm"]').click();

    await expect(page.locator('[data-testid="group-problem"]')).toContainText(/in no shop/i);
    // The modal stays open on the reader's own input rather than closing on a
    // creation that did not happen.
    await expect(page.locator('[data-testid="group-modal"]')).toBeVisible();
  });

  test('the whole review is operable by keyboard alone', async ({ page }) => {
    await stub(page);
    await page.goto('/dashboard/products');
    await page.waitForSelector('[data-testid="suggestions-banner"]', { timeout: 30_000 });

    const toggle = page.locator('[data-testid="suggestions-toggle"]');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="suggestion-review"]', { timeout: 15_000 });
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await page.locator('[data-testid="suggestion-next"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="suggestion-name"]')).toHaveText('Gorra plana');

    // The disabled action says WHY, where a screen reader will read it.
    const open = page.locator('[data-testid="suggestion-review-open"]');
    const describedBy = await open.getAttribute('aria-describedby');
    expect(describedBy).toBe('suggestion-blocked-desc');
    await expect(page.locator('#suggestion-blocked-desc')).toContainText(/published or all draft/i);

    await page.locator('[data-testid="suggestion-prev"]').focus();
    await page.keyboard.press('Enter');
    await page.locator('[data-testid="suggestion-review-open"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForSelector('[data-testid="group-modal"]', { timeout: 15_000 });
  });
});

/**
 * The old suggestions route.
 *
 * It used to own a second grouping workflow, with none of the safeguards Items
 * had. The link must keep working, and must never land on a blank page.
 */
test.describe('the old /groups link', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('lands on the items review rather than a page that no longer exists', async ({ page }) => {
    await stub(page);
    await page.goto('/dashboard/products/groups');
    await page.waitForURL(/\/dashboard\/products\?suggestions=open/, { timeout: 30_000 });
    await page.waitForSelector('[data-testid="suggestion-review"]', { timeout: 15_000 });
    await expect(page.locator('[data-testid="suggestion-name"]')).toHaveText('Camiseta lisa');
  });

  test('lands on a real empty state when there is nothing to group', async ({ page }) => {
    await stub(page, { suggestions: [[]] });
    await page.goto('/dashboard/products/groups');
    await page.waitForURL(/\/dashboard\/products\?suggestions=open/, { timeout: 30_000 });
    await page.waitForSelector('tbody tr', { timeout: 30_000 });
    // No banner at all — an empty banner announcing nothing is the broken page
    // this replaced.
    await expect(page.locator('[data-testid="suggestions-banner"]')).toHaveCount(0);
    await assertNoHorizontalOverflow(page, 'groups-empty');
  });
});

test.describe('an empty items table says which empty it is', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('with nothing in the catalogue, it offers Add Item', async ({ page }) => {
    await stub(page, { products: [], suggestions: [[]] });
    await page.goto('/dashboard/products');
    await page.waitForSelector('[data-testid="empty-catalogue"]', { timeout: 30_000 });
    await expect(page.locator('[data-testid="empty-filtered"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="empty-clear-filters"]')).toHaveCount(0);

    await page.locator('[data-testid="empty-add-item"]').click();
    await page.waitForSelector('[data-testid="new-kind-chooser"]', { timeout: 15_000 });
  });

  test('a reader is not offered an action the server would refuse', async ({ page }) => {
    await stub(page, { products: [], suggestions: [[]], role: 'VIEWER' });
    await page.goto('/dashboard/products');
    await page.waitForSelector('[data-testid="empty-catalogue"]', { timeout: 30_000 });
    await expect(page.locator('[data-testid="empty-add-item"]')).toHaveCount(0);
  });

  test('with a filter narrowing it, it offers Clear filters — which resets every one', async ({ page }) => {
    await stub(page, { suggestions: [[]] });
    await page.goto('/dashboard/products');
    await page.waitForSelector('tbody tr', { timeout: 30_000 });

    await page.getByLabel('Search').fill('zzzz-nothing-matches');
    await page.waitForSelector('[data-testid="empty-filtered"]', { timeout: 15_000 });
    await expect(page.locator('[data-testid="empty-catalogue"]')).toHaveCount(0);
    // The items may well exist — offering "create your first product" here
    // would be untrue.
    await expect(page.locator('[data-testid="empty-add-item"]')).toHaveCount(0);

    await page.locator('[data-testid="empty-clear-filters"]').click();
    await page.waitForSelector('tbody tr', { timeout: 15_000 });
    await expect(page.getByLabel('Search')).toHaveValue('');
    await expect(page.locator('[data-testid="empty-filtered"]')).toHaveCount(0);
  });
});
