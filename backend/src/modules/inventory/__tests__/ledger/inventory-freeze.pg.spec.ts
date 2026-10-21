import { EntityManager } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { seedOrganization, createProduct, SeededOrg, withCutoverFreeze } from '../../../../../test/inventory-fixtures';
import { InventoryPostingService } from '../../ledger/inventory-posting.service';
import { InventoryTransaction } from '../../entities/inventory-transaction.entity';
import { InventoryCommand, InventoryPrincipal, TRANSACTION_TYPES } from '../../ledger/inventory.types';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const USER: InventoryPrincipal = { kind: 'USER', userId: '66666666-6666-4666-8666-666666666666' };

/**
 * P5-X1 — the organization cutover freeze, against real PostgreSQL.
 *
 * WHY THIS SUITE IS SHORT AND STILL COMPLETE. P5-B3 converted all seventeen
 * legacy stock writers into ledger commands, and `inventory-writer-census`
 * asserts that exactly one construct still writes a legacy stock column. So
 * "every writer class is covered" does not require seventeen tests: it requires
 * proving that the ONE path they all traverse refuses while frozen, and that
 * no type slips through it. The type table is walked exhaustively below rather
 * than sampled, so a transaction type added later without a decision about the
 * freeze fails here.
 */
d('P5-X1 organization cutover freeze (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let seed: SeededOrg;
  let service: any;

  const freeze = async (organizationId: string): Promise<void> => {
    await em.execute('update organizations set inventory_cutover_frozen_at = now() where id = ?', [organizationId]);
  };
  const unfreeze = async (organizationId: string): Promise<void> => {
    await em.execute('update organizations set inventory_cutover_frozen_at = null where id = ?', [organizationId]);
  };

  const opening = (productId: string, quantity: number, key: string): InventoryCommand =>
    ({
      organizationId: seed.organizationId,
      type: 'OPENING_BALANCE',
      idempotencyKey: key,
      principal: USER,
      intents: [{ productId, declaredAmount: quantity, intentSign: 1 }],
      movements: [
        {
          productId,
          locationId: seed.warehouseId,
          physicalCondition: 'GOOD',
          operationalState: 'AVAILABLE',
          quantityDelta: quantity,
        },
      ],
    }) as InventoryCommand;

  const reserve = (productId: string, key: string, quantity = 1): InventoryCommand =>
    ({
      organizationId: seed.organizationId,
      type: 'RESERVE',
      idempotencyKey: key,
      principal: USER,
      intents: [{ productId, declaredAmount: quantity, intentSign: 0 }],
      movements: [
        {
          productId,
          locationId: seed.warehouseId,
          physicalCondition: 'GOOD',
          operationalState: 'AVAILABLE',
          quantityDelta: -quantity,
        },
        {
          productId,
          locationId: seed.warehouseId,
          physicalCondition: 'GOOD',
          operationalState: 'RESERVED',
          quantityDelta: quantity,
        },
      ],
    }) as InventoryCommand;

  const rowCounts = async (): Promise<Record<string, number>> => {
    const rows: Record<string, number>[] = await em.execute(
      `select (select count(*)::int from inventory_transactions) as transactions,
              (select count(*)::int from inventory_entries) as entries,
              (select count(*)::int from inventory_balances) as balances`,
    );
    return rows[0];
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    seed = await seedOrganization(em, 'freeze');
    service = Object.create(InventoryPostingService.prototype);
    service.transactionRepository = em.getRepository(InventoryTransaction);
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  afterEach(async () => {
    await unfreeze(seed.organizationId);
  });

  describe('the column itself', () => {
    it('exists, is nullable, and every organization starts unfrozen', async () => {
      const columns: { is_nullable: string; column_default: string | null }[] = await em.execute(
        `select is_nullable, column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'organizations'
            and column_name = 'inventory_cutover_frozen_at'`,
      );
      expect(columns).toHaveLength(1);
      expect(columns[0].is_nullable).toBe('YES');
      expect(columns[0].column_default).toBeNull();

      const frozen: { n: number }[] = await em.execute(
        'select count(*)::int as n from organizations where inventory_cutover_frozen_at is not null',
      );
      expect(frozen[0].n).toBe(0);
    });
  });

  describe('while frozen', () => {
    /**
     * Exhaustive over the type table, and deliberately against the rule itself
     * rather than through `post()`.
     *
     * `assertCommandShape` runs first and is pure — a RESERVE-shaped payload
     * relabelled FAMILY_STOCK_DISTRIBUTION is malformed whatever the freeze
     * says, so driving fifteen types through `post()` would need fifteen valid
     * payloads and would still be testing shape validation. Here the freeze
     * rule is asked about every type directly; the tests that follow prove it
     * is actually wired into the choke point with real, valid commands.
     */
    it('answers every transaction type, and admits only the opening while frozen', async () => {
      await freeze(seed.organizationId);
      expect(TRANSACTION_TYPES.length).toBeGreaterThan(10);

      for (const type of TRANSACTION_TYPES) {
        const attempt = service.assertCutoverFreeze(em, { organizationId: seed.organizationId, type });
        if (type === 'OPENING_BALANCE') {
          await expect(attempt).resolves.toBeUndefined();
        } else {
          await expect(attempt).rejects.toThrow(/frozen for the inventory cutover/);
        }
      }
    });

    it('answers every transaction type while UNFROZEN, refusing only the opening', async () => {
      for (const type of TRANSACTION_TYPES) {
        const attempt = service.assertCutoverFreeze(em, { organizationId: seed.organizationId, type });
        if (type === 'OPENING_BALANCE') {
          await expect(attempt).rejects.toThrow(/may only post while the organization is frozen/);
        } else {
          await expect(attempt).resolves.toBeUndefined();
        }
      }
    });

    it('writes nothing when it refuses', async () => {
      const product = await createProduct(em, seed.organizationId);
      await withCutoverFreeze(em, seed.organizationId, () => service.post(opening(product, 5, 'freeze-nothing')));
      await freeze(seed.organizationId);

      const before = await rowCounts();
      await expect(service.post(reserve(product, 'refused-write'))).rejects.toBeInstanceOf(ConflictException);
      expect(await rowCounts()).toEqual(before);
    });

    it('refuses a REPLAY of a command that succeeded before the window', async () => {
      // A replay writes nothing, but returning a transaction id would tell a
      // caller its request was accepted during a window that exists precisely
      // because no caller should be posting.
      const product = await createProduct(em, seed.organizationId);
      await withCutoverFreeze(em, seed.organizationId, () => service.post(opening(product, 9, 'replay-seed')));
      const key = 'replay-across-the-window';
      const first = await service.post(reserve(product, key));
      expect(first.replayed).toBe(false);

      await freeze(seed.organizationId);
      await expect(service.post(reserve(product, key))).rejects.toThrow(/frozen for the inventory cutover/);
    });

    it('admits the opening epoch, which is why the window exists', async () => {
      const product = await createProduct(em, seed.organizationId);
      await freeze(seed.organizationId);
      const posted = await service.post(opening(product, 11, 'epoch-while-frozen'));
      expect(posted.replayed).toBe(false);

      const balance: { quantity: number }[] = await em.execute(
        `select quantity from inventory_balances where product_id = ?::uuid and location_id = ?::uuid`,
        [product, seed.warehouseId],
      );
      expect(balance[0].quantity).toBe(11);
    });

    it('does not leak across organizations — a sibling keeps trading', async () => {
      const other = await seedOrganization(em, 'freeze-sibling');
      await freeze(seed.organizationId);

      const theirs = await withCutoverFreeze(em, other.organizationId, () =>
        service.post({
          organizationId: other.organizationId,
          type: 'OPENING_BALANCE',
          idempotencyKey: 'sibling-open',
          principal: USER,
          intents: [{ productId: other.productId, declaredAmount: 3, intentSign: 1 }],
          movements: [
            {
              productId: other.productId,
              locationId: other.warehouseId,
              physicalCondition: 'GOOD',
              operationalState: 'AVAILABLE',
              quantityDelta: 3,
            },
          ],
        } as InventoryCommand),
      );
      expect((theirs as any).replayed).toBe(false);

      const ordinary = await service.post({
        organizationId: other.organizationId,
        type: 'RESERVE',
        idempotencyKey: 'sibling-reserve',
        principal: USER,
        intents: [{ productId: other.productId, declaredAmount: 1, intentSign: 0 }],
        movements: [
          {
            productId: other.productId,
            locationId: other.warehouseId,
            physicalCondition: 'GOOD',
            operationalState: 'AVAILABLE',
            quantityDelta: -1,
          },
          {
            productId: other.productId,
            locationId: other.warehouseId,
            physicalCondition: 'GOOD',
            operationalState: 'RESERVED',
            quantityDelta: 1,
          },
        ],
      } as InventoryCommand);
      expect(ordinary.replayed).toBe(false);
    });
  });

  describe('while unfrozen', () => {
    it('refuses an opening epoch outside a declared window', async () => {
      const product = await createProduct(em, seed.organizationId);
      await expect(service.post(opening(product, 4, 'epoch-unfrozen'))).rejects.toThrow(
        /may only post while the organization is frozen/,
      );
    });

    it('admits ordinary postings', async () => {
      const product = await createProduct(em, seed.organizationId);
      await withCutoverFreeze(em, seed.organizationId, () => service.post(opening(product, 6, 'ordinary-seed')));
      const posted = await service.post(reserve(product, 'ordinary-reserve'));
      expect(posted.replayed).toBe(false);
    });
  });

  it('refuses an organization that does not exist rather than reading it as unfrozen', async () => {
    const product = await createProduct(em, seed.organizationId);
    await expect(
      service.post({
        ...opening(product, 1, 'ghost-org'),
        organizationId: '00000000-0000-4000-8000-000000000000',
      } as InventoryCommand),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
