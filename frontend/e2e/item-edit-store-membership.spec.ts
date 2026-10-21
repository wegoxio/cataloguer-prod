import { test, expect, Page, BrowserContext, APIRequestContext } from '@playwright/test';
import { login, ADMIN_EMAIL, ADMIN_PASSWORD } from './helpers';

/**
 * THE ITEM EDITOR IN A REAL BROWSER, AT BOTH WIDTHS (#282).
 *
 * The defect was that this form always sent `storeIds`, so a branch-scoped
 * actor could not save any edit at all. The fix gates the membership section on
 * an explicit capability, so what is worth seeing in a browser is that the
 * COMPANY-WIDE path is unchanged — the section is there, the save still carries
 * membership, the server still accepts it — and that none of it is a function
 * of viewport width.
 *
 * WHAT THIS FILE DOES NOT COVER, and why: the seeded development database has
 * one platform administrator and no store-bound ADMIN, and minting one would
 * add a user fixture every other suite would then inherit. The narrowed actor's
 * journey is proved instead against a real database in
 * `backend/src/modules/products/branch-actor-item-edit.pg.spec.ts`, which drives
 * the same edit → preserve → group sequence and asserts the pivot rows of a
 * sibling branch. That is stronger evidence than a browser could give, because
 * a browser cannot read the sibling branch's price.
 */
const API = 'http://localhost:3001/api/v1';
const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

test.describe.serial('#282 · the item editor and store membership', () => {
  let context: BrowserContext;
  let page: Page;
  let api: APIRequestContext;
  let token: string;
  let organizationId: string;
  let productId: string;

  const inOrg = () => ({ Authorization: `Bearer ${token}`, 'X-Managed-Organization': organizationId });

  test.beforeAll(async ({ browser, playwright }) => {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    api = await playwright.request.newContext();
    await login(page);

    const session = await api.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    token = (await session.json()).data.accessToken;

    // A company of this suite's own, so nothing depends on what another suite
    // left behind. One branch — which is also the shape the owner reported.
    const onboarded = await api.post(`${API}/organizations/onboard`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        organization: { name: `Item Edit ${tag}` },
        // Same name for both, exactly as the Clients screen sends it — the
        // clients table lists STORES, so this is the row the test looks for.
        store: { name: `Item Edit ${tag}` },
        manager: { email: `item-edit-${tag}@example.com` },
      },
    });
    expect(onboarded.status()).toBe(201);
    organizationId = (await onboarded.json()).data.organization.id;

    // The inventory prerequisite an ordinary item save needs. Without it the
    // save is refused by something that has nothing to do with #282, and a test
    // that tolerated that refusal would prove nothing about the workflow.

    const created = await api.post(`${API}/products`, {
      headers: inOrg(),
      data: { name: `Camiseta ${tag}`, price: 10, status: 'DRAFT', stockQuantity: 0, trackInventory: false },
    });
    expect(created.status()).toBe(201);
    productId = (await created.json()).data.id;
  });

  test.afterAll(async () => {
    await context?.close();
    await api?.dispose();
  });

  /** Enters the company in the panel, so the catalogue modules are reachable. */
  const enterCompany = async () => {
    await page.goto('/dashboard/clients');
    await page
      .getByRole('row', { name: new RegExp(`Item Edit ${tag}`) })
      .getByRole('button', { name: 'Manage' })
      .click();
    await expect(page.getByText('Managing company')).toBeVisible({ timeout: 20_000 });
    await page.reload();
  };

  const openEditor = async () => {
    // The page's own supported entry point, so the test does not depend on
    // which icon a table row happens to render.
    await page.goto(`/dashboard/products?edit=${productId}`);
    await expect(page.locator('form input[name="name"]')).toBeVisible({ timeout: 30_000 });
  };

  test('a company-wide actor sees the branch section at desktop AND narrow widths', async () => {
    await enterCompany();
    await openEditor();

    await expect(page.locator('[data-testid="form-branch-section"]')).toBeVisible();
    await expect(page.locator('[data-testid="form-branch-readonly"]')).toHaveCount(0);

    // The same form at 390px. Presence must not depend on the viewport, which
    // is the only way a width could change who may do what.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('[data-testid="form-branch-section"]')).toBeVisible();
    await expect(page.locator('[data-testid="form-branch-readonly"]')).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('saving as a company-wide actor still sends storeIds and storePrices, and succeeds', async () => {
    await openEditor();

    const write = page.waitForRequest(
      (r) => r.method() === 'PATCH' && r.url().includes(`/products/${productId}`),
      { timeout: 30_000 },
    );
    const answered = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().includes(`/products/${productId}`),
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: /Save Product|Guardar/i }).click();

    const body = JSON.parse((await write).postData() ?? '{}');
    // Unchanged behaviour for the actor who may replace membership.
    expect(Object.keys(body)).toContain('storeIds');
    expect(Object.keys(body)).toContain('storePrices');

    // The save SUCCEEDS. No alternative status is acceptable: a test that
    // accepted a failure would not show that the workflow works.
    expect((await answered).status()).toBe(200);
  });

  /**
   * THE BOUNDARY ITSELF, over HTTP rather than trusted. `X-Managed-Store`
   * genuinely narrows the resolved scope, so this is a branch-scoped caller —
   * and #282 must not have made it welcome.
   */
  test('the endpoint still refuses a whole-set replacement from a branch-scoped caller', async () => {
    const stores = await (await api.get(`${API}/stores`, { headers: inOrg() })).json();
    const list = Array.isArray(stores) ? stores : (stores.items ?? stores.data ?? []);
    expect(list.length).toBeGreaterThan(0);

    const refused = await api.patch(`${API}/products/${productId}`, {
      headers: { ...inOrg(), 'X-Managed-Store': list[0].id },
      data: { storeIds: [list[0].id] },
    });
    expect(refused.status()).toBe(403);

    // And the same narrowed caller may still change everything else.
    const allowed = await api.patch(`${API}/products/${productId}`, {
      headers: { ...inOrg(), 'X-Managed-Store': list[0].id },
      data: { status: 'PUBLISHED' },
    });
    expect(allowed.status()).toBe(200);
  });
});
