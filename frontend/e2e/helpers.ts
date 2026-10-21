import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Page, expect } from '@playwright/test';

export const ADMIN_EMAIL = process.env.DEV_ADMIN_EMAIL || 'admin@wegox.com';
export const ADMIN_PASSWORD = process.env.DEV_ADMIN_PASSWORD || 'superadmin123';

/**
 * The login route allows FIVE attempts a minute per address, and the limit is
 * real: a full-battery run against production builds finishes files in
 * seconds, so sign-ins from ONE spec file land inside the window opened by
 * the previous one. Every sign-in takes a slot from this file-backed ledger
 * first — file-backed so it survives Playwright's worker restarts AND is
 * shared by every spec file in the run — and waits the window out when five
 * are live. Deterministic at any server speed, instead of passing only when
 * the suite happens to be slow.
 */
const LOGIN_LEDGER = path.join(os.tmpdir(), 'cataloguer-e2e-login-ledger.json');
export async function loginSlot(): Promise<void> {
  for (;;) {
    let attempts: number[] = [];
    try {
      attempts = JSON.parse(fs.readFileSync(LOGIN_LEDGER, 'utf8'));
    } catch {
      /* first attempt of a run */
    }
    const windowStart = Date.now() - 61_000;
    const live = attempts.filter((at) => at > windowStart);
    if (live.length < 5) {
      live.push(Date.now());
      fs.writeFileSync(LOGIN_LEDGER, JSON.stringify(live));
      return;
    }
    const wait = live[0] + 61_000 - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, wait)));
  }
}

export async function login(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await loginSlot();
  await page.goto('/login');
  await page.getByLabel('Email Address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
}
