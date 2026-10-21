import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { prepareLedger, realStock, realTransfers } from '../../../../../test/inventory-stock-support';
import { InventoryTransferService } from '../../transfers/inventory-transfer.service';
import { InventoryReconciliationService, INVARIANT_ACTIVATION } from '../../ledger/inventory-reconciliation.service';
import { InventoryStockService } from '../../ledger/inventory-stock.service';
import { InventoryBalance } from '../../entities/inventory-balance.entity';
import { InventoryPrincipal } from '../../ledger/inventory.types';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const OPERATOR: InventoryPrincipal = { kind: 'USER', userId: '3c3c3c3c-3c3c-4c3c-8c3c-3c3c3c3c3c3c' };

/**
 * P5-B5 — transfers.
 *
 * The invariant that matters most is the dull one: the organization's owned
 * total is IDENTICAL at every step. Units leaving a shelf, waiting in a van and
 * arriving somewhere else are the same units throughout, and a transfer that
 * changed the total would mean the ledger had invented or lost something.
 */
d('P5-B5 transfers (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let transfers: InventoryTransferService;
  let stock: InventoryStockService;
  let reconciliation: InventoryReconciliationService;

  const seed = async (label: string, opening: number) => {
    const suffix = `${label}-${Math.random().toString(16).slice(2, 8)}`;
    const [org]: { id: string }[] = await em.execute(
      `insert into organizations (name, slug, created_at, updated_at) values (?, ?, now(), now()) returning id`,
      [suffix, suffix],
    );
    const [store]: { id: string }[] = await em.execute(
      `insert into stores (name, slug, organization_id, created_at, updated_at)
       values (?, ?, ?::uuid, now(), now()) returning id`,
      [`s-${suffix}`, `s-${suffix}`, org.id],
    );
    const [product]: { id: string }[] = await em.execute(
      `insert into products (name, slug, organization_id, track_inventory, created_at, updated_at)
       values (?, ?, ?::uuid, true, now(), now()) returning id`,
      [`p-${suffix}`, `p-${suffix}`, org.id],
    );
    await em.execute(
      `insert into store_products (organization_id, store_id, product_id, published, track_inventory, created_at, updated_at)
       values (?::uuid, ?::uuid, ?::uuid, true, true, now(), now())`,
      [org.id, store.id, product.id],
    );
    const loc = await prepareLedger(em, { organizationId: org.id, storeId: store.id });
    if (opening > 0) {
      await em.transactional(async (tem) =>
        stock.setProductQuantity(tem as EntityManager, {
          organizationId: org.id,
          productId: product.id,
          targetQuantity: opening,
          origin: 'test-harness',
          locationId: loc.warehouseId,
        }),
      );
    }
    return { organizationId: org.id, storeId: store.id, productId: product.id, ...loc };
  };

  const cell = async (organizationId: string, locationId: string | null, productId: string, state: string) => {
    if (locationId === null) {
      const rows: { q: number }[] = await em.execute(
        `select coalesce(sum(quantity), 0)::int as q from inventory_transit_balances
          where organization_id = ?::uuid and product_id = ?::uuid and transit_direction = ?`,
        [organizationId, productId, state],
      );
      return rows[0].q;
    }
    const rows: { q: number }[] = await em.execute(
      `select coalesce(sum(quantity), 0)::int as q from inventory_balances
        where organization_id = ?::uuid and location_id = ?::uuid and product_id = ?::uuid and operational_state = ?`,
      [organizationId, locationId, productId, state],
    );
    return rows[0].q;
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    transfers = realTransfers(em);
    stock = realStock(em);
    reconciliation = Object.create(InventoryReconciliationService.prototype);
    (reconciliation as any).balanceRepository = em.getRepository(InventoryBalance);
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  const draft = (s: any, quantity: number) =>
    em.transactional(async (tem) =>
      transfers.createDraft(tem as EntityManager, {
        organizationId: s.organizationId,
        sourceLocationId: s.warehouseId,
        destinationLocationId: s.storeLocationId!,
        lines: [{ productId: s.productId, quantity }],
      }),
    );

  it('moves custody end to end without changing the owned total', async () => {
    const s = await seed('happy', 10);
    const id = await draft(s, 6);
    expect(await stock.organizationTotal(em, s.organizationId, s.productId)).toBe(10);

    await em.transactional(async (tem) =>
      transfers.commit(tem as EntityManager, { organizationId: s.organizationId, transferId: id, principal: OPERATOR }),
    );
    expect(await cell(s.organizationId, s.warehouseId, s.productId, 'AVAILABLE')).toBe(4);
    expect(await cell(s.organizationId, s.warehouseId, s.productId, 'TRANSFER_COMMITTED')).toBe(6);
    expect(await stock.organizationTotal(em, s.organizationId, s.productId)).toBe(10);

    await em.transactional(async (tem) =>
      transfers.dispatch(tem as EntityManager, {
        organizationId: s.organizationId,
        transferId: id,
        principal: OPERATOR,
      }),
    );
    expect(await cell(s.organizationId, s.warehouseId, s.productId, 'TRANSFER_COMMITTED')).toBe(0);
    expect(await cell(s.organizationId, null, s.productId, 'DISPATCH')).toBe(6);
    // Owned but nowhere: still ten.
    expect(await stock.organizationTotal(em, s.organizationId, s.productId)).toBe(10);
    // And not sellable while it travels.
    expect(await reconciliation.sellableQuantity(s.organizationId, s.productId)).toBe(4);

    await em.transactional(async (tem) =>
      transfers.receive(tem as EntityManager, {
        organizationId: s.organizationId,
        transferId: id,
        principal: OPERATOR,
      }),
    );
    expect(await cell(s.organizationId, null, s.productId, 'DISPATCH')).toBe(0);
    expect(await cell(s.organizationId, s.storeLocationId!, s.productId, 'AVAILABLE')).toBe(6);
    expect(await stock.organizationTotal(em, s.organizationId, s.productId)).toBe(10);
    expect(await reconciliation.sellableQuantity(s.organizationId, s.productId)).toBe(10);

    const rows: { status: string }[] = await em.execute(`select status from inventory_transfers where id = ?::uuid`, [
      id,
    ]);
    expect(rows[0].status).toBe('COMPLETED');
    expect(await reconciliation.verifyAll(s.organizationId)).toEqual([]);
  });

  it('receives partially and leaves the rest travelling', async () => {
    const s = await seed('partial', 10);
    const id = await draft(s, 8);
    await em.transactional(async (tem) => {
      await transfers.commit(tem as EntityManager, {
        organizationId: s.organizationId,
        transferId: id,
        principal: OPERATOR,
      });
      await transfers.dispatch(tem as EntityManager, {
        organizationId: s.organizationId,
        transferId: id,
        principal: OPERATOR,
      });
    });
    await em.transactional(async (tem) =>
      transfers.receive(tem as EntityManager, {
        organizationId: s.organizationId,
        transferId: id,
        principal: OPERATOR,
        quantities: { [s.productId]: 5 },
      }),
    );
    expect(await cell(s.organizationId, s.storeLocationId!, s.productId, 'AVAILABLE')).toBe(5);
    expect(await cell(s.organizationId, null, s.productId, 'DISPATCH')).toBe(3);
    expect(await stock.organizationTotal(em, s.organizationId, s.productId)).toBe(10);
    const rows: { status: string }[] = await em.execute(`select status from inventory_transfers where id = ?::uuid`, [
      id,
    ]);
    expect(rows[0].status).toBe('PARTIALLY_RECEIVED');
    expect(await reconciliation.verifyAll(s.organizationId)).toEqual([]);
  });

  it('returns travelling units home, and they travel to get there', async () => {
    const s = await seed('return', 10);
    const id = await draft(s, 4);
    await em.transactional(async (tem) => {
      await transfers.commit(tem as EntityManager, {
        organizationId: s.organizationId,
        transferId: id,
        principal: OPERATOR,
      });
      await transfers.dispatch(tem as EntityManager, {
        organizationId: s.organizationId,
        transferId: id,
        principal: OPERATOR,
      });
    });

    await em.transactional(async (tem) =>
      transfers.startReturn(tem as EntityManager, {
        organizationId: s.organizationId,
        transferId: id,
        principal: OPERATOR,
      }),
    );
    // Still in transit, but pointed the other way — a return is a journey, not
    // a teleport.
    expect(await cell(s.organizationId, null, s.productId, 'DISPATCH')).toBe(0);
    expect(await cell(s.organizationId, null, s.productId, 'RETURN')).toBe(4);
    expect(await stock.organizationTotal(em, s.organizationId, s.productId)).toBe(10);

    await em.transactional(async (tem) =>
      transfers.completeReturn(tem as EntityManager, {
        organizationId: s.organizationId,
        transferId: id,
        principal: OPERATOR,
      }),
    );
    expect(await cell(s.organizationId, null, s.productId, 'RETURN')).toBe(0);
    expect(await cell(s.organizationId, s.warehouseId, s.productId, 'AVAILABLE')).toBe(10);
    expect(await stock.organizationTotal(em, s.organizationId, s.productId)).toBe(10);
    expect(await reconciliation.verifyAll(s.organizationId)).toEqual([]);
  });

  it('cancels a committed transfer and gives the units back', async () => {
    const s = await seed('cancel', 7);
    const id = await draft(s, 3);
    await em.transactional(async (tem) =>
      transfers.commit(tem as EntityManager, { organizationId: s.organizationId, transferId: id, principal: OPERATOR }),
    );
    expect(await cell(s.organizationId, s.warehouseId, s.productId, 'AVAILABLE')).toBe(4);
    await em.transactional(async (tem) =>
      transfers.cancel(tem as EntityManager, { organizationId: s.organizationId, transferId: id, principal: OPERATOR }),
    );
    expect(await cell(s.organizationId, s.warehouseId, s.productId, 'AVAILABLE')).toBe(7);
    expect(await reconciliation.verifyAll(s.organizationId)).toEqual([]);
  });

  describe('refusals', () => {
    it('refuses a transfer to the same location', async () => {
      const s = await seed('same', 5);
      await expect(
        em.transactional(async (tem) =>
          transfers.createDraft(tem as EntityManager, {
            organizationId: s.organizationId,
            sourceLocationId: s.warehouseId,
            destinationLocationId: s.warehouseId,
            lines: [{ productId: s.productId, quantity: 1 }],
          }),
        ),
      ).rejects.toThrow(/two different locations/);
    });

    it('refuses to commit more than the source holds', async () => {
      const s = await seed('short', 2);
      const id = await draft(s, 5);
      await expect(
        em.transactional(async (tem) =>
          transfers.commit(tem as EntityManager, {
            organizationId: s.organizationId,
            transferId: id,
            principal: OPERATOR,
          }),
        ),
      ).rejects.toThrow(/inventory_balances_nonnegative_check/);
      expect(await cell(s.organizationId, s.warehouseId, s.productId, 'AVAILABLE')).toBe(2);
    });

    it('refuses to dispatch more than planned', async () => {
      const s = await seed('overdispatch', 10);
      const id = await draft(s, 3);
      await em.transactional(async (tem) =>
        transfers.commit(tem as EntityManager, {
          organizationId: s.organizationId,
          transferId: id,
          principal: OPERATOR,
        }),
      );
      await expect(
        em.transactional(async (tem) =>
          transfers.dispatch(tem as EntityManager, {
            organizationId: s.organizationId,
            transferId: id,
            principal: OPERATOR,
            quantities: { [s.productId]: 5 },
          }),
        ),
      ).rejects.toThrow(/cannot dispatch more than it planned/);
    });

    it('refuses to receive more than is travelling', async () => {
      const s = await seed('overreceive', 10);
      const id = await draft(s, 3);
      await em.transactional(async (tem) => {
        await transfers.commit(tem as EntityManager, {
          organizationId: s.organizationId,
          transferId: id,
          principal: OPERATOR,
        });
        await transfers.dispatch(tem as EntityManager, {
          organizationId: s.organizationId,
          transferId: id,
          principal: OPERATOR,
        });
      });
      await expect(
        em.transactional(async (tem) =>
          transfers.receive(tem as EntityManager, {
            organizationId: s.organizationId,
            transferId: id,
            principal: OPERATOR,
            quantities: { [s.productId]: 9 },
          }),
        ),
      ).rejects.toThrow(/more than is travelling/);
    });

    it('refuses to cancel a transfer that has already left', async () => {
      const s = await seed('late-cancel', 5);
      const id = await draft(s, 2);
      await em.transactional(async (tem) => {
        await transfers.commit(tem as EntityManager, {
          organizationId: s.organizationId,
          transferId: id,
          principal: OPERATOR,
        });
        await transfers.dispatch(tem as EntityManager, {
          organizationId: s.organizationId,
          transferId: id,
          principal: OPERATOR,
        });
      });
      await expect(
        em.transactional(async (tem) =>
          transfers.cancel(tem as EntityManager, {
            organizationId: s.organizationId,
            transferId: id,
            principal: OPERATOR,
          }),
        ),
      ).rejects.toThrow(/return it instead/);
    });

    it('refuses another organization location as an endpoint', async () => {
      const mine = await seed('mine-t', 5);
      const theirs = await seed('theirs-t', 5);
      await expect(
        em.transactional(async (tem) =>
          transfers.createDraft(tem as EntityManager, {
            organizationId: mine.organizationId,
            sourceLocationId: mine.warehouseId,
            destinationLocationId: theirs.warehouseId,
            lines: [{ productId: mine.productId, quantity: 1 }],
          }),
        ),
      ).rejects.toThrow(/inventory_transfers_destination_tenant_foreign/);
    });
  });

  describe('the deferred B1 key and the B2 transit constraint', () => {
    it('an entry cannot name a transfer that does not exist', async () => {
      const s = await seed('fk', 3);
      const [tx]: { id: string }[] = await em.execute(
        `insert into inventory_transactions (organization_id, type, idempotency_key, command_fingerprint, actor_kind, actor_user_id, posted_at)
         values (?::uuid, 'TRANSFER_DISPATCH', ?, repeat('c', 64), 'USER', gen_random_uuid(), now()) returning id`,
        [s.organizationId, `fk-${Date.now()}`],
      );
      await expect(
        em.execute(
          `insert into inventory_entries (transaction_id, organization_id, product_id, location_id,
              physical_condition, operational_state, transfer_id, transit_direction, quantity_delta, created_at)
           values (?::uuid, ?::uuid, ?::uuid, null, 'GOOD', 'IN_TRANSIT', gen_random_uuid(), 'DISPATCH', 1, now())`,
          [tx.id, s.organizationId, s.productId],
        ),
      ).rejects.toThrow(/inventory_entries_transfer_tenant_foreign/);
    });

    it('an opening may now declare transit, but only against a real transfer', async () => {
      const s = await seed('opening-transit', 4);
      const id = await draft(s, 1);
      const [rec]: { id: string }[] = await em.execute(
        `insert into inventory_opening_reconciliations
           (organization_id, product_id, legacy_snapshot_json, legacy_product_quantity, proposed_org_total,
            discrepancy_class, source_fingerprint, idempotency_key, status, created_at, updated_at)
         values (?::uuid, ?::uuid, '{}'::jsonb, 0, 0, 'MATCHED', repeat('a', 64), ?, 'PROPOSED', now(), now())
         returning id`,
        [s.organizationId, s.productId, `open-${Date.now()}`],
      );
      await expect(
        em.execute(`update inventory_opening_reconciliations set approved_in_transit_quantity = 2 where id = ?::uuid`, [
          rec.id,
        ]),
      ).rejects.toThrow(/transit_needs_transfer/);
      await expect(
        em.execute(
          `update inventory_opening_reconciliations
              set approved_in_transit_quantity = 2, opening_transit_transfer_id = ?::uuid where id = ?::uuid`,
          [id, rec.id],
        ),
      ).resolves.toBeDefined();
    });

    it('the activation matrix now claims B5', () => {
      expect(INVARIANT_ACTIVATION.TRANSFER_LIFECYCLE_INTEGRITY).toBe('B5');
    });

    it('detects a transit balance that no longer matches its transfer lines', async () => {
      const s = await seed('transfer-drift', 6);
      const id = await draft(s, 2);
      await em.transactional(async (tem) => {
        await transfers.commit(tem as EntityManager, {
          organizationId: s.organizationId,
          transferId: id,
          principal: OPERATOR,
        });
        await transfers.dispatch(tem as EntityManager, {
          organizationId: s.organizationId,
          transferId: id,
          principal: OPERATOR,
        });
      });
      expect(await reconciliation.verifyTransfers(s.organizationId)).toEqual([]);
      await em.execute(`update inventory_transfer_lines set dispatched_quantity = 1 where transfer_id = ?::uuid`, [id]);
      const findings = await reconciliation.verifyTransfers(s.organizationId);
      expect(findings.map((f) => f.invariant)).toContain('TRANSFER_LIFECYCLE_INTEGRITY');
    });
  });
});
