import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../test/pg-harness';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * Category tenancy against real PostgreSQL (Phase 4).
 *
 * Before this migration a category's tenancy was enforced only by service
 * code: `product_categories` was a bare (product_id, category_id) pivot, and
 * parent/store were plain single-column foreign keys. Nothing stopped a
 * product of one company being filed under another company's category, or a
 * category being parented into a different company. (Migration 70 also added
 * BRANCH-level rules; migration 71 removed them again once the shared-warehouse
 * model was confirmed — the cross-branch block below pins that removal.)
 *
 * Every guarantee here is one only the database can make, so every test writes
 * raw SQL and expects the database itself to refuse.
 */
d('Phase 4 category tenancy (real PostgreSQL)', () => {
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

  const store = async (organizationId: string, slug: string): Promise<string> => {
    const [row] = await conn().execute(
      `insert into stores (organization_id, name, slug, created_at, updated_at)
       values (?, ?, ?, now(), now()) returning id`,
      [organizationId, slug, slug],
    );
    return row.id;
  };

  const category = async (
    organizationId: string,
    slug: string,
    opts: { storeId?: string | null; parentId?: string | null; imageAssetId?: string | null } = {},
  ): Promise<string> => {
    const [row] = await conn().execute(
      `insert into categories
         (organization_id, store_id, parent_category_id, image_asset_id, name, slug, sort_order, show_in_navigation, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, 0, true, now(), now()) returning id`,
      [organizationId, opts.storeId ?? null, opts.parentId ?? null, opts.imageAssetId ?? null, slug, slug],
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

  const asset = async (organizationId: string | null, storeId: string | null, type = 'IMAGE'): Promise<string> => {
    const [row] = await conn().execute(
      `insert into store_assets (organization_id, store_id, name, type, url, created_at)
       values (?, ?, 'pic', ?, 'https://cdn.example.com/assets/x.png', now()) returning id`,
      [organizationId, storeId, type],
    );
    return row.id;
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork();
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  describe('cross-ORGANIZATION links are impossible', () => {
    it('refuses a parent belonging to another company', async () => {
      const acme = await org('Acme', 'acme-parent');
      const rival = await org('Rival', 'rival-parent');
      const foreignParent = await category(rival, 'rival-root');

      await expect(category(acme, 'acme-child', { parentId: foreignParent })).rejects.toThrow(
        /categories_parent_tenant_foreign|violates foreign key/i,
      );
    });

    it('refuses a store belonging to another company', async () => {
      const acme = await org('Acme', 'acme-store');
      const rival = await org('Rival', 'rival-store');
      const foreignStore = await store(rival, 'rival-branch');

      await expect(category(acme, 'acme-cat', { storeId: foreignStore })).rejects.toThrow(
        /categories_store_tenant_foreign|violates foreign key/i,
      );
    });

    it('refuses an image asset belonging to another company', async () => {
      const acme = await org('Acme', 'acme-img');
      const rival = await org('Rival', 'rival-img');
      const foreignAsset = await asset(rival, null);

      await expect(category(acme, 'acme-img-cat', { imageAssetId: foreignAsset })).rejects.toThrow(
        /categories_image_tenant_foreign|violates foreign key/i,
      );
    });

    it('refuses a product-category link that spans two companies', async () => {
      const acme = await org('Acme', 'acme-pivot');
      const rival = await org('Rival', 'rival-pivot');
      const acmeProduct = await product(acme, 'acme-product');
      const rivalCategory = await category(rival, 'rival-cat');

      // NEGATIVE CONTROL: the pivot's own organization column is what the two
      // composite keys disagree about, so whichever value is written, one of
      // them must refuse. Before Phase 4 this insert simply succeeded.
      await expect(
        conn().execute(`insert into product_categories (product_id, category_id, organization_id) values (?, ?, ?)`, [
          acmeProduct,
          rivalCategory,
          acme,
        ]),
      ).rejects.toThrow(/product_categories_category_tenant_foreign|violates foreign key/i);

      await expect(
        conn().execute(`insert into product_categories (product_id, category_id, organization_id) values (?, ?, ?)`, [
          acmeProduct,
          rivalCategory,
          rival,
        ]),
      ).rejects.toThrow(/product_categories_product_tenant_foreign|violates foreign key/i);
    });

    it('accepts the same-company link, so the constraint is not simply refusing everything', async () => {
      const acme = await org('Acme', 'acme-ok');
      const p = await product(acme, 'acme-ok-product');
      const c = await category(acme, 'acme-ok-cat');
      await conn().execute(
        `insert into product_categories (product_id, category_id, organization_id) values (?, ?, ?)`,
        [p, c, acme],
      );
      const [row] = await conn().execute(`select count(*)::int as n from product_categories where product_id = ?`, [p]);
      expect(row.n).toBe(1);
    });
  });

  // MIGRATION 71 (Phase 4 correction): the catalogue is organization-wide, so
  // the branch rules migration 70's trigger enforced are GONE — every store of
  // a company shares one warehouse, and cross-branch parentage and imagery are
  // legal by design. These tests pin both directions: the six accept cases
  // prove the trigger is absent, and the companion cross-COMPANY tests above
  // prove its removal did not widen the organization boundary, which was
  // always carried by the composite foreign keys, never by the trigger.
  describe('cross-BRANCH links are LEGAL inside one company (migration 71)', () => {
    it('accepts a parent from a sibling branch', async () => {
      const acme = await org('Acme', 'acme-branch');
      const branchA = await store(acme, 'branch-a');
      const branchB = await store(acme, 'branch-b');
      const parentInB = await category(acme, 'b-root', { storeId: branchB });

      const child = await category(acme, 'a-child', { storeId: branchA, parentId: parentInB });
      expect(child).toBeTruthy();
    });

    it('accepts an organization-global category under a branch parent', async () => {
      const acme = await org('Acme', 'acme-global');
      const branch = await store(acme, 'the-branch');
      const branchParent = await category(acme, 'branch-root', { storeId: branch });

      const child = await category(acme, 'global-child', { storeId: null, parentId: branchParent });
      expect(child).toBeTruthy();
    });

    it('accepts an organization-global parent for a branch child', async () => {
      const acme = await org('Acme', 'acme-accepts');
      const branch = await store(acme, 'accepting-branch');
      const globalParent = await category(acme, 'global-root', { storeId: null });
      const child = await category(acme, 'branch-child', { storeId: branch, parentId: globalParent });
      expect(child).toBeTruthy();
    });

    it('accepts a same-branch parent', async () => {
      const acme = await org('Acme', 'acme-same');
      const branch = await store(acme, 'same-branch');
      const parent = await category(acme, 'same-root', { storeId: branch });
      const child = await category(acme, 'same-child', { storeId: branch, parentId: parent });
      expect(child).toBeTruthy();
    });

    it("accepts another branch's image asset", async () => {
      const acme = await org('Acme', 'acme-imgbranch');
      const branchA = await store(acme, 'img-branch-a');
      const branchB = await store(acme, 'img-branch-b');
      const assetInB = await asset(acme, branchB);

      const c = await category(acme, 'img-a', { storeId: branchA, imageAssetId: assetInB });
      expect(c).toBeTruthy();
    });

    it('accepts an organization-global asset for a branch category', async () => {
      const acme = await org('Acme', 'acme-globalimg');
      const branch = await store(acme, 'globalimg-branch');
      const globalAsset = await asset(acme, null);
      const c = await category(acme, 'globalimg-cat', { storeId: branch, imageAssetId: globalAsset });
      expect(c).toBeTruthy();
    });

    it('the trigger and its function are genuinely absent, not merely quiet', async () => {
      const [trg] = await conn().execute(
        `select count(*)::int as n from pg_trigger where tgname = 'categories_scope_compatible_trigger'`,
      );
      expect(trg.n).toBe(0);
      const [fn] = await conn().execute(
        `select count(*)::int as n from pg_proc where proname = 'categories_scope_compatible'`,
      );
      expect(fn.n).toBe(0);
    });
  });

  describe('hierarchy integrity', () => {
    it('refuses a category that is its own parent', async () => {
      const acme = await org('Acme', 'acme-self');
      const c = await category(acme, 'self-cat');
      await expect(conn().execute(`update categories set parent_category_id = id where id = ?`, [c])).rejects.toThrow(
        /categories_no_self_parent_check/,
      );
    });
  });

  describe('deleting a referenced row nulls ONLY the referencing column', () => {
    it('deleting a parent clears parent_category_id and leaves organization_id intact', async () => {
      const acme = await org('Acme', 'acme-delparent');
      const parent = await category(acme, 'del-parent');
      const child = await category(acme, 'del-child', { parentId: parent });

      // A plain composite ON DELETE SET NULL would try to null organization_id
      // too — which is NOT NULL — and the delete would simply fail.
      await conn().execute(`delete from categories where id = ?`, [parent]);

      const [row] = await conn().execute(`select parent_category_id, organization_id from categories where id = ?`, [
        child,
      ]);
      expect(row.parent_category_id).toBeNull();
      expect(row.organization_id).toBe(acme);
    });

    it('deleting a store clears store_id and leaves organization_id intact', async () => {
      const acme = await org('Acme', 'acme-delstore');
      const branch = await store(acme, 'doomed-branch');
      const c = await category(acme, 'orphaned-cat', { storeId: branch });

      await conn().execute(`delete from stores where id = ?`, [branch]);

      const [row] = await conn().execute(`select store_id, organization_id from categories where id = ?`, [c]);
      expect(row.store_id).toBeNull();
      expect(row.organization_id).toBe(acme);
    });

    it('refuses to delete an asset a category still displays', async () => {
      const acme = await org('Acme', 'acme-delasset');
      const a = await asset(acme, null);
      await category(acme, 'illustrated', { imageAssetId: a });

      await expect(conn().execute(`delete from store_assets where id = ?`, [a])).rejects.toThrow(
        /categories_image_tenant_foreign|violates foreign key/i,
      );
    });
  });
});
