import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../test/pg-harness';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const THIS_MIGRATION = 'Migration20260810120000';

/**
 * Migration 72 (real PostgreSQL): the membership pivot fills its tenant
 * column at INSERT.
 *
 * The defect it repairs: the ORM writes only (category_id, product_id) into
 * `product_categories`, and migration 70's NOT NULL organization_id made
 * every API category assignment die. The trigger derives the organization
 * from the product; the composite foreign keys REMAIN the authority that
 * refuses cross-organization links — these tests hold both halves.
 */
d('Migration 72 membership organization fill (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;

  const conn = () => em.getConnection();

  const org = async (name: string, slug: string): Promise<string> => {
    const [row] = await conn().execute(
      `insert into organizations (name, slug, created_at, updated_at) values (?, ?, now(), now()) returning id`,
      [name, slug],
    );
    return row.id;
  };
  const category = async (organizationId: string, slug: string): Promise<string> => {
    const [row] = await conn().execute(
      `insert into categories (organization_id, name, slug, sort_order, show_in_navigation, created_at, updated_at)
       values (?, ?, ?, 0, true, now(), now()) returning id`,
      [organizationId, slug, slug],
    );
    return row.id;
  };
  const product = async (organizationId: string, slug: string): Promise<string> => {
    const [row] = await conn().execute(
      `insert into products (organization_id, name, slug, status, price, stock_quantity, track_inventory, created_at, updated_at)
       values (?, ?, ?, 'PUBLISHED', 10, 0, false, now(), now()) returning id`,
      [organizationId, slug, slug],
    );
    return row.id;
  };

  let orgA: string;
  let orgB: string;
  let prodA: string;
  let catA: string;
  let catB: string;

  beforeAll(async () => {
    pg = await withDisposablePg();
    em = pg.orm.em.fork();
    orgA = await org('Fill-A', 'fill-a');
    orgB = await org('Fill-B', 'fill-b');
    prodA = await product(orgA, 'fill-a-product');
    catA = await category(orgA, 'fill-a-cat');
    catB = await category(orgB, 'fill-b-cat');
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  it('an ORM-shaped two-column insert receives the product organization automatically', async () => {
    await conn().execute(`insert into product_categories (product_id, category_id) values (?, ?)`, [prodA, catA]);
    const [row] = await conn().execute(
      `select organization_id from product_categories where product_id = ? and category_id = ?`,
      [prodA, catA],
    );
    expect(row.organization_id).toBe(orgA);
  });

  it('a same-organization membership succeeds (and is idempotent to re-check)', async () => {
    const [n] = await conn().execute(`select count(*)::int as c from product_categories where product_id = ?`, [prodA]);
    expect(n.c).toBe(1);
  });

  it('a cross-organization category STILL fails — the composite FK is the authority', async () => {
    await expect(
      conn().execute(`insert into product_categories (product_id, category_id) values (?, ?)`, [prodA, catB]),
    ).rejects.toThrow(/product_categories_category_tenant_foreign|violates foreign key/i);
  });

  it('an explicitly incorrect organization STILL fails — the trigger never overrides a given value', async () => {
    // A FRESH pair: (prodA, catA) already exists, and the primary key would
    // fire before the tenant FK, proving nothing.
    const prodX = await product(orgA, 'fill-a-product-x');
    await expect(
      conn().execute(`insert into product_categories (product_id, category_id, organization_id) values (?, ?, ?)`, [
        prodX,
        catA,
        orgB,
      ]),
    ).rejects.toThrow(/tenant_foreign|violates foreign key/i);
  });

  it('a missing product cannot create a membership', async () => {
    await expect(
      conn().execute(`insert into product_categories (product_id, category_id) values (?, ?)`, [
        '00000000-0000-4000-8000-000000000000',
        catA,
      ]),
    ).rejects.toThrow(/not-null|violates foreign key|tenant_foreign/i);
  });

  it('rollback removes the trigger and function cleanly, and re-applying restores the fill', async () => {
    await pg.orm.getMigrator().down(THIS_MIGRATION);
    const [trg] = await conn().execute(
      `select count(*)::int as n from pg_trigger where tgname = 'product_categories_fill_organization_trigger'`,
    );
    expect(trg.n).toBe(0);
    const [fn] = await conn().execute(
      `select count(*)::int as n from pg_proc where proname = 'product_categories_fill_organization'`,
    );
    expect(fn.n).toBe(0);
    // Without the trigger the old defect reappears — proving the trigger is
    // what carries the repair.
    const prod2 = await product(orgA, 'fill-a-product-2');
    await expect(
      conn().execute(`insert into product_categories (product_id, category_id) values (?, ?)`, [prod2, catA]),
    ).rejects.toThrow(/not-null/i);
    await pg.orm.getMigrator().up({ to: THIS_MIGRATION });
    await conn().execute(`insert into product_categories (product_id, category_id) values (?, ?)`, [prod2, catA]);
    const [row] = await conn().execute(`select organization_id from product_categories where product_id = ?`, [prod2]);
    expect(row.organization_id).toBe(orgA);
  });
});
