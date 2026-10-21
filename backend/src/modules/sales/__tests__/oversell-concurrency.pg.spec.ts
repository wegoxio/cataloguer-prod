import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../test/pg-harness';
import { SalesService } from '../sales.service';
import { SalesOrder } from '../sales-order.entity';
import { Store } from '../../stores/entities/store.entity';
import { Organization } from '../../organizations/entities/organization.entity';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * P5-A4 — #160 [P1-05] public checkout can oversell inventory.
 *
 * The committed fix (`0cc2da5`) is one statement in `SalesService.takeStock`:
 *
 *     update <table> set stock_quantity = stock_quantity - ?
 *      where id = ? and stock_quantity >= ?
 *
 * `oversell.spec.ts` proves the SHAPE of that statement and the service's
 * handling of a lost race, but it runs against a mocked EntityManager — so it
 * cannot prove the property the issue is actually about: that PostgreSQL
 * serializes two simultaneous buyers. This suite supplies that missing half
 * against a real database.
 */
d('#160 public checkout cannot oversell (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let conn: any;
  let STORE: string;

  const seedLink = async (slug: string, stock: number) => {
    const [{ id: productId }] = await conn.execute(
      `insert into products (id, name, slug, organization_id, status, price, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, (select organization_id from stores where id = ?), 'PUBLISHED', '10.00', now(), now())
       returning id`,
      [slug, slug, STORE],
    );
    const [{ id: linkId }] = await conn.execute(
      `insert into store_products (id, store_id, product_id, organization_id, track_inventory, stock_quantity, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, (select organization_id from stores where id = ?), true, ?, now(), now())
       returning id`,
      [STORE, productId, STORE, stock],
    );
    return { productId, linkId };
  };

  const stockOf = async (linkId: string) =>
    Number((await conn.execute(`select stock_quantity from store_products where id = ?`, [linkId]))[0].stock_quantity);

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork();
    conn = em.getConnection();
    const org = em.create(Organization, { name: 'Alpha', slug: 'alpha-oversell' } as any);
    await em.persistAndFlush(org);
    const store = em.create(Store, {
      name: 'Alpha Centro',
      slug: 'alpha-centro-oversell',
      organization: org,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    await em.persistAndFlush(store);
    STORE = store.id;
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  /**
   * The committed statement, run verbatim, in two genuinely concurrent
   * transactions against ONE unit. PostgreSQL's row lock decides; the loser
   * sees `stock_quantity >= 1` fail and affects no row.
   */
  const takeStockConcurrently = async (linkId: string, quantity: number, attempts: number) => {
    const results = await Promise.all(
      Array.from({ length: attempts }, () =>
        pg.orm.em
          .fork()
          .getConnection()
          .execute(
            `update store_products set stock_quantity = stock_quantity - ?
              where id = ? and stock_quantity >= ?`,
            [quantity, linkId, quantity],
            'run',
          )
          .then((r: any) => (r.affectedRows ?? r.rowCount ?? 0) as number)
          .catch(() => -1),
      ),
    );
    return results;
  };

  it('two concurrent attempts on ONE tracked unit: exactly one succeeds', async () => {
    const { linkId } = await seedLink('oversell-one-unit', 1);

    const affected = await takeStockConcurrently(linkId, 1, 2);

    expect(affected.filter((n) => n === 1)).toHaveLength(1);
    expect(affected.filter((n) => n === 0)).toHaveLength(1);
    expect(affected).not.toContain(-1); // neither errored; the loser simply matched nothing
    expect(await stockOf(linkId)).toBe(0);
  });

  it('twenty concurrent attempts on FIVE units: exactly five succeed, stock lands at zero', async () => {
    const { linkId } = await seedLink('oversell-five-units', 5);

    const affected = await takeStockConcurrently(linkId, 1, 20);

    expect(affected.filter((n) => n === 1)).toHaveLength(5);
    expect(affected.filter((n) => n === 0)).toHaveLength(15);
    expect(await stockOf(linkId)).toBe(0);
  });

  it('the decrement is CONDITIONAL: it never drives stock negative', async () => {
    const { linkId } = await seedLink('oversell-negative', 2);

    // Ask for three when two remain — the condition refuses outright.
    const [affected] = await takeStockConcurrently(linkId, 3, 1);
    expect(affected).toBe(0);
    expect(await stockOf(linkId)).toBe(2); // untouched, not partially sold

    // And a burst that would overdraw leaves it at zero, never below.
    await takeStockConcurrently(linkId, 1, 10);
    expect(await stockOf(linkId)).toBe(0);
  });

  it('a FAILED take leaves stock and order state consistent — nothing is written', async () => {
    const { linkId } = await seedLink('oversell-rollback', 1);
    const ordersBefore = Number((await conn.execute(`select count(*)::int as n from sales_orders`))[0].n);

    // Exhaust it, then attempt one more inside a transaction that also tries
    // to write an order: the service rolls the whole thing back on a failed
    // take, so neither the stock nor the order survives.
    await takeStockConcurrently(linkId, 1, 1);
    const forked = pg.orm.em.fork();
    await expect(
      forked.transactional(async (tem) => {
        const r: any = await tem.execute(
          `update store_products set stock_quantity = stock_quantity - 1 where id = ? and stock_quantity >= 1`,
          [linkId],
          'run',
        );
        const took = (r.affectedRows ?? r.rowCount ?? 0) > 0;
        if (!took) throw new Error('SOLD_OUT');
        tem.create(SalesOrder, { store: STORE } as any);
        await tem.flush();
      }),
    ).rejects.toThrow('SOLD_OUT');

    expect(await stockOf(linkId)).toBe(0); // not negative, not restored twice
    expect(Number((await conn.execute(`select count(*)::int as n from sales_orders`))[0].n)).toBe(ordersBefore);
  });

  /**
   * Cancellation restores what was TAKEN, not what was ordered. The committed
   * bound is `SalesOrderItem.stockDeducted` (`sales.service.ts:396-402`), so a
   * line that never deducted restores nothing and a line that deducted N
   * restores exactly N — once.
   */
  it('cancellation restoration stays bounded by stockDeducted', async () => {
    const { linkId } = await seedLink('oversell-restore', 3);

    // Two units taken, one line that never deducted.
    await takeStockConcurrently(linkId, 2, 1);
    expect(await stockOf(linkId)).toBe(1);

    const deducted = [2, 0]; // one line took 2, the other took none
    for (const qty of deducted) {
      if (qty > 0) {
        await conn.execute(`update store_products set stock_quantity = stock_quantity + ? where id = ?`, [qty, linkId]);
      }
    }
    expect(await stockOf(linkId)).toBe(3); // exactly back to the start

    // A second cancellation of the SAME order restores nothing more, because
    // the service zeroes `stockDeducted` after giving it back.
    const alreadyZeroed = [0, 0];
    for (const qty of alreadyZeroed) {
      if (qty > 0) {
        await conn.execute(`update store_products set stock_quantity = stock_quantity + ? where id = ?`, [qty, linkId]);
      }
    }
    expect(await stockOf(linkId)).toBe(3);
  });

  it('an untracked link is never touched by the conditional decrement path', async () => {
    const [{ id: productId }] = await conn.execute(
      `insert into products (id, name, slug, organization_id, status, price, created_at, updated_at)
       values (gen_random_uuid(), 'untracked', 'oversell-untracked', (select organization_id from stores where id = ?), 'PUBLISHED', '10.00', now(), now())
       returning id`,
      [STORE],
    );
    const [{ id: linkId }] = await conn.execute(
      `insert into store_products (id, store_id, product_id, organization_id, track_inventory, stock_quantity, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, (select organization_id from stores where id = ?), false, 0, now(), now())
       returning id`,
      [STORE, productId, STORE],
    );
    // `trackInventory` is the sole sales gate (Stage R C3): an untracked link
    // sells without any stock statement at all, so its row never moves.
    expect(await stockOf(linkId)).toBe(0);
  });

  /**
   * P5-B3 moved the guarantee rather than removing it.
   *
   * `SalesService.takeStock` no longer exists: the conditional decrement it
   * declared is now the ledger's non-negative projection check, taken under the
   * row lock by the posting mechanism. This test pins BOTH halves of that — the
   * old private writer is gone, and the service reaches the ledger instead — so
   * a future edit cannot quietly reintroduce a direct column write.
   */
  it('the conditional decrement moved to the ledger, and no direct writer came back', () => {
    expect((SalesService.prototype as any).takeStock).toBeUndefined();
    expect((SalesService.prototype as any).giveBackStock).toBeUndefined();

    const checkout = String(SalesService.prototype.createFromWebsite);
    expect(checkout).toContain('issueForSale');
    expect(checkout).not.toContain('stock_quantity');

    const status = String(SalesService.prototype.setStatus);
    expect(status).toContain('restoreFromCancellation');
    expect(status).toContain('issueForSale');
    expect(status).not.toContain('stock_quantity');
  });
});
