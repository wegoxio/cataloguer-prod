import { EntityManager } from '@mikro-orm/postgresql';
import { NotFoundException } from '@nestjs/common';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../test/pg-harness';
import { BulkOperationsService } from '../bulk-operations.service';
import { ProductsService } from '../../products/catalogue/products.service';
import { PublicationGuardService } from '../../products/publication/publication-guard.service';
import { Product } from '../../products/entities/product.entity';
import { Category } from '../../categories/entities/category.entity';
import { publicVisibilityWhere } from '../../public-catalogue/public-catalogue.service';
import { productFamilyLock, AdvisoryLockKey } from '../../products/families/advisory-lock.util';
import { TenantScope } from '../../auth/tenancy/tenant-scope';
import { stockDouble, realStock } from '../../../../test/inventory-stock-support';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const unsigned = (n: number): number => n >>> 0;

/**
 * Bulk website publication (ADR 029) against real PostgreSQL.
 *
 * What only the database can prove:
 *
 *   - the row a publish or hide touches changes in `published` (and
 *     `updated_at`) and in NOTHING else — price, sale price, cost, stock,
 *     tracking, lead time, organization all byte-identical; sibling branches,
 *     the product row and a foreign company's rows untouched;
 *   - the public predicate the storefront uses sees a published child and
 *     stops seeing a card whose last visible child was hidden, while every
 *     `store_products` row still exists;
 *   - a hide that is queued behind a family-shape change decides AFTER it:
 *     the product that became a card while the hide waited is SKIPPED, not
 *     written — the family-root lock is genuinely held for both directions;
 *   - the `branchPublished` list filter names exactly the hidden members of
 *     one website.
 */
d('bulk website publication (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  const POLL_DEADLINE_MS = 20_000;
  const POLL_INTERVAL_MS = 50;

  let pg: DisposablePg;
  let em: EntityManager;
  let service: BulkOperationsService;
  let products: ProductsService;
  const audits: any[] = [];

  let ORG_A: string;
  let ORG_B: string;
  let A1: string;
  let A2: string;
  let B1: string;
  let scopeA: TenantScope;

  const actor = { id: '00000000-0000-4000-8000-00000000000a', email: 'om@alpha.test' };
  const uid = (label: string) => `${label}-${Math.random().toString(16).slice(2, 10)}`;
  const sql = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> =>
    em.fork().getConnection().execute(text, params);

  /** Every branch row of a product, every column that matters, ordered — the invariant surface. */
  const linksOf = async (productId: string) =>
    sql(
      `select store_id, organization_id, published, price, sale_price, cost, stock_quantity, track_inventory, lead_time_days
         from store_products where product_id = ?::uuid order by store_id`,
      [productId],
    );
  const productRow = async (productId: string) =>
    sql(
      `select status, archived_at, price, sale_price, stock_quantity, track_inventory, parent_id from products where id = ?::uuid`,
      [productId],
    );
  const withoutPublished = (rows: any[]) =>
    rows.map((row) => {
      const copy = { ...row };
      delete copy.published;
      return copy;
    });

  /**
   * The branches company A owns. `scopeAllowsStore` holds an organization
   * manager to `allowedStoreIds`, exactly as the guard builds it from the
   * company's stores, so every store created for A is added here and the
   * scope object shares this array.
   */
  const allowedA: string[] = [];
  const store = async (org: string, label: string) => {
    const name = uid(label);
    const [row] = await sql<{ id: string }>(
      `insert into stores (name, slug, organization_id, created_at, updated_at) values (?, ?, ?::uuid, now(), now()) returning id`,
      [name, name, org],
    );
    if (org === ORG_A) allowedA.push(row.id);
    return row.id;
  };
  const product = async (org: string, label: string, over: { status?: string; parent?: string | null } = {}) => {
    const name = uid(label);
    const [row] = await sql<{ id: string }>(
      `insert into products (name, slug, organization_id, status, price, track_inventory, parent_id, created_at, updated_at)
       values (?, ?, ?::uuid, ?, 10, false, ?::uuid, now(), now()) returning id`,
      [name, name, org, over.status ?? 'PUBLISHED', over.parent ?? null],
    );
    return row.id;
  };
  const link = async (
    org: string,
    storeId: string,
    productId: string,
    published: boolean,
    branch: {
      price?: string;
      salePrice?: string;
      cost?: string;
      stock?: number;
      tracked?: boolean;
      lead?: number;
    } = {},
  ) =>
    sql(
      `insert into store_products
         (organization_id, store_id, product_id, published, price, sale_price, cost, stock_quantity, track_inventory, lead_time_days, created_at, updated_at)
       values (?::uuid, ?::uuid, ?::uuid, ?, ?, ?, ?, ?, ?, ?, now(), now())`,
      [
        org,
        storeId,
        productId,
        published,
        branch.price ?? null,
        branch.salePrice ?? null,
        branch.cost ?? null,
        branch.stock ?? 0,
        branch.tracked ?? false,
        branch.lead ?? null,
      ],
    );

  const visibleIn = async (storeId: string): Promise<string[]> => {
    const rows = await em
      .fork()
      .find(Product, publicVisibilityWhere({ organizationId: ORG_A, storeId }), { fields: ['id'] });
    return rows.map((r) => r.id).sort();
  };

  const waitFor = async (predicate: () => Promise<boolean>, what: string): Promise<void> => {
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const waitersOn = async (key: AdvisoryLockKey): Promise<number> => {
    const rows = await sql<{ n: number }>(
      `select count(*)::int as n from pg_locks
        where locktype = 'advisory' and not granted and classid = ? and objid = ? and objsubid = 2`,
      [unsigned(key.ns), unsigned(key.key)],
    );
    return Number(rows[0].n);
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    const guard = new PublicationGuardService();
    const auditLog = {
      recordAuditEntry: async (...args: any[]) => {
        audits.push(args);
      },
      recordAuditEntryIn: async () => undefined as never,
    };
    products = new ProductsService(
      em.getRepository(Product) as any,
      em.getRepository(Category) as any,
      { findAll: async () => [] } as any,
      auditLog as any,
      { learnedWordsFor: async () => [], dismissedSignaturesFor: async () => [] } as any,
      guard,
      { resolveForImport: async () => ({}) } as any,
      realStock(em as any),
    );
    service = new BulkOperationsService(
      em.getRepository(Product) as any,
      em.getRepository(Category) as any,
      products as any,
      auditLog as any,
      guard,
      stockDouble() as any,
    );

    const orgA = uid('alpha');
    const orgB = uid('beta');
    [{ id: ORG_A }] = await sql<{ id: string }>(
      `insert into organizations (name, slug, created_at, updated_at) values (?, ?, now(), now()) returning id`,
      [orgA, orgA],
    );
    [{ id: ORG_B }] = await sql<{ id: string }>(
      `insert into organizations (name, slug, created_at, updated_at) values (?, ?, now(), now()) returning id`,
      [orgB, orgB],
    );
    A1 = await store(ORG_A, 'elite');
    A2 = await store(ORG_A, 'norte');
    B1 = await store(ORG_B, 'foreign');
    scopeA = {
      platform: false,
      organizationId: ORG_A,
      storeId: null,
      allowedStoreIds: allowedA,
      role: 'ORGANIZATION_MANAGER',
    } as TenantScope;
  });

  afterAll(async () => {
    await pg?.close();
  });

  beforeEach(() => {
    audits.length = 0;
  });

  describe('the target website is refused as a whole', () => {
    it('an ARCHIVED website answers not-found before any product is touched', async () => {
      const closed = await store(ORG_A, 'closed');
      const solo = await product(ORG_A, 'solo');
      await link(ORG_A, closed, solo, false);
      await sql(`update stores set archived_at = now() where id = ?::uuid`, [closed]);
      const before = await linksOf(solo);

      await expect(service.bulkBranchPublication(scopeA, [solo], closed, true, actor)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(await linksOf(solo)).toEqual(before);
      expect(audits).toHaveLength(0);
    });

    it('a caller NARROWED to one branch may act there and is refused a sibling with the same not-found', async () => {
      const solo = await product(ORG_A, 'solo');
      await link(ORG_A, A1, solo, false);
      await link(ORG_A, A2, solo, false);
      const narrowedToA1 = { ...scopeA, storeId: A1 } as TenantScope;

      await expect(service.bulkBranchPublication(narrowedToA1, [solo], A2, true, actor)).rejects.toThrow(
        `Store with ID ${A2} not found`,
      );
      expect((await linksOf(solo)).find((l) => l.store_id === A2)?.published).toBe(false);

      const own = await service.bulkBranchPublication(narrowedToA1, [solo], A1, true, actor);
      expect(own.outcomes[0]).toMatchObject({ outcome: 'UPDATED' });
      expect((await linksOf(solo)).find((l) => l.store_id === A1)?.published).toBe(true);
    });
  });

  describe('the family root is the CURRENT parent', () => {
    it.each([
      ['hide', true, false],
      ['publish', false, true],
    ])('%s of a child queues on its PARENT’s family key, not on its own', async (_label, linkPublished, published) => {
      const card = await product(ORG_A, 'card');
      const kid = await product(ORG_A, 'kid', { parent: card });
      await link(ORG_A, A1, card, true);
      await link(ORG_A, A1, kid, linkPublished);
      const parentKey = productFamilyLock(card);

      const blocker = pg.orm.em.fork() as EntityManager;
      await blocker.begin();
      try {
        await blocker.execute('select pg_advisory_xact_lock(?::int4, ?::int4)', [parentKey.ns, parentKey.key]);
        const op = service.bulkBranchPublication(scopeA, [kid], A1, published, actor);
        // Observed waiting on the PARENT's key: the root was derived from the
        // child's current parent, under the lock protocol.
        await waitFor(
          async () => (await waitersOn(parentKey)) >= 1,
          'the child operation to queue on its parent’s family key',
        );
        await blocker.rollback();

        const result = await op;
        expect(result.outcomes[0]).toMatchObject({ id: kid, outcome: 'UPDATED' });
        expect((await linksOf(kid))[0].published).toBe(published);
      } catch (err) {
        await blocker.rollback().catch(() => undefined);
        throw err;
      }
    });
  });

  describe('the one column that changes', () => {
    it('publishing a hidden member flips published and leaves every other branch value, sibling branch, product row and foreign row identical', async () => {
      const solo = await product(ORG_A, 'solo');
      await link(ORG_A, A1, solo, false, { price: '12.50', cost: '7.00', stock: 4, tracked: true, lead: 3 });
      await link(ORG_A, A2, solo, true, { price: '13.00', salePrice: '11.00' });
      const foreign = await product(ORG_B, 'theirs');
      await link(ORG_B, B1, foreign, false, { price: '99.00' });

      const before = await linksOf(solo);
      const productBefore = await productRow(solo);
      const foreignBefore = await linksOf(foreign);

      const result = await service.bulkBranchPublication(scopeA, [solo], A1, true, actor);

      // The message first: when this is not UPDATED, the reason is the finding.
      expect(result.outcomes[0].message).toBeUndefined();
      expect(result.outcomes).toEqual([{ id: solo, outcome: 'UPDATED', globalStatus: 'PUBLISHED' }]);
      const after = await linksOf(solo);
      expect(after.map((r) => r.published)).toEqual([
        before[0].store_id === A1 ? true : before[0].published,
        before[1].store_id === A1 ? true : before[1].published,
      ]);
      expect(withoutPublished(after)).toEqual(withoutPublished(before));
      expect(await productRow(solo)).toEqual(productBefore);
      expect(await linksOf(foreign)).toEqual(foreignBefore);
      // No membership was created or removed.
      expect(after).toHaveLength(2);

      // Audited once, as PUBLISH, with the website in the context.
      expect(audits).toHaveLength(1);
      expect(audits[0][4]).toBe('PUBLISH');
      expect(audits[0][5]).toEqual({ branchPublished: { before: false, after: true } });
      expect(audits[0][7]).toEqual({ organizationId: ORG_A, storeId: A1 });
    });

    it('hiding a published member flips only published; hiding it again is UNCHANGED with no write', async () => {
      const solo = await product(ORG_A, 'solo');
      await link(ORG_A, A1, solo, true, { price: '12.50', stock: 2, tracked: true, lead: 5 });
      const before = await linksOf(solo);

      const first = await service.bulkBranchPublication(scopeA, [solo], A1, false, actor);
      expect(first.outcomes[0].outcome).toBe('UPDATED');
      expect(audits[0][4]).toBe('UNPUBLISH');
      const after = await linksOf(solo);
      expect(after[0].published).toBe(false);
      expect(withoutPublished(after)).toEqual(withoutPublished(before));

      audits.length = 0;
      const [{ updated_at: stamp }] = await sql(`select updated_at from store_products where product_id = ?::uuid`, [
        solo,
      ]);
      const second = await service.bulkBranchPublication(scopeA, [solo], A1, false, actor);
      expect(second.outcomes[0].outcome).toBe('UNCHANGED');
      expect(second.unchangedCount).toBe(1);
      expect(audits).toHaveLength(0);
      const [{ updated_at: stampAfter }] = await sql(
        `select updated_at from store_products where product_id = ?::uuid`,
        [solo],
      );
      expect(String(stampAfter)).toBe(String(stamp));
    });
  });

  describe('what is refused, skipped and never written', () => {
    it('a product not on that website is FAILED and no membership row appears', async () => {
      const elsewhere = await product(ORG_A, 'elsewhere');
      await link(ORG_A, A2, elsewhere, true);
      const [{ n: before }] = await sql<{ n: number }>(
        `select count(*)::int as n from store_products where product_id = ?::uuid`,
        [elsewhere],
      );

      const result = await service.bulkBranchPublication(scopeA, [elsewhere], A1, true, actor);

      expect(result.outcomes[0]).toMatchObject({ outcome: 'FAILED' });
      expect(result.outcomes[0].message).toMatch(/not on that website/);
      const [{ n: after }] = await sql<{ n: number }>(
        `select count(*)::int as n from store_products where product_id = ?::uuid`,
        [elsewhere],
      );
      expect(Number(after)).toBe(Number(before));
    });

    it('a parent card is SKIPPED_PARENT and neither the card nor its children change', async () => {
      const card = await product(ORG_A, 'card');
      const k1 = await product(ORG_A, 'k1', { parent: card });
      const k2 = await product(ORG_A, 'k2', { parent: card });
      await link(ORG_A, A1, card, true);
      await link(ORG_A, A1, k1, false);
      await link(ORG_A, A1, k2, false);
      const before = [await linksOf(card), await linksOf(k1), await linksOf(k2)];

      const result = await service.bulkBranchPublication(scopeA, [card], A1, false, actor);

      expect(result.outcomes[0]).toMatchObject({ id: card, outcome: 'SKIPPED_PARENT' });
      expect(result.outcomes[0].message).toMatch(/parent card/);
      expect(result).toMatchObject({ skippedParentCount: 1, failedCount: 0, updatedCount: 0 });
      expect([await linksOf(card), await linksOf(k1), await linksOf(k2)]).toEqual(before);
      expect(audits).toHaveLength(0);
    });

    it('a foreign product is FAILED with the same not-found as a missing one; a foreign website refuses the whole request before any write', async () => {
      const theirs = await product(ORG_B, 'theirs');
      await link(ORG_B, B1, theirs, false);
      const mine = await product(ORG_A, 'mine');
      await link(ORG_A, A1, mine, false);

      const result = await service.bulkBranchPublication(scopeA, [theirs, mine], A1, true, actor);
      expect(result.outcomes.map((o) => o.outcome)).toEqual(['FAILED', 'UPDATED']);
      expect(result.outcomes[0].message).toBe(`Product with ID ${theirs} not found`);
      expect((await linksOf(theirs))[0].published).toBe(false);

      const snapshot = await linksOf(mine);
      await expect(service.bulkBranchPublication(scopeA, [mine], B1, false, actor)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(await linksOf(mine)).toEqual(snapshot);
    });

    it('publishing runs the existing guard: a branch-required field left unanswered is FAILED; hiding the same product is not the guard’s concern', async () => {
      const [{ id: def }] = await sql<{ id: string }>(
        `insert into product_field_definitions (organization_id, key, label, type, created_at, updated_at)
         values (?::uuid, 'weight', 'Weight', 'NUMBER', now(), now()) returning id`,
        [ORG_A],
      );
      const strict = await store(ORG_A, 'strict');
      await sql(
        `insert into store_field_settings (organization_id, store_id, definition_id, active, required, created_at, updated_at)
         values (?::uuid, ?::uuid, ?::uuid, true, true, now(), now())`,
        [ORG_A, strict, def],
      );
      const heavy = await product(ORG_A, 'heavy');
      await link(ORG_A, strict, heavy, false);
      const shown = await product(ORG_A, 'shown');
      await link(ORG_A, strict, shown, true);

      const publish = await service.bulkBranchPublication(scopeA, [heavy], strict, true, actor);
      expect(publish.outcomes[0]).toMatchObject({ outcome: 'FAILED' });
      expect(publish.outcomes[0].message).toMatch(
        /cannot be published in that branch until it answers the fields the branch requires/,
      );
      expect((await linksOf(heavy))[0].published).toBe(false);

      const hide = await service.bulkBranchPublication(scopeA, [shown], strict, false, actor);
      expect(hide.outcomes[0]).toMatchObject({ outcome: 'UPDATED' });
      expect((await linksOf(shown))[0].published).toBe(false);
    });
  });

  describe('what the storefront sees afterwards', () => {
    it('a published child becomes visible for that website only; hiding the card’s last visible child removes the card while every row stays', async () => {
      const card = await product(ORG_A, 'card');
      const k1 = await product(ORG_A, 'k1', { parent: card });
      const k2 = await product(ORG_A, 'k2', { parent: card });
      await link(ORG_A, A1, card, true);
      await link(ORG_A, A1, k1, false);
      await link(ORG_A, A1, k2, false);
      await link(ORG_A, A2, card, true);
      await link(ORG_A, A2, k1, true);

      expect(await visibleIn(A1)).not.toContain(card);

      const publish = await service.bulkBranchPublication(scopeA, [k1, k2], A1, true, actor);
      expect(publish.outcomes.map((o) => o.outcome)).toEqual(['UPDATED', 'UPDATED']);
      expect(await visibleIn(A1)).toContain(card);

      const hide = await service.bulkBranchPublication(scopeA, [k1, k2], A1, false, actor);
      expect(hide.updatedCount).toBe(2);
      expect(await visibleIn(A1)).not.toContain(card);
      // The other website is untouched, and the rows all still exist.
      expect(await visibleIn(A2)).toContain(card);
      const [{ n }] = await sql<{ n: number }>(
        `select count(*)::int as n from store_products where product_id in (?::uuid, ?::uuid, ?::uuid)`,
        [card, k1, k2],
      );
      expect(Number(n)).toBe(5);
    });
  });

  describe('the family-root lock is held for a hide, too', () => {
    it('a hide queued behind a grouping decides after it: the product that just became a card is SKIPPED, not written', async () => {
      const solo = await product(ORG_A, 'solo');
      await link(ORG_A, A1, solo, true);
      const key = productFamilyLock(solo);

      // A "grouping in progress": another transaction holds the family root.
      const blocker = pg.orm.em.fork() as EntityManager;
      await blocker.begin();
      try {
        await blocker.execute('select pg_advisory_xact_lock(?::int4, ?::int4)', [key.ns, key.key]);

        const hide = service.bulkBranchPublication(scopeA, [solo], A1, false, actor);
        await waitFor(async () => (await waitersOn(key)) >= 1, 'the hide to queue on the family-root key');

        // While the hide waits, the grouping completes: `solo` gains a child.
        await product(ORG_A, 'child-of-solo', { parent: solo });
        await blocker.rollback();

        const result = await hide;
        expect(result.outcomes[0]).toMatchObject({ id: solo, outcome: 'SKIPPED_PARENT' });
        expect((await linksOf(solo))[0].published).toBe(true);
        expect(audits).toHaveLength(0);
      } catch (err) {
        await blocker.rollback().catch(() => undefined);
        throw err;
      }
    });

    it('and for a publish: the queued publish also skips a product that became a card', async () => {
      const solo = await product(ORG_A, 'solo');
      await link(ORG_A, A1, solo, false);
      const key = productFamilyLock(solo);

      const blocker = pg.orm.em.fork() as EntityManager;
      await blocker.begin();
      try {
        await blocker.execute('select pg_advisory_xact_lock(?::int4, ?::int4)', [key.ns, key.key]);
        const publish = service.bulkBranchPublication(scopeA, [solo], A1, true, actor);
        await waitFor(async () => (await waitersOn(key)) >= 1, 'the publish to queue on the family-root key');
        await product(ORG_A, 'child-of-solo', { parent: solo });
        await blocker.rollback();

        const result = await publish;
        expect(result.outcomes[0]).toMatchObject({ id: solo, outcome: 'SKIPPED_PARENT' });
        expect((await linksOf(solo))[0].published).toBe(false);
      } catch (err) {
        await blocker.rollback().catch(() => undefined);
        throw err;
      }
    });
  });

  describe('the branchPublished list filter', () => {
    it('names exactly the hidden members of one website — never a non-member', async () => {
      const hidden = await product(ORG_A, 'hidden');
      const shown = await product(ORG_A, 'shown');
      const elsewhere = await product(ORG_A, 'elsewhere');
      const strict = await store(ORG_A, 'filter');
      await link(ORG_A, strict, hidden, false);
      await link(ORG_A, strict, shown, true);
      await link(ORG_A, A2, elsewhere, false);

      const hiddenIds = await products.findMatchingIds({
        organizationId: ORG_A,
        storeFilterId: strict,
        branchPublished: false,
      });
      expect(hiddenIds).toEqual([hidden]);
      const shownIds = await products.findMatchingIds({
        organizationId: ORG_A,
        storeFilterId: strict,
        branchPublished: true,
      });
      expect(shownIds).toEqual([shown]);
      await expect(products.findMatchingIds({ organizationId: ORG_A, branchPublished: false })).rejects.toThrow(
        'branchPublished requires storeId',
      );
    });
  });
});
