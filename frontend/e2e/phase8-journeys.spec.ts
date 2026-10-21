import { test, expect, request as playwrightRequest } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, login, loginSlot } from './helpers';
import { seedUser } from './seed';

/**
 * Phase 8 — the six operator journeys the checkpoint names.
 *
 * Each persona gets its OWN company built through the API, so a journey passes
 * or fails on what its role can do rather than on whatever happens to be in the
 * developer's database. The assertions are deliberately about REACHABILITY and
 * REFUSAL — which surfaces appear, and what the server says when one is asked
 * for anyway — because that is the part only a real browser and a real backend
 * can settle. The component suite already proves which controls render.
 *
 * Local-only, like the rest of `e2e/`: there is no CI runner, and the login
 * route is rate-limited to five attempts a minute, so personas that only need
 * an API answer use a request context instead of signing in.
 */

const API = 'http://localhost:3001/api/v1';
const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/**
 * ONE administrator sign-in for the whole file.
 *
 * The login route is rate-limited to five attempts a minute, and every journey
 * needs a company built by somebody who may create one. Signing in per test
 * would spend the budget on setup and fail the later journeys for a reason that
 * has nothing to do with what they assert.
 */
let cachedAdminToken: string | null = null;
async function adminToken(): Promise<string> {
  if (cachedAdminToken) return cachedAdminToken;
  const token = await tokenFor(ADMIN_EMAIL, ADMIN_PASSWORD);
  expect(token, 'the platform administrator could not sign in').toBeTruthy();
  cachedAdminToken = token!;
  return cachedAdminToken;
}

/** A company with two branches, so isolation between them can be shown. */
async function buildCompany(token: string) {
  const suffix = stamp();
  // The organizations contract derives the slug itself and refuses one in the
  // body (whitelist + forbidNonWhitelisted). Sending it 400'd every journey
  // that builds a company — from the very commit that added them.
  // CRECIMIENTO: BUS-001 caps Básico at one website, and every journey
  // company runs two branches to prove isolation between them.
  const organization = await callAs(token, 'POST', '/organizations', {
    name: `P8 ${suffix}`,
    plan: 'CRECIMIENTO',
  });
  expect(organization.status, JSON.stringify(organization.json)).toBeLessThan(300);
  const organizationId = organization.json.data.id;
  const managed = { 'X-Managed-Organization': organizationId };

  // The stores contract names the owning client in the BODY (P0-01); the
  // managed header alone answers with the service's clear refusal.
  const storeA = await callAs(
    token,
    'POST',
    '/stores',
    { name: `A ${suffix}`, slug: `a-${suffix}`, organizationId },
    managed,
  );
  const storeB = await callAs(
    token,
    'POST',
    '/stores',
    { name: `B ${suffix}`, slug: `b-${suffix}`, organizationId },
    managed,
  );
  expect(storeA.status, JSON.stringify(storeA.json)).toBeLessThan(300);
  expect(storeB.status, JSON.stringify(storeB.json)).toBeLessThan(300);

  return {
    organizationId,
    managed,
    storeAId: storeA.json.data.id,
    storeBId: storeB.json.data.id,
    suffix,
  };
}

/** Signs a seeded persona in through a fresh request context (no browser login). */
async function tokenFor(email: string, password: string): Promise<string | null> {
  await loginSlot();
  const context = await playwrightRequest.newContext();
  const response = await context.post(`${API}/auth/login`, { data: { email, password } });
  const body = await response.json().catch(() => null);
  await context.dispose();
  return body?.data?.accessToken ?? null;
}

async function callAs(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const context = await playwrightRequest.newContext();
  const response = await context.fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    data: body,
  });
  const json = await response.json().catch(() => null);
  await context.dispose();
  return { status: response.status(), json };
}

test.describe('Phase 8 · the operator journeys', () => {
  // Waiting out the login window is PART of these tests by design: a journey
  // that arrives with the five-a-minute budget spent legitimately stands in
  // line for up to a minute per sign-in, on top of its own work. The tripled
  // 30-second default (test.slow) lost that race under load once the whole
  // battery shared one ledger, so the ceiling is explicit instead.
  test.setTimeout(300_000);
  test('organization manager: runs the whole company, including inventory', async () => {
    const token = await adminToken();
    const company = await buildCompany(token);
    const password = `Mgr-${stamp()}-Aa1!`;
    const email = `p8-manager-${company.suffix}@example.test`;
    seedUser({ email, password, role: 'ORGANIZATION_MANAGER', organizationId: company.organizationId, storeId: null });

    const managerToken = await tokenFor(email, password);
    expect(managerToken, 'the manager could not sign in').toBeTruthy();

    // Reads the company's inventory surface…
    const locations = await callAs(managerToken!, 'GET', '/inventory/locations');
    expect(locations.status).toBe(200);
    // …and holds the organization-wide commands: reconciliation answers.
    const reconciliation = await callAs(managerToken!, 'GET', '/inventory/reconciliation');
    expect(reconciliation.status).toBe(200);
    expect(reconciliation.json.data).toHaveProperty('findings');
    // Transfers are an organization act, and this role has it.
    const transfers = await callAs(managerToken!, 'GET', '/inventory/transfers');
    expect(transfers.status).toBe(200);
  });

  test('Store A administrator: own branch only, recount but no organization command', async () => {
    const token = await adminToken();
    const company = await buildCompany(token);
    const password = `AdmA-${stamp()}-Aa1!`;
    const email = `p8-admin-a-${company.suffix}@example.test`;
    seedUser({ email, password, role: 'ADMIN', organizationId: company.organizationId, storeId: company.storeAId });

    const branchToken = await tokenFor(email, password);
    expect(branchToken, 'store A admin could not sign in').toBeTruthy();

    // Reads inventory for its own branch…
    const locations = await callAs(branchToken!, 'GET', '/inventory/locations');
    expect(locations.status).toBe(200);
    // every location it can see belongs to its own branch
    for (const location of locations.json.data ?? []) {
      expect(location.storeId).toBe(company.storeAId);
    }

    // …but the organization-wide commands are refused, whatever the panel shows.
    const reconciliation = await callAs(branchToken!, 'GET', '/inventory/reconciliation');
    expect(reconciliation.status).toBe(403);
    const transfer = await callAs(branchToken!, 'POST', '/inventory/transfers', {
      sourceLocationId: '00000000-0000-4000-8000-000000000001',
      destinationLocationId: '00000000-0000-4000-8000-000000000002',
      lines: [{ productId: '00000000-0000-4000-8000-000000000003', quantity: 1 }],
    });
    expect(transfer.status).toBe(403);

    // Imports belong to the company, not to a branch.
    const history = await callAs(branchToken!, 'GET', '/import/history');
    expect(history.status).toBe(403);
  });

  test('Store B administrator: cannot see or command Store A', async () => {
    const token = await adminToken();
    const company = await buildCompany(token);
    const password = `AdmB-${stamp()}-Aa1!`;
    const email = `p8-admin-b-${company.suffix}@example.test`;
    seedUser({ email, password, role: 'ADMIN', organizationId: company.organizationId, storeId: company.storeBId });

    const branchToken = await tokenFor(email, password);
    expect(branchToken, 'store B admin could not sign in').toBeTruthy();

    const locations = await callAs(branchToken!, 'GET', '/inventory/locations');
    expect(locations.status).toBe(200);
    const visible = (locations.json.data ?? []).map((row: any) => row.storeId);
    // Store A is a sibling: its shelf is not this administrator's to read.
    expect(visible).not.toContain(company.storeAId);
    for (const storeId of visible) expect(storeId).toBe(company.storeBId);
  });

  test('platform actor: no tenant inventory command without entering a company', async () => {
    const token = await adminToken();

    // Unscoped: the platform owner has no organization, so there is no tenant
    // whose stock it could command. It must enter a company first.
    const unscoped = await callAs(token, 'GET', '/inventory/reconciliation');
    expect(unscoped.status).toBe(403);

    const company = await buildCompany(token);
    // Inside a company, the same actor is that company's operator.
    const scoped = await callAs(token, 'GET', '/inventory/reconciliation', undefined, company.managed);
    expect(scoped.status).toBe(200);
  });

  test('public API key: reaches the catalogue and never the panel', async () => {
    const token = await adminToken();
    const company = await buildCompany(token);
    const created = await callAs(
      token,
      'POST',
      '/api-keys',
      { name: `p8-${company.suffix}`, storeId: company.storeAId },
      company.managed,
    );
    expect(created.status).toBeLessThan(300);
    const key: string = created.json.data.key;
    expect(created.json.data.capabilities).toEqual(['CATALOGUE_READ']);

    const context = await playwrightRequest.newContext();
    // The catalogue answers…
    const products = await context.get(`${API}/public/products?limit=5`, { headers: { 'X-Api-Key': key } });
    expect(products.status()).toBe(200);
    // …and the administration surface does not exist for a channel key —
    // including every route Phase 8 added. A key is a CHANNEL, never a person.
    const NOWHERE = '00000000-0000-4000-8000-000000000000';
    const adminProbes: Array<[string, string]> = [
      ['GET', '/inventory/locations'],
      ['POST', `/inventory/transfers/${NOWHERE}/start-return`],
      ['POST', `/inventory/transfers/${NOWHERE}/complete-return`],
      ['POST', `/suppliers/orders/${NOWHERE}/ship`],
      ['POST', `/suppliers/orders/${NOWHERE}/arrive`],
      ['POST', `/suppliers/orders/${NOWHERE}/receipts`],
      ['GET', `/suppliers/orders/${NOWHERE}/receipts`],
      ['GET', '/users'],
    ];
    for (const [method, path] of adminProbes) {
      const probe = await context.fetch(`${API}${path}`, {
        method,
        headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
        data: method === 'POST' ? {} : undefined,
      });
      expect(probe.status(), `${method} ${path} must not exist for a channel key`).toBe(401);
    }
    // A read-only key cannot order, either (Phase 6 capabilities).
    const order = await context.post(`${API}/public/orders`, {
      headers: { 'X-Api-Key': key },
      data: { items: [] },
    });
    expect(order.status()).toBe(403);
    await context.dispose();
  });

  test('authenticated but no access: an explicit state, never an empty catalogue', async ({ page }) => {
    const token = await adminToken();
    const company = await buildCompany(token);
    const password = `View-${stamp()}-Aa1!`;
    const email = `p8-viewer-${company.suffix}@example.test`;
    seedUser({ email, password, role: 'VIEWER', organizationId: company.organizationId, storeId: company.storeAId });

    const viewerToken = await tokenFor(email, password);
    expect(viewerToken, 'the viewer could not sign in').toBeTruthy();

    // A viewer holds no inventory surface at all — not even the reads.
    const locations = await callAs(viewerToken!, 'GET', '/inventory/locations');
    expect(locations.status).toBe(403);
    const recount = await callAs(viewerToken!, 'POST', '/inventory/recount', {
      productId: '00000000-0000-4000-8000-000000000003',
      locationId: '00000000-0000-4000-8000-000000000001',
      countedQuantity: 1,
      reason: 'should never post',
    });
    expect(recount.status).toBe(403);

    // In the panel the answer is a stated one rather than an empty table.
    await loginSlot();
    await page.goto('/login');
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL(/dashboard/, { timeout: 20_000 });
    await page.goto('/dashboard/inventory');
    await expect(page.getByTestId('access-denied')).toBeVisible();
    // The sidebar does not offer what the server would refuse.
    await expect(page.locator('nav a[href="/dashboard/inventory"]')).toHaveCount(0);

    // The same stated answer on EVERY refused route — deep links included.
    // These three used to bounce silently to the dashboard.
    for (const refused of ['/dashboard/users', '/dashboard/metrics', '/dashboard/audit-log']) {
      await page.goto(refused);
      await expect(page.getByTestId('access-denied')).toBeVisible();
    }
  });

  test('platform actor in the panel: no company chosen is SAID, not an empty catalogue', async ({ page }) => {
    await loginSlot();
    await login(page);
    // No company has been entered: the catalogue names the missing choice
    // and offers the way to make it, instead of an empty table that reads
    // as "this company has no products" about a company nobody chose.
    await page.goto('/dashboard/products');
    await expect(page.getByTestId('no-organization-context')).toBeVisible();
    await page.goto('/dashboard/categories');
    await expect(page.getByTestId('no-organization-context')).toBeVisible();

    // Phase 9 replaced the Phase 8 rehearsal, and this assertion moved with
    // it. The rehearsal failed closed behind a build flag; the real wizard
    // decides from the actor's own scope, so a platform actor who has entered
    // no company is refused by the same predicate the import page uses.
    //
    // There is no source to open either — registration depends on the private
    // bucket, which is a deferred hosted boundary — so the wizard invites a
    // fresh start rather than showing an empty editor.
    await page.goto('/dashboard/import-export/wizard');
    const wizardState = page.locator('[data-testid="wizard-forbidden"], [data-testid="wizard-start-over"]');
    await expect(wizardState.first()).toBeVisible();
    // Whatever the state, there is no editor and nothing that could execute.
    await expect(page.getByTestId('mapping-editor')).toHaveCount(0);
    await expect(page.getByTestId('execute-import')).toHaveCount(0);
  });
});
