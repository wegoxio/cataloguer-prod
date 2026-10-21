import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../test/pg-harness';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const PREV_MIGRATION = 'Migration20260805210000'; // the Phase 3 head (69)
const THIS_MIGRATION = 'Migration20260806120000';

/**
 * The Phase 4 migration against real PostgreSQL.
 *
 * Two things only a database proves: that the preflights REFUSE a database
 * already holding a violation instead of failing halfway through a constraint,
 * and that the migration is genuinely reversible — unlike Phases 2 and 3,
 * every change here is additive, so `down()` restores the previous shape
 * exactly. Production still rolls forward; this exists so the round-trip is
 * verified somewhere.
 */
d('Phase 4 category presentation migration (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  const org = async (em: EntityManager, name: string, slug: string): Promise<string> => {
    const [row] = await em
      .getConnection()
      .execute(
        `insert into organizations (name, slug, created_at, updated_at) values (?, ?, now(), now()) returning id`,
        [name, slug],
      );
    return row.id;
  };

  const legacyCategory = async (em: EntityManager, organizationId: string, slug: string, parentId?: string) => {
    const [row] = await em.getConnection().execute(
      `insert into categories (organization_id, parent_category_id, name, slug, created_at, updated_at)
       values (?, ?, ?, ?, now(), now()) returning id`,
      [organizationId, parentId ?? null, slug, slug],
    );
    return row.id as string;
  };

  const legacyProduct = async (em: EntityManager, organizationId: string, slug: string) => {
    const [row] = await em.getConnection().execute(
      `insert into products (organization_id, name, slug, status, price, stock_quantity, track_inventory, created_at, updated_at)
       values (?, ?, ?, 'PUBLISHED', 10, 0, false, now(), now()) returning id`,
      [organizationId, slug, slug],
    );
    return row.id as string;
  };

  describe('preflights refuse a database that already holds a violation', () => {
    it('refuses a cross-company product-category link', async () => {
      const pg = await withDisposablePg({ migrateTo: PREV_MIGRATION });
      try {
        const em = pg.orm.em.fork();
        const acme = await org(em, 'Acme', 'acme-x1');
        const rival = await org(em, 'Rival', 'rival-x1');
        const p = await legacyProduct(em, acme, 'p-x1');
        const c = await legacyCategory(em, rival, 'c-x1');
        await em
          .getConnection()
          .execute(`insert into product_categories (product_id, category_id) values (?, ?)`, [p, c]);

        await expect(pg.orm.getMigrator().up()).rejects.toThrow(/P4_REFUSE_CROSS_ORG_MEMBERSHIP/);
        const [applied] = await em
          .getConnection()
          .execute(`select count(*)::int as n from mikro_orm_migrations where name = ?`, [THIS_MIGRATION]);
        expect(applied.n).toBe(0);
      } finally {
        await pg.close();
      }
    });

    it('refuses a cross-company parent', async () => {
      const pg = await withDisposablePg({ migrateTo: PREV_MIGRATION });
      try {
        const em = pg.orm.em.fork();
        const acme = await org(em, 'Acme', 'acme-x2');
        const rival = await org(em, 'Rival', 'rival-x2');
        const foreign = await legacyCategory(em, rival, 'rival-root-x2');
        await legacyCategory(em, acme, 'acme-child-x2', foreign);

        await expect(pg.orm.getMigrator().up()).rejects.toThrow(/P4_REFUSE_CROSS_ORG_PARENT/);
      } finally {
        await pg.close();
      }
    });

    it('refuses a self-parenting row', async () => {
      const pg = await withDisposablePg({ migrateTo: PREV_MIGRATION });
      try {
        const em = pg.orm.em.fork();
        const acme = await org(em, 'Acme', 'acme-x3');
        const c = await legacyCategory(em, acme, 'c-x3');
        await em.getConnection().execute(`update categories set parent_category_id = id where id = ?`, [c]);

        await expect(pg.orm.getMigrator().up()).rejects.toThrow(/P4_REFUSE_SELF_PARENT/);
      } finally {
        await pg.close();
      }
    });

    it('refuses a deeper cycle, distinctly from a merely deep chain', async () => {
      const pg = await withDisposablePg({ migrateTo: PREV_MIGRATION });
      try {
        const em = pg.orm.em.fork();
        const acme = await org(em, 'Acme', 'acme-x4');
        const a = await legacyCategory(em, acme, 'a-x4');
        const b = await legacyCategory(em, acme, 'b-x4', a);
        const c = await legacyCategory(em, acme, 'c-x4', b);
        // Close the loop: a -> b -> c -> a. Not self-parenting, so only the
        // recursive walk can see it.
        await em.getConnection().execute(`update categories set parent_category_id = ? where id = ?`, [c, a]);

        await expect(pg.orm.getMigrator().up()).rejects.toThrow(/P4_REFUSE_HIERARCHY_CYCLE/);
      } finally {
        await pg.close();
      }
    });

    it('refuses a valid chain deeper than the runtime can read', async () => {
      const pg = await withDisposablePg({ migrateTo: PREV_MIGRATION });
      try {
        const em = pg.orm.em.fork();
        const acme = await org(em, 'Acme', 'acme-x5');
        let parent: string | undefined;
        // 70 levels: no cycle, but past the supported depth of 64. Letting this
        // through would leave a tree the resolver silently truncates.
        for (let i = 0; i < 70; i++) parent = await legacyCategory(em, acme, `deep-${i}-x5`, parent);

        await expect(pg.orm.getMigrator().up()).rejects.toThrow(/P4_REFUSE_HIERARCHY_DEPTH/);
      } finally {
        await pg.close();
      }
    });
  });

  describe('a clean database migrates, preserves every row, and reverses', () => {
    let pg: DisposablePg;
    let em: EntityManager;

    beforeAll(async () => {
      pg = await withDisposablePg({ migrateTo: PREV_MIGRATION });
      em = pg.orm.em.fork();
    });

    afterAll(async () => {
      if (pg) await pg.close();
    });

    it('applies, backfills membership tenancy exactly, and changes no row count', async () => {
      const conn = em.getConnection();
      const acme = await org(em, 'Acme', 'acme-clean');
      const root = await legacyCategory(em, acme, 'root-clean');
      const child = await legacyCategory(em, acme, 'child-clean', root);
      const p = await legacyProduct(em, acme, 'p-clean');
      await conn.execute(`insert into product_categories (product_id, category_id) values (?, ?)`, [p, child]);

      const [before] = await conn.execute(
        `select (select count(*) from categories) as c,
                (select count(*) from products) as p,
                (select count(*) from product_categories) as pc`,
      );

      // Pinned to THIS migration: the chain has grown past it (migration 71
      // removes the trigger this block asserts), and a bare up() would test
      // the head's shape rather than migration 70's own post-state — and the
      // bare down() below would then revert 71, not 70.
      await pg.orm.getMigrator().up({ to: THIS_MIGRATION });

      const [after] = await conn.execute(
        `select (select count(*) from categories) as c,
                (select count(*) from products) as p,
                (select count(*) from product_categories) as pc`,
      );
      expect(after).toEqual(before);

      // Backfill exactness: every pivot row carries its product's company.
      const [drift] = await conn.execute(
        `select count(*)::int as n from product_categories pc
         join products pr on pr.id = pc.product_id
         where pc.organization_id is distinct from pr.organization_id`,
      );
      expect(drift.n).toBe(0);

      const [nulls] = await conn.execute(
        `select count(*)::int as n from product_categories where organization_id is null`,
      );
      expect(nulls.n).toBe(0);
    });

    it('gives every existing category the documented presentation defaults', async () => {
      const [row] = await em
        .getConnection()
        .execute(
          `select count(*)::int as n from categories where sort_order = 0 and show_in_navigation = true and kind is null and public_label is null and image_asset_id is null`,
        );
      const [total] = await em.getConnection().execute(`select count(*)::int as n from categories`);
      // Nothing was invented: every pre-existing row is unordered, navigable
      // and unclassified, which is exactly what it was before the columns.
      expect(row.n).toBe(total.n);
    });

    it('installs every constraint and index the model depends on', async () => {
      const conn = em.getConnection();
      const names = (
        await conn.execute(
          `select conname from pg_constraint where conrelid::regclass::text in ('categories','product_categories')`,
        )
      ).map((r: any) => r.conname);

      for (const expected of [
        'categories_id_organization_id_unique',
        'categories_kind_check',
        'categories_sort_order_check',
        'categories_public_label_not_blank_check',
        'categories_no_self_parent_check',
        'categories_parent_tenant_foreign',
        'categories_store_tenant_foreign',
        'categories_image_tenant_foreign',
        'product_categories_product_tenant_foreign',
        'product_categories_category_tenant_foreign',
      ]) {
        expect(names).toContain(expected);
      }

      const triggers = (
        await conn.execute(`select tgname from pg_trigger where tgrelid = 'categories'::regclass and not tgisinternal`)
      ).map((r: any) => r.tgname);
      expect(triggers).toContain('categories_scope_compatible_trigger');

      const indexes = (
        await conn.execute(`select indexname from pg_indexes where schemaname = 'public' and tablename = 'categories'`)
      ).map((r: any) => r.indexname);
      expect(indexes).toContain('categories_parent_sort_index');
    });

    it('refuses an invalid kind and a negative sortOrder at the database', async () => {
      const conn = em.getConnection();
      const [row] = await conn.execute(`select id, organization_id from categories limit 1`);
      await expect(conn.execute(`update categories set kind = 'SUPPLIER' where id = ?`, [row.id])).rejects.toThrow(
        /categories_kind_check/,
      );
      await expect(conn.execute(`update categories set sort_order = -1 where id = ?`, [row.id])).rejects.toThrow(
        /categories_sort_order_check/,
      );
      await expect(conn.execute(`update categories set public_label = '   ' where id = ?`, [row.id])).rejects.toThrow(
        /categories_public_label_not_blank_check/,
      );
    });

    it('reverses cleanly back to the Phase 3 shape', async () => {
      const conn = em.getConnection();
      await pg.orm.getMigrator().down();

      const columns = (
        await conn.execute(
          `select column_name from information_schema.columns where table_schema='public' and table_name='categories'`,
        )
      ).map((r: any) => r.column_name);
      for (const gone of ['kind', 'public_label', 'sort_order', 'show_in_navigation', 'image_asset_id']) {
        expect(columns).not.toContain(gone);
      }

      const pivotColumns = (
        await conn.execute(
          `select column_name from information_schema.columns where table_schema='public' and table_name='product_categories'`,
        )
      ).map((r: any) => r.column_name);
      expect(pivotColumns).not.toContain('organization_id');

      const triggers = (
        await conn.execute(`select tgname from pg_trigger where tgrelid = 'categories'::regclass and not tgisinternal`)
      ).map((r: any) => r.tgname);
      expect(triggers).not.toContain('categories_scope_compatible_trigger');

      // The membership rows themselves survive the round trip.
      const [pc] = await conn.execute(`select count(*)::int as n from product_categories`);
      expect(pc.n).toBeGreaterThan(0);
    });
  });
});
