import { test, expect, type Page, type BrowserContext, type APIRequestContext } from '@playwright/test';
import { login, loginSlot } from './helpers';

/**
 * A STANDALONE ITEM JOINING AN EXISTING GROUP, browser to backend.
 *
 * The stubbed suite proves the control lays out and sends the request the
 * endpoint accepts; this proves the two halves agree on a real backend and a
 * disposable database: the group the picker finds is a real card, the join
 * lands as `parent_id` in the row, and the refusals a person can reach — a
 * label a sibling already shows, a card that is draft, a card hidden where the
 * item is published — are the backend's own sentences, shown where the form is.
 *
 * Runs against the backend Playwright started (`E2E_API_URL`), never a fixed
 * port, so it cannot be mistaken for a run against the shared stack. One login
 * for the whole file: the limit is five a minute.
 */
const API = process.env.E2E_API_URL || 'http://localhost:3001/api/v1';
const stamp = Date.now().toString(36);
const company = `PRB join ${stamp}`;

test.describe.configure({ mode: 'serial' });

test.describe('joining an existing group, browser to backend', () => {
  let context: BrowserContext;
  let page: Page;
  let api: APIRequestContext;
  let token: string;
  let orgId: string;
  let storeId: string;
  let cardId: string;
  let joiningId: string;
  let refusedId: string;

  const inOrg = (): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    'X-Managed-Organization': orgId,
    ...(storeId ? { 'X-Managed-Store': storeId } : {}),
  });

  const createProduct = async (name: string) => {
    const created = await api.post(`${API}/products`, {
      headers: inOrg(),
      data: { name, price: 10, status: 'PUBLISHED', stockQuantity: 0, trackInventory: false, storeIds: [storeId] },
    });
    expect(created.status(), `create ${name}`).toBe(201);
    return (await created.json()).data.id as string;
  };

  const productOf = async (id: string) => (await (await api.get(`${API}/products/${id}`, { headers: inOrg() })).json()).data;

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
    await page.getByLabel('Client admin email').fill(`prb-join-${stamp}@example.test`);
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

  test('seeds a group of two published items, and two published standalones', async () => {
    const small = await createProduct(`Lámpara ${stamp} pequeña`);
    const medium = await createProduct(`Lámpara ${stamp} mediana`);
    joiningId = await createProduct(`Lámpara ${stamp} grande`);
    refusedId = await createProduct(`Lámpara ${stamp} enorme`);

    const family = await api.post(`${API}/products/families`, {
      headers: inOrg(),
      data: {
        name: `Lámparas ${stamp}`,
        members: [
          { id: small, label: 'Pequeña' },
          { id: medium, label: 'Mediana' },
        ],
      },
    });
    expect(family.status()).toBe(201);
    cardId = (await family.json()).data.id;
    expect(cardId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('from the standalone’s own page: the group is found, and the item becomes its child', async () => {
    await page.goto(`/dashboard/products/${joiningId}`);
    await page.waitForSelector('[data-testid="family-join-open"]', { timeout: 30_000 });
    await page.locator('[data-testid="family-join-open"]').click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await expect(page.locator('[data-testid="standalone-explainer"]')).toBeVisible();

    await page.locator('#family-join-search').fill(`Lámparas ${stamp}`);
    // The picker asks the SERVER for groups: the card is offered, the
    // standalones are not.
    await expect(page.locator(`[data-testid="family-join-candidate-${cardId}"]`)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid^="family-join-candidate-"]')).toHaveCount(1);
    await expect(page.locator(`[data-testid="family-join-candidate-${cardId}"]`)).toContainText('2 children');
    await page.locator(`[data-testid="family-join-candidate-${cardId}"]`).click();
    await page.locator('#family-join-label').fill('Grande');
    await page.locator('[data-testid="family-join-submit"]').click();
    await expect(page.getByText('Added to the group')).toBeVisible({ timeout: 20_000 });

    // The page re-reads the item: it is a child now, listed with its siblings.
    await expect(page.locator('[data-testid="family-panel"]')).toContainText('Pequeña', { timeout: 20_000 });
    await expect(page.locator('[data-testid="family-join"]')).toHaveCount(0);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    // The opener went with the standalone view; focus is on the rebuilt section heading.
    await expect(page.locator('[data-testid="family-heading"]')).toBeFocused();
    await expect(page.locator('[data-testid="family-heading"]')).toContainText(`Lámparas ${stamp}`);
    // ...and the focus is seen: the heading wears the primary-coloured ring.
    await expect(page.locator('[data-testid="family-heading"]')).toHaveCSS('box-shadow', /rgb\(55, 98, 227\) 0px 0px 0px [1-9]/);
    // The family table it now shows is valid markup: one header row of column
    // headers, and no row inside a row.
    const shape = await page.locator('[data-testid="family-panel"] table').evaluate((table) => ({
      nested: table.querySelectorAll('tr tr').length,
      headerRows: table.querySelectorAll('thead > tr').length,
      bodyRows: table.querySelectorAll('tbody > tr').length,
    }));
    expect(shape).toEqual({ nested: 0, headerRows: 1, bodyRows: 3 });

    const joined = await productOf(joiningId);
    expect(joined.parent?.id ?? joined.parent).toBe(cardId);
    expect(joined.optionLabel).toBe('Grande');
    const card = await productOf(cardId);
    expect(card.children.map((c: { id: string }) => c.id)).toContain(joiningId);
    expect(card.children).toHaveLength(3);
  });

  test('a label a sibling already shows is refused by the backend, in its own words', async () => {
    await page.goto(`/dashboard/products/${refusedId}`);
    await page.waitForSelector('[data-testid="family-join-open"]', { timeout: 30_000 });
    await page.locator('[data-testid="family-join-open"]').click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await page.locator('#family-join-search').fill(`Lámparas ${stamp}`);
    await page.locator(`[data-testid="family-join-candidate-${cardId}"]`).click({ timeout: 20_000 });
    await page.locator('#family-join-label').fill('grande');
    await page.locator('[data-testid="family-join-submit"]').click();

    const notice = page.locator('[data-testid="family-join-refusal"]');
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toContainText('already shows as');
    await expect(notice.locator('[data-testid="family-join-refusal-retry"]')).toHaveCount(0);
    // The pick survives the refusal; only the label needs changing.
    await expect(page.locator('[data-testid="family-join-picked"]')).toContainText(`Lámparas ${stamp}`);
    expect((await productOf(refusedId)).parent ?? null).toBeNull();
  });

  test('a DRAFT card cannot take a published item: refused, and the item stays standalone', async () => {
    const drafted = await api.patch(`${API}/products/${cardId}`, { headers: inOrg(), data: { status: 'DRAFT' } });
    expect(drafted.status()).toBe(200);

    // The form is still on the page from the previous step, label and all.
    await page.locator('#family-join-label').fill('Enorme');
    await page.locator('[data-testid="family-join-submit"]').click();

    const notice = page.locator('[data-testid="family-join-refusal"]');
    await expect(notice).toContainText('is draft', { timeout: 20_000 });
    expect((await productOf(refusedId)).parent ?? null).toBeNull();
    expect((await productOf(cardId)).children).toHaveLength(3);
  });

  /**
   * THE HIDDEN CARD, REACHED THROUGH SUPPORTED CALLS ONLY.
   *
   * An existing card cannot be hidden in a branch directly: `PUT
   * :id/stores/:storeId` refuses a card, because a card's branches are derived
   * from its children. But a STANDALONE can be hidden, and `addMember`
   * promotes a childless standalone to a card keeping the branch links it
   * has, visibility included. So: two standalones hidden in the branch, one
   * attached to the other — a published card, hidden in the branch — and a
   * standalone published there is refused by the visibility rule, naming the
   * branch. Each step is an ordinary call; nothing is seeded by hand.
   */
  test('a card made from two items hidden in the branch is a card hidden there: a published item is refused, naming the branch', async () => {
    const hiddenCardId = await createProduct(`Lámpara ${stamp} oculta X`);
    const hiddenChildId = await createProduct(`Lámpara ${stamp} oculta Y`);
    for (const id of [hiddenCardId, hiddenChildId]) {
      const hidden = await api.put(`${API}/products/${id}/stores/${storeId}`, {
        headers: inOrg(),
        data: { published: false },
      });
      expect(hidden.status(), 'a STANDALONE can be hidden in a branch').toBe(200);
    }
    const promoted = await api.post(`${API}/products/${hiddenCardId}/family/members`, {
      headers: inOrg(),
      data: { productId: hiddenChildId, label: 'Y' },
    });
    expect(promoted.status(), 'a hidden child under a hidden card is allowed').toBe(201);

    // What that left: a card, published company-wide, with its one branch
    // link unpublished.
    const card = await productOf(hiddenCardId);
    expect(card.children).toHaveLength(1);
    expect(card.status).toBe('PUBLISHED');
    const links = (card.branchLinks || []).map((l: any) => ({
      store: typeof l.store === 'string' ? l.store : l.store?.id,
      published: !!l.published,
    }));
    expect(links).toEqual([{ store: storeId, published: false }]);

    // From the published standalone's page, that card is a group like any
    // other — until the backend decides.
    await page.goto(`/dashboard/products/${refusedId}`);
    await page.waitForSelector('[data-testid="family-join-open"]', { timeout: 30_000 });
    await page.locator('[data-testid="family-join-open"]').click();
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await page.locator('#family-join-search').fill(`Lámpara ${stamp} oculta X`);
    await page.locator(`[data-testid="family-join-candidate-${hiddenCardId}"]`).click({ timeout: 20_000 });
    await page.locator('#family-join-label').fill('Enorme');
    await page.locator('[data-testid="family-join-submit"]').click();

    const notice = page.locator('[data-testid="family-join-refusal"]');
    await expect(notice).toBeVisible({ timeout: 20_000 });
    await expect(notice).toContainText('is hidden in');
    await expect(notice).toContainText('Publish the parent there first');
    await expect(notice.locator('[data-testid="family-join-refusal-retry"]')).toHaveCount(0);
    expect((await productOf(refusedId)).parent ?? null).toBeNull();
    expect((await productOf(hiddenCardId)).children).toHaveLength(1);
  });
});
