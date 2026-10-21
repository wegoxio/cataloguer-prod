import { BulkOperationsService } from '../bulk-operations.service';
import { PublicationGuardService } from '../../products/publication/publication-guard.service';
import { ProductStatus } from '../../products/catalogue/product-status.enum';
import { productFamilyLock, sortLockKeys, storePublicationLock } from '../../products/families/advisory-lock.util';
import { stockDouble } from '../../../../test/inventory-stock-support';

/**
 * Bulk operations under the publication guard (B4a3).
 *
 * The guard, the lock keys and the membership diff are the REAL code — only
 * the database is faked. What is pinned here is bulk-specific: each product
 * runs in its OWN fresh retryable transaction, a refused product rolls back
 * whole while the batch continues, and a widening retries just that product
 * on a fresh transactional manager.
 */
describe('bulk operations under the publication guard (B4a3)', () => {
  const ORG = 'org-1';
  const SCOPE = {
    platform: false,
    organizationId: ORG,
    storeId: null,
    allowedStoreIds: ['store-a', 'store-b'],
    role: 'ADMIN',
  } as any;
  const actor = { id: 'u1', email: 'ana@acme.test' };

  const idOf = (ref: any): string => (typeof ref === 'string' ? ref : ref?.id);

  interface World {
    stores: Record<string, any>;
    products: Record<string, any>;
    pivots: any[];
    settings: any[];
    values: any[];
    childCount: number;
    afterPivotRead?: (attempt: number, read: number) => void;
  }

  const product = (id: string, over: Record<string, any> = {}) => ({
    id,
    name: `item-${id}`,
    status: ProductStatus.PUBLISHED,
    archivedAt: null,
    organization: { id: ORG },
    parent: null,
    stores: { getItems: () => [] },
    ...over,
  });

  const pivot = (productId: string, storeId: string, over: Record<string, any> = {}) => ({
    store: { id: storeId },
    product: { id: productId },
    published: true,
    price: null,
    salePrice: null,
    cost: null,
    stockQuantity: 0,
    trackInventory: false,
    leadTimeDays: null,
    ...over,
  });

  const build = (over: Partial<World> = {}) => {
    const world: World = {
      stores: {
        'store-a': { id: 'store-a', slug: 'branch-a', organization: { id: ORG } },
        'store-b': { id: 'store-b', slug: 'branch-b', organization: { id: ORG } },
      },
      products: {},
      pivots: [],
      settings: [],
      values: [],
      childCount: 0,
      ...over,
    };

    const log: string[] = [];
    const locks: { attempt: number; ns: number; key: number }[] = [];
    const createdPivots: any[] = [];
    const removedPivots: any[] = [];
    const tems: any[] = [];
    let attempts = 0;

    const storeRows = (where: any) =>
      (where?.id?.$in ?? [])
        .map((id: string) => world.stores[id])
        .filter(Boolean)
        .filter((s: any) => !where.organization || s.organization.id === where.organization);

    const makeTem = (attempt: number) => {
      let pivotReads = 0;
      const tem: any = {
        findOne: jest.fn(async (entity: any, where: any) => {
          const name = typeof entity === 'function' ? entity.name : String(entity);
          if (name === 'Product') {
            // A fresh transaction hydrates its own entity; a rolled-back
            // attempt's mutations never leak into the next one.
            const row = where?.id ? world.products[where.id] : null;
            return row ? { ...row } : null;
          }
          return null;
        }),
        find: jest.fn(async (entity: any, where: any) => {
          const name = typeof entity === 'function' ? entity.name : String(entity);
          if (name === 'Store') return storeRows(where);
          if (name === 'StoreProduct') {
            const rows = world.pivots.filter((p) => idOf(p.product) === where.product);
            pivotReads += 1;
            world.afterPivotRead?.(attempt, pivotReads);
            return rows;
          }
          if (name === 'StoreFieldSetting') {
            return world.settings.filter((s) => {
              const storeId = idOf(s.store);
              if (where.store?.$in && !where.store.$in.includes(storeId)) return false;
              if (where.active !== undefined && s.active !== where.active) return false;
              if (where.required !== undefined && s.required !== where.required) return false;
              return true;
            });
          }
          if (name === 'ProductFieldValue') return world.values.filter((v) => idOf(v.product) === where.product);
          return [];
        }),
        count: jest.fn(async () => world.childCount),
        create: jest.fn((_entity: any, data: any) => ({ ...data })),
        persist: jest.fn((row: any) => {
          log.push('persist:StoreProduct');
          createdPivots.push(row);
        }),
        remove: jest.fn((row: any) => removedPivots.push(row)),
        flush: jest.fn(async () => {
          log.push('flush');
        }),
        execute: jest.fn(async (_sql: string, params: number[]) => {
          log.push(`lock:${params[0]}:${params[1]}`);
          locks.push({ attempt, ns: params[0], key: params[1] });
          return [];
        }),
      };
      tems.push(tem);
      return tem;
    };

    const em: any = {
      // Root manager: resolveStoresInScope resolves the target stores here,
      // once for the whole batch; everything else is transactional.
      find: jest.fn(async (_entity: any, where: any) => storeRows(where)),
      flush: jest.fn(),
      transactional: jest.fn(async (cb: any) => {
        attempts += 1;
        const attempt = attempts;
        log.push(`tx:${attempt}:start`);
        try {
          const result = await cb(makeTem(attempt));
          log.push(`tx:${attempt}:commit`);
          return result;
        } catch (err) {
          log.push(`tx:${attempt}:rollback`);
          throw err;
        }
      }),
    };

    const productRepo: any = { findOne: jest.fn(), getEntityManager: () => em };
    const auditLog = { recordAuditEntry: jest.fn() };
    const service = new BulkOperationsService(
      productRepo,
      { findOne: jest.fn() } as any,
      { archive: jest.fn(), restore: jest.fn() } as any,
      auditLog as any,
      new PublicationGuardService(),
      stockDouble() as any,
    );

    return {
      service,
      world,
      log,
      locks,
      createdPivots,
      removedPivots,
      tems,
      em,
      auditLog,
      attempts: () => attempts,
    };
  };

  const requireWeightIn = (storeId: string) => [
    { store: { id: storeId }, definition: { id: 'd1', key: 'weight' }, active: true, required: true },
  ];

  describe('bulkStores', () => {
    it('rolls back a refused product whole and lets the rest of the batch continue', async () => {
      const { service, log, createdPivots, auditLog } = build({
        products: { 'p-1': product('p-1'), 'p-2': product('p-2') },
        settings: requireWeightIn('store-a'),
      });

      const result = await service.bulkStores(SCOPE, ['p-1', 'p-2'], ['store-a'], actor);

      // p-1 and p-2 are both PUBLISHED products entering a demanding branch
      // with no answers — both refused, each in its own transaction, neither
      // leaving a pivot behind.
      expect(result.successCount).toBe(0);
      expect(result.failedCount).toBe(2);
      result.failures.forEach((f) => expect(f.message).toMatch(/cannot be published/));
      expect(createdPivots).toHaveLength(0);
      expect(log).toContain('tx:1:rollback');
      expect(log).toContain('tx:2:rollback');
      expect(auditLog.recordAuditEntry).not.toHaveBeenCalled();
    });

    it('publishes per product in its own transaction when the branch demands nothing', async () => {
      const { service, log, createdPivots, attempts } = build({
        products: { 'p-1': product('p-1'), 'p-2': product('p-2') },
      });

      const result = await service.bulkStores(SCOPE, ['p-1', 'p-2'], ['store-a', 'store-b'], actor);

      expect(result.successCount).toBe(2);
      expect(attempts()).toBe(2); // one transaction per product, none retried
      expect(log.filter((l) => l.startsWith('tx:')).filter((l) => l.endsWith('commit'))).toHaveLength(2);
      expect(createdPivots).toHaveLength(4);
      createdPivots.forEach((p) => {
        expect(p.published).toBe(true);
        expect(p.organization).toBe(ORG);
      });
    });

    it('retries only the widened product, on a fresh transactional manager', async () => {
      const retained = pivot('p-1', 'store-b');
      const { service, world, locks, tems, createdPivots, attempts } = build({
        products: { 'p-1': product('p-1') },
        pivots: [retained],
        // Between discovery and rederivation, a concurrent operation removes
        // the retained pivot — store-b silently becomes a PUBLISHING store
        // whose lock attempt 1 never took.
        afterPivotRead: (attempt, read) => {
          if (attempt === 1 && read === 1) world.pivots = [];
        },
      });

      const result = await service.bulkStores(SCOPE, ['p-1'], ['store-a', 'store-b'], actor);

      expect(result.successCount).toBe(1);
      expect(result.failedCount).toBe(0);
      expect(attempts()).toBe(2);
      expect(tems).toHaveLength(2);
      expect(tems[0]).not.toBe(tems[1]);
      expect(locks.filter((l) => l.attempt === 1)).toHaveLength(2); // family + store-a
      expect(locks.filter((l) => l.attempt === 2)).toHaveLength(3); // family + both stores
      expect(createdPivots.map((p) => idOf(p.store)).sort()).toEqual(['store-a', 'store-b']);
    });

    it('keeps a retained pivot untouched — nothing is silently unpublished', async () => {
      const retained = pivot('p-1', 'store-a', { published: false, price: '99.90', stockQuantity: 7 });
      const { service, createdPivots, removedPivots } = build({
        products: { 'p-1': product('p-1') },
        pivots: [retained],
      });

      const result = await service.bulkStores(SCOPE, ['p-1'], ['store-a', 'store-b'], actor);

      expect(result.successCount).toBe(1);
      expect(removedPivots).toHaveLength(0);
      expect(createdPivots).toHaveLength(1);
      expect(idOf(createdPivots[0].store)).toBe('store-b');
      // The branch's own decisions — including its deliberate unpublish —
      // survive the bulk replacement byte for byte.
      expect(retained).toMatchObject({ published: false, price: '99.90', stockQuantity: 7 });
    });
  });

  describe('bulkStatus → PUBLISHED', () => {
    it('validates the full published exposure and rolls the product back on refusal', async () => {
      const { service, log, auditLog, attempts } = build({
        products: { 'p-1': product('p-1', { status: ProductStatus.DRAFT }) },
        pivots: [pivot('p-1', 'store-a')],
        settings: requireWeightIn('store-a'),
      });

      const result = await service.bulkStatus(ORG, ['p-1'], ProductStatus.PUBLISHED, actor);

      // The flip would have turned store-a's published pivot live; it is
      // refused, the transaction rolls back, and nothing is audited.
      expect(result.successCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(result.failures[0].message).toMatch(/cannot be published/);
      expect(log).toContain('tx:1:rollback');
      expect(attempts()).toBe(1);
      expect(auditLog.recordAuditEntry).not.toHaveBeenCalled();
    });

    it('locks family + published pivots for the flip, and nothing for other statuses', async () => {
      const published = build({
        products: { 'p-1': product('p-1', { status: ProductStatus.DRAFT }) },
        pivots: [pivot('p-1', 'store-a'), pivot('p-1', 'store-b', { published: false })],
      });
      const result = await published.service.bulkStatus(ORG, ['p-1'], ProductStatus.PUBLISHED, actor);
      expect(result.successCount).toBe(1);
      const expected = sortLockKeys([productFamilyLock('p-1'), storePublicationLock('store-a')]).map(
        (k) => `lock:${k.ns}:${k.key}`,
      );
      expect(published.log.filter((l) => l.startsWith('lock:'))).toEqual(expected);
      expect(published.auditLog.recordAuditEntry).toHaveBeenCalledWith(
        actor.id,
        actor.email,
        expect.anything(),
        'p-1',
        expect.anything(),
        { status: { before: ProductStatus.DRAFT, after: ProductStatus.PUBLISHED } },
        expect.stringContaining('PUBLISHED'),
        // P5-A1: affected-resource context — the product's own organization
        { organizationId: 'org-1' },
      );

      // Leaving published state validates and locks nothing.
      const draft = build({
        products: { 'p-1': product('p-1') },
        pivots: [pivot('p-1', 'store-a')],
        settings: requireWeightIn('store-a'),
      });
      const down = await draft.service.bulkStatus(ORG, ['p-1'], ProductStatus.DRAFT, actor);
      expect(down.successCount).toBe(1);
      expect(draft.log.filter((l) => l.startsWith('lock:'))).toEqual([]);
    });

    it('retries the flip on a fresh manager when a concurrent publication widens the exposure', async () => {
      const { service, world, locks, tems, attempts } = build({
        products: { 'p-1': product('p-1', { status: ProductStatus.DRAFT }) },
        pivots: [pivot('p-1', 'store-a')],
        afterPivotRead: (attempt, read) => {
          if (attempt === 1 && read === 1) world.pivots.push(pivot('p-1', 'store-b'));
        },
      });

      const result = await service.bulkStatus(ORG, ['p-1'], ProductStatus.PUBLISHED, actor);

      expect(result.successCount).toBe(1);
      expect(attempts()).toBe(2);
      expect(tems[0]).not.toBe(tems[1]);
      expect(locks.filter((l) => l.attempt === 1)).toHaveLength(2);
      expect(locks.filter((l) => l.attempt === 2)).toHaveLength(3);
    });
  });
});
