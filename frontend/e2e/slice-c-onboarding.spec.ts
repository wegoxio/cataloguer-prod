import { test, expect, Page, BrowserContext, APIRequestContext } from '@playwright/test';
import { login, ADMIN_EMAIL, ADMIN_PASSWORD } from './helpers';

/**
 * THE CUTOVER, PROVED IN A REAL BROWSER AGAINST A REAL BACKEND.
 *
 * A backend route no frontend calls does not fix onboarding, so the claim under
 * test is about the SCREEN: pressing "Create and invite" issues ONE request to
 * `/organizations/onboard`, and the company it produces has an
 * ORGANIZATION_MANAGER — not the store-bound ADMIN every company onboarded
 * through the old three-request sequence received.
 *
 * Counting the requests is the assertion, not an implementation detail: "one
 * transactional call" is precisely the property that removes the partial-commit
 * windows.
 *
 * One login for the whole file: the login endpoint is rate limited to 5/min,
 * and a suite that spends its budget on ceremony fails for the wrong reason.
 */
const API = 'http://localhost:3001/api/v1';
const unique = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

test.describe.serial('Slice C · onboarding is one request and produces a manager', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  let context: BrowserContext;
  let page: Page;
  let api: APIRequestContext;
  let apiToken: string;

  test.beforeAll(async ({ browser, playwright }) => {
    context = await browser.newContext();
    page = await context.newPage();
    api = await playwright.request.newContext();
    await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
    // A token of its own: the panel keeps the browser's in memory in some
    // builds, and reading an absent one out of localStorage fails as a 401 that
    // says nothing about onboarding.
    const session = await api.post(`${API}/auth/login`, { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    apiToken = (await session.json()).data.accessToken;
  });

  test.afterAll(async () => {
    await context?.close();
    await api?.dispose();
  });

  /** Fills the New Client form and returns the single onboarding response. */
  const onboard = async (company: string, email: string, websiteUrl?: string) => {
    await page.goto('/dashboard/clients');
    await page.getByRole('button', { name: /New Client|Nuevo cliente/i }).click();
    await page.locator('input[name="clientCompanyName"]').fill(company);
    await page.locator('input[name="clientAdminEmail"]').fill(email);
    if (websiteUrl) await page.locator('input[name="clientWebsiteUrl"]').fill(websiteUrl);

    const wait = page.waitForResponse(
      (r) => r.url().includes('/organizations/onboard') && r.request().method() === 'POST',
      { timeout: 30_000 },
    );
    await page.getByRole('button', { name: /Create and invite|Crear e invitar/i }).click();
    return wait;
  };

  const banner = () => page.locator('[data-testid="onboarding-result"]');
  const resendButton = () => page.getByRole('button', { name: /Resend invitation|Reenviar invitación/i });

  test('the Clients screen posts once and the new company has an ORGANIZATION_MANAGER', async () => {
    const seen: string[] = [];
    const record = (r: { method(): string; url(): string }) => {
      if (r.method() === 'POST' && r.url().includes('/api/v1/')) {
        seen.push(new URL(r.url()).pathname.replace('/api/v1', ''));
      }
    };
    page.on('request', record);

    const tag = unique();
    const company = `Slice C ${tag}`;
    const managerEmail = `slice-c-${tag}@example.com`;
    const response = await onboard(company, managerEmail, `https://slice-c-${tag}.example.com`);
    page.off('request', record);

    expect(response.status()).toBe(201);
    const body = await response.json();
    // THE DEFECT THIS CLOSES: a manager, organization-wide, no branch.
    expect(body.data.manager.role).toBe('ORGANIZATION_MANAGER');
    expect(body.data.manager.store).toBeNull();
    expect(body.data.idempotent).toBe(false);
    // A CREATION always makes an attempt, so it reports that attempt's outcome
    // and never UNKNOWN. Which of the two it is belongs to the environment —
    // this run has no reachable mail provider — and pinning DELIVERED here
    // would be asserting the mail server, not the contract. The retry test
    // below pins UNKNOWN exactly, because that value IS the contract.
    expect(body.data.invitation.pending).toBe(true);
    expect(['DELIVERED', 'FAILED']).toContain(body.data.invitation.deliveryStatus);
    const attempted = body.data.invitation.deliveryStatus as 'DELIVERED' | 'FAILED';
    expect(body.data.organization.name).toBe(company);
    expect(body.data.store).not.toBeNull();

    // EXACTLY ONE write for the whole onboarding — the old sequence was three,
    // and none of its endpoints may be posted to any more.
    const writes = seen.filter((p) => !p.startsWith('/auth/'));
    expect(writes).toEqual(['/organizations/onboard']);

    // The banner states exactly that attempt.
    await expect(banner()).toBeVisible({ timeout: 15_000 });
    await expect(banner()).toHaveAttribute('data-delivery', attempted);
    await expect(banner()).toHaveAttribute('data-pending', 'yes');
    await expect(page.locator('[data-testid="onboarding-invitation-state"]')).toContainText(managerEmail);
    // Delivered leaves nothing to re-send; a failed attempt offers the recovery.
    await expect(resendButton()).toHaveCount(attempted === 'DELIVERED' ? 0 : 1);
  });

  /**
   * The state the old boolean could not express. A retry sends no email, so
   * `delivered: false` said "the invitation failed" about an invitation that
   * was fine — failure copy and a resend button over a healthy company.
   */
  test('an exact retry creates nothing, and reports UNKNOWN rather than a failure', async () => {
    const tag = unique();
    const company = `Slice C Retry ${tag}`;
    const managerEmail = `slice-c-retry-${tag}@example.com`;
    const website = `https://retry-${tag}.example.com`;

    const first = await (await onboard(company, managerEmail, website)).json();
    expect(first.data.idempotent).toBe(false);

    const second = await (await onboard(company, managerEmail, website)).json();
    expect(second.data.idempotent).toBe(true);
    expect(second.data.organization.id).toBe(first.data.organization.id);
    expect(second.data.manager.id).toBe(first.data.manager.id);
    expect(second.data.invitation).toEqual({ pending: true, deliveryStatus: 'UNKNOWN' });

    await expect(banner()).toHaveAttribute('data-delivery', 'UNKNOWN');
    await expect(banner()).toContainText(/already existed|ya existía/i);
    await expect(banner()).toContainText(/Nothing was duplicated|No se duplicó nada/i);
    await expect(banner()).not.toContainText(/could not be delivered|no se pudo entregar/i);
    // An explicit resend stays available — it is the operator's decision.
    await expect(resendButton()).toHaveCount(1);
  });

  /**
   * AND THE STATE THAT WAS PLAINLY WRONG: once the manager has accepted, there
   * is no invitation left to describe as delivered or failed, and nothing to
   * re-send. The old screen offered both.
   */
  test('an exact retry AFTER acceptance says accepted, with no failure wording and no resend', async () => {
    const tag = unique();
    const company = `Slice C Accepted ${tag}`;
    const managerEmail = `slice-c-accepted-${tag}@example.com`;
    const website = `https://accepted-${tag}.example.com`;

    const first = await (await onboard(company, managerEmail, website)).json();
    const organizationId = first.data.organization.id;
    const managerId = first.data.manager.id;

    // Accept on the manager's behalf, through a supported route: a platform
    // owner managing that company sets the password directly. (Which is also
    // why acceptance is NOT treated as proof the invitation email arrived.)
    const accepted = await api.patch(`${API}/users/${managerId}/password`, {
      headers: { Authorization: `Bearer ${apiToken}`, 'X-Managed-Organization': organizationId },
      data: { password: 'Wegox-Catalog-2026' },
    });
    expect(accepted.status()).toBe(200);

    const retry = await (await onboard(company, managerEmail, website)).json();
    expect(retry.data.idempotent).toBe(true);
    expect(retry.data.invitation.pending).toBe(false);
    expect(retry.data.invitation.deliveryStatus).not.toBe('FAILED');

    await expect(banner()).toHaveAttribute('data-pending', 'no');
    await expect(banner()).toContainText(/has already accepted|ya aceptó/i);
    await expect(banner()).not.toContainText(/could not be delivered|no se pudo entregar/i);
    await expect(resendButton()).toHaveCount(0);
  });

  /**
   * THE WEBSITE STAYS OPTIONAL — the cutover changes how many requests this
   * screen makes, not what it asks the operator for. Two older journeys
   * (`categories.spec.ts`, `prc-parent-journey.spec.ts`) onboard a company with
   * a name and an email only, so requiring a website here would break them.
   * D2 is about the STORE always being sent, which it still is.
   */
  test('a company with no website still onboards, and a store is still created', async () => {
    const tag = unique();
    const company = `No Website ${tag}`;

    await page.goto('/dashboard/clients');
    await page.getByRole('button', { name: /New Client|Nuevo cliente/i }).click();
    await page.locator('input[name="clientCompanyName"]').fill(company);
    await page.locator('input[name="clientAdminEmail"]').fill(`no-site-${tag}@example.com`);
    await expect(page.getByRole('button', { name: /Create and invite|Crear e invitar/i })).toBeEnabled();

    const response = await onboard(company, `no-site-${tag}@example.com`);
    expect(response.status()).toBe(201);

    // D2 holds without the website: a store is sent, and it has none.
    const sent = JSON.parse(response.request().postData() ?? '{}');
    expect(sent.store).toEqual({ name: company });
    const body = await response.json();
    expect(body.data.store).not.toBeNull();
    expect(body.data.store.websiteUrl).toBeNull();
    expect(body.data.manager.role).toBe('ORGANIZATION_MANAGER');
  });
});
