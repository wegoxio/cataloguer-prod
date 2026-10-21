import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const PREV_MIGRATION = 'Migration20260805200000'; // the Phase 2 head (68)
const THIS_MIGRATION = 'Migration20260805210000';

/**
 * Phase 3 against real PostgreSQL: the additive migration from the exact
 * Phase 2 head, the deterministic organization backfill, and every guarantee
 * that only a database can actually prove — cross-tenant links refused by
 * composite foreign keys, self-relations and duplicate edges refused by
 * CHECK and UNIQUE, suppression rows forced into their own shape, and a
 * referenced file refused deletion.
 */
d('Phase 3 documents and relations (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  const orgId = async (em: EntityManager, name: string, slug: string): Promise<string> => {
    const [row] = await em
      .getConnection()
      .execute(
        `insert into organizations (name, slug, created_at, updated_at) values (?, ?, now(), now()) returning id`,
        [name, slug],
      );
    return row.id;
  };

  describe('migration classifier, backfill and reversal', () => {
    let pg: DisposablePg;
    let em: EntityManager;

    beforeAll(async () => {
      pg = await withDisposablePg({ migrateTo: PREV_MIGRATION });
      em = pg.orm.em.fork();
    });

    afterAll(async () => {
      if (pg) await pg.close();
    });

    it('refuses a partial shape, rolls back whole, then applies after repair', async () => {
      await em.getConnection().execute(`alter table "store_assets" add column "organization_id" uuid null`);
      await expect(pg.orm.getMigrator().up({ to: THIS_MIGRATION })).rejects.toThrow(/P3_REFUSE_PARTIAL_SHAPE/);
      const applied = await em
        .getConnection()
        .execute(`select count(*)::int as n from mikro_orm_migrations where name = ?`, [THIS_MIGRATION]);
      expect(applied[0].n).toBe(0);
      await em.getConnection().execute(`alter table "store_assets" drop column "organization_id"`);
    });

    it('backfills each asset with its own store organization, leaving platform assets NULL', async () => {
      const conn = em.getConnection();
      const acme = await orgId(em, 'Acme', 'acme-backfill');
      const [store] = await conn.execute(
        `insert into stores (organization_id, name, slug, created_at, updated_at)
         values (?, 'Main', 'main-backfill', now(), now()) returning id`,
        [acme],
      );
      await conn.execute(
        `insert into store_assets (store_id, name, type, url, created_at)
         values (?, 'sheet', 'FILE', 'https://cdn.example.com/assets/s/1.pdf', now())`,
        [store.id],
      );
      // A platform asset: no store, therefore no company.
      await conn.execute(
        `insert into store_assets (store_id, name, type, url, created_at)
         values (null, 'logo', 'IMAGE', 'https://cdn.example.com/assets/platform/1.png', now())`,
      );

      await pg.orm.getMigrator().up({ to: THIS_MIGRATION });

      const rows: any[] = await conn.execute(`select name, organization_id from store_assets order by name`);
      const byName = new Map(rows.map((row) => [row.name, row.organization_id]));
      expect(byName.get('sheet')).toBe(acme);
      expect(byName.get('logo')).toBeNull();
    });

    it('creates both tables with their composite tenant keys intact', async () => {
      for (const table of ['product_assets', 'product_relations']) {
        const fks = await em.getConnection().execute(
          `select count(*)::int as n from pg_constraint
            where conrelid = 'public.${table}'::regclass and contype = 'f'`,
        );
        // organization + two composite tenant keys.
        expect(fks[0].n).toBe(3);
      }
    });

    it('widens the audit entity-type CHECK for exactly the types Phase 3 writes', async () => {
      const [check] = await em.getConnection().execute(
        `select pg_get_constraintdef(oid) as def from pg_constraint
          where conrelid = 'public.audit_logs'::regclass and conname = 'audit_logs_entity_type_check'`,
      );
      expect(check.def).toContain("'ASSET'");
      expect(check.def).toContain("'PRODUCT_ASSET'");
      // Relations are not audited in Phase 3, so the CHECK must not list them.
      expect(check.def).not.toContain("'PRODUCT_RELATION'");
    });

    it('down() reverses cleanly while unused, and refuses once a link exists', async () => {
      const conn = em.getConnection();
      const acme = await orgId(em, 'Acme Down', 'acme-down');
      const [store] = await conn.execute(
        `insert into stores (organization_id, name, slug, created_at, updated_at)
         values (?, 'Down', 'down-store', now(), now()) returning id`,
        [acme],
      );
      const [product] = await conn.execute(
        `insert into products (organization_id, name, slug, price, stock_quantity, track_inventory, status, created_at, updated_at)
         values (?, 'Silla', 'silla-down', 10, 0, false, 'PUBLISHED', now(), now()) returning id`,
        [acme],
      );
      // Backfill-consistent: the asset's company IS its store's company, so
      // dropping the column would lose nothing that cannot be recomputed.
      const [asset] = await conn.execute(
        `insert into store_assets (store_id, organization_id, name, type, url, created_at)
         values (?, ?, 'w', 'FILE', 'https://cdn.example.com/assets/x/w.pdf', now()) returning id`,
        [store.id, acme],
      );
      await conn.execute(
        `insert into product_assets (organization_id, product_id, asset_id, kind, created_at, updated_at)
         values (?, ?, ?, 'WARRANTY', now(), now())`,
        [acme, product.id, asset.id],
      );

      await expect(pg.orm.getMigrator().down()).rejects.toThrow(/P3_IRREVERSIBLE/);

      await conn.execute(`delete from product_assets`);
      await pg.orm.getMigrator().down();
      const gone = await conn.execute(`select to_regclass('public.product_assets')::text as t`);
      expect(gone[0].t).toBeNull();
      // Forward again so the suites below see the Phase 3 shape.
      await pg.orm.getMigrator().up({ to: THIS_MIGRATION });
    });

    it('down() also refuses while a store-less asset carries a company of its own', async () => {
      // The new contract lets a company-wide actor register an asset with no
      // store at all. The backfill could never have produced that row, so
      // dropping the column would silently destroy the only record of who
      // owns the file — the migration refuses instead of pretending.
      const conn = em.getConnection();
      const acme = await orgId(em, 'Acme Storeless', 'acme-storeless');
      const [asset] = await conn.execute(
        `insert into store_assets (store_id, organization_id, name, type, url, created_at)
         values (null, ?, 'orphan', 'FILE', 'https://cdn.example.com/assets/y/o.pdf', now()) returning id`,
        [acme],
      );
      await expect(pg.orm.getMigrator().down()).rejects.toThrow(/P3_IRREVERSIBLE/);
      await conn.execute(`delete from store_assets where id = ?`, [asset.id]);
    });
  });

  describe('database-enforced guarantees', () => {
    let pg: DisposablePg;
    let em: EntityManager;
    let acme: string;
    let other: string;
    let parentId: string;
    let childId: string;
    let assetId: string;
    let foreignAssetId: string;

    beforeAll(async () => {
      pg = await withDisposablePg();
      em = pg.orm.em.fork();
      const conn = em.getConnection();
      acme = await orgId(em, 'Acme', 'acme-guard');
      other = await orgId(em, 'Other', 'other-guard');
      const mkProduct = async (organization: string, slug: string, parent: string | null) => {
        const [row] = await conn.execute(
          `insert into products (organization_id, name, slug, price, stock_quantity, track_inventory, status, parent_id, created_at, updated_at)
           values (?, ?, ?, 10, 0, false, 'PUBLISHED', ?, now(), now()) returning id`,
          [organization, slug, slug, parent],
        );
        return row.id as string;
      };
      parentId = await mkProduct(acme, 'model', null);
      childId = await mkProduct(acme, 'version', parentId);
      const [asset] = await conn.execute(
        `insert into store_assets (organization_id, name, type, url, created_at)
         values (?, 'warranty', 'FILE', 'https://cdn.example.com/assets/a/w.pdf', now()) returning id`,
        [acme],
      );
      assetId = asset.id;
      const [foreign] = await conn.execute(
        `insert into store_assets (organization_id, name, type, url, created_at)
         values (?, 'foreign', 'FILE', 'https://cdn.example.com/assets/b/f.pdf', now()) returning id`,
        [other],
      );
      foreignAssetId = foreign.id;
    });

    afterAll(async () => {
      if (pg) await pg.close();
    });

    const attach = (organization: string, product: string, asset: string, kind = 'WARRANTY') =>
      em.getConnection().execute(
        `insert into product_assets (organization_id, product_id, asset_id, kind, created_at, updated_at)
         values (?, ?, ?, ?, now(), now())`,
        [organization, product, asset, kind],
      );

    it("refuses a link to another company's file — the composite key, not the service", async () => {
      // The row claims Acme's organization while pointing at Other's file:
      // no application code is involved in this refusal.
      await expect(attach(acme, parentId, foreignAssetId)).rejects.toThrow(/product_assets_asset_tenant_foreign/);
    });

    it("refuses a link claiming another company's product", async () => {
      await expect(attach(other, parentId, foreignAssetId)).rejects.toThrow(/product_assets_product_tenant_foreign/);
    });

    it('refuses a second link for the same product and file', async () => {
      await attach(acme, parentId, assetId);
      await expect(attach(acme, parentId, assetId, 'CERTIFICATE')).rejects.toThrow(
        /product_assets_product_id_asset_id_unique/,
      );
    });

    it('refuses a kind outside the document vocabulary', async () => {
      await expect(attach(acme, childId, assetId, 'IMAGE')).rejects.toThrow(/product_assets_kind_check/);
    });

    it('forces a suppression row into its own shape', async () => {
      const conn = em.getConnection();
      // A suppression that smuggles a document is refused outright.
      await expect(
        conn.execute(
          `insert into product_assets (organization_id, product_id, asset_id, kind, suppressed, created_at, updated_at)
           values (?, ?, ?, 'WARRANTY', true, now(), now())`,
          [acme, childId, assetId],
        ),
      ).rejects.toThrow(/product_assets_suppression_shape_check/);
      // A suppression that carries nothing is accepted.
      await conn.execute(
        `insert into product_assets (organization_id, product_id, asset_id, kind, suppressed, created_at, updated_at)
         values (?, ?, ?, null, true, now(), now())`,
        [acme, childId, assetId],
      );
      // And an attachment with no kind at all is equally refused.
      await expect(
        conn.execute(
          `insert into product_assets (organization_id, product_id, asset_id, kind, created_at, updated_at)
           values (?, ?, ?, null, now(), now())`,
          [acme, parentId, foreignAssetId],
        ),
      ).rejects.toThrow();
    });

    it('refuses destroying a file products still publish', async () => {
      await expect(em.getConnection().execute(`delete from store_assets where id = ?`, [assetId])).rejects.toThrow(
        /product_assets_asset_tenant_foreign|violates foreign key/,
      );
    });

    it('releases the file once every link is gone', async () => {
      const conn = em.getConnection();
      await conn.execute(`delete from product_assets where asset_id = ?`, [assetId]);
      await conn.execute(`delete from store_assets where id = ?`, [assetId]);
      const [{ n }] = await conn.execute(`select count(*)::int as n from store_assets where id = ?`, [assetId]);
      expect(n).toBe(0);
    });

    const relate = (organization: string, source: string, target: string, type = 'RELATED') =>
      em.getConnection().execute(
        `insert into product_relations (organization_id, source_product_id, target_product_id, type, created_at, updated_at)
         values (?, ?, ?, ?, now(), now())`,
        [organization, source, target, type],
      );

    it('refuses a product suggesting itself', async () => {
      await expect(relate(acme, parentId, parentId)).rejects.toThrow(/product_relations_no_self_check/);
    });

    it('refuses a duplicate edge, which is what makes creation idempotent', async () => {
      await relate(acme, parentId, childId);
      await expect(relate(acme, parentId, childId)).rejects.toThrow(/product_relations_edge_unique/);
    });

    it('allows the mirror edge and a different type as distinct statements', async () => {
      await relate(acme, childId, parentId);
      await relate(acme, parentId, childId, 'ACCESSORY');
      const [{ n }] = await em.getConnection().execute(`select count(*)::int as n from product_relations`);
      expect(n).toBe(3);
    });

    it('refuses an edge across companies', async () => {
      const conn = em.getConnection();
      const [foreignProduct] = await conn.execute(
        `insert into products (organization_id, name, slug, price, stock_quantity, track_inventory, status, created_at, updated_at)
         values (?, 'Foreign', 'foreign-p', 10, 0, false, 'PUBLISHED', now(), now()) returning id`,
        [other],
      );
      await expect(relate(acme, parentId, foreignProduct.id)).rejects.toThrow(
        /product_relations_target_tenant_foreign/,
      );
    });

    it('refuses a relation type outside the vocabulary', async () => {
      await expect(relate(acme, childId, parentId, 'FRIEND_OF')).rejects.toThrow(/product_relations_type_check/);
    });

    it('accepts the Phase 3 audit entity types against the real CHECK', async () => {
      const conn = em.getConnection();
      for (const entityType of ['ASSET', 'PRODUCT_ASSET']) {
        await conn.execute(
          `insert into audit_logs (actor_email, entity_type, entity_id, action, created_at)
           values ('ana@acme.com', ?, ?, 'DELETE', now())`,
          [entityType, parentId],
        );
      }
      await expect(
        conn.execute(
          `insert into audit_logs (actor_email, entity_type, entity_id, action, created_at)
           values ('ana@acme.com', 'PRODUCT_RELATION', ?, 'DELETE', now())`,
          [parentId],
        ),
      ).rejects.toThrow(/audit_logs_entity_type_check/);
    });
  });
});
