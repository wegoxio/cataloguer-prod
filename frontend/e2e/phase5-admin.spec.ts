import { test, expect, type Page } from '@playwright/test';
import { login } from './helpers';

/**
 * FOCUSED browser smoke tests for the Phase 5 administration capabilities
 * (P5-W5).
 *
 * Focused on purpose. The component suite proves the behaviour — which controls
 * a scope may see, and that the handlers refuse when reached anyway — without a
 * server. What only a real browser can show is that these surfaces are actually
 * WIRED: that the panels reach the page, and that a manufacturer code typed
 * into the form comes back from a search. Duplicating the authority matrix here
 * would buy nothing and cost a rate-limited login each.
 *
 * The builder entry has its own file, `website-builder.spec.ts`, which covers
 * visibility, the truthful notice, data preservation and a denied role.
 *
 * Each test builds its OWN company and website through the API and then enters
 * that company. Relying on whatever happens to be in the developer's database
 * makes a test that passes for the wrong reason — and on a fresh one, fails for
 * the wrong reason too.
 *
 * Local-only, like the rest of `e2e/`: there is no CI runner, and the login
 * route is rate-limited to five attempts a minute.
 */

const API = 'http://localhost:3001/api/v1';
const stamp = () => Date.now().toString(36);

/** Logs in and captures the Bearer token the panel already sends. */
async function loginAndCaptureToken(page: Page): Promise<string> {
  let captured = '';
  page.on('request', (req) => {
    const auth = req.headers()['authorization'];
    if (!captured && auth && auth.startsWith('Bearer ')) captured = auth.slice(7);
  });
  await login(page);
  await expect.poll(() => (captured ? 'captured' : 'pending'), { timeout: 10_000 }).toBe('captured');
  return captured;
}

async function apiPost(page: Page, token: string, path: string, body: unknown) {
  const res = await page.evaluate(
    async (args) => {
      const r = await fetch(`${args.api}${args.path}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${args.token}` },
        body: JSON.stringify(args.body),
      });
      return { status: r.status, json: await r.json().catch(() => null) };
    },
    { api: API, token, path, body },
  );
  expect(res.status, `POST ${path} -> ${JSON.stringify(res.json)}`).toBeLessThan(300);
  return res.json?.data;
}

/**
 * A company with one website, entered as the panel enters it.
 *
 * A store REQUIRES an organization (P0-01), and the catalogue modules only
 * appear once a company is in context — which is the scope-derived navigation
 * working, not an obstacle to route around.
 */
async function enterOwnCompany(page: Page, label: string, websiteUrl?: string) {
  const token = await loginAndCaptureToken(page);
  const organization = await apiPost(page, token, '/organizations', { name: `${label} Co` });
  expect(organization?.id, 'organization id').toBeTruthy();
  const store = await apiPost(page, token, '/stores', {
    name: `${label} Site`,
    organizationId: organization.id,
    ...(websiteUrl ? { websiteUrl } : {}),
  });
  expect(store?.id, 'store id').toBeTruthy();
  await page.evaluate(
    (tenant) => localStorage.setItem('wegox-managed-tenant', JSON.stringify(tenant)),
    { organizationId: organization.id, organizationName: organization.name ?? `${label} Co` },
  );
  return { organizationId: organization.id as string, storeId: store.id as string };
}

test('a product carries the four Phase 5 administration panels, and its manufacturer code is searchable', async ({
  page,
}) => {
  const label = `P5 Admin ${stamp()}`;
  const name = `${label} Chair`;
  const manufacturerCode = `MFR-${stamp().toUpperCase()}`;

  await enterOwnCompany(page, label);
  await page.goto('/dashboard/products');

  // The toolbar button by name: the true-empty state offers an Add Item of its
  // own, so the label alone is ambiguous on a company with nothing in it yet.
  await expect(page.locator('[data-testid="add-item"]')).toBeVisible();
  await page.locator('[data-testid="add-item"]').click();

  // Both identities are offered, separately (P5-W1).
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Manufacturer code').fill(manufacturerCode);

  // The two halves of the form are labelled (P5-W4 capability 4).
  await expect(page.getByText('Owned by the company')).toBeVisible();
  await expect(page.getByText('Set by each branch').first()).toBeVisible();

  await page.getByRole('button', { name: 'Save Product' }).click();
  await expect(page.getByText(/Product created/i)).toBeVisible();

  // The supplier's reference is searchable alongside the SKU (P5-W1).
  await page.getByPlaceholder(/manufacturer code/i).fill(manufacturerCode);
  await expect(page.getByRole('link', { name })).toBeVisible({ timeout: 15_000 });

  // The item page carries the Phase 5 panels.
  await page.getByRole('link', { name }).click();
  await expect(page.getByTestId('specifications-panel')).toBeVisible();
  await expect(page.getByTestId('documents-panel')).toBeVisible();
  await expect(page.getByTestId('related-panel')).toBeVisible();
  await expect(page.getByTestId('family-panel')).toBeVisible();

  const branchPanel = page.getByTestId('branch-panel');
  await expect(branchPanel).toBeVisible();
  // Availability is REPORTED, never an editable field (P5-W4 capability 4).
  await expect(branchPanel).toContainText(/Sellable now/i);
  await expect(branchPanel).toContainText(/ledger/i);
});
