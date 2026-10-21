import { EntityManager } from '@mikro-orm/postgresql';
import { ForbiddenException } from '@nestjs/common';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { prepareLedger, realStock } from '../../../../../test/inventory-stock-support';
import { InventoryCommandService } from '../../ledger/inventory-command.service';
import { InventoryPostingService } from '../../ledger/inventory-posting.service';
import { InventoryReconciliationService } from '../../ledger/inventory-reconciliation.service';
import { InventoryStockService } from '../../ledger/inventory-stock.service';
import { InventoryLocation } from '../../entities/inventory-location.entity';
import { InventoryTransaction } from '../../entities/inventory-transaction.entity';
import { InventoryBalance } from '../../entities/inventory-balance.entity';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const ACTOR = { id: '6f6f6f6f-6f6f-4f6f-8f6f-6f6f6f6f6f6f', email: 'manager@example.com' };

/**
 * P5-B8 — the operator commands, their authority, and the audit contract.
 *
 * Two questions are answered here and nowhere else: who may issue an inventory
 * command (ADR 014), and which acts earn an audit-history row on top of the
 * ledger. The second is the reconciliation this boundary owed: operator
 * decisions are audited, workflow consequences are not, and the ledger remains
 * the record of record either way.
 */
d('P5-B8 inventory commands, authority and audit (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let commands: InventoryCommandService;
  let stock: InventoryStockService;
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

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    stock = realStock(em);
    auditCalls = [];
    const posting: any = Object.create(InventoryPostingService.prototype);
    posting.transactionRepository = em.getRepository(InventoryTransaction);
    commands = Object.create(InventoryCommandService.prototype);
    (commands as any).locationRepository = em.getRepository(InventoryLocation);
    (commands as any).posting = posting;
    (commands as any).stock = stock;
    (commands as any).auditLogService = {
      recordAuditEntry: jest.fn(async (...args: any[]) => {
        auditCalls.push(args);
      }),
    };
    reconciliation = Object.create(InventoryReconciliationService.prototype);
    (reconciliation as any).balanceRepository = em.getRepository(InventoryBalance);
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  beforeEach(() => {
    auditCalls = [];
    ((commands as any).auditLogService.recordAuditEntry as jest.Mock).mockClear();
  });

  describe('authority (ADR 014)', () => {
    it('lets an organization manager recount anywhere in its own organization', async () => {
      const s = await seed('om-recount', 5);
      const result = await commands.recount({
        scope: manager(s.organizationId),
        actor: ACTOR,
        productId: s.productId,
        locationId: s.warehouseId,
        countedQuantity: 3,
        reason: 'annual count',
      });
      expect(result).toEqual({ posted: true, delta: 3 });
    });

    it('lets a branch ADMIN recount ITS OWN branch', async () => {
      const s = await seed('admin-own', 4);
      await expect(
        commands.recount({
          scope: branchAdmin(s.organizationId, s.storeId),
          actor: ACTOR,
          productId: s.productId,
          locationId: s.storeLocationId!,
          countedQuantity: 6,
          reason: 'shelf count',
        }),
      ).resolves.toEqual({ posted: true, delta: 2 });
    });

    it('refuses a branch ADMIN recounting the warehouse', async () => {
      const s = await seed('admin-warehouse', 4);
      await expect(
        commands.recount({
          scope: branchAdmin(s.organizationId, s.storeId),
          actor: ACTOR,
          productId: s.productId,
          locationId: s.warehouseId,
          countedQuantity: 1,
          reason: 'nope',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a branch ADMIN recounting a sibling branch', async () => {
      const s = await seed('admin-sibling', 4);
      const [sibling]: { id: string }[] = await em.execute(
        `insert into stores (name, slug, organization_id, created_at, updated_at)
         values (?, ?, ?::uuid, now(), now()) returning id`,
        [`sib-${Date.now()}`, `sib-${Date.now()}`, s.organizationId],
      );
      const siblingLocation = await commands.ensureStoreLocation({
        scope: manager(s.organizationId),
        actor: ACTOR,
        storeId: sibling.id,
        name: 'sibling custody',
      });
      await expect(
        commands.recount({
          scope: branchAdmin(s.organizationId, s.storeId),
          actor: ACTOR,
          productId: s.productId,
          locationId: siblingLocation,
          countedQuantity: 1,
          reason: 'nope',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([
      [
        'reclassify',
        (s: any) =>
          commands.reclassifySellability({
            scope: branchAdmin(s.organizationId, s.storeId),
            actor: ACTOR,
            productId: s.productId,
            locationId: s.storeLocationId!,
            quantity: 1,
            from: { physicalCondition: 'GOOD', operationalState: 'AVAILABLE' },
            to: { physicalCondition: 'DAMAGED', operationalState: 'NON_SELLABLE' },
            reason: 'nope',
          }),
      ],
      [
        'create a warehouse',
        (s: any) =>
          commands.createWarehouse({
            scope: branchAdmin(s.organizationId, s.storeId),
            actor: ACTOR,
            code: 'WH-2',
            name: 'Second',
          }),
      ],
      [
        'change the default warehouse',
        (s: any) =>
          commands.setDefaultWarehouse({
            scope: branchAdmin(s.organizationId, s.storeId),
            actor: ACTOR,
            locationId: s.warehouseId,
          }),
      ],
    ])('refuses a branch ADMIN trying to %s', async (_label, run) => {
      const s = await seed('admin-refused', 3);
      await expect(run(s)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses an actor with no organization in scope', async () => {
      const s = await seed('no-scope', 2);
      await expect(
        commands.recount({
          scope: { platform: true, role: 'SUPER_ADMIN', organizationId: null, storeId: null, allowedStoreIds: [] },
          actor: ACTOR,
          productId: s.productId,
          locationId: s.warehouseId,
          countedQuantity: 1,
          reason: 'nope',
        }),
      ).rejects.toThrow();
    });
  });

  describe('the commands themselves', () => {
    it('reclassifies damaged units into sellable ones, and back', async () => {
      const s = await seed('reclass', 6);
      await commands.reclassifySellability({
        scope: manager(s.organizationId),
        actor: ACTOR,
        productId: s.productId,
        locationId: s.storeLocationId!,
        quantity: 2,
        from: { physicalCondition: 'GOOD', operationalState: 'AVAILABLE' },
        to: { physicalCondition: 'DAMAGED', operationalState: 'NON_SELLABLE' },
        reason: 'water damage',
      });
      expect(await reconciliation.sellableQuantity(s.organizationId, s.productId)).toBe(4);
      expect(await stock.organizationTotal(em, s.organizationId, s.productId)).toBe(6);

      await commands.reclassifySellability({
        scope: manager(s.organizationId),
        actor: ACTOR,
        productId: s.productId,
        locationId: s.storeLocationId!,
        quantity: 2,
        from: { physicalCondition: 'DAMAGED', operationalState: 'NON_SELLABLE' },
        to: { physicalCondition: 'DAMAGED', operationalState: 'AVAILABLE' },
        reason: 'sold as seconds',
      });
      // DAMAGED + AVAILABLE is legal and sellable (ADR 013 §2).
      expect(await reconciliation.sellableQuantity(s.organizationId, s.productId)).toBe(6);
      expect(await reconciliation.verifyAll(s.organizationId)).toEqual([]);
    });

    it('reassigns stock between two unrelated products', async () => {
      const s = await seed('reassign', 5);
      const [other]: { id: string }[] = await em.execute(
        `insert into products (name, slug, organization_id, created_at, updated_at)
         values (?, ?, ?::uuid, now(), now()) returning id`,
        [`other-${Date.now()}`, `other-${Date.now()}`, s.organizationId],
      );
      await commands.reassignStock({
        scope: manager(s.organizationId),
        actor: ACTOR,
        sourceProductId: s.productId,
        destinationProductId: other.id,
        locationId: s.storeLocationId!,
        quantity: 3,
        reason: 'mislabelled at intake',
      });
      expect(await stock.organizationTotal(em, s.organizationId, s.productId)).toBe(2);
      expect(await stock.organizationTotal(em, s.organizationId, other.id)).toBe(3);
      expect(await reconciliation.verifyAll(s.organizationId)).toEqual([]);
    });

    it('distributes a family card across its versions, preserving the total', async () => {
      const s = await seed('distribute', 9);
      const children: string[] = [];
      for (const label of ['a', 'b']) {
        const [child]: { id: string }[] = await em.execute(
          `insert into products (name, slug, organization_id, parent_id, created_at, updated_at)
           values (?, ?, ?::uuid, ?::uuid, now(), now()) returning id`,
          [`c${label}-${Date.now()}`, `c${label}-${Date.now()}`, s.organizationId, s.productId],
        );
        children.push(child.id);
      }
      await commands.distributeFamilyStock({
        scope: manager(s.organizationId),
        actor: ACTOR,
        rootProductId: s.productId,
        locationId: s.storeLocationId!,
        allocations: [
          { productId: children[0], quantity: 5 },
          { productId: children[1], quantity: 4 },
        ],
        reason: 'versions identified',
      });
      expect(await stock.organizationTotal(em, s.organizationId, s.productId)).toBe(0);
      expect(await stock.organizationTotal(em, s.organizationId, children[0])).toBe(5);
      expect(await stock.organizationTotal(em, s.organizationId, children[1])).toBe(4);
      expect(await reconciliation.verifyAll(s.organizationId)).toEqual([]);
    });

    it('administers locations: creates a warehouse and moves the default', async () => {
      const s = await seed('locations', 0);
      const second = await commands.createWarehouse({
        scope: manager(s.organizationId),
        actor: ACTOR,
        code: 'WH-SECOND',
        name: 'Overflow',
      });
      await commands.setDefaultWarehouse({ scope: manager(s.organizationId), actor: ACTOR, locationId: second });
      const rows: { id: string; is_default: boolean }[] = await em.execute(
        `select id, is_default from inventory_locations where organization_id = ?::uuid and kind = 'WAREHOUSE' order by is_default desc`,
        [s.organizationId],
      );
      // Exactly one default, and it moved. The partial unique index would have
      // refused any intermediate state with two.
      expect(rows.filter((row) => row.is_default)).toHaveLength(1);
      expect(rows[0].id).toBe(second);
    });

    it('refuses a warehouse pretending to be branch custody', async () => {
      const s = await seed('code-guard', 0);
      await expect(
        commands.createWarehouse({
          scope: manager(s.organizationId),
          actor: ACTOR,
          code: `STORE:${s.storeId}`,
          name: 'Impostor',
        }),
      ).rejects.toThrow(/belongs to branch custody/);
    });

    it('refuses a command with no stated reason', async () => {
      const s = await seed('no-reason', 3);
      await expect(
        commands.recount({
          scope: manager(s.organizationId),
          actor: ACTOR,
          productId: s.productId,
          locationId: s.warehouseId,
          countedQuantity: 1,
          reason: '   ',
        }),
      ).rejects.toThrow(/must say why/);
    });
  });

  describe('the audit contract', () => {
    it('writes an audit entry for an operator command, with affected-resource context', async () => {
      const s = await seed('audit-command', 4);
      await commands.recount({
        scope: manager(s.organizationId),
        actor: ACTOR,
        productId: s.productId,
        locationId: s.storeLocationId!,
        countedQuantity: 6,
        reason: 'shelf count',
      });
      expect(auditCalls).toHaveLength(1);
      const [actorId, actorEmail, , entityId, , changes, message, context] = auditCalls[0];
      expect(actorId).toBe(ACTOR.id);
      expect(actorEmail).toBe(ACTOR.email);
      expect(entityId).toBe(s.productId);
      expect(changes).toMatchObject({ countedQuantity: 6, delta: 2, reason: 'shelf count' });
      expect(message).toMatch(/Recounted inventory/);
      // #171/#203: the affected organization AND branch, never inferred.
      expect(context).toEqual({ organizationId: s.organizationId, storeId: s.storeId });
    });

    it('records the branch as null for an organization-wide act', async () => {
      const s = await seed('audit-warehouse', 0);
      await commands.createWarehouse({
        scope: manager(s.organizationId),
        actor: ACTOR,
        code: 'WH-AUDIT',
        name: 'Audited',
      });
      expect(auditCalls[0][7]).toEqual({ organizationId: s.organizationId, storeId: null });
    });

    it('does NOT audit a workflow-driven movement — the ledger already holds it', async () => {
      const s = await seed('audit-workflow', 5);
      await em.transactional(async (tem) =>
        stock.issueForSale(tem as EntityManager, {
          organizationId: s.organizationId,
          storeId: s.storeId,
          productId: s.productId,
          quantity: 1,
          idempotencyScope: 'audit-workflow',
        }),
      );
      // A checkout is audited as an ORDER, not as N inventory rows. One audit
      // entry per unit movement would bury the decisions in consequences.
      expect(auditCalls).toHaveLength(0);
      const ledger: { n: number }[] = await em.execute(
        `select count(*)::int as n from inventory_transactions where organization_id = ?::uuid and type = 'SALE_ISSUE'`,
        [s.organizationId],
      );
      expect(ledger[0].n).toBe(1);
    });

    it('a refused command writes neither ledger nor audit', async () => {
      const s = await seed('audit-refused', 3);
      await expect(
        commands.recount({
          scope: branchAdmin(s.organizationId, s.storeId),
          actor: ACTOR,
          productId: s.productId,
          locationId: s.warehouseId,
          countedQuantity: 99,
          reason: 'nope',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(auditCalls).toHaveLength(0);
      expect(await stock.organizationTotal(em, s.organizationId, s.productId)).toBe(3);
    });

    it('the ledger remains the record of record when the audit write fails', async () => {
      const s = await seed('audit-fails', 4);
      const auditor = (commands as any).auditLogService.recordAuditEntry as jest.Mock;
      auditor.mockRejectedValueOnce(new Error('audit sink unavailable'));
      // AuditLogService fails open by design, so this must not be presented as
      // transactionally coupled to the posting. The command still throws — the
      // caller learns — but the ledger movement is already durable and correct.
      await expect(
        commands.recount({
          scope: manager(s.organizationId),
          actor: ACTOR,
          productId: s.productId,
          locationId: s.warehouseId,
          countedQuantity: 9,
          reason: 'count',
        }),
      ).rejects.toThrow(/audit sink unavailable/);
      // The recount targeted the WAREHOUSE, which now holds nine; the four the
      // branch already held are untouched, so the organization owns thirteen.
      const warehouse: { q: number }[] = await em.execute(
        `select coalesce(sum(quantity), 0)::int as q from inventory_balances
          where organization_id = ?::uuid and location_id = ?::uuid and product_id = ?::uuid`,
        [s.organizationId, s.warehouseId, s.productId],
      );
      expect(warehouse[0].q).toBe(9);
      expect(await stock.organizationTotal(em, s.organizationId, s.productId)).toBe(13);
      expect(await reconciliation.verifyAll(s.organizationId)).toEqual([]);
    });
  });
});
