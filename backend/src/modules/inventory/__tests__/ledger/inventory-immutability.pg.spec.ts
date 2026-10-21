import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { seedOrganization, createProduct, SeededOrg, withCutoverFreeze } from '../../../../../test/inventory-fixtures';
import { InventoryPostingService } from '../../ledger/inventory-posting.service';
import { InventoryTransaction } from '../../entities/inventory-transaction.entity';
import { InventoryCommand } from '../../ledger/inventory.types';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * P5-B1 — the interim enforcement mechanisms, INCLUDING their limit.
 *
 * The runtime role owns these tables (platform baseline F3), so a trigger
 * cannot be a security boundary against that role: it can disable or drop it.
 * What the triggers genuinely give is refusal of ordinary DML, which is real
 * and worth having — and the last test in this file proves the bypass exists,
 * so the limitation lives in the suite rather than only in a comment.
 *
 * P5-C2B CLOSED THAT BYPASS FOR THE RUNTIME (`Migration20260821140000`): the
 * application role is no longer the owner and holds no DML on these tables, so
 * it can neither write them directly nor take the guard off. The last test here
 * still passes, and must: this suite connects as the OWNER, and an owner can
 * always disable its own triggers. That is exactly why the boundary had to be
 * ownership rather than a trigger.
 * `inventory-privilege-split.pg.spec.ts` proves the other side by connecting as
 * the runtime role and being refused.
 */
d('P5-B1 ledger immutability and projection exclusivity (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let seed: SeededOrg;
  let posting: any;
  let transactionId: string;
  let productId: string;

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    seed = await seedOrganization(em, 'immutable');
    posting = Object.create(InventoryPostingService.prototype);
    posting.transactionRepository = em.getRepository(InventoryTransaction);
    productId = await createProduct(em, seed.organizationId);
    // P5-X1: an opening posts only inside a declared cutover window.
    const posted: any = await withCutoverFreeze(em, seed.organizationId, () =>
      posting.post({
        organizationId: seed.organizationId,
        type: 'OPENING_BALANCE',
        idempotencyKey: 'immutability-seed',
        principal: { kind: 'USER', userId: '77777777-7777-4777-8777-777777777777' },
        intents: [{ productId, declaredAmount: 7, intentSign: 1 }],
        movements: [
          {
            productId,
            locationId: seed.warehouseId,
            physicalCondition: 'GOOD',
            operationalState: 'AVAILABLE',
            quantityDelta: 7,
          },
        ],
      } as InventoryCommand),
    );
    transactionId = posted.transactionId;
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  describe('append-only ledger', () => {
    it('refuses UPDATE of a posted entry', async () => {
      await expect(
        em.execute(`update inventory_entries set quantity_delta = 1 where transaction_id = ?::uuid`, [transactionId]),
      ).rejects.toThrow(/immutable/i);
    });

    it('refuses DELETE of a posted entry', async () => {
      await expect(
        em.execute(`delete from inventory_entries where transaction_id = ?::uuid`, [transactionId]),
      ).rejects.toThrow(/immutable/i);
    });

    it('refuses UPDATE of a posted transaction', async () => {
      await expect(
        em.execute(`update inventory_transactions set type = 'ADJUSTMENT' where id = ?::uuid`, [transactionId]),
      ).rejects.toThrow(/immutable/i);
    });

    it('refuses DELETE of a posted transaction', async () => {
      await expect(
        em.execute(`delete from inventory_transactions where id = ?::uuid`, [transactionId]),
      ).rejects.toThrow(/immutable/i);
    });

    it('refuses UPDATE of a declared intent', async () => {
      await expect(
        em.execute(`update inventory_transaction_intents set declared_amount = 99 where transaction_id = ?::uuid`, [
          transactionId,
        ]),
      ).rejects.toThrow(/immutable/i);
    });

    it('refuses DELETE of a declared intent', async () => {
      await expect(
        em.execute(`delete from inventory_transaction_intents where transaction_id = ?::uuid`, [transactionId]),
      ).rejects.toThrow(/immutable/i);
    });

    it('still allows INSERT — the ledger is append-only, not read-only', async () => {
      const rows: { n: number }[] = await em.execute(
        `select count(*)::int as n from inventory_entries where transaction_id = ?::uuid`,
        [transactionId],
      );
      expect(rows[0].n).toBe(1);
    });
  });

  describe('projection exclusivity', () => {
    it('refuses a direct INSERT into the located projection', async () => {
      await expect(
        em.execute(
          `insert into inventory_balances (organization_id, location_id, product_id, physical_condition, operational_state, quantity, updated_at)
           values (?::uuid, ?::uuid, ?::uuid, 'GOOD', 'AVAILABLE', 5, now())`,
          [seed.organizationId, seed.storeLocationId, productId],
        ),
      ).rejects.toThrow(/posting mechanism/i);
    });

    it('refuses a direct UPDATE of the located projection', async () => {
      await expect(
        em.execute(`update inventory_balances set quantity = 999 where product_id = ?::uuid`, [productId]),
      ).rejects.toThrow(/posting mechanism/i);
    });

    it('refuses a direct DELETE from the located projection', async () => {
      await expect(
        em.execute(`delete from inventory_balances where product_id = ?::uuid`, [productId]),
      ).rejects.toThrow(/posting mechanism/i);
    });

    it('refuses a direct write to the transit projection', async () => {
      await expect(
        em.execute(
          `insert into inventory_transit_balances (organization_id, transfer_id, transit_direction, product_id, physical_condition, quantity, updated_at)
           values (?::uuid, gen_random_uuid(), 'DISPATCH', ?::uuid, 'GOOD', 3, now())`,
          [seed.organizationId, productId],
        ),
      ).rejects.toThrow(/posting mechanism/i);
    });

    it('the posting flag is transaction-local and does not leak', async () => {
      await em.execute(`select set_config('cataloguer.posting', 'on', true)`);
      // A new statement outside that transaction sees the flag unset again.
      const rows: { setting: string }[] = await em.execute(
        `select coalesce(current_setting('cataloguer.posting', true), '') as setting`,
      );
      expect(rows[0].setting).not.toBe('on');
      await expect(
        em.execute(`update inventory_balances set quantity = 1 where product_id = ?::uuid`, [productId]),
      ).rejects.toThrow(/posting mechanism/i);
    });

    it('the posting mechanism itself writes them without objection', async () => {
      const rows: { quantity: number }[] = await em.execute(
        `select quantity from inventory_balances where product_id = ?::uuid`,
        [productId],
      );
      expect(rows[0].quantity).toBe(7);
    });
  });

  describe('location identity is immutable', () => {
    it.each([
      ['code', `update inventory_locations set code = 'RENAMED' where id = ?::uuid`],
      ['kind', `update inventory_locations set kind = 'STORE' where id = ?::uuid`],
      ['store', `update inventory_locations set store_id = gen_random_uuid() where id = ?::uuid`],
    ])('refuses changing %s after creation', async (_field, sql) => {
      await expect(em.execute(sql, [seed.warehouseId])).rejects.toThrow(/identity is immutable/i);
    });

    it('refuses moving a location to another organization', async () => {
      const other = await seedOrganization(em, 'identity-other');
      await expect(
        em.execute(`update inventory_locations set organization_id = ?::uuid where id = ?::uuid`, [
          other.organizationId,
          seed.warehouseId,
        ]),
      ).rejects.toThrow(/identity is immutable/i);
    });

    it('still allows the mutable fields', async () => {
      await expect(
        em.execute(`update inventory_locations set name = 'Renamed warehouse' where id = ?::uuid`, [seed.warehouseId]),
      ).resolves.toBeDefined();
      const rows: { name: string; code: string }[] = await em.execute(
        `select name, code from inventory_locations where id = ?::uuid`,
        [seed.warehouseId],
      );
      expect(rows[0].name).toBe('Renamed warehouse');
      expect(rows[0].code).not.toBe('Renamed warehouse');
    });
  });

  describe('the honest limit of these mechanisms', () => {
    /**
     * Recorded as an executable fact, not a caveat in prose: the owning role can
     * take the guard off. This is unchanged by P5-C2B and always will be — an
     * owner can disable its own triggers, which is precisely why the boundary
     * had to be built out of OWNERSHIP rather than out of triggers. What C2B
     * changed is that the application is no longer that owner.
     */
    it('the owning role can disable the guard, which is why C2B had to be ownership', async () => {
      await em.execute(`alter table inventory_balances disable trigger inventory_balances_posting_only`);
      await expect(
        em.execute(`update inventory_balances set quantity = quantity + 1 where product_id = ?::uuid`, [productId]),
      ).resolves.toBeDefined();
      await em.execute(`alter table inventory_balances enable trigger inventory_balances_posting_only`);
      await expect(
        em.execute(`update inventory_balances set quantity = quantity - 1 where product_id = ?::uuid`, [productId]),
      ).rejects.toThrow(/posting mechanism/i);
    });
  });
});
