import { test, expect, Page, BrowserContext, APIRequestContext } from '@playwright/test';
import { login, loginSlot, ADMIN_EMAIL, ADMIN_PASSWORD } from './helpers';
import { query, execute } from './db';

/**
 * PLAN GRATIS, END TO END, WITH THE REAL SIGN-IN AND THE REAL GUARDS.
 *
 * A company waiting for its first payment is read-only (the control). The
 * unscoped platform owner moves it to Plan Gratis from the branch Settings
 * plan selector; the Clients table then says "Plan Gratis" and "Free"; its
 * manager can write again, sees a free plan with nothing to buy, and cannot
 * start a checkout. Every authority refusal is made with a real access token.
 *
 * The one direct-SQL write is a test fixture on the disposable database: a
 * LEGACY row still marked PENDING while on Plan Gratis, to prove the gate reads
 * the effective status rather than the stored one.
 */
const API = process.env.E2E_API_URL || 'http://localhost:3001/api/v1';
const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const MANAGER_PASSWORD = 'Wegox-Gratis-2026';
const READ_ONLY = 'Your panel is read-only until the first payment.';

test.describe.serial('Plan Gratis · assignment, billing state, presentation and Stripe isolation', () => {
  let api: APIRequestContext;
  let ownerToken = '';
  let managerToken = '';
  let organizationId = '';
  let storeId = '';
  let managerEmail = '';
  let managerContext: BrowserContext;
  let manager: Page;

  const owner = () => ({ Authorization: `Bearer ${ownerToken}` });
  const managed = () => ({ ...owner(), 'X-Managed-Organization': organizationId });
  const asManager = () => ({ Authorization: `Bearer ${managerToken}` });
  const state = () =>
    query<{ plan: string; billing_status: string; customer: string | null }>(
      `select plan, billing_status, stripe_customer_id as customer from organizations where id = '${organizationId}'`,
    )[0];
  const newItem = (name: string) =>
    api.post(`${API}/products`, {
      headers: asManager(),
      data: { name: `${name} ${tag}`, price: 10, status: 'DRAFT', stockQuantity: 0, trackInventory: false, storeIds: [storeId] },
    });

  test.beforeAll(async ({ browser, playwright }) => {
    api = await playwright.request.newContext();
    await loginSlot();
    const session = await api.post(`${API}/auth/login`, { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    expect(session.status()).toBe(201);
    ownerToken = (await session.json()).data.accessToken;

    managerEmail = `gratis-mgr-${tag}@example.com`;
    const onboarded = await api.post(`${API}/organizations/onboard`, {
      headers: owner(),
      data: { organization: { name: `Gratis ${tag}`, plan: 'BASICO' }, store: { name: `Gratis ${tag}` }, manager: { email: managerEmail } },
    });
    expect(onboarded.status()).toBe(201);
    const created = (await onboarded.json()).data;
    organizationId = created.organization.id;
    storeId = created.store.id;
    const password = await api.patch(`${API}/users/${created.manager.id}/password`, { headers: managed(), data: { password: MANAGER_PASSWORD } });
    expect(password.status()).toBe(200);

    // The supported way to put a company into "waiting for payment".
    const pending = await api.patch(`${API}/organizations/${organizationId}`, { headers: owner(), data: { billingStatus: 'PENDING_FIRST_PAYMENT' } });
    expect(pending.status()).toBe(200);

    await loginSlot();
    const managerSession = await api.post(`${API}/auth/login`, { data: { email: managerEmail, password: MANAGER_PASSWORD } });
    expect(managerSession.status()).toBe(201);
    managerToken = (await managerSession.json()).data.accessToken;

    managerContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    manager = await managerContext.newPage();
    await login(manager, managerEmail, MANAGER_PASSWORD);
  });

  test.afterAll(async () => {
    await managerContext?.close();
    await api?.dispose();
  });

  test('CONTROL — while waiting for payment the manager is read-only', async () => {
    await manager.goto('/dashboard');
    await expect(manager.getByText(READ_ONLY)).toBeVisible({ timeout: 30_000 });
    const refused = await newItem('Before Gratis');
    expect(refused.status()).toBe(403);
    expect(state()).toMatchObject({ plan: 'BASICO', billing_status: 'PENDING_FIRST_PAYMENT' });
  });

  test('authority — manager, and a Superadmin inside the managed company, cannot assign Plan Gratis', async () => {
    const byManager = await api.patch(`${API}/organizations/${organizationId}`, { headers: asManager(), data: { plan: 'GRATIS' } });
    const byManagerBranch = await api.patch(`${API}/stores/${storeId}/plan`, { headers: asManager(), data: { plan: 'GRATIS' } });
    const byManagedOwner = await api.patch(`${API}/organizations/${organizationId}`, { headers: managed(), data: { plan: 'GRATIS' } });
    const byManagedOwnerBranch = await api.patch(`${API}/stores/${storeId}/plan`, { headers: managed(), data: { plan: 'GRATIS' } });
    const managedOnboard = await api.post(`${API}/organizations/onboard`, {
      headers: managed(),
      data: { organization: { name: `Scoped Gratis ${tag}`, plan: 'GRATIS' }, manager: { email: `scoped-${tag}@example.com` } },
    });
    expect([byManager.status(), byManagerBranch.status(), byManagedOwner.status(), byManagedOwnerBranch.status(), managedOnboard.status()]).toEqual([
      403, 403, 403, 403, 403,
    ]);
    expect(state()).toMatchObject({ plan: 'BASICO', billing_status: 'PENDING_FIRST_PAYMENT' });
    expect(query<{ n: string }>(`select count(*)::text as n from organizations where name = 'Scoped Gratis ${tag}'`)[0].n).toBe('0');
  });

  test('Clients shows the company\'s actual plan, and the unscoped owner assigns Plan Gratis there for the whole company', async ({ page }) => {
    await login(page);
    await page.goto('/dashboard/clients');
    const companyPlan = page.locator(`[data-testid="active-company-plan-${organizationId}"]`);
    await expect(companyPlan).toContainText('Básico', { timeout: 30_000 });
    await page.locator(`[data-testid="change-plan-${organizationId}"]`).click();
    await expect(page.locator('[data-testid="company-plan-current"]')).toContainText('Básico');
    await expect(page.locator('#company-plan-select')).toHaveValue('BASICO');
    await expect(page.locator('[data-testid="company-plan-save"]')).toBeDisabled();

    await page.locator('#company-plan-select').selectOption('GRATIS');
    const notice = page.locator('[data-testid="company-plan-gratis-notice"]');
    for (const line of ['Free', 'Same limits as Básico', 'No card subscription required', 'Applies to the entire company and all its branches']) {
      await expect(notice).toContainText(line);
    }
    const saved = page.waitForResponse((r) => r.url().includes(`/organizations/${organizationId}`) && r.request().method() === 'PATCH');
    await page.locator('[data-testid="company-plan-save"]').click();
    expect((await saved).status()).toBe(200);
    expect(state()).toMatchObject({ plan: 'GRATIS', billing_status: 'ACTIVE', customer: null });
    await expect(companyPlan).toContainText('Plan Gratis');

    const cell = page.locator(`[data-testid="client-plan-${storeId}"]`);
    await expect(cell).toContainText('Plan Gratis');
    await expect(cell).toContainText('Free');
    await expect(cell).not.toContainText('$');

    // The branch no longer carries a plan control of its own.
    await page.goto(`/dashboard/website/${storeId}#settings`);
    await expect(page.locator('[data-testid="company-plan-managed-in-clients"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#store-commercial-plan')).toHaveCount(0);
    await expect(page.getByLabel('Commercial plan (platform owner only)')).toHaveCount(0);
  });

  test('the manager writes again, sees a free plan, and is offered nothing to buy', async () => {
    await manager.goto('/dashboard/billing');
    await expect(manager.locator('[data-testid="billing-current-plan"]')).toHaveText('Plan Gratis', { timeout: 30_000 });
    await expect(manager.locator('[data-testid="billing-current-price"]')).toHaveText('Free');
    await expect(manager.getByText(READ_ONLY)).toHaveCount(0);
    await expect(manager.getByRole('button', { name: /Activate card payment|Pay by card|Manage payment/ })).toHaveCount(0);
    await expect(manager.locator('[data-testid="billing-plan-option-GRATIS"]')).toHaveCount(0);
    await expect(manager.locator('[data-testid^="billing-plan-option-"]')).toHaveCount(4);

    const allowed = await newItem('After Gratis');
    expect(allowed.status()).toBe(201);
  });

  test('Stripe isolation — no checkout for Plan Gratis, and none from a Plan Gratis company, with no attempt or customer', async () => {
    const forGratis = await api.post(`${API}/billing/checkout`, { headers: asManager(), data: { plan: 'GRATIS' } });
    expect(forGratis.status()).toBe(400);
    for (const plan of ['BASICO', 'CRECIMIENTO']) {
      const fromGratis = await api.post(`${API}/billing/checkout`, { headers: asManager(), data: { plan } });
      expect(fromGratis.status()).toBe(400);
      expect((await fromGratis.json()).message).toContain('complimentary plan');
    }
    expect(query<{ n: string }>(`select count(*)::text as n from billing_checkout_attempts where organization_id = '${organizationId}'`)[0].n).toBe('0');
    expect(state()).toMatchObject({ plan: 'GRATIS', customer: null });
  });

  test('a legacy Plan Gratis row still marked PENDING is never read-only', async () => {
    execute(`update organizations set billing_status = 'PENDING_FIRST_PAYMENT' where id = '${organizationId}' and plan = 'GRATIS'`);
    const status = await api.get(`${API}/billing/status`, { headers: asManager() });
    expect((await status.json()).data).toMatchObject({ billingStatus: 'ACTIVE', plan: { key: 'GRATIS', complimentary: true } });
    const allowed = await newItem('Legacy Gratis');
    expect(allowed.status()).toBe(201);
    await manager.goto('/dashboard');
    await expect(manager.locator('h1, h2').first()).toBeVisible({ timeout: 30_000 });
    await expect(manager.getByText(READ_ONLY)).toHaveCount(0);
  });
  test('switching branches never changes the company plan, and a second branch does not add recurring revenue', async ({ page }) => {
    const twoTag = `${tag}b`;
    const onboarded = await api.post(`${API}/organizations/onboard`, {
      headers: owner(),
      data: { organization: { name: `Two Branch ${twoTag}`, plan: 'CRECIMIENTO' }, store: { name: `Two Branch A ${twoTag}` }, manager: { email: `two-${twoTag}@example.com` } },
    });
    expect(onboarded.status()).toBe(201);
    const two = (await onboarded.json()).data;
    const overviewTotals = async () => (await (await api.get(`${API}/stores/overview`, { headers: owner() })).json()).data.totals;
    const before = await overviewTotals();
    const second = await api.post(`${API}/stores`, {
      headers: { ...owner(), 'X-Managed-Organization': two.organization.id },
      data: { name: `Two Branch B ${twoTag}`, organizationId: two.organization.id },
    });
    expect(second.status()).toBe(201);
    const branchB = (await second.json()).data.id;
    const after = await overviewTotals();
    expect(after.monthlyRecurringUsd).toBe(before.monthlyRecurringUsd);
    expect(after.recurringCompanies).toBe(before.recurringCompanies);
    expect(after.activeClients).toBe(before.activeClients + 1);

    await login(page);
    await page.evaluate(
      ({ tenant }) => localStorage.setItem('wegox-managed-tenant', JSON.stringify(tenant)),
      { tenant: { organizationId: two.organization.id, organizationName: `Two Branch ${twoTag}`, storeId: null } },
    );
    for (const branch of [null, two.store.id, branchB]) {
      if (branch) {
        await page.evaluate(
          ({ tenant }) => localStorage.setItem('wegox-managed-tenant', JSON.stringify(tenant)),
          { tenant: { organizationId: two.organization.id, organizationName: `Two Branch ${twoTag}`, storeId: branch } },
        );
      }
      await page.goto('/dashboard/billing');
      await expect(page.locator('[data-testid="billing-current-plan"]')).toHaveText('Plan Crecimiento', { timeout: 30_000 });
    }
  });
});
