import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { ProductStatus } from '../../catalogue/product-status.enum';
import { productFamilyLock, sortLockKeys, storePublicationLock } from '../../families/advisory-lock.util';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';

/**
 * Field-value deletion under the publication guard (B4a3).
 *
 * The service and the guard are REAL; only the database is faked. What is
 * pinned: deletion is one retryable transaction that locks the family root
 * plus every store where removing the answer would leave the product both
 * SHOWN and DEMANDED, in canonical order; everything is re-read under the
 * locks and a widened set restarts on a fresh manager; a surviving demanding
 * store refuses with a bounded deterministic 409 BEFORE the row is touched;
 * and products nothing is demanded of — or that answer to nobody — delete
 * freely without consulting any store.
 */
describe('field-value deletion under the publication guard (B4a3)', () => {
  const ORG = '00000000-0000-4000-8000-00000000000a';
  const PRODUCT = '00000000-0000-4000-8000-0000000000f1';
  const DEF = '00000000-0000-4000-8000-0000000000d1';

  const orgWide: TenantScope = {
    platform: false,
    organizationId: ORG,
    storeId: null,
    allowedStoreIds: ['store-a', 'store-b'],
    role: 'ORGANIZATION_MANAGER',
  };
  const branch: TenantScope = { ...orgWide, storeId: 'store-a', allowedStoreIds: ['store-a'], role: 'ADMIN' };

  const idOf = (ref: any): string => (typeof ref === 'string' ? ref : ref?.id);

  interface World {
    products: Record<string, any>;
    definition: any;
    value: any | null;
    pivots: any[];
    settings: any[];
    /** Runs after the Nth pivot read of an attempt — races between derives. */
    afterPivotRead?: (attempt: number, read: number) => void;
  }

  const product = (id: string, over: Record<string, any> = {}) => ({
    id,
    status: ProductStatus.PUBLISHED,
    archivedAt: null,
    parent: null,
    organization: { id: ORG },
    ...over,
  });

  const demanding = (storeId: string, over: Record<string, any> = {}) => ({
    store: { id: storeId },
    definition: { id: DEF },
    active: true,
    required: true,
    ...over,
  });

  const build = (over: Partial<World> = {}) => {
    const world: World = {
      products: { [PRODUCT]: product(PRODUCT) },
      definition: { id: DEF, key: 'weight', archivedAt: null },
      value: { id: 'v-1', product: { id: PRODUCT }, definition: { id: DEF } },
      pivots: [],
      settings: [],
      ...over,
    };
    const log: string[] = [];
    const locks: { attempt: number; ns: number; key: number }[] = [];
    const tems: any[] = [];
    let attempts = 0;

    const makeTem = (attempt: number) => {
      let pivotReads = 0;
      const tem: any = {
        findOne: jest.fn(async (entity: any, where: any) => {
          const name = typeof entity === 'function' ? entity.name : String(entity);
          if (name === 'Product') return world.products[where?.id] ?? null;
          if (name === 'ProductFieldDefinition') return where?.id === DEF ? world.definition : null;
          if (name === 'ProductFieldValue') {
            log.push('read:ProductFieldValue');
            return world.value;
          }
          return null;
        }),
        find: jest.fn(async (entity: any, where: any) => {
          const name = typeof entity === 'function' ? entity.name : String(entity);
          if (name === 'StoreProduct') {
            const rows = world.pivots.filter((p) => idOf(p.product) === where.product);
            pivotReads += 1;
            world.afterPivotRead?.(attempt, pivotReads);
            return rows;
          }
          if (name === 'StoreFieldSetting') {
            log.push('read:StoreFieldSetting');
            return world.settings.filter(
              (s) =>
                (where.store?.$in ?? []).includes(idOf(s.store)) &&
                idOf(s.definition) === where.definition &&
                s.active === where.active &&
                s.required === where.required,
            );
          }
          return [];
        }),
        count: jest.fn(
          async (_entity: any, where: any) =>
            Object.values(world.products).filter((p) => idOf(p.parent) === where?.parent).length,
        ),
        remove: jest.fn(() => {
          log.push('remove:ProductFieldValue');
          return tem;
        }),
        flush: jest.fn(async () => {
          log.push('flush');
          if (log.includes('remove:ProductFieldValue')) world.value = null;
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

    const service = new ProductFieldsService({ find: jest.fn() } as any, em, new PublicationGuardService());
    return { service, world, log, locks, tems, em, attempts: () => attempts };
  };

  const lockEntries = (log: string[]) => log.filter((line) => line.startsWith('lock:'));
  const del = (service: ProductFieldsService, scope: TenantScope = orgWide) => service.deleteValue(scope, PRODUCT, DEF);

  it('refuses while a shown product is demanded — bounded payload, nothing removed, full rollback', async () => {
    const { service, world, log, attempts } = build({
      pivots: [{ store: { id: 'store-a' }, product: { id: PRODUCT }, published: true }],
      settings: [demanding('store-a')],
    });

    const err = await del(service).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      blockingStoreIds: ['store-a'],
      blockingStoreCount: 1,
      truncated: false,
    });
    // The refusal came strictly before removal: the row was never touched,
    // and the transaction rolled back.
    expect(log).not.toContain('remove:ProductFieldValue');
    expect(world.value).not.toBeNull();
    expect(log).toContain('tx:1:rollback');
    expect(log).not.toContain('tx:1:commit');
    expect(attempts()).toBe(1);
  });

  it('locks the family root and every demanding store, in the one canonical order', async () => {
    const { service, log } = build({
      pivots: [
        { store: { id: 'store-a' }, product: { id: PRODUCT }, published: true },
        { store: { id: 'store-b' }, product: { id: PRODUCT }, published: true },
      ],
      settings: [demanding('store-b'), demanding('store-a')],
    });

    const err = await del(service).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect((err.getResponse() as any).blockingStoreIds).toEqual(['store-a', 'store-b']);
    const expected = sortLockKeys([
      productFamilyLock(PRODUCT),
      storePublicationLock('store-a'),
      storePublicationLock('store-b'),
    ]).map((k) => `lock:${k.ns}:${k.key}`);
    expect(lockEntries(log)).toEqual(expected);
  });

  it('locks an exposed store even when nothing is demanded there, and never an unreached one', async () => {
    const { service, world, log } = build({
      // Shown only in store-a, where nothing is demanded; the requirement
      // lives in store-b, which the product never reaches.
      pivots: [{ store: { id: 'store-a' }, product: { id: PRODUCT }, published: true }],
      settings: [demanding('store-b')],
    });

    await del(service);

    expect(world.value).toBeNull();
    // store-a is locked DESPITE demanding nothing — that key is the whole
    // defense against a requirement activating beside the deletion. store-b,
    // unreached, stays out of the set entirely.
    const expected = sortLockKeys([productFamilyLock(PRODUCT), storePublicationLock('store-a')]).map(
      (k) => `lock:${k.ns}:${k.key}`,
    );
    expect(lockEntries(log)).toEqual(expected);
    expect(log).toContain('tx:1:commit');
  });

  it('removes from drafts and family cards without consulting any store', async () => {
    const draft = build({
      products: { [PRODUCT]: product(PRODUCT, { status: ProductStatus.DRAFT }) },
      pivots: [{ store: { id: 'store-a' }, product: { id: PRODUCT }, published: true }],
      settings: [demanding('store-a')],
    });
    await del(draft.service);
    expect(draft.world.value).toBeNull();
    expect(draft.log).not.toContain('read:StoreFieldSetting');

    const card = build({
      products: {
        [PRODUCT]: product(PRODUCT),
        version: product('version', { parent: { id: PRODUCT } }),
      },
      pivots: [{ store: { id: 'store-a' }, product: { id: PRODUCT }, published: true }],
      settings: [demanding('store-a')],
    });
    await del(card.service);
    expect(card.world.value).toBeNull();
    expect(card.log).not.toContain('read:StoreFieldSetting');
  });

  it('refuses an archived definition before locking or reading anything else', async () => {
    const { service, world, log } = build({
      definition: { id: DEF, key: 'weight', archivedAt: new Date() },
    });

    const err = await del(service).catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/archived/i);
    expect(lockEntries(log)).toEqual([]);
    expect(log).not.toContain('read:ProductFieldValue');
    expect(world.value).not.toBeNull();
  });

  it('answers missing product, field and value with the uniform not-found', async () => {
    const noProduct = build({ products: {} });
    await expect(del(noProduct.service)).rejects.toThrow(new NotFoundException('Product not found').message);

    const noDefinition = build({ definition: null });
    await expect(del(noDefinition.service)).rejects.toThrow(NotFoundException);

    const noValue = build({ value: null });
    await expect(del(noValue.service)).rejects.toThrow(new NotFoundException('Value not found').message);
  });

  it('refuses a branch actor before any transaction opens — values are company-wide', async () => {
    const { service, em } = build();
    await expect(del(service, branch)).rejects.toThrow(/company-wide access/);
    expect(em.transactional).not.toHaveBeenCalled();
  });

  it('a requirement activating after the first derive cannot pass — its key was already held', async () => {
    const { service, world, locks, attempts } = build({
      pivots: [{ store: { id: 'store-a' }, product: { id: PRODUCT }, published: true }],
      settings: [demanding('store-a', { required: false })],
      // The branch activates the requirement right after deletion's first
      // derive. In reality the activation would BLOCK on store-a's key, which
      // this deletion already holds; here it lands before the settings read,
      // and the deletion still sees and honours it.
      afterPivotRead: (attempt, read) => {
        if (attempt === 1 && read === 1) world.settings[0].required = true;
      },
    });

    const err = await del(service).catch((e) => e);

    // No widening, no second attempt: the exposed store was in the lock set
    // from the start, requirement or not.
    expect(attempts()).toBe(1);
    expect(locks.filter((l) => l.attempt === 1)).toHaveLength(2);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err.getResponse() as any).blockingStoreIds).toEqual(['store-a']);
    expect(world.value).not.toBeNull();
  });

  it('retries on a fresh manager when the exposed-store set widens between the derives', async () => {
    const { service, world, tems, locks, attempts } = build({
      pivots: [{ store: { id: 'store-a' }, product: { id: PRODUCT }, published: true }],
      // Between discovery and rederivation a concurrent publication exposes
      // the product in store-b — a key attempt 1 never took.
      afterPivotRead: (attempt, read) => {
        if (attempt === 1 && read === 1) {
          world.pivots.push({ store: { id: 'store-b' }, product: { id: PRODUCT }, published: true });
        }
      },
    });

    await del(service);

    expect(attempts()).toBe(2);
    expect(tems).toHaveLength(2);
    expect(tems[0]).not.toBe(tems[1]);
    // Attempt 1 held family + store-a; attempt 2 named all three from the
    // start, found nothing demanded, and deleted.
    expect(locks.filter((l) => l.attempt === 1)).toHaveLength(2);
    expect(locks.filter((l) => l.attempt === 2)).toHaveLength(3);
    expect(world.value).toBeNull();
  });

  it('bounds the refusal to ten ascending store ids plus the true count', async () => {
    const stores = Array.from({ length: 12 }, (_, i) => `store-${String(i).padStart(2, '0')}`);
    const { service } = build({
      pivots: stores.map((s) => ({ store: { id: s }, product: { id: PRODUCT }, published: true })),
      settings: stores.map((s) => demanding(s)),
    });

    const err = await del(service).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    const refusal = err.getResponse() as any;
    expect(refusal.blockingStoreCount).toBe(12);
    expect(refusal.truncated).toBe(true);
    expect(refusal.blockingStoreIds).toHaveLength(PublicationGuardService.MAX_BLOCKING_STORE_IDS);
    expect(refusal.blockingStoreIds[0]).toBe('store-00');
    expect(refusal.blockingStoreIds).toEqual([...refusal.blockingStoreIds].sort());
  });
});
