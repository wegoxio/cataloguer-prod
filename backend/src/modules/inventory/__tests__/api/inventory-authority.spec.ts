import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { InventoryController } from '../../inventory.controller';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';

/**
 * Phase 8 decision D1 — who may command the ledger.
 *
 * The canonical boundary is ADR 014 plus ADR 013 §20, and it is deliberately
 * NOT widened for the convenience of a screen: an organization manager runs
 * inventory for its whole company, a branch administrator may RECOUNT its own
 * branch and nothing else, and an editor or viewer commands nothing at all.
 *
 * These tests exercise the CONTROLLER's own gate. The routes additionally carry
 * `@Roles`, and the narrow commands re-assert the boundary inside the service —
 * three independent layers, because hiding a control in the panel is
 * presentation and never enforcement.
 */
const scopeOf = (over: Partial<TenantScope>): TenantScope => ({
  platform: false,
  role: 'ORGANIZATION_MANAGER',
  organizationId: 'org-1',
  storeId: null,
  allowedStoreIds: [],
  ...over,
});

const MANAGER = scopeOf({});
const BRANCH_ADMIN = scopeOf({ role: 'ADMIN', storeId: 'store-a', allowedStoreIds: ['store-a'] });
const UNSCOPED_PLATFORM = scopeOf({ platform: true, role: 'SUPER_ADMIN', organizationId: null });
const SCOPED_PLATFORM = scopeOf({ platform: true, role: 'SUPER_ADMIN' });

describe('inventory command authority (Phase 8 D1)', () => {
  const build = () => {
    const commands = {
      recount: jest.fn().mockResolvedValue({ posted: true, delta: 0 }),
      reclassifySellability: jest.fn().mockResolvedValue(undefined),
      reassignStock: jest.fn().mockResolvedValue(undefined),
      distributeFamilyStock: jest.fn().mockResolvedValue(undefined),
    };
    const transfers = {
      createDraft: jest.fn().mockResolvedValue('transfer-1'),
      commit: jest.fn(),
      dispatch: jest.fn(),
      receive: jest.fn(),
      startReturn: jest.fn(),
      completeReturn: jest.fn(),
      cancel: jest.fn(),
    };
    const em: { execute: jest.Mock; transactional: jest.Mock } = {
      execute: jest.fn().mockResolvedValue([]),
      transactional: jest.fn(async (work: any): Promise<any> => work(em)),
    };
    const reconciliation = {
      verifyAll: jest.fn().mockResolvedValue([]),
      storeHeldQuantity: jest.fn().mockResolvedValue(0),
      organizationPhysicalTotal: jest.fn().mockResolvedValue(0),
      sellableQuantity: jest.fn().mockResolvedValue(0),
    };
    const stock = {
      defaultWarehouseId: jest.fn().mockResolvedValue('wh-1'),
      locationAvailable: jest.fn().mockResolvedValue(0),
    };
    const audit = { recordAuditEntry: jest.fn().mockResolvedValue(undefined) };
    const controller = new InventoryController(
      em as never,
      stock as never,
      commands as never,
      transfers as never,
      reconciliation as never,
      audit as never,
    );
    return { controller, commands, transfers, em, audit, reconciliation };
  };

  const req = (scope: TenantScope) => ({ scope, user: { id: 'u1', email: 'a@b.c' } });
  const KEY = 'idem-key-123456';

  describe('the organization-wide commands', () => {
    const cases: [string, (c: InventoryController, r: any) => Promise<unknown>][] = [
      [
        'reclassify',
        (c, r) =>
          c.reclassify(
            r,
            {
              productId: 'p',
              locationId: 'l',
              quantity: 1,
              from: { physicalCondition: 'GOOD', operationalState: 'AVAILABLE' },
              to: { physicalCondition: 'DAMAGED', operationalState: 'NON_SELLABLE' },
              reason: 'broken',
            } as never,
            KEY,
          ),
      ],
      [
        'reassign',
        (c, r) =>
          c.reassign(
            r,
            {
              sourceProductId: 'a',
              destinationProductId: 'b',
              locationId: 'l',
              quantity: 1,
              reason: 'misfiled',
            } as never,
            KEY,
          ),
      ],
      [
        'distribute',
        (c, r) =>
          c.distribute(
            r,
            {
              rootProductId: 'r',
              locationId: 'l',
              allocations: [{ productId: 'c', quantity: 1 }],
              reason: 'split',
            } as never,
            KEY,
          ),
      ],
      [
        'createTransfer',
        (c, r) =>
          c.createTransfer(r, {
            sourceLocationId: 's',
            destinationLocationId: 'd',
            lines: [{ productId: 'p', quantity: 1 }],
          } as never),
      ],
      ['commitTransfer', (c, r) => c.commitTransfer(r, 't1')],
      ['dispatchTransfer', (c, r) => c.dispatchTransfer(r, 't1', {} as never)],
      ['receiveTransfer', (c, r) => c.receiveTransfer(r, 't1', {} as never)],
      ['startTransferReturn', (c, r) => c.startTransferReturn(r, 't1', {} as never)],
      ['completeTransferReturn', (c, r) => c.completeTransferReturn(r, 't1')],
      ['cancelTransfer', (c, r) => c.cancelTransfer(r, 't1')],
      ['reconciliation', (c, r) => c.reconcile(r)],
    ];

    it.each(cases)('admits the organization manager: %s', async (_name, call) => {
      const { controller } = build();
      await expect(call(controller, req(MANAGER))).resolves.toBeDefined();
    });

    it.each(cases)('REFUSES a branch administrator: %s', async (_name, call) => {
      const { controller, commands, transfers } = build();
      await expect(call(controller, req(BRANCH_ADMIN))).rejects.toBeInstanceOf(ForbiddenException);
      // nothing was attempted before the refusal
      expect(commands.reclassifySellability).not.toHaveBeenCalled();
      expect(commands.reassignStock).not.toHaveBeenCalled();
      expect(commands.distributeFamilyStock).not.toHaveBeenCalled();
      expect(transfers.createDraft).not.toHaveBeenCalled();
      expect(transfers.commit).not.toHaveBeenCalled();
    });

    it.each(cases)('REFUSES an unscoped platform actor: %s', async (_name, call) => {
      const { controller } = build();
      // No organization means no tenant to command; a platform actor must enter
      // a company first, and then acts as that company's operator.
      await expect(call(controller, req(UNSCOPED_PLATFORM))).rejects.toBeTruthy();
    });

    it('admits a platform actor that HAS entered an organization', async () => {
      const { controller, transfers } = build();
      await expect(controller.commitTransfer(req(SCOPED_PLATFORM), 't1')).resolves.toBeDefined();
      expect(transfers.commit).toHaveBeenCalled();
    });

    it('start-return forwards the named partial quantities; complete-return carries none', async () => {
      // The route is a thin wrapper over the Phase 5 semantics: `start-return`
      // may name WHICH travelling units turn around, `complete-return` has no
      // choice to make — everything travelling home lands.
      const { controller, transfers } = build();
      await controller.startTransferReturn(req(MANAGER), 't1', { quantities: { 'prod-1': 2 } } as never);
      expect(transfers.startReturn).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ transferId: 't1', quantities: { 'prod-1': 2 } }),
      );
      await controller.completeTransferReturn(req(MANAGER), 't1');
      expect(transfers.completeReturn).toHaveBeenCalledWith(
        expect.anything(),
        expect.not.objectContaining({ quantities: expect.anything() }),
      );
    });
  });

  describe('roles that hold no inventory authority at all', () => {
    it('never lists EDITOR or VIEWER among the roles any inventory route admits', () => {
      // The route decorators are the first gate. Reading them here keeps the
      // claim honest: a role absent from every list cannot reach the surface,
      // whatever a screen chooses to render.
      const roleLists = [
        Reflect.getMetadata('roles', InventoryController.prototype.recount),
        Reflect.getMetadata('roles', InventoryController.prototype.reclassify),
        Reflect.getMetadata('roles', InventoryController.prototype.reassign),
        Reflect.getMetadata('roles', InventoryController.prototype.distribute),
        Reflect.getMetadata('roles', InventoryController.prototype.createTransfer),
        Reflect.getMetadata('roles', InventoryController.prototype.startTransferReturn),
        Reflect.getMetadata('roles', InventoryController.prototype.completeTransferReturn),
        Reflect.getMetadata('roles', InventoryController.prototype.productStock),
      ];
      for (const list of roleLists) {
        expect(list).toBeDefined();
        expect(list).not.toContain('EDITOR');
        expect(list).not.toContain('VIEWER');
      }
    });
  });

  describe('recount — the one command a branch administrator holds', () => {
    it('passes the branch actor through to the service, which pins the location', async () => {
      const { controller, commands } = build();
      await controller.recount(req(BRANCH_ADMIN), {
        productId: 'p1',
        locationId: 'loc-store-a',
        countedQuantity: 7,
        reason: 'shelf count',
      } as never);
      // The controller never decides the last mile itself: it hands the scope
      // to `recount`, whose assertBranchOperator refuses any location but the
      // actor's own branch.
      expect(commands.recount).toHaveBeenCalledWith(
        expect.objectContaining({ scope: BRANCH_ADMIN, locationId: 'loc-store-a', countedQuantity: 7 }),
      );
    });

    it('is a TARGET, not a delta — which is what makes a retry safe', async () => {
      const { controller, commands } = build();
      const body = { productId: 'p1', locationId: 'l', countedQuantity: 7, reason: 'count' } as never;
      await controller.recount(req(MANAGER), body);
      await controller.recount(req(MANAGER), body);
      for (const call of commands.recount.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ countedQuantity: 7 }));
      }
    });
  });

  describe('idempotency of the delta commands', () => {
    it('refuses reclassify / reassign / distribute without an Idempotency-Key', async () => {
      const { controller, commands } = build();
      await expect(
        controller.reclassify(
          req(MANAGER),
          {
            productId: 'p',
            locationId: 'l',
            quantity: 1,
            from: { physicalCondition: 'GOOD', operationalState: 'AVAILABLE' },
            to: { physicalCondition: 'DAMAGED', operationalState: 'NON_SELLABLE' },
            reason: 'x',
          } as never,
          undefined,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        controller.reassign(
          req(MANAGER),
          { sourceProductId: 'a', destinationProductId: 'b', locationId: 'l', quantity: 1, reason: 'x' } as never,
          'short',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(commands.reclassifySellability).not.toHaveBeenCalled();
      expect(commands.reassignStock).not.toHaveBeenCalled();
    });

    it('forwards the caller key so a double submit is a replay, not a second adjustment', async () => {
      const { controller, commands } = build();
      const body = {
        sourceProductId: 'a',
        destinationProductId: 'b',
        locationId: 'l',
        quantity: 3,
        reason: 'misfiled',
      } as never;
      await controller.reassign(req(MANAGER), body, KEY);
      await controller.reassign(req(MANAGER), body, KEY);
      const keys = commands.reassignStock.mock.calls.map((call: any[]) => call[0].idempotencyKey);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[0]).toContain(KEY);
    });
  });

  describe('operator decisions reach audit history', () => {
    it('records a transfer as a decision, with its organization', async () => {
      const { controller, audit } = build();
      await controller.createTransfer(req(MANAGER), {
        sourceLocationId: 's',
        destinationLocationId: 'd',
        lines: [{ productId: 'p', quantity: 2 }],
      } as never);
      expect(audit.recordAuditEntry).toHaveBeenCalledWith(
        'u1',
        'a@b.c',
        expect.anything(),
        'transfer-1',
        expect.anything(),
        expect.anything(),
        expect.stringContaining('transfer'),
        expect.objectContaining({ organizationId: 'org-1' }),
      );
    });
  });
});
