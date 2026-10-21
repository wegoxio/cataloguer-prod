import { test, expect } from '@playwright/test';
import { login, ADMIN_EMAIL } from './helpers';

test('rejects wrong credentials, then logs in and shows the owner shell', async ({ page }) => {
  // Wrong password first (same page session keeps login attempts low: 5/min limit)
  await page.goto('/login');
  await page.getByLabel('Email Address').fill(ADMIN_EMAIL);
  await page.getByLabel('Password', { exact: true }).fill('definitely-wrong');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByText(/invalid email or password/i)).toBeVisible();

  // Correct credentials
  await login(page);

  // The platform owner's business-only shell (catalog modules live inside
  // each company via Clients → Manage)
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Clients' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Websites / Apps' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Items' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /sign out/i })).toBeVisible();
});
