import { test, expect, Page, BrowserContext } from '@playwright/test';
import { login } from './helpers';

/**
 * #185 (P3-04): the billing gate must be read ONCE per tenant instead of on
 * every navigation, and must still be correct the moment billing changes.
 *
 * `/billing/status` is stubbed so the assertions depend on our own cache and
 * invalidation logic, never on a seeded billing state. Every test separates
 * the provider's INITIAL request (a baseline) from the requests an event
 * causes, so an initial fetch can never be mistaken for a refresh.
 *
 * The suite logs in ONCE (serial mode, one shared context): the backend rate
 * limits /auth/login to 5/min and the other spec files need that budget. Each
 * test re-enters via page.goto — the httpOnly refresh cookie re-authenticates
 * without touching /auth/login, and the full load freshly mounts the provider.
 */

test.describe.configure({ mode: 'serial' });

const PANEL_ORIGIN = 'http://localhost:3000';
const STATUS_ROUTE = '**/api/v1/billing/status*';
const INVALIDATION_KEY = 'wegox-billing-invalidated';
const INVALIDATION_EVENT = 'wegox:billing-invalidated';

const CORS = {
  'access-control-allow-origin': PANEL_ORIGIN,
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'authorization,content-type,x-managed-organization,x-managed-store',
  'access-control-allow-methods': 'GET,OPTIONS',
};

interface Stub {
  /** Mutable: a test can change what the next read returns. */
  status: string;
  /** One entry per GET that actually reached the network. */
  calls: Record<string, string>[];
}

/** Stubs GET /billing/status for ONE page and records every call it makes. */
async function stubBillingStatus(target: Page, status = 'ACTIVE'): Promise<Stub> {
  const stub: Stub = { status, calls: [] };
  await target.route(STATUS_ROUTE, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    stub.calls.push(request.headers());
    await route.fulfill({
      status: 200,
      headers: { ...CORS, 'content-type': 'application/json' },
      body: JSON.stringify({ data: { billingStatus: stub.status, plan: null } }),
    });
  });
  return stub;
}

/** Waits for the provider's first read, so later counts measure refreshes. */
async function settleBaseline(stub: Stub, expected = 1, page?: Page): Promise<void> {
  await expect.poll(() => stub.calls.length, { timeout: 10_000 }).toBe(expected);
  // A further, unexpected read would still be pending; give it a chance to
  // appear so the baseline is genuinely quiet before the test acts.
  //
  // The quiet window is generous ON PURPOSE. On a cold Next dev server the
  // first visit to a route compiles it, so a second baseline read can land
  // well over a second after the first — and a test that started acting in
  // that gap would attribute the straggler to whatever it did next. That is
  // exactly how the focus-revalidation assertion was observed failing with
  // "expected 1, received 2": the extra read was never a revalidation, it was
  // the baseline still settling. Waiting for the network to go idle first, and
  // then holding the count for longer, makes the precondition true instead of
  // making the assertion looser.
  if (page) await page.waitForLoadState('networkidle').catch(() => undefined);
  await expect.poll(() => stub.calls.length, { timeout: 4_000 }).toBe(expected);
}

const BANNER_PENDING = 'Your panel is read-only until the first payment.';
const BANNER_SUSPENDED = 'Your subscription is paused, so the panel is read-only.';

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  await login(page); // the suite's ONLY /auth/login hit
});

test.afterAll(async () => {
  await context.close();
});

test.afterEach(async () => {
  // Each test registers its own stub and may enter manage mode; leave the
  // shared page clean for the next test's fresh goto.
  await page.unroute(STATUS_ROUTE);
  await page.evaluate(
    ({ key }) => {
      window.localStorage.removeItem('wegox-managed-tenant');
      window.localStorage.removeItem(key);
    },
    { key: INVALIDATION_KEY },
  );
});

test('reads billing status once across client-side navigation', async () => {
  const stub = await stubBillingStatus(page, 'ACTIVE');
  await page.goto('/dashboard');
  await settleBaseline(stub, 1, page);

  // Survives only if no full document load happens: proves the five moves
  // below are client-side navigations, not reloads that remount the provider.
  await page.evaluate(() => {
    (window as unknown as { __noReload?: boolean }).__noReload = true;
  });

  // 'Team' is deliberately absent from this walk. P5-A2 family 6 made staffing
  // require a company (`canManageTeam` → `hasOrganization`), so the UNSCOPED
  // platform owner this test signs in as no longer sees it — staffing a client
  // is a tenant act and the owner must enter that company first. What this test
  // is about is the number of billing reads across CLIENT-SIDE navigations, and
  // four of them prove it exactly as five did.
  const nav = page.getByRole('navigation');
  for (const label of ['Clients', 'Websites / Apps', 'Settings', 'Dashboard']) {
    await nav.getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard/);
  }

  expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true);
  expect(stub.calls.length, 'one read for four client-side navigations').toBe(1);
});

test('shows the gate banner only for non-active billing', async () => {
  const stub = await stubBillingStatus(page, 'PENDING_FIRST_PAYMENT');
  await page.goto('/dashboard');
  await settleBaseline(stub, 1, page);
  await expect(page.getByText(BANNER_PENDING)).toBeVisible();

  stub.status = 'SUSPENDED';
  await page.reload();
  await settleBaseline(stub, 2, page);
  await expect(page.getByText(BANNER_SUSPENDED)).toBeVisible();

  stub.status = 'ACTIVE';
  await page.reload();
  await settleBaseline(stub, 3, page);
  await expect(page.getByText(BANNER_PENDING)).toHaveCount(0);
  await expect(page.getByText(BANNER_SUSPENDED)).toHaveCount(0);
});

test('checkout in a second tab refreshes the original tab, once', async () => {
  // Original tab: gated, cache fresh (well under the 60s focus window).
  const original = await stubBillingStatus(page, 'PENDING_FIRST_PAYMENT');
  await page.goto('/dashboard');
  await settleBaseline(original, 1, page);
  await expect(page.getByText(BANNER_PENDING)).toBeVisible();

  // Checkout opened in a NEW tab (Stripe uses target=_blank) and returns there
  // via a FULL document load. On that mount, `?paid=1` publishes (child effect)
  // BEFORE the provider attaches listeners (parent effect), so the checkout
  // tab misses its own event — by design: its initial read runs after the
  // publish in the same commit and is therefore already post-payment. Exactly
  // ONE request; the broadcast exists for the OTHER tabs.
  const checkoutTab = await context.newPage(); // same context: cookie auth, no login
  const checkout = await stubBillingStatus(checkoutTab, 'ACTIVE');
  original.status = 'ACTIVE'; // payment landed: both tabs now read ACTIVE
  await checkoutTab.goto('/dashboard/billing?paid=1');
  await expect.poll(() => checkout.calls.length, { timeout: 10_000 }).toBe(1);

  // Original tab: exactly one extra read, despite a cache seconds old — this
  // is the storage-event broadcast, not the 60s focus rule.
  await expect.poll(() => original.calls.length, { timeout: 10_000 }).toBe(2);
  await expect(page.getByText(BANNER_PENDING)).toHaveCount(0);

  // Replaying the SAME publication must not fetch again: the custom event
  // carries its token, and the storage handler compares the stored one.
  await page.evaluate(
    ({ key, eventName }) => {
      const token = window.localStorage.getItem(key);
      window.dispatchEvent(new CustomEvent(eventName, { detail: token }));
      window.dispatchEvent(new StorageEvent('storage', { key }));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    },
    { key: INVALIDATION_KEY, eventName: INVALIDATION_EVENT },
  );
  await page.waitForTimeout(1_000);
  expect(original.calls.length, 'duplicate events are ignored').toBe(2);
  expect(checkout.calls.length, 'checkout tab unaffected').toBe(1);
  await checkoutTab.close();
});

test('switching managed tenant refetches and never shows the previous company', async () => {
  const stub = await stubBillingStatus(page, 'PENDING_FIRST_PAYMENT');
  await page.goto('/dashboard');
  await settleBaseline(stub, 1, page);
  await expect(page.getByText(BANNER_PENDING)).toBeVisible();

  const organizationId = '00000000-0000-4000-8000-00000000e185';
  stub.status = 'ACTIVE'; // the other company is paid up
  await page.evaluate(
    ({ tenant }) => {
      window.localStorage.setItem('wegox-managed-tenant', JSON.stringify(tenant));
      window.dispatchEvent(new Event('wegox:managed-tenant'));
    },
    { tenant: { organizationId, organizationName: 'E2E Managed Co' } },
  );

  await expect.poll(() => stub.calls.length, { timeout: 10_000 }).toBe(2);
  expect(stub.calls[1]['x-managed-organization'], 'read is scoped to the new tenant').toBe(organizationId);
  // The previous company's gate must be gone, not merely replaced later.
  await expect(page.getByText(BANNER_PENDING)).toHaveCount(0);
});

test('revalidates on focus only once the cached read is 60s old', async () => {
  // The preceding test leaves a managed company selected. This one is about
  // the FOCUS contract, so it starts from a KNOWN client state instead of
  // inheriting one: with a tenant left over, "the cached read" is ambiguous —
  // the provider legitimately revalidates an entry that has aged past the
  // window, and the assertion below would be judging the wrong entry. Clearing
  // the selection and reloading makes the entry under test the one this test
  // just made. No assertion is relaxed by this; the precondition is made true.
  await page.evaluate(() => window.localStorage.removeItem('wegox-managed-tenant'));
  await page.reload();
  await page.clock.install();
  const stub = await stubBillingStatus(page, 'ACTIVE');
  await page.goto('/dashboard');
  await settleBaseline(stub, 1, page);

  // Returning to a fresh tab must not re-read.
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.waitForTimeout(500);
  expect(stub.calls.length, 'fresh cache: no revalidation').toBe(1);

  // Past the window, the focus/visibilitychange PAIR collapses to one read.
  await page.clock.fastForward('01:05');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => stub.calls.length, { timeout: 10_000 }).toBe(2);
  await page.waitForTimeout(1_000);
  expect(stub.calls.length, 'paired events stay single-flight').toBe(2);
});
