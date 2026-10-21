import { test, expect, APIRequestContext, BrowserContext, Page } from '@playwright/test';
import { login } from './helpers';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

/**
 * The owner's critical business flow end to end, and the public contract it
 * feeds.
 *
 * TWO HALVES, ONE LOGIN. The first half drives the panel: onboard a client
 * company, step into it with "Manage company" mode, and work its catalog
 * exactly as that company's admin would. The second half asks what a DesignHof
 * consumer actually receives — because a category is not "correct" merely
 * because the panel listed it; the published contract is where a tenancy
 * mistake becomes somebody else's data.
 *
 * `/auth/login` is rate-limited to 5/min, so this file logs in ONCE in
 * `beforeAll` and shares the context — `billing-gate.spec.ts` is the template.
 * The API half re-uses the same session: the httpOnly refresh cookie is on the
 * shared context, so `/auth/refresh` yields the same actor's access token, and
 * the managed-company headers are the very ones the panel sends.
 *
 * WHY THIS FILE ONCE FAILED. It was previously observed failing at the
 * Categories heading after entering managed mode, and was carried as
 * "known-broken". It is not broken: the assertion inherited Playwright's
 * default 5s expect budget, while the first visit to `/dashboard/categories`
 * makes the Next dev server compile that route on demand — which exceeds 5s on
 * a cold cache under load. Every navigation assertion below now states its own
 * budget, exactly as the company-visible assertion already did. No assertion
 * was weakened to make it pass.
 */
test.describe.configure({ mode: 'serial' });

test.describe('categories: the panel flow and the public channel contract', () => {
  const stamp = Date.now();
  const companyA = `E2E Co ${stamp}`;
  const uiCategory = `E2E Category ${stamp}`;

  let context: BrowserContext;
  let page: Page;
  let api: APIRequestContext;
  let bearer: Record<string, string>;

  /** Organization A is created through the panel; B exists only to be foreign. */
  let orgA = '';
  let storeA = '';
  let orgB = '';
  let storeB = '';
  let keyA = '';
  let keyB = '';
  let sellingCategoryA = '';
  let emptyCategoryA = '';
  let categoryB = '';

  /** Acting inside a company, the way the panel does it. */
  const inOrg = (organizationId: string, storeId?: string): Record<string, string> => ({
    ...bearer,
    'X-Managed-Organization': organizationId,
    ...(storeId ? { 'X-Managed-Store': storeId } : {}),
  });

  const created = async (response: {
    ok(): boolean;
    status(): number;
    json(): Promise<any>;
    text(): Promise<string>;
  }): Promise<any> => {
    if (!response.ok()) {
      // The body is what says WHICH field was refused; a bare status turns a
      // fixable mistake into a guessing game.
      expect(response.ok(), `expected a 2xx, got ${response.status()}: ${await response.text()}`).toBe(true);
    }
    const body = await response.json();
    return body.data ?? body;
  };

  /** A category with one PUBLISHED product, published in `storeId`. */
  const sellingCategory = async (
    organizationId: string,
    storeId: string,
    label: string,
  ): Promise<{ categoryId: string; productId: string }> => {
    const headers = inOrg(organizationId, storeId);
    const category = await created(
      await api.post(`${API}/categories`, { headers, data: { name: label } }),
    );
    const product = await created(
      await api.post(`${API}/products`, {
        headers,
        data: {
          name: `${label} product`,
          price: 10,
          status: 'PUBLISHED',
          categoryIds: [category.id],
          storeIds: [storeId],
        },
      }),
    );
    // Publication is per branch: the public contract asks whether THIS channel
    // sells it, not whether the company owns it.
    await created(
      await api.put(`${API}/products/${product.id}/stores/${storeId}`, {
        headers,
        data: { published: true, price: 10 },
      }),
    );
    return { categoryId: category.id, productId: product.id };
  };

  /** The published contract is paginated: `{ data: { items, total, … } }`. */
  const publicCategories = async (apiKey: string, query = ''): Promise<any[]> => {
    const response = await api.get(`${API}/public/categories${query}`, { headers: { 'X-Api-Key': apiKey } });
    expect(response.ok(), `public categories returned ${response.status()}`).toBe(true);
    const body = await response.json();
    const page = body.data ?? body;
    expect(Array.isArray(page.items), 'the public listing is a paginated envelope').toBe(true);
    return page.items;
  };

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await login(page); // the ONE login this file spends
    api = context.request;
    const refreshed = await created(await api.post(`${API}/auth/refresh`));
    bearer = { Authorization: `Bearer ${refreshed.accessToken}` };
  });

  test.afterAll(async () => {
    await context?.close();
  });

  test('an authorized tenant actor creates and reads the intended category state', async () => {
    // 1. Onboard the client company from the Clients control panel.
    await page.getByRole('navigation').getByRole('link', { name: 'Clients' }).click();
    await page.getByRole('button', { name: 'New Client' }).click();
    await page.getByLabel('Company name').fill(companyA);
    await page.getByLabel('Client admin email').fill(`e2e-${stamp}@example.test`);
    await page.getByRole('button', { name: 'Create and invite' }).click();
    await expect(page.getByText(companyA).first()).toBeVisible({ timeout: 15_000 });

    // 2. Enter "Manage company" mode from the same control panel.
    await page
      .getByRole('row', { name: new RegExp(companyA) })
      .getByRole('button', { name: 'Manage' })
      .click();
    await expect(page.getByText('Managing company')).toBeVisible({ timeout: 15_000 });
    // Entering managed mode stores the tenant in the browser; the RESOLVED
    // scope the sidebar reads comes from `/auth/me`, refetched on load.
    await page.reload();

    // 3. The catalog modules are back, scoped to this company. The first visit
    //    compiles the route in dev, so the budget is stated rather than
    //    inherited.
    await page.getByRole('navigation').getByRole('link', { name: 'Categories' }).click();
    await expect(page).toHaveURL(/\/dashboard\/categories/, { timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'Categories' })).toBeVisible({ timeout: 20_000 });

    // Create in the modal, and read it back in the table.
    await page.getByRole('button', { name: 'Add Category' }).click();
    await page.getByLabel('Name', { exact: true }).fill(uiCategory);
    await page.getByRole('button', { name: 'Save Category' }).click();
    await expect(page.getByText('Category created')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('cell', { name: uiCategory })).toBeVisible();

    // The managed tenant the panel is acting as — the same pair the API half
    // will use, read from the browser rather than assumed.
    const managed = await page.evaluate(() => window.localStorage.getItem('wegox-managed-tenant'));
    const tenant = JSON.parse(managed as string) as { organizationId: string; storeId?: string | null };
    orgA = tenant.organizationId;
    expect(orgA).toMatch(/^[0-9a-f-]{36}$/);

    const stores = await created(await api.get(`${API}/stores`, { headers: inOrg(orgA) }));
    const list = Array.isArray(stores) ? stores : (stores.items ?? []);
    expect(list.length, 'the onboarded company has a website').toBeGreaterThan(0);
    storeA = list[0].id;
  });

  test('archiving is the soft-delete flow, and leaving manage mode withdraws the module', async () => {
    await page
      .getByRole('row', { name: new RegExp(uiCategory) })
      .getByRole('button', { name: 'Archive' })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: 'Archive' }).click();
    await expect(page.getByText(`"${uiCategory}" archived`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('cell', { name: uiCategory })).toHaveCount(0);

    await page.getByRole('button', { name: 'Back to my platform' }).click();
    await expect(page.getByRole('navigation').getByRole('link', { name: 'Categories' })).toHaveCount(0);
  });

  test('the fixtures the public contract is judged against exist', async () => {
    // Company A: one category that actually sells, and one that does not.
    const selling = await sellingCategory(orgA, storeA, `A sells ${stamp}`);
    sellingCategoryA = selling.categoryId;
    const empty = await created(
      await api.post(`${API}/categories`, { headers: inOrg(orgA, storeA), data: { name: `A empty ${stamp}` } }),
    );
    emptyCategoryA = empty.id;

    // Company B exists only so that "foreign" means something.
    const companyB = await created(
      await api.post(`${API}/organizations`, { headers: bearer, data: { name: `E2E Co B ${stamp}` } }),
    );
    orgB = companyB.id;
    const websiteB = await created(
      await api.post(`${API}/stores`, {
        headers: inOrg(orgB),
        data: { name: `E2E Site B ${stamp}`, organizationId: orgB },
      }),
    );
    storeB = websiteB.id;
    categoryB = (await sellingCategory(orgB, storeB, `B sells ${stamp}`)).categoryId;

    // One channel key per company. This is the only time the secret is returned.
    const issued = async (organizationId: string, storeId: string): Promise<string> => {
      const key = await created(
        await api.post(`${API}/api-keys`, {
          headers: inOrg(organizationId, storeId),
          data: { name: `e2e-${stamp}`, storeId },
        }),
      );
      expect(key.key, 'the created key returns its secret exactly once').toMatch(/^ck_/);
      return key.key;
    };
    keyA = await issued(orgA, storeA);
    keyB = await issued(orgB, storeB);
  });

  test('public category output is limited to the requested channel’s published catalogue', async () => {
    const ids = (await publicCategories(keyA)).map((category) => category.id);

    // The category that has a PUBLISHED product published in THIS branch.
    expect(ids).toContain(sellingCategoryA);
    // A real category of the same company that sells nothing here is not part
    // of this channel's catalogue — the non-additive P5-W3 behaviour.
    expect(ids).not.toContain(emptyCategoryA);
    // The archived one from the panel half is gone too.
    expect(ids).not.toContain(uiCategory);
  });

  test('no foreign organization’s category is exposed, in either direction', async () => {
    const seenByA = (await publicCategories(keyA)).map((category) => category.id);
    const seenByB = (await publicCategories(keyB)).map((category) => category.id);

    expect(seenByA).not.toContain(categoryB);
    expect(seenByB).not.toContain(sellingCategoryA);
    expect(seenByB).not.toContain(emptyCategoryA);
    // Each channel sees its own, so the assertions above are not vacuous.
    expect(seenByA).toContain(sellingCategoryA);
    expect(seenByB).toContain(categoryB);
  });

  test('a revoked or absent key reaches nothing at all', async () => {
    const anonymous = await api.get(`${API}/public/categories`);
    expect(anonymous.status()).toBe(401);
    const wrong = await api.get(`${API}/public/categories`, { headers: { 'X-Api-Key': 'ck_not_a_real_key' } });
    expect(wrong.status()).toBe(401);
  });

  test('localization is Spanish-first, with a deterministic fallback', async () => {
    // Spanish is the organization's canonical content locale, so an
    // unqualified read is Spanish and says so.
    const canonical = await publicCategories(keyA);
    const sellingCanonical = canonical.find((category) => category.id === sellingCategoryA);
    expect(sellingCanonical.locale).toBe('es');
    const canonicalName = sellingCanonical.name;

    // A locale nobody has translated into falls back to the canonical text and
    // REPORTS the locale it actually returned — it never borrows another
    // language's words and never silently claims to be German.
    const german = await publicCategories(keyA, '?locale=de');
    const sellingGerman = german.find((category) => category.id === sellingCategoryA);
    expect(sellingGerman.locale).toBe('es');
    expect(sellingGerman.name).toBe(canonicalName);

    // Catalogue copy belongs to the whole company, so a BRANCH-narrowed actor
    // may not rewrite it — asserted here rather than assumed, because the
    // narrowing is the interesting half of the rule.
    const narrowed = await api.put(`${API}/categories/${sellingCategoryA}/translations/en`, {
      headers: inOrg(orgA, storeA),
      data: { name: `Branch attempt ${stamp}` },
    });
    expect(narrowed.status(), 'a branch-narrowed actor cannot rewrite company copy').toBe(400);

    // With company-wide access and a real translation, the requested locale
    // wins and is reported.
    await created(
      await api.put(`${API}/categories/${sellingCategoryA}/translations/en`, {
        headers: inOrg(orgA),
        data: { name: `English ${stamp}` },
      }),
    );
    const english = await publicCategories(keyA, '?locale=en');
    const sellingEnglish = english.find((category) => category.id === sellingCategoryA);
    expect(sellingEnglish.locale).toBe('en');
    expect(sellingEnglish.name).toBe(`English ${stamp}`);

    // And the untranslated fallback is unchanged by the existence of English:
    // fallback is per requested locale, not "whatever exists".
    const stillGerman = await publicCategories(keyA, '?locale=de');
    expect(stillGerman.find((category) => category.id === sellingCategoryA).name).toBe(canonicalName);
  });
});
