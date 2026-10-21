import { BadRequestException, ConflictException } from '@nestjs/common';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { ProductStatus } from '../../catalogue/product-status.enum';
import { storePublicationLock } from '../../families/advisory-lock.util';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';

/**
 * Required-setting activation under the publication guard (B4a3) — the
 * store-side half of the invariant. The guard and the service are REAL; only
 * the database is faked.
 *
 * What is pinned: the WHOLE update is one transaction that takes the same
 * store publication lock every publication writer holds, re-reads under it,
 * rules on the FINAL state (omission preserves), scans only the transition
 * INTO effective requirement, filters the scan by publication's own canonical
 * sellability predicate, refuses with a bounded payload, and persists nothing
 * before validation passes.
 */
describe('required-setting activation under the publication guard (B4a3)', () => {
  const ORG = '00000000-0000-4000-8000-00000000000a';
  const STORE = '00000000-0000-4000-8000-0000000000a1';
  const DEF = '00000000-0000-4000-8000-0000000000d1';

  const scope: TenantScope = {
    platform: false,
    organizationId: ORG,
    storeId: null,
    allowedStoreIds: [STORE],
    role: 'ORGANIZATION_MANAGER',
  };

  const idOf = (ref: any): string => (typeof ref === 'string' ? ref : ref?.id);

  interface World {
    /** The existing StoreFieldSetting row for (STORE, DEF), if any. */
    setting: any | null;
    products: Record<string, any>;
    /** Pivot rows of STORE; `product` carries the populated product row. */
    pivots: any[];
    values: any[];
  }

  const product = (id: string, over: Record<string, any> = {}) => ({
    id,
    status: ProductStatus.PUBLISHED,
    archivedAt: null,
    parent: null,
    ...over,
  });

  const build = (over: Partial<World> = {}) => {
    const world: World = { setting: null, products: {}, pivots: [], values: [], ...over };
    const log: string[] = [];
    const locks: { ns: number; key: number }[] = [];
    const persisted: any[] = [];

    const tem: any = {
      findOne: jest.fn(async (entity: any, where: any) => {
        const name = typeof entity === 'function' ? entity.name : String(entity);
        if (name === 'ProductFieldDefinition') {
          return where?.id === DEF
            ? { id: DEF, key: 'weight', label: 'Weight', type: 'NUMBER', unit: 'kg', sortOrder: 0, archivedAt: null }
            : null;
        }
        if (name === 'Store') return where?.id === STORE ? { id: STORE, organization: { id: ORG } } : null;
        if (name === 'StoreFieldSetting') {
          log.push('read:StoreFieldSetting');
          return world.setting;
        }
        return null;
      }),
      find: jest.fn(async (entity: any, where: any) => {
        const name = typeof entity === 'function' ? entity.name : String(entity);
        if (name === 'StoreProduct') {
          log.push('read:StoreProduct');
          return world.pivots.filter((p) => idOf(p.store) === where.store && p.published === where.published);
        }
        if (name === 'ProductFieldValue') {
          return world.values.filter(
            (v) => (where.product?.$in ?? []).includes(idOf(v.product)) && idOf(v.definition) === where.definition,
          );
        }
        return [];
      }),
      count: jest.fn(
        async (_entity: any, where: any) =>
          Object.values(world.products).filter((p) => idOf(p.parent) === where?.parent).length,
      ),
      create: jest.fn((_entity: any, data: any) => ({
        active: false,
        required: false,
        publiclyVisible: false,
        importable: false,
        ...data,
      })),
      persist: jest.fn((row: any) => {
        log.push('persist:StoreFieldSetting');
        persisted.push(row);
      }),
      flush: jest.fn(async () => {
        log.push('flush');
      }),
      execute: jest.fn(async (_sql: string, params: number[]) => {
        log.push(`lock:${params[0]}:${params[1]}`);
        locks.push({ ns: params[0], key: params[1] });
        return [];
      }),
    };

    const em: any = {
      // assertStoreInScope resolves the store on the root manager.
      findOne: jest.fn(async (_entity: any, where: any) =>
        where?.id === STORE ? { id: STORE, organization: { id: ORG } } : null,
      ),
      transactional: jest.fn(async (cb: any) => {
        log.push('tx:start');
        try {
          const result = await cb(tem);
          log.push('tx:commit');
          return result;
        } catch (err) {
          log.push('tx:rollback');
          throw err;
        }
      }),
    };

    const service = new ProductFieldsService({ find: jest.fn() } as any, em, new PublicationGuardService());
    return { service, world, log, locks, persisted, tem, em };
  };

  const upsert = (service: ProductFieldsService, dto: any) => service.upsertStoreSetting(scope, STORE, DEF, dto);

  it('refuses activation while a shown product leaves the field unanswered, persisting nothing', async () => {
    const { service, log, persisted } = build({
      products: { 'p-1': product('p-1') },
      pivots: [{ store: { id: STORE }, product: product('p-1'), published: true }],
    });

    const err = await upsert(service, { active: true, required: true }).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      storeId: STORE,
      missingProductIds: ['p-1'],
      missingProductCount: 1,
      truncated: false,
    });
    // Validation ran strictly before any write: no setting row was ever
    // staged, and the transaction rolled back.
    expect(persisted).toHaveLength(0);
    expect(log).not.toContain('persist:StoreFieldSetting');
    expect(log).toContain('tx:rollback');
    expect(log).not.toContain('tx:commit');
  });

  it('activates once every shown product answers, holding the publication writers own lock', async () => {
    const { service, locks, log } = build({
      products: { 'p-1': product('p-1') },
      pivots: [{ store: { id: STORE }, product: product('p-1'), published: true }],
      values: [{ product: { id: 'p-1' }, definition: { id: DEF } }],
    });

    const out = await upsert(service, { active: true, required: true });

    expect(out.setting).toMatchObject({ active: true, required: true });
    // Serialization compatibility: the ONE key every publication writer in
    // this store holds — computed with the same production utility.
    const expected = storePublicationLock(STORE);
    expect(locks).toEqual([{ ns: expected.ns, key: expected.key }]);
    // And the lock precedes every read the decision rests on.
    expect(log.indexOf(`lock:${expected.ns}:${expected.key}`)).toBeLessThan(log.indexOf('read:StoreFieldSetting'));
    expect(log.indexOf(`lock:${expected.ns}:${expected.key}`)).toBeLessThan(log.indexOf('read:StoreProduct'));
  });

  it('refuses every final required-while-inactive state, however the flags arrive', async () => {
    // Explicitly inactive with required in the same request.
    const both = build();
    await expect(upsert(both.service, { active: false, required: true })).rejects.toThrow(BadRequestException);

    // required:true alone onto a row that is currently inactive.
    const ontoInactive = build({
      setting: { active: false, required: false, publiclyVisible: false, importable: false, sortOrder: null },
    });
    await expect(upsert(ontoInactive.service, { required: true })).rejects.toThrow(BadRequestException);

    // Deactivating while required remains set from before.
    const deactivating = build({
      setting: { active: true, required: true, publiclyVisible: false, importable: false, sortOrder: null },
    });
    await expect(upsert(deactivating.service, { active: false })).rejects.toThrow(BadRequestException);
  });

  it('preserves every omitted flag — a partial update flips nothing behind the callers back', async () => {
    const { service, persisted } = build({
      setting: { active: true, required: false, publiclyVisible: true, importable: true, sortOrder: 3 },
      // The store shows nothing, so the transition scan passes vacuously.
    });

    const out = await upsert(service, { required: true });

    expect(out.setting).toMatchObject({
      active: true,
      required: true,
      publiclyVisible: true,
      importable: true,
      sortOrder: 3,
    });
    expect(persisted).toHaveLength(1);
  });

  it('does not rescan when the field is already effectively required', async () => {
    const { service, log, locks } = build({
      setting: { active: true, required: true, publiclyVisible: false, importable: false, sortOrder: null },
      // An unanswered shown product exists — a rescan would refuse.
      products: { 'p-1': product('p-1') },
      pivots: [{ store: { id: STORE }, product: product('p-1'), published: true }],
    });

    const out = await upsert(service, { active: true, required: true, sortOrder: 5 });

    // Already-required is not a transition: nothing is newly demanded of
    // anybody, so the catalogue is not read at all. The lock is still taken —
    // the update itself must serialize against publications.
    expect(out.setting).toMatchObject({ required: true, sortOrder: 5 });
    expect(log).not.toContain('read:StoreProduct');
    expect(locks).toHaveLength(1);
  });

  it('scans with publication canonical sellability: drafts, archived, cards and hidden pivots answer to nobody', async () => {
    const card = product('card');
    const { service } = build({
      products: {
        draft: product('draft', { status: ProductStatus.DRAFT }),
        gone: product('gone', { archivedAt: new Date() }),
        card,
        version: product('version', { parent: { id: 'card' } }),
        hidden: product('hidden'),
      },
      pivots: [
        { store: { id: STORE }, product: product('draft', { status: ProductStatus.DRAFT }), published: true },
        { store: { id: STORE }, product: product('gone', { archivedAt: new Date() }), published: true },
        { store: { id: STORE }, product: card, published: true },
        { store: { id: STORE }, product: product('hidden'), published: false },
      ],
    });

    // Every shown-looking product fails the canonical predicate, so the
    // requirement activates with no answers anywhere.
    const out = await upsert(service, { active: true, required: true });
    expect(out.setting).toMatchObject({ active: true, required: true });
  });

  it('bounds the refusal: a count and ten ascending ids, never the catalogue', async () => {
    const many = Array.from({ length: 12 }, (_, i) => product(`p-${String(i).padStart(2, '0')}`));
    const { service } = build({
      products: Object.fromEntries(many.map((p) => [p.id, p])),
      pivots: many.map((p) => ({ store: { id: STORE }, product: p, published: true })),
    });

    const err = await upsert(service, { active: true, required: true }).catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    const refusal = err.getResponse() as any;
    expect(refusal.missingProductCount).toBe(12);
    expect(refusal.truncated).toBe(true);
    expect(refusal.missingProductIds).toHaveLength(PublicationGuardService.MAX_MISSING_PRODUCT_IDS);
    expect(refusal.missingProductIds).toEqual([...refusal.missingProductIds].sort());
    expect(refusal.missingProductIds[0]).toBe('p-00');
  });
});
