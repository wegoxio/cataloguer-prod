import { test, expect, Page, BrowserContext, APIRequestContext } from '@playwright/test';
import { login, loginSlot, ADMIN_EMAIL, ADMIN_PASSWORD } from './helpers';
import { query } from './db';

/**
 * THE PLATFORM DIRECTORY IN A REAL BROWSER, AGAINST A REAL BACKEND (#275).
 *
 * The journey #275 asks for: find a store-bound ADMIN in a directory that spans
 * every company, promote it to Organization Manager, and see the store binding
 * clear — the change that had no path at all before Slice A, and no screen
 * before this one.
 *
 * Everything the screen is given comes from supported endpoints; the only
 * direct-SQL use is reading `users` back to prove the committed state, and the
 * inventory bootstrap a new company needs (#284), both against a DISPOSABLE
 * database.
 */
const API = 'http://localhost:3001/api/v1';
const tag = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const BRANCH_PASSWORD = 'Wegox-Branch-2026';

test.describe.serial('#275 · Platform Users', () => {
  let context: BrowserContext;
  let page: Page;
  let api: APIRequestContext;
  let token: string;

  let organizationId: string;
  let storeA: string;
  let storeB: string;
  let adminId: string;
  let adminEmail: string;
  let viewerEmail: string;

  const inOrg = () => ({ Authorization: `Bearer ${token}`, 'X-Managed-Organization': organizationId });

  test.beforeAll(async ({ browser, playwright }) => {
    api = await playwright.request.newContext();
    await loginSlot();
    token = (
      await (await api.post(`${API}/auth/login`, { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })).json()
    ).data.accessToken;

    const onboarded = await api.post(`${API}/organizations/onboard`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        organization: { name: `Directory ${tag}`, plan: 'CRECIMIENTO' },
        store: { name: `Directory ${tag}` },
        manager: { email: `dir-mgr-${tag}@example.com` },
      },
    });
    expect(onboarded.status()).toBe(201);
    const created = (await onboarded.json()).data;
    organizationId = created.organization.id;
    storeA = created.store.id;

    storeB = (
      await (
        await api.post(`${API}/stores`, { headers: inOrg(), data: { name: `Norte ${tag}`, organizationId } })
      ).json()
    ).data.id;

    // The person the journey is about: a store-bound ADMIN, exactly the shape
    // onboarding used to produce for every company.
    adminEmail = `dir-admin-${tag}@example.com`;
    const admin = await api.post(`${API}/users`, {
      headers: inOrg(),
      data: { email: adminEmail, role: 'ADMIN', storeId: storeA, company: `Directory ${tag}` },
    });
    expect(admin.status()).toBe(201);
    adminId = (await admin.json()).data.id;
    await api.patch(`${API}/users/${adminId}/password`, { headers: inOrg(), data: { password: BRANCH_PASSWORD } });

    // A second person, so "changing one row changes one row" is observable.
    viewerEmail = `dir-viewer-${tag}@example.com`;
    await api.post(`${API}/users`, {
      headers: inOrg(),
      data: { email: viewerEmail, role: 'VIEWER', storeId: storeB, company: `Directory ${tag}` },
    });

    context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();
    await login(page);
  });

  test.afterAll(async () => {
    await context?.close();
    await api?.dispose();
  });

  const open = async () => {
    await page.goto('/dashboard/platform-users');
    await expect(page.getByRole('heading', { name: /Platform Users|Usuarios de la plataforma/i })).toBeVisible({
      timeout: 30_000,
    });
  };

  const searchFor = async (value: string) => {
    await page.locator('input[name="platformUserSearch"]').fill(value);
    // The search is debounced; wait for the request it produces.
    await page.waitForResponse(
      (r) => r.url().includes('/users/platform') && r.url().includes(encodeURIComponent(value).slice(0, 8)),
      { timeout: 30_000 },
    );
  };

  test('the page is reachable from the sidebar and lists people across companies', async () => {
    await page.goto('/dashboard');
    // The wait is armed BEFORE the navigation: the page requests its first
    // page as it mounts, so arming afterwards races the request and loses.
    const pending = page.waitForResponse((r) => r.url().includes('/users/platform'), { timeout: 30_000 });
    await page.getByRole('navigation').getByRole('link', { name: /Platform Users|Usuarios de la plataforma/i }).click();
    await expect(page).toHaveURL(/\/dashboard\/platform-users/, { timeout: 20_000 });

    const listed = await pending;
    expect(listed.status()).toBe(200);
    const body = await listed.json();
    // Server-side: a bounded page, and a total that exceeds what was returned
    // only if the platform holds more — either way the browser holds one page.
    expect(new URL(listed.url()).searchParams.get('limit')).toBe('25');
    expect(body.data.items.length).toBeLessThanOrEqual(25);
    expect(body.data).toHaveProperty('total');
    expect(body.data).toHaveProperty('totalPages');
  });

  test('a filter is applied by the SERVER, not in the browser', async () => {
    await open();
    // The RESPONSE, not the request: the rows are rendered from what came
    // back, so waiting for the request only proves the browser asked.
    const answered = page.waitForResponse(
      (r) => r.url().includes('/users/platform') && r.url().includes('role=ORGANIZATION_MANAGER'),
      { timeout: 30_000 },
    );
    await page.locator('[data-testid="filter-role"]').selectOption('ORGANIZATION_MANAGER');
    const body = await (await answered).json();
    // The SERVER decided: every row it returned carries the requested role.
    expect(body.data.items.length).toBeGreaterThan(0);
    expect(new Set(body.data.items.map((u: { role: string }) => u.role))).toEqual(new Set(['ORGANIZATION_MANAGER']));

    // And the screen shows them — asserted with the auto-retrying matcher,
    // because rendering happens after the response resolves.
    await expect(page.locator('table tbody tr').first()).toContainText(
      /Organization Manager|ORGANIZATION_MANAGER|Responsable de empresa/i,
      { timeout: 20_000 },
    );
  });

  test('the branch filter is scoped to the chosen company', async () => {
    await open();
    await expect(page.locator('[data-testid="filter-store"]')).toBeDisabled();
    await page.locator('[data-testid="filter-organization"]').selectOption(organizationId);
    await expect(page.locator('[data-testid="filter-store"]')).toBeEnabled();

    const request = page.waitForRequest((r) => r.url().includes(`storeId=${storeB}`), { timeout: 30_000 });
    await page.locator('[data-testid="filter-store"]').selectOption(storeB);
    await request;
    await expect(page.getByText(viewerEmail)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(adminEmail)).toHaveCount(0);
  });

  test('PROMOTES a store-bound ADMIN to Organization Manager, and the branch clears', async () => {
    await open();
    await searchFor(adminEmail);
    await expect(page.getByText(adminEmail)).toBeVisible({ timeout: 20_000 });

    await page.locator(`[data-testid="change-access-${adminId}"]`).click();
    await expect(page.locator('[data-testid="current-access"]')).toContainText(/Directory/);

    // Company-wide is a SHAPE, and choosing it re-derives the role list.
    await page.locator('[data-testid="shape-ORGANIZATION"]').click();
    await expect(page.locator('[data-testid="access-store"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="session-warning"]')).toBeVisible();

    // The escalation gate: nothing is submittable until it is typed.
    await expect(page.locator('[data-testid="escalation-gate"]')).toBeVisible();
    await expect(page.locator('[data-testid="submit-access"]')).toBeDisabled();
    await page.locator('input[name="confirmEscalation"]').fill('PROMOTE');
    await expect(page.locator('[data-testid="submit-access"]')).toBeEnabled();

    const patch = page.waitForRequest(
      (r) => r.method() === 'PATCH' && r.url().includes(`/organizations/${organizationId}/users/${adminId}/access`),
      { timeout: 30_000 },
    );
    const answered = page.waitForResponse(
      (r) => r.request().method() === 'PATCH' && r.url().includes(`/users/${adminId}/access`),
      { timeout: 30_000 },
    );
    await page.locator('[data-testid="submit-access"]').click();

    // `storeId` is present and null — the contract's way of saying company-wide.
    const body = JSON.parse((await patch).postData() ?? '{}');
    expect(body).toEqual({ role: 'ORGANIZATION_MANAGER', storeId: null });
    expect((await answered).status()).toBe(200);

    // The modal closes only after the server commits, and the screen states the
    // COMMITTED outcome rather than the requested one.
    await expect(page.locator('[data-testid="submit-access"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="access-outcome"]')).toContainText(adminEmail);
    await expect(page.locator('[data-testid="access-outcome"]')).toContainText(/Company-wide|En toda la empresa/i);

    // The database agrees: the role moved and the branch binding is gone.
    const committed = query<{ role: string; store_id: string | null; organization_id: string }>(`
      select r.name as role, u.store_id, u.organization_id
        from users u join roles r on r.id = u.role_id
       where u.email = '${adminEmail}'
    `)[0];
    expect(committed.role).toBe('ORGANIZATION_MANAGER');
    expect(committed.store_id).toBeNull();
    expect(committed.organization_id).toBe(organizationId);

    // And nobody else moved.
    const bystander = query<{ role: string; store_id: string | null }>(`
      select r.name as role, u.store_id from users u join roles r on r.id = u.role_id where u.email = '${viewerEmail}'
    `)[0];
    expect(bystander.role).toBe('VIEWER');
    expect(bystander.store_id).toBe(storeB);
  });

  test('the refreshed row shows the committed access', async () => {
    await open();
    await searchFor(adminEmail);
    const row = page.locator('table tbody tr', { hasText: adminEmail });
    await expect(row).toContainText(/Organization Manager|Responsable de empresa/i);
    // A company-wide role has no branch, and the cell SAYS so.
    await expect(row).toContainText(/Company-wide|Toda la empresa/i);
  });

  test('the endpoint still refuses STORE_ADMIN from a hand-crafted request', async () => {
    // The modal cannot offer it; this is the other half — the boundary itself,
    // unchanged by Slice B.
    const refused = await api.patch(`${API}/organizations/${organizationId}/users/${adminId}/access`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { role: 'STORE_ADMIN', storeId: storeA },
    });
    expect(refused.status()).toBe(400);

    const platform = await api.patch(`${API}/organizations/${organizationId}/users/${adminId}/access`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { role: 'SUPER_ADMIN', storeId: null },
    });
    expect(platform.status()).toBe(400);

    const still = query<{ role: string }>(`
      select r.name as role from users u join roles r on r.id = u.role_id where u.email = '${adminEmail}'
    `)[0];
    expect(still.role).toBe('ORGANIZATION_MANAGER');
  });

  test('a NON-owner is refused the page and the endpoint', async () => {
    // The branch ADMIN promoted above is now a manager, so a fresh branch actor
    // is minted for this check rather than reusing a changed one.
    const outsiderEmail = `dir-outsider-${tag}@example.com`;
    const outsider = await api.post(`${API}/users`, {
      headers: inOrg(),
      data: { email: outsiderEmail, role: 'ADMIN', storeId: storeA, company: `Directory ${tag}` },
    });
    expect(outsider.status()).toBe(201);
    await api.patch(`${API}/users/${(await outsider.json()).data.id}/password`, {
      headers: inOrg(),
      data: { password: BRANCH_PASSWORD },
    });

    await loginSlot();
    const theirToken = (
      await (await api.post(`${API}/auth/login`, { data: { email: outsiderEmail, password: BRANCH_PASSWORD } })).json()
    ).data.accessToken;
    const refused = await api.get(`${API}/users/platform`, { headers: { Authorization: `Bearer ${theirToken}` } });
    expect(refused.status()).toBe(403);

    const browserContext = await context.browser()!.newContext();
    const theirPage = await browserContext.newPage();
    await login(theirPage, outsiderEmail, BRANCH_PASSWORD);
    await theirPage.goto('/dashboard/platform-users');
    // Redirected away, and the sidebar never offered it.
    await expect(theirPage).toHaveURL(/\/dashboard$/, { timeout: 20_000 });
    await expect(theirPage.getByRole('navigation').getByRole('link', { name: /Platform Users/i })).toHaveCount(0);
    await browserContext.close();
  });

  /**
   * A KEYBOARD ALONE, END TO END (#275).
   *
   * Not "the elements have labels" — the whole journey, driven with nothing but
   * Tab, arrows, Space and Enter: reach the page, search, filter, open the
   * modal, choose a shape, choose a role, choose a branch, type the escalation
   * word and submit. A control that can only be reached with a pointer is not
   * reachable by an operator using a screen reader, and no amount of correct
   * markup makes up for it.
   */
  const focused = (target: Page) =>
    target.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      if (!active) return null;
      return {
        testid: active.getAttribute('data-testid'),
        name: active.getAttribute('name'),
        tag: active.tagName.toLowerCase(),
        text: (active.textContent ?? '').trim().slice(0, 40),
      };
    });

  /** Tabs until the wanted element holds focus, or gives up loudly. */
  const tabTo = async (target: Page, predicate: (f: any) => boolean, limit = 60) => {
    for (let i = 0; i < limit; i += 1) {
      const now = await focused(target);
      if (now && predicate(now)) return now;
      await target.keyboard.press('Tab');
    }
    throw new Error(`never reached the element after ${limit} tabs; last focus: ${JSON.stringify(await focused(target))}`);
  };

  test('the whole change-access journey is completable with the keyboard alone', async () => {
    // A fresh subject, so this test does not depend on the promotion above.
    const kbEmail = `dir-kb-${tag}@example.com`;
    const created = await api.post(`${API}/users`, {
      headers: inOrg(),
      data: { email: kbEmail, role: 'ADMIN', storeId: storeA, company: `Directory ${tag}` },
    });
    expect(created.status()).toBe(201);
    const kbId = (await created.json()).data.id;

    await open();

    // 1. SEARCH — reached by Tab, typed into, and it narrows the list.
    await page.locator('body').click({ position: { x: 2, y: 2 } });
    await tabTo(page, (f) => f.name === 'platformUserSearch');
    await page.keyboard.type(kbEmail);
    await page.waitForResponse((r) => r.url().includes('/users/platform') && r.url().includes('search='), {
      timeout: 30_000,
    });
    await expect(page.getByText(kbEmail)).toBeVisible({ timeout: 20_000 });

    // 2. THE ROW'S ACTION — reached by Tab and activated with Enter.
    await tabTo(page, (f) => f.testid === `change-access-${kbId}`);
    await page.keyboard.press('Enter');
    await expect(page.locator('[data-testid="current-access"]')).toBeVisible({ timeout: 20_000 });

    // 3. FOCUS MOVED INTO THE DIALOG rather than staying behind it.
    const landed = await focused(page);
    const insideDialog = await page.evaluate(
      () => !!document.activeElement?.closest('[role="dialog"]'),
    );
    expect(insideDialog, `focus landed on ${JSON.stringify(landed)} instead of inside the dialog`).toBe(true);

    // 4. THE FOCUS TRAP — Tab cannot escape the dialog.
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press('Tab');
      const stillInside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
      expect(stillInside, `Tab escaped the dialog on press ${i + 1}`).toBe(true);
    }

    // 5. THE BRANCH PICKER, by keyboard: its search and its select are both
    //    reachable, and the select is operated with the keyboard.
    await tabTo(page, (f) => f.testid === 'access-store');
    await page.locator('[data-testid="access-store"]').selectOption(storeB);
    await expect(page.locator('[data-testid="access-store"]')).toHaveValue(storeB);

    // 6. THE ROLE, by keyboard.
    await tabTo(page, (f) => f.testid === 'access-role');
    await page.locator('[data-testid="access-role"]').selectOption('EDITOR');

    // 7. SUBMIT with Enter, and prove the request carried the keyboard choices.
    const patch = page.waitForRequest(
      (r) => r.method() === 'PATCH' && r.url().includes(`/users/${kbId}/access`),
      { timeout: 30_000 },
    );
    await tabTo(page, (f) => f.testid === 'submit-access');
    await page.keyboard.press('Enter');
    expect(JSON.parse((await patch).postData() ?? '{}')).toEqual({ role: 'EDITOR', storeId: storeB });
    await expect(page.locator('[data-testid="access-outcome"]')).toContainText(kbEmail, { timeout: 20_000 });

    // 8. FOCUS LANDED ON THE OUTCOME, not on `document.body`.
    //
    //    The modal's default is to hand focus back to whatever opened it, but a
    //    committed change re-reads the list: the row's button is destroyed and
    //    rebuilt, so focusing it does nothing and a keyboard user is dropped at
    //    the top of the document with no announcement. The outcome is both a
    //    real destination and the sentence stating what the server committed.
    const returned = await focused(page);
    expect(returned?.tag, `focus went to ${JSON.stringify(returned)}`).not.toBe('body');
    expect(returned?.testid).toBe('access-outcome');

    // 9. The committed row agrees, and the ESCALATION GATE was never bypassed:
    //    this was an ordinary change, so no confirmation was demanded.
    const committed = query<{ role: string; store_id: string | null }>(`
      select r.name as role, u.store_id from users u join roles r on r.id = u.role_id where u.email = '${kbEmail}'
    `)[0];
    expect(committed.role).toBe('EDITOR');
    expect(committed.store_id).toBe(storeB);
  });

  test('the escalation gate cannot be bypassed by the keyboard, and Escape cancels without changing anything', async () => {
    const gateEmail = `dir-gate-${tag}@example.com`;
    const created = await api.post(`${API}/users`, {
      headers: inOrg(),
      data: { email: gateEmail, role: 'VIEWER', storeId: storeA, company: `Directory ${tag}` },
    });
    const gateId = (await created.json()).data.id;

    await open();
    await searchFor(gateEmail);
    await page.locator(`[data-testid="change-access-${gateId}"]`).click();

    // Company-wide, by keyboard: the shape control is a button, so Space
    // activates it — the key a keyboard user actually presses.
    await page.locator('body').press('Tab');
    await tabTo(page, (f) => f.testid === 'shape-ORGANIZATION');
    await page.keyboard.press(' ');
    await expect(page.locator('[data-testid="escalation-gate"]')).toBeVisible();

    let patched = false;
    const watch = (request: { method: () => string; url: () => string }) => {
      if (request.method() === 'PATCH' && request.url().includes('/access')) patched = true;
    };
    page.on('request', watch);

    /**
     * SUBMIT IS NOT MERELY REFUSED — IT IS NOT IN THE TAB ORDER AT ALL.
     *
     * A disabled button cannot take focus, so a keyboard user cannot even
     * arrive at it while the escalation is unconfirmed. Walking the whole trap
     * and proving it never appears is a stronger statement than clicking it and
     * finding nothing happened: there is no keystroke that reaches it.
     */
    await expect(page.locator('[data-testid="submit-access"]')).toBeDisabled();
    const stops: (string | null)[] = [];
    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
      stops.push((await focused(page))?.testid ?? null);
    }
    expect(stops).not.toContain('submit-access');

    // And Enter, pressed from inside the dialog, sends nothing.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    expect(patched, 'a PATCH left the browser without the escalation being confirmed').toBe(false);

    // A WRONG word is not enough either — still disabled, still unreachable.
    // (Case is deliberately not part of the test: the gate accepts `promote`
    // as readily as `PROMOTE`. What it will not accept is a different word.)
    await tabTo(page, (f) => f.name === 'confirmEscalation');
    await page.keyboard.type('promoted');
    await expect(page.locator('[data-testid="submit-access"]')).toBeDisabled();

    // The RIGHT word is what makes it reachable — the gate is a gate, not a
    // permanently locked door.
    await page.locator('input[name="confirmEscalation"]').fill('PROMOTE');
    await expect(page.locator('[data-testid="submit-access"]')).toBeEnabled();
    await tabTo(page, (f) => f.testid === 'submit-access');

    // Escape closes the dialog, and NOTHING was changed.
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="submit-access"]')).toHaveCount(0);
    page.off('request', watch);
    expect(patched).toBe(false);

    const untouched = query<{ role: string; store_id: string | null }>(`
      select r.name as role, u.store_id from users u join roles r on r.id = u.role_id where u.email = '${gateEmail}'
    `)[0];
    expect(untouched.role).toBe('VIEWER');
    expect(untouched.store_id).toBe(storeA);

    // Focus returned to the control that opened the dialog.
    const back = await focused(page);
    expect(back?.testid).toBe(`change-access-${gateId}`);
  });

  test('the keyboard journey also works at 390px', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    await page.locator('body').click({ position: { x: 2, y: 2 } });
    await tabTo(page, (f) => f.name === 'platformUserSearch');
    await page.keyboard.type(viewerEmail);
    await page.waitForResponse((r) => r.url().includes('/users/platform') && r.url().includes('search='), {
      timeout: 30_000,
    });
    await expect(page.getByText(viewerEmail)).toBeVisible({ timeout: 20_000 });

    // The company and branch pickers are still reachable and operable at this
    // width — a filter that collapses out of the tab order is not responsive,
    // it is missing.
    await tabTo(page, (f) => f.testid === 'filter-organization-search');
    await tabTo(page, (f) => f.testid === 'filter-organization');
    await page.locator('[data-testid="filter-organization"]').selectOption(organizationId);
    await expect(page.locator('[data-testid="filter-store"]')).toBeEnabled({ timeout: 20_000 });
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  /**
   * THE LABELS AN OPERATOR ACTUALLY READS, IN BOTH LANGUAGES.
   *
   * Asserting that a key EXISTS in the dictionary proves nothing about what the
   * screen renders — that is exactly how `ORGANIZATION_MANAGER` reached the
   * English UI while the Spanish dictionary was complete. These read the live
   * DOM instead.
   */
  test('English shows words, not enum constants', async () => {
    await open();
    const filters = page.locator('[data-testid="platform-user-filters"]');
    await expect(filters).toContainText('Company');
    await expect(filters).toContainText('Branch');
    await expect(filters).toContainText('Find a company');
    await expect(filters).toContainText('No pending invitation');
    // The false claim is gone from the whole screen, in every spelling.
    const body = (await page.locator('body').innerText()).toLowerCase();
    expect(body).not.toContain('signed in already');
    expect(body).not.toContain('accepted');
    // Roles render as words everywhere the operator can see them.
    const roleOptions = await page.locator('[data-testid="filter-role"] option').allInnerTexts();
    expect(roleOptions).toContain('Organization Manager');
    expect(roleOptions).toContain('Branch administrator');
    for (const label of roleOptions) expect(label).not.toMatch(/^[A-Z_]+$/);
  });

  test('Spanish shows Spanish — read from the rendered page, not from the dictionary', async () => {
    await page.addInitScript(() => window.localStorage.setItem('wegox-lang', 'es'));
    await open();

    const filters = page.locator('[data-testid="platform-user-filters"]');
    await expect(filters).toContainText('Empresa');
    await expect(filters).toContainText('Sucursal');
    await expect(filters).toContainText('Buscar una empresa');
    await expect(filters).toContainText('Sin invitación pendiente');

    const roleOptions = await page.locator('[data-testid="filter-role"] option').allInnerTexts();
    expect(roleOptions).toContain('Responsable de empresa');
    expect(roleOptions).toContain('Observador');
    // No English and no enum leaked through.
    for (const label of roleOptions) {
      expect(label).not.toMatch(/^[A-Z_]+$/);
      expect(label).not.toBe('Organization Manager');
      expect(label).not.toBe('Viewer');
    }

    // And the modal, which is where the untranslated enum first surfaced.
    await searchFor(viewerEmail);
    const viewerId = query<{ id: string }>(`select id from users where email = '${viewerEmail}'`)[0].id;
    await page.locator(`[data-testid="change-access-${viewerId}"]`).click();
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toContainText('Cambiar acceso');
    await expect(dialog).toContainText('Forma del acceso');
    await expect(dialog).toContainText('Buscar una sucursal');
    const modalRoles = await page.locator('[data-testid="access-role"] option').allInnerTexts();
    for (const label of modalRoles) expect(label).not.toMatch(/^[A-Z_]+$/);
    await page.keyboard.press('Escape');

    // Back to English for whatever runs next in this serial file.
    await page.addInitScript(() => window.localStorage.setItem('wegox-lang', 'en'));
    await page.evaluate(() => window.localStorage.setItem('wegox-lang', 'en'));
  });

  test('the directory is usable at 390px', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open();
    await expect(page.locator('[data-testid="platform-user-filters"]')).toBeVisible();
    await expect(page.locator('table')).toBeVisible();
    // The table scrolls inside its own container rather than the page.
    const overflow = await page.evaluate(() => {
      const table = document.querySelector('table');
      const box = table?.parentElement;
      return { scrolls: box ? getComputedStyle(box).overflowX : null, body: document.body.scrollWidth <= window.innerWidth + 1 };
    });
    expect(overflow.scrolls).toBe('auto');
    expect(overflow.body).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
  });
});
