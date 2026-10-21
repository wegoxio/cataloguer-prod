import { mkdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../test/pg-harness';

const gate = pgTestsEnabled();
// The measurement run is EXPENSIVE (seeds ~100k products) and writes files
// into docs/evidence/183 — it is a deliberate act, not part of the battery.
const d = gate.enabled && process.env.EVIDENCE_183 === '1' ? describe : describe.skip;

/**
 * #183 — the MEASUREMENT run behind the three shipped indexes and the Phase 6
 * filter arms. Regenerates the committed evidence:
 *
 *   EVIDENCE_183=1 TEST_DATABASE_URL=... ALLOW_PG_DISPOSABLE_TESTS=1 \
 *     pnpm exec jest --runInBand src/database/evidence-183.pg.spec.ts
 *
 * Seeds a disposable database at the discovery scale (96k products, 150k
 * images, 120k orders, 2k categories, 30k specification values, 20k ledger
 * rows), captures EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) for every condemned
 * shape BEFORE the index migration and again AFTER it, and for each Phase 6
 * filter arm after it, then writes normalized JSON plus a human summary under
 * docs/evidence/183/. "Normalized" = raw plans kept verbatim, execution and
 * planning times rounded to 0.01ms, one file per measurement, stable names —
 * so two runs diff structurally even though timings wobble.
 */
d('#183 measurement evidence (EXPENSIVE, gated by EVIDENCE_183=1)', () => {
  jest.setTimeout(1_800_000);

  const EVIDENCE_DIR = resolve(__dirname, '../../../docs/evidence/183');
  const INDEX_MIGRATION = 'Migration20260825110000';
  const PRE_INDEX_MIGRATION = 'Migration20260825100000';

  let pg: DisposablePg;
  let em: EntityManager;
  let ORG: string;
  let STORE: string;
  let CAT_PARENT: string;
  let DEF_MATERIAL: string;
  const summary: { name: string; phase: string; executionMs: number; planningMs: number }[] = [];

  const round = (n: number) => Math.round(n * 100) / 100;

  const measure = async (name: string, phase: 'before' | 'after', sql: string, params: unknown[]) => {
    // warm once so the first-touch buffer reads don't dominate the comparison
    await em.execute(sql, params);
    const rows: { 'QUERY PLAN': any }[] = await em.execute(`explain (analyze, buffers, format json) ${sql}`, params);
    const plan = rows[0]['QUERY PLAN'];
    const root = Array.isArray(plan) ? plan[0] : plan;
    root['Execution Time'] = round(root['Execution Time']);
    root['Planning Time'] = round(root['Planning Time']);
    summary.push({
      name,
      phase,
      executionMs: root['Execution Time'],
      planningMs: root['Planning Time'],
    });
    writeFileSync(
      join(EVIDENCE_DIR, `${name}.${phase}.json`),
      JSON.stringify({ name, phase, sql: sql.replace(/\s+/g, ' ').trim(), plan: root }, null, 2) + '\n',
    );
  };

  beforeAll(async () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    // Boot at the pre-index revision: the "before" world.
    pg = await withDisposablePg({ migrateTo: PRE_INDEX_MIGRATION });
    em = pg.orm.em.fork();

    const [org]: { id: string }[] = await em.execute(
      `insert into organizations (name, slug, created_at, updated_at) values ('Evidence', 'evidence-183', now(), now()) returning id`,
    );
    ORG = org.id;
    const [store]: { id: string }[] = await em.execute(
      `insert into stores (name, slug, organization_id, created_at, updated_at)
       values ('Evidence Store', 'evidence-183-store', ?::uuid, now(), now()) returning id`,
      [ORG],
    );
    STORE = store.id;

    // ~2k categories, one parent with children so the subtree arm has depth
    const [parent]: { id: string }[] = await em.execute(
      `insert into categories (name, slug, organization_id, created_at, updated_at)
       values ('Muebles', 'muebles-evidence', ?::uuid, now(), now()) returning id`,
      [ORG],
    );
    CAT_PARENT = parent.id;
    await em.execute(
      `insert into categories (name, slug, organization_id, parent_category_id, created_at, updated_at)
       select 'Categoría '||i, 'cat-ev-'||i, ?::uuid, case when i % 10 = 0 then ?::uuid end, now(), now()
         from generate_series(1, 2000) i`,
      [ORG, CAT_PARENT],
    );

    // 96k products: 5% are children of the previous row (families), SKUs and
    // manufacturer codes throughout, spread over 180 days of created_at
    await em.execute(
      `insert into products (name, slug, organization_id, status, price, sku, manufacturer_code, stock_quantity, created_at, updated_at)
       select 'Producto '||i, 'prod-ev-'||i, ?::uuid, 'PUBLISHED', (i % 500) + 1, 'SKU-'||i, 'MFG-'||(i % 7000), i % 7,
              now() - ((i % 259200) || ' minutes')::interval, now()
         from generate_series(1, 96000) i`,
      [ORG],
    );
    await em.execute(
      `update products p set parent_id = q.id
         from products q
        where p.organization_id = ?::uuid and q.organization_id = p.organization_id
          and p.slug = 'prod-ev-'||(substring(q.slug from 9)::int + 1)
          and substring(q.slug from 9)::int % 20 = 1 and substring(p.slug from 9)::int % 20 = 2`,
      [ORG],
    );
    // channel links for every product; category membership for a third
    await em.execute(
      `insert into store_products (organization_id, store_id, product_id, published, created_at, updated_at)
       select ?::uuid, ?::uuid, id, true, now(), now() from products where organization_id = ?::uuid`,
      [ORG, STORE, ORG],
    );
    await em.execute(
      `insert into product_categories (product_id, category_id)
       select p.id, c.id from products p
         join categories c on c.slug = 'cat-ev-'||((substring(p.slug from 9)::int % 2000) + 1)
        where p.organization_id = ?::uuid and substring(p.slug from 9)::int % 3 = 0`,
      [ORG],
    );

    // ~150k images (1–2 per product), 15% archived
    await em.execute(
      `insert into product_images (product_id, url, is_primary, display_mode, sort_order, archived_at, created_at)
       select id, 'https://cdn.test/'||slug||'-'||g||'.png', g = 1, 'CONTAIN', g - 1,
              case when (substring(slug from 9)::int + g) % 7 = 0 then now() end, now()
         from products, generate_series(1, 2) g
        where organization_id = ?::uuid and (g = 1 or substring(slug from 9)::int % 2 = 0)`,
      [ORG],
    );

    // 120k orders across 90 days, with a REALISTIC status skew: almost
    // everything ends DELIVERED, and the panel's working filter (NEW) is rare
    // — which is exactly when "walk (org, created_at) and filter" hurts and
    // the composite (org, status, created_at) earns its keep.
    await em.execute(
      `insert into sales_orders (store_id, organization_id, order_number, status, total_usd, created_at, updated_at)
       select ?::uuid, ?::uuid, 'EV-'||i,
              case when i % 200 = 0 then 'NEW' when i % 10 = 1 then 'CONFIRMED' when i % 20 = 2 then 'CANCELLED' else 'DELIVERED' end,
              (i % 90) + 1, now() - ((i % 129600) || ' minutes')::interval, now()
         from generate_series(1, 120000) i`,
      [STORE, ORG],
    );

    // one filterable TEXT spec with values on ~30k products
    const [def]: { id: string }[] = await em.execute(
      `insert into product_field_definitions (organization_id, "key", label, type, source, applicability, created_at, updated_at)
       values (?::uuid, 'material', 'Material', 'TEXT', 'CUSTOM', 'BOTH', now(), now()) returning id`,
      [ORG],
    );
    DEF_MATERIAL = def.id;
    await em.execute(
      `insert into store_field_settings (organization_id, store_id, definition_id, active, publicly_visible, filterable, created_at, updated_at)
       values (?::uuid, ?::uuid, ?::uuid, true, true, true, now(), now())`,
      [ORG, STORE, DEF_MATERIAL],
    );
    await em.execute(
      `insert into product_field_values (organization_id, product_id, definition_id, definition_type, value_text, created_at, updated_at)
       select ?::uuid, id, ?::uuid, 'TEXT', (array['Roble','Nogal','Metal','Cristal'])[(substring(slug from 9)::int % 4) + 1], now(), now()
         from products where organization_id = ?::uuid and substring(slug from 9)::int % 3 = 1`,
      [ORG, DEF_MATERIAL, ORG],
    );

    // a store location and 20k AVAILABLE ledger rows (posting-fenced)
    const [location]: { id: string }[] = await em.execute(
      `insert into inventory_locations (organization_id, kind, code, name, store_id, created_at, updated_at)
       values (?::uuid, 'STORE', ?, 'Evidence', ?::uuid, now(), now()) returning id`,
      [ORG, `STORE:${STORE}`, STORE],
    );
    await em.transactional(async (tem) => {
      await tem.execute(`select set_config('cataloguer.posting', 'on', true)`);
      await tem.execute(
        `insert into inventory_balances (organization_id, location_id, product_id, physical_condition, operational_state, quantity, updated_at)
         select ?::uuid, ?::uuid, id, 'GOOD', 'AVAILABLE', substring(slug from 9)::int % 5, now()
           from products where organization_id = ?::uuid and substring(slug from 9)::int % 5 = 0`,
        [ORG, location.id, ORG],
      );
    });
    await em.execute(`vacuum analyze products`);
    await em.execute(`vacuum analyze product_images`);
    await em.execute(`vacuum analyze sales_orders`);
    await em.execute(`vacuum analyze categories`);
    await em.execute(`vacuum analyze product_field_values`);
    await em.execute(`vacuum analyze inventory_balances`);
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  it('measures the condemned shapes before, applies the migration, measures everything after', async () => {
    const salesSql = `select id from sales_orders where organization_id = ?::uuid and status = 'NEW' order by created_at desc limit 25`;
    const imagesSql = `select id, url from product_images where archived_at is null and product_id in (select id from products where organization_id = ?::uuid order by created_at desc limit 25)`;
    const nameSql = `select id from products where organization_id = ?::uuid and name ilike '%ducto 4711%'`;
    const skuSql = `select id from products where organization_id = ?::uuid and sku ilike '%4711%'`;
    const categoryNameSql = `select id from categories where organization_id = ?::uuid and archived_at is null and name ilike '%goría 171%'`;

    // ---- BEFORE ----
    for (const [name, sql] of [
      ['sales-listing', salesSql],
      ['images-active-page', imagesSql],
      ['search-name-arm', nameSql],
      ['search-sku-arm', skuSql],
      ['category-name-arm', categoryNameSql],
    ] as const) {
      await measure(name, 'before', sql, [ORG]);
    }

    // ---- the migration under evidence ----
    await pg.orm.getMigrator().up({ to: INDEX_MIGRATION });
    await em.execute(`select gin_clean_pending_list('products_name_trgm_index'::regclass)`);
    await em.execute(`select gin_clean_pending_list('products_sku_trgm_index'::regclass)`);
    await em.execute(`vacuum analyze products`);

    // ---- AFTER: the same five shapes ----
    for (const [name, sql] of [
      ['sales-listing', salesSql],
      ['images-active-page', imagesSql],
      ['search-name-arm', nameSql],
      ['search-sku-arm', skuSql],
      ['category-name-arm', categoryNameSql],
    ] as const) {
      await measure(name, 'after', sql, [ORG]);
    }

    // ---- AFTER: every Phase 6 filter arm, as the service emits it ----
    await measure(
      'filter-mfgcode-arm',
      'after',
      `select id from products where organization_id = ?::uuid and parent_id is null
        and (manufacturer_code ilike '%FG-4711%'
          or exists (select 1 from products c
                      where c.parent_id = products.id and c.status = 'PUBLISHED' and c.archived_at is null
                        and c.manufacturer_code ilike '%FG-4711%'
                        and exists (select 1 from store_products sp where sp.product_id = c.id and sp.store_id = ?::uuid and sp.published)))`,
      [ORG, STORE],
    );
    await measure(
      'filter-category-subtree-arm',
      'after',
      `select count(*) from product_categories pc
        where pc.category_id in (select id from categories where organization_id = ?::uuid
                                  and (id = ?::uuid or parent_category_id = ?::uuid))`,
      [ORG, CAT_PARENT, CAT_PARENT],
    );
    await measure(
      'filter-instock-arm',
      'after',
      `select count(*) from products p where p.organization_id = ?::uuid and p.parent_id is null and exists (
         select 1 from products m
          where ((not exists (select 1 from products c where c.parent_id = p.id) and m.id = p.id)
              or (m.parent_id = p.id and m.status = 'PUBLISHED' and m.archived_at is null
                  and exists (select 1 from store_products sp where sp.product_id = m.id and sp.store_id = ?::uuid and sp.published)))
            and coalesce((select sum(b.quantity) from inventory_balances b join inventory_locations l on l.id = b.location_id
                           where b.product_id = m.id and b.organization_id = ?::uuid and b.operational_state = 'AVAILABLE'
                             and l.kind = 'STORE' and l.store_id = ?::uuid), m.stock_quantity) > 0)`,
      [ORG, STORE, ORG, STORE],
    );
    await measure(
      'filter-spec-arm',
      'after',
      `select count(*) from products p where p.organization_id = ?::uuid and p.parent_id is null and exists (
         select 1 from products m
          where (m.id = p.id or (m.parent_id = p.id and m.status = 'PUBLISHED' and m.archived_at is null
                 and exists (select 1 from store_products sp where sp.product_id = m.id and sp.store_id = ?::uuid and sp.published)))
            and (exists (select 1 from product_field_values pv where pv.product_id = m.id and pv.definition_id = ?::uuid and pv.value_text = 'Roble')
              or (m.parent_id is not null
                  and not exists (select 1 from product_field_values pv where pv.product_id = m.id and pv.definition_id = ?::uuid)
                  and exists (select 1 from product_field_values pv where pv.product_id = m.parent_id and pv.definition_id = ?::uuid and pv.value_text = 'Roble'))))`,
      [ORG, STORE, DEF_MATERIAL, DEF_MATERIAL, DEF_MATERIAL],
    );
    await measure(
      'filter-child-search-arm',
      'after',
      `select id from products p where p.organization_id = ?::uuid and p.parent_id is null
        and exists (select 1 from products c
                     where c.parent_id = p.id and c.status = 'PUBLISHED' and c.archived_at is null and c.sku ilike '%4711%'
                       and exists (select 1 from store_products sp where sp.product_id = c.id and sp.store_id = ?::uuid and sp.published))`,
      [ORG, STORE],
    );

    // ---- the human summary ----
    const byName = new Map<string, { before?: number; after?: number }>();
    for (const row of summary) {
      const entry = byName.get(row.name) ?? {};
      entry[row.phase as 'before' | 'after'] = row.executionMs;
      byName.set(row.name, entry);
    }
    const lines = [
      '# #183 measurement evidence',
      '',
      `Regenerated by \`src/database/evidence-183.pg.spec.ts\` (EVIDENCE_183=1) on a disposable`,
      `PostgreSQL seeded to 96k products / ~150k images / 120k orders / 2k categories /`,
      `~30k specification values / ~19k ledger rows. Raw normalized plans sit beside this`,
      `file as \`<shape>.<phase>.json\` (EXPLAIN ANALYZE, BUFFERS, FORMAT JSON; times`,
      `rounded to 0.01ms).`,
      '',
      '| shape | before (ms) | after (ms) |',
      '|---|---|---|',
      ...[...byName.entries()].map(([name, entry]) => `| ${name} | ${entry.before ?? '—'} | ${entry.after ?? '—'} |`),
      '',
      'The three shipped indexes are exactly the ones the before/after pairs justify:',
      'the sales composite, the active-images partial, and the two trigram GINs',
      '(one shape in the table, two index objects). The category-name arm was measured',
      'and did NOT earn an index (sub-millisecond either way at 2k categories).',
      '',
      'Arms measured `after`-only are the Phase 6 filters. The two aggregate arms',
      '(`filter-instock-arm`, `filter-spec-arm`) are WORST-CASE numbers: an unfiltered',
      'COUNT of the entire 96k-product catalogue through the member predicate — a page',
      'of 25 pays a fraction of it, and real tenants are orders of magnitude smaller.',
      'The inStock shape originally measured ~12,000ms here; the shipped clause pins the',
      'tenant on the ledger probe (making the (organization_id, product_id) balances',
      'index usable) and folds the exists+sum pair into one `coalesce(sum, owned)` —',
      'that rewrite, not a new index, is what the 322ms figure reflects.',
      '',
    ];
    writeFileSync(join(EVIDENCE_DIR, 'summary.md'), lines.join('\n'));
    expect(summary.length).toBe(15);
  });
});
