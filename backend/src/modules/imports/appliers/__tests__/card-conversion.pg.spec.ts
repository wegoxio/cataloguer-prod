import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { ProductMutation, ProductsApplier } from '../products.applier';
import { PlannedUnit } from '../../execution/batch-planner';
import { RowOutcome } from '../../entities/import-row-result.entity';
import { PublicationGuardService } from '../../../products/publication/publication-guard.service';

const APPROVER = '00000000-0000-4000-8000-000000000001';
const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * TURNING AN EXISTING PRODUCT INTO A CARD, and what a card row may say.
 *
 * The first design normalized an imported card into shape after inserting it:
 * clear the sale price, the cost, the SKU. That is wrong twice.
 *
 * It destroys identity. `matchRow` resolves a repeated row by prior source
 * identity, then SKU, then manufacturer code; its name step deliberately
 * returns UNRESOLVED because names repeat, and nothing in this codebase writes
 * `import_external_identities` yet. Clearing a card's SKU turns a clean second
 * run into a row awaiting a human — which is why the SKU is the ONE documented
 * exception here, and why the accepted family CSV names its parent through a
 * SKU column.
 *
 * And it destroys history. A populated standalone can carry ledger entries,
 * balances, supplier lines and per-shop decisions, none of which may be
 * deleted to make a card of it.
 *
 * So nothing is ever cleared. A row is refused unless the product is ALREADY
 * in the shape a card must have.
 */
d('import: converting into a card, and card-row fields (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let applier: ProductsApplier;
  let organizationId: string;

  const exec = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
    pg.orm.em.getConnection().execute(sql, params) as Promise<T>;
  const uid = (l: string) => `${l}-${randomUUID().slice(0, 8)}`;

  const context = () => ({
    organizationId,
    executionId: randomUUID(),
    importType: 'PRODUCTS',
    approvedByUserId: APPROVER,
    em: pg.orm.em as EntityManager,
  });
  const unit = (mutations: ProductMutation[]): PlannedUnit =>
    ({ kind: 'ROW', sourceRows: mutations.map((m) => m.sourceRow), mutations }) as PlannedUnit;
  const applyUnit = (u: PlannedUnit) =>
    (pg.orm.em as EntityManager).transactional(async (tem) =>
      applier.apply(u, { ...context(), em: tem as EntityManager }),
    );

  const mkStandalone = async (over: { sku?: string; salePrice?: number; trackInventory?: boolean } = {}) => {
    const name = uid('solo');
    const [row] = await exec<{ id: string }[]>(
      `insert into products (id, name, slug, organization_id, status, price, sale_price, track_inventory, sku, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?::uuid, 'PUBLISHED', 10, ?, ?, ?, now(), now()) returning id`,
      [name, name, organizationId, over.salePrice ?? null, over.trackInventory ?? false, over.sku ?? null],
    );
    return row.id;
  };

  const childCount = async (id: string) =>
    (await exec<{ n: number }[]>(`select count(*)::int n from products where parent_id = ?::uuid`, [id]))[0].n;

  beforeAll(async () => {
    pg = await withDisposablePg({});
    applier = new ProductsApplier(new PublicationGuardService());
    organizationId = (
      await exec<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), 'Conv Co', ?, now(), now()) returning id`,
        [uid('conv')],
      )
    )[0].id;
  }, 300_000);

  afterAll(async () => {
    if (pg) await pg.close();
  });

  describe('what a card ROW may carry', () => {
    it('GIVES UP the SKU it was named by, and keeps that name as a durable identity', async () => {
      const sku = uid('FAM').toUpperCase();
      const results = await applyUnit(
        unit([
          {
            sourceRow: 1,
            fields: { name: uid('Camiseta'), sku, manufacturerCode: 'MFG-X' },
            externalIdentity: { sourceSystem: 'manual-spreadsheet', externalId: sku },
            children: [{ sourceRow: 2, fields: { name: uid('Camiseta M'), optionLabel: 'M' } }],
          } as ProductMutation,
        ]),
      );
      expect(results.every((r) => r.outcome === RowOutcome.CREATED)).toBe(true);
      const cardId = results[0].targetId as string;
      expect(await childCount(cardId)).toBe(1);

      // A card is never ordered, sold or received, so it carries neither.
      const [row] = await exec<{ sku: string | null; manufacturer_code: string | null }[]>(
        `select sku, manufacturer_code from products where id = ?::uuid`,
        [cardId],
      );
      expect(row.sku).toBeNull();
      expect(row.manufacturer_code).toBeNull();

      // What the file called it is recorded where a later run will look.
      const [identity] = await exec<{ target_id: string; source_system: string }[]>(
        `select target_id, source_system from import_external_identities
          where organization_id = ?::uuid and external_id = ? and target_type = 'product'`,
        [organizationId, sku],
      );
      expect(identity.target_id).toBe(cardId);
      expect(identity.source_system).toBe('manual-spreadsheet');
    });

    it('BLOCKS a sale price, a cost or a shop override on the card row, and creates nothing', async () => {
      const before = (
        await exec<{ n: number }[]>(`select count(*)::int n from products where organization_id = ?::uuid`, [
          organizationId,
        ])
      )[0].n;
      const results = await applyUnit(
        unit([
          {
            sourceRow: 1,
            fields: { name: uid('Camiseta'), salePrice: 5, cost: 2 },
            children: [{ sourceRow: 2, fields: { name: uid('Camiseta M'), optionLabel: 'M' } }],
          } as ProductMutation,
        ]),
      );
      expect(results.every((r) => r.outcome === RowOutcome.BLOCKED)).toBe(true);
      expect(results[0].reason).toMatch(/sale price/i);
      const after = (
        await exec<{ n: number }[]>(`select count(*)::int n from products where organization_id = ?::uuid`, [
          organizationId,
        ])
      )[0].n;
      expect(after).toBe(before);
    });
  });

  describe('converting an EXISTING product', () => {
    it('refuses a standalone that has inventory history, and leaves the ledger byte-for-byte', async () => {
      const solo = await mkStandalone();
      const [loc] = await exec<{ id: string }[]>(
        `insert into inventory_locations (id, organization_id, code, name, kind, created_at, updated_at)
         values (gen_random_uuid(), ?::uuid, ?, 'W', 'WAREHOUSE', now(), now()) returning id`,
        [organizationId, uid('loc')],
      );
      const [tx] = await exec<{ id: string }[]>(
        // A SYSTEM transaction must name its origin; the check constraint
        // refuses one that names neither a user nor an origin.
        `insert into inventory_transactions (id, organization_id, type, idempotency_key, command_fingerprint, actor_kind, system_origin, posted_at)
         values (gen_random_uuid(), ?::uuid, 'RECEIPT', ?, ?, 'SYSTEM', 'test-fixture', now()) returning id`,
        // The fingerprint column is constrained to a 64-hex digest.
        [organizationId, uid('idem'), randomUUID().replace(/-/g, '').repeat(2)],
      );
      await exec(
        `insert into inventory_entries (id, organization_id, transaction_id, product_id, location_id, physical_condition, operational_state, quantity_delta, created_at)
         values (gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, ?::uuid, 'GOOD', 'AVAILABLE', 5, now())`,
        [organizationId, tx.id, solo, loc.id],
      );
      const ledgerBefore = await exec<Record<string, unknown>[]>(
        `select * from inventory_entries where product_id = ?::uuid order by id`,
        [solo],
      );

      const results = await applyUnit(
        unit([
          {
            sourceRow: 1,
            targetId: solo,
            fields: { name: 'Now a card' },
            children: [{ sourceRow: 2, fields: { name: uid('kid'), optionLabel: 'M' } }],
          } as ProductMutation,
        ]),
      );

      expect(results.every((r) => r.outcome === RowOutcome.BLOCKED)).toBe(true);
      expect(results[0].reason).toMatch(/inventory history/i);
      expect(await childCount(solo)).toBe(0);
      // The immutable history is exactly as it was — nothing deleted to make
      // room for a conversion that was refused.
      const ledgerAfter = await exec<Record<string, unknown>[]>(
        `select * from inventory_entries where product_id = ?::uuid order by id`,
        [solo],
      );
      expect(ledgerAfter).toEqual(ledgerBefore);
    });

    it('refuses a standalone that is on a supplier order', async () => {
      const solo = await mkStandalone();
      const [sup] = await exec<{ id: string }[]>(
        `insert into suppliers (id, organization_id, name, created_at)
         values (gen_random_uuid(), ?::uuid, 'S', now()) returning id`,
        [organizationId],
      );
      const [order] = await exec<{ id: string }[]>(
        `insert into supplier_orders (id, organization_id, supplier_id, order_number, status, created_at, updated_at)
         values (gen_random_uuid(), ?::uuid, ?::uuid, ?, 'ORDERED', now(), now()) returning id`,
        [organizationId, sup.id, uid('PO')],
      );
      await exec(
        `insert into supplier_order_items (id, order_id, product_id, raw_name, quantity)
         values (gen_random_uuid(), ?::uuid, ?::uuid, 'line', 1)`,
        [order.id, solo],
      );

      const results = await applyUnit(
        unit([
          {
            sourceRow: 1,
            targetId: solo,
            fields: { name: 'Now a card' },
            children: [{ sourceRow: 2, fields: { name: uid('kid'), optionLabel: 'M' } }],
          } as ProductMutation,
        ]),
      );
      expect(results.every((r) => r.outcome === RowOutcome.BLOCKED)).toBe(true);
      expect(results[0].reason).toMatch(/supplier order/i);
      expect(await childCount(solo)).toBe(0);
    });

    it('refuses a standalone carrying prohibited scalar state, and clears nothing', async () => {
      const solo = await mkStandalone({ salePrice: 7, trackInventory: true, sku: uid('KEEP').toUpperCase() });
      const before = (
        await exec<{ sku: string | null; sale_price: string | null; track_inventory: boolean }[]>(
          `select sku, sale_price, track_inventory from products where id = ?::uuid`,
          [solo],
        )
      )[0];

      const results = await applyUnit(
        unit([
          {
            sourceRow: 1,
            targetId: solo,
            fields: { name: 'Now a card' },
            children: [{ sourceRow: 2, fields: { name: uid('kid'), optionLabel: 'M' } }],
          } as ProductMutation,
        ]),
      );
      expect(results.every((r) => r.outcome === RowOutcome.BLOCKED)).toBe(true);
      expect(await childCount(solo)).toBe(0);
      // Its identity and its commercial state are untouched: nothing was
      // "cleaned" out of a product the import refused to convert.
      const after = (
        await exec<{ sku: string | null; sale_price: string | null; track_inventory: boolean }[]>(
          `select sku, sale_price, track_inventory from products where id = ?::uuid`,
          [solo],
        )
      )[0];
      expect(after).toEqual(before);
    });

    it('a refused conversion creates NO loose children', async () => {
      const solo = await mkStandalone({ salePrice: 3 });
      const kidName = uid('orphan');
      const results = await applyUnit(
        unit([
          {
            sourceRow: 1,
            targetId: solo,
            fields: { name: 'Now a card' },
            children: [{ sourceRow: 2, fields: { name: kidName, optionLabel: 'M' } }],
          } as ProductMutation,
        ]),
      );
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.outcome === RowOutcome.BLOCKED)).toBe(true);
      const [{ n }] = await exec<{ n: number }[]>(`select count(*)::int n from products where name = ?`, [kidName]);
      expect(n).toBe(0);
    });

    it('ALLOWS a standalone that is already in the shape a card must have', async () => {
      const clean = await mkStandalone();
      const results = await applyUnit(
        unit([
          {
            sourceRow: 1,
            targetId: clean,
            fields: { name: 'Now a card' },
            children: [{ sourceRow: 2, fields: { name: uid('kid'), optionLabel: 'M' } }],
          } as ProductMutation,
        ]),
      );
      expect(results.every((r) => r.outcome !== RowOutcome.BLOCKED)).toBe(true);
      expect(await childCount(clean)).toBe(1);
    });
  });

  describe('idempotency and family shape', () => {
    it('an identical retry updates the SAME card and creates no duplicate', async () => {
      const sku = uid('RETRY').toUpperCase();
      const name = uid('Camiseta');
      const kid = uid('Camiseta M');
      const run = () =>
        applyUnit(
          unit([
            {
              sourceRow: 1,
              fields: { name, sku },
              children: [{ sourceRow: 2, fields: { name: kid, optionLabel: 'M' } }],
            } as ProductMutation,
          ]),
        );

      const first = await run();
      const cardId = first[0].targetId as string;

      // The card does NOT keep the SKU — a card is never ordered, sold or
      // received, so a sellable item's identifier has no business on one. What
      // the file called the row is what a re-import resolves through, and the
      // card itself carries nothing.
      const [{ sku: storedSku }] = await exec<{ sku: string | null }[]>(`select sku from products where id = ?::uuid`, [
        cardId,
      ]);
      expect(storedSku).toBeNull();

      // The second run is the plan a re-import produces.
      const second = await applyUnit(
        unit([
          {
            sourceRow: 1,
            targetId: cardId,
            fields: { name, sku },
            children: [{ sourceRow: 2, fields: { name: kid, optionLabel: 'M' } }],
          } as ProductMutation,
        ]),
      );
      expect(second[0].targetId).toBe(cardId);
      // ONE card, not two — and the retry did not put the SKU back on it.
      const [{ n }] = await exec<{ n: number }[]>(
        `select count(*)::int n from products where organization_id = ?::uuid and name = ?`,
        [organizationId, name],
      );
      expect(n).toBe(1);
      const [{ sku: afterRetry }] = await exec<{ sku: string | null }[]>(
        `select sku from products where id = ?::uuid`,
        [cardId],
      );
      expect(afterRetry).toBeNull();
    });

    it('an EXPLICIT plan family with exactly one child commits', async () => {
      const results = await applyUnit(
        unit([
          {
            sourceRow: 1,
            fields: { name: uid('Mesa') },
            children: [{ sourceRow: 2, fields: { name: uid('Mesa 160'), optionLabel: '160' } }],
          } as ProductMutation,
        ]),
      );
      expect(results.every((r) => r.outcome === RowOutcome.CREATED)).toBe(true);
      expect(await childCount(results[0].targetId as string)).toBe(1);
    });

    it('a family whose parent row FAILS creates no children on their own', async () => {
      const kidName = uid('orphan');
      const results = await applyUnit(
        unit([
          {
            sourceRow: 1,
            fields: {}, // no name: the parent row cannot be created
            children: [{ sourceRow: 2, fields: { name: kidName, optionLabel: 'M' } }],
          } as ProductMutation,
        ]),
      );
      expect(results[0].outcome).toBe(RowOutcome.FAILED);
      expect(results[1].outcome).toBe(RowOutcome.BLOCKED);
      const [{ n }] = await exec<{ n: number }[]>(`select count(*)::int n from products where name = ?`, [kidName]);
      expect(n).toBe(0);
    });
  });
});
