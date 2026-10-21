import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { prepareLedger, realStock } from '../../../../../test/inventory-stock-support';
import { InventoryController } from '../../inventory.controller';
import { InventoryCommandService } from '../../ledger/inventory-command.service';
import { InventoryPostingService } from '../../ledger/inventory-posting.service';
import { InventoryReconciliationService } from '../../ledger/inventory-reconciliation.service';
import { InventoryStockService } from '../../ledger/inventory-stock.service';
import { InventoryTransferService } from '../../transfers/inventory-transfer.service';
import { InventoryLocation } from '../../entities/inventory-location.entity';
import { InventoryTransaction } from '../../entities/inventory-transaction.entity';
import { InventoryTransfer } from '../../entities/inventory-transfer.entity';
import { InventoryBalance } from '../../entities/inventory-balance.entity';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const ACTOR = { id: '6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f', email: 'manager@example.com' };

/**
 * Phase 8 — the operational inventory SURFACE against a real ledger.
 *
 * The service-layer authority is proved by `inventory-commands.pg.spec.ts`.
 * What is new here is the route surface an operator actually reaches: that its
 * reads are tenant-isolated and branch-narrowed, that a command issued through
 * it leaves the invariants intact, and that a repeated delta command applies
 * ONCE. The last one is the property a screen with a submit button needs and a
 * service called from another service never did.
 */
d('Phase 8 inventory surface (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let controller: InventoryController;
  let reconciliation: InventoryReconciliationService;
  let auditCalls: any[];

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
    const loc = await prepareLedger(em, {
      organizationId: org.id,
      storeId: store.id,
      productId: opening > 0 ? product.id : null,
      quantity: opening,
    });
    return { organizationId: org.id, storeId: store.id, productId: product.id, ...loc };
  };

  const manager = (organizationId: string): TenantScope => ({
    platform: false,
    role: 'ORGANIZATION_MANAGER',
    organizationId,
    storeId: null,
    allowedStoreIds: [],
  });
  const branchAdmin = (organizationId: string, storeId: string): TenantScope => ({
    platform: false,
    role: 'ADMIN',
    organizationId,
    storeId,
    allowedStoreIds: [storeId],
  });
  const req = (scope: TenantScope) => ({ scope, user: ACTOR });

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    auditCalls = [];

    const stock: InventoryStockService = realStock(em);
    const posting: any = Object.create(InventoryPostingService.prototype);
    posting.transactionRepository = em.getRepository(InventoryTransaction);

    const commands: any = Object.create(InventoryCommandService.prototype);
    commands.locationRepository = em.getRepository(InventoryLocation);
    commands.posting = posting;
    commands.stock = stock;
    commands.auditLogService = {
      recordAuditEntry: jest.fn(async (...args: any[]) => {
        auditCalls.push(args);
      }),
    };

    const transfers: any = Object.create(InventoryTransferService.prototype);
    transfers.transferRepository = em.getRepository(InventoryTransfer);
    transfers.posting = posting;

    reconciliation = Object.create(InventoryReconciliationService.prototype);
    (reconciliation as any).balanceRepository = em.getRepository(InventoryBalance);

    controller = new InventoryController(
      em,
      stock,
      commands as InventoryCommandService,
      transfers as InventoryTransferService,
      reconciliation,
      commands.auditLogService,
    );
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  beforeEach(() => {
    auditCalls = [];
  });

  describe('reads are scoped to the tenant that asks', () => {
    it("never reports another organization's stock", async () => {
      const mine = await seed('read-mine', 9);
      const foreign = await seed('read-foreign', 40);

      const asMine = await controller.productStock(req(manager(mine.organizationId)), mine.productId);
      expect(asMine.data.organizationTotal).toBe(9);

      // The FOREIGN product read under my scope answers with nothing at all,
      // rather than leaking a number that belongs to another company.
      const leak = await controller.productStock(req(manager(mine.organizationId)), foreign.productId);
      expect(leak.data.organizationTotal).toBe(0);
      expect(leak.data.perStore.every((row: any) => row.storeId !== foreign.storeId)).toBe(true);
    });

    it('shows a branch administrator ITS OWN branch and no sibling', async () => {
      const s = await seed('read-branch', 6);
      const [sibling]: { id: string }[] = await em.execute(
        `insert into stores (name, slug, organization_id, created_at, updated_at)
         values (?, ?, ?::uuid, now(), now()) returning id`,
        [`sib-${Date.now()}`, `sib-${Date.now()}`, s.organizationId],
      );

      const asManager = await controller.productStock(req(manager(s.organizationId)), s.productId);
      expect(asManager.data.perStore.length).toBeGreaterThanOrEqual(2);

      const asBranch = await controller.productStock(req(branchAdmin(s.organizationId, s.storeId)), s.productId);
      expect(asBranch.data.perStore.map((row: any) => row.storeId)).toEqual([s.storeId]);
      expect(asBranch.data.perStore.map((row: any) => row.storeId)).not.toContain(sibling.id);
      // the company total is still answered: it is the number its own share is part of
      expect(asBranch.data.organizationTotal).toBe(6);
    });

    it('separates what is owned from what can be sold', async () => {
      const s = await seed('read-sellable', 5);
      const view = await controller.productStock(req(manager(s.organizationId)), s.productId);
      expect(view.data.organizationTotal).toBe(5);
      expect(typeof view.data.sellable).toBe('number');
      expect(view.data).toHaveProperty('reserved');
      expect(view.data).toHaveProperty('nonSellable');
      expect(view.data).toHaveProperty('inTransit');
    });

    it('lists only the locations the caller may see', async () => {
      const s = await seed('read-locations', 3);
      const all = await controller.locations(req(manager(s.organizationId)));
      expect(all.data.some((row: any) => row.kind === 'WAREHOUSE')).toBe(true);

      const branchView = await controller.locations(req(branchAdmin(s.organizationId, s.storeId)));
      expect(branchView.data.every((row: any) => row.kind === 'STORE' && row.storeId === s.storeId)).toBe(true);
    });
  });

  describe('a command issued through the surface', () => {
    it('moves the numbers and leaves the invariants intact', async () => {
      const s = await seed('cmd-recount', 10);
      const before = await controller.productStock(req(manager(s.organizationId)), s.productId);
      expect(before.data.organizationTotal).toBe(10);

      const result = await controller.recount(req(manager(s.organizationId)), {
        productId: s.productId,
        locationId: s.storeLocationId!,
        countedQuantity: 4,
        reason: 'annual count',
      } as never);
      expect(result.data.posted).toBe(true);

      const after = await controller.productStock(req(manager(s.organizationId)), s.productId);
      expect(after.data.organizationTotal).toBe(4);

      // POSTCONDITION: the ledger still reconciles with itself after the command
      const findings = await reconciliation.verifyAll(s.organizationId, em);
      expect(findings).toEqual([]);
    });

    it('converges when a recount is repeated — a retry is not a second adjustment', async () => {
      const s = await seed('cmd-retry', 8);
      const body = {
        productId: s.productId,
        locationId: s.storeLocationId!,
        countedQuantity: 5,
        reason: 'count',
      } as never;
      await controller.recount(req(manager(s.organizationId)), body);
      const first = await controller.productStock(req(manager(s.organizationId)), s.productId);
      await controller.recount(req(manager(s.organizationId)), body);
      const second = await controller.productStock(req(manager(s.organizationId)), s.productId);
      expect(second.data.organizationTotal).toBe(first.data.organizationTotal);
      expect(second.data.organizationTotal).toBe(5);
    });

    it('applies a repeated DELTA command exactly once under one idempotency key', async () => {
      const s = await seed('cmd-idem', 12);
      const body = {
        productId: s.productId,
        locationId: s.storeLocationId!,
        quantity: 3,
        from: { physicalCondition: 'GOOD', operationalState: 'AVAILABLE' },
        to: { physicalCondition: 'DAMAGED', operationalState: 'NON_SELLABLE' },
        reason: 'water damage',
      } as never;
      const key = `phase8-reclassify-${Math.random().toString(16).slice(2)}`;

      await controller.reclassify(req(manager(s.organizationId)), body, key);
      const once = await controller.productStock(req(manager(s.organizationId)), s.productId);

      // the same submit again — the operator's browser retried
      await controller.reclassify(req(manager(s.organizationId)), body, key);
      const twice = await controller.productStock(req(manager(s.organizationId)), s.productId);

      expect(twice.data.nonSellable).toBe(once.data.nonSellable);
      expect(twice.data.organizationTotal).toBe(once.data.organizationTotal);
      expect(await reconciliation.verifyAll(s.organizationId, em)).toEqual([]);
    });

    it('records the operator decision in audit history', async () => {
      const s = await seed('cmd-audit', 4);
      await controller.recount(req(manager(s.organizationId)), {
        productId: s.productId,
        locationId: s.storeLocationId!,
        countedQuantity: 2,
        reason: 'spot check',
      } as never);
      expect(auditCalls.length).toBeGreaterThan(0);
    });
  });

  describe('history', () => {
    it('answers with the movements behind the numbers', async () => {
      const s = await seed('history', 7);
      await controller.recount(req(manager(s.organizationId)), {
        productId: s.productId,
        locationId: s.storeLocationId!,
        countedQuantity: 3,
        reason: 'count',
      } as never);
      const history = await controller.history(req(manager(s.organizationId)), s.productId, '50');
      expect(history.data.length).toBeGreaterThan(0);
      expect(history.data[0]).toHaveProperty('quantityDelta');
      expect(history.data[0]).toHaveProperty('postedAt');
    });

    it("never shows one organization another's movements", async () => {
      const mine = await seed('history-mine', 5);
      const foreign = await seed('history-foreign', 5);
      const leak = await controller.history(req(manager(mine.organizationId)), foreign.productId, '50');
      expect(leak.data).toEqual([]);
    });
  });

  describe('turning a travelling transfer around (Phase 8 return routes)', () => {
    const statusOf = async (transferId: string) => {
      const rows: { status: string }[] = await em.execute(`select status from inventory_transfers where id = ?::uuid`, [
        transferId,
      ]);
      return rows[0].status;
    };
    const cell = async (s: { organizationId: string; productId: string }, locationId: string | null, state: string) => {
      const rows: { q: number }[] = await em.execute(
        `select coalesce(sum(quantity), 0)::int as q from inventory_balances
          where organization_id = ?::uuid and product_id = ?::uuid
            and operational_state = ? and location_id is not distinct from ?::uuid`,
        [s.organizationId, s.productId, state, locationId],
      );
      return rows[0].q;
    };

    it('reverses part of the road and lands it back on the source shelf', async () => {
      const s = await seed('return-partial', 10);
      const scope = req(manager(s.organizationId));

      const created = await controller.createTransfer(scope, {
        sourceLocationId: s.storeLocationId!,
        destinationLocationId: s.warehouseId,
        lines: [{ productId: s.productId, quantity: 5 }],
      } as never);
      const transferId = created.data.id;
      await controller.commitTransfer(scope, transferId);
      await controller.dispatchTransfer(scope, transferId, {} as never);
      expect(await statusOf(transferId)).toBe('IN_TRANSIT');

      // Two of the five turn around while three continue to the destination.
      await controller.startTransferReturn(scope, transferId, { quantities: { [s.productId]: 2 } } as never);
      expect(await statusOf(transferId)).toBe('RETURNING');

      await controller.completeTransferReturn(scope, transferId);
      // 10 opened, 5 left, 2 came home: the source shelf holds 7 sellable.
      expect(await cell(s, s.storeLocationId, 'AVAILABLE')).toBe(7);

      // The other three arrive where they were going; the transfer settles.
      await controller.receiveTransfer(scope, transferId, {} as never);
      expect(await statusOf(transferId)).toBe('COMPLETED');
      expect(await cell(s, s.warehouseId, 'AVAILABLE')).toBe(3);

      // Nothing was created or destroyed on the way, and the ledger agrees
      // with itself afterwards.
      const view = await controller.productStock(scope, s.productId);
      expect(view.data.organizationTotal).toBe(10);
      expect(await reconciliation.verifyAll(s.organizationId, em)).toEqual([]);
    });

    it('records both return decisions in audit history', async () => {
      const s = await seed('return-audit', 4);
      const scope = req(manager(s.organizationId));
      const created = await controller.createTransfer(scope, {
        sourceLocationId: s.storeLocationId!,
        destinationLocationId: s.warehouseId,
        lines: [{ productId: s.productId, quantity: 2 }],
      } as never);
      await controller.commitTransfer(scope, created.data.id);
      await controller.dispatchTransfer(scope, created.data.id, {} as never);

      auditCalls = [];
      await controller.startTransferReturn(scope, created.data.id, {} as never);
      await controller.completeTransferReturn(scope, created.data.id);
      expect(auditCalls.length).toBe(2);
    });

    it("refuses another organization's transfer with a plain not-found", async () => {
      const mine = await seed('return-mine', 6);
      const foreign = await seed('return-foreign', 6);
      const scope = req(manager(mine.organizationId));
      const created = await controller.createTransfer(scope, {
        sourceLocationId: mine.storeLocationId!,
        destinationLocationId: mine.warehouseId,
        lines: [{ productId: mine.productId, quantity: 3 }],
      } as never);
      await controller.commitTransfer(scope, created.data.id);
      await controller.dispatchTransfer(scope, created.data.id, {} as never);

      const thief = req(manager(foreign.organizationId));
      await expect(controller.startTransferReturn(thief, created.data.id, {} as never)).rejects.toThrow(
        /Transfer not found/,
      );
      await expect(controller.completeTransferReturn(thief, created.data.id)).rejects.toThrow(/Transfer not found/);
      // and the transfer is exactly where its owner left it
      expect(await statusOf(created.data.id)).toBe('IN_TRANSIT');
    });
  });
});
