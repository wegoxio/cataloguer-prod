import { test, expect, request as playwrightRequest } from '@playwright/test';
import { ADMIN_EMAIL, ADMIN_PASSWORD, login, loginSlot } from './helpers';
import { seedUser } from './seed';

/**
 * Requirement 3 — mid-session role and access changes, with two isolated
 * sessions: the persona in a real browser, the administrator through request
 * contexts (supported APIs only).
 *
 * The backend reads authority from the database on every request, so a
 * downgrade governs the next request immediately even under a token that
 * still carries the old role claim. The browser catches up on scope refresh
 * or reload. Both halves are asserted here; the slow-response race is covered
 * by the provider's unit tests (claimed generations), not by this file.
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

async function company() {
  const admin = await tokenFor(ADMIN_EMAIL, ADMIN_PASSWORD);
  const suffix = stamp();
  const org = await callAs(admin, 'POST', '/organizations', { name: `RC ${suffix}`, plan: 'CRECIMIENTO' });
  expect(org.status, JSON.stringify(org.json)).toBeLessThan(300);
  const organizationId = org.json.data.id;
  const managed = { 'X-Managed-Organization': organizationId };
  const a = await callAs(admin, 'POST', '/stores', { name: `A ${suffix}`, slug: `a-${suffix}`, organizationId }, managed);
  const b = await callAs(admin, 'POST', '/stores', { name: `B ${suffix}`, slug: `b-${suffix}`, organizationId }, managed);
  expect(a.status).toBeLessThan(300);
  expect(b.status).toBeLessThan(300);
  const email = `rc-${suffix}@example.test`;
  const password = `Rc-${suffix}-Aa1!`;
  const userId = seedUser({ email, password, role: 'ADMIN', organizationId, storeId: a.json.data.id });
  return { admin, managed, organizationId, storeA: a.json.data.id, storeB: b.json.data.id, email, password, userId };
}

test.describe('Requirement 3 · mid-session role and access changes', () => {
  test.setTimeout(300_000);
  test.beforeEach(async () => freshLoginWindow());

  test('downgrade ADMIN → VIEWER: privileged controls vanish on reload, route denied, API refuses the OLD token', async ({ page }) => {
    const c = await company();
    // A token minted BEFORE the change — still unexpired, still claiming ADMIN.
    const staleToken = await tokenFor(c.email, c.password);
    await login(page, c.email, c.password);

    // Privileged state: Team is offered and lists tenant users.
    await expect(page.getByRole('link', { name: 'Team' })).toBeVisible();
    await page.goto('/dashboard/users');
    await expect(page.getByText(c.email).first()).toBeVisible();

    // The downgrade, through the supported administrator API.
    const changed = await callAs(c.admin, 'PATCH', `/users/${c.userId}/role`, { role: 'VIEWER' }, c.managed);
    expect(changed.status, JSON.stringify(changed.json)).toBeLessThan(300);

    // 1. Direct API with the pre-change token: refused with CURRENT authority.
    const direct = await callAs(staleToken, 'GET', '/users');
    expect(direct.status).toBe(403);

    // 2. Scope refresh + full reload: the control disappears.
    await page.reload();
    await expect(page.getByRole('link', { name: 'Team' })).toHaveCount(0);

    // 3. Direct protected-route navigation is denied, and no cached list shows.
    await page.goto('/dashboard/users');
    await expect(page.getByTestId('access-denied')).toBeVisible();
    // The team LIST (a table of tenant users) is gone. The header still names
    // the signed-in user — that is their own identity, not privileged data.
    await expect(page.getByRole('table')).toHaveCount(0);
  });

  test('store access moved A → B: authority follows the database, not the token', async ({ page }) => {
    const c = await company();
    const staleToken = await tokenFor(c.email, c.password);
    await login(page, c.email, c.password);

    const before = await callAs(staleToken, 'GET', '/auth/me');
    expect(before.json?.data?.scope?.storeId).toBe(c.storeA);

    const moved = await callAs(c.admin, 'PATCH', `/users/${c.userId}/store`, { storeId: c.storeB }, c.managed);
    expect(moved.status, JSON.stringify(moved.json)).toBeLessThan(300);

    // Same unexpired token, different answer: the server resolved scope fresh.
    const after = await callAs(staleToken, 'GET', '/auth/me');
    expect(after.json?.data?.scope?.storeId).toBe(c.storeB);

    // The browser reloads into a live session; the authority proof is the
    // before/after pair above, taken with the SAME pre-change token.
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard/);
  });

  test('DEACTIVATION mid-session: the old token is refused immediately', async () => {
    const c = await company();
    const staleToken = await tokenFor(c.email, c.password);
    expect((await callAs(staleToken, 'GET', '/auth/me')).status).toBe(200);
    const off = await callAs(c.admin, 'PATCH', `/users/${c.userId}/deactivate`, undefined, c.managed);
    expect(off.status, JSON.stringify(off.json)).toBeLessThan(300);
    expect((await callAs(staleToken, 'GET', '/auth/me')).status).toBe(401);
  });
});
