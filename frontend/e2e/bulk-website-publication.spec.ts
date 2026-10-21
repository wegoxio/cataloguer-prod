import { test, expect, Page, BrowserContext, APIRequestContext } from '@playwright/test';
import { login, ADMIN_EMAIL, ADMIN_PASSWORD } from './helpers';

/**
 * BULK WEBSITE PUBLICATION IN A REAL BROWSER (ADR 029).
 *
 * The journey the owner described: products that are globally Published and
 * assigned to a website yet "Hidden here" on it, fixed many at a time without
 * detaching anything. What only a browser can show:
 *
 *   - the Branch + Branch publication filters narrow the list to the hidden
 *     members of ONE website, and the rows say "Hidden here";
 *   - the page checkbox selects them, the bar offers "Website publication",
 *     the dialog decides nothing on its own, and the result panel counts
 *     Updated / Already in that state / Skipped parent cards / Failed;
 *   - a parent card in the selection is SKIPPED, not failed;
 *   - afterwards the website's own API key sees the children (and the card),
 *     and every branch row still exists with its values.
 *
 * Runs against the backend Playwright started (`E2E_API_URL`), never a fixed
 * developer stack, and creates its own company so nothing depends on another
 * suite's leftovers.
 */
const API = process.env.E2E_API_URL || 'http://localhost:3001/api/v1';
const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

test.describe.serial('ADR 029 · bulk website publication', () => {
  let context: BrowserContext;
  let page: Page;
  let api: APIRequestContext;
  let token: string;
  let organizationId: string;
  let storeA: string;
  let storeB: string;
  let standalone: string;
  let child1: string;
  let child2: string;
  let card: string;
  let apiKey: string;

  const inOrg = () => ({ Authorization: `Bearer ${token}`, 'X-Managed-Organization': organizationId });

  const createProduct = async (name: string, storeIds: string[]) => {
    const created = await api.post(`${API}/products`, {
      headers: inOrg(),
      data: { name, price: 10, status: 'PUBLISHED', stockQuantity: 0, trackInventory: false, storeIds },
    });
    expect(created.status()).toBe(201);
    return (await created.json()).data.id as string;
  };
  /** The single-product writer, used only to set the STARTING state. */
  const hideOn = async (productId: string, storeId: string) => {
    const r = await api.put(`${API}/products/${productId}/stores/${storeId}`, {
      headers: inOrg(),
      data: { published: false },
    });
    expect(r.status()).toBe(200);
  };
  const linksOf = async (productId: string) => {
    const r = await api.get(`${API}/products/${productId}`, { headers: inOrg() });
    expect(r.status()).toBe(200);
    const product = (await r.json()).data;
    return (product.branchLinks || []).map((l: any) => ({
      store: typeof l.store === 'string' ? l.store : l.store?.id,
      published: !!l.published,
      price: l.price ?? null,
      leadTimeDays: l.leadTimeDays ?? null,
    }));
  };
  const publicSlugs = async (): Promise<string[]> => {
    const r = await api.get(`${API}/public/products?limit=50`, { headers: { 'X-Api-Key': apiKey } });
    expect(r.status()).toBe(200);
    const body = await r.json();
    const items: Array<{ slug: string }> = body.items ?? body.data ?? [];
    return items.map((p) => p.slug).sort();
  };

  test.beforeAll(async ({ browser, playwright }) => {
    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    api = await playwright.request.newContext();
    await login(page);

    const session = await api.post(`${API}/auth/login`, { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    token = (await session.json()).data.accessToken;

    // A company of this suite's own, with TWO websites so the Branch filter is
    // offered and "the other website" is a real sibling row. The default plan
    // (BASICO) includes one website, so the company is onboarded on a plan
    // with room for a second.
    const onboarded = await api.post(`${API}/organizations/onboard`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        organization: { name: `Bulk Pub ${tag}`, plan: 'CRECIMIENTO' },
        store: { name: `Elite ${tag}` },
        manager: { email: `bulk-pub-${tag}@example.com` },
      },
    });
    expect(onboarded.status()).toBe(201);
    const onboardedBody = (await onboarded.json()).data;
    organizationId = onboardedBody.organization.id;
    storeA = onboardedBody.store?.id;
    if (!storeA) {
      const stores = await api.get(`${API}/stores`, { headers: inOrg() });
      storeA = (await stores.json()).data.find((s: any) => s.name === `Elite ${tag}`).id;
    }
    // The store DTO names its owner explicitly (`A store must belong to an organization`).
    const second = await api.post(`${API}/stores`, {
      headers: inOrg(),
      data: { name: `Norte ${tag}`, slug: `norte-${tag}`, organizationId },
    });
    expect(second.status(), await second.text()).toBe(201);
    storeB = (await second.json()).data.id;

    // Creating with storeIds mints PUBLISHED links (the membership writer's
    // default); the starting state of the journey is "hidden here" on Elite.
    standalone = await createProduct(`Cuaderno ${tag}`, [storeA, storeB]);
    child1 = await createProduct(`Silla ${tag} Verde`, [storeA]);
    child2 = await createProduct(`Silla ${tag} Azul`, [storeA]);
    for (const id of [standalone, child1, child2]) await hideOn(id, storeA);

    const family = await api.post(`${API}/products/families`, {
      headers: inOrg(),
      data: {
        name: `Silla ${tag}`,
        members: [
          { id: child1, label: 'Verde' },
          { id: child2, label: 'Azul' },
        ],
      },
    });
    expect(family.status()).toBe(201);
    card = (await family.json()).data.id;

    // The website's own key, so the AFTER state is read exactly as a visitor
    // would read it.
    const key = await api.post(`${API}/api-keys`, {
      headers: inOrg(),
      data: { name: `bulk-pub-${tag}`, storeId: storeA, capabilities: ['CATALOGUE_READ'] },
    });
    expect(key.status()).toBe(201);
    const keyBody = (await key.json()).data;
    apiKey = keyBody.key ?? keyBody.plaintext ?? keyBody.token;
    expect(typeof apiKey).toBe('string');
  });

  test.afterAll(async () => {
    await context?.close();
    await api?.dispose();
  });

  const enterCompany = async () => {
    await page.goto('/dashboard/clients');
    await page
      .getByRole('row', { name: new RegExp(`Elite ${tag}`) })
      .getByRole('button', { name: 'Manage' })
      .click();
    await expect(page.getByText('Managing company')).toBeVisible({ timeout: 20_000 });
    await page.reload();
  };

  const openFiltersForBranch = async (storeId: string) => {
    await page.goto('/dashboard/products');
    await page.waitForSelector('tbody tr', { timeout: 30_000 });
    await page.getByRole('button', { name: /Filters/ }).click();
    // The shared Select renders its label as a sibling of the control.
    await page.locator('div:has(> label:text-is("Branch")) select').selectOption(storeId);
    await expect(page.locator('[data-testid="filter-branch-published"]')).toBeVisible();
  };

  test('the filters narrow the list to the hidden members of one website, and the rows say so', async () => {
    await enterCompany();
    await openFiltersForBranch(storeA);
    await page.locator('[data-testid="filter-branch-published"]').selectOption('false');
    await page.waitForSelector('[data-testid^="branch-state-"]', { timeout: 30_000 });

    // The two children and the standalone are hidden on Elite; the card is a
    // member (derived) and published there, so it is NOT in this view.
    for (const id of [standalone, child1, child2]) {
      await expect(page.locator(`[data-testid="branch-state-${id}"]`)).toHaveText('Hidden here');
    }
    await expect(page.locator(`[data-testid="branch-state-${card}"]`)).toHaveCount(0);
    expect(await publicSlugs()).toEqual([]);
  });

  test('Website publication → Publish here updates every hidden member and the website sees them', async () => {
    const before = { standalone: await linksOf(standalone), child1: await linksOf(child1) };

    await page.locator('[data-testid="select-all-on-page"]').check();
    await expect(page.locator('[data-testid="bulk-website-publication"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-testid="bulk-website-publication"]').click();

    // The website is pre-selected from the filter; the action is not.
    const dialog = page.locator('[data-testid="website-publication-modal"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-testid="wp-store"]')).toHaveValue(storeA);
    await expect(dialog.locator('[data-testid="wp-submit"]')).toBeDisabled();
    await dialog.locator('[data-testid="wp-publish"]').check();
    await expect(dialog.locator('[data-testid="wp-confirm-text"]')).toContainText(`will be shown on Elite ${tag}`);
    await dialog.locator('[data-testid="wp-submit"]').click();

    const result = page.locator('[data-testid="wp-result"]');
    await expect(result).toBeVisible({ timeout: 30_000 });
    await expect(result.locator('[data-testid="wp-updated"]')).toHaveText('Updated: 3');
    await expect(result.locator('[data-testid="wp-unchanged"]')).toHaveText('Already in that state: 0');
    await expect(result.locator('[data-testid="wp-skipped"]')).toHaveText('Skipped parent cards: 0');
    await expect(result.locator('[data-testid="wp-failed"]')).toHaveText('Failed: 0');
    await expect(result.locator('[data-testid="wp-not-attempted"]')).toHaveText('Not attempted: 0');

    // Only the flag moved: same rows, same values, on both websites.
    const afterStandalone = await linksOf(standalone);
    expect(afterStandalone).toHaveLength(2);
    expect(afterStandalone.find((l: any) => l.store === storeA)?.published).toBe(true);
    expect(afterStandalone.find((l: any) => l.store === storeB)).toEqual(before.standalone.find((l: any) => l.store === storeB));
    expect((await linksOf(child1)).find((l: any) => l.store === storeA)?.published).toBe(true);

    // The website's key now sees the standalone and the card (through its
    // published children).
    const slugs = await publicSlugs();
    expect(slugs.some((s) => s.startsWith('cuaderno'))).toBe(true);
    expect(slugs.some((s) => s.startsWith('silla'))).toBe(true);
  });

  test('a parent card in the selection is skipped with an explanation, and Hide here removes the card from the website', async () => {
    await openFiltersForBranch(storeA);
    // No publication filter this time: the card is a member and is listed.
    await page.waitForSelector(`[data-testid="branch-state-${card}"]`, { timeout: 30_000 });
    await expect(page.locator(`[data-testid="branch-state-${card}"]`)).toHaveText('Published here');

    await page.locator('[data-testid="select-all-on-page"]').check();
    await page.locator('[data-testid="bulk-website-publication"]').click();
    const dialog = page.locator('[data-testid="website-publication-modal"]');
    await expect(dialog.locator('[data-testid="wp-preflight-parents"]')).toContainText('1 parent cards will be skipped');
    await dialog.locator('[data-testid="wp-hide"]').check();
    await expect(dialog.locator('[data-testid="wp-confirm-text"]')).toContainText('publish them again later');
    await dialog.locator('[data-testid="wp-submit"]').click();

    const result = page.locator('[data-testid="wp-result"]');
    await expect(result).toBeVisible({ timeout: 30_000 });
    await expect(result.locator('[data-testid="wp-updated"]')).toHaveText('Updated: 3');
    await expect(result.locator('[data-testid="wp-skipped"]')).toHaveText('Skipped parent cards: 1');
    await expect(result.locator('[data-testid="wp-failed"]')).toHaveText('Failed: 0');
    await expect(result.locator('[data-testid="wp-skipped-details"]')).toContainText('at least one of its child products is published there');

    // The card's own row on Elite was not written; the storefront no longer
    // shows the family because none of its children is published there; every
    // branch row still exists.
    expect((await linksOf(card)).find((l: any) => l.store === storeA)?.published).toBe(true);
    expect((await linksOf(child1)).find((l: any) => l.store === storeA)?.published).toBe(false);
    expect(await linksOf(standalone)).toHaveLength(2);
    expect(await publicSlugs()).toEqual([]);
  });
});
