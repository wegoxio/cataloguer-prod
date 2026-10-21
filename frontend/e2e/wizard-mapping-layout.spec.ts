import { test, expect, Page } from '@playwright/test';

/**
 * The mapping stage, measured rather than described.
 *
 * Manual acceptance rejected a release for scrolling and layout faults that
 * every unit test passed, because class-name assertions cannot see geometry: a
 * component can render exactly the classes it was asked for and still put its
 * only forward action a thousand pixels below a scroll container that does not
 * scroll. So this measures the real thing — real Chromium, real CSS, real
 * layout — and fails on numbers.
 *
 * ONLY the data is stubbed. Every route the page calls is answered here so the
 * suite needs no server, no database and no runner; nothing about the stub
 * touches a stylesheet, a class or a box. What is measured is what a person
 * sees.
 *
 * The file it renders is deliberately wide. Forty-five columns is an ordinary
 * supplier export and it is what makes the mapping form long enough for the
 * fault to appear; a three-column fixture fits on one screen and proves
 * nothing.
 */

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const ANALYSIS_ID = '22222222-2222-4222-8222-222222222222';
const LOCATION_ID = '33333333-3333-4333-8333-333333333333';
const STORE_ID = '44444444-4444-4444-8444-444444444444';

/** A wide, ordinary-looking export. */
const HEADERS = [
  'sku', 'nombre', 'descripcion', 'precio', 'precio_oferta', 'coste', 'existencias', 'categoria',
  'marca', 'proveedor', 'ean', 'peso', 'largo', 'ancho', 'alto', 'color', 'talla', 'material',
  'temporada', 'coleccion', 'genero', 'pais_origen', 'arancel', 'iva', 'descuento', 'unidad',
  'minimo_pedido', 'plazo_entrega', 'garantia', 'estado', 'visible', 'destacado', 'etiquetas',
  'imagen_1', 'imagen_2', 'imagen_3', 'notas', 'referencia_interna', 'fecha_alta', 'fecha_baja',
  'lote', 'caducidad', 'ubicacion', 'pasillo', 'estante',
];

const ROW = HEADERS.map((_, i) => `v${i}`);

/**
 * The exact origin, never `*`.
 *
 * The session refresh is sent with `credentials: 'include'`, and a credentialed
 * response carrying a wildcard origin is rejected by the browser — the sign-in
 * would fail and this suite would measure the login page instead of the mapping
 * form, which is exactly what it did before this was corrected.
 */
/** The origin the page is actually served from — localhost, or a deployed host. */
const ORIGIN = new URL(process.env.LAYOUT_BASE_URL ?? 'http://localhost:3000').origin;

const json = (body: unknown) => ({
  status: 200,
  contentType: 'application/json',
  headers: {
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-credentials': 'true',
  },
  body: JSON.stringify(body),
});

/**
 * Answer every API call the wizard makes.
 *
 * Broad on purpose: an unstubbed call would reach a server that is not running,
 * and the page would render an error state whose geometry is not the thing
 * under test.
 */
async function stubApi(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname.replace('/api/v1', '');

    if (p === '/auth/refresh') {
      return route.fulfill(
        json({ data: { accessToken: 'stub-token', user: { id: 'u1', email: 'manager@example.test', name: 'Manager' } } }),
      );
    }
    if (p === '/auth/me') {
      return route.fulfill(
        json({
          data: {
            user: { id: 'u1', email: 'manager@example.test', name: 'Manager' },
            scope: {
              platform: false,
              role: 'ORGANIZATION_MANAGER',
              organizationId: 'org-1',
              storeId: STORE_ID,
              allowedStoreIds: [STORE_ID],
            },
          },
        }),
      );
    }
    if (p === '/import/wizard/contract') {
      return route.fulfill(
        json({ data: { version: '1.0.0', supportedTransformations: [], issueSeverities: {}, transformations: [] } }),
      );
    }
    if (p === `/import/lifecycle/sources/${SOURCE_ID}`) {
      return route.fulfill(
        json({
          data: {
            id: SOURCE_ID,
            originalFileName: 'proveedor-export.csv',
            detectedFormat: 'CSV_OR_TEXT',
            contentHash: 'a'.repeat(64),
            status: 'AVAILABLE',
            createdAt: '2026-08-29T10:00:00.000Z',
          },
        }),
      );
    }
    if (p.endsWith('/analysis')) {
      return route.fulfill(json({ data: { id: ANALYSIS_ID, status: 'COMPLETED' } }));
    }
    if (p.startsWith('/import/lifecycle/analyses/')) {
      return route.fulfill(
        json({
          data: {
            id: ANALYSIS_ID,
            sourceId: SOURCE_ID,
            status: 'COMPLETED',
            tables: {
              sample: { firstRowNumber: 2, sheet: 'main', headers: HEADERS, rows: [ROW, ROW, ROW] },
              columnTypes: HEADERS.map(() => 'TEXT'),
            },
            proposals: HEADERS.map((header, columnIndex) => ({ columnIndex, header, field: null, reasons: [] })),
            findings: [],
            rowsAnalyzed: 3,
            failureReason: null,
          },
        }),
      );
    }
    if (p.startsWith('/import/lifecycle/relationship-options')) {
      return route.fulfill(
        json({
          data: {
            storeId: STORE_ID,
            stockDestinations: [
              { id: LOCATION_ID, name: 'Almacén central', kind: 'WAREHOUSE', storeId: null, isDefault: true, proposed: false },
            ],
            stores: [{ id: STORE_ID, name: 'Centro' }],
            existingCategoryNames: [],
          },
        }),
      );
    }
    if (p.endsWith('/cancel')) {
      return route.fulfill(json({ data: { cancelled: true, alreadyCancelled: false, notice: 'This import was cancelled. Nothing in your catalogue was changed.' } }));
    }
    if (p.startsWith('/import/wizard/templates')) return route.fulfill(json({ data: [] }));
    if (p === '/import/wizard/preview') {
      // The COMPLETE shape. A partial one threw `Cannot read properties of
      // undefined (reading 'length')` inside the editor the moment a preview
      // arrived — a fault in this stub, not in the page, and one that only
      // showed up in the test that waits long enough for the debounce.
      return route.fulfill(
        json({
          data: {
            rows: [],
            ignoredColumns: [],
            blankRowCount: 0,
            previewedRows: 0,
            issues: [],
            summary: { errors: 0, warnings: 0, infos: 0 },
            readiness: { allowed: false, reason: 'Nothing is mapped yet.' },
          },
        }),
      );
    }

    return route.fulfill(json({ data: null }));
  });
}

/** Open the wizard at the mapping stage and wait for the form to be there. */
async function openMapping(page: Page) {
  await stubApi(page);
  // `source` and `type` are the link's own parameter names.
  await page.goto(`/dashboard/import-export/wizard?source=${SOURCE_ID}&type=PRODUCTS`);
  await expect(page.getByTestId('mapping-editor')).toBeVisible({ timeout: 20_000 });
  // The last column must exist before anything is measured: measuring a form
  // that is still filling reports the height of a form nobody has.
  await expect(page.getByTestId(`column-${HEADERS.length - 1}`)).toBeAttached({ timeout: 20_000 });
}

/**
 * Drive the page's real scroll owner to a fraction of its range.
 *
 * The owner is DISCOVERED by overflow rather than named by a test id, because
 * this suite has to run unchanged against builds that know nothing about it —
 * the rollback production source and the rejected release included.
 */
async function scrollMainTo(page: Page, fraction: number) {
  await page.evaluate((f) => {
    const owners: HTMLElement[] = [];
    let worst = 0;
    document.querySelectorAll('*').forEach((el) => {
      const e = el as HTMLElement;
      const s = getComputedStyle(e);
      const over = e.scrollHeight - e.clientHeight;
      if (/(auto|scroll)/.test(s.overflowY) && over > worst) {
        worst = over;
        owners[0] = e;
      }
    });
    const owner = owners[0];
    if (owner) owner.scrollTop = (owner.scrollHeight - owner.clientHeight) * f;
    else window.scrollTo(0, document.body.scrollHeight * f);
  }, fraction);
}

/**
 * The scrollable ancestors OF THE MAPPING FORM, innermost first.
 *
 * Ancestors only, and that distinction is the whole point. The sidebar has its
 * own scrollbar on purpose — on a short screen its nav scrolls so the sign-out
 * block below stays reachable — and counting it would make this test demand the
 * removal of a deliberate, correct affordance. What breaks a person's session
 * is two scrollbars stacked between them and the thing they are editing: the
 * bottom of a long form reachable only once BOTH have been driven to their end,
 * and most people never find the second one.
 */
async function contentScrollOwners(page: Page) {
  return page.evaluate(() => {
    const start = document.querySelector('[data-testid="mapping-editor"]');
    if (!start) return [];
    const owners: { tag: string; testid: string; cls: string; scrollH: number; clientH: number; over: number }[] = [];
    let el: Element | null = start;
    while (el) {
      const s = getComputedStyle(el);
      const over = el.scrollHeight - el.clientHeight;
      if (/(auto|scroll)/.test(s.overflowY) && over > 1) {
        owners.push({
          tag: el.tagName.toLowerCase(),
          testid: el.getAttribute('data-testid') ?? '',
          cls: (el.className || '').toString().slice(0, 70),
          scrollH: el.scrollHeight,
          clientH: el.clientHeight,
          over,
        });
      }
      el = el.parentElement;
    }
    return owners;
  });
}


/**
 * The viewport the failure was reported from is first.
 *
 * The screenshot measured 2482×1482 physical pixels at a device pixel ratio of
 * 2 — 1241×741 CSS pixels. Neither of the two sizes this suite already covered
 * was that one, but the fault was present at all three; the suite missed it
 * because it asked whether the action bar was VISIBLE, never whether it was
 * covering anything.
 */
for (const viewport of [
  { name: 'reported 1241×741 @2x', width: 1241, height: 741, dpr: 2 },
  { name: 'desktop 1440×900', width: 1440, height: 900, dpr: 1 },
  { name: 'desktop 1440×900 @2x', width: 1440, height: 900, dpr: 2 },
  { name: 'laptop 1280×720', width: 1280, height: 720, dpr: 1 },
]) {
  test.describe(`the mapping stage at ${viewport.name}`, () => {
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: viewport.dpr,
    });

    test('puts exactly one scrollbar between the reader and the form', async ({ page }) => {
      await openMapping(page);
      const owners = await contentScrollOwners(page);
      expect(owners.length, `content scroll owners: ${JSON.stringify(owners, null, 2)}`).toBe(1);
    });

    test('does not scroll the whole document behind that scrollbar', async ({ page }) => {
      await openMapping(page);

      // A REAL wheel, because that is the only honest question. `scrollTop`
      // can be assigned on an `overflow: hidden` element and will happily
      // report the value back, so a programmatic probe calls a fixed page
      // broken; and `scrollHeight > clientHeight` on the root is routine and
      // says nothing about whether anything moves. Both misled this test
      // before it was written this way.
      await page.mouse.move(20, 400); // over the shell, clear of the inner scroller
      await page.mouse.wheel(0, 1200);
      await page.waitForTimeout(200);

      const movedBy = await page.evaluate(() => window.scrollY);
      // The document scrolling behind the dashboard's own scroller is two
      // stacked scrollbars: the outer one travels thousands of pixels of
      // nothing and drags empty ground up under the shell.
      expect(movedBy, 'the document scrolled behind the content scroller').toBe(0);
    });

    test('keeps a usable action reachable without hunting', async ({ page }) => {
      await openMapping(page);
      // The stage must offer a way OUT and a way ON at all times. They live in
      // the header, where they cannot cover the form.
      await expect(page.getByTestId('wizard-cancel-import')).toBeVisible();
      await expect(page.getByTestId('wizard-save-exit')).toBeVisible();
    });

    test('never covers a single editor control, anywhere in the scroll range', async ({ page }) => {
      await openMapping(page);

      // The assertion the old suite was missing. It proved the bar was inside
      // the viewport — 598..645 of 741 is inside — while three to six mapping
      // inputs sat behind it at every scroll position. Being on screen and
      // being out of the way are different properties, and only one of them
      // was ever checked.
      for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
        await scrollMainTo(page, fraction);
        await page.waitForTimeout(150);

        const covered = await page.evaluate(() => {
          // Anything that could LIE OVER the form: an element taken out of
          // normal flow. A normal-flow container cannot cover its neighbours,
          // so listing one here would only ever report its own contents.
          const overlays = Array.from(document.querySelectorAll('body *')).filter((el) => {
            const s = getComputedStyle(el);
            if (s.position !== 'sticky' && s.position !== 'fixed' && s.position !== 'absolute') return false;
            // Visually hidden elements paint nothing, so they cover nothing.
            // Screen-reader labels are `position: absolute` and clipped to a
            // point; counting them would report a fault where a person sees a
            // perfectly clear form.
            if (s.visibility === 'hidden' || s.opacity === '0') return false;
            if (s.clipPath !== 'none' || (s.clip && s.clip !== 'auto')) return false;
            const r = el.getBoundingClientRect();
            return r.width > 2 && r.height > 2;
          }) as HTMLElement[];

          const editor = document.querySelector('[data-testid="mapping-editor"]');
          const vh = window.innerHeight;
          const hits: string[] = [];
          for (const bar of overlays) {
            // An overlay INSIDE the editor is the dangerous kind; one that is
            // the editor's ancestor is just a layout wrapper.
            if (!editor || bar.contains(editor)) continue;
            const br = bar.getBoundingClientRect();
            const targets = Array.from(
              editor.querySelectorAll('[data-testid^="column-"], select, input, button, label, a[href]'),
            ).filter((e) => !bar.contains(e) && !e.contains(bar));
            for (const el of targets) {
              const r = (el as HTMLElement).getBoundingClientRect();
              if (r.width === 0 || r.height === 0) continue;
              if (r.top >= vh || r.bottom <= 0) continue;
              if (r.bottom > br.top && r.top < br.bottom && r.right > br.left && r.left < br.right) {
                const who = bar.getAttribute('data-testid') ?? `${bar.tagName.toLowerCase()}.${(bar.className || '').toString().slice(0, 30)}`;
                hits.push(`${who} covers ${el.getAttribute('data-testid') ?? el.tagName.toLowerCase()}`);
              }
            }
          }
          return hits;
        });

        expect(covered, `at scroll ${fraction}: ${JSON.stringify(covered.slice(0, 6))}`).toEqual([]);
      }
    });

    test('lets every mapping control scroll fully into view', async ({ page }) => {
      await openMapping(page);
      // The last control especially. With a sticky footer it could never clear
      // the bar; in normal flow there is nothing to clear.
      const last = page.getByTestId(`column-${HEADERS.length - 1}`);
      await last.scrollIntoViewIfNeeded();
      await page.waitForTimeout(150);
      const clear = await page.evaluate((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const vh = window.innerHeight;
        const bars = ['wizard-actions', 'wizard-footer']
          .map((t) => document.querySelector(`[data-testid="${t}"]`))
          .filter((e): e is HTMLElement => e !== null);
        const overlapped = bars.some((b) => {
          const br = b.getBoundingClientRect();
          return r.bottom > br.top && r.top < br.bottom && r.right > br.left && r.left < br.right;
        });
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh, overlapped };
      }, `column-${HEADERS.length - 1}`);
      expect(clear).not.toBeNull();
      expect(clear!.top).toBeGreaterThanOrEqual(0);
      expect(clear!.bottom).toBeLessThanOrEqual(clear!.vh + 1);
      expect(clear!.overlapped, 'the last mapping control is behind an action area').toBe(false);
    });

    test('never leaves keyboard focus behind another element', async ({ page }) => {
      await openMapping(page);
      // Tab through the first stretch of the form and check, at each stop, that
      // the focused element is not underneath an action area. A control that
      // can be focused but not seen is worse than one that cannot be reached.
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press('Tab');
        const hidden = await page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null;
          if (!el || el === document.body) return null;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return null;
          const bars = ['wizard-actions', 'wizard-footer']
            .map((t) => document.querySelector(`[data-testid="${t}"]`))
            .filter((e): e is HTMLElement => e !== null && !e.contains(document.activeElement));
          for (const b of bars) {
            const br = b.getBoundingClientRect();
            if (r.bottom > br.top && r.top < br.bottom && r.right > br.left && r.left < br.right) {
              return el.getAttribute('data-testid') ?? el.tagName.toLowerCase();
            }
          }
          return null;
        });
        expect(hidden, `focused element hidden behind an action area: ${hidden}`).toBeNull();
      }
    });

    test('leaves no obsolete dead band under the content', async ({ page }) => {
      await openMapping(page);
      await scrollMainTo(page, 1);
      await page.waitForTimeout(200);
      const gap = await page.evaluate(() => {
        const owner = document.querySelector('.overflow-y-auto.px-6') as HTMLElement | null;
        if (!owner) return -1;
        let lowest = 0;
        owner.querySelectorAll('*').forEach((el) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.height > 0 && r.width > 0 && r.bottom > lowest) lowest = r.bottom;
        });
        return Math.round(owner.getBoundingClientRect().bottom - lowest);
      });
      // The 96px band existed only to clear a sticky footer that is gone.
      expect(gap, 'empty space below the last control').toBeLessThan(48);
    });

    test('puts the navigation footer after the last editor control', async ({ page }) => {
      await openMapping(page);
      const order = await page.evaluate((lastId) => {
        const last = document.querySelector(`[data-testid="${lastId}"]`);
        const footer = document.querySelector('[data-testid="wizard-footer"]');
        if (!last || !footer) return null;
        // Node.DOCUMENT_POSITION_FOLLOWING === 4
        return Boolean(last.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING);
      }, `column-${HEADERS.length - 1}`);
      expect(order, 'the footer must come after the editor in document flow').toBe(true);
    });

    test('leaves no dead grey band under the content', async ({ page }) => {
      await openMapping(page);
      await scrollMainTo(page, 1);
      await page.waitForTimeout(200);

      const gap = await page.evaluate(() => {
        // Find the element that actually owns the page's vertical scrolling,
        // by overflow. Discovered rather than named, so this measures ANY
        // build — including one that predates any marker attribute.
        const found: HTMLElement[] = [];
        let worst = 0;
        document.querySelectorAll('*').forEach((el) => {
          const e = el as HTMLElement;
          const s = getComputedStyle(e);
          const over = e.scrollHeight - e.clientHeight;
          if (/(auto|scroll)/.test(s.overflowY) && over > worst) {
            worst = over;
            found[0] = e;
          }
        });
        const owner = found[0];
        if (!owner) return -1;
        let lowest = 0;
        owner.querySelectorAll('*').forEach((el: Element) => {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.height > 0 && r.width > 0 && r.bottom > lowest) lowest = r.bottom;
        });
        return Math.round(owner.getBoundingClientRect().bottom - lowest);
      });
      // Some breathing room under the last control is deliberate; a band tall
      // enough to read as "the page ended and something is broken" is not.
      expect(gap, 'empty space below the last visible control').toBeLessThan(160);
    });

    test('reaches every action by keyboard', async ({ page }) => {
      await openMapping(page);
      const reached = await page.evaluate(() => {
        const bar = document.querySelector('[data-testid="wizard-actions"]');
        if (!bar) return null;
        return Array.from(bar.querySelectorAll('button,a[href]'))
          .filter((el) => !(el as HTMLButtonElement).disabled)
          .map((el) => (el as HTMLElement).tabIndex);
      });
      expect(reached, 'no action bar to focus').not.toBeNull();
      // A negative tabIndex takes a control out of the tab order entirely.
      expect(reached!.every((t) => t >= 0), `tab indices: ${JSON.stringify(reached)}`).toBe(true);
    });
  });
}
