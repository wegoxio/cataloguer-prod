import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import {
  seedOrganization,
  SeededOrg,
  triggerAndFunctionCounts,
  triggerAndFunctionNames,
} from '../../../../../test/inventory-fixtures';
import { storeLocationCode } from '../../ledger/inventory.types';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/** The revision immediately before the inventory ledger. */
const PRE_B1 = 'Migration20260819140000';
/** This boundary's own migration. */
const B1 = 'Migration20260820120000';

/**
 * P5-B1 — what the DATABASE refuses.
 *
 * Every proof here is raw SQL. A service-level check is precisely what these
 * constraints exist not to depend on: the whole point of the composite
 * references and the CHECKs is that an over-draw or a cross-tenant pairing is
 * refused even when the application is wrong.
 */
d('P5-B1 inventory schema integrity (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let seed: SeededOrg;
  let other: SeededOrg;
  /** A real transfer: from P5-B5 an IN_TRANSIT entry must name one. */
  let transferId: string;

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    seed = await seedOrganization(em, 'alpha');
    other = await seedOrganization(em, 'beta');
    const [transfer]: { id: string }[] = await em.execute(
      `insert into inventory_transfers
         (organization_id, source_location_id, destination_location_id, status, created_at, updated_at)
       values (?::uuid, ?::uuid, ?::uuid, 'DRAFT', now(), now()) returning id`,
      [seed.organizationId, seed.warehouseId, seed.storeLocationId],
    );
    transferId = transfer.id;
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  const expectRefusal = async (sql: string, params: unknown[], pattern: RegExp) => {
    await expect(em.execute(sql, params)).rejects.toThrow(pattern);
  };

  describe('tenancy', () => {
    it('refuses a STORE location claiming another organization store', async () => {
      // A store with no custody location yet, so the one-per-store index cannot
      // fire first and mask the tenancy failure this test is about.
      const [bare]: { id: string }[] = await em.execute(
        `insert into stores (name, slug, organization_id, created_at, updated_at)
         values (?, ?, ?::uuid, now(), now()) returning id`,
        [`bare-${Date.now()}`, `bare-${Date.now()}`, other.organizationId],
      );
      await expectRefusal(
        `insert into inventory_locations (organization_id, kind, code, name, store_id, is_default, created_at, updated_at)
         values (?::uuid, 'STORE', ?, 'foreign', ?::uuid, false, now(), now())`,
        [seed.organizationId, storeLocationCode(bare.id), bare.id],
        /inventory_locations_store_tenant_foreign/,
      );
    });

    it('refuses an entry pairing a product and a location of different organizations', async () => {
      const [tx]: { id: string }[] = await em.execute(
        `insert into inventory_transactions (organization_id, type, idempotency_key, command_fingerprint, actor_kind, actor_user_id, posted_at)
         values (?::uuid, 'ADJUSTMENT', ?, repeat('a', 64), 'USER', gen_random_uuid(), now()) returning id`,
        [seed.organizationId, `tenancy-${Date.now()}`],
      );
      await expectRefusal(
        `insert into inventory_entries (transaction_id, organization_id, product_id, location_id,
            physical_condition, operational_state, quantity_delta, created_at)
         values (?::uuid, ?::uuid, ?::uuid, ?::uuid, 'GOOD', 'AVAILABLE', 1, now())`,
        [tx.id, seed.organizationId, seed.productId, other.warehouseId],
        /inventory_entries_location_tenant_foreign/,
      );
    });

    it('refuses an entry whose product belongs to another organization', async () => {
      const [tx]: { id: string }[] = await em.execute(
        `insert into inventory_transactions (organization_id, type, idempotency_key, command_fingerprint, actor_kind, actor_user_id, posted_at)
         values (?::uuid, 'ADJUSTMENT', ?, repeat('b', 64), 'USER', gen_random_uuid(), now()) returning id`,
        [seed.organizationId, `tenancy2-${Date.now()}`],
      );
      await expectRefusal(
        `insert into inventory_entries (transaction_id, organization_id, product_id, location_id,
            physical_condition, operational_state, quantity_delta, created_at)
         values (?::uuid, ?::uuid, ?::uuid, ?::uuid, 'GOOD', 'AVAILABLE', 1, now())`,
        [tx.id, seed.organizationId, other.productId, seed.warehouseId],
        /inventory_entries_product_tenant_foreign/,
      );
    });

    it('refuses an audit store from another organization', async () => {
      await expectRefusal(
        `insert into inventory_transactions (organization_id, type, idempotency_key, command_fingerprint, audit_store_id, actor_kind, actor_user_id, posted_at)
         values (?::uuid, 'ADJUSTMENT', ?, repeat('c', 64), ?::uuid, 'USER', gen_random_uuid(), now())`,
        [seed.organizationId, `audit-${Date.now()}`, other.storeId],
        /inventory_transactions_audit_store_tenant_foreign/,
      );
    });

    it('accepts an audit store from the acting organization', async () => {
      await expect(
        em.execute(
          `insert into inventory_transactions (organization_id, type, idempotency_key, command_fingerprint, audit_store_id, actor_kind, actor_user_id, posted_at)
           values (?::uuid, 'ADJUSTMENT', ?, repeat('d', 64), ?::uuid, 'USER', gen_random_uuid(), now())`,
          [seed.organizationId, `audit-ok-${Date.now()}`, seed.storeId],
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('location identity', () => {
    it('allows at most one default warehouse per organization', async () => {
      await expectRefusal(
        `insert into inventory_locations (organization_id, kind, code, name, store_id, is_default, created_at, updated_at)
         values (?::uuid, 'WAREHOUSE', 'WH-SECOND', 'second', null, true, now(), now())`,
        [seed.organizationId],
        /inventory_locations_one_default_per_org/,
      );
    });

    it('lets a DIFFERENT organization have its own default warehouse', async () => {
      const rows: { n: number }[] = await em.execute(
        `select count(*)::int as n from inventory_locations where is_default and organization_id in (?::uuid, ?::uuid)`,
        [seed.organizationId, other.organizationId],
      );
      expect(rows[0].n).toBe(2);
    });

    it('refuses a default that is not a warehouse', async () => {
      await expectRefusal(
        `insert into inventory_locations (organization_id, kind, code, name, store_id, is_default, created_at, updated_at)
         values (?::uuid, 'STORE', ?, 'bad default', ?::uuid, true, now(), now())`,
        [other.organizationId, `STORE:bogus-${Date.now()}`, other.storeId],
        /inventory_locations_default_is_warehouse_check|inventory_locations_store_tenant_foreign/,
      );
    });

    it('refuses a WAREHOUSE that names a store', async () => {
      await expectRefusal(
        `insert into inventory_locations (organization_id, kind, code, name, store_id, is_default, created_at, updated_at)
         values (?::uuid, 'WAREHOUSE', 'WH-WITH-STORE', 'bad', ?::uuid, false, now(), now())`,
        [seed.organizationId, seed.storeId],
        /inventory_locations_store_kind_check/,
      );
    });

    it('refuses a STORE location without a store', async () => {
      await expectRefusal(
        `insert into inventory_locations (organization_id, kind, code, name, store_id, is_default, created_at, updated_at)
         values (?::uuid, 'STORE', 'STORE-NOBODY', 'bad', null, false, now(), now())`,
        [seed.organizationId],
        /inventory_locations_store_kind_check/,
      );
    });

    it('refuses a second custody location for the same store', async () => {
      await expectRefusal(
        `insert into inventory_locations (organization_id, kind, code, name, store_id, is_default, created_at, updated_at)
         values (?::uuid, 'STORE', ?, 'duplicate', ?::uuid, false, now(), now())`,
        [seed.organizationId, `STORE:dup-${Date.now()}`, seed.storeId],
        /inventory_locations_one_per_store/,
      );
    });

    it('refuses a duplicate code inside one organization', async () => {
      await expectRefusal(
        `insert into inventory_locations (organization_id, kind, code, name, store_id, is_default, created_at, updated_at)
         values (?::uuid, 'WAREHOUSE', (select code from inventory_locations where id = ?::uuid), 'dup', null, false, now(), now())`,
        [seed.organizationId, seed.warehouseId],
        /inventory_locations_organization_id_code_unique/,
      );
    });

    it('derives the store code from the immutable uuid, never the slug', async () => {
      const rows: { code: string; slug: string }[] = await em.execute(
        `select l.code, s.slug from inventory_locations l join stores s on s.id = l.store_id where l.id = ?::uuid`,
        [seed.storeLocationId],
      );
      expect(rows[0].code).toBe(`STORE:${seed.storeId}`);
      expect(rows[0].code).not.toContain(rows[0].slug);
    });
  });

  describe('the located / transit partition', () => {
    const entry = async (fields: Record<string, unknown>) => {
      const [tx]: { id: string }[] = await em.execute(
        `insert into inventory_transactions (organization_id, type, idempotency_key, command_fingerprint, actor_kind, actor_user_id, posted_at)
         values (?::uuid, 'ADJUSTMENT', ?, repeat('e', 64), 'USER', gen_random_uuid(), now()) returning id`,
        [seed.organizationId, `partition-${Math.random()}`],
      );
      return em.execute(
        `insert into inventory_entries (transaction_id, organization_id, product_id, location_id,
            physical_condition, operational_state, transfer_id, transit_direction, quantity_delta, created_at)
         values (?::uuid, ?::uuid, ?::uuid, ?::uuid, 'GOOD', ?, ?::uuid, ?, 1, now())`,
        [
          tx.id,
          seed.organizationId,
          seed.productId,
          fields.locationId ?? null,
          fields.state,
          fields.transferId ?? null,
          fields.direction ?? null,
        ],
      );
    };

    it('refuses IN_TRANSIT with a location', async () => {
      await expect(
        entry({ state: 'IN_TRANSIT', locationId: seed.warehouseId, transferId, direction: 'DISPATCH' }),
      ).rejects.toThrow(/inventory_entries_transit_coherence_check/);
    });

    it('refuses IN_TRANSIT without a transfer', async () => {
      await expect(entry({ state: 'IN_TRANSIT', direction: 'DISPATCH' })).rejects.toThrow(
        /inventory_entries_transit_coherence_check/,
      );
    });

    it('refuses IN_TRANSIT without a direction', async () => {
      await expect(entry({ state: 'IN_TRANSIT', transferId })).rejects.toThrow(
        /inventory_entries_transit_coherence_check/,
      );
    });

    it('refuses a located entry that names a transfer', async () => {
      await expect(
        entry({ state: 'AVAILABLE', locationId: seed.warehouseId, transferId, direction: 'DISPATCH' }),
      ).rejects.toThrow(/inventory_entries_transit_coherence_check/);
    });

    it('refuses a located entry with no location', async () => {
      await expect(entry({ state: 'AVAILABLE' })).rejects.toThrow(/inventory_entries_transit_coherence_check/);
    });

    it('accepts a well-formed transit entry', async () => {
      await expect(entry({ state: 'IN_TRANSIT', transferId, direction: 'DISPATCH' })).resolves.toBeDefined();
    });

    it('keeps IN_TRANSIT out of the located projection entirely', async () => {
      await expect(
        em.execute(
          `insert into inventory_balances (organization_id, location_id, product_id, physical_condition, operational_state, quantity, updated_at)
           values (?::uuid, ?::uuid, ?::uuid, 'GOOD', 'IN_TRANSIT', 1, now())`,
          [seed.organizationId, seed.warehouseId, seed.productId],
        ),
      ).rejects.toThrow(/inventory_balances_state_check|posting mechanism/);
    });
  });

  describe('quantity constraints', () => {
    it('refuses a zero-delta entry', async () => {
      const [tx]: { id: string }[] = await em.execute(
        `insert into inventory_transactions (organization_id, type, idempotency_key, command_fingerprint, actor_kind, actor_user_id, posted_at)
         values (?::uuid, 'ADJUSTMENT', ?, repeat('f', 64), 'USER', gen_random_uuid(), now()) returning id`,
        [seed.organizationId, `zero-${Date.now()}`],
      );
      await expectRefusal(
        `insert into inventory_entries (transaction_id, organization_id, product_id, location_id,
            physical_condition, operational_state, quantity_delta, created_at)
         values (?::uuid, ?::uuid, ?::uuid, ?::uuid, 'GOOD', 'AVAILABLE', 0, now())`,
        [tx.id, seed.organizationId, seed.productId, seed.warehouseId],
        /inventory_entries_nonzero_check/,
      );
    });

    it('refuses a malformed fingerprint', async () => {
      await expectRefusal(
        `insert into inventory_transactions (organization_id, type, idempotency_key, command_fingerprint, actor_kind, actor_user_id, posted_at)
         values (?::uuid, 'ADJUSTMENT', ?, 'not-a-sha', 'USER', gen_random_uuid(), now())`,
        [seed.organizationId, `fp-${Date.now()}`],
        /inventory_transactions_fingerprint_shape_check/,
      );
    });

    it('refuses a non-positive declared amount', async () => {
      const [tx]: { id: string }[] = await em.execute(
        `insert into inventory_transactions (organization_id, type, idempotency_key, command_fingerprint, actor_kind, actor_user_id, posted_at)
         values (?::uuid, 'ADJUSTMENT', ?, repeat('1', 64), 'USER', gen_random_uuid(), now()) returning id`,
        [seed.organizationId, `intent-${Date.now()}`],
      );
      await expectRefusal(
        `insert into inventory_transaction_intents (transaction_id, organization_id, product_id, declared_amount, intent_sign)
         values (?::uuid, ?::uuid, ?::uuid, 0, 1)`,
        [tx.id, seed.organizationId, seed.productId],
        /inventory_transaction_intents_amount_check/,
      );
    });

    it('refuses an out-of-range intent sign', async () => {
      const [tx]: { id: string }[] = await em.execute(
        `insert into inventory_transactions (organization_id, type, idempotency_key, command_fingerprint, actor_kind, actor_user_id, posted_at)
         values (?::uuid, 'ADJUSTMENT', ?, repeat('2', 64), 'USER', gen_random_uuid(), now()) returning id`,
        [seed.organizationId, `sign-${Date.now()}`],
      );
      await expectRefusal(
        `insert into inventory_transaction_intents (transaction_id, organization_id, product_id, declared_amount, intent_sign)
         values (?::uuid, ?::uuid, ?::uuid, 1, 2)`,
        [tx.id, seed.organizationId, seed.productId],
        /inventory_transaction_intents_sign_check/,
      );
    });

    it('refuses a duplicate intent line for one product', async () => {
      const [tx]: { id: string }[] = await em.execute(
        `insert into inventory_transactions (organization_id, type, idempotency_key, command_fingerprint, actor_kind, actor_user_id, posted_at)
         values (?::uuid, 'ADJUSTMENT', ?, repeat('3', 64), 'USER', gen_random_uuid(), now()) returning id`,
        [seed.organizationId, `dup-intent-${Date.now()}`],
      );
      await em.execute(
        `insert into inventory_transaction_intents (transaction_id, organization_id, product_id, declared_amount, intent_sign)
         values (?::uuid, ?::uuid, ?::uuid, 1, 1)`,
        [tx.id, seed.organizationId, seed.productId],
      );
      await expectRefusal(
        `insert into inventory_transaction_intents (transaction_id, organization_id, product_id, declared_amount, intent_sign)
         values (?::uuid, ?::uuid, ?::uuid, 2, 1)`,
        [tx.id, seed.organizationId, seed.productId],
        /inventory_transaction_intents_transaction_product_unique/,
      );
    });

    it('refuses a duplicate idempotency key inside one organization', async () => {
      const key = `unique-${Date.now()}`;
      await em.execute(
        `insert into inventory_transactions (organization_id, type, idempotency_key, command_fingerprint, actor_kind, actor_user_id, posted_at)
         values (?::uuid, 'ADJUSTMENT', ?, repeat('4', 64), 'USER', gen_random_uuid(), now())`,
        [seed.organizationId, key],
      );
      await expectRefusal(
        `insert into inventory_transactions (organization_id, type, idempotency_key, command_fingerprint, actor_kind, actor_user_id, posted_at)
         values (?::uuid, 'ADJUSTMENT', ?, repeat('5', 64), 'USER', gen_random_uuid(), now())`,
        [seed.organizationId, key],
        /inventory_transactions_org_idempotency_unique/,
      );
    });

    it('lets another organization reuse the same idempotency key', async () => {
      const key = `shared-${Date.now()}`;
      await em.execute(
        `insert into inventory_transactions (organization_id, type, idempotency_key, command_fingerprint, actor_kind, actor_user_id, posted_at)
         values (?::uuid, 'ADJUSTMENT', ?, repeat('6', 64), 'USER', gen_random_uuid(), now())`,
        [seed.organizationId, key],
      );
      await expect(
        em.execute(
          `insert into inventory_transactions (organization_id, type, idempotency_key, command_fingerprint, actor_kind, actor_user_id, posted_at)
           values (?::uuid, 'ADJUSTMENT', ?, repeat('6', 64), 'USER', gen_random_uuid(), now())`,
          [other.organizationId, key],
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('posting provenance is coherent or the row does not exist', () => {
    const insert = (kind: string, userId: string, origin: string) =>
      em.execute(
        `insert into inventory_transactions (organization_id, type, idempotency_key, command_fingerprint,
            actor_kind, actor_user_id, system_origin, posted_at)
         values (?::uuid, 'ADJUSTMENT', ?, repeat('7', 64), ?, ${userId}, ${origin}, now())`,
        [seed.organizationId, `principal-${Math.random()}`, kind],
      );

    it('accepts a USER with a user id and no system origin', async () => {
      await expect(insert('USER', 'gen_random_uuid()', 'null')).resolves.toBeDefined();
    });

    it('accepts a SYSTEM with an origin and no user id', async () => {
      await expect(insert('SYSTEM', 'null', "'sales-checkout'")).resolves.toBeDefined();
    });

    it.each([
      ['USER without a user id', 'USER', 'null', 'null'],
      ['USER carrying a system origin', 'USER', 'gen_random_uuid()', "'x'"],
      ['SYSTEM without an origin', 'SYSTEM', 'null', 'null'],
      ['SYSTEM carrying a user id', 'SYSTEM', 'gen_random_uuid()', "'x'"],
      ['an unknown kind', 'ROBOT', 'gen_random_uuid()', 'null'],
    ])('refuses %s', async (_label, kind, userId, origin) => {
      await expect(insert(kind, userId, origin)).rejects.toThrow(/inventory_transactions_principal_check/);
    });
  });

  describe('store deletion is restricted once custody exists', () => {
    it('refuses to delete a store that owns a custody location', async () => {
      await expectRefusal(
        `delete from stores where id = ?::uuid`,
        [seed.storeId],
        /inventory_locations_store_tenant_foreign/,
      );
    });
  });

  describe('measured trigger and function objects', () => {
    it('names the objects THIS migration produces', async () => {
      // Asserted by NAME, not by a global count: a later boundary adding its own
      // trigger must not break B1's proof, and a total says nothing about which
      // objects actually exist.
      const owned = await triggerAndFunctionNames(em, 'inventory_');
      // `arrayContaining`, not equality: later boundaries legitimately add their
      // own `inventory_*` objects, and B1's proof is that ITS six exist.
      expect(owned.triggers).toEqual(
        expect.arrayContaining([
          'inventory_balances_posting_only',
          'inventory_entries_immutable',
          'inventory_locations_identity_immutable',
          'inventory_transaction_intents_immutable',
          'inventory_transactions_immutable',
          'inventory_transit_balances_posting_only',
        ]),
      );
      expect(owned.functions).toEqual(
        expect.arrayContaining([
          'inventory_immutable_raise',
          'inventory_location_identity_guard',
          'inventory_projection_guard',
        ]),
      );
    });
  });
});

/**
 * Reversibility is proved on its own database: an up -> down -> up cycle must
 * leave no table, trigger or function behind. `down()` is a development and
 * rehearsal tool only — once an opening epoch is posted, rollback is
 * restore-based (ADR 013 §10).
 */
d('P5-B1 migration reversibility (real PostgreSQL)', () => {
  jest.setTimeout(300_000);
  let pg: DisposablePg;

  afterAll(async () => {
    if (pg) await pg.close();
  });

  it('up -> down -> up leaves no residue', async () => {
    // Migrated to THIS boundary exactly, so the proof measures B1's own
    // reversibility rather than every later migration's as well.
    pg = await withDisposablePg({ migrateTo: B1 });
    const em = pg.orm.em.fork() as EntityManager;
    const migrator = pg.orm.getMigrator();

    const after = await triggerAndFunctionCounts(em);
    expect(after).toEqual({ triggers: 7, functions: 4 });

    await migrator.down({ to: PRE_B1 });
    const rolledBack = await triggerAndFunctionCounts(em);
    expect(rolledBack).toEqual({ triggers: 1, functions: 1 });

    const tables: { n: number }[] = await em.execute(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public' and table_name like 'inventory_%'`,
    );
    expect(tables[0].n).toBe(0);

    await migrator.up({ to: B1 });
    const again = await triggerAndFunctionCounts(em);
    expect(again).toEqual({ triggers: 7, functions: 4 });
    const restored: { n: number }[] = await em.execute(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public' and table_name like 'inventory_%'`,
    );
    expect(restored[0].n).toBe(6);
  });
});
