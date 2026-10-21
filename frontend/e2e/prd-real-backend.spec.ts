import { test, expect, request as playwrightRequest, type Page, type BrowserContext } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, loginSlot } from './helpers';
import { seedUser } from './seed';

/**
 * PR D end to end: a real browser, the real dashboard, the real backend, a
 * disposable seeded database. Nothing about the data is stubbed.
 *
 * The stubbed suite proves the interface lays out and behaves. This proves the
 * two halves agree — that the readiness the backend computes is the readiness
 * the banner shows, that a blocked group really is refused by the endpoint the
 * button would call, that grouping one really creates the family and really
 * removes the suggestion, and that a reader narrowed to one branch is never
 * shown another branch's candidates.
 *
 * Requires a DISPOSABLE database: `DATABASE_URL` must point at the same
 * throwaway database the backend under test was started with, migrated and
 * seeded. Never a developer's working database, and never anything remote.
 * Every row it makes is synthetic and unique to the run.
 */

const API = 'http://localhost:3001/api/v1';
const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

test.describe.configure({ mode: 'serial' });

async function call(token: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const context = await playwrightRequest.newContext();
  const response = await context.fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    data: body,
  });
  const json = await response.json().catch(() => null);
  await context.dispose();
  return { status: response.status(), json };
}

/**
 * ONE sign-in per persona for the whole file.
 *
 * The login route allows five attempts a minute, and this file needs both
 * browser sessions and API tokens. Signing in again for every assertion spends
 * the budget on plumbing and fails a later journey for a reason that has
 * nothing to do with what it asserts, so each persona's token is taken once
 * and reused. Browser sign-ins still take a slot of their own.
 */
const tokens = new Map<string, string>();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The shared ledger MODELS the server's counter; it does not read it. A run
 * that follows another inside the same minute can still meet a 429 — which is
 * the limiter working, not an authorization failure. So a 429 is waited out
 * and retried; any other refusal fails at once, because that one IS the answer.
 */
async function tokenFor(email: string, password: string): Promise<string> {
  const cached = tokens.get(email);
  if (cached) return cached;
  for (let attempt = 0; attempt < 6; attempt++) {
    await loginSlot();
    const response = await call(null, 'POST', '/auth/login', { email, password });
    if (response.status < 300) {
      const token = response.json.data.accessToken as string;
      tokens.set(email, token);
      return token;
    }
    expect(response.status, `${email} was refused: ${JSON.stringify(response.json)}`).toBe(429);
    await wait(20_000);
  }
  throw new Error(`${email} never got a login slot`);
}

interface Fixture {
  orgA: string;
  orgB: string;
  a1: string;
  a2: string;
  b1: string;
  readyMembers: string[];
  branchTwoMembers: string[];
  otherCompanyMembers: string[];
  draftMember: string;
  users: Record<string, { email: string; password: string }>;
}

let fx: Fixture;
let adminToken: string;

test.beforeAll(async () => {
  adminToken = await tokenFor(ADMIN_EMAIL, ADMIN_PASSWORD);

  const mkOrg = async (name: string) => {
    const r = await call(adminToken, 'POST', '/organizations', { name, plan: 'CRECIMIENTO' });
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300);
    return r.json.data.id as string;
  };
  const mkStore = async (organizationId: string, name: string, slug: string) => {
    const r = await call(adminToken, 'POST', '/stores', { name, slug, organizationId }, { 'X-Managed-Organization': organizationId });
    expect(r.status, JSON.stringify(r.json)).toBeLessThan(300);
    return r.json.data.id as string;
  };
  const mkProduct = async (organizationId: string, name: string, opts: { storeIds?: string[]; status?: string } = {}) => {
    const r = await call(
      adminToken,
      'POST',
      '/products',
      { name, price: 40, status: opts.status ?? 'PUBLISHED', storeIds: opts.storeIds ?? [] },
      { 'X-Managed-Organization': organizationId },
    );
    expect(r.status, `${name}: ${JSON.stringify(r.json)}`).toBeLessThan(300);
    return r.json.data.id as string;
  };

  const orgA = await mkOrg(`PRD A ${stamp}`);
  const orgB = await mkOrg(`PRD B ${stamp}`);
  const a1 = await mkStore(orgA, `A1 ${stamp}`, `a1-${stamp}`);
  const a2 = await mkStore(orgA, `A2 ${stamp}`, `a2-${stamp}`);
  const b1 = await mkStore(orgB, `B1 ${stamp}`, `b1-${stamp}`);

  // READY — both published, both in a shop, no conflicting values.
  const readyMembers = [
    await mkProduct(orgA, 'Camiseta lisa roja', { storeIds: [a1] }),
    await mkProduct(orgA, 'Camiseta lisa azul', { storeIds: [a1] }),
  ];

  // BLOCKED · MIXED_PUBLICATION_STATUS
  await mkProduct(orgA, 'Gorra plana verde', { storeIds: [a1] });
  const draftMember = await mkProduct(orgA, 'Gorra plana negra', { storeIds: [a1], status: 'DRAFT' });

  // BLOCKED · MEMBER_WITHOUT_STORE
  await mkProduct(orgA, 'Bufanda larga gris', { storeIds: [a1] });
  const storeless = await mkProduct(orgA, 'Bufanda larga rosa', { storeIds: [a1] });
  await call(adminToken, 'PATCH', `/products/${storeless}`, { storeIds: [] }, { 'X-Managed-Organization': orgA });

  // BLOCKED · SPECIFICATION_CONFLICT — a parent-only value a child may not hold.
  const definition = await call(
    adminToken,
    'POST',
    '/product-fields',
    { label: `Material padre ${stamp}`, type: 'TEXT', applicability: 'PARENT', childOverrideAllowed: false },
    { 'X-Managed-Organization': orgA },
  );
  await mkProduct(orgA, 'Chaqueta fina beige', { storeIds: [a1] });
  const conflicted = await mkProduct(orgA, 'Chaqueta fina crema', { storeIds: [a1] });
  await call(
    adminToken,
    'PUT',
    `/products/${conflicted}/fields/${definition.json.data.id}`,
    { value: 'Lana' },
    { 'X-Managed-Organization': orgA },
  );

  // Branch A2 only — invisible to a reader narrowed to A1.
  const branchTwoMembers = [
    await mkProduct(orgA, 'Zapato bajo marron', { storeIds: [a2] }),
    await mkProduct(orgA, 'Zapato bajo negro', { storeIds: [a2] }),
  ];

  // Another company, DELIBERATELY named alike: a leak would merge, not hide.
  const otherCompanyMembers = [
    await mkProduct(orgB, 'Camiseta lisa verde', { storeIds: [b1] }),
    await mkProduct(orgB, 'Camiseta lisa negra', { storeIds: [b1] }),
  ];

  const password = (who: string) => `Prd-${who}-${stamp}-Aa1!`;
  const users = {
    omA: { email: `prd-oma-${stamp}@example.test`, password: password('oma') },
    adminA1: { email: `prd-a1-${stamp}@example.test`, password: password('a1') },
    omB: { email: `prd-omb-${stamp}@example.test`, password: password('omb') },
    viewerA: { email: `prd-view-${stamp}@example.test`, password: password('view') },
  };
  seedUser({ ...users.omA, role: 'ORGANIZATION_MANAGER', organizationId: orgA, storeId: null });
  seedUser({ ...users.adminA1, role: 'ADMIN', organizationId: orgA, storeId: a1 });
  // A branch-level role must be pinned to its branch, exactly as an
  // organization-level one must not be.
  seedUser({ ...users.viewerA, role: 'VIEWER', organizationId: orgA, storeId: a1 });
  // An ORGANIZATION_MANAGER runs the whole company and must NOT be pinned to a
  // branch: the sign-in refuses that combination as a misconfigured account.
  seedUser({ ...users.omB, role: 'ORGANIZATION_MANAGER', organizationId: orgB, storeId: null });

  fx = { orgA, orgB, a1, a2, b1, readyMembers, branchTwoMembers, otherCompanyMembers, draftMember, users };
});

/** Signs a persona into the BROWSER and lands on the dashboard. */
async function signIn(page: Page, who: 'omA' | 'adminA1' | 'omB' | 'viewerA') {
  const user = fx.users[who];
  for (let attempt = 0; attempt < 6; attempt++) {
    await loginSlot();
    await page.goto('/login');
    await page.getByLabel('Email Address').fill(user.email);
    await page.getByLabel('Password', { exact: true }).fill(user.password);
    // WHAT THE SERVER SAID, not merely that the page stayed put. A retry loop
    // that cannot tell a rate limit from a rejected account turns a five-second
    // configuration mistake into a three-minute timeout saying nothing.
    const answer = page.waitForResponse((r) => r.url().endsWith('/auth/login') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Sign In' }).click();
    const status = (await answer).status();
    if (status < 300) {
      await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
      return;
    }
    expect(status, `${user.email} was refused by the sign-in`).toBe(429);
    await wait(20_000);
  }
  throw new Error(`${user.email} never got a login slot`);
}

async function openSuggestions(page: Page) {
  await page.goto('/dashboard/products');
  await page.waitForSelector('[data-testid="suggestions-banner"]', { timeout: 30_000 });
  await page.locator('[data-testid="suggestions-toggle"]').click();
  await page.waitForSelector('[data-testid="suggestion-review"]', { timeout: 15_000 });
}

/** Walks the carousel to the suggestion with this name, or fails saying what it saw. */
async function goTo(page: Page, name: string) {
  const shown = page.locator('[data-testid="suggestion-name"]');
  const seen: string[] = [];
  for (let i = 0; i < 12; i++) {
    const current = (await shown.textContent())?.trim() ?? '';
    if (current === name) return;
    seen.push(current);
    const next = page.locator('[data-testid="suggestion-next"]');
    if (!(await next.isEnabled().catch(() => false))) break;
    await next.click();
  }
  throw new Error(`"${name}" was not among the suggestions: ${JSON.stringify(seen)}`);
}

test.describe('PR D · browser to backend', () => {
  test.setTimeout(300_000);

  let context: BrowserContext;
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    context = await browser.newContext();
    page = await context.newPage();
    await signIn(page, 'omA');
  });

  test.afterAll(async () => context?.close());

  test('the manager signs in scoped to their company and sees only its suggestions', async () => {
    await page.goto('/dashboard/products');
    await page.waitForSelector('[data-testid="suggestions-banner"]', { timeout: 30_000 });

    const answer = await page.evaluate(async () => {
      const res = await fetch('/api/v1/products/family-suggestions');
      return res.status;
    });
    void answer;

    const listed = await call(await tokenFor(fx.users.omA.email, fx.users.omA.password), 'GET', '/products/family-suggestions');
    const ids = (listed.json.data as { members: { id: string }[] }[]).flatMap((s) => s.members.map((m) => m.id));
    // The other company's look-alikes are named so a leak would MERGE them
    // into this company's "Camiseta lisa" rather than appear separately.
    for (const foreign of fx.otherCompanyMembers) expect(ids).not.toContain(foreign);
    const camiseta = (listed.json.data as { name: string; members: unknown[] }[]).find((s) => s.name === 'Camiseta lisa');
    expect(camiseta!.members).toHaveLength(2);
  });

  test('a READY suggestion is shown in Items, and only ready ones are counted', async () => {
    await page.goto('/dashboard/products');
    await page.waitForSelector('[data-testid="suggestions-banner"]', { timeout: 30_000 });
    // Two ready groups: "Camiseta lisa" and "Zapato bajo". Three more are
    // blocked, and are deliberately not counted as waiting.
    await expect(page.locator('[data-testid="suggestions-summary"]')).toContainText('2');
    await page.locator('[data-testid="suggestions-toggle"]').click();
    await goTo(page, 'Camiseta lisa');
    await expect(page.locator('[data-testid="suggestion-blocked"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="suggestion-review-open"]')).toBeEnabled();
  });

  test.describe('every blocked reason the backend can report', () => {
    test('MIXED_PUBLICATION_STATUS names the draft member', async () => {
      await openSuggestions(page);
      await goTo(page, 'Gorra plana');
      await expect(page.locator('[data-testid="blocked-reason-MIXED_PUBLICATION_STATUS"]')).toContainText(
        /published or all draft/i,
      );
      await expect(page.locator(`[data-testid="member-draft-${fx.draftMember}"]`)).toBeVisible();
      await expect(page.locator('[data-testid="suggestion-review-open"]')).toBeDisabled();
    });

    test('MEMBER_WITHOUT_STORE names the member in no shop', async () => {
      await openSuggestions(page);
      await goTo(page, 'Bufanda larga');
      await expect(page.locator('[data-testid="blocked-reason-MEMBER_WITHOUT_STORE"]')).toContainText(/no shop/i);
      await expect(page.locator('[data-testid^="member-no-store-"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="suggestion-review-open"]')).toBeDisabled();
    });

    test('SPECIFICATION_CONFLICT names the member holding the value', async () => {
      await openSuggestions(page);
      await goTo(page, 'Chaqueta fina');
      await expect(page.locator('[data-testid="blocked-reason-SPECIFICATION_CONFLICT"]')).toContainText(
        /specification value/i,
      );
      await expect(page.locator('[data-testid^="member-conflict-"]')).toHaveCount(1);
      await expect(page.locator('[data-testid="suggestion-review-open"]')).toBeDisabled();
    });

    /**
     * The disabled control is not decoration: the same group, submitted to the
     * authoritative endpoint anyway, is refused there too.
     */
    test('a blocked group is refused by the endpoint the button would have called', async () => {
      const token = await tokenFor(fx.users.omA.email, fx.users.omA.password);
      const listing = await call(token, 'GET', '/products/family-suggestions');
      const blocked = (listing.json.data as any[]).find((s) => s.name === 'Gorra plana');
      expect(blocked.readiness).toBe('BLOCKED');
      const refused = await call(token, 'POST', '/products/families', {
        name: blocked.name,
        members: blocked.members.map((m: any) => ({ id: m.id, label: m.label })),
      });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(refused.json)).toMatch(/published|draft|status/i);
    });
  });

  test('Review opens the grouping modal with the suggested members and name, and never touches the selection', async () => {
    await openSuggestions(page);
    await goTo(page, 'Camiseta lisa');
    expect(await page.locator('tbody input[type="checkbox"]:checked').count()).toBe(0);

    await page.locator('[data-testid="suggestion-review-open"]').click();
    await page.waitForSelector('[data-testid="group-modal"]', { timeout: 15_000 });
    await expect(page.locator('[data-testid="group-parent-name"]')).toHaveValue('Camiseta lisa');
    for (const id of fx.readyMembers) {
      await expect(page.locator(`[data-testid="group-label-${id}"]`)).toHaveCount(1);
    }
    expect(await page.locator('tbody input[type="checkbox"]:checked').count()).toBe(0);
    await page.locator('[data-testid="group-cancel"]').click();
  });

  test('the name and the labels can be edited, the server validates, and grouping is atomic', async () => {
    const posted: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && r.url().endsWith('/products/families')) posted.push(r.postData() ?? '');
    });

    await openSuggestions(page);
    await goTo(page, 'Camiseta lisa');
    await page.locator('[data-testid="suggestion-review-open"]').click();
    await page.waitForSelector('[data-testid="group-modal"]', { timeout: 15_000 });

    const chosenName = `Camiseta lisa ${stamp}`;
    await page.locator('[data-testid="group-parent-name"]').fill(chosenName);
    await page.locator(`[data-testid="group-label-${fx.readyMembers[0]}"]`).fill('Roja');
    await page.locator(`[data-testid="group-label-${fx.readyMembers[1]}"]`).fill('Azul');
    // The advisory check runs against the real endpoint and raises nothing.
    await page.locator('[data-testid="group-parent-name"]').blur();
    await expect(page.locator('[data-testid="group-problem"]')).toHaveCount(0);

    await page.locator('[data-testid="group-confirm"]').click();
    await expect(page.locator('[data-testid="group-modal"]')).toHaveCount(0, { timeout: 30_000 });

    // ONE creating request, carrying the card and both children — the backend
    // has no state in which the card exists without them.
    expect(posted).toHaveLength(1);
    const sent = JSON.parse(posted[0]);
    expect(sent.name).toBe(chosenName);
    expect(sent.members.map((m: any) => m.id).sort()).toEqual([...fx.readyMembers].sort());

    // And the family really exists, with both children attached.
    const token = await tokenFor(fx.users.omA.email, fx.users.omA.password);
    const products = await call(token, 'GET', `/products?search=${encodeURIComponent(chosenName)}`);
    const card = (products.json.items as any[]).find((p) => p.name === chosenName);
    expect(card).toBeTruthy();
    expect(card.children).toHaveLength(2);
  });

  test('the suggestion and the counts refresh once it has been grouped', async () => {
    await page.goto('/dashboard/products');
    await page.waitForSelector('[data-testid="suggestions-banner"]', { timeout: 30_000 });
    // One ready group left: "Camiseta lisa" is now a family.
    await expect(page.locator('[data-testid="suggestions-summary"]')).toContainText('1');
    await page.locator('[data-testid="suggestions-toggle"]').click();
    await expect(async () => await goTo(page, 'Camiseta lisa')).rejects.toThrow();
  });

  test('dismissing one removes it, and the list refreshes without it', async () => {
    await openSuggestions(page);
    await goTo(page, 'Zapato bajo');
    await page.locator('[data-testid="suggestion-dismiss"]').click();
    await expect(page.locator('[data-testid="suggestions-summary"]')).toContainText(/correction first/i, {
      timeout: 30_000,
    });
    // It is gone from the server's answer too, not just from the screen.
    const token = await tokenFor(fx.users.omA.email, fx.users.omA.password);
    const listing = await call(token, 'GET', '/products/family-suggestions');
    expect((listing.json.data as any[]).map((s) => s.name)).not.toContain('Zapato bajo');
    expect(listing.json.readyCount).toBe(0);
  });

  /**
   * Readiness is ADVISORY. The catalogue can move between reading it and
   * pressing the button, and only the creation's own transaction can settle it.
   */
  test('a change made after the page loaded is caught by the final validation', async () => {
    const token = await tokenFor(fx.users.omA.email, fx.users.omA.password);
    // Two fresh look-alikes, both fine at the moment the page reads them.
    const first = await call(token, 'POST', '/products', { name: 'Panuelo suave rojo', price: 12, status: 'PUBLISHED', storeIds: [fx.a1] });
    const second = await call(token, 'POST', '/products', { name: 'Panuelo suave azul', price: 12, status: 'PUBLISHED', storeIds: [fx.a1] });
    expect(second.status).toBeLessThan(300);

    await openSuggestions(page);
    await goTo(page, 'Panuelo suave');
    await expect(page.locator('[data-testid="suggestion-review-open"]')).toBeEnabled();
    await page.locator('[data-testid="suggestion-review-open"]').click();
    await page.waitForSelector('[data-testid="group-modal"]', { timeout: 15_000 });

    // …and now the catalogue moves underneath it: one member goes to draft.
    const moved = await call(token, 'PATCH', `/products/${second.json.data.id}`, { status: 'DRAFT' });
    expect(moved.status).toBeLessThan(300);

    await page.locator('[data-testid="group-confirm"]').click();
    // The authoritative refusal reaches the reader, and nothing was created.
    await expect(page.locator('[data-testid="group-problem"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="group-problem"]')).toContainText(/published|draft/i);
    await expect(page.locator('[data-testid="group-modal"]')).toBeVisible();
    await page.locator('[data-testid="group-cancel"]').click();

    const after = await call(token, 'GET', `/products?search=${encodeURIComponent('Panuelo suave')}`);
    const cards = (after.json.items as any[]).filter((p) => (p.children ?? []).length > 0);
    expect(cards).toHaveLength(0);
    void first;
  });

  test('the old /groups link reaches the one review experience', async () => {
    await page.goto('/dashboard/products/groups');
    await page.waitForURL(/\/dashboard\/products\?suggestions=open/, { timeout: 30_000 });
    await page.waitForSelector('[data-testid="suggestion-review"]', { timeout: 30_000 });
    // The same component, against real data.
    await expect(page.locator('[data-testid="suggestion-name"]')).toHaveText(/\S/);
  });

  test.describe('the dashboard tile', () => {
    test('is neutral and NOT a link when nothing is ready', async () => {
      // Everything ready has been grouped or dismissed; three blocked groups
      // remain, and a blocked group is not work that can be done.
      await page.goto('/dashboard');
      await page.waitForSelector('[data-testid="tile-groupable"]', { timeout: 30_000 });
      const tile = page.locator('[data-testid="tile-groupable"]');
      await expect(tile).toHaveAttribute('data-state', 'clean');
      await expect(tile).toHaveAttribute('aria-disabled', 'true');
      expect(await tile.evaluate((el) => el.tagName)).not.toBe('A');
    });

    test('is amber and navigable when something is ready', async () => {
      const token = await tokenFor(fx.users.omA.email, fx.users.omA.password);
      await call(token, 'POST', '/products', { name: 'Calcetin corto rojo', price: 5, status: 'PUBLISHED', storeIds: [fx.a1] });
      await call(token, 'POST', '/products', { name: 'Calcetin corto azul', price: 5, status: 'PUBLISHED', storeIds: [fx.a1] });

      await page.goto('/dashboard');
      await page.waitForSelector('[data-testid="tile-groupable"]', { timeout: 30_000 });
      const tile = page.locator('[data-testid="tile-groupable"]');
      await expect(tile).toHaveAttribute('data-state', 'actionable');
      expect(await tile.evaluate((el) => el.tagName)).toBe('A');
      await tile.click();
      await page.waitForURL(/\/dashboard\/products\?suggestions=open/, { timeout: 30_000 });
      await page.waitForSelector('[data-testid="suggestion-review"]', { timeout: 30_000 });
    });

    /**
     * The only stubbed thing in this file, and only the TRANSPORT: the request
     * is made to fail so the third state can be reached at all. A failed count
     * used to be drawn amber with the problem wording, so not knowing looked
     * like a backlog.
     */
    test('is neutral, inert and honest when the count cannot be read', async () => {
      await page.route('**/api/v1/products/family-suggestions', (route) => route.abort());
      await page.goto('/dashboard');
      await page.waitForSelector('[data-testid="tile-groupable"]', { timeout: 30_000 });
      const tile = page.locator('[data-testid="tile-groupable"]');
      await expect(tile).toHaveAttribute('data-state', 'unknown');
      await expect(tile).toHaveAttribute('aria-disabled', 'true');
      await expect(tile).toContainText(/could not be checked/i);
      await page.unroute('**/api/v1/products/family-suggestions');
    });
  });

  test.describe('an empty items list says which empty it is', () => {
    test('a filter that matches nothing offers Clear filters, which resets them', async () => {
      await page.goto('/dashboard/products');
      await page.waitForSelector('tbody tr', { timeout: 30_000 });
      await page.getByLabel('Search').fill(`zzz-nothing-${stamp}`);
      await page.waitForSelector('[data-testid="empty-filtered"]', { timeout: 30_000 });
      await expect(page.locator('[data-testid="empty-catalogue"]')).toHaveCount(0);
      await expect(page.locator('[data-testid="empty-add-item"]')).toHaveCount(0);

      await page.locator('[data-testid="empty-clear-filters"]').click();
      await page.waitForSelector('tbody tr', { timeout: 30_000 });
      await expect(page.getByLabel('Search')).toHaveValue('');
    });

    test('a company with nothing in it offers Add Item', async () => {
      const other = await context.browser()!.newContext();
      const otherPage = await other.newPage();
      try {
        await signIn(otherPage, 'omB');

        // Company B's manager is pinned to its only branch, which holds two
        // products; filter them away and the list is genuinely empty for a
        // reason that is NOT a filter only once they are archived. Instead,
        // read the true-empty state where it exists: a fresh company.
        const token = await tokenFor(fx.users.omB.email, fx.users.omB.password);
        for (const id of fx.otherCompanyMembers) await call(token, 'PATCH', `/products/${id}/archive`);

        await otherPage.goto('/dashboard/products');
        await otherPage.waitForSelector('[data-testid="empty-catalogue"]', { timeout: 30_000 });
        await expect(otherPage.locator('[data-testid="empty-filtered"]')).toHaveCount(0);
        await otherPage.locator('[data-testid="empty-add-item"]').click();
        await otherPage.waitForSelector('[data-testid="new-kind-chooser"]', { timeout: 15_000 });
      } finally {
        await other.close();
      }
    });
  });

  /**
   * READING AND ACTING ARE SEPARATE, and the separation is enforced by the
   * server. The interface withholding a button is a courtesy; the 403 is the
   * boundary.
   */
  test('a read-only actor may look, is offered no controls, and is refused by the API', async () => {
    const other = await context.browser()!.newContext();
    const viewerPage = await other.newPage();
    try {
      await signIn(viewerPage, 'viewerA');
      await viewerPage.goto('/dashboard/products');
      await viewerPage.waitForSelector('[data-testid="suggestions-banner"]', { timeout: 30_000 });

      // The invitation is honest: nothing to "Review" for somebody who cannot.
      await expect(viewerPage.locator('[data-testid="suggestions-toggle"]')).toHaveText(/show/i);
      await viewerPage.locator('[data-testid="suggestions-toggle"]').click();
      await viewerPage.waitForSelector('[data-testid="suggestion-review"]', { timeout: 15_000 });
      await expect(viewerPage.locator('[data-testid="suggestion-name"]')).toHaveText(/\S/);

      // No control it could not carry through.
      await expect(viewerPage.locator('[data-testid="suggestion-review-open"]')).toHaveCount(0);
      await expect(viewerPage.locator('[data-testid="suggestion-dismiss"]')).toHaveCount(0);
      await expect(viewerPage.locator('[data-testid="bulk-group"]')).toHaveCount(0);
      await expect(viewerPage.locator('[data-testid="add-item"]')).toHaveCount(0);

      // And the boundary, reached directly, refuses all three writes.
      const token = await tokenFor(fx.users.viewerA.email, fx.users.viewerA.password);
      const listing = await call(token, 'GET', '/products/family-suggestions');
      expect(listing.status).toBe(200);
      const first = (listing.json.data as any[])[0];
      const members = first.members.map((m: any) => ({ id: m.id, label: m.label }));
      for (const [path, body] of [
        ['/products/family-suggestions/dismiss', { name: first.name }],
        ['/products/families/validate', { name: first.name, members }],
        ['/products/families', { name: first.name, members }],
      ] as [string, object][]) {
        const refused = await call(token, 'POST', path, body);
        expect(refused.status, `${path} must refuse a read-only actor`).toBe(403);
      }
    } finally {
      await other.close();
    }
  });

  /**
   * A dismissal is a persistent organization-wide write, so it must land in
   * the company the request is scoped to — not in whatever company the caller
   * happens to belong to, which for a platform owner is none at all.
   */
  test('a platform owner inside a company dismisses FOR that company', async () => {
    const managed = { 'X-Managed-Organization': fx.orgB };
    const omB = await tokenFor(fx.users.omB.email, fx.users.omB.password);

    // Its OWN group: an earlier journey archives company B's fixture products,
    // and a test that reads whatever is left over is a test about test order.
    for (const name of ['Bufanda ancha roja', 'Bufanda ancha azul']) {
      const made = await call(omB, 'POST', '/products', {
        name,
        price: 15,
        status: 'PUBLISHED',
        storeIds: [fx.b1],
      });
      expect(made.status, JSON.stringify(made.json)).toBeLessThan(300);
    }

    const before = await call(omB, 'GET', '/products/family-suggestions');
    const target = (before.json.data as any[]).find((s) => s.name === 'Bufanda ancha');
    expect(target, 'company B needs a suggestion to dismiss').toBeTruthy();

    const dismissed = await call(adminToken, 'POST', '/products/family-suggestions/dismiss', { name: target.name }, managed);
    expect(dismissed.status).toBeLessThan(300);

    // The company's OWN manager no longer sees it. Before this correction the
    // owner's "No" went to a null bucket and the client never heard it.
    const after = await call(omB, 'GET', '/products/family-suggestions');
    expect((after.json.data as any[]).map((s) => s.name)).not.toContain(target.name);

    // An unscoped owner is refused outright.
    const unscoped = await call(adminToken, 'POST', '/products/family-suggestions/dismiss', { name: 'Camiseta lisa' });
    expect(unscoped.status).toBe(403);

    // And a signature belonging to another company is refused with a sentence
    // that says nothing about whether it exists.
    // "Gorra plana" is company A's group; company B has never had it.
    const foreign = await call(adminToken, 'POST', '/products/family-suggestions/dismiss', { name: 'Gorra plana' }, managed);
    const nonsense = await call(adminToken, 'POST', '/products/family-suggestions/dismiss', { name: 'Nada de nada' }, managed);
    expect(foreign.status).toBe(404);
    expect(nonsense.status).toBe(404);
    expect(foreign.json.message).toBe(nonsense.json.message);
  });

  test('a reader narrowed to one branch is never shown another branch or company', async () => {
    const other = await context.browser()!.newContext();
    const narrowedPage = await other.newPage();
    try {
      await signIn(narrowedPage, 'adminA1');

      await narrowedPage.goto('/dashboard/products');
      await narrowedPage.waitForSelector('[data-testid="suggestions-banner"], [data-testid="empty-catalogue"]', {
        timeout: 30_000,
      });

      const token = await tokenFor(fx.users.adminA1.email, fx.users.adminA1.password);
      const listing = await call(token, 'GET', '/products/family-suggestions');
      const ids = (listing.json.data as any[]).flatMap((s) => s.members.map((m: any) => m.id));
      // Not the sibling branch…
      for (const id of fx.branchTwoMembers) expect(ids).not.toContain(id);
      // …and not the other company.
      for (const id of fx.otherCompanyMembers) expect(ids).not.toContain(id);
      // The branch's own candidates are still offered.
      expect(listing.json.data.length).toBeGreaterThan(0);
    } finally {
      await other.close();
    }
  });
});
