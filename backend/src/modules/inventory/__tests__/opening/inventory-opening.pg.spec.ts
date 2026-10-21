import { EntityManager } from '@mikro-orm/postgresql';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { InventoryPostingService } from '../../ledger/inventory-posting.service';
import { InventoryOpeningProposalService } from '../../opening/inventory-opening-proposal.service';
import { InventoryOpeningService } from '../../opening/inventory-opening.service';
import { InventoryReconciliationService } from '../../ledger/inventory-reconciliation.service';
import { InventoryTransaction } from '../../entities/inventory-transaction.entity';
import { InventoryBalance } from '../../entities/inventory-balance.entity';
import { InventoryOpeningReconciliation } from '../../entities/inventory-opening-reconciliation.entity';
import { InventoryPrincipal, storeLocationCode } from '../../ledger/inventory.types';
import { defaultWarehouseCode } from '../../opening/inventory-opening.types';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const OWNER: InventoryPrincipal = { kind: 'USER', userId: '11111111-1111-4111-8111-111111111111' };

/**
 * P5-B2 — the opening epoch.
 *
 * The whole point of this boundary is that nothing chooses silently. The two
 * pre-ledger columns disagree in real data, so a divergent product is proposed
 * with NO allocations and cannot be posted until somebody states the answer and
 * says why. These tests attack that from both sides: the ambiguity must block,
 * and a legitimate approval must go through and reconcile exactly.
 */
d('P5-B2 opening reconciliation and epoch (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let proposals: InventoryOpeningProposalService;
  let opening: InventoryOpeningService;
  let reconciliation: InventoryReconciliationService;

  const wire = (manager: EntityManager) => {
    const posting: any = Object.create(InventoryPostingService.prototype);
    posting.transactionRepository = manager.getRepository(InventoryTransaction);
    const proposal: any = Object.create(InventoryOpeningProposalService.prototype);
    proposal.reconciliationRepository = manager.getRepository(InventoryOpeningReconciliation);
    const open: any = Object.create(InventoryOpeningService.prototype);
    open.reconciliationRepository = manager.getRepository(InventoryOpeningReconciliation);
    open.posting = posting;
    open.proposals = proposal;
    const recon: any = Object.create(InventoryReconciliationService.prototype);
    recon.balanceRepository = manager.getRepository(InventoryBalance);
    return { posting, proposal, open, recon };
  };

  /** An organization with one store and legacy quantities set by the caller. */
  /**
   * Every organization this suite creates exists to run one opening epoch, so
   * it is seeded ALREADY FROZEN (P5-X1): an OPENING_BALANCE posts only inside a
   * declared cutover window, and a fixture that had to remember to open one
   * would be testing the fixture rather than the epoch.
   */
  const seedLegacy = async (label: string, rows: { product: number; store: number | null }[]) => {
    const suffix = `${label}-${Math.random().toString(16).slice(2, 8)}`;
    const [org]: { id: string }[] = await em.execute(
      `insert into organizations (name, slug, inventory_cutover_frozen_at, created_at, updated_at)
       values (?, ?, now(), now(), now()) returning id`,
      [suffix, suffix],
    );
    const [store]: { id: string }[] = await em.execute(
      `insert into stores (name, slug, organization_id, created_at, updated_at)
       values (?, ?, ?::uuid, now(), now()) returning id`,
      [`store-${suffix}`, `store-${suffix}`, org.id],
    );
    const products: string[] = [];
    for (const [index, row] of rows.entries()) {
      const [product]: { id: string }[] = await em.execute(
        `insert into products (name, slug, organization_id, stock_quantity, track_inventory, created_at, updated_at)
         values (?, ?, ?::uuid, ?, true, now(), now()) returning id`,
        [`p${index}-${suffix}`, `p${index}-${suffix}`, org.id, row.product],
      );
      products.push(product.id);
      if (row.store !== null) {
        await em.execute(
          `insert into store_products (organization_id, store_id, product_id, stock_quantity, track_inventory, published, created_at, updated_at)
           values (?::uuid, ?::uuid, ?::uuid, ?, true, true, now(), now())`,
          [org.id, store.id, product.id, row.store],
        );
      }
    }
    return { organizationId: org.id, storeId: store.id, products };
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    const wired = wire(em);
    proposals = wired.proposal;
    opening = wired.open;
    reconciliation = wired.recon;
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  describe('location bootstrap', () => {
    it('creates exactly one default warehouse and one custody location per store', async () => {
      const seed = await seedLegacy('bootstrap', [{ product: 0, store: 0 }]);
      const result = await opening.bootstrapLocations(seed.organizationId);
      expect(result.storeLocationIds).toHaveLength(1);

      const rows: { kind: string; code: string; is_default: boolean }[] = await em.execute(
        `select kind, code, is_default from inventory_locations where organization_id = ?::uuid order by kind`,
        [seed.organizationId],
      );
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.kind === 'STORE')!.code).toBe(storeLocationCode(seed.storeId));
      expect(rows.find((r) => r.kind === 'WAREHOUSE')!.code).toBe(defaultWarehouseCode(seed.organizationId));
      expect(rows.find((r) => r.kind === 'WAREHOUSE')!.is_default).toBe(true);
    });

    it('is idempotent — re-running creates nothing new', async () => {
      const seed = await seedLegacy('bootstrap-twice', [{ product: 0, store: 0 }]);
      await opening.bootstrapLocations(seed.organizationId);
      await opening.bootstrapLocations(seed.organizationId);
      const rows: { n: number }[] = await em.execute(
        `select count(*)::int as n from inventory_locations where organization_id = ?::uuid`,
        [seed.organizationId],
      );
      expect(rows[0].n).toBe(2);
    });

    it('derives both codes from immutable uuids, never from slugs', async () => {
      const seed = await seedLegacy('codes', [{ product: 0, store: 0 }]);
      await opening.bootstrapLocations(seed.organizationId);
      const rows: { code: string }[] = await em.execute(
        `select l.code from inventory_locations l where l.organization_id = ?::uuid order by l.kind`,
        [seed.organizationId],
      );
      expect(rows.map((r) => r.code)).toEqual([
        storeLocationCode(seed.storeId),
        defaultWarehouseCode(seed.organizationId),
      ]);
    });
  });

  describe('proposals classify without deciding', () => {
    it('classifies matched, product-only, allocation-only and divergent', async () => {
      const seed = await seedLegacy('classify', [
        { product: 5, store: 5 }, // MATCHED
        { product: 7, store: 0 }, // PRODUCT_ONLY
        { product: 0, store: 4 }, // ALLOCATION_ONLY
        { product: 9, store: 3 }, // DIVERGENT
      ]);
      await opening.bootstrapLocations(seed.organizationId);
      const result = await proposals.propose(seed.organizationId);
      expect(result.proposed).toBe(4);
      expect(result.byClass).toEqual({ MATCHED: 1, PRODUCT_ONLY: 1, ALLOCATION_ONLY: 1, DIVERGENT: 1 });
    });

    it('proposes NO allocations for a divergent product — somebody must state the answer', async () => {
      const seed = await seedLegacy('divergent', [{ product: 9, store: 3 }]);
      await opening.bootstrapLocations(seed.organizationId);
      await proposals.propose(seed.organizationId);
      const rows: { n: number }[] = await em.execute(
        `select count(*)::int as n
           from inventory_opening_reconciliation_allocations a
           join inventory_opening_reconciliations r on r.id = a.reconciliation_id
          where r.organization_id = ?::uuid`,
        [seed.organizationId],
      );
      expect(rows[0].n).toBe(0);
    });

    it('proposes a store allocation plus the warehouse remainder for a product-only product', async () => {
      const seed = await seedLegacy('remainder', [{ product: 10, store: 4 }]);
      await opening.bootstrapLocations(seed.organizationId);
      await proposals.propose(seed.organizationId);
      // 10 vs 4 is DIVERGENT, so nothing is proposed — the point of the previous
      // test. A genuinely product-only product has no store quantity at all.
      const only = await seedLegacy('remainder-2', [{ product: 6, store: 0 }]);
      await opening.bootstrapLocations(only.organizationId);
      await proposals.propose(only.organizationId);
      const rows: { code: string; approved_quantity: number }[] = await em.execute(
        `select l.code, a.approved_quantity
           from inventory_opening_reconciliation_allocations a
           join inventory_locations l on l.id = a.destination_location_id
          where a.organization_id = ?::uuid`,
        [only.organizationId],
      );
      expect(rows).toEqual([{ code: defaultWarehouseCode(only.organizationId), approved_quantity: 6 }]);
    });

    it('never overwrites an approved proposal', async () => {
      const seed = await seedLegacy('immutable-proposal', [{ product: 5, store: 5 }]);
      await opening.bootstrapLocations(seed.organizationId);
      await proposals.propose(seed.organizationId);
      const locations: { id: string }[] = await em.execute(
        `select id from inventory_locations where organization_id = ?::uuid and kind = 'STORE'`,
        [seed.organizationId],
      );
      await opening.approve({
        organizationId: seed.organizationId,
        productId: seed.products[0],
        approvedOrgTotal: 5,
        allocations: [{ destinationLocationId: locations[0].id, approvedQuantity: 5 }],
        approvedByUserId: OWNER.kind === 'USER' ? OWNER.userId : '',
      });
      const again = await proposals.propose(seed.organizationId);
      expect(again).toEqual(expect.objectContaining({ proposed: 0, skipped: 1 }));
    });
  });

  describe('approval must balance and must be explained', () => {
    const prepare = async (label: string, product: number, store: number) => {
      const seed = await seedLegacy(label, [{ product, store }]);
      await opening.bootstrapLocations(seed.organizationId);
      await proposals.propose(seed.organizationId);
      const locations: { id: string; kind: string }[] = await em.execute(
        `select id, kind from inventory_locations where organization_id = ?::uuid order by kind`,
        [seed.organizationId],
      );
      return {
        ...seed,
        storeLocationId: locations.find((l) => l.kind === 'STORE')!.id,
        warehouseId: locations.find((l) => l.kind === 'WAREHOUSE')!.id,
      };
    };

    it('refuses an approved total that does not equal its allocations', async () => {
      const seed = await prepare('unbalanced', 9, 3);
      await expect(
        opening.approve({
          organizationId: seed.organizationId,
          productId: seed.products[0],
          approvedOrgTotal: 9,
          allocations: [{ destinationLocationId: seed.storeLocationId, approvedQuantity: 3 }],
          discrepancyReason: 'counted',
          approvedByUserId: OWNER.kind === 'USER' ? OWNER.userId : '',
        }),
      ).rejects.toThrow(/does not equal allocations/);
    });

    it('refuses a divergent approval with no stated reason', async () => {
      const seed = await prepare('unexplained', 9, 3);
      await expect(
        opening.approve({
          organizationId: seed.organizationId,
          productId: seed.products[0],
          approvedOrgTotal: 9,
          allocations: [
            { destinationLocationId: seed.storeLocationId, approvedQuantity: 3 },
            { destinationLocationId: seed.warehouseId, approvedQuantity: 6 },
          ],
          approvedByUserId: OWNER.kind === 'USER' ? OWNER.userId : '',
        }),
      ).rejects.toThrow(/must record why this total was chosen/);
    });

    it('refuses a negative approved allocation', async () => {
      const seed = await prepare('negative', 9, 3);
      await expect(
        opening.approve({
          organizationId: seed.organizationId,
          productId: seed.products[0],
          approvedOrgTotal: 3,
          allocations: [
            { destinationLocationId: seed.storeLocationId, approvedQuantity: 6 },
            { destinationLocationId: seed.warehouseId, approvedQuantity: -3 },
          ],
          discrepancyReason: 'counted',
          approvedByUserId: OWNER.kind === 'USER' ? OWNER.userId : '',
        }),
      ).rejects.toThrow(/cannot be negative/);
    });

    it('refuses a duplicate destination', async () => {
      const seed = await prepare('duplicate', 9, 3);
      await expect(
        opening.approve({
          organizationId: seed.organizationId,
          productId: seed.products[0],
          approvedOrgTotal: 6,
          allocations: [
            { destinationLocationId: seed.storeLocationId, approvedQuantity: 3 },
            { destinationLocationId: seed.storeLocationId, approvedQuantity: 3 },
          ],
          discrepancyReason: 'counted',
          approvedByUserId: OWNER.kind === 'USER' ? OWNER.userId : '',
        }),
      ).rejects.toThrow(/One approved quantity per destination/);
    });

    it('accepts a balanced, explained approval and records the approver', async () => {
      const seed = await prepare('approved', 9, 3);
      await opening.approve({
        organizationId: seed.organizationId,
        productId: seed.products[0],
        approvedOrgTotal: 9,
        allocations: [
          { destinationLocationId: seed.storeLocationId, approvedQuantity: 3 },
          { destinationLocationId: seed.warehouseId, approvedQuantity: 6 },
        ],
        discrepancyReason: 'physical count 2026-08-20; branch held 3, warehouse held 6',
        approvedByUserId: OWNER.kind === 'USER' ? OWNER.userId : '',
      });
      const rows: { status: string; approved_org_total: number; approved_by_user_id: string; reason: string }[] =
        await em.execute(
          `select status, approved_org_total, approved_by_user_id, discrepancy_reason as reason
             from inventory_opening_reconciliations where organization_id = ?::uuid`,
          [seed.organizationId],
        );
      expect(rows[0].status).toBe('APPROVED');
      expect(rows[0].approved_org_total).toBe(9);
      expect(rows[0].approved_by_user_id).toBe(OWNER.kind === 'USER' ? OWNER.userId : '');
      expect(rows[0].reason).toMatch(/physical count/);
    });

    it('refuses to approve twice', async () => {
      const seed = await prepare('twice', 4, 4);
      const approval = {
        organizationId: seed.organizationId,
        productId: seed.products[0],
        approvedOrgTotal: 4,
        allocations: [{ destinationLocationId: seed.storeLocationId, approvedQuantity: 4 }],
        approvedByUserId: OWNER.kind === 'USER' ? OWNER.userId : '',
      };
      await opening.approve(approval);
      await expect(opening.approve(approval)).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('the ambiguity gate', () => {
    it('blocks an organization with an unreconciled product', async () => {
      const seed = await seedLegacy('unreconciled', [{ product: 3, store: 3 }]);
      await opening.bootstrapLocations(seed.organizationId);
      const blockers = await opening.openingBlockers(seed.organizationId);
      expect(blockers.map((b) => b.code)).toContain('PRODUCT_NOT_APPROVED');
      await expect(opening.postOpening(seed.organizationId, OWNER)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('blocks an organization with no default warehouse', async () => {
      const seed = await seedLegacy('no-warehouse', [{ product: 0, store: 0 }]);
      const blockers = await opening.openingBlockers(seed.organizationId);
      expect(blockers.map((b) => b.code)).toContain('NO_DEFAULT_WAREHOUSE');
    });

    it('blocks a negative legacy quantity', async () => {
      const seed = await seedLegacy('negative-legacy', [{ product: 1, store: 1 }]);
      await opening.bootstrapLocations(seed.organizationId);
      await em.execute(`update products set stock_quantity = -2 where id = ?::uuid`, [seed.products[0]]);
      const blockers = await opening.openingBlockers(seed.organizationId);
      expect(blockers.map((b) => b.code)).toContain('NEGATIVE_LEGACY_QUANTITY');
    });

    it('blocks an archived product still holding stock', async () => {
      const seed = await seedLegacy('archived', [{ product: 5, store: 5 }]);
      await opening.bootstrapLocations(seed.organizationId);
      await em.execute(`update products set archived_at = now() where id = ?::uuid`, [seed.products[0]]);
      const blockers = await opening.openingBlockers(seed.organizationId);
      expect(blockers.map((b) => b.code)).toContain('ARCHIVED_PRODUCT_HOLDS_STOCK');
    });

    it('blocks when the legacy data moved after approval', async () => {
      const seed = await seedLegacy('drift', [{ product: 5, store: 5 }]);
      await opening.bootstrapLocations(seed.organizationId);
      await proposals.propose(seed.organizationId);
      const locations: { id: string }[] = await em.execute(
        `select id from inventory_locations where organization_id = ?::uuid and kind = 'STORE'`,
        [seed.organizationId],
      );
      await opening.approve({
        organizationId: seed.organizationId,
        productId: seed.products[0],
        approvedOrgTotal: 5,
        allocations: [{ destinationLocationId: locations[0].id, approvedQuantity: 5 }],
        approvedByUserId: OWNER.kind === 'USER' ? OWNER.userId : '',
      });
      expect(await opening.openingBlockers(seed.organizationId)).toEqual([]);

      // Somebody sells a unit through the legacy path after the approval.
      await em.execute(`update store_products set stock_quantity = 4 where product_id = ?::uuid`, [seed.products[0]]);
      const blockers = await opening.openingBlockers(seed.organizationId);
      expect(blockers.map((b) => b.code)).toContain('LEGACY_DATA_MOVED_SINCE_APPROVAL');
      await expect(opening.postOpening(seed.organizationId, OWNER)).rejects.toThrow(/blocked/);
    });
  });

  describe('the opening epoch', () => {
    it('posts every approved product and reconciles exactly', async () => {
      const seed = await seedLegacy('epoch', [
        { product: 5, store: 5 },
        { product: 6, store: 0 },
        { product: 0, store: 0 },
      ]);
      await opening.bootstrapLocations(seed.organizationId);
      await proposals.propose(seed.organizationId);
      const locations: { id: string; kind: string }[] = await em.execute(
        `select id, kind from inventory_locations where organization_id = ?::uuid order by kind`,
        [seed.organizationId],
      );
      const storeLocationId = locations.find((l) => l.kind === 'STORE')!.id;
      const warehouseId = locations.find((l) => l.kind === 'WAREHOUSE')!.id;

      await opening.approve({
        organizationId: seed.organizationId,
        productId: seed.products[0],
        approvedOrgTotal: 5,
        allocations: [{ destinationLocationId: storeLocationId, approvedQuantity: 5 }],
        approvedByUserId: OWNER.kind === 'USER' ? OWNER.userId : '',
      });
      await opening.approve({
        organizationId: seed.organizationId,
        productId: seed.products[1],
        approvedOrgTotal: 6,
        allocations: [{ destinationLocationId: warehouseId, approvedQuantity: 6 }],
        discrepancyReason: 'all six were in the warehouse',
        approvedByUserId: OWNER.kind === 'USER' ? OWNER.userId : '',
      });
      await opening.approve({
        organizationId: seed.organizationId,
        productId: seed.products[2],
        approvedOrgTotal: 0,
        allocations: [],
        approvedByUserId: OWNER.kind === 'USER' ? OWNER.userId : '',
      });

      expect(await opening.openingBlockers(seed.organizationId)).toEqual([]);
      const result = await opening.postOpening(seed.organizationId, OWNER);
      expect(result.posted).toBe(2);
      expect(result.zeroTotal).toBe(1);

      expect(await reconciliation.organizationPhysicalTotal(seed.organizationId, seed.products[0])).toBe(5);
      expect(await reconciliation.storeHeldQuantity(seed.organizationId, seed.storeId, seed.products[0])).toBe(5);
      expect(await reconciliation.organizationPhysicalTotal(seed.organizationId, seed.products[1])).toBe(6);
      expect(await reconciliation.storeHeldQuantity(seed.organizationId, seed.storeId, seed.products[1])).toBe(0);
      expect(await reconciliation.verifyAll(seed.organizationId)).toEqual([]);

      const statuses: { status: string; posted: string | null }[] = await em.execute(
        `select status, posted_transaction_id as posted from inventory_opening_reconciliations
          where organization_id = ?::uuid order by product_id`,
        [seed.organizationId],
      );
      expect(statuses.every((row) => row.status === 'POSTED')).toBe(true);
      expect(statuses.filter((row) => row.posted === null)).toHaveLength(1);
    });

    it('a zero-total opening settles a stale legacy cache, so the organization can still unfreeze', async () => {
      // The P5-X2 rehearsal measured this exact shape: a PRODUCT_ONLY product
      // whose legacy cache said 5, opened at ZERO by owner decision. The epoch
      // posts nothing for it — correct — but before the zero branch synced the
      // compatibility caches, the cache stayed 5 against a ledger of 0,
      // LEGACY_PRODUCT_CACHE_EQUALITY stayed red forever, and unfreeze (which
      // demands green reconciliation) was structurally impossible.
      const seed = await seedLegacy('zero-open-stale-cache', [{ product: 5, store: null }]);
      await opening.bootstrapLocations(seed.organizationId);
      await proposals.propose(seed.organizationId);
      const [proposed]: { discrepancy_class: string }[] = await em.execute(
        `select discrepancy_class from inventory_opening_reconciliations
          where organization_id = ?::uuid and product_id = ?::uuid`,
        [seed.organizationId, seed.products[0]],
      );
      expect(proposed.discrepancy_class).toBe('PRODUCT_ONLY');

      await opening.approve({
        organizationId: seed.organizationId,
        productId: seed.products[0],
        approvedOrgTotal: 0,
        allocations: [],
        discrepancyReason: 'owner-directed zero open: test-fixture residue',
        approvedByUserId: OWNER.kind === 'USER' ? OWNER.userId : '',
      });
      const result = await opening.postOpening(seed.organizationId, OWNER);
      expect(result).toEqual({ posted: 0, zeroTotal: 1, transactionIds: [] });

      const [caches]: { product: number; store: number | null }[] = await em.execute(
        `select p.stock_quantity as product, sp.stock_quantity as store
           from products p left join store_products sp on sp.product_id = p.id
          where p.id = ?::uuid`,
        [seed.products[0]],
      );
      // The stale 5 is settled to the ledger's truth: zero.
      expect(Number(caches.product)).toBe(0);
      expect(await reconciliation.verifyAll(seed.organizationId)).toEqual([]);
    });

    it('is idempotent — re-running the epoch posts nothing new', async () => {
      const seed = await seedLegacy('epoch-twice', [{ product: 4, store: 4 }]);
      await opening.bootstrapLocations(seed.organizationId);
      await proposals.propose(seed.organizationId);
      const locations: { id: string }[] = await em.execute(
        `select id from inventory_locations where organization_id = ?::uuid and kind = 'STORE'`,
        [seed.organizationId],
      );
      await opening.approve({
        organizationId: seed.organizationId,
        productId: seed.products[0],
        approvedOrgTotal: 4,
        allocations: [{ destinationLocationId: locations[0].id, approvedQuantity: 4 }],
        approvedByUserId: OWNER.kind === 'USER' ? OWNER.userId : '',
      });
      await opening.postOpening(seed.organizationId, OWNER);
      const second = await opening.postOpening(seed.organizationId, OWNER);
      expect(second.posted).toBe(0);
      expect(await reconciliation.organizationPhysicalTotal(seed.organizationId, seed.products[0])).toBe(4);
    });

    it('leaves the legacy columns untouched — conversion is B3', async () => {
      const seed = await seedLegacy('legacy-intact', [{ product: 7, store: 7 }]);
      await opening.bootstrapLocations(seed.organizationId);
      await proposals.propose(seed.organizationId);
      const locations: { id: string }[] = await em.execute(
        `select id from inventory_locations where organization_id = ?::uuid and kind = 'STORE'`,
        [seed.organizationId],
      );
      await opening.approve({
        organizationId: seed.organizationId,
        productId: seed.products[0],
        approvedOrgTotal: 7,
        allocations: [{ destinationLocationId: locations[0].id, approvedQuantity: 7 }],
        approvedByUserId: OWNER.kind === 'USER' ? OWNER.userId : '',
      });
      await opening.postOpening(seed.organizationId, OWNER);
      const rows: { product: number; store: number }[] = await em.execute(
        `select p.stock_quantity as product, sp.stock_quantity as store
           from products p join store_products sp on sp.product_id = p.id where p.id = ?::uuid`,
        [seed.products[0]],
      );
      expect(rows[0]).toEqual({ product: 7, store: 7 });
    });
  });

  describe('an approved reconciliation is evidence', () => {
    it('refuses to edit or delete it once approved', async () => {
      const seed = await seedLegacy('evidence', [{ product: 2, store: 2 }]);
      await opening.bootstrapLocations(seed.organizationId);
      await proposals.propose(seed.organizationId);
      const locations: { id: string }[] = await em.execute(
        `select id from inventory_locations where organization_id = ?::uuid and kind = 'STORE'`,
        [seed.organizationId],
      );
      await opening.approve({
        organizationId: seed.organizationId,
        productId: seed.products[0],
        approvedOrgTotal: 2,
        allocations: [{ destinationLocationId: locations[0].id, approvedQuantity: 2 }],
        approvedByUserId: OWNER.kind === 'USER' ? OWNER.userId : '',
      });
      await expect(
        em.execute(
          `update inventory_opening_reconciliations set approved_org_total = 99 where organization_id = ?::uuid`,
          [seed.organizationId],
        ),
      ).rejects.toThrow(/may only move to POSTED/);
      await expect(
        em.execute(`delete from inventory_opening_reconciliations where organization_id = ?::uuid`, [
          seed.organizationId,
        ]),
      ).rejects.toThrow(/cannot be deleted/);
    });

    it('refuses a non-zero opening transit that names no transfer', async () => {
      const seed = await seedLegacy('transit-zero', [{ product: 1, store: 1 }]);
      await opening.bootstrapLocations(seed.organizationId);
      await proposals.propose(seed.organizationId);
      await expect(
        em.execute(
          `update inventory_opening_reconciliations set approved_in_transit_quantity = 3 where organization_id = ?::uuid`,
          [seed.organizationId],
        ),
        // B2 pinned this to zero because nothing existed to reference. B5
        // replaced that with the real rule: transit may be declared, but only
        // against a transfer.
      ).rejects.toThrow(/transit_needs_transfer/);
    });
  });
});
