import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../test/pg-harness';
import { prepareLedger, realReservations, realStock } from '../../../../test/inventory-stock-support';
import { SalesService } from '../sales.service';
import { SalesOrder } from '../sales-order.entity';
import { Product } from '../../products/entities/product.entity';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * P5-B4, Decision A1 — what a short branch does depends on the organization.
 *
 * With enforcement ON (the default, and today's behaviour) a short sale is
 * refused, wording unchanged. With it OFF the shortfall becomes a system-origin
 * `SALES_OVERSELL` backorder: an honest promise, visibly distinct from one an
 * operator made, and still no negative balance anywhere.
 */
d('P5-B4 sales enforcement and oversell backorders (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;

  const seed = async (label: string, opening: number, enforce: boolean) => {
    const suffix = `${label}-${Math.random().toString(16).slice(2, 8)}`;
    const [org]: { id: string }[] = await em.execute(
      `insert into organizations (name, slug, enforce_stock_availability, created_at, updated_at)
       values (?, ?, ?, now(), now()) returning id`,
      [suffix, suffix, enforce],
    );
    const [store]: { id: string }[] = await em.execute(
      `insert into stores (name, slug, organization_id, created_at, updated_at)
       values (?, ?, ?::uuid, now(), now()) returning id`,
      [`s-${suffix}`, `s-${suffix}`, org.id],
    );
    const [product]: { id: string }[] = await em.execute(
      `insert into products (name, slug, organization_id, price, status, track_inventory, created_at, updated_at)
       values (?, ?, ?::uuid, 10, 'PUBLISHED', true, now(), now()) returning id`,
      [`p-${suffix}`, `p-${suffix}`, org.id],
    );
    await em.execute(
      `insert into store_products (organization_id, store_id, product_id, published, track_inventory, price, created_at, updated_at)
       values (?::uuid, ?::uuid, ?::uuid, true, true, 10, now(), now())`,
      [org.id, store.id, product.id],
    );
    await prepareLedger(em, {
      organizationId: org.id,
      storeId: store.id,
      productId: opening > 0 ? product.id : null,
      quantity: opening,
    });
    return { organizationId: org.id, storeId: store.id, productId: product.id };
  };

  const salesFor = (manager: EntityManager) =>
    new SalesService(
      manager.getRepository(SalesOrder) as any,
      manager.getRepository(Product) as any,
      { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
      { compute: async () => ({ code: null, codeText: null, discountUsd: 0 }) } as any,
      realStock(manager),
      realReservations(manager),
    );

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  it('enforcement ON refuses the short sale and raises no promise', async () => {
    const s = await seed('enforced', 1, true);
    const sales = salesFor(pg.orm.em.fork() as EntityManager);

    await expect(sales.createFromWebsite(s.storeId, [{ productId: s.productId, quantity: 3 }])).rejects.toThrow(
      /Not enough stock/,
    );
    const rows: { orders: number; backorders: number }[] = await em.execute(
      `select (select count(*)::int from sales_orders where store_id = ?::uuid) as orders,
              (select count(*)::int from inventory_backorders where organization_id = ?::uuid) as backorders`,
      [s.storeId, s.organizationId],
    );
    expect(rows[0]).toEqual({ orders: 0, backorders: 0 });
  });

  it('enforcement OFF sells and records a SALES_OVERSELL promise instead', async () => {
    const s = await seed('permissive', 1, false);
    const sales = salesFor(pg.orm.em.fork() as EntityManager);

    const order = await sales.createFromWebsite(s.storeId, [{ productId: s.productId, quantity: 3 }]);
    expect(order.orderNumber).toBeDefined();

    const backorders: { origin: string; quantity: number; status: string; store_id: string }[] = await em.execute(
      `select origin, quantity, status, store_id from inventory_backorders where organization_id = ?::uuid`,
      [s.organizationId],
    );
    expect(backorders).toHaveLength(1);
    expect(backorders[0]).toMatchObject({ origin: 'SALES_OVERSELL', quantity: 3, status: 'OPEN' });
    expect(backorders[0].store_id).toBe(s.storeId);

    // No negative balance anywhere: the promise is not stock.
    const balances: { negative: number }[] = await em.execute(
      `select count(*)::int as negative from inventory_balances where organization_id = ?::uuid and quantity < 0`,
      [s.organizationId],
    );
    expect(balances[0].negative).toBe(0);

    // The line records that nothing was deducted, because nothing was.
    const items: { stock_deducted: number }[] = await em.execute(
      `select stock_deducted from sales_order_items where order_id = ?::uuid`,
      [order.id],
    );
    expect(items[0].stock_deducted).toBe(0);
  });

  it('enforcement OFF still takes real stock when the branch has it', async () => {
    const s = await seed('permissive-stocked', 5, false);
    const sales = salesFor(pg.orm.em.fork() as EntityManager);

    const order = await sales.createFromWebsite(s.storeId, [{ productId: s.productId, quantity: 2 }]);
    const items: { stock_deducted: number }[] = await em.execute(
      `select stock_deducted from sales_order_items where order_id = ?::uuid`,
      [order.id],
    );
    // Physical recording is unconditional (ADR 013 §7): the setting governs the
    // SHORTFALL, not whether real movements are recorded.
    expect(items[0].stock_deducted).toBe(2);
    const backorders: { n: number }[] = await em.execute(
      `select count(*)::int as n from inventory_backorders where organization_id = ?::uuid`,
      [s.organizationId],
    );
    expect(backorders[0].n).toBe(0);
  });

  it('defaults to enforcing, so nothing changes for an organization that never chose', async () => {
    const rows: { enforce: boolean }[] = await em.execute(
      `insert into organizations (name, slug, created_at, updated_at) values (?, ?, now(), now())
       returning enforce_stock_availability as enforce`,
      [`default-${Date.now()}`, `default-${Date.now()}`],
    );
    expect(rows[0].enforce).toBe(true);
  });
});
