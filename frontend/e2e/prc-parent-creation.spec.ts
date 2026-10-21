import { test, expect, type Page } from '@playwright/test';

/**
 * PR C in a real browser: creating a parent card from Add Item.
 *
 * Stubbed data, no backend, nothing mutated. What this proves is what unit
 * tests cannot — that the journey LAYS OUT and is operable at a desktop width
 * and a narrow one, with real pointer clicks and by keyboard alone, and that
 * confirming issues exactly ONE creating request.
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

const ALONE = { id: 'solo-1', name: 'Camiseta Small', slug: 'camiseta-small', status: 'PUBLISHED', price: 80 };
const ALONE2 = { id: 'solo-2', name: 'Camiseta Medium', slug: 'camiseta-medium', status: 'PUBLISHED', price: 95 };
const CARD = {
  id: 'card-1',
  name: 'Silla Nordic',
  slug: 'silla-nordic',
  status: 'PUBLISHED',
  price: 120,
  children: [{ id: 'kid-1', name: 'Silla Nordic Verde', optionLabel: 'Verde' }],
};

async function stub(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace('/api/v1', '');
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
      // The picker asks the SERVER for standalone candidates only.
      const items = url.searchParams.get('family') === 'standalone' ? [ALONE, ALONE2] : [CARD, ALONE, ALONE2];
      return route.fulfill(json({ items, total: items.length, page: 1, limit: 100, totalPages: 1 }));
    }
    if (p === '/products/card-1') return route.fulfill(json({ data: CARD }));
    if (p === '/products/families')
      return route.fulfill(json({ data: { id: 'new-card', name: 'Camiseta', members: 2 } }));
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
  const o = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(o.scroll, `${label}: horizontal overflow`).toBeLessThanOrEqual(o.client + 1);
}

/** Open Add Item and switch it to the card journey. */
async function openCardForm(page: Page) {
  await page.goto('/dashboard/products');
  await page.waitForSelector('tbody tr', { timeout: 30_000 });
  await page.locator('[data-testid="add-item"]').click();
  await page.waitForSelector('[data-testid="new-kind-chooser"]', { timeout: 15_000 });
  await page.locator('[data-testid="new-kind-card"]').click();
  await page.waitForSelector('[data-testid="create-card-form"]', { timeout: 15_000 });
}

for (const vp of VIEWPORTS) {
  test.describe(`creating a parent card · ${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('Add Item asks WHICH kind, and the card form replaces the sellable fields', async ({ page }) => {
      await stub(page);
      await page.goto('/dashboard/products');
      await page.waitForSelector('tbody tr', { timeout: 30_000 });
      await page.locator('[data-testid="add-item"]').click();

      // A single item is the default, and it is today's form.
      await page.waitForSelector('[data-testid="new-kind-chooser"]', { timeout: 15_000 });
      await expect(page.locator('[data-testid="form-branch-section"]')).toBeVisible();

      await page.locator('[data-testid="new-kind-card"]').click();
      await page.waitForSelector('[data-testid="create-card-form"]', { timeout: 15_000 });
      // A card has no price to charge, no stock and no shops of its own.
      await expect(page.locator('[data-testid="form-branch-section"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="card-preview"]')).toContainText(/never sold/i);
      await assertNoHorizontalOverflow(page, `card-form/${vp.name}`);
      await page.screenshot({ path: `test-results/prc-screenshots/prc-card-form-${vp.name}.png`, fullPage: true });
    });

    test('it refuses to save a card with fewer than two children, and says so', async ({ page }) => {
      await stub(page);
      await openCardForm(page);
      await page.locator('[data-testid="card-name"]').fill('Camiseta');
      await expect(page.locator('[data-testid="card-create"]')).toBeDisabled();
      await expect(page.locator('[data-testid="card-problem"]')).toContainText(/at least two/i);

      await page.locator('[data-testid="card-child-search"]').fill('Camiseta');
      await page.waitForSelector('[data-testid="card-candidate-solo-1"]', { timeout: 15_000 });

      // THE SERVER decides what may be a child. The picker asks for
      // `family=standalone`, so an existing card is not in the answer at all —
      // a card cannot become somebody's child, and offering one would invite a
      // three-level hierarchy the model does not have.
      await expect(page.locator('[data-testid="card-candidate-card-1"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="card-candidate-solo-2"]')).toHaveCount(1);

      await page.locator('[data-testid="card-candidate-solo-1"]').click();
      // Still one: a card with a single child is not what this journey makes.
      await expect(page.locator('[data-testid="card-create"]')).toBeDisabled();
      await expect(page.locator('[data-testid="card-problem"]')).toContainText(/at least two/i);
    });

    test('with real pointer clicks it creates the card in ONE request and lands on it', async ({ page }) => {
      await stub(page);
      const posted: { url: string; body: string }[] = [];
      page.on('request', (r) => {
        if (r.method() === 'POST' && r.url().includes('/products/families'))
          posted.push({ url: r.url(), body: r.postData() ?? '' });
      });
      await openCardForm(page);

      await page.locator('[data-testid="card-name"]').fill('Camiseta');
      await page.locator('[data-testid="card-description"]').fill('La ficha de la camiseta');
      await page.locator('[data-testid="card-child-search"]').fill('Camiseta');
      await page.waitForSelector('[data-testid="card-candidate-solo-1"]', { timeout: 15_000 });
      // Ordinary clicks: no force, no dispatchEvent, no keyboard workaround.
      await page.locator('[data-testid="card-candidate-solo-1"]').click();
      await page.locator('[data-testid="card-candidate-solo-2"]').click();

      // Each child gets its own label, prefilled from what its name adds.
      await expect(page.locator('[data-testid="card-label-solo-1"]')).toHaveValue('Small');
      await expect(page.locator('[data-testid="card-label-solo-2"]')).toHaveValue('Medium');
      await expect(page.locator('[data-testid="card-create"]')).toBeEnabled();

      await page.locator('[data-testid="card-create"]').click();
      await page.waitForURL(/\/dashboard\/products\/new-card/, { timeout: 15_000 });

      // EXACTLY ONE creating request, carrying the card AND its children —
      // there is no state in which the card exists without them.
      expect(posted).toHaveLength(1);
      const sent = JSON.parse(posted[0].body) as {
        name: string;
        description?: string;
        members: { id: string; label: string }[];
      };
      expect(sent.name).toBe('Camiseta');
      expect(sent.description).toBe('La ficha de la camiseta');
      expect(sent.members.map((m) => m.id).sort()).toEqual(['solo-1', 'solo-2']);
      for (const m of sent.members) expect(m.label.trim().length).toBeGreaterThan(0);
    });

    test('the whole journey is reachable by keyboard alone', async ({ page }) => {
      await stub(page);
      await openCardForm(page);
      const name = page.locator('[data-testid="card-name"]');
      await name.focus();
      await page.keyboard.type('Camiseta');
      await page.locator('[data-testid="card-child-search"]').focus();
      await page.keyboard.type('Camiseta');
      await page.waitForSelector('[data-testid="card-candidate-solo-1"]', { timeout: 15_000 });
      for (const id of ['solo-1', 'solo-2']) {
        await page.locator(`[data-testid="card-candidate-${id}"]`).focus();
        await page.keyboard.press('Space');
      }
      await expect(page.locator('[data-testid="card-create"]')).toBeEnabled();
      // The label inputs carry an accessible name that says which child.
      const label = page.locator('[data-testid="card-label-solo-1"]');
      expect(await label.getAttribute('aria-label')).toContain('Camiseta Small');
    });
  });
}

test.describe('editing a parent card', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('shows the SORTING price and explains what a card cannot have', async ({ page }) => {
    await stub(page);
    await page.goto('/dashboard/products?edit=card-1');
    await page.waitForSelector('[data-testid="form-card-note"]', { timeout: 30_000 });
    await expect(page.locator('[data-testid="form-card-price"]')).toContainText(/sorting price/i);
    await expect(page.locator('[data-testid="form-card-price"]')).toContainText(/never charged/i);
    await expect(page.locator('[data-testid="form-card-note"]')).toContainText(/never sold/i);
    // The sellable-only controls are not merely disabled — they are absent.
    await expect(page.locator('[data-testid="form-branch-section"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="form-stock-note"]')).toHaveCount(0);
    await page.screenshot({ path: 'test-results/prc-screenshots/prc-card-edit.png', fullPage: true });
  });
});
