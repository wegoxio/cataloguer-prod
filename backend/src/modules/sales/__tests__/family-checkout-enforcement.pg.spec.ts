import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../test/pg-harness';
import { SalesService } from '../sales.service';
import { SalesOrder } from '../sales-order.entity';
import { Product } from '../../products/entities/product.entity';
import { realStock, realReservations } from '../../../../test/inventory-stock-support';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * Checkout enforcement for parents and wrong-store children.
 *
 * The order guard was ALREADY CORRECT before this branch — it is deliberately
 * not rewritten. What was missing is proof that it stays correct, and proof of
 * WHEN it refuses: the refusal has to land before anything is written, or a
 * rejected checkout still leaves an order row, a ledger movement or an audit
 * entry behind.
 *
 * These tests count rows in every table a successful checkout touches, before
 * and after a refused one, against a real database.
 */
d('family checkout enforcement (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let sales: SalesService;

  const uid = (label: string) => `${label}-${Math.random().toString(16).slice(2, 10)}`;
  const sql = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => em.execute(text, params);

  /** Every table a completed website order writes to. */
  const WRITTEN_TABLES = [
    'sales_orders',
    'sales_order_items',
    'inventory_transactions',
    'inventory_entries',
    'inventory_reservations',
    'audit_logs',
  ];

  const census = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const table of WRITTEN_TABLES) {
      const [row] = await sql<{ n: number }>(`select count(*)::int as n from ${table}`);
      out[table] = row.n;
    }
    return out;
  };

  const seed = async () => {
    const slug = uid('org');
    const [org] = await sql<{ id: string }>(
      `insert into organizations (name, slug, created_at, updated_at) values (?, ?, now(), now()) returning id`,
      [slug, slug],
    );
    const store = async (label: string) => {
      const name = uid(label);
      const [row] = await sql<{ id: string }>(
        `insert into stores (name, slug, organization_id, created_at, updated_at)
         values (?, ?, ?::uuid, now(), now()) returning id`,
        [name, name, org.id],
      );
      return row.id;
    };
    const storeA = await store('a');
    const storeB = await store('b');

    const product = async (label: string, parentId: string | null, storeIds: string[]) => {
      const name = uid(label);
      const [row] = await sql<{ id: string }>(
        `insert into products
           (name, slug, organization_id, status, price, track_inventory, parent_id, created_at, updated_at)
         values (?, ?, ?::uuid, 'PUBLISHED', 25, false, ?::uuid, now(), now()) returning id`,
        [name, name, org.id, parentId],
      );
      for (const storeId of storeIds) {
        await sql(
          `insert into store_products
             (organization_id, store_id, product_id, published, track_inventory, created_at, updated_at)
           values (?::uuid, ?::uuid, ?::uuid, true, false, now(), now())`,
          [org.id, storeId, row.id],
        );
      }
      return row.id;
    };

    const parent = await product('chair', null, [storeA, storeB]);
    const childA = await product('green', parent, [storeA]);
    const childB = await product('brown', parent, [storeB]);
    return { organizationId: org.id, storeA, storeB, parent, childA, childB };
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    sales = new SalesService(
      em.getRepository(SalesOrder) as any,
      em.getRepository(Product) as any,
      { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
      // The real discounts service's "no code" answer, so the positive case
      // exercises the same write path a real checkout takes.
      { compute: async () => ({ discountUsd: 0, codeText: null, code: null }) } as any,
      realStock(em as any),
      realReservations(em as any),
    );
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  /**
   * The refusal is the same sentence in both cases on purpose: a card and an
   * item that is simply not sold here must look identical from outside, so a
   * probing visitor cannot tell which is which.
   */
  const NOT_AVAILABLE = /is not available in this store/;

  describe('service level', () => {
    it('refuses a child that belongs to ANOTHER store, and writes nothing', async () => {
      const s = await seed();
      const before = await census();

      await expect(
        sales.createFromWebsite(s.storeA, [{ productId: s.childB, quantity: 1 }] as any, 'Ana', '555'),
      ).rejects.toThrow(NOT_AVAILABLE);

      expect(await census()).toEqual(before);
    });

    it('refuses the PARENT itself, and writes nothing', async () => {
      const s = await seed();
      const before = await census();

      await expect(
        sales.createFromWebsite(s.storeA, [{ productId: s.parent, quantity: 1 }] as any, 'Ana', '555'),
      ).rejects.toThrow(NOT_AVAILABLE);

      expect(await census()).toEqual(before);
    });

    it('refuses a MIXED cart whole — one bad line writes none of the good ones', async () => {
      const s = await seed();
      const before = await census();

      await expect(
        sales.createFromWebsite(
          s.storeA,
          [
            { productId: s.childA, quantity: 1 },
            { productId: s.childB, quantity: 1 },
          ] as any,
          'Ana',
          '555',
        ),
      ).rejects.toThrow(NOT_AVAILABLE);

      // The valid line must not have been priced, reserved or written either.
      expect(await census()).toEqual(before);
    });

    it('gives the same refusal for a wrong-store child as for an id that does not exist', async () => {
      const s = await seed();
      const wrongStore = await sales
        .createFromWebsite(s.storeA, [{ productId: s.childB, quantity: 1 }] as any)
        .catch((e) => e);
      const nonexistent = await sales
        .createFromWebsite(s.storeA, [{ productId: '00000000-0000-4000-8000-000000000000', quantity: 1 }] as any)
        .catch((e) => e);

      expect(wrongStore.getStatus()).toBe(nonexistent.getStatus());
      // Neither message reveals whether the id names anything at all.
      expect(wrongStore.message).toMatch(NOT_AVAILABLE);
      expect(nonexistent.message).toMatch(NOT_AVAILABLE);
    });

    it('accepts the child that IS sold here, so the guard is not simply refusing everything', async () => {
      const s = await seed();
      const before = await census();

      const order = await sales.createFromWebsite(
        s.storeA,
        [{ productId: s.childA, quantity: 2 }] as any,
        'Ana',
        '555',
      );

      expect(order.orderNumber).toBeDefined();
      const after = await census();
      expect(after.sales_orders).toBe(before.sales_orders + 1);
      expect(after.sales_order_items).toBe(before.sales_order_items + 1);
    });

    it('refuses a child whose link to this store exists but is UNPUBLISHED', async () => {
      const s = await seed();
      await sql(`update store_products set published = false where product_id = ?::uuid and store_id = ?::uuid`, [
        s.childA,
        s.storeA,
      ]);
      const before = await census();

      await expect(sales.createFromWebsite(s.storeA, [{ productId: s.childA, quantity: 1 }] as any)).rejects.toThrow(
        NOT_AVAILABLE,
      );

      expect(await census()).toEqual(before);
    });
  });
});
