import { test, expect, Page } from '@playwright/test';
import { login, loginSlot, ADMIN_EMAIL, ADMIN_PASSWORD } from './helpers';
import { query, execute } from './db';

/**
 * #295 G1 acceptance correction — which branch a new invoice or manual sale is
 * for, at COMPANY scope ("All branches"), on a disposable stack.
 *
 * The first journey is the production failure exactly: the owner enters a
 * freshly onboarded company (one live branch) without narrowing, opens New
 * invoice, and issues it. Before the correction the picker was hidden (it
 * needed two or more branches), nothing was selected, and the server answered
 * "A target storeId is required for this operation". Then a second branch
 * makes the choice explicit, and archiving every branch blocks the forms with
 * no request sent.
 */
const API = process.env.E2E_API_URL || 'http://localhost:3001/api/v1';
const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function ownerToken(page: Page): Promise<string> {
  await loginSlot();
  const res = await page.request.post(`${API}/auth/login`, { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).data.accessToken as string;
}

async function enterCompany(page: Page, organizationId: string, name: string) {
  await login(page);
  await page.evaluate(
    ({ tenant }) => localStorage.setItem('wegox-managed-tenant', JSON.stringify(tenant)),
    { tenant: { organizationId, organizationName: name, storeId: null } },
  );
}

/** The editor's customer-name input: its label is not linked by id, so it is reached through the label's field wrapper. */
const customerName = (page: Page) => page.locator('label', { hasText: /^Name$/ }).first().locator('xpath=..').locator('input');

function recordRequests(page: Page, needle: string) {
  const seen: { method: string; url: string }[] = [];
  page.on('request', (r) => {
    if (r.url().includes(needle) && r.method() !== 'GET' && r.method() !== 'OPTIONS') seen.push({ method: r.method(), url: r.url() });
  });
  return seen;
}

test.describe.serial('#295 G1 · branch target at company scope', () => {
  let token = '';
  let organizationId = '';
  let firstBranch = '';
  let secondBranch = '';
  const companyName = `Branch ${tag}`;

  test('setup: one company, exactly one live branch, one sellable item', async ({ page }) => {
    token = await ownerToken(page);
    const onboarded = await page.request.post(`${API}/organizations/onboard`, {
      headers: { authorization: `Bearer ${token}` },
      data: { organization: { name: companyName }, manager: { email: `branch-${tag}@example.test` }, store: { name: `${companyName} Centro` } },
    });
    expect(onboarded.ok()).toBeTruthy();
    const body = await onboarded.json();
    organizationId = body.data.organization.id;
    firstBranch = body.data.store.id;
    expect(query<{ n: string }>(`select count(*)::text as n from stores where organization_id = '${organizationId}' and archived_at is null and removed_at is null`)[0].n).toBe('1');
    const product = await page.request.post(`${API}/products`, {
      headers: { authorization: `Bearer ${token}`, 'x-managed-organization': organizationId },
      data: { name: `Item ${tag}`, status: 'PUBLISHED', price: 5, storeIds: [firstBranch] },
    });
    expect(product.ok(), await product.text()).toBeTruthy();
  });

  test('THE ACCEPTANCE FAILURE: company scope, "All branches", one live branch — the invoice is issued on that branch without a picker, and a manual sale is recorded the same way', async ({ page }) => {
    const posts = recordRequests(page, '/api/v1/invoices');
    await enterCompany(page, organizationId, companyName);
    await page.goto('/dashboard/sales/invoices/new');
    await expect(page.getByTestId('branch-target-single')).toContainText(`${companyName} Centro`, { timeout: 60_000 });
    await expect(page.getByTestId('branch-target-picker')).toHaveCount(0);
    await customerName(page).fill('Cliente');
    await page.getByPlaceholder('e.g. Tequeños x50 tray').first().fill('Service');
    const save = page.getByTestId('invoice-save');
    await expect(save).toBeEnabled();
    const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/invoices') && r.request().method() === 'POST');
    await save.click();
    const response = await created;
    expect(response.status(), await response.text()).toBe(201);
    const invoice = (await response.json()).data;
    expect(invoice.store.id).toBe(firstBranch);
    expect(posts.length).toBe(1);
    await expect(page).toHaveURL(new RegExp(`/dashboard/sales/invoices/${invoice.id}`), { timeout: 30_000 });

    // The manual sale, from the same company scope.
    await page.goto('/dashboard/sales');
    await page.getByRole('button', { name: /add sale/i }).first().click();
    await expect(page.getByTestId('branch-target-single')).toContainText(`${companyName} Centro`);
    const itemSelect = page.locator('[role="dialog"] select').first();
    await expect(itemSelect.locator('option', { hasText: `Item ${tag}` })).toHaveCount(1, { timeout: 30_000 });
    await itemSelect.selectOption({ label: `Item ${tag} ($5)` }).catch(async () => {
      const value = await itemSelect.locator('option', { hasText: `Item ${tag}` }).getAttribute('value');
      await itemSelect.selectOption(value!);
    });
    const sold = page.waitForResponse((r) => r.url().endsWith('/api/v1/sales') && r.request().method() === 'POST');
    await page.getByTestId('sale-submit').click();
    const saleResponse = await sold;
    expect(saleResponse.status(), await saleResponse.text()).toBe(201);
    expect(query<{ store_id: string }>(`select store_id from sales_orders where organization_id = '${organizationId}' order by created_at desc limit 1`)[0].store_id).toBe(firstBranch);
  });

  test('two live branches: the choice is explicit, nothing is sent until a branch is chosen, and the chosen branch is used', async ({ page }) => {
    // `query()` wraps its statement in a SELECT, so the insert runs through `execute()`.
    execute(
      `insert into stores (name, slug, organization_id, created_at, updated_at) values ('${companyName} Norte', 'norte-${tag}', '${organizationId}', now(), now())`,
    );
    secondBranch = query<{ id: string }>(`select id from stores where slug = 'norte-${tag}'`)[0].id;
    const posts = recordRequests(page, '/api/v1/invoices');
    await enterCompany(page, organizationId, companyName);
    await page.goto('/dashboard/sales/invoices/new');
    const picker = page.getByTestId('branch-target-picker');
    await expect(picker).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('branch-target-single')).toHaveCount(0);
    await expect(page.getByTestId('branch-target-choose')).toBeVisible();
    await customerName(page).fill('Cliente');
    await page.getByPlaceholder('e.g. Tequeños x50 tray').first().fill('Service');
    const save = page.getByTestId('invoice-save');
    await expect(save).toBeDisabled();
    await save.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(500);
    expect(posts.length).toBe(0);
    await picker.selectOption(secondBranch);
    await expect(save).toBeEnabled();
    const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/invoices') && r.request().method() === 'POST');
    await save.click();
    const response = await created;
    expect(response.status()).toBe(201);
    expect((await response.json()).data.store.id).toBe(secondBranch);
  });

  test('zero live branches (archived ones are never selected): a truthful blocked state and no request, for the invoice and the sale', async ({ page }) => {
    execute(`update stores set archived_at = now() where organization_id = '${organizationId}' and archived_at is null`);
    expect(query<{ n: string }>(`select count(*)::text as n from stores where organization_id = '${organizationId}' and archived_at is null and removed_at is null`)[0].n).toBe('0');
    const invoicePosts = recordRequests(page, '/api/v1/invoices');
    const salePosts = recordRequests(page, '/api/v1/sales');
    await enterCompany(page, organizationId, companyName);
    await page.goto('/dashboard/sales/invoices/new');
    await expect(page.getByTestId('branch-target-none')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('branch-target-picker')).toHaveCount(0);
    await customerName(page).fill('Cliente');
    await page.getByPlaceholder('e.g. Tequeños x50 tray').first().fill('Service');
    await expect(page.getByTestId('invoice-save')).toBeDisabled();
    await page.goto('/dashboard/sales');
    await page.getByRole('button', { name: /add sale/i }).first().click();
    await expect(page.getByTestId('branch-target-none')).toBeVisible();
    await expect(page.getByTestId('sale-submit')).toBeDisabled();
    await page.waitForTimeout(500);
    expect(invoicePosts.length).toBe(0);
    expect(salePosts.length).toBe(0);
  });
});
