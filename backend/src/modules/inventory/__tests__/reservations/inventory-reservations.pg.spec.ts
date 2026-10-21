import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { prepareLedger, realReservations, realStock } from '../../../../../test/inventory-stock-support';
import { InventoryReservationService } from '../../reservations/inventory-reservation.service';
import { InventoryReconciliationService, INVARIANT_ACTIVATION } from '../../ledger/inventory-reconciliation.service';
import { InventoryStockService } from '../../ledger/inventory-stock.service';
import { InventoryBalance } from '../../entities/inventory-balance.entity';
import { InventoryPrincipal } from '../../ledger/inventory.types';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const OPERATOR: InventoryPrincipal = { kind: 'USER', userId: '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b' };

/**
 * P5-B4 — the two aggregates, and the line between them.
 *
 * A physical reservation moves real units out of AVAILABLE. A backorder writes
 * nothing to the ledger at all. Most of this file exists to prove that second
 * sentence, because a backorder that quietly created entries would be imaginary
 * stock, and the projections would stop meaning anything.
 */
d('P5-B4 reservations and backorders (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let reservations: InventoryReservationService;
  let stock: InventoryStockService;
  let reconciliation: InventoryReconciliationService;

  const seed = async (label: string, opening = 0) => {
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
    const loc = await prepareLedger(em, {
      organizationId: org.id,
      storeId: store.id,
      productId: opening > 0 ? product.id : null,
      quantity: opening,
    });
    return { organizationId: org.id, storeId: store.id, productId: product.id, ...loc };
  };

  const cell = async (organizationId: string, locationId: string, productId: string, state: string) => {
    const rows: { quantity: number }[] = await em.execute(
      `select quantity from inventory_balances
        where organization_id = ?::uuid and location_id = ?::uuid and product_id = ?::uuid
          and physical_condition = 'GOOD' and operational_state = ?`,
      [organizationId, locationId, productId, state],
    );
    return rows[0]?.quantity ?? 0;
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    reservations = realReservations(em);
    stock = realStock(em);
    reconciliation = Object.create(InventoryReconciliationService.prototype);
    (reconciliation as any).balanceRepository = em.getRepository(InventoryBalance);
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  describe('a physical reservation moves real units', () => {
    it('takes them out of AVAILABLE without changing what the organization owns', async () => {
      const s = await seed('reserve', 10);
      const result = await em.transactional(async (tem) =>
        reservations.reservePhysical(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          locationId: s.storeLocationId!,
          quantity: 4,
          principal: OPERATOR,
          customer: { customerName: 'A Buyer', customerPhone: '555' },
        }),
      );
      expect(result).not.toBeNull();

      expect(await cell(s.organizationId, s.storeLocationId!, s.productId, 'AVAILABLE')).toBe(6);
      expect(await cell(s.organizationId, s.storeLocationId!, s.productId, 'RESERVED')).toBe(4);
      // Owned total unchanged: reserving is not consuming.
      expect(await stock.organizationTotal(em, s.organizationId, s.productId)).toBe(10);
      expect(await reconciliation.verifyAll(s.organizationId)).toEqual([]);
    });

    it('refuses to reserve more than the cell holds, and writes nothing', async () => {
      const s = await seed('reserve-short', 3);
      const result = await em.transactional(async (tem) =>
        reservations.reservePhysical(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          locationId: s.storeLocationId!,
          quantity: 5,
          principal: OPERATOR,
        }),
      );
      expect(result).toBeNull();
      expect(await cell(s.organizationId, s.storeLocationId!, s.productId, 'AVAILABLE')).toBe(3);
      expect(await cell(s.organizationId, s.storeLocationId!, s.productId, 'RESERVED')).toBe(0);
      const rows: { n: number }[] = await em.execute(
        `select count(*)::int as n from inventory_reservations where organization_id = ?::uuid`,
        [s.organizationId],
      );
      expect(rows[0].n).toBe(0);
    });

    it('releasing puts them back', async () => {
      const s = await seed('release', 8);
      const made = await em.transactional(async (tem) =>
        reservations.reservePhysical(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          locationId: s.storeLocationId!,
          quantity: 3,
          principal: OPERATOR,
        }),
      );
      await em.transactional(async (tem) =>
        reservations.releasePhysical(tem as EntityManager, {
          organizationId: s.organizationId,
          reservationId: made!.reservationId,
          principal: OPERATOR,
        }),
      );
      expect(await cell(s.organizationId, s.storeLocationId!, s.productId, 'AVAILABLE')).toBe(8);
      expect(await cell(s.organizationId, s.storeLocationId!, s.productId, 'RESERVED')).toBe(0);
      expect(await reconciliation.verifyAll(s.organizationId)).toEqual([]);
    });

    it('fulfilling issues them FROM RESERVED, never twice from AVAILABLE', async () => {
      const s = await seed('fulfil', 8);
      const made = await em.transactional(async (tem) =>
        reservations.reservePhysical(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          locationId: s.storeLocationId!,
          quantity: 3,
          principal: OPERATOR,
        }),
      );
      await em.transactional(async (tem) =>
        reservations.fulfilPhysical(tem as EntityManager, {
          organizationId: s.organizationId,
          reservationId: made!.reservationId,
          principal: OPERATOR,
        }),
      );
      // Five left available, none reserved, five owned — the reserved units
      // left the organization exactly once.
      expect(await cell(s.organizationId, s.storeLocationId!, s.productId, 'AVAILABLE')).toBe(5);
      expect(await cell(s.organizationId, s.storeLocationId!, s.productId, 'RESERVED')).toBe(0);
      expect(await stock.organizationTotal(em, s.organizationId, s.productId)).toBe(5);
      expect(await reconciliation.verifyAll(s.organizationId)).toEqual([]);
    });

    it('a settled reservation cannot be settled again', async () => {
      const s = await seed('settle-twice', 5);
      const made = await em.transactional(async (tem) =>
        reservations.reservePhysical(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          locationId: s.storeLocationId!,
          quantity: 2,
          principal: OPERATOR,
        }),
      );
      await em.transactional(async (tem) =>
        reservations.releasePhysical(tem as EntityManager, {
          organizationId: s.organizationId,
          reservationId: made!.reservationId,
          principal: OPERATOR,
        }),
      );
      await expect(
        em.transactional(async (tem) =>
          reservations.releasePhysical(tem as EntityManager, {
            organizationId: s.organizationId,
            reservationId: made!.reservationId,
            principal: OPERATOR,
          }),
        ),
      ).rejects.toThrow(/Active reservation not found/);
    });
  });

  describe('a backorder writes nothing to the ledger', () => {
    it('creates no transaction, no entry and no balance', async () => {
      const s = await seed('backorder', 0);
      const before: { tx: number; entries: number; balances: number }[] = await em.execute(
        `select (select count(*)::int from inventory_transactions where organization_id = ?::uuid) as tx,
                (select count(*)::int from inventory_entries where organization_id = ?::uuid) as entries,
                (select count(*)::int from inventory_balances where organization_id = ?::uuid) as balances`,
        [s.organizationId, s.organizationId, s.organizationId],
      );
      await em.transactional(async (tem) =>
        reservations.createBackorder(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          quantity: 6,
          origin: 'OPERATOR',
          storeId: s.storeId,
        }),
      );
      const after: typeof before = await em.execute(
        `select (select count(*)::int from inventory_transactions where organization_id = ?::uuid) as tx,
                (select count(*)::int from inventory_entries where organization_id = ?::uuid) as entries,
                (select count(*)::int from inventory_balances where organization_id = ?::uuid) as balances`,
        [s.organizationId, s.organizationId, s.organizationId],
      );
      expect(after[0]).toEqual(before[0]);
      expect(await stock.organizationTotal(em, s.organizationId, s.productId)).toBe(0);
      expect(await reconciliation.verifyAll(s.organizationId)).toEqual([]);
    });

    it('keeps a system oversell distinguishable from an operator promise', async () => {
      const s = await seed('origins', 0);
      await em.transactional(async (tem) => {
        await reservations.createBackorder(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          quantity: 2,
          origin: 'OPERATOR',
        });
        await reservations.createBackorder(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          quantity: 3,
          origin: 'SALES_OVERSELL',
        });
      });
      const rows: { origin: string; quantity: number }[] = await em.execute(
        `select origin, quantity from inventory_backorders where organization_id = ?::uuid order by origin`,
        [s.organizationId],
      );
      expect(rows).toEqual([
        { origin: 'OPERATOR', quantity: 2 },
        { origin: 'SALES_OVERSELL', quantity: 3 },
      ]);
    });

    it('refuses a non-positive promise', async () => {
      const s = await seed('bad-backorder', 0);
      await expect(
        em.transactional(async (tem) =>
          reservations.createBackorder(tem as EntityManager, {
            organizationId: s.organizationId,
            productId: s.productId,
            quantity: 0,
            origin: 'OPERATOR',
          }),
        ),
      ).rejects.toThrow(/positive quantity/);
    });
  });

  describe('allocation is oldest promise first', () => {
    it('meets the queue in creation order and reserves what it allocates', async () => {
      const s = await seed('queue', 0);
      const ids: string[] = [];
      for (const quantity of [3, 4, 5]) {
        ids.push(
          await em.transactional(async (tem) =>
            reservations.createBackorder(tem as EntityManager, {
              organizationId: s.organizationId,
              productId: s.productId,
              quantity,
              origin: 'OPERATOR',
            }),
          ),
        );
        // Distinct creation instants, so the ordering is unambiguous.
        await em.execute(`select pg_sleep(0.01)`);
      }

      // Six units arrive: enough for the first promise and part of the second.
      await em.transactional(async (tem) =>
        stock.setProductQuantity(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          targetQuantity: 6,
          origin: 'test-harness',
          locationId: s.warehouseId,
        }),
      );
      const result = await em.transactional(async (tem) =>
        reservations.allocateBackorders(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          locationId: s.warehouseId,
          principal: OPERATOR,
        }),
      );
      expect(result).toEqual({ allocated: 6, backordersTouched: 2 });

      const rows: { id: string; status: string; allocated_quantity: number }[] = await em.execute(
        `select id, status, allocated_quantity from inventory_backorders
          where organization_id = ?::uuid order by created_at`,
        [s.organizationId],
      );
      expect(rows[0]).toMatchObject({ id: ids[0], status: 'ALLOCATED', allocated_quantity: 3 });
      expect(rows[1]).toMatchObject({ id: ids[1], status: 'PARTIALLY_ALLOCATED', allocated_quantity: 3 });
      expect(rows[2]).toMatchObject({ id: ids[2], status: 'OPEN', allocated_quantity: 0 });

      // Everything allocated is now genuinely reserved, not merely promised.
      expect(await cell(s.organizationId, s.warehouseId, s.productId, 'RESERVED')).toBe(6);
      expect(await cell(s.organizationId, s.warehouseId, s.productId, 'AVAILABLE')).toBe(0);
      expect(await reconciliation.verifyAll(s.organizationId)).toEqual([]);
    });

    it('a partially met promise keeps its place in the queue', async () => {
      const s = await seed('partial-queue', 0);
      const first = await em.transactional(async (tem) =>
        reservations.createBackorder(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          quantity: 10,
          origin: 'OPERATOR',
        }),
      );
      await em.execute(`select pg_sleep(0.01)`);
      await em.transactional(async (tem) =>
        reservations.createBackorder(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          quantity: 5,
          origin: 'OPERATOR',
        }),
      );

      for (const arrival of [4, 4]) {
        await em.transactional(async (tem) => {
          const current = await stock.locationAvailable(
            tem as EntityManager,
            s.organizationId,
            s.warehouseId,
            s.productId,
          );
          await stock.setProductQuantity(tem as EntityManager, {
            organizationId: s.organizationId,
            productId: s.productId,
            targetQuantity: current + arrival,
            origin: 'test-harness',
            locationId: s.warehouseId,
          });
          await reservations.allocateBackorders(tem as EntityManager, {
            organizationId: s.organizationId,
            productId: s.productId,
            locationId: s.warehouseId,
            principal: OPERATOR,
          });
        });
      }

      const rows: { id: string; allocated_quantity: number }[] = await em.execute(
        `select id, allocated_quantity from inventory_backorders where organization_id = ?::uuid order by created_at`,
        [s.organizationId],
      );
      // The older promise took both arrivals; the younger one has waited.
      expect(rows[0]).toMatchObject({ id: first, allocated_quantity: 8 });
      expect(rows[1].allocated_quantity).toBe(0);
      expect(await reconciliation.verifyAll(s.organizationId)).toEqual([]);
    });

    it('allocates nothing when there is nothing to allocate', async () => {
      const s = await seed('empty-queue', 5);
      const result = await em.transactional(async (tem) =>
        reservations.allocateBackorders(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          locationId: s.storeLocationId!,
          principal: OPERATOR,
        }),
      );
      expect(result).toEqual({ allocated: 0, backordersTouched: 0 });
      expect(await cell(s.organizationId, s.storeLocationId!, s.productId, 'RESERVED')).toBe(0);
    });

    it('a cancelled promise is skipped', async () => {
      const s = await seed('cancelled', 0);
      const cancelled = await em.transactional(async (tem) =>
        reservations.createBackorder(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          quantity: 4,
          origin: 'OPERATOR',
        }),
      );
      await em.execute(`select pg_sleep(0.01)`);
      const live = await em.transactional(async (tem) =>
        reservations.createBackorder(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          quantity: 2,
          origin: 'OPERATOR',
        }),
      );
      await em.transactional(async (tem) =>
        reservations.cancelBackorder(tem as EntityManager, s.organizationId, cancelled),
      );
      await em.transactional(async (tem) =>
        stock.setProductQuantity(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          targetQuantity: 2,
          origin: 'test-harness',
          locationId: s.warehouseId,
        }),
      );
      const result = await em.transactional(async (tem) =>
        reservations.allocateBackorders(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          locationId: s.warehouseId,
          principal: OPERATOR,
        }),
      );
      expect(result.allocated).toBe(2);
      const rows: { id: string; allocated_quantity: number; status: string }[] = await em.execute(
        `select id, allocated_quantity, status from inventory_backorders where organization_id = ?::uuid order by created_at`,
        [s.organizationId],
      );
      expect(rows[0]).toMatchObject({ id: cancelled, status: 'CANCELLED', allocated_quantity: 0 });
      expect(rows[1]).toMatchObject({ id: live, status: 'ALLOCATED', allocated_quantity: 2 });
    });
  });

  describe('the invariants are live', () => {
    it('detects a reservation aggregate that no longer matches the RESERVED balance', async () => {
      const s = await seed('recon-drift', 6);
      await em.transactional(async (tem) =>
        reservations.reservePhysical(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          locationId: s.storeLocationId!,
          quantity: 2,
          principal: OPERATOR,
        }),
      );
      expect(await reconciliation.verifyReservations(s.organizationId)).toEqual([]);
      await em.execute(`update inventory_reservations set quantity = 5 where organization_id = ?::uuid`, [
        s.organizationId,
      ]);
      const findings = await reconciliation.verifyReservations(s.organizationId);
      expect(findings.map((f) => f.invariant)).toContain('RESERVATION_AGGREGATE_EQUALITY');
    });

    it('detects a backorder whose allocation rows do not add up', async () => {
      const s = await seed('backorder-drift', 4);
      const id = await em.transactional(async (tem) =>
        reservations.createBackorder(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          quantity: 4,
          origin: 'OPERATOR',
        }),
      );
      await em.transactional(async (tem) =>
        reservations.allocateBackorders(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          locationId: s.storeLocationId!,
          principal: OPERATOR,
        }),
      );
      expect(await reconciliation.verifyBackorders(s.organizationId)).toEqual([]);
      // Injected drift has to be INTERNALLY coherent, or the status CHECK
      // refuses it before the reconciliation query ever runs — which is itself
      // worth knowing. So the row is left self-consistent (1 of 4 allocated,
      // PARTIALLY_ALLOCATED) while disagreeing with its allocation records.
      await em.execute(
        `update inventory_backorders set allocated_quantity = 1, status = 'PARTIALLY_ALLOCATED' where id = ?::uuid`,
        [id],
      );
      const findings = await reconciliation.verifyBackorders(s.organizationId);
      expect(findings.map((f) => f.invariant)).toContain('BACKORDER_CREATES_NO_ENTRIES');
    });

    it('an allocation record is immutable', async () => {
      const s = await seed('allocation-immutable', 3);
      await em.transactional(async (tem) =>
        reservations.createBackorder(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          quantity: 3,
          origin: 'OPERATOR',
        }),
      );
      await em.transactional(async (tem) =>
        reservations.allocateBackorders(tem as EntityManager, {
          organizationId: s.organizationId,
          productId: s.productId,
          locationId: s.storeLocationId!,
          principal: OPERATOR,
        }),
      );
      await expect(
        em.execute(`update inventory_backorder_allocations set quantity = 99 where organization_id = ?::uuid`, [
          s.organizationId,
        ]),
      ).rejects.toThrow(/immutable/i);
    });

    it('the activation matrix now claims B4', () => {
      expect(INVARIANT_ACTIVATION.RESERVATION_AGGREGATE_EQUALITY).toBe('B4');
      expect(INVARIANT_ACTIVATION.BACKORDER_CREATES_NO_ENTRIES).toBe('B4');
      expect(INVARIANT_ACTIVATION.TRANSFER_LIFECYCLE_INTEGRITY).toBe('B5');
    });
  });

  describe('tenancy', () => {
    it('cannot reserve another organization stock', async () => {
      const mine = await seed('mine-res', 5);
      const theirs = await seed('theirs-res', 5);
      await expect(
        em.transactional(async (tem) =>
          reservations.reservePhysical(tem as EntityManager, {
            organizationId: mine.organizationId,
            productId: theirs.productId,
            locationId: theirs.storeLocationId!,
            quantity: 1,
            principal: OPERATOR,
          }),
        ),
      ).rejects.toThrow(/must belong to the acting organization/);
      expect(await cell(theirs.organizationId, theirs.storeLocationId!, theirs.productId, 'AVAILABLE')).toBe(5);
    });

    it('cannot promise against another organization product', async () => {
      const mine = await seed('mine-bo', 0);
      const theirs = await seed('theirs-bo', 0);
      await expect(
        em.transactional(async (tem) =>
          reservations.createBackorder(tem as EntityManager, {
            organizationId: mine.organizationId,
            productId: theirs.productId,
            quantity: 1,
            origin: 'OPERATOR',
          }),
        ),
      ).rejects.toThrow(/inventory_backorders_product_tenant_foreign/);
    });
  });
});
