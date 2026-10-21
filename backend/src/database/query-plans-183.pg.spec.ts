import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../test/pg-harness';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * #183 — STRUCTURAL proof that the three measured indexes exist and that the
 * planner can serve each condemned query shape from them.
 *
 * Deliberately NOT a timing test: milliseconds on a laptop prove nothing and
 * rot into flakes. What is pinned instead:
 *
 *  - the migration creates exactly the promised objects (and its down/up
 *    round-trips cleanly, extension included);
 *  - each hot shape's plan REFERENCES the intended index once sequential
 *    scans are taken off the table — i.e. the index genuinely serves the
 *    shape, which is the part a wrong column order or operator class would
 *    break silently.
 *
 * The BENEFIT is established separately by the committed measurement evidence
 * in docs/evidence/183/ (EXPLAIN ANALYZE at 96k products / 120k orders).
 */
d('#183 query plans are index-served (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let ORG: string;
  let STORE: string;

  /** EXPLAIN with seqscans disabled, returned as a searchable string. */
  const planFor = async (sql: string, params: unknown[]): Promise<string> => {
    return em.transactional(async (tem) => {
      await tem.execute(`set local enable_seqscan = off`);
      const rows = await tem.execute(`explain (format json) ${sql}`, params);
      return JSON.stringify(rows);
    });
  };

  beforeAll(async () => {
    pg = await withDisposablePg();
    em = pg.orm.em.fork();
    const [org]: { id: string }[] = await em.execute(
      `insert into organizations (name, slug, created_at, updated_at) values ('Plan Org', 'plan-183', now(), now()) returning id`,
    );
    ORG = org.id;
    const [store]: { id: string }[] = await em.execute(
      `insert into stores (name, slug, organization_id, created_at, updated_at)
       values ('Plan Store', 'plan-183-store', ?::uuid, now(), now()) returning id`,
      [ORG],
    );
    STORE = store.id;
    // A modest, ANALYZEd population so the planner has real statistics — big
    // enough that scanning a whole btree costs more than a selective trigram
    // probe, or the planner would "win" these tests with the wrong index.
    await em.execute(
      `insert into products (name, slug, organization_id, status, price, sku, stock_quantity, created_at, updated_at)
       select 'Producto '||i, 'plan-producto-'||i, ?::uuid, 'PUBLISHED', 10, 'SKU-'||i, 0, now(), now()
         from generate_series(1, 5000) i`,
      [ORG],
    );
    await em.execute(
      `insert into product_images (product_id, url, is_primary, display_mode, sort_order, archived_at, created_at)
       select id, 'https://cdn.test/'||slug||'.png', true, 'CONTAIN', 0, case when random() < 0.2 then now() end, now()
         from products where organization_id = ?::uuid`,
      [ORG],
    );
    await em.execute(
      `insert into sales_orders (store_id, organization_id, order_number, status, total_usd, created_at, updated_at)
       select ?::uuid, ?::uuid, 'PLAN-'||i, case when i % 3 = 0 then 'NEW' else 'CONFIRMED' end, 10, now() - (i || ' minutes')::interval, now()
         from generate_series(1, 500) i`,
      [STORE, ORG],
    );
    // The seed ran AFTER the migration built the GIN indexes, so every row
    // sits in their pending lists — which the cost estimator prices so high
    // the planner shuns the index it would happily use in production, where
    // autovacuum keeps the lists flushed. Flush explicitly, then gather stats.
    await em.execute(`select gin_clean_pending_list('products_name_trgm_index'::regclass)`);
    await em.execute(`select gin_clean_pending_list('products_sku_trgm_index'::regclass)`);
    await em.execute(`analyze products, product_images, sales_orders`);
  });

  afterAll(async () => {
    await pg.close();
  });

  it('the migration created its exact objects: extension and four indexes', async () => {
    const [ext]: { n: number }[] = await em.execute(
      `select count(*)::int as n from pg_extension where extname = 'pg_trgm'`,
    );
    expect(ext.n).toBe(1);
    const indexes: { indexname: string }[] = await em.execute(
      `select indexname from pg_indexes where indexname in (
         'sales_orders_organization_id_status_created_at_index',
         'product_images_product_id_active_index',
         'products_name_trgm_index',
         'products_sku_trgm_index') order by indexname`,
    );
    expect(indexes.map((row) => row.indexname)).toEqual([
      'product_images_product_id_active_index',
      'products_name_trgm_index',
      'products_sku_trgm_index',
      'sales_orders_organization_id_status_created_at_index',
    ]);
  });

  it('an infix ILIKE on product NAME is served by the trigram index', async () => {
    const plan = await planFor(`select id from products where name ilike ?`, ['%oducto 4%']);
    expect(plan).toContain('products_name_trgm_index');
  });

  it('an infix ILIKE on product SKU is served by the trigram index', async () => {
    // A selective infix — a term shared by every row (like "SKU-") floods the
    // posting lists and rightly sends the planner elsewhere; a real lookup is
    // someone pasting a distinctive fragment of a reference.
    const plan = await planFor(`select id from products where sku ilike ?`, ['%4937%']);
    expect(plan).toContain('products_sku_trgm_index');
  });

  it('active images by product are served by the partial index (the table had NO product_id index)', async () => {
    const plan = await planFor(
      `select id from product_images where product_id = any(select id from products where organization_id = ?::uuid limit 25) and archived_at is null`,
      [ORG],
    );
    expect(plan).toContain('product_images_product_id_active_index');
  });

  it("the panel's order listing (tenant + status, newest first) is served by the composite, including its sort", async () => {
    const plan = await planFor(
      `select id from sales_orders where organization_id = ?::uuid and status = 'NEW' order by created_at desc limit 25`,
      [ORG],
    );
    expect(plan).toContain('sales_orders_organization_id_status_created_at_index');
    // the composite's column order makes the ORDER BY free — no separate Sort
    expect(plan).not.toContain('"Node Type": "Sort"');
  });

  it('down() removes the four indexes AND the extension; up() restores them', async () => {
    await pg.orm.getMigrator().down({ to: 'Migration20260825100000' });
    const [gone]: { n: number }[] = await em.execute(
      `select count(*)::int as n from pg_indexes where indexname like 'products_%_trgm_index'
         or indexname in ('product_images_product_id_active_index', 'sales_orders_organization_id_status_created_at_index')`,
    );
    expect(gone.n).toBe(0);
    const [ext]: { n: number }[] = await em.execute(
      `select count(*)::int as n from pg_extension where extname = 'pg_trgm'`,
    );
    expect(ext.n).toBe(0);

    await pg.orm.getMigrator().up();
    const [restored]: { n: number }[] = await em.execute(
      `select count(*)::int as n from pg_indexes where indexname in (
         'sales_orders_organization_id_status_created_at_index',
         'product_images_product_id_active_index',
         'products_name_trgm_index',
         'products_sku_trgm_index')`,
    );
    expect(restored.n).toBe(4);
  });
});
