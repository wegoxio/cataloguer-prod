import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../test/pg-harness';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/** The last migration before the tenant-integrity repair. */
const BEFORE_REPAIR = 'Migration20260822130000';
const REPAIR = 'Migration20260824120000';

/**
 * Sales-order tenant integrity, proved on real PostgreSQL.
 *
 * The P5-X2 rehearsal acceptance measured manual checkouts persisting
 * `sales_orders.organization_id` as NULL — invisible to every
 * organization-grouped report while the store join quietly carried the tenant.
 * These tests prove the repair end to end: the backfill derives each historic
 * row's company from its own store; anything unexplainable stops the migration
 * loudly; and after the repair the database itself refuses both a missing and
 * a mismatched company, so no future code path can reintroduce the defect.
 */
d('sales-order organization integrity (real PostgreSQL)', () => {
  jest.setTimeout(600_000);

  const seedOrgStore = async (em: EntityManager, label: string) => {
    const [org]: { id: string }[] = await em.execute(
      `insert into organizations (name, slug, created_at, updated_at) values (?, ?, now(), now()) returning id`,
      [label, label],
    );
    const [store]: { id: string }[] = await em.execute(
      `insert into stores (name, slug, organization_id, created_at, updated_at)
       values (?, ?, ?::uuid, now(), now()) returning id`,
      [`store-${label}`, `store-${label}`, org.id],
    );
    return { org: org.id, store: store.id };
  };

  const insertNullOrder = async (em: EntityManager, storeId: string, orderNumber: string) => {
    await em.execute(
      `insert into sales_orders (store_id, order_number, status, total_usd, discount_usd, created_at, updated_at)
       values (?::uuid, ?, 'PAID', 42.50, 0, now(), now())`,
      [storeId, orderNumber],
    );
  };

  describe('the backfill migration', () => {
    let pg: DisposablePg;
    let em: EntityManager;

    beforeAll(async () => {
      pg = await withDisposablePg({ migrateTo: BEFORE_REPAIR });
      em = pg.orm.em.fork() as EntityManager;
    });
    afterAll(async () => {
      if (pg) await pg.close();
    });

    it('backfills NULL rows from their own store, preserving state and amount', async () => {
      const a = await seedOrgStore(em, 'backfill-a');
      const b = await seedOrgStore(em, 'backfill-b');
      await insertNullOrder(em, a.store, 'NULL-A');
      await insertNullOrder(em, b.store, 'NULL-B');
      // one row already stamped CORRECTLY must be left exactly as it is
      await em.execute(
        `insert into sales_orders (store_id, organization_id, order_number, status, total_usd, discount_usd, created_at, updated_at)
         values (?::uuid, ?::uuid, 'PRE-STAMPED', 'DELIVERED', 10, 0, now(), now())`,
        [a.store, a.org],
      );

      await pg.orm.getMigrator().up({ to: REPAIR });

      const rows: { order_number: string; organization_id: string; status: string; total_usd: string }[] =
        await em.execute(
          `select order_number, organization_id, status, total_usd from sales_orders order by order_number`,
        );
      const byNumber = new Map(rows.map((row) => [row.order_number, row]));
      expect(byNumber.get('NULL-A')!.organization_id).toBe(a.org);
      expect(byNumber.get('NULL-B')!.organization_id).toBe(b.org);
      expect(byNumber.get('PRE-STAMPED')!.organization_id).toBe(a.org);
      // states and amounts preserved
      expect(byNumber.get('NULL-A')!.status).toBe('PAID');
      expect(Number(byNumber.get('NULL-A')!.total_usd)).toBe(42.5);
      const [{ n }]: { n: number }[] = await em.execute(
        `select count(*)::int as n from sales_orders where organization_id is null`,
      );
      expect(n).toBe(0);
    });

    it('after the repair, the database itself refuses a missing company', async () => {
      const a = await seedOrgStore(em, 'not-null-check');
      await expect(insertNullOrder(em, a.store, 'POST-NULL')).rejects.toThrow(/null value|not-null/i);
    });

    it('after the repair, the database itself refuses a store/organization mismatch', async () => {
      const a = await seedOrgStore(em, 'mismatch-a');
      const b = await seedOrgStore(em, 'mismatch-b');
      await expect(
        em.execute(
          `insert into sales_orders (store_id, organization_id, order_number, status, total_usd, discount_usd, created_at, updated_at)
           values (?::uuid, ?::uuid, 'MISMATCH', 'NEW', 1, 0, now(), now())`,
          [a.store, b.org],
        ),
      ).rejects.toThrow(/sales_orders_store_tenant_foreign|foreign key/i);
    });
  });

  describe('the migration STOPS on unexplainable history', () => {
    it('a stamped company DIFFERENT from the store’s aborts the migration, changing nothing', async () => {
      const pg = await withDisposablePg({ migrateTo: BEFORE_REPAIR });
      try {
        const em = pg.orm.em.fork() as EntityManager;
        const a = await seedOrgStore(em, 'corrupt-a');
        const b = await seedOrgStore(em, 'corrupt-b');
        // cross-tenant corruption: an order in a's store stamped with b's company
        await em.execute(
          `insert into sales_orders (store_id, organization_id, order_number, status, total_usd, discount_usd, created_at, updated_at)
           values (?::uuid, ?::uuid, 'CORRUPT', 'NEW', 1, 0, now(), now())`,
          [a.store, b.org],
        );
        await insertNullOrder(em, a.store, 'INNOCENT-NULL');

        await expect(pg.orm.getMigrator().up({ to: REPAIR })).rejects.toThrow(/cross-tenant corruption/i);

        // the refusal wrote nothing: the innocent NULL row is still NULL
        const rows: { organization_id: string | null }[] = await em.execute(
          `select organization_id from sales_orders where order_number = 'INNOCENT-NULL'`,
        );
        expect(rows[0].organization_id).toBeNull();
      } finally {
        await pg.close();
      }
    });
  });

  describe('creation paths stamp the company', () => {
    let pg: DisposablePg;
    let em: EntityManager;

    beforeAll(async () => {
      pg = await withDisposablePg({});
      em = pg.orm.em.fork() as EntityManager;
    });
    afterAll(async () => {
      if (pg) await pg.close();
    });

    it('a checkout INSERT without the company is impossible at HEAD', async () => {
      const a = await seedOrgStore(em, 'head-stamp');
      await expect(insertNullOrder(em, a.store, 'HEAD-NULL')).rejects.toThrow(/null value|not-null/i);
    });

    it('organization-scoped reads see exactly their own orders', async () => {
      const a = await seedOrgStore(em, 'scoped-a');
      const b = await seedOrgStore(em, 'scoped-b');
      await em.execute(
        `insert into sales_orders (store_id, organization_id, order_number, status, total_usd, discount_usd, created_at, updated_at)
         values (?::uuid, ?::uuid, 'SCOPED-A', 'NEW', 5, 0, now(), now())`,
        [a.store, a.org],
      );
      const mine: { n: number }[] = await em.execute(
        `select count(*)::int as n from sales_orders where organization_id = ?::uuid`,
        [a.org],
      );
      const theirs: { n: number }[] = await em.execute(
        `select count(*)::int as n from sales_orders where organization_id = ?::uuid`,
        [b.org],
      );
      expect(mine[0].n).toBe(1);
      expect(theirs[0].n).toBe(0);
    });
  });
});
