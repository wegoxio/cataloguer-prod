import { test, expect, type Page } from '@playwright/test';

/**
 * A STANDALONE ITEM JOINING A GROUP THAT ALREADY EXISTS, in a real browser, on
 * stubbed data.
 *
 * No backend and no production data: every API call is answered in the page.
 * What this holds is the part unit tests cannot — that the control lays out on
 * the item's page at a desktop width and a narrow one, that a person can
 * search, pick, label and submit it by keyboard, that what leaves the page is
 * the request the endpoint accepts, and that the backend's refusal is shown
 * where the form is rather than in a toast that slides away.
 *
 * The refusal wording is the backend's own (`family-membership.ts`,
 * `product-family.service.ts`): the stub repeats it verbatim so the page is
 * held to showing what the server said.
 */

const ORG = 'org-1';
const STORE = 'store-a';

/**
 * The page's own origin, from the config that served it. The stubbed answers
 * are cross-origin (the API is on another port), so they must name the origin
 * this run actually uses: `localhost:3000` with the ordinary config, the
 * disposable config's port when another app already holds 3000.
 */
const origin = () => new URL(test.info().project.use.baseURL ?? 'http://localhost:3000').origin;

const json = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': origin(), 'access-control-allow-credentials': 'true' },
  body: JSON.stringify(body),
});

const ALONE = { id: 'solo-1', name: 'Lámpara de pie', slug: 'lampara-de-pie', status: 'PUBLISHED', price: 80, stockQuantity: 2, trackInventory: true };
const CARD = {
  id: 'card-1',
  name: 'Lámparas',
  slug: 'lamparas',
  status: 'PUBLISHED',
  price: 120,
  children: [{ id: 'kid-1', name: 'Lámpara de mesa', optionLabel: 'Mesa' }],
};
const OTHER_CARD = { id: 'card-2', name: 'Lámparas de exterior', slug: 'lamparas-de-exterior', status: 'PUBLISHED', price: 90, children: [{ id: 'kid-2', name: 'Farol', optionLabel: 'Farol' }] };

const HIDDEN_REFUSAL =
  '"Lámparas" is hidden in "Centro", where the published item "Lámpara de pie" is visible. Attaching it would remove the item from that branch. Publish the parent there first, or hide the item there.';
const CHANGING_REFUSAL = 'Store membership kept changing while this was being applied. Please try again.';
/** A lifecycle refusal: also a 409, but with a code — and nothing to try again. */
const REMOVED_REFUSAL = {
  message: 'That record has been removed, so this operation cannot reference it. Ask the platform owner to restore it first.',
  code: 'LIFECYCLE_RECORD_REMOVED',
};

type Answer = { status: number; body: unknown };

/**
 * `joinAnswers` is consumed in order by successive POSTs to the members
 * endpoint, so a test can say "refuse once, then accept". `slowSearch`, when
 * given, holds the answer to a search for exactly that text until released.
 */
async function stub(page: Page, joinAnswers: Answer[], slowSearch?: { text: string; until: Promise<void> }) {
  const answers = [...joinAnswers];
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace('/api/v1', '');
    const q = url.searchParams;
    const method = route.request().method();

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

    if (p === '/products' && method === 'GET') {
      // The picker asks for GROUPS only; anything else on this page is a list
      // nobody reads here.
      if (q.get('family') === 'models') {
        const text = q.get('search') ?? '';
        if (slowSearch && text === slowSearch.text) await slowSearch.until;
        const needle = text.toLowerCase();
        const items = [CARD, OTHER_CARD].filter((c) => c.name.toLowerCase().includes(needle));
        return route.fulfill(json({ items, total: items.length, page: 1, limit: 10, totalPages: 1 }));
      }
      return route.fulfill(json({ items: [ALONE, CARD], total: 2, page: 1, limit: 100, totalPages: 1 }));
    }
    if (p === '/products/card-1/family/members' && method === 'POST') {
      const answer = answers.shift() ?? { status: 201, body: { data: { member: { id: 'solo-1', name: ALONE.name, label: 'Pie' } } } };
      return route.fulfill(json(answer.body, answer.status));
    }
    if (p === '/products/solo-1') return route.fulfill(json({ data: ALONE }));
    if (p === '/products/card-1') return route.fulfill(json({ data: CARD }));
    if (p.startsWith('/products/') && p.endsWith('/family')) return route.fulfill(json({ data: null }));
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

/** No element may spill past the document's own width. */
async function assertNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scroll: doc.scrollWidth, client: doc.clientWidth };
  });
  expect(overflow.scroll, `${label}: horizontal overflow`).toBeLessThanOrEqual(overflow.client + 1);
}

/** The dialog's panel lies wholly inside the viewport. */
async function assertDialogFits(page: Page, label: string) {
  const box = await page.locator('[role="dialog"] > div').boundingBox();
  const viewport = page.viewportSize();
  expect(box, `${label}: dialog rendered`).not.toBeNull();
  expect(box!.x, `${label}: dialog left edge`).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width, `${label}: dialog right edge`).toBeLessThanOrEqual(viewport!.width + 1);
  expect(box!.y, `${label}: dialog top edge`).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height, `${label}: dialog bottom edge`).toBeLessThanOrEqual(viewport!.height + 1);
}

/** The POST bodies that left the page for the members endpoint, in order. */
function recordJoins(page: Page): { url: string; body: unknown }[] {
  const posted: { url: string; body: unknown }[] = [];
  page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().includes('/family/members'))
      posted.push({ url: r.url(), body: JSON.parse(r.postData() ?? 'null') });
  });
  return posted;
}

/** React's development errors about markup a browser would repair: the hydration error in the reported screenshots. */
const NESTING = /cannot (appear as|be) a child of|validateDOMNesting|hydrat/i;
function recordNestingErrors(page: Page): string[] {
  const seen: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && NESTING.test(message.text())) seen.push(message.text().slice(0, 200));
  });
  page.on('pageerror', (error) => {
    if (NESTING.test(error.message)) seen.push(error.message.slice(0, 200));
  });
  return seen;
}

/** The app's primary colour (`tailwind.config`), as a browser computes it. */
const PRIMARY = 'rgb(55, 98, 227)';

/**
 * Focus on the section heading is SEEN, not just there: the focused heading
 * wears a primary-coloured ring at least two pixels wide (a box shadow, the way
 * Tailwind draws rings), and the ring goes when focus does — so it is the
 * focus that shows, not a border the heading always has.
 */
async function assertHeadingFocusShows(page: Page, label: string) {
  const heading = page.locator('[data-testid="family-heading"]');
  await expect(heading).toBeFocused();
  const ringOf = () =>
    heading.evaluate((el, primary) => {
      const shadow = getComputedStyle(el).boxShadow;
      // Each layer is "<colour> <x> <y> <blur> <spread>"; keep the widest primary one.
      const spreads = shadow
        .split(/,(?![^(]*\))/)
        .map((layer) => layer.trim())
        .filter((layer) => layer.startsWith(primary))
        .map((layer) => Number(/(-?\d+(?:\.\d+)?)px\s*$/.exec(layer)?.[1] ?? 0));
      return spreads.length ? Math.max(...spreads) : 0;
    }, PRIMARY);
  expect(await ringOf(), `${label}: focused heading ring (px)`).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: `test-results/prb-join-modal/${label}-heading-focus.png` });
  await heading.evaluate((el) => (el as HTMLElement).blur());
  expect(await ringOf(), `${label}: ring after blur (px)`).toBe(0);
}

const dialog = (page: Page) => page.locator('[role="dialog"]');
const search = (page: Page) => page.locator('#family-join-search');
const shownAs = (page: Page) => page.locator('#family-join-label');

async function openStandalone(page: Page) {
  await page.goto('/dashboard/products/solo-1');
  await page.waitForSelector('[data-testid="family-join-open"]', { timeout: 30_000 });
}

async function openDialog(page: Page) {
  await page.locator('[data-testid="family-join-open"]').click();
  await expect(dialog(page)).toBeVisible();
  await expect(search(page)).toBeFocused();
}

/** Search, wait for the two groups, pick the first, label it. */
async function searchAndPick(page: Page, label: string) {
  await search(page).fill('Lámp');
  await page.waitForSelector('[data-testid="family-join-candidate-card-1"]', { timeout: 15_000 });
  await expect(page.locator('[data-testid="family-join-candidate-card-2"]')).toBeVisible();
  await expect(page.locator('[data-testid="family-join-candidate-card-1"]')).toContainText('1 child');
  await page.locator('[data-testid="family-join-candidate-card-1"]').click();
  await expect(page.locator('[data-testid="family-join-picked-name"]')).toHaveText('Lámparas');
  await expect(shownAs(page)).toBeFocused();
  await shownAs(page).fill(label);
}

for (const vp of VIEWPORTS) {
  test.describe(`join an existing group · ${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('the section offers a button; the dialog fits, is searched, picked, labelled and submitted', async ({ page }) => {
      await stub(page, []);
      const posted = recordJoins(page);
      const nesting = recordNestingErrors(page);
      await openStandalone(page);

      const panel = page.locator('[data-testid="family-panel"]');
      await expect(panel.locator('[data-testid="standalone-explainer"]')).toBeVisible();
      await expect(dialog(page)).toHaveCount(0);
      await assertNoHorizontalOverflow(page, `initial/${vp.name}`);
      await page.screenshot({ path: `test-results/prb-join-modal/${vp.name}-initial.png`, fullPage: true });

      await openDialog(page);
      await expect(dialog(page)).toHaveAttribute('aria-modal', 'true');
      await expect(dialog(page)).toHaveAttribute('aria-label', 'Add to an existing group');
      await assertDialogFits(page, `open/${vp.name}`);
      await searchAndPick(page, 'Pie');
      await expect(page.locator('[data-testid="family-join-label-count"]')).toHaveText('3/80');
      await assertDialogFits(page, `picked/${vp.name}`);
      await assertNoHorizontalOverflow(page, `picked/${vp.name}`);
      // Enabled, and looking it: the button fades in over 200 ms when it becomes enabled.
      await expect(page.locator('[data-testid="family-join-submit"]')).toBeEnabled();
      await expect(page.locator('[data-testid="family-join-submit"]')).toHaveCSS('opacity', '1');
      await page.screenshot({ path: `test-results/prb-join-modal/${vp.name}-picked.png` });

      await page.locator('[data-testid="family-join-submit"]').click();
      await expect.poll(() => posted.length, { timeout: 10_000 }).toBe(1);
      expect(posted[0].url).toContain('/products/card-1/family/members');
      expect(posted[0].body).toEqual({ productId: 'solo-1', label: 'Pie' });
      await expect(page.getByText('Added to the group')).toBeVisible({ timeout: 10_000 });
      await expect(dialog(page)).toHaveCount(0);
      // The button that opened the dialog is about to go; focus is on the section
      // heading, and it shows — after a pointer submit too.
      await assertHeadingFocusShows(page, `${vp.name}-pointer`);
      expect(nesting).toEqual([]);
    });

    test('a refusal is shown in the dialog as the backend said it, with the group and label kept', async ({ page }) => {
      await stub(page, [{ status: 400, body: { statusCode: 400, message: HIDDEN_REFUSAL, error: 'Bad Request' } }]);
      const posted = recordJoins(page);
      await openStandalone(page);
      await openDialog(page);
      await searchAndPick(page, 'Pie');
      await page.locator('[data-testid="family-join-submit"]').click();

      const notice = dialog(page).locator('[data-testid="family-join-refusal"]');
      await expect(notice).toBeVisible({ timeout: 10_000 });
      await expect(notice).toHaveAttribute('role', 'alert');
      await expect(notice).toContainText('is hidden in "Centro"');
      await expect(notice.locator('[data-testid="family-join-refusal-retry"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="family-join-picked-name"]')).toHaveText('Lámparas');
      await expect(shownAs(page)).toHaveValue('Pie');
      expect(posted.length).toBe(1);
      await assertDialogFits(page, `refused/${vp.name}`);
      await assertNoHorizontalOverflow(page, `refused/${vp.name}`);
      // The same request would only be refused again: it cannot be resent
      // until the label or the group changes.
      await expect(page.locator('[data-testid="family-join-submit"]')).toBeDisabled();
      await page.screenshot({ path: `test-results/prb-join-modal/${vp.name}-refused.png` });
      await shownAs(page).fill('Pie de salón');
      await expect(notice).toHaveCount(0);
      await expect(page.locator('[data-testid="family-join-submit"]')).toBeEnabled();
      await expect(page.locator('[data-testid="family-join-submit"]')).toHaveCSS('opacity', '1');
      expect(posted.length).toBe(1);
    });
  });
}

test.describe('refusals and retry', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('a lifecycle 409 is shown as the refusal it is, with nothing to try again', async ({ page }) => {
    await stub(page, [{ status: 409, body: REMOVED_REFUSAL }]);
    const posted = recordJoins(page);
    await openStandalone(page);
    await openDialog(page);
    await searchAndPick(page, 'Pie');
    await page.locator('[data-testid="family-join-submit"]').click();

    const notice = page.locator('[data-testid="family-join-refusal"]');
    await expect(notice).toContainText('That record has been removed', { timeout: 10_000 });
    await expect(notice.locator('[data-testid="family-join-refusal-retry"]')).toHaveCount(0);
    expect(posted.length).toBe(1);
  });

  test('the lock-retry exhaustion shows "Try again"; the retry sends the same request and succeeds', async ({ page }) => {
    await stub(page, [{ status: 409, body: { statusCode: 409, message: CHANGING_REFUSAL, error: 'Conflict' } }]);
    const posted = recordJoins(page);
    await openStandalone(page);
    await openDialog(page);
    await searchAndPick(page, 'Pie');
    await page.locator('[data-testid="family-join-submit"]').click();

    const notice = page.locator('[data-testid="family-join-refusal"]');
    await expect(notice).toContainText('kept changing', { timeout: 10_000 });
    await notice.locator('[data-testid="family-join-refusal-retry"]').click();

    await expect.poll(() => posted.length, { timeout: 10_000 }).toBe(2);
    expect(posted[1].body).toEqual(posted[0].body);
    await expect(page.getByText('Added to the group')).toBeVisible({ timeout: 10_000 });
    await expect(dialog(page)).toHaveCount(0);
  });

  test('a slow answer for an older search never replaces the answer for the newer one', async ({ page }) => {
    let release!: () => void;
    const until = new Promise<void>((resolve) => (release = resolve));
    await stub(page, [], { text: 'Lá', until });
    await openStandalone(page);
    await openDialog(page);

    await search(page).fill('Lá');
    // Let the debounced request for "Lá" leave, then ask for something narrower.
    await page.waitForRequest((r) => r.url().includes('family=models') && r.url().includes('search=L%C3%A1&'));
    await search(page).fill('Lámparas de');
    await expect(page.locator('[data-testid="family-join-candidate-card-2"]')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('[data-testid="family-join-candidate-card-1"]')).toHaveCount(0);

    // The answer for "Lá" (both groups) arrives last, and changes nothing.
    release();
    await page.waitForResponse((r) => r.url().includes('search=L%C3%A1&'));
    await page.waitForTimeout(300);
    await expect(page.locator('[data-testid="family-join-candidate-card-1"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="family-join-candidate-card-2"]')).toBeVisible();
  });
});

test.describe('keyboard', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('open, search, pick, label and submit without a pointer; focus moves where the next step is', async ({ page }) => {
    await stub(page, []);
    const posted = recordJoins(page);
    await openStandalone(page);

    // The one programmatic step: put the keyboard on the page's button.
    await page.locator('[data-testid="family-join-open"]').focus();
    await page.keyboard.press('Enter');
    await expect(search(page)).toBeFocused();
    await page.keyboard.type('Lámp');
    await page.waitForSelector('[data-testid="family-join-candidate-card-1"]', { timeout: 15_000 });
    await page.keyboard.press('Tab');
    await expect(page.locator('[data-testid="family-join-candidate-card-1"]')).toBeFocused();
    await page.keyboard.press('Enter');
    // Picking takes the keyboard to the label, not back to the top.
    await expect(shownAs(page)).toBeFocused();
    await page.keyboard.type('Pie');
    await page.keyboard.press('Enter');

    await expect.poll(() => posted.length, { timeout: 10_000 }).toBe(1);
    expect(posted[0].body).toEqual({ productId: 'solo-1', label: 'Pie' });
    await assertHeadingFocusShows(page, 'keyboard');
  });

  test('Escape closes the dialog and gives focus back to the button that opened it', async ({ page }) => {
    await stub(page, []);
    await openStandalone(page);
    await page.locator('[data-testid="family-join-open"]').focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toHaveCount(0);
    await expect(page.locator('[data-testid="family-join-open"]')).toBeFocused();
  });

  test('Tab stays inside the dialog', async ({ page }) => {
    await stub(page, []);
    await openStandalone(page);
    await openDialog(page);
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
      expect(inside, `Tab ${i + 1} left the dialog`).toBe(true);
    }
  });
});

test.describe('the group’s own page', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('renders its children table as valid markup: no row inside a row, no hydration error', async ({ page }) => {
    await stub(page, []);
    const nesting = recordNestingErrors(page);
    await page.goto('/dashboard/products/card-1');
    await page.waitForSelector('[data-testid="family-panel"] table', { timeout: 30_000 });

    const shape = await page.locator('[data-testid="family-panel"] table').evaluate((table) => ({
      nested: table.querySelectorAll('tr tr').length,
      headerRows: table.querySelectorAll('thead > tr').length,
      headerCells: Array.from(table.querySelectorAll('thead > tr > th')).map((th) => th.getAttribute('scope')),
      bodyRows: table.querySelectorAll('tbody > tr').length,
    }));
    expect(shape.nested).toBe(0);
    expect(shape.headerRows).toBe(1);
    expect(shape.headerCells.length).toBeGreaterThan(0);
    expect(new Set(shape.headerCells)).toEqual(new Set(['col']));
    expect(shape.bodyRows).toBe(1);
    // Give React a moment to report anything it found.
    await page.waitForTimeout(500);
    expect(nesting).toEqual([]);
  });
});
