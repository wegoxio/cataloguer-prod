import { ForbiddenException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { Organization } from '../../../organizations/entities/organization.entity';
import { Store } from '../../../stores/entities/store.entity';
import { Product } from '../../entities/product.entity';
import { ProductStatus } from '../../catalogue/product-status.enum';
import { ProductsService } from '../../catalogue/products.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { realStock } from '../../../../../test/inventory-stock-support';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * The `Product.stores` m:n rides a CUSTOM pivot entity (StoreProduct), and
 * MikroORM's inferred join columns silently picked the WRONG pivot column
 * (products.id = store_products.organization_id): every `{stores: X}` filter
 * and every `stores` hydration matched nothing, so store-bound admins saw an
 * empty catalog while the rows provably existed. The mapping now pins
 * joinColumn/inverseJoinColumn explicitly; this spec holds the ORM to the
 * database's own answer so the inference can never regress silently:
 *
 * - the raw pivot count equals the ORM `{stores: id}` count;
 * - hydration returns the REAL store, never an organization-id join;
 * - a store-bound admin-shaped scope sees exactly its store's links;
 * - another tenant sees none of them;
 * - organization-only and unscoped behavior are unchanged.
 */
d('Product.stores pivot mapping (real PostgreSQL)', () => {
  jest.setTimeout(180_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let orgA: string;
  let orgB: string;
  let storeA: string;
  let storeB: string;
  let linkedA1: string;
  let linkedA2: string;
  let unlinkedA: string;
  let linkedB: string;

  const service = () =>
    new ProductsService(
      em.getRepository(Product) as any,
      { find: async () => [], findOne: async () => null } as any, // category repo: unused by findAll
      { findById: async () => undefined } as any,
      { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
      { learnFromAcceptedGroup: async () => undefined } as any,
      new PublicationGuardService(),
      {} as any,
      realStock(em as any),
    );

  beforeAll(async () => {
    pg = await withDisposablePg();
    em = pg.orm.em.fork();
    const org = (name: string, slug: string) => em.create(Organization, { name, slug } as any);
    const a = org('Elite-shaped', 'elite-shaped');
    const b = org('Other-tenant', 'other-tenant');
    em.persist([a, b]);
    await em.flush();
    orgA = a.id;
    orgB = b.id;
    const store = (name: string, slug: string, o: Organization) =>
      em.create(Store, { name, slug, organization: o } as any);
    const sa = store('Elite Store', 'elite-store', a);
    const sb = store('Other Store', 'other-store', b);
    em.persist([sa, sb]);
    await em.flush();
    storeA = sa.id;
    storeB = sb.id;
    const product = (slug: string, o: string) =>
      em.create(Product, {
        name: slug,
        slug,
        organization: o,
        price: 10,
        stockQuantity: 0,
        trackInventory: false,
        status: ProductStatus.PUBLISHED,
      } as any);
    const p1 = product('a-linked-1', orgA);
    const p2 = product('a-linked-2', orgA);
    const p3 = product('a-unlinked', orgA);
    const p4 = product('b-linked', orgB);
    em.persist([p1, p2, p3, p4]);
    await em.flush();
    linkedA1 = p1.id;
    linkedA2 = p2.id;
    unlinkedA = p3.id;
    linkedB = p4.id;
    const conn = em.getConnection();
    for (const [o, s, p] of [
      [orgA, storeA, linkedA1],
      [orgA, storeA, linkedA2],
      [orgB, storeB, linkedB],
    ]) {
      await conn.execute(
        `insert into "store_products"
           ("organization_id","store_id","product_id","published","track_inventory","stock_quantity","created_at","updated_at")
         values (?, ?, ?, true, false, 0, now(), now())`,
        [o, s, p],
      );
    }
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  it('counts through the pivot exactly as raw SQL does', async () => {
    const raw = (
      await em.getConnection().execute(`select count(*)::int as n from "store_products" where store_id = ?`, [storeA])
    )[0].n;
    expect(raw).toBe(2);
    const [, ormCount] = await em.getRepository(Product).findAndCount({ stores: storeA });
    expect(ormCount).toBe(raw);
  });

  it('joins the pivot on product_id, never on organization_id', async () => {
    const sql = em.createQueryBuilder(Product).select('id').where({ stores: storeA }).getFormattedQuery();
    expect(sql).toContain('"product_id"');
    expect(sql).not.toContain('"id" = "s1"."organization_id"');
  });

  it('hydrates the stores collection with the REAL store', async () => {
    const fresh = pg.orm.em.fork();
    const p = await fresh.findOne(Product, { id: linkedA1 }, { populate: ['stores'] as never });
    expect(p).not.toBeNull();
    const ids = p!.stores.getItems().map((s) => s.id);
    expect(ids).toEqual([storeA]);
    const bare = await fresh.findOne(Product, { id: unlinkedA }, { populate: ['stores'] as never });
    expect(bare!.stores.getItems()).toHaveLength(0);
  });

  // Phase 4: `storeFilterId` is an EXPLICIT view filter (which branch
  // publishes this?), no longer a tenant boundary derived from the actor.
  it('an explicit store filter narrows to that branch of the company', async () => {
    const res = await service().findAll({ organizationId: orgA, storeFilterId: storeA });
    expect(res.total).toBe(2);
    expect(res.items.map((p) => p.id).sort()).toEqual([linkedA1, linkedA2].sort());
  });

  it('another tenant cannot see those products through any store filter', async () => {
    const foreignOrg = await service().findAll({ organizationId: orgB, storeFilterId: storeA });
    expect(foreignOrg.total).toBe(0);
    const foreignStore = await service().findAll({ organizationId: orgA, storeFilterId: storeB });
    expect(foreignStore.total).toBe(0);
    const own = await service().findAll({ organizationId: orgA, storeFilterId: storeA });
    expect(own.items.map((p) => p.id)).not.toContain(linkedB);
  });

  it('organization-only lists the whole company; an unscoped list is REFUSED', async () => {
    const orgWide = await service().findAll({ organizationId: orgA });
    expect(orgWide.total).toBe(3); // the unlinked product rides along org-wide
    // Phase 4 (C15): no organization ⇒ refusal, never an unscoped query. The
    // old behavior returned every company's products to a store-less actor.
    await expect(service().findAll({})).rejects.toThrow(ForbiddenException);
  });

  // Migration 72 regression: the ORM's pivot writer inserts only the two id
  // columns, and before the fill trigger every API `create` with categoryIds
  // died on the pivot's NOT NULL organization_id — the 2026-08-10 defect,
  // exercised here through the REAL service create path.
  it('service create with categoryIds persists a tenant-attributed membership (migration 72)', async () => {
    const catRow = await em.getConnection().execute(
      `insert into categories (organization_id, name, slug, sort_order, show_in_navigation, created_at, updated_at)
         values (?, 'pivot-fill-cat', 'pivot-fill-cat', 0, true, now(), now()) returning id`,
      [orgA],
    );
    const catId = catRow[0].id;
    const svc = new ProductsService(
      em.getRepository(Product) as any,
      { find: async () => [], findOne: async () => null } as any,
      {
        // Real lookup, org rule identical to the corrected service's own.
        findAssignableCategory: async (_orgId: string | null, _storeId: string | null, id: string) =>
          em
            .getConnection()
            .execute(`select * from categories where id = ?`, [id])
            .then((r: any[]) => {
              if (!r.length) throw new Error('category not found');
              return { id: r[0].id, archivedAt: r[0].archived_at, organization: r[0].organization_id };
            }),
      } as any,
      { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
      { learnFromAcceptedGroup: async () => undefined } as any,
      new PublicationGuardService(),
      { writeCreationValues: async () => undefined } as any,
      realStock(em as any),
    );
    const created = await svc.create(
      { name: 'pivot-fill-product', price: 1, categoryIds: [catId], storeIds: [storeA] } as any,
      undefined,
    );
    const [pivot] = await em
      .getConnection()
      .execute(`select organization_id from product_categories where product_id = ? and category_id = ?`, [
        created.id,
        catId,
      ]);
    expect(pivot.organization_id).toBe(orgA);
  });
});
