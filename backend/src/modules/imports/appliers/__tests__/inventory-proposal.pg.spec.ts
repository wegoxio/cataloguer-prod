import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { InventoryProposalApplier } from '../inventory-proposal.applier';
import { InventoryPostingService } from '../../../inventory/ledger/inventory-posting.service';
import { classifyInventoryIntents, InventoryContext } from '../../inventory/inventory-proposal';
import { PlannedUnit } from '../../execution/batch-planner';
import { RowOutcome } from '../../entities/import-row-result.entity';
import { storeLocationCode } from '../../../inventory/ledger/inventory.types';
import { defaultWarehouseCode } from '../../../inventory/opening/inventory-opening.types';
import { InventoryTransaction } from '../../../inventory/entities/inventory-transaction.entity';

/**
 * The posting service takes the transaction REPOSITORY, and `postWithin` is
 * handed the transaction's own EntityManager separately — so a service built
 * from any repository posts correctly inside whichever transaction it is given.
 */
const postingFor = (manager: EntityManager) =>
  new InventoryPostingService(manager.getRepository(InventoryTransaction) as never);

/**
 * Importing stock WITHOUT becoming a second writer.
 *
 * The whole point of this applier is that it goes through the ledger rather
 * than around it. So the proofs are: a ledger transaction appears, the
 * compatibility caches follow it, a retry replays instead of doubling, and the
 * applier's own source contains no direct stock write for the census to find.
 */

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

d('inventory proposals through the ledger (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let organizationId: string;
  let storeId: string;
  let storeLocationId: string;
  let productId: string;
  let userId: string;

  const exec = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
    pg.orm.em.getConnection().execute(sql, params) as Promise<T>;

  const context = (executionId = randomUUID()) => ({
    organizationId,
    executionId,
    importType: 'PRODUCTS',
    approvedByUserId: userId,
    em: em,
  });

  const inventoryContext = (): InventoryContext => ({
    allowedStoreIds: new Set([storeId]),
    storeLocationIds: new Map([[storeId, storeLocationId]]),
    frozen: false,
    hasDefaultWarehouse: true,
  });

  const unit = (mutations: unknown[]): PlannedUnit => ({ kind: 'ROW', sourceRows: [2], mutations }) as PlannedUnit;

  beforeAll(async () => {
    pg = await withDisposablePg();
    em = pg.orm.em.fork() as EntityManager;
    organizationId = (
      await exec<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), 'Ledger Co', ?, now(), now()) returning id`,
        [`ledger-co-${Date.now()}`],
      )
    )[0].id;

    // A real user row, because the posting's principal is part of the
    // command's identity and the column is a foreign key.
    const [role] = await exec<{ id: string }[]>(`select id from roles where name = 'ORGANIZATION_MANAGER'`);
    userId = (
      await exec<{ id: string }[]>(
        `insert into users (email, role_id, organization_id, store_id, password_hash, created_at, updated_at)
         values (?, ?, ?, null, 'set', now(), now()) returning id`,
        [`importer-${randomUUID().slice(0, 8)}@example.test`, role.id, organizationId],
      )
    )[0].id;

    storeId = (
      await exec<{ id: string }[]>(
        `insert into stores (id, name, slug, organization_id, created_at, updated_at)
         values (gen_random_uuid(), 'Centro', ?, ?, now(), now()) returning id`,
        [`centro-${randomUUID().slice(0, 8)}`, organizationId],
      )
    )[0].id;

    // The posting surface requires exactly one default warehouse per company.
    await exec(
      `insert into inventory_locations (id, organization_id, kind, code, name, is_default, created_at, updated_at)
       values (gen_random_uuid(), ?, 'WAREHOUSE', ?, 'Almacén', true, now(), now())`,
      [organizationId, defaultWarehouseCode(organizationId)],
    );

    storeLocationId = (
      await exec<{ id: string }[]>(
        `insert into inventory_locations (id, organization_id, kind, code, name, store_id, created_at, updated_at)
         values (gen_random_uuid(), ?, 'STORE', ?, 'Centro', ?, now(), now()) returning id`,
        [organizationId, storeLocationCode(storeId), storeId],
      )
    )[0].id;

    productId = (
      await exec<{ id: string }[]>(
        `insert into products (id, name, slug, status, organization_id, price, stock_quantity, created_at, updated_at)
         values (gen_random_uuid(), 'Silla', ?, 'PUBLISHED', ?, 10, 0, now(), now()) returning id`,
        [`silla-${randomUUID()}`, organizationId],
      )
    )[0].id;

    // The shop pivot exists because the product is sold there. The cache
    // refresh updates rows that exist; it does not decide which shops carry a
    // product, which is a catalogue decision rather than an inventory one.
    await exec(
      `insert into store_products (organization_id, store_id, product_id, published, stock_quantity, track_inventory, created_at, updated_at)
       values (?, ?, ?, true, 0, true, now(), now())`,
      [organizationId, storeId, productId],
    );
  }, 300_000);

  afterAll(async () => {
    await pg?.close();
  });

  const proposalsFor = (quantity: number, sourceRow = 2) =>
    classifyInventoryIntents(
      [
        {
          sourceRow,
          productId,
          allocations: [{ storeId, quantity, condition: 'GOOD' as const }],
        },
      ],
      inventoryContext(),
    ).proposals;

  describe('posting through the authorised surface', () => {
    it('writes a ledger transaction rather than a stock column', async () => {
      const executionId = randomUUID();
      const results = await em.transactional(async (tem) =>
        new InventoryProposalApplier(postingFor(tem as EntityManager)).apply(
          unit(proposalsFor(12)),
          context(executionId),
        ),
      );

      expect(results[0].outcome).toBe(RowOutcome.UPDATED);
      expect(results[0].targetType).toBe('inventory-transaction');

      const [transaction] = await exec<{ type: string }[]>(`select type from inventory_transactions where id = ?`, [
        results[0].targetId,
      ]);
      // ADJUSTMENT, not OPENING_BALANCE: an import is ordinary operation, and
      // an opening balance outside a declared cutover window is refused.
      expect(transaction.type).toBe('ADJUSTMENT');
    });

    it('leaves the compatibility caches agreeing with the ledger', async () => {
      // Refreshed by the posting service's ONE authorised writer, inside the
      // same transaction. The import never touches them.
      const [product] = await exec<{ stock_quantity: number }[]>(`select stock_quantity from products where id = ?`, [
        productId,
      ]);
      const [pivot] = await exec<{ stock_quantity: number }[]>(
        `select stock_quantity from store_products where product_id = ? and store_id = ?`,
        [productId, storeId],
      );
      expect(Number(product.stock_quantity)).toBe(12);
      expect(Number(pivot?.stock_quantity ?? 0)).toBe(12);
    });

    it('attributes the posting to the person who approved it', async () => {
      // A system origin would say nobody decided the stock was correct.
      const [transaction] = await exec<{ actor_kind: string; actor_user_id: string | null }[]>(
        `select actor_kind, actor_user_id from inventory_transactions
          where organization_id = ? order by posted_at desc limit 1`,
        [organizationId],
      );
      expect(transaction.actor_kind).toBe('USER');
      expect(transaction.actor_user_id).toBe(userId);
    });
  });

  describe('a retried run', () => {
    it('REPLAYS the posting instead of doubling the stock', async () => {
      // The idempotency key is bound to the execution and the source row, and
      // the posting surface returns the original transaction for a repeat.
      const executionId = randomUUID();
      const before = await exec<{ count: string }[]>(
        `select count(*)::text as count from inventory_transactions where organization_id = ?`,
        [organizationId],
      );

      const first = await em.transactional(async (tem) =>
        new InventoryProposalApplier(postingFor(tem as EntityManager)).apply(
          unit(proposalsFor(5, 30)),
          context(executionId),
        ),
      );
      const second = await em.transactional(async (tem) =>
        new InventoryProposalApplier(postingFor(tem as EntityManager)).apply(
          unit(proposalsFor(5, 30)),
          context(executionId),
        ),
      );

      expect(first[0].outcome).toBe(RowOutcome.UPDATED);
      expect(second[0].outcome).toBe(RowOutcome.SKIPPED);
      expect(second[0].reason).toMatch(/already been posted/);
      expect(second[0].targetId).toBe(first[0].targetId);

      const after = await exec<{ count: string }[]>(
        `select count(*)::text as count from inventory_transactions where organization_id = ?`,
        [organizationId],
      );
      expect(Number(after[0].count)).toBe(Number(before[0].count) + 1);
    });
  });

  describe('a declared zero', () => {
    it('is honoured as a decision and moves nothing', async () => {
      // A ledger entry may not carry a zero delta, and inventing an empty
      // transaction to look tidy would be a lie in the ledger.
      const { proposals } = classifyInventoryIntents(
        [{ sourceRow: 40, productId, organizationTotal: 0 }],
        inventoryContext(),
      );
      const before = await exec<{ count: string }[]>(
        `select count(*)::text as count from inventory_transactions where organization_id = ?`,
        [organizationId],
      );

      const results = await em.transactional(async (tem) =>
        new InventoryProposalApplier(postingFor(tem as EntityManager)).apply(
          unit(proposals),
          context(),
        ),
      );

      expect(results[0].outcome).toBe(RowOutcome.SKIPPED);
      expect(results[0].reason).toMatch(/holding nothing/);
      const after = await exec<{ count: string }[]>(
        `select count(*)::text as count from inventory_transactions where organization_id = ?`,
        [organizationId],
      );
      expect(after[0].count).toBe(before[0].count);
    });
  });

  describe('the applier is not a second writer', () => {
    it('contains no direct stock-column write in its own source', () => {
      // Comments stripped first: the file explains at length what it must not
      // do, and a scan of the raw text would fail on the explanation.
      const source = readFileSync(join(__dirname, '..', 'inventory-proposal.applier.ts'), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      const forbidden = ['stock_quantity', 'update products', 'update store_products', 'inventory_entries'];
      expect(forbidden.filter((token) => source.includes(token))).toEqual([]);
    });

    it('reaches the ledger only through postWithin', () => {
      const source = readFileSync(join(__dirname, '..', 'inventory-proposal.applier.ts'), 'utf8');
      expect(source).toContain('this.posting.postWithin(');
      // Not `post()`, which opens its own transaction — the ledger entry, the
      // cache refresh and the batch checkpoint must share one commit.
      expect(source).not.toMatch(/this\.posting\.post\(/);
    });
  });
});

if (!gate.enabled) {
  // eslint-disable-next-line no-console
  console.log(`inventory proposal PG suite skipped: ${gate.reason}`);
}
