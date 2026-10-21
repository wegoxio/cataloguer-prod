import { test, expect, type Page, type BrowserContext, type APIRequestContext } from '@playwright/test';
import { login, loginSlot } from './helpers';

/**
 * The parent/child journey end to end: a real browser, the real dashboard, the
 * real backend, a disposable seeded database. Nothing is stubbed.
 *
 * The stubbed suites prove the interface lays out and behaves; this proves the
 * two halves agree — that what the dashboard sends is what the endpoint
 * accepts, that the card it creates is the card the rules describe, and that
 * the refusals a person can reach really are refusals.
 *
 * One login for the whole file: the limit is five a minute.
 */
const API = 'http://localhost:3001/api/v1';
const stamp = Date.now().toString(36);
const company = `PRC ${stamp}`;

test.describe.configure({ mode: 'serial' });

test.describe('parent/child, browser to backend', () => {
  let context: BrowserContext;
  let page: Page;
  let api: APIRequestContext;
  let token: string;
  let orgId: string;
  let storeId: string;

  const inOrg = (): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    'X-Managed-Organization': orgId,
    ...(storeId ? { 'X-Managed-Store': storeId } : {}),
  });

  test.beforeAll(async ({ browser, playwright }) => {
    await loginSlot();
    context = await browser.newContext();
    page = await context.newPage();
    api = await playwright.request.newContext();
    await login(page);
  });

  test.afterAll(async () => {
    await context?.close();
    await api?.dispose();
  });

  test('onboards a company and enters its catalogue', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Clients' }).click();
    await page.getByRole('button', { name: 'New Client' }).click();
    await page.getByLabel('Company name').fill(company);
    await page.getByLabel('Client admin email').fill(`prc-${stamp}@example.test`);
    await page.getByRole('button', { name: 'Create and invite' }).click();
    await expect(page.getByText(company).first()).toBeVisible({ timeout: 20_000 });

    await page
      .getByRole('row', { name: new RegExp(company) })
      .getByRole('button', { name: 'Manage' })
      .click();
    await expect(page.getByText('Managing company')).toBeVisible({ timeout: 20_000 });
    await page.reload();

    const managed = await page.evaluate(() => window.localStorage.getItem('wegox-managed-tenant'));
    orgId = (JSON.parse(managed as string) as { organizationId: string }).organizationId;
    expect(orgId).toMatch(/^[0-9a-f-]{36}$/);
    token = (await page.evaluate(() => window.localStorage.getItem('wegox-access-token'))) as string;
    if (!token) {
      // The panel keeps the token in memory in some builds; take one directly.
      const res = await api.post(`${API}/auth/login`, {
        data: { email: process.env.DEV_ADMIN_EMAIL || 'admin@wegox.com', password: process.env.DEV_ADMIN_PASSWORD || 'superadmin123' },
      });
      token = (await res.json()).data.accessToken;
    }
    const stores = await (await api.get(`${API}/stores`, { headers: inOrg() })).json();
    const list = Array.isArray(stores) ? stores : (stores.items ?? stores.data ?? []);
    expect(list.length, 'the onboarded company has a website').toBeGreaterThan(0);
    storeId = list[0].id;
  });

  test('creates two standalone items through the real Add Item form', async () => {
    for (const [name, price] of [
      [`Camiseta ${stamp} Small`, '10'],
      [`Camiseta ${stamp} Medium`, '20'],
    ]) {
      await page.getByRole('navigation').getByRole('link', { name: 'Items' }).click();
      await expect(page).toHaveURL(/\/dashboard\/products/, { timeout: 20_000 });
      await page.locator('[data-testid="add-item"]').click();
      await expect(page.locator('[data-testid="new-kind-chooser"]')).toBeVisible({ timeout: 20_000 });
      await page.getByLabel('Name', { exact: true }).fill(name);
      await page.getByLabel('Regular Price ($)').fill(price);
      // A child must already belong to a shop, so the item is put in one here.
      await page.locator('[data-testid="form-branch-section"] input[type="checkbox"]').first().check();
      await page.getByRole('button', { name: /save product/i }).click();
      await expect(page.getByRole('cell', { name })).toBeVisible({ timeout: 20_000 });
    }
  });

  test('REFUSES a card with fewer than two children, and creates nothing', async () => {
    const before = await (await api.get(`${API}/products?limit=100`, { headers: inOrg() })).json();
    const countBefore = (before.items ?? []).length;

    const res = await api.post(`${API}/products/families`, {
      headers: inOrg(),
      data: { name: `Solo ${stamp}`, members: [{ id: (before.items ?? [])[0].id, label: 'Small' }] },
    });
    expect(res.status()).toBe(400);
    expect((await res.text()).toLowerCase()).toContain('at least two');

    const after = await (await api.get(`${API}/products?limit=100`, { headers: inOrg() })).json();
    expect((after.items ?? []).length).toBe(countBefore);
  });

  test('REFUSES an unknown property — the DTO the route never had', async () => {
    const items = (await (await api.get(`${API}/products?limit=100`, { headers: inOrg() })).json()).items ?? [];
    const res = await api.post(`${API}/products/families`, {
      headers: inOrg(),
      data: {
        name: `Bad ${stamp}`,
        sku: 'NOT-ALLOWED',
        members: items.slice(0, 2).map((p: any, i: number) => ({ id: p.id, label: `L${i}` })),
      },
    });
    expect(res.status()).toBe(400);
  });

  test('creates the card and its two children in ONE act, through the browser', async () => {
    await page.getByRole('navigation').getByRole('link', { name: 'Items' }).click();
    await expect(page).toHaveURL(/\/dashboard\/products/, { timeout: 20_000 });
    await page.locator('[data-testid="add-item"]').click();
    await page.locator('[data-testid="new-kind-card"]').click();
    await expect(page.locator('[data-testid="create-card-form"]')).toBeVisible({ timeout: 20_000 });

    await page.locator('[data-testid="card-name"]').fill(`Camiseta ${stamp}`);
    await page.locator('[data-testid="card-description"]').fill('La ficha de la camiseta');
    await page.locator('[data-testid="card-child-search"]').fill(`Camiseta ${stamp}`);
    // The picker asks the SERVER for standalone candidates.
    await expect(page.locator('[data-testid^="card-candidate-"]')).toHaveCount(2, { timeout: 20_000 });
    for (const box of await page.locator('[data-testid^="card-candidate-"]').all()) await box.click();
    await expect(page.locator('[data-testid="card-create"]')).toBeEnabled();
    await page.locator('[data-testid="card-create"]').click();

    // It lands on the card it just made.
    await expect(page).toHaveURL(/\/dashboard\/products\/[0-9a-f-]{36}/, { timeout: 30_000 });
    // Exact: the family panel's own heading also contains the card's name.
    await expect(page.getByRole('heading', { name: `Camiseta ${stamp}`, exact: true })).toBeVisible({
      timeout: 20_000,
    });
    // Its own budget: the first visit to this route compiles it in dev, and a
    // 5s default is what makes a cold compile look like a missing element.
    await expect(page.locator('[data-testid="detail-not-purchasable"]')).toBeVisible({ timeout: 20_000 });
  });

  test('the saved card obeys the parent field model, and its children still sell', async () => {
    const items = (await (await api.get(`${API}/products?limit=100`, { headers: inOrg() })).json()).items ?? [];
    const card = items.find((p: any) => p.name === `Camiseta ${stamp}`);
    expect(card, 'the card exists').toBeTruthy();

    const full = (await (await api.get(`${API}/products/${card.id}`, { headers: inOrg() })).json()).data;
    expect(full.children).toHaveLength(2);
    // The card owns its copy...
    expect(full.description).toBe('La ficha de la camiseta');
    // ...and carries none of the sellable-item state.
    expect(full.sku ?? null).toBeNull();
    expect(full.manufacturerCode ?? null).toBeNull();
    expect(full.salePrice ?? null).toBeNull();
    expect(full.trackInventory).toBe(false);
    // Its shops are DERIVED from its children.
    expect((full.stores ?? []).length).toBeGreaterThan(0);

    // Every child is still an ordinary purchasable item with its own price.
    for (const child of full.children) {
      const kid = (await (await api.get(`${API}/products/${child.id}`, { headers: inOrg() })).json()).data;
      expect(Number(kid.price)).toBeGreaterThan(0);
      expect(kid.parent?.id ?? kid.parent).toBe(card.id);
    }
  });

  test('the boundary refuses what the card form hides', async () => {
    const items = (await (await api.get(`${API}/products?limit=100`, { headers: inOrg() })).json()).items ?? [];
    const card = items.find((p: any) => p.name === `Camiseta ${stamp}`);

    for (const [body, needle] of [
      [{ stockQuantity: 5 }, 'stock'],
      [{ trackInventory: true }, 'inventory'],
      [{ salePrice: 3 }, 'sale price'],
      [{ cost: 2 }, 'cost'],
      [{ sku: 'NEW-1' }, 'sku'],
    ] as [Record<string, unknown>, string][]) {
      const res = await api.patch(`${API}/products/${card.id}`, { headers: inOrg(), data: body });
      expect(res.status(), `PATCH ${JSON.stringify(body)} must be refused`).toBe(400);
      expect((await res.text()).toLowerCase()).toContain(needle.split(' ')[0]);
    }

    // The card's own fields are still editable, sorting price included.
    const ok = await api.patch(`${API}/products/${card.id}`, { headers: inOrg(), data: { price: 42 } });
    expect(ok.status()).toBe(200);
  });

  test('a parent is absent from the supplier picker source', async () => {
    const res = await api.get(`${API}/products?limit=100&excludeParents=true`, { headers: inOrg() });
    const items = (await res.json()).items ?? [];
    expect(items.some((p: any) => p.name === `Camiseta ${stamp}`)).toBe(false);
    expect(items.length).toBeGreaterThan(0);
  });

  test('editing the card shows the SORTING price and hides what it cannot have', async () => {
    const items = (await (await api.get(`${API}/products?limit=100`, { headers: inOrg() })).json()).items ?? [];
    const card = items.find((p: any) => p.name === `Camiseta ${stamp}`);
    await page.goto(`/dashboard/products?edit=${card.id}`);
    await expect(page.locator('[data-testid="form-card-note"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="form-card-price"]')).toContainText(/sorting price/i);
    await expect(page.locator('[data-testid="form-branch-section"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="form-stock-note"]')).toHaveCount(0);
  });
});
