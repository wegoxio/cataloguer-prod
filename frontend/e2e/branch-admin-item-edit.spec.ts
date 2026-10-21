import { test, expect, Page, BrowserContext, APIRequestContext } from '@playwright/test';
import { login, loginSlot, ADMIN_EMAIL, ADMIN_PASSWORD } from './helpers';
import { pivots, query } from './db';

/**
 * THE NARROWED ACTOR'S OWN JOURNEY, IN A REAL BROWSER (#282).
 *
 * A store-bound ADMIN could not save any edit to any item: the form restated
 * the product's current `storeIds` on every save, and `PATCH /products/:id`
 * refuses that key's PRESENCE from a branch-scoped caller. It surfaced while
 * grouping, because the grouping modal tells you to align statuses first — in
 * the item editor.
 *
 * Everything here is that actor's, signed in as itself. The one thing it must
 * NOT be able to see is a sibling branch's price, so the preservation claim is
 * read from the database instead of from the screen.
 *
 * The actor is built through SUPPORTED endpoints — `POST /users` with a role
 * and a branch, then `PATCH /users/:id/password` — so nothing about the account
 * is a fixture invention. The only direct-SQL fixture is the inventory
 * bootstrap, which has no HTTP boundary; see `db.ts`.
 */
const API = 'http://localhost:3001/api/v1';
const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const BRANCH_PASSWORD = 'Wegox-Branch-2026';

test.describe.serial('#282 · a store-bound ADMIN edits, creates and groups', () => {
  let owner: APIRequestContext;
  let branchContext: BrowserContext;
  let page: Page;

  let organizationId: string;
  let storeA: string;
  let storeB: string;
  let branchEmail: string;
  let branchToken: string;
  let existingItem: string;
  let secondItem: string;

  const asOwner = (token: string) => ({ Authorization: `Bearer ${token}`, 'X-Managed-Organization': organizationId });

  test.beforeAll(async ({ browser, playwright }) => {
    owner = await playwright.request.newContext();
    await loginSlot();
    const session = await owner.post(`${API}/auth/login`, {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    const token = (await session.json()).data.accessToken;

    // A company of this suite's own: one branch from onboarding, a second added
    // so there is a SIBLING whose price the narrowed actor must never move.
    const onboarded = await owner.post(`${API}/organizations/onboard`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        // CRECIMIENTO, because BASICO allows a single website and this suite
        // needs a SIBLING branch whose price the narrowed actor must not move.
        organization: { name: `Branch Admin ${tag}`, plan: 'CRECIMIENTO' },
        store: { name: `Branch Admin ${tag}` },
        manager: { email: `branch-mgr-${tag}@example.com` },
      },
    });
    expect(onboarded.status()).toBe(201);
    const created = (await onboarded.json()).data;
    organizationId = created.organization.id;
    storeA = created.store.id;

    const second = await owner.post(`${API}/stores`, {
      headers: asOwner(token),
      data: { name: `Sibling ${tag}`, organizationId },
    });
    expect(second.status()).toBe(201);
    storeB = (await second.json()).data.id;

    // The inventory prerequisite an ordinary item save needs. Without it the
    // save fails on something that has nothing to do with #282.

    // Two items in the actor's branch, plus a DIFFERENT price in the sibling.
    for (const name of ['Camiseta Roja', 'Camiseta Azul']) {
      const item = await owner.post(`${API}/products`, {
        headers: asOwner(token),
        data: { name: `${name} ${tag}`, price: 10, status: 'DRAFT', stockQuantity: 0, trackInventory: false,
                storeIds: [storeA] },
      });
      expect(item.status()).toBe(201);
      const id = (await item.json()).data.id;
      if (!existingItem) existingItem = id;
      else secondItem = id;

      // Supported single-store assignment, not SQL: the sibling membership and
      // its override are created the way the product creates them.
      const assigned = await owner.put(`${API}/products/${id}/stores/${storeB}`, {
        headers: asOwner(token),
        data: { published: true, price: 19.99 },
      });
      expect(assigned.status()).toBe(200);
    }

    // The actor itself: a real ADMIN bound to branch A, with a password set
    // through the supported administrative route.
    branchEmail = `branch-admin-${tag}@example.com`;
    const user = await owner.post(`${API}/users`, {
      headers: asOwner(token),
      data: { email: branchEmail, role: 'ADMIN', storeId: storeA, company: `Branch Admin ${tag}` },
    });
    expect(user.status()).toBe(201);
    const branchUserId = (await user.json()).data.id;
    const password = await owner.patch(`${API}/users/${branchUserId}/password`, {
      headers: asOwner(token),
      data: { password: BRANCH_PASSWORD },
    });
    expect(password.status()).toBe(200);

    // A token of the branch actor's own for the raw HTTP probes. The panel
    // keeps the browser's token in memory in some builds, so reading it out of
    // localStorage yields an anonymous 401 that says nothing about #282.
    await loginSlot();
    const branchSession = await owner.post(`${API}/auth/login`, {
      data: { email: branchEmail, password: BRANCH_PASSWORD },
    });
    expect(branchSession.status()).toBe(201);
    branchToken = (await branchSession.json()).data.accessToken;

    // And signed in AS THAT ACTOR in the browser for every test below.
    branchContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await branchContext.newPage();
    await login(page, branchEmail, BRANCH_PASSWORD);
  });

  test.afterAll(async () => {
    await branchContext?.close();
    await owner?.dispose();
  });

  const openEditor = async (id: string) => {
    await page.goto(`/dashboard/products?edit=${id}`);
    await expect(page.locator('form input[name="name"]')).toBeVisible({ timeout: 30_000 });
  };

  const submit = async (label = /Save Product|Guardar/i) => page.getByRole('button', { name: label }).click();

  test('the branch actor is genuinely narrowed', async () => {
    const me = await owner.get(`${API}/auth/me`, { headers: { Authorization: `Bearer ${branchToken}` } });
    const scope = (await me.json())?.data?.scope ?? null;
    // If this actor were company-wide the rest of the file would prove nothing.
    expect(scope?.storeId).toBe(storeA);
    expect(scope?.role).toBe('ADMIN');
  });

  test('the membership controls are ABSENT and replaced by truthful context', async () => {
    await openEditor(existingItem);

    await expect(page.locator('[data-testid="form-branch-section"]')).toHaveCount(0);
    const note = page.locator('[data-testid="form-branch-readonly"]');
    await expect(note).toBeVisible();
    await expect(note).toContainText(/set for the whole company and are not edited here|para toda la empresa/i);
    await expect(note).toContainText(/leaves them exactly as they are|los deja exactamente como están/i);

    // No control for something this actor may not decide — not even a disabled
    // one. Scoped to STORE controls: `trackInventory` is an ordinary checkbox
    // on this form and is none of #282's business.
    await expect(page.locator('form label').filter({ hasText: `Branch Admin ${tag}` })).toHaveCount(0);
    await expect(page.locator('form label').filter({ hasText: `Sibling ${tag}` })).toHaveCount(0);
    await expect(page.locator('form input[placeholder="Price (base)"]')).toHaveCount(0);
    await expect(page.locator('form input[placeholder="Sale (base)"]')).toHaveCount(0);
    // And the note names no branch, because this actor cannot see them all.
    await expect(note).not.toContainText(new RegExp(`Sibling ${tag}`));
  });

  test('EDITING omits both properties, succeeds, and moves no pivot row', async () => {
    const before = pivots([existingItem, secondItem]);
    expect(before).toHaveLength(4); // two items x two branches

    await openEditor(existingItem);
    const request = page.waitForRequest(
      (r) => r.method() === 'PATCH' && r.url().includes(`/products/${existingItem}`),
      { timeout: 30_000 },
    );
    const answered = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().includes(`/products/${existingItem}`),
      { timeout: 30_000 },
    );
    // The status alignment the grouping journey asks for.
    await page.locator('form select').first().selectOption('PUBLISHED');
    await submit();

    const body = JSON.parse((await request).postData() ?? '{}');
    expect(Object.keys(body)).not.toContain('storeIds');
    expect(Object.keys(body)).not.toContain('storePrices');
    expect(JSON.stringify(body)).not.toMatch(/storeIds|storePrices/);

    // No alternative failure is acceptable: the save must succeed.
    expect((await answered).status()).toBe(200);
    expect(query<{ status: string }>(`select status from products where id = '${existingItem}'::uuid`)[0].status).toBe(
      'PUBLISHED',
    );

    // Every membership and every override, including the sibling's 19.99 this
    // actor cannot see, exactly as they were.
    expect(pivots([existingItem, secondItem])).toEqual(before);
  });

  test('CREATING omits both, succeeds, and lands in EXACTLY the resolved store', async () => {
    await page.goto('/dashboard/products');
    await page.getByRole('button', { name: /Add Item|Nuevo art/i }).click();
    await expect(page.locator('form input[name="name"]')).toBeVisible({ timeout: 20_000 });

    // The same absence on the create path.
    await expect(page.locator('[data-testid="form-branch-section"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="form-branch-readonly"]')).toBeVisible();

    const name = `Creado ${tag}`;
    await page.locator('form input[name="name"]').fill(name);
    await page.locator('form input[name="price"]').fill('25');

    const request = page.waitForRequest(
      (r) => r.method() === 'POST' && r.url().endsWith('/api/v1/products'),
      { timeout: 30_000 },
    );
    const answered = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith('/api/v1/products'),
      { timeout: 30_000 },
    );
    await submit();

    const body = JSON.parse((await request).postData() ?? '{}');
    expect(JSON.stringify(body)).not.toMatch(/storeIds|storePrices/);
    expect((await answered).status()).toBe(201);

    // The backend assigned the branch: exactly one membership row, and it is
    // the actor's own store. Not global, and not no-store.
    const rows = query<{ store_id: string }>(`
      select sp.store_id from store_products sp
        join products p on p.id = sp.product_id
       where p.name = '${name}' and p.organization_id = '${organizationId}'::uuid
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].store_id).toBe(storeA);
  });

  test('the status correction is followed by successful GROUPING', async () => {
    // The second item needs the same status before the two can be grouped —
    // through the editor, which is the step that used to 403.
    await openEditor(secondItem);
    const answered = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().includes(`/products/${secondItem}`),
      { timeout: 30_000 },
    );
    await page.locator('form select').first().selectOption('PUBLISHED');
    await submit();
    expect((await answered).status()).toBe(200);

    // And now the operation the operator came to do.
    const family = await owner.post(`${API}/products/families`, {
      headers: { Authorization: `Bearer ${branchToken}` },
      data: {
        name: `Camiseta ${tag}`,
        members: [
          { id: existingItem, label: 'Roja' },
          { id: secondItem, label: 'Azul' },
        ],
      },
    });
    expect(family.status()).toBe(201);
    const parentId = (await family.json()).data.id;
    const children = query<{ c: number }>(
      `select count(*)::int as c from products where parent_id = '${parentId}'::uuid`,
    );
    expect(children[0].c).toBe(2);
  });

  /**
   * THE BOUNDARY, UNCHANGED. #282 removed a control the panel should never have
   * offered; it did not make the operation available to this actor by another
   * route.
   */
  test('a hand-crafted storeIds request from this actor is STILL 403, and moves nothing', async () => {
    const before = pivots([existingItem, secondItem]);

    for (const storeIds of [[storeA], []]) {
      const refused = await owner.patch(`${API}/products/${existingItem}`, {
        headers: { Authorization: `Bearer ${branchToken}` },
        data: { storeIds },
      });
      expect(refused.status()).toBe(403);
    }

    expect(pivots([existingItem, secondItem])).toEqual(before);
  });
});
