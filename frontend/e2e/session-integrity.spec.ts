import { test, expect, request as playwrightRequest, Page } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, login, loginSlot } from './helpers';
import { seedUser } from './seed';

/**
 * Requirement 2 — expired or invalidated sessions, proven in a real browser
 * against the isolated local application.
 *
 * Three credential states are distinguished, exactly as the contract has them:
 *  - expired ACCESS token, valid refresh token → renewal succeeds silently;
 *  - refresh token REVOKED → re-authentication required: cleanup + redirect;
 *  - user DEACTIVATED → refused on the very next request, refresh refused too.
 *
 * Honesty about simulation: the access token is hard-coded to 15 minutes and a
 * test cannot wait for it. Where an "expired access token" is needed, ONE API
 * response is intercepted and answered 401 — that simulates the server judging
 * the token expired. Everything after that intercept is REAL: the client's
 * refresh POST hits the real backend, which really rotates or really refuses.
 * Revocation and deactivation themselves are real, through supported APIs.
 */

/**
 * Give every test its OWN login window. The server limits the login route to
 * five hits a minute per address and counts more than the shared ledger models
 * (the full-file run drifted over budget while each test passed alone), so
 * each test waits until 62s after the previous test's last sign-in. Slower,
 * and deterministic at any server speed.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
async function freshLoginWindow(): Promise<void> {
  const ledger = path.join(os.tmpdir(), 'cataloguer-e2e-login-ledger.json');
  let last = 0;
  try { last = Math.max(0, ...JSON.parse(fs.readFileSync(ledger, 'utf8'))); } catch { /* none yet */ }
  const wait = last + 62_000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

const API = 'http://localhost:3001/api/v1';
const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

async function tokenFor(email: string, password: string): Promise<string> {
  await loginSlot();
  const ctx = await playwrightRequest.newContext();
  const res = await ctx.post(`${API}/auth/login`, { data: { email, password } });
  const body = await res.json().catch(() => null);
  await ctx.dispose();
  expect(
    body?.data?.accessToken,
    `login failed for ${email}: HTTP ${res.status()} ${String(body?.message ?? '').slice(0, 80)}`,
  ).toBeTruthy();
  return body.data.accessToken;
}

async function callAs(token: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const ctx = await playwrightRequest.newContext();
  const res = await ctx.fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    data: body,
  });
  const json = await res.json().catch(() => null);
  await ctx.dispose();
  return { status: res.status(), json };
}

/** A fresh persona in a fresh company: nothing here touches any real tenant. */
async function persona() {
  const admin = await tokenFor(ADMIN_EMAIL, ADMIN_PASSWORD);
  const suffix = stamp();
  const org = await callAs(admin, 'POST', '/organizations', { name: `SEC ${suffix}`, plan: 'CRECIMIENTO' });
  expect(org.status, JSON.stringify(org.json)).toBeLessThan(300);
  const organizationId = org.json.data.id;
  const store = await callAs(admin, 'POST', '/stores', { name: `S ${suffix}`, slug: `s-${suffix}`, organizationId }, { 'X-Managed-Organization': organizationId });
  expect(store.status, JSON.stringify(store.json)).toBeLessThan(300);
  const email = `sec-${suffix}@example.test`;
  const password = `Sec-${suffix}-Aa1!`;
  const userId = seedUser({ email, password, role: 'ADMIN', organizationId, storeId: store.json.data.id });
  return { admin, organizationId, storeId: store.json.data.id, email, password, userId };
}

/** The Team page renders the persona's own email — protected tenant data. */
async function showProtectedData(page: Page, email: string) {
  await page.goto('/dashboard/users');
  await expect(page.getByText(email).first()).toBeVisible();
}

/** Intercept exactly ONE matching API response and answer 401 — the simulated expiry. */
async function simulateExpiredAccessOnce(page: Page, pathFragment: string) {
  let done = false;
  await page.route(`**/api/v1${pathFragment}**`, async (route) => {
    if (done) return route.continue();
    done = true;
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'Unauthorized' }) });
  });
}

test.describe('Requirement 2 · session expiry and invalidation', () => {
  test.setTimeout(300_000);
  test.beforeEach(async () => freshLoginWindow());

  test('expired access token with a VALID refresh token: renewal succeeds and data stays', async ({ page }) => {
    const p = await persona();
    await login(page, p.email, p.password);
    await showProtectedData(page, p.email);

    await simulateExpiredAccessOnce(page, '/users');
    const refresh = page.waitForResponse((r) => r.url().includes('/auth/refresh') && r.request().method() === 'POST');
    await page.reload();
    const refreshRes = await refresh;
    // The REAL refresh endpoint renewed the session.
    expect(refreshRes.status()).toBeLessThan(300);
    await expect(page.getByText(p.email).first()).toBeVisible();
    await expect(page).toHaveURL(/\/dashboard\/users/);
  });

  test('REVOKED refresh token + background 401: session ends, redirect to sign-in, tenant data gone, back-nav shows none', async ({ page }) => {
    const p = await persona();
    await login(page, p.email, p.password);
    await showProtectedData(page, p.email);

    // REAL revocation through the supported API: every session of this user.
    const second = await tokenFor(p.email, p.password);
    const revoked = await callAs(second, 'POST', '/auth/sessions/revoke-all');
    expect(revoked.status).toBeLessThan(300);

    // The browser's access token is still valid (15-minute contract). Simulate
    // its expiry on the next API call; the client's refresh then meets the REAL
    // server, which really refuses the revoked cookie.
    await simulateExpiredAccessOnce(page, '/users');
    const refresh = page.waitForResponse((r) => r.url().includes('/auth/refresh') && r.request().method() === 'POST');
    await page.getByRole('link', { name: /settings/i }).click().catch(() => page.goto('/dashboard/settings'));
    await page.goto('/dashboard/users');
    const refreshRes = await refresh;
    expect(refreshRes.status()).toBe(401);

    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(p.email)).toHaveCount(0);

    // Back navigation must not resurrect the protected page.
    await page.goBack();
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(p.email)).toHaveCount(0);
  });

  test('initial-load path: a reload after revocation lands on sign-in with nothing rendered', async ({ page }) => {
    const p = await persona();
    await login(page, p.email, p.password);
    await showProtectedData(page, p.email);

    const second = await tokenFor(p.email, p.password);
    await callAs(second, 'POST', '/auth/sessions/revoke-all');

    // Fully real: no interception. The load-time refresh is refused.
    const refresh = page.waitForResponse((r) => r.url().includes('/auth/refresh'));
    await page.reload();
    expect((await refresh).status()).toBe(401);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(p.email)).toHaveCount(0);
  });

  test('DEACTIVATION: the very next request is refused and refresh is refused — fully real', async ({ page }) => {
    const p = await persona();
    await login(page, p.email, p.password);
    await showProtectedData(page, p.email);

    const deactivated = await callAs(p.admin, 'PATCH', `/users/${p.userId}/deactivate`, undefined, {
      'X-Managed-Organization': p.organizationId,
    });
    expect(deactivated.status, JSON.stringify(deactivated.json)).toBeLessThan(300);

    // No simulation: the guard reloads the user, finds the soft delete, 401s;
    // the client refreshes; the refresh is refused for a deactivated user.
    const refresh = page.waitForResponse((r) => r.url().includes('/auth/refresh'));
    await page.goto('/dashboard/settings');
    expect((await refresh).status()).toBe(401);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(p.email)).toHaveCount(0);
  });

  test('a delayed in-flight scope response cannot repopulate a session after sign-out', async ({ page }) => {
    const p = await persona();
    await login(page, p.email, p.password);
    await showProtectedData(page, p.email);

    // Hold the next /auth/me reply until after sign-out completes, then release it.
    let release: (() => void) | null = null;
    await page.route('**/api/v1/auth/me', async (route) => {
      if (release) return route.continue();
      await new Promise<void>((r) => (release = r));
      await route.continue();
    });
    // Trigger a scope re-resolution (tenant key change) by navigating; then sign out mid-flight.
    await page.goto('/dashboard/settings');
    await page.getByRole('button', { name: /sign out/i }).click();
    await expect(page).toHaveURL(/\/login/);
    release!();
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByText(p.email)).toHaveCount(0);
  });
});
