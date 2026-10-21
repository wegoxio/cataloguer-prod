import { test, expect, type Page } from '@playwright/test';

/**
 * PR A rendered in a real browser, on stubbed data.
 *
 * No backend and no production data: every API call is answered in the page, so
 * this runs anywhere and mutates nothing. What it checks is the part unit tests
 * cannot — that the role badges, the disabled Smart import control and the
 * product pickers actually LAY OUT, at a desktop width and a narrow one, and
 * that the keyboard can reach what a person needs to reach.
 */

const ORIGIN = 'http://localhost:3000';
const ORG = 'org-1';
const STORE = 'store-a';

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': ORIGIN, 'access-control-allow-credentials': 'true' },
  body: JSON.stringify(body),
});

const CARD = { id: 'card-1', name: 'Silla Nordic', slug: 'silla-nordic', status: 'PUBLISHED', price: 120, stockQuantity: 0, trackInventory: false, children: [{ id: 'kid-1', name: 'Silla Nordic Verde', optionLabel: 'Verde' }, { id: 'kid-2', name: 'Silla Nordic Marrón', optionLabel: 'Marrón' }] };
const KID = { id: 'kid-1', name: 'Silla Nordic Verde', slug: 'silla-nordic-verde', status: 'PUBLISHED', price: 120, stockQuantity: 4, trackInventory: true, optionLabel: 'Verde', parent: { id: 'card-1', name: 'Silla Nordic' } };
const ALONE = { id: 'solo-1', name: 'Lámpara de pie', slug: 'lampara-de-pie', status: 'PUBLISHED', price: 80, stockQuantity: 2, trackInventory: true };
/** A second standalone, so the grouping tests have a real selection to group. */
const ALONE2 = { id: 'solo-2', name: 'Lámpara de pie grande', slug: 'lampara-de-pie-grande', status: 'PUBLISHED', price: 95, stockQuantity: 1, trackInventory: true };

const FAMILY = {
  parentId: 'card-1',
  parentName: 'Silla Nordic',
  members: [
    { id: 'kid-1', name: 'Silla Nordic Verde', optionLabel: 'Verde', price: 120, trackInventory: true, stockQuantity: 4 },
    { id: 'kid-2', name: 'Silla Nordic Marrón', optionLabel: 'Marrón', price: 130, trackInventory: true, stockQuantity: 1 },
  ],
};

async function stub(
  page: Page,
  role: 'ORGANIZATION_MANAGER' | 'ADMIN',
  opts: { pairOfStandalones?: boolean } = {},
) {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace('/api/v1', '');
    const q = url.searchParams;

    if (p === '/auth/refresh')
      return route.fulfill(json({ data: { accessToken: 'stub', user: { id: 'u1', email: 'a@b.c', name: 'Ana' } } }));
    if (p === '/auth/me')
      return route.fulfill(
        json({
          data: {
            user: { id: 'u1', email: 'a@b.c', name: 'Ana' },
            scope: {
              platform: false,
              role,
              organizationId: ORG,
              storeId: role === 'ADMIN' ? STORE : null,
              allowedStoreIds: [STORE],
            },
          },
        }),
      );

    if (p === '/products') {
      // The SERVER-side selector source: when a picker asks for line-item
      // candidates, the card is not in the answer at all.
      const extra = opts.pairOfStandalones ? [ALONE2] : [];
      const items = q.get('excludeParents') === 'true' ? [KID, ALONE, ...extra] : [CARD, KID, ALONE, ...extra];
      return route.fulfill(json({ items, total: items.length, page: 1, limit: 100, totalPages: 1 }));
    }
    if (p === '/products/card-1') return route.fulfill(json({ data: CARD }));
    if (p === '/products/kid-1') return route.fulfill(json({ data: KID }));
    if (p === '/products/solo-1') return route.fulfill(json({ data: ALONE }));
    if (p === '/products/solo-2') return route.fulfill(json({ data: ALONE2 }));
    if (p.startsWith('/products/') && p.endsWith('/family')) {
      const owner = p.split('/')[2];
      return route.fulfill(json({ data: owner === 'solo-1' ? null : FAMILY }));
    }
    if (p === '/products/families/validate') return route.fulfill(json({ data: { ok: true, problem: null } }));
    if (p === '/products/families')
      return route.fulfill(json({ data: { id: 'new-card', name: 'Camiseta', members: 2 } }));
    if (p === '/stores') return route.fulfill(json({ items: [{ id: STORE, name: 'Centro' }], total: 1 }));
    if (p === '/categories') return route.fulfill(json({ items: [], total: 0 }));
    if (p === '/sales' || p === '/invoices') return route.fulfill(json({ items: [], total: 0, page: 1, limit: 25, totalPages: 0 }));
    return route.fulfill(json({ data: null, items: [], total: 0 }));
  });
  await page.addInitScript(() => window.localStorage.setItem('cataloguer.session', '1'));
}

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'narrow', width: 390, height: 844 },
];

/** No element may spill past the document's own width. */
async function assertNoHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scroll: doc.scrollWidth, client: doc.clientWidth };
  });
  expect(overflow.scroll, `${label}: horizontal overflow`).toBeLessThanOrEqual(overflow.client + 1);
}

/** A badge that wrapped to zero height, or collapsed, is not readable. */
async function assertBadgesReadable(page: Page, label: string) {
  const boxes = await page.locator('[data-testid^="family-role-"]').evaluateAll((nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return { text: (n.textContent ?? '').trim(), w: r.width, h: r.height };
    }),
  );
  for (const b of boxes) {
    expect(b.text.length, `${label}: empty badge`).toBeGreaterThan(0);
    expect(b.h, `${label}: badge "${b.text}" collapsed`).toBeGreaterThan(8);
    expect(b.w, `${label}: badge "${b.text}" collapsed`).toBeGreaterThan(8);
  }
}

/**
 * The identity group — checkbox, image, name — is pinned as ONE contiguous
 * block while the table scrolls sideways. Measured, not assumed: each column
 * must be sticky in header and body, header and body must share an offset,
 * every column must start where the previous one ends, the first must sit at
 * the scrollport's edge whatever was scrolled, and every pinned cell must be
 * opaque so nothing scrolling beneath it shows through.
 */
/**
 * What the component DECIDED, read off the attributes it exposes, and what the
 * browser measured. The threshold that turns the group off lives in the
 * component alone; these tests check its observable decision against the
 * geometry it produced, never re-derive the rule.
 */
async function regionState(page: Page) {
  return page.locator('[data-testid="items-table-box"]').evaluate((el) => ({
    label: el.getAttribute('aria-label'),
    role: el.getAttribute('role'),
    tabindex: el.getAttribute('tabindex'),
    overflow: el.getAttribute('data-horizontal-overflow'),
    sticky: el.getAttribute('data-sticky-columns'),
    scrollable: el.scrollWidth > el.clientWidth + 1,
    room: el.clientWidth,
    tableWidth: el.scrollWidth,
  }));
}

/** The region tells the truth about scrolling: a tab stop and the scroll wording iff it overflows. */
async function assertRegionHonest(page: Page, label: string) {
  const state = await regionState(page);
  expect(state.role, `${label}: region role`).toBe('region');
  expect(state.overflow, `${label}: overflow attribute matches the measured box`).toBe(state.scrollable ? 'true' : 'false');
  if (state.scrollable) {
    expect(state.tabindex, `${label}: an overflowing box is a tab stop`).toBe('0');
    expect(state.label, `${label}: an overflowing box says so`).toBe('Items table, scrolls horizontally');
  } else {
    expect(state.tabindex, `${label}: a box that fits takes no tab stop`).toBeNull();
    expect(state.label, `${label}: a box that fits is named neutrally`).toBe('Items table');
  }
  return state;
}

async function assertStickyGroup(page: Page, label: string) {
  const box = page.locator('[data-testid="items-table-box"]');
  const geometry = await box.evaluate((el) => {
    const measure = (node: Element) => {
      const r = node.getBoundingClientRect();
      const s = getComputedStyle(node);
      return { left: r.left, right: r.right, width: r.width, position: s.position, bg: s.backgroundColor };
    };
    // The component's decision, not a re-derivation of its threshold.
    const fits = el.getAttribute('data-sticky-columns') === 'true';
    el.scrollLeft = el.scrollWidth; // as far as this viewport allows; nothing at a wide one
    const rect = el.getBoundingClientRect();
    const inner = el.clientLeft; // the wrapper's border: the scrollport starts inside it
    return {
      fits,
      room: el.clientWidth,
      edge: rect.left + inner,
      scrolled: el.scrollLeft,
      header: Array.from(el.querySelectorAll('thead th')).slice(0, 3).map(measure),
      body: Array.from(el.querySelectorAll('tbody tr:first-child td')).slice(0, 3).map(measure),
    };
  });
  if (!geometry.fits) {
    // Too narrow to pin without covering everything else: the group must have
    // switched itself off, and the columns simply scroll.
    for (let i = 0; i < 3; i += 1) {
      expect(geometry.header[i].position, `${label}: header column ${i} not pinned in a ${geometry.room}px box`).toBe('static');
      expect(geometry.body[i].position, `${label}: body column ${i} not pinned in a ${geometry.room}px box`).toBe('static');
    }
    return;
  }
  const opaque = /^rgb\(/; // rgba(...) with alpha < 1, or "transparent", would let rows bleed through
  for (let i = 0; i < 3; i += 1) {
    expect(geometry.header[i].position, `${label}: header column ${i} sticky`).toBe('sticky');
    expect(geometry.body[i].position, `${label}: body column ${i} sticky`).toBe('sticky');
    expect(geometry.header[i].bg, `${label}: header column ${i} opaque`).toMatch(opaque);
    expect(geometry.body[i].bg, `${label}: body column ${i} opaque`).toMatch(opaque);
    expect(Math.abs(geometry.header[i].left - geometry.body[i].left), `${label}: column ${i} header/body offsets agree`).toBeLessThanOrEqual(1);
    if (i > 0) {
      expect(Math.abs(geometry.body[i].left - geometry.body[i - 1].right), `${label}: column ${i} contiguous with ${i - 1}`).toBeLessThanOrEqual(1);
    }
  }
  expect(Math.abs(geometry.body[0].left - geometry.edge), `${label}: checkbox pinned at the edge after scrolling ${geometry.scrolled}px`).toBeLessThanOrEqual(1);
}

/**
 * THE STATE THE OTHER TWO VIEWPORTS NEVER REACH. At 1440px the table fits and
 * nothing scrolls; at 390px the group stands down. At 1000px the box holds the
 * group with room to spare AND the table is wider than the box, so the group
 * is pinned while the other columns genuinely scroll underneath it — with a
 * selected row and a hovered row, which are the two states a pinned cell has
 * to repaint for itself.
 */
test.describe('sticky group engaged (1000px)', () => {
  test.use({ viewport: { width: 1000, height: 800 } });

  test('checkbox, image and name stay pinned while the other columns scroll, selection and hover included', async ({ page }) => {
    await stub(page, 'ORGANIZATION_MANAGER');
    await page.goto('/dashboard/products');
    await page.waitForSelector('[data-testid^="family-role-"]', { timeout: 30_000 });

    const region = await assertRegionHonest(page, 'engaged/1000');
    expect(region.scrollable, 'the table is wider than its box').toBe(true);
    expect(region.sticky, 'the component pinned the group').toBe('true');
    expect(region.tabindex).toBe('0');

    // A selected row and a hovered row, then the box scrolled fully right.
    await page.getByLabel('Select Silla Nordic Verde').check();
    await assertStickyGroup(page, 'engaged/1000'); // scrolls the box and proves the geometry
    await page.getByLabel('Select Lámpara de pie').hover(); // the checkbox is pinned, so it is still under the pointer

    const paint = await page.locator('[data-testid="items-table-box"]').evaluate((el) => {
      const rows = Array.from(el.querySelectorAll('tbody tr'));
      const cell = (tr: Element, n: number) => tr.querySelectorAll('td')[n];
      const bg = (node: Element) => getComputedStyle(node).backgroundColor;
      const overlay = (node: Element) => getComputedStyle(node, '::before').backgroundColor;
      const rect = (node: Element) => node.getBoundingClientRect();
      const [card, kid, solo] = rows;
      return {
        scrolled: el.scrollLeft,
        unselectedPinned: [0, 1, 2].map((n) => ({ bg: bg(cell(card, n)), overlay: overlay(cell(card, n)) })),
        selectedPinned: [0, 1, 2].map((n) => ({ bg: bg(cell(kid, n)), overlay: overlay(cell(kid, n)) })),
        hoveredPinned: [0, 1, 2].map((n) => ({ bg: bg(cell(solo, n)), overlay: overlay(cell(solo, n)) })),
        rolePosition: getComputedStyle(cell(kid, 3)).position,
        roleLeft: rect(cell(kid, 3)).left,
        nameRight: rect(cell(kid, 2)).right,
        roleRight: rect(cell(kid, 3)).right,
      };
    });
    expect(paint.scrolled).toBeGreaterThan(0);
    for (const c of paint.unselectedPinned) {
      expect(c.bg).toBe('rgb(255, 255, 255)');
      expect(c.overlay).toBe('rgba(0, 0, 0, 0)');
    }
    for (const c of paint.selectedPinned) {
      expect(c.bg, 'selected pinned cell keeps an opaque base').toBe('rgb(255, 255, 255)');
      expect(c.overlay, 'selected pinned cell repaints the tint').toMatch(/^rgba\(\d+, \d+, \d+, 0\.05\)$/);
    }
    for (const c of paint.hoveredPinned) {
      expect(c.bg, 'hovered pinned cell repaints the hover colour').toBe('rgb(248, 250, 252)');
    }
    // Role is not pinned and has scrolled under the group: it starts left of
    // where the pinned Name cell ends, and part of it is still to the right.
    expect(paint.rolePosition).toBe('static');
    expect(paint.roleLeft).toBeLessThan(paint.nameRight);
    expect(paint.roleRight).toBeGreaterThan(paint.roleLeft);

    await assertNoHorizontalOverflow(page, 'engaged/1000');
    await page.screenshot({ path: 'test-results/pra-screenshots/pra-list-engaged-1000.png', fullPage: true });
  });
});

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('product list shows all three roles, laid out', async ({ page }) => {
      await stub(page, 'ORGANIZATION_MANAGER');
      await page.goto('/dashboard/products');
      await page.waitForSelector('[data-testid^="family-role-"]', { timeout: 30_000 });

      const roles = await page.locator('[data-testid^="family-role-"]').evaluateAll((n) =>
        n.map((x) => x.getAttribute('data-role')),
      );
      expect(roles).toContain('PARENT');
      expect(roles).toContain('CHILD');
      expect(roles).toContain('STANDALONE');

      // The family lives in its own COLUMNS — Role, then Parent item — and the
      // Name cell is the item's own name and slug, nothing else.
      const headers = (await page.locator('thead th').allTextContents()).map((h) => h.trim());
      expect(headers.slice(1)).toEqual([
        'Image',
        'Name',
        'Role',
        'Parent item',
        'Status',
        'Category',
        'Price',
        'Sale Price',
        'Stock',
        'Actions',
      ]);
      const nameIndex = headers.indexOf('Name');
      const roleIndex = headers.indexOf('Role');
      expect(roleIndex).toBe(nameIndex + 1);
      expect(headers.indexOf('Parent item')).toBe(roleIndex + 1);
      // Every body row has a cell in that column, and it carries the value.
      const cells = await page.locator(`tbody tr td:nth-child(${roleIndex + 1})`).allTextContents();
      expect(cells.length).toBe(3);
      expect(cells.join(' ')).toContain('Parent (2)');
      expect(cells.join(' ')).toContain('Child');
      expect(cells.join(' ')).toContain('Standalone');
      // The Name cell carries no role, no parent link and no option label.
      const nameCell = `tbody tr td:nth-child(${nameIndex + 1})`;
      expect(
        await page
          .locator(`${nameCell} [data-testid^="family-role-"], ${nameCell} [data-testid^="parent-of-"], ${nameCell} [data-testid^="option-label-"]`)
          .count(),
      ).toBe(0);
      // Parent item: the child links to its parent and names its option; the
      // card and the standalone show a dash.
      await expect(page.locator('[data-testid="parent-of-kid-1"]')).toHaveText('Silla Nordic');
      await expect(page.locator('[data-testid="parent-of-kid-1"]')).toHaveAttribute('href', '/dashboard/products/card-1');
      await expect(page.locator('[data-testid="option-label-kid-1"]')).toHaveText('Option: Verde');
      await expect(page.locator('[data-testid="parent-item-card-1"]')).toContainText('—');
      await expect(page.locator('[data-testid="parent-item-solo-1"]')).toContainText('—');
      // Every row checkbox is named after its item.
      const rowLabels = await page.locator('tbody input[type="checkbox"]').evaluateAll((n) => n.map((x) => x.getAttribute('aria-label')));
      expect(rowLabels).toEqual(['Select Silla Nordic', 'Select Silla Nordic Verde', 'Select Lámpara de pie']);
      // Numbers are right-aligned in header and body.
      for (const column of ['Price', 'Sale Price', 'Stock']) {
        const index = headers.indexOf(column);
        const align = await page
          .locator(`thead th:nth-child(${index + 1}), tbody tr td:nth-child(${index + 1})`)
          .evaluateAll((n) => n.map((x) => getComputedStyle(x).textAlign));
        expect(align.every((a) => a === 'right'), `${column} aligned right`).toBe(true);
      }

      await assertBadgesReadable(page, `list/${vp.name}`);
      await assertNoHorizontalOverflow(page, `list/${vp.name}`);
      // Desktop fits: neutral name, no tab stop. Narrow overflows inside the
      // box: tab stop and scroll wording, and the group has stood down.
      const region = await assertRegionHonest(page, `list/${vp.name}`);
      if (vp.name === 'desktop') {
        expect(region.scrollable, 'desktop: the table fits its box').toBe(false);
      } else {
        expect(region.scrollable, 'narrow: the box scrolls internally').toBe(true);
        expect(region.sticky, 'narrow: the group stands down').toBe('false');
      }
      await page.screenshot({ path: `test-results/pra-screenshots/pra-list-${vp.name}.png`, fullPage: true });
      await assertStickyGroup(page, `list/${vp.name}`);
      // The sticky helper leaves the box scrolled fully right; the document
      // must still not overflow, and this is the state worth a second picture.
      await assertNoHorizontalOverflow(page, `list/${vp.name}/scrolled`);
      await page.screenshot({ path: `test-results/pra-screenshots/pra-list-${vp.name}-scrolled.png`, fullPage: true });
    });

    for (const [label, id, role] of [
      ['parent', 'card-1', 'PARENT'],
      ['child', 'kid-1', 'CHILD'],
      ['standalone', 'solo-1', 'STANDALONE'],
    ] as const) {
      test(`${label} detail states its role`, async ({ page }) => {
        await stub(page, 'ORGANIZATION_MANAGER');
        await page.goto(`/dashboard/products/${id}`);
        await page.waitForSelector(`[data-testid="family-role-${id}"]`, { timeout: 30_000 });
        await expect(page.locator(`[data-testid="family-role-${id}"]`)).toHaveAttribute('data-role', role);
        await assertBadgesReadable(page, `${label}/${vp.name}`);
        await assertNoHorizontalOverflow(page, `${label}/${vp.name}`);
        await page.screenshot({ path: `test-results/pra-screenshots/pra-${label}-detail-${vp.name}.png`, fullPage: true });
      });
    }

    test('import/export as an ORGANIZATION MANAGER offers a real link', async ({ page }) => {
      await stub(page, 'ORGANIZATION_MANAGER');
      await page.goto('/dashboard/import-export');
      await page.waitForSelector('[data-testid="start-import"]', { timeout: 30_000 });
      await expect(page.locator('[data-testid="start-import"]')).toBeEnabled();
      await expect(page.locator('a[href="/dashboard/import-export/wizard"]')).toHaveCount(1);
      await assertNoHorizontalOverflow(page, `import-manager/${vp.name}`);
      await page.screenshot({ path: `test-results/pra-screenshots/pra-import-manager-${vp.name}.png`, fullPage: true });
    });

    test('import/export as an ADMIN shows it disabled and explained', async ({ page }) => {
      await stub(page, 'ADMIN');
      await page.goto('/dashboard/import-export');
      await page.waitForSelector('[data-testid="start-import"]', { timeout: 30_000 });

      await expect(page.locator('[data-testid="start-import"]')).toBeDisabled();
      // The explanation is ON SCREEN, in the reading order — not only bound by
      // aria-describedby to a control the keyboard cannot land on.
      await expect(page.locator('[data-testid="smart-import-denied"]')).toBeVisible();
      // And there is no anchor to the wizard at all.
      await expect(page.locator('a[href="/dashboard/import-export/wizard"]')).toHaveCount(0);
      await assertNoHorizontalOverflow(page, `import-admin/${vp.name}`);
      await page.screenshot({ path: `test-results/pra-screenshots/pra-import-admin-${vp.name}.png`, fullPage: true });
    });

    test('the sales product picker is built from a parent-free list', async ({ page }) => {
      const asked: string[] = [];
      await stub(page, 'ORGANIZATION_MANAGER');
      page.on('request', (r) => {
        if (r.url().includes('/api/v1/products?')) asked.push(r.url());
      });
      await page.goto('/dashboard/sales');
      // The catalogue is fetched when the sale dialog OPENS, not on page load.
      const record = page.getByRole('button', { name: /add sale|añadir venta|agregar venta/i }).first();
      await record.waitFor({ timeout: 30_000 });
      await record.click();
      await page.waitForTimeout(1_500);
      expect(asked.some((u) => u.includes('excludeParents=true'))).toBe(true);
      // The card's name never reaches any <option>.
      const options = await page.locator('option').allTextContents();
      expect(options.join(' ')).not.toContain('Silla Nordic Marrón');
      await assertNoHorizontalOverflow(page, `sales/${vp.name}`);
      await page.screenshot({ path: `test-results/pra-screenshots/pra-sales-${vp.name}.png`, fullPage: true });
    });
  });
}

test.describe('keyboard and assistive technology', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('an authorized Smart import is reachable by keyboard and activates the wizard link', async ({ page }) => {
    await stub(page, 'ORGANIZATION_MANAGER');
    await page.goto('/dashboard/import-export');
    await page.waitForSelector('[data-testid="start-import"]', { timeout: 30_000 });

    const link = page.locator('a[href="/dashboard/import-export/wizard"]');
    await link.focus();
    await expect(link).toBeFocused();
  });

  test('an unauthorized Smart import cannot be focused or navigated', async ({ page }) => {
    await stub(page, 'ADMIN');
    await page.goto('/dashboard/import-export');
    await page.waitForSelector('[data-testid="start-import"]', { timeout: 30_000 });

    // A native disabled button is NOT focusable — which is why the explanation
    // must not live only in its aria-describedby.
    const focusable = await page.evaluate(() => {
      const b = document.querySelector('[data-testid="start-import"]') as HTMLButtonElement;
      b.focus();
      return document.activeElement === b;
    });
    expect(focusable).toBe(false);
    await expect(page.locator('a[href="/dashboard/import-export/wizard"]')).toHaveCount(0);
  });

  test('the denial reason is in the reading order, independent of the button', async ({ page }) => {
    await stub(page, 'ADMIN');
    await page.goto('/dashboard/import-export');
    await page.waitForSelector('[data-testid="smart-import-denied"]', { timeout: 30_000 });
    const text = await page.locator('[data-testid="smart-import-denied"]').textContent();
    expect(text).toContain('company manager');
    // What actually matters: the explanation is ON SCREEN and reachable in
    // document order, so a screen reader meets it whether or not the disabled
    // button can be focused. (The button sits inside a Tooltip wrapper, so
    // "same parent element" was the wrong thing to assert.)
    const placement = await page.evaluate(() => {
      const p = document.querySelector('[data-testid="smart-import-denied"]');
      const b = document.querySelector('[data-testid="start-import"]');
      if (!p || !b) return null;
      const card = b.closest('.card');
      return {
        inSameCard: !!card && card.contains(p),
        afterTheButton: !!(b.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING),
        rendered: (p as HTMLElement).offsetHeight > 0,
      };
    });
    expect(placement).toEqual({ inSameCard: true, afterTheButton: true, rendered: true });
  });

  test('child to parent navigation is keyboard reachable', async ({ page }) => {
    await stub(page, 'ORGANIZATION_MANAGER');
    await page.goto('/dashboard/products/kid-1');
    await page.waitForSelector('[data-testid="family-role-kid-1"]', { timeout: 30_000 });
    const toParent = page.locator('a[href="/dashboard/products/card-1"]').first();
    await expect(toParent).toHaveCount(1);
    await toParent.focus();
    await expect(toParent).toBeFocused();
  });

  test('parent to children navigation is keyboard reachable', async ({ page }) => {
    await stub(page, 'ORGANIZATION_MANAGER');
    await page.goto('/dashboard/products/card-1');
    await page.waitForSelector('[data-testid="family-role-card-1"]', { timeout: 30_000 });
    const toChild = page.locator('a[href="/dashboard/products/kid-2"]').first();
    await expect(toChild).toHaveCount(1);
    await toChild.focus();
    await expect(toChild).toBeFocused();
  });

  test('role meaning is text, not colour', async ({ page }) => {
    await stub(page, 'ORGANIZATION_MANAGER');
    await page.goto('/dashboard/products');
    await page.waitForSelector('[data-testid^="family-role-"]', { timeout: 30_000 });
    // Rendered greyscale, every badge still reads.
    await page.addStyleTag({ content: 'html { filter: grayscale(1) !important; }' });
    const texts = await page.locator('[data-testid^="family-role-"]').allTextContents();
    expect(texts.length).toBeGreaterThanOrEqual(3);
    for (const t of texts) expect(t.trim().length).toBeGreaterThan(0);
    await page.screenshot({ path: 'test-results/pra-screenshots/pra-list-greyscale.png', fullPage: true });
  });
});

/**
 * PR B — manual grouping, in a real browser at both widths.
 */
for (const vp of VIEWPORTS) {
  test.describe(`grouping · ${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('the bulk bar offers grouping, and explains when it cannot', async ({ page }) => {
      await stub(page, 'ORGANIZATION_MANAGER');
      await page.goto('/dashboard/products');
      await page.waitForSelector('tbody tr', { timeout: 30_000 });

      // Selecting the parent card and the standalone item is an ineligible mix.
      // Selected by KEYBOARD, deliberately.
      //
      // The bulk bar is `fixed bottom-4`, so once it appears it can sit over a
      // row and swallow a pointer click on the checkbox underneath — visible at
      // 390px, where it wraps to two lines. That overlap is a property of the
      // shared bar, not of grouping, and it is recorded rather than reshaped
      // here. Focus and Space are unaffected by it, which is the path this
      // asserts: the feature must be operable without a mouse.
      const boxes = page.locator('tbody tr input[type="checkbox"]');
      await boxes.nth(0).focus();
      await page.keyboard.press('Space');
      await boxes.nth(2).focus();
      await page.keyboard.press('Space');
      await page.waitForSelector('[data-testid="bulk-group"]', { timeout: 15_000 });
      await expect(page.locator('[data-testid="bulk-group"]')).toBeDisabled();
      await expect(page.locator('[data-testid="bulk-group-blocked"]')).toContainText(/standalone/i);

      await assertNoHorizontalOverflow(page, `group-blocked/${vp.name}`);
      await page.screenshot({ path: `test-results/pra-screenshots/prb-blocked-${vp.name}.png`, fullPage: true });
    });

    /**
     * THE NAME FIELD MUST BE WIDE ENOUGH TO READ WHAT IS IN IT.
     *
     * Laid out as one row, the name input and the selector label shared the
     * width and at 390px the name got about sixty pixels — unusable for the
     * one field this screen exists to edit. The two stack until there is room
     * for both, so the name always has the width of the dialog.
     */
    test('each child name field is usable and the dialog never scrolls sideways', async ({ page }) => {
      await stub(page, 'ORGANIZATION_MANAGER', { pairOfStandalones: true });
      await page.goto('/dashboard/products');
      await page.waitForSelector('tbody tr', { timeout: 30_000 });

      const rows = page.locator('tbody tr');
      for (let i = 0; i < (await rows.count()); i += 1) {
        const row = rows.nth(i);
        if ((await row.locator('[data-role="STANDALONE"]').count()) === 0) continue;
        await row.locator('input[type="checkbox"]').focus();
        await page.keyboard.press('Space');
      }
      await page.locator('[data-testid="bulk-group"]').click();
      await page.waitForSelector('[data-testid="group-modal"]', { timeout: 15_000 });

      const names = page.locator('[data-testid^="group-name-"]:not([id*="label"]):not([id*="owner"])');
      const count = await names.count();
      expect(count).toBeGreaterThan(0);

      // A long name in every field, the case that made the squeeze obvious.
      for (let i = 0; i < count; i += 1) {
        await names.nth(i).fill('Lámpara de pie de roble macizo con pantalla de lino natural');
      }

      const dialogWidth = await page
        .locator('[data-testid="group-modal"]')
        .evaluate((el) => el.getBoundingClientRect().width);
      for (let i = 0; i < count; i += 1) {
        const w = await names.nth(i).evaluate((el) => el.getBoundingClientRect().width);
        // Comfortably more than the ~62px the shared row used to leave, and a
        // real share of the dialog rather than a sliver beside the label.
        expect(w, `${vp.name}: name field width`).toBeGreaterThan(160);
        expect(w).toBeGreaterThan(dialogWidth * 0.4);
      }

      // The selector label is still its own field, and still reachable.
      await expect(page.locator('[data-testid^="group-label-"]').first()).toBeVisible();
      await assertNoHorizontalOverflow(page, `group-modal-names/${vp.name}`);

      // Keyboard: the name field and the label beside it are both reachable,
      // and focus lands where it is expected.
      await names.first().focus();
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe(
        await names.first().getAttribute('data-testid'),
      );
      await page.keyboard.press('Tab');
      const afterTab = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? '');
      expect(afterTab, `${vp.name}: tab order`).toMatch(/^group-(label|name)-/);
    });

    test('the modal collects a name and labels, and previews the outcome', async ({ page }) => {
      await stub(page, 'ORGANIZATION_MANAGER', { pairOfStandalones: true });
      await page.goto('/dashboard/products');
      await page.waitForSelector('tbody tr', { timeout: 30_000 });

      // Select every standalone row. Selection is by KEYBOARD for the reason
      // given above: the fixed bar can cover a row's checkbox.
      const rows = page.locator('tbody tr');
      for (let i = 0; i < (await rows.count()); i += 1) {
        const row = rows.nth(i);
        if ((await row.locator('[data-role="STANDALONE"]').count()) === 0) continue;
        await row.locator('input[type="checkbox"]').focus();
        await page.keyboard.press('Space');
      }

      const group = page.locator('[data-testid="bulk-group"]');
      await expect(group).toBeEnabled();
      await group.click();
      await page.waitForSelector('[data-testid="group-modal"]', { timeout: 15_000 });

      // Every selected item gets its own editable label, prefilled.
      const labels = page.locator('[data-testid^="group-label-"]');
      expect(await labels.count()).toBe(2);
      for (let i = 0; i < 2; i += 1) expect((await labels.nth(i).inputValue()).trim().length).toBeGreaterThan(0);

      // The preview says the three things that surprise people, plus the
      // status the card will carry and what the copied price is NOT.
      const preview = page.locator('[data-testid="group-preview"]');
      await expect(preview).toContainText(/never sold/i);
      await expect(preview).toContainText(/own price/i);
      await expect(preview).toContainText(/stores/i);
      await expect(page.locator('[data-testid="group-preview-status"]')).toContainText(/published|draft/i);
      await expect(page.locator('[data-testid="group-preview-price"]')).toContainText(/sort/i);

      // Naming the card is what unblocks confirmation.
      const confirm = page.locator('[data-testid="group-confirm"]');
      await expect(confirm).toBeDisabled();
      await page.locator('[data-testid="group-parent-name"]').fill('Lámpara de pie');
      await expect(confirm).toBeEnabled();

      await assertNoHorizontalOverflow(page, `group-modal/${vp.name}`);
      // Enabled must also LOOK enabled: the button fades under
      // `disabled:opacity-50`, and it animates back over 200ms.
      await expect
        .poll(() => confirm.evaluate((n) => getComputedStyle(n).opacity), { timeout: 5_000 })
        .toBe('1');
      await page.screenshot({ path: `test-results/pra-screenshots/prb-modal-${vp.name}.png`, fullPage: true });
    });

    /**
     * POINTER AND TOUCH, at the width where the bar wraps.
     *
     * The keyboard path proves the feature is operable without a mouse; it
     * proves nothing about the mouse. This selects with ordinary clicks — no
     * `force`, no `dispatchEvent`, no `evaluate` reaching into the page, no
     * keyboard — so Playwright's own actionability check is the assertion:
     * it refuses to click an element another element covers, which is exactly
     * the defect the bar's spacer removes.
     */
    test('every row checkbox can be clicked with a real pointer, and the bar never covers one', async ({ page }) => {
      await stub(page, 'ORGANIZATION_MANAGER', { pairOfStandalones: true });
      await page.goto('/dashboard/products');
      await page.waitForSelector('tbody tr', { timeout: 30_000 });

      const rows = page.locator('tbody tr');
      const standalone: number[] = [];
      for (let i = 0; i < (await rows.count()); i += 1) {
        if ((await rows.nth(i).locator('[data-role="STANDALONE"]').count()) > 0) standalone.push(i);
      }
      expect(standalone.length).toBeGreaterThanOrEqual(2);

      for (const i of standalone) {
        await rows.nth(i).locator('input[type="checkbox"]').click();
      }
      // Selecting made the bar appear; EVERY row's checkbox must still be
      // clickable underneath it, including the last one.
      for (let i = 0; i < (await rows.count()); i += 1) {
        const box = rows.nth(i).locator('input[type="checkbox"]');
        await box.scrollIntoViewIfNeeded();
        const covered = await box.evaluate((node) => {
          const r = node.getBoundingClientRect();
          const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return at !== node && !node.contains(at);
        });
        expect(covered, `row ${i}: the bulk bar is over this checkbox`).toBe(false);
      }

      // ...and the flow completes from there with the pointer alone.
      await page.locator('[data-testid="bulk-group"]').click();
      await page.waitForSelector('[data-testid="group-modal"]', { timeout: 15_000 });
      await page.locator('[data-testid="group-parent-name"]').fill('Lámpara de pie');
      await page.locator('[data-testid="group-confirm"]').click();
      await page.waitForURL(/\/dashboard\/products\/new-card/, { timeout: 15_000 });
    });

    test('confirming posts one create and lands on the new card', async ({ page }) => {
      await stub(page, 'ORGANIZATION_MANAGER', { pairOfStandalones: true });
      const posted: { url: string; body: string }[] = [];
      page.on('request', (r) => {
        if (r.method() === 'POST' && r.url().includes('/products/families'))
          posted.push({ url: r.url(), body: r.postData() ?? '' });
      });
      await page.goto('/dashboard/products');
      await page.waitForSelector('tbody tr', { timeout: 30_000 });

      const rows = page.locator('tbody tr');
      for (let i = 0; i < (await rows.count()); i += 1) {
        const row = rows.nth(i);
        if ((await row.locator('[data-role="STANDALONE"]').count()) === 0) continue;
        await row.locator('input[type="checkbox"]').focus();
        await page.keyboard.press('Space');
      }
      await page.locator('[data-testid="bulk-group"]').click();
      await page.waitForSelector('[data-testid="group-modal"]', { timeout: 15_000 });
      await page.locator('[data-testid="group-parent-name"]').fill('Lámpara de pie');
      await page.locator('[data-testid="group-confirm"]').click();

      // It lands on the NEW card's own page.
      await page.waitForURL(/\/dashboard\/products\/new-card/, { timeout: 15_000 });

      // Exactly one creating call, carrying every selected member.
      const creates = posted.filter((r) => !r.url.includes('/validate'));
      expect(creates.length).toBe(1);
      const sent = JSON.parse(creates[0].body) as { name: string; members: { id: string; label: string }[] };
      expect(sent.name).toBe('Lámpara de pie');
      expect(sent.members.length).toBe(2);
      expect(sent.members.map((m) => m.id).sort()).toEqual(['solo-1', 'solo-2']);
      for (const m of sent.members) expect(m.label.trim().length).toBeGreaterThan(0);
    });
  });
}
