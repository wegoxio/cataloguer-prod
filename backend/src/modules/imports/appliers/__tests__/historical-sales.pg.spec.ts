import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import {
  HISTORICAL_SALE_NOTICE,
  HistoricalSaleRow,
  HistoricalSalesApplier,
  refuseDeduction,
} from '../historical-sales.applier';
import { PlannedUnit } from '../../execution/batch-planner';
import { RowOutcome } from '../../entities/import-row-result.entity';

/** The approver an execution runs under; appliers attribute writes to them. */
const APPROVER = '00000000-0000-4000-8000-000000000001';

/**
 * Historical sales are records only, proven where it counts.
 *
 * The claim is a negative — importing years of sales history changes no stock,
 * no availability, no ledger balance — and a negative is worth what the attempt
 * to falsify it is worth. So this checks the inventory tables before and after,
 * tries to write a deducting row directly, and reads the applier's own source.
 */

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

d('historical sales (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let applier: HistoricalSalesApplier;
  let organizationId: string;
  let otherOrganizationId: string;
  let storeId: string;
  let otherStoreId: string;
  let productId: string;
  let executionId: string;
  let sourceId: string;

  const exec = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
    pg.orm.em.getConnection().execute(sql, params) as Promise<T>;

  const newOrg = async (label: string) =>
    (
      await exec<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), ?, ?, now(), now()) returning id`,
        [label, `${label}-${randomUUID().slice(0, 8)}`.toLowerCase()],
      )
    )[0].id;

  const newStore = async (org: string, label: string) =>
    (
      await exec<{ id: string }[]>(
        `insert into stores (id, name, slug, organization_id, created_at, updated_at)
         values (gen_random_uuid(), ?, ?, ?, now(), now()) returning id`,
        [label, `${label}-${randomUUID().slice(0, 8)}`.toLowerCase(), org],
      )
    )[0].id;

  const newExecution = async (): Promise<string> => {
    await exec(
      `update import_executions set status='COMPLETED', finished_at=now()
        where organization_id = ? and status in ('QUEUED','RUNNING')`,
      [organizationId],
    );
    const planId = (
      await exec<{ id: string }[]>(
        `insert into import_plans
           (organization_id, source_id, import_type, plan_hash, source_hash, analyzer_version,
            mapping, decisions, target_assumptions, summary, sales_inventory_mode, store_id)
         values (?, ?, 'HISTORICAL_STORE_SALES', ?, repeat('b',64), 'p9-1',
                 '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb, 'HISTORICAL_RECORD_ONLY', ?) returning id`,
        [organizationId, sourceId, randomUUID().replace(/-/g, '').padEnd(64, '0'), storeId],
      )
    )[0].id;
    return (
      await exec<{ id: string }[]>(
        `insert into import_executions (organization_id, plan_id, execution_identity, status)
         values (?, ?, ?, 'RUNNING') returning id`,
        [organizationId, planId, `exec-${randomUUID()}`],
      )
    )[0].id;
  };

  const unit = (rows: HistoricalSaleRow[]): PlannedUnit =>
    ({ kind: 'ROW', sourceRows: rows.map((r) => r.sourceRow), mutations: rows, sourceTable: 'Ventas' }) as PlannedUnit;

  const sale = (over: Partial<HistoricalSaleRow> = {}): HistoricalSaleRow => ({
    sourceRow: 2,
    storeId,
    productId,
    itemText: 'Camiseta azul',
    quantity: 3,
    unitPrice: 19.99,
    occurredAt: new Date('2023-06-15T10:00:00.000Z'),
    ...over,
  });

  /** Everything about inventory that a real order would move. */
  const inventorySnapshot = async () => {
    const [products] = await exec<{ total: string }[]>(
      `select coalesce(sum(stock_quantity),0)::text as total from products where organization_id = ?`,
      [organizationId],
    );
    const [storeProducts] = await exec<{ total: string }[]>(
      `select coalesce(sum(stock_quantity),0)::text as total from store_products where organization_id = ?`,
      [organizationId],
    );
    const [orders] = await exec<{ count: string }[]>(`select count(*)::text as count from sales_orders`);
    const [items] = await exec<{ count: string }[]>(`select count(*)::text as count from sales_order_items`);
    // The ledger itself, and the balances derived from it — the two things a
    // real sale moves and a historical record must not.
    const [entries] = await exec<{ count: string }[]>(`select count(*)::text as count from inventory_entries`);
    const [balances] = await exec<{ total: string }[]>(
      `select coalesce(sum(quantity),0)::text as total from inventory_balances`,
    );
    const [backorders] = await exec<{ count: string }[]>(`select count(*)::text as count from inventory_backorders`);
    return {
      productStock: products.total,
      storeStock: storeProducts.total,
      salesOrders: orders.count,
      salesOrderItems: items.count,
      inventoryEntries: entries.count,
      inventoryBalance: balances.total,
      backorders: backorders.count,
    };
  };

  beforeAll(async () => {
    pg = await withDisposablePg();
    em = pg.orm.em.fork() as EntityManager;
    applier = new HistoricalSalesApplier();

    organizationId = await newOrg('sales-co');
    otherOrganizationId = await newOrg('other-co');
    storeId = await newStore(organizationId, 'centro');
    otherStoreId = await newStore(otherOrganizationId, 'ajeno');

    productId = (
      await exec<{ id: string }[]>(
        `insert into products (id, name, slug, sku, status, organization_id, price, stock_quantity, created_at, updated_at)
         values (gen_random_uuid(), 'Camiseta azul', ?, 'CAM-01', 'PUBLISHED', ?, 19.99, 50, now(), now()) returning id`,
        [`camiseta-${randomUUID()}`, organizationId],
      )
    )[0].id;

    await exec(
      `insert into store_products (organization_id, store_id, product_id, published, price, stock_quantity, track_inventory, created_at, updated_at)
       values (?, ?, ?, true, 19.99, 50, true, now(), now())`,
      [organizationId, storeId, productId],
    );

    sourceId = (
      await exec<{ id: string }[]>(
        `insert into import_sources
           (organization_id, object_key, original_file_name, size_bytes, content_hash, detected_format, parser_version)
         values (?, ?, 'ventas.csv', 10, repeat('a',64), 'CSV_OR_TEXT', 'p9-1') returning id`,
        [organizationId, `imports/${organizationId}/ventas.csv`],
      )
    )[0].id;

    executionId = await newExecution();
  }, 300_000);

  afterAll(async () => {
    await pg?.close();
  });

  describe('nothing about inventory moves', () => {
    it('records a sale and leaves every inventory figure exactly as it was', async () => {
      const before = await inventorySnapshot();

      const results = await applier.apply(unit([sale()]), {
        organizationId,
        executionId,
        importType: 'HISTORICAL_STORE_SALES',
        approvedByUserId: APPROVER,
        em: em,
      });

      expect(results[0].outcome).toBe(RowOutcome.CREATED);
      // The whole claim, checked against the tables a real order would move.
      expect(await inventorySnapshot()).toEqual(before);
    });

    it('creates no operational sales order, so nothing enters a fulfilment queue', async () => {
      const executionId2 = await newExecution();
      await applier.apply(unit([sale({ sourceRow: 3 })]), {
        organizationId,
        executionId: executionId2,
        importType: 'HISTORICAL_STORE_SALES',
        approvedByUserId: APPROVER,
        em: em,
      });

      const [orders] = await exec<{ count: string }[]>(`select count(*)::text as count from sales_orders`);
      expect(Number(orders.count)).toBe(0);
    });

    it('stores stockDeducted as false, so a report can say so from data', async () => {
      const rows = await exec<{ stock_deducted: boolean }[]>(
        `select stock_deducted from imported_historical_sales where organization_id = ?`,
        [organizationId],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.stock_deducted === false)).toBe(true);
    });

    it('the DATABASE refuses a row claiming stock was deducted', async () => {
      // The guarantee that survives a code path which tries. Written directly,
      // bypassing the applier entirely.
      await expect(
        exec(
          `insert into imported_historical_sales
             (organization_id, store_id, item_text, quantity, occurred_at, stock_deducted,
              execution_id, source_table, source_row)
           values (?, ?, 'Camiseta', 1, now() - interval '1 year', true, ?, 'Ventas', 999)`,
          [organizationId, storeId, executionId],
        ),
      ).rejects.toThrow(/never_deducts|violates check constraint/i);
    });
  });

  describe('a mapping that asks for a deduction', () => {
    it('is REFUSED by name rather than obeyed and ignored', () => {
      // Silently dropping the request would let somebody believe their stock
      // had been adjusted.
      const reason = refuseDeduction(sale({ requestsStockDeduction: true }));
      expect(reason).toMatch(/never change stock/);
      expect(reason).toMatch(/Remove the stock-deduction option/);
    });

    it('blocks that row and keeps the rest of the batch', async () => {
      const executionId2 = await newExecution();
      const results = await applier.apply(
        unit([sale({ sourceRow: 2, requestsStockDeduction: true }), sale({ sourceRow: 3 }), sale({ sourceRow: 4 })]),
        {
          organizationId,
          executionId: executionId2,
          importType: 'HISTORICAL_STORE_SALES',
          approvedByUserId: APPROVER,
          em,
        },
      );

      expect(results.map((r) => r.outcome)).toEqual([RowOutcome.BLOCKED, RowOutcome.CREATED, RowOutcome.CREATED]);
    });
  });

  describe('what the record keeps', () => {
    it('keeps the business time, not the time it was imported', async () => {
      // Conflating them would date a customer's whole history to the day they
      // migrated.
      const executionId2 = await newExecution();
      await applier.apply(unit([sale({ sourceRow: 10, occurredAt: new Date('2021-03-04T00:00:00.000Z') })]), {
        organizationId,
        executionId: executionId2,
        importType: 'HISTORICAL_STORE_SALES',
        approvedByUserId: APPROVER,
        em: em,
      });

      const [row] = await exec<{ occurred_at: Date; created_at: Date }[]>(
        `select occurred_at, created_at from imported_historical_sales where execution_id = ? and source_row = 10`,
        [executionId2],
      );
      expect(new Date(row.occurred_at).getUTCFullYear()).toBe(2021);
      expect(new Date(row.created_at).getUTCFullYear()).toBeGreaterThan(2021);
    });

    it('preserves the original text when no product matched', async () => {
      // A history full of discontinued products will not all match, and
      // refusing those rows would throw away most of what the customer came to
      // keep.
      const executionId2 = await newExecution();
      const results = await applier.apply(
        unit([sale({ sourceRow: 11, productId: null, itemText: 'Lámpara descatalogada' })]),
        {
          organizationId,
          executionId: executionId2,
          importType: 'HISTORICAL_STORE_SALES',
          approvedByUserId: APPROVER,
          em,
        },
      );

      expect(results[0].outcome).toBe(RowOutcome.CREATED);
      expect(results[0].reason).toContain('Lámpara descatalogada');

      const [row] = await exec<{ item_text: string; product_id: string | null }[]>(
        `select item_text, product_id from imported_historical_sales where execution_id = ? and source_row = 11`,
        [executionId2],
      );
      expect(row.item_text).toBe('Lámpara descatalogada');
      expect(row.product_id).toBeNull();
    });

    it('has nowhere to put a name, an email, an address or a phone', async () => {
      // PII minimization by absence: you cannot store what there is no column
      // for, and a later change would have to be a migration somebody reviews.
      const columns = await exec<{ column_name: string }[]>(
        `select column_name from information_schema.columns
          where table_schema='public' and table_name='imported_historical_sales'`,
      );
      const names = columns.map((c) => c.column_name);
      for (const forbidden of ['customer_name', 'customer_email', 'email', 'phone', 'address', 'buyer_name']) {
        expect(names).not.toContain(forbidden);
      }
      expect(names).toContain('customer_reference');
    });

    it('records an external reference so the customer can reconcile', async () => {
      const executionId2 = await newExecution();
      await applier.apply(unit([sale({ sourceRow: 12, externalRef: 'ORD-2021-0042' })]), {
        organizationId,
        executionId: executionId2,
        importType: 'HISTORICAL_STORE_SALES',
        approvedByUserId: APPROVER,
        em: em,
      });
      const [row] = await exec<{ external_ref: string }[]>(
        `select external_ref from imported_historical_sales where execution_id = ? and source_row = 12`,
        [executionId2],
      );
      expect(row.external_ref).toBe('ORD-2021-0042');
    });
  });

  describe('scope', () => {
    it('refuses a shop belonging to another company', async () => {
      // The composite foreign key: the (store, organization) pair does not
      // exist, so the row cannot be inserted at all.
      const executionId2 = await newExecution();
      await expect(
        applier.apply(unit([sale({ sourceRow: 20, storeId: otherStoreId, productId: null })]), {
          organizationId,
          executionId: executionId2,
          importType: 'HISTORICAL_STORE_SALES',
          approvedByUserId: APPROVER,
          em: em,
        }),
      ).rejects.toThrow(/store_tenant_foreign|violates foreign key/i);
    });

    it('refuses a product belonging to another company', async () => {
      const foreignProduct = (
        await exec<{ id: string }[]>(
          `insert into products (id, name, slug, status, organization_id, price, created_at, updated_at)
           values (gen_random_uuid(), 'Ajeno', ?, 'PUBLISHED', ?, 1, now(), now()) returning id`,
          [`ajeno-${randomUUID()}`, otherOrganizationId],
        )
      )[0].id;

      const executionId2 = await newExecution();
      await expect(
        applier.apply(unit([sale({ sourceRow: 21, productId: foreignProduct })]), {
          organizationId,
          executionId: executionId2,
          importType: 'HISTORICAL_STORE_SALES',
          approvedByUserId: APPROVER,
          em: em,
        }),
      ).rejects.toThrow(/product_tenant_foreign|violates foreign key/i);
    });
  });

  describe('replays and corrections', () => {
    it('records a source row once, however many times the run retries it', async () => {
      const executionId2 = await newExecution();
      const context = {
        organizationId,
        executionId: executionId2,
        importType: 'HISTORICAL_STORE_SALES',
        approvedByUserId: APPROVER,
        em: em,
      };

      const first = await applier.apply(unit([sale({ sourceRow: 30 })]), context);
      const second = await applier.apply(unit([sale({ sourceRow: 30 })]), context);

      expect(first[0].outcome).toBe(RowOutcome.CREATED);
      expect(second[0].outcome).toBe(RowOutcome.SKIPPED);
      expect(second[0].reason).toMatch(/already recorded/);

      const [counted] = await exec<{ count: string }[]>(
        `select count(*)::text as count from imported_historical_sales where execution_id = ? and source_row = 30`,
        [executionId2],
      );
      expect(Number(counted.count)).toBe(1);
    });

    it('refuses a sale of zero or a negative quantity', async () => {
      // Not a sale; a correction, and corrections are not what this records.
      const executionId2 = await newExecution();
      await expect(
        applier.apply(unit([sale({ sourceRow: 31, quantity: 0 })]), {
          organizationId,
          executionId: executionId2,
          importType: 'HISTORICAL_STORE_SALES',
          approvedByUserId: APPROVER,
          em: em,
        }),
      ).rejects.toThrow(/quantity_check|violates check constraint/i);
    });

    it('refuses a sale dated in the future', async () => {
      // Almost always a date read in the wrong field order, and a future sale
      // in a history report is worse than a refused row.
      const executionId2 = await newExecution();
      await expect(
        applier.apply(unit([sale({ sourceRow: 32, occurredAt: new Date(Date.now() + 30 * 24 * 3600 * 1000) })]), {
          organizationId,
          executionId: executionId2,
          importType: 'HISTORICAL_STORE_SALES',
          approvedByUserId: APPROVER,
          em: em,
        }),
      ).rejects.toThrow(/occurred_at_check|violates check constraint/i);
    });
  });

  describe('the applier cannot touch inventory even by mistake', () => {
    it('contains no inventory, ledger or sales-order write in its own source', () => {
      // A call that is never written cannot be re-enabled by a careless edit.
      // Comments are stripped first. The file EXPLAINS at length why it must
      // not touch these tables, and a scan of the raw text would fail on the
      // explanation — a guard that cries wolf gets deleted.
      const source = readFileSync(join(__dirname, '..', 'historical-sales.applier.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      const forbidden = [
        'inventory_movements',
        'sales_orders',
        'sales_order_items',
        'InventoryService',
        'store_products',
        'stock_quantity',
      ];
      // Reported as the offending list rather than a bare false, so a failure
      // names what was found instead of sending someone hunting.
      expect(forbidden.filter((token) => source.includes(token))).toEqual([]);
    });

    it('states the notice the interface must show', () => {
      expect(HISTORICAL_SALE_NOTICE).toBe('Historical record — inventory unaffected.');
    });
  });
});

if (!gate.enabled) {
  // eslint-disable-next-line no-console
  console.log(`historical sales PG suite skipped: ${gate.reason}`);
}
