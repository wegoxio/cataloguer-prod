import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { ProductsService } from '../../catalogue/products.service';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { ProductFieldDefinition } from '../../entities/product-field-definition.entity';
import { Product } from '../../entities/product.entity';
import { SalesService } from '../../../sales/sales.service';
import { SalesOrder } from '../../../sales/sales-order.entity';
import { realStock, realReservations } from '../../../../../test/inventory-stock-support';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;
const ACTOR = { id: '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e', email: 'op@e.test' } as any;

/**
 * A PARENT IS NOT A LINE ITEM — enforced where it counts.
 *
 * A parent is the card a family shows: it holds no stock and no price of its
 * own. Hiding it from a dropdown is not enough, because a hidden option is
 * still an id somebody can submit. So the guarantee is stated twice, and both
 * are tested here: the QUERY that feeds every selector leaves parents out, and
 * the ORDER path refuses a parent id that arrives anyway.
 */
d('a parent is never sellable (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let products: ProductsService;
  let sales: SalesService;

  let ORG: string;
  let STORE: string;
  let CARD: string;
  let CHILD: string;
  let ALONE: string;

  const exec = async <T>(sql: string, params: unknown[] = []): Promise<T> => em.execute(sql, params) as Promise<T>;
  const uid = (l: string) => `${l}-${randomUUID().slice(0, 8)}`;

  const mkProduct = async (label: string, parentId: string | null) => {
    const name = uid(label);
    const [row] = await exec<{ id: string }[]>(
      `insert into products (id, name, slug, organization_id, status, price, track_inventory, parent_id, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?::uuid, 'PUBLISHED', 25, false, ?::uuid, now(), now()) returning id`,
      [name, name, ORG, parentId],
    );
    await exec(
      `insert into store_products (id, organization_id, store_id, product_id, published, track_inventory, created_at, updated_at)
       values (gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, true, false, now(), now())`,
      [ORG, STORE, row.id],
    );
    return row.id;
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    const guard = new PublicationGuardService();
    const fields = new ProductFieldsService(em.getRepository(ProductFieldDefinition) as any, em as any, guard);
    products = new ProductsService(
      em.getRepository(Product) as any,
      em.getRepository(Product) as any,
      { findById: async () => undefined } as any,
      { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
      { learnFromAcceptedGroup: async () => undefined } as any,
      guard,
      fields,
      realStock(em as any),
    );
    sales = new SalesService(
      em.getRepository(SalesOrder) as any,
      em.getRepository(Product) as any,
      { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
      { compute: async () => ({ discountUsd: 0, codeText: null, code: null }) } as any,
      realStock(em as any),
      realReservations(em as any),
    );

    ORG = (
      await exec<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), 'Sell Co', ?, now(), now()) returning id`,
        [uid('sell')],
      )
    )[0].id;
    STORE = (
      await exec<{ id: string }[]>(
        `insert into stores (id, name, slug, organization_id, created_at, updated_at)
         values (gen_random_uuid(), 'Centro', ?, ?::uuid, now(), now()) returning id`,
        [uid('centro'), ORG],
      )
    )[0].id;
    CARD = await mkProduct('card', null);
    CHILD = await mkProduct('child', CARD);
    ALONE = await mkProduct('alone', null);
  }, 300_000);

  afterAll(async () => {
    if (pg) await pg.close();
  });

  const list = async (over: Record<string, unknown> = {}) => {
    const page = await products.findAll({
      organizationId: ORG,
      page: 1,
      limit: 100,
      ...over,
    } as never);
    return (page as any).items.map((i: any) => i.id);
  };

  describe('the query that feeds every selector', () => {
    it('omits parents when asked for selectable products', async () => {
      const ids = await list({ excludeParents: true });
      expect(ids).not.toContain(CARD);
    });

    it('keeps children and standalone products, which ARE what a family sells', async () => {
      const ids = await list({ excludeParents: true });
      expect(ids).toContain(CHILD);
      expect(ids).toContain(ALONE);
    });

    it('changes nothing when not asked — the catalogue still lists the card', async () => {
      const ids = await list();
      expect(ids).toContain(CARD);
      expect(ids).toContain(CHILD);
      expect(ids).toContain(ALONE);
    });

    it('is not the same as the standalone filter, which would also drop children', async () => {
      // `family: 'standalone'` excludes children too, and a child is exactly
      // what a customer buys — so it is the wrong tool for a sales selector.
      const standaloneOnly = await list({ family: 'standalone' });
      expect(standaloneOnly).not.toContain(CHILD);
      const selectable = await list({ excludeParents: true });
      expect(selectable).toContain(CHILD);
    });
  });

  describe('the order path refuses a parent id that arrives anyway', () => {
    const NOT_AVAILABLE = /is not available in this store/;

    it('refuses a parent submitted directly, exactly as it refuses an unknown id', async () => {
      const parent = await sales
        .createFromWebsite(STORE, [{ productId: CARD, quantity: 1 }] as any, 'Ana', '555')
        .catch((e) => e);
      const unknown = await sales
        .createFromWebsite(STORE, [{ productId: '00000000-0000-4000-8000-000000000000', quantity: 1 }] as any)
        .catch((e) => e);

      expect(parent.getStatus()).toBe(400);
      expect(parent.message).toMatch(NOT_AVAILABLE);
      // Identical to a missing id: the refusal must not confirm that the id
      // names a real card.
      expect(unknown.message).toMatch(NOT_AVAILABLE);
    });

    it('refuses a parent through the MANUAL sales path too, not only the website one', async () => {
      const err: any = await sales
        .createManual({ organizationId: ORG, storeId: STORE, allowedStoreIds: [STORE] } as any, ACTOR, {
          storeId: STORE,
          items: [{ productId: CARD, quantity: 1 }],
        } as any)
        .catch((e) => e);
      expect(err.message).toMatch(NOT_AVAILABLE);
    });

    it('accepts the child and the standalone product, so the guard is not refusing everything', async () => {
      const child = await sales.createFromWebsite(STORE, [{ productId: CHILD, quantity: 1 }] as any, 'Ana', '555');
      const alone = await sales.createFromWebsite(STORE, [{ productId: ALONE, quantity: 1 }] as any, 'Ana', '555');
      expect(child.orderNumber).toBeDefined();
      expect(alone.orderNumber).toBeDefined();
    });
  });
  describe('it composes with the other filters, and applies BEFORE paging', () => {
    it('is applied in the query, so `total` and the page agree', async () => {
      const all = await products.findAll({ organizationId: ORG, page: 1, limit: 100 } as never);
      const selectable = await products.findAll({
        organizationId: ORG,
        page: 1,
        limit: 100,
        excludeParents: true,
      } as never);
      // Filtering the page after the query would leave `total` counting the
      // card the caller never receives.
      expect((selectable as any).total).toBe((selectable as any).items.length);
      expect((selectable as any).total).toBe((all as any).total - 1);
    });

    it('fills a small page with SELECTABLE rows, never a short page hiding a parent', async () => {
      const page = await products.findAll({
        organizationId: ORG,
        page: 1,
        limit: 2,
        excludeParents: true,
      } as never);
      const ids = (page as any).items.map((i: any) => i.id);
      expect(ids).toHaveLength(2);
      expect(ids).not.toContain(CARD);
    });

    it('composes with the STORE filter', async () => {
      const ids = (
        (await products.findAll({
          organizationId: ORG,
          page: 1,
          limit: 100,
          excludeParents: true,
          storeFilterId: STORE,
        } as never)) as any
      ).items.map((i: any) => i.id);
      expect(ids).toContain(CHILD);
      expect(ids).toContain(ALONE);
      expect(ids).not.toContain(CARD);
    });

    it('composes with the STATUS filter', async () => {
      const ids = (
        (await products.findAll({
          organizationId: ORG,
          page: 1,
          limit: 100,
          excludeParents: true,
          status: 'PUBLISHED',
        } as never)) as any
      ).items.map((i: any) => i.id);
      expect(ids).toContain(CHILD);
      expect(ids).not.toContain(CARD);
    });

    it('composes with SEARCH — a parent matching the term is still omitted', async () => {
      const [card] = await exec<{ name: string }[]>(`select name from products where id = ?::uuid`, [CARD]);
      const ids = (
        (await products.findAll({
          organizationId: ORG,
          page: 1,
          limit: 100,
          excludeParents: true,
          search: card.name,
        } as never)) as any
      ).items.map((i: any) => i.id);
      // The search finds it; the filter still refuses to offer it.
      expect(ids).not.toContain(CARD);
      const unfiltered = (
        (await products.findAll({ organizationId: ORG, page: 1, limit: 100, search: card.name } as never)) as any
      ).items.map((i: any) => i.id);
      expect(unfiltered).toContain(CARD);
    });
  });
});
