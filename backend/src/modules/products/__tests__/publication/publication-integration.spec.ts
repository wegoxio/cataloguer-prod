import { BadRequestException, ConflictException } from '@nestjs/common';
import { ProductsService } from '../../catalogue/products.service';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { ProductFieldType } from '../../entities/product-field-definition.entity';
import { ProductStatus } from '../../catalogue/product-status.enum';
import { productFamilyLock, sortLockKeys, storePublicationLock } from '../../families/advisory-lock.util';
import { stockDouble } from '../../../../../test/inventory-stock-support';

/**
 * create/update under the publication guard (B4a3), integrated.
 *
 * Everything that decides is REAL: ProductsService, PublicationGuardService,
 * ProductFieldsService, the membership diff and the lock-key derivation. Only
 * the database is faked, as a world of plain rows behind a transactional
 * manager — so what is pinned here is the choreography the pieces perform
 * together, per attempt:
 *
 *   load/create product → write creation values → discover/acquire/rederive
 *   locks → validate publication → apply pivot diff → flush
 *
 * and around it, the retry contract: every attempt is a whole fresh
 * transaction, every error escapes the callback so rollback completes first,
 * only a widened lock set retries, and three transactions is the ceiling.
 */
describe('publication integration: create and update (B4a3)', () => {
  const ORG = 'org-1';

  const collection = (initial: any[] = []) => {
    let items = [...initial];
    return {
      getItems: () => items,
      set: (next: any[]) => {
        items = [...next];
      },
      add: (x: any) => {
        items.push(x);
      },
      init: async () => undefined,
      isInitialized: () => true,
    };
  };

  const idOf = (ref: any): string => (typeof ref === 'string' ? ref : ref?.id);

  interface World {
    stores: Record<string, any>;
    pivots: any[];
    settings: any[];
    definitions: any[];
    values: any[];
    products: Record<string, any>;
    childCount: number;
    /** Runs before an attempt's callback — reset state per transaction. */
    onAttemptStart?: (attempt: number) => void;
    /** Runs after the Nth pivot read of an attempt — race between the reads. */
    afterPivotRead?: (attempt: number, read: number) => void;
    /** Runs after the Nth single-link read (assignToStore) of an attempt. */
    afterLinkRead?: (attempt: number, read: number) => void;
  }

  const build = (over: Partial<World> = {}) => {
    const world: World = {
      stores: {
        'store-a': { id: 'store-a', organization: { id: ORG } },
        'store-b': { id: 'store-b', organization: { id: ORG } },
      },
      pivots: [],
      settings: [],
      definitions: [],
      values: [],
      products: {},
      childCount: 0,
      ...over,
    };

    /** One global journal across every transaction, for order assertions. */
    const log: string[] = [];
    const locks: { attempt: number; ns: number; key: number }[] = [];
    const createdPivots: any[] = [];
    const removedPivots: any[] = [];
    const tems: any[] = [];
    let attempts = 0;

    const makeTem = (attempt: number) => {
      const stagedValues: any[] = [];
      // Pivot rows persisted in this transaction become QUERYABLE only after a
      // flush, exactly as in Postgres — code that forgets to flush before
      // re-reading them will not find them here either.
      const stagedPivots: any[] = [];
      const flushedPivots: any[] = [];
      const stagedRemovals: any[] = [];
      const flushedRemovals: any[] = [];
      let pivotReads = 0;
      let linkReads = 0;
      const tem: any = {
        create: jest.fn((entity: any, data: any) => {
          const name = typeof entity === 'function' ? entity.name : String(entity);
          log.push(`create:${name}`);
          if (name === 'Product') return { ...data, categories: collection(), stores: collection() };
          return { ...data };
        }),
        persistAndFlush: jest.fn(async (entity: any) => {
          entity.id ??= 'p-new';
          log.push('persistAndFlush');
        }),
        persist: jest.fn((row: any) => {
          if (row.definitionType !== undefined) {
            log.push('persist:ProductFieldValue');
            stagedValues.push(row);
          } else {
            log.push('persist:StoreProduct');
            createdPivots.push(row);
            stagedPivots.push(row);
          }
        }),
        remove: jest.fn((link: any) => {
          log.push('remove:StoreProduct');
          removedPivots.push(link);
          stagedRemovals.push(link);
        }),
        flush: jest.fn(async () => {
          log.push('flush');
          flushedPivots.push(...stagedPivots.splice(0));
          flushedRemovals.push(...stagedRemovals.splice(0));
        }),
        find: jest.fn(async (entity: any, where: any) => {
          const name = typeof entity === 'function' ? entity.name : String(entity);
          log.push(`read:${name}`);
          if (name === 'Store') {
            const wanted: string[] = where.id?.$in ?? [];
            return wanted
              .map((id) => world.stores[id])
              .filter(Boolean)
              .filter((s) => !where.organization || s.organization.id === where.organization);
          }
          if (name === 'StoreProduct') {
            const rows = [...world.pivots, ...flushedPivots].filter(
              (p) => idOf(p.product) === where.product && !flushedRemovals.includes(p),
            );
            pivotReads += 1;
            world.afterPivotRead?.(attempt, pivotReads);
            return rows;
          }
          if (name === 'StoreFieldSetting') {
            return world.settings.filter((s) => {
              const storeId = idOf(s.store);
              if (where.store?.$in && !where.store.$in.includes(storeId)) return false;
              if (typeof where.store === 'string' && where.store !== storeId) return false;
              if (where.active !== undefined && s.active !== where.active) return false;
              if (where.required !== undefined && s.required !== where.required) return false;
              if (where.definition?.$in && !where.definition.$in.includes(idOf(s.definition))) return false;
              return true;
            });
          }
          if (name === 'ProductFieldValue') {
            // Phase 2: the guard reads product AND family-model values in one
            // $in query for effective resolution.
            const wanted: string[] = where.product?.$in ?? [where.product];
            return [...world.values, ...stagedValues].filter((v) => wanted.includes(idOf(v.product)));
          }
          if (name === 'ProductFieldDefinition') {
            return world.definitions.filter((d) => (where.id?.$in ?? []).includes(d.id));
          }
          return [];
        }),
        findOne: jest.fn(async (entity: any, where: any) => {
          const name = typeof entity === 'function' ? entity.name : String(entity);
          if (name === 'Product') {
            // Each transaction hydrates its OWN entity, as MikroORM's fresh
            // fork would — a rolled-back attempt's mutations must not leak
            // into the next attempt's graph.
            const row = where?.id ? world.products[where.id] : null;
            return row ? { ...row } : null;
          }
          if (name === 'Store') return world.stores[where?.id] ?? null;
          if (name === 'StoreProduct') {
            // Hydrated as a copy, like Product — snapshotted BEFORE the race
            // hook runs: what a derive pass read must stay what it read, even
            // when the world moves right after.
            const row =
              world.pivots.find((p) => idOf(p.product) === where.product && idOf(p.store) === where.store) ?? null;
            const snapshot = row ? { ...row } : null;
            linkReads += 1;
            world.afterLinkRead?.(attempt, linkReads);
            return snapshot;
          }
          return null;
        }),
        count: jest.fn(async () => world.childCount),
        getReference: jest.fn((_entity: any, id: string) => ({ id })),
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
      // The organization fallback resolves the first requested store here.
      findOne: jest.fn(async (_entity: any, where: any) => world.stores[where?.id] ?? null),
      find: jest.fn(async () => []),
      flush: jest.fn(),
      persistAndFlush: jest.fn(),
      transactional: jest.fn(async (cb: any) => {
        attempts += 1;
        const attempt = attempts;
        world.onAttemptStart?.(attempt);
        log.push(`tx:${attempt}:start`);
        const tem = makeTem(attempt);
        try {
          const result = await cb(tem);
          log.push(`tx:${attempt}:commit`);
          return result;
        } catch (err) {
          // The real transactional() completes the rollback before rethrowing;
          // journalling it here is what lets tests prove no retry begins first.
          log.push(`tx:${attempt}:rollback`);
          throw err;
        }
      }),
    };

    const productRepo: any = {
      // Slug/SKU probes carry no id and find nothing; findById re-reads by id.
      findOne: jest.fn(async (where: any) =>
        where?.id
          ? (world.products[where.id] ?? {
              id: where.id,
              name: 'created',
              stores: collection(),
              categories: collection(),
            })
          : null,
      ),
      getEntityManager: () => em,
    };
    const auditLog = { recordAuditEntry: jest.fn() };

    const service = new ProductsService(
      productRepo,
      { find: jest.fn(async () => []), findOne: jest.fn(async () => null) } as any,
      { findById: jest.fn() } as any,
      auditLog as any,
      { learnFromAcceptedGroup: jest.fn() } as any,
      new PublicationGuardService(),
      new ProductFieldsService({ find: jest.fn() } as any, { transactional: jest.fn() } as any, {} as any),
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

  const actor = { id: 'u1', email: 'ana@acme.test' };

  const requiredWeight = () => ({
    definitions: [{ id: 'd1', key: 'weight', type: ProductFieldType.NUMBER, archivedAt: null }],
    settings: [{ store: { id: 'store-a' }, definition: { id: 'd1', key: 'weight' }, active: true, required: true }],
  });

  const lockEntries = (log: string[]) => log.filter((line) => line.startsWith('lock:'));

  const storeProductReads = (tem: any) =>
    tem.find.mock.calls.filter(
      (call: any[]) => (typeof call[0] === 'function' ? call[0].name : String(call[0])) === 'StoreProduct',
    ).length;

  const product = (over: Record<string, any> = {}) => ({
    id: 'p-1',
    name: 'Silla',
    slug: 'silla',
    sku: null,
    description: null,
    metaTitle: null,
    metaDescription: null,
    price: 10,
    salePrice: null,
    cost: null,
    stockQuantity: 0,
    trackInventory: false,
    status: ProductStatus.PUBLISHED,
    archivedAt: null,
    organization: { id: ORG },
    parent: null,
    categories: collection(),
    stores: collection(),
    ...over,
  });

  const pivot = (storeId: string, over: Record<string, any> = {}) => ({
    store: { id: storeId },
    product: { id: 'p-1' },
    published: true,
    price: null,
    salePrice: null,
    cost: null,
    stockQuantity: 0,
    trackInventory: false,
    leadTimeDays: null,
    ...over,
  });

  describe('create', () => {
    it('runs values → locks → validation → pivots → flush, inside one transaction', async () => {
      const { service, log, createdPivots, attempts } = build(requiredWeight());

      await service.create(
        {
          name: 'Silla',
          status: ProductStatus.PUBLISHED,
          storeIds: ['store-a'],
          fieldValues: [{ definitionId: 'd1', value: '1.5' }],
        } as any,
        actor,
      );

      expect(attempts()).toBe(1);
      const valueWrite = log.indexOf('persist:ProductFieldValue');
      const firstLock = log.findIndex((line) => line.startsWith('lock:'));
      const guardRead = log.indexOf('read:StoreFieldSetting');
      const pivotWrite = log.indexOf('persist:StoreProduct');
      // Values exist before the guard can look; locks are held before it looks;
      // and no pivot exists until it has decided.
      expect(valueWrite).toBeGreaterThan(-1);
      expect(valueWrite).toBeLessThan(firstLock);
      expect(firstLock).toBeLessThan(guardRead);
      expect(guardRead).toBeLessThan(pivotWrite);
      expect(pivotWrite).toBeLessThan(log.lastIndexOf('flush'));
      expect(log).toContain('tx:1:commit');

      expect(createdPivots).toHaveLength(1);
      // P5-B3: a new pivot no longer states a quantity; the column default applies.
      expect(createdPivots[0]).toMatchObject({ published: true, price: null });
      expect(createdPivots[0].stockQuantity).toBeUndefined();
      expect(idOf(createdPivots[0].store)).toBe('store-a');
    });

    it('refuses when a required field is unanswered, and no pivot ever existed', async () => {
      const { service, log, createdPivots, attempts } = build(requiredWeight());

      const err = await service
        .create({ name: 'Silla', status: ProductStatus.PUBLISHED, storeIds: ['store-a'] } as any, actor)
        .catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        storeId: 'store-a',
        missingFieldKeys: ['weight'],
        missingFieldCount: 1,
        truncated: false,
      });
      // Not even a staged one: refusal happens strictly before the diff is applied.
      expect(createdPivots).toHaveLength(0);
      expect(log).not.toContain('persist:StoreProduct');
      expect(log).toContain('tx:1:rollback');
      // A refusal is an answer, not contention — retrying it is not allowed.
      expect(attempts()).toBe(1);
    });

    it('locks the family root and every publishing store, in the one canonical order', async () => {
      const { service, log } = build();

      await service.create({ name: 'Silla', storeIds: ['store-b', 'store-a'] } as any, actor);

      // The new product is its own family root; expectation computed with the
      // very utilities production uses, so this cannot drift from them.
      const expected = sortLockKeys([
        productFamilyLock('p-new'),
        storePublicationLock('store-a'),
        storePublicationLock('store-b'),
      ]).map((k) => `lock:${k.ns}:${k.key}`);
      expect(lockEntries(log)).toEqual(expected);
    });

    it('rolls back product, values and pivots together when a store price is refused', async () => {
      const { service, log, em, attempts } = build({
        definitions: [{ id: 'd1', key: 'weight', type: ProductFieldType.TEXT, archivedAt: null }],
      });

      const err = await service
        .create(
          {
            name: 'Silla',
            storeIds: ['store-a'],
            fieldValues: [{ definitionId: 'd1', value: 'oak' }],
            storePrices: [{ storeId: 'store-a', price: 10, salePrice: 15 }],
          } as any,
          actor,
        )
        .catch((e) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toMatch(/exceed/);
      // Product, value and pivot were all written INSIDE the transaction that
      // the refusal then rolled back — nothing survives it piecemeal.
      expect(log).toContain('persistAndFlush');
      expect(log).toContain('persist:ProductFieldValue');
      expect(log).toContain('persist:StoreProduct');
      expect(log).toContain('tx:1:rollback');
      expect(log).not.toContain('tx:1:commit');
      // A pricing refusal is an answer, not contention.
      expect(attempts()).toBe(1);
      expect(em.find).not.toHaveBeenCalled();
      expect(em.flush).not.toHaveBeenCalled();
    });

    it('prices the pivots it just created, never through the root manager', async () => {
      const { service, log, em, createdPivots } = build();

      await service.create(
        { name: 'Silla', storeIds: ['store-a'], storePrices: [{ storeId: 'store-a', price: 99 }] } as any,
        actor,
      );

      // The override found a pivot that existed nowhere but inside this
      // transaction — proof the membership step was flushed before the pricing
      // query, on the SAME transactional manager.
      expect(createdPivots).toHaveLength(1);
      expect(createdPivots[0].price).toBe(99);
      expect(log.indexOf('persist:StoreProduct')).toBeLessThan(log.lastIndexOf('read:StoreProduct'));
      // The root manager wrote and read nothing: pricing lives in the transaction.
      expect(em.find).not.toHaveBeenCalled();
      expect(em.flush).not.toHaveBeenCalled();
      expect(em.persistAndFlush).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('keeps a retained pivot as the same untouched row through a membership edit', async () => {
      const retained = pivot('store-a', {
        published: false,
        price: '99.90',
        cost: '40.00',
        stockQuantity: 7,
        trackInventory: true,
        leadTimeDays: 5,
      });
      const { service, createdPivots, removedPivots } = build({
        products: { 'p-1': product() },
        pivots: [retained],
      });

      await service.update('p-1', { storeIds: ['store-a', 'store-b'] } as any, ORG, actor);

      // The branch's own commercial decisions — and its deliberate unpublish —
      // survive because the retained row is never in the update set at all.
      expect(removedPivots).toHaveLength(0);
      expect(createdPivots).toHaveLength(1);
      expect(idOf(createdPivots[0].store)).toBe('store-b');
      expect(createdPivots[0]).toMatchObject({ published: true, price: null, cost: null });
      expect(createdPivots[0].stockQuantity).toBeUndefined();
      expect(retained).toMatchObject({
        published: false,
        price: '99.90',
        cost: '40.00',
        stockQuantity: 7,
        trackInventory: true,
        leadTimeDays: 5,
      });
    });

    it('rolls back and retries in a fresh transaction when the lock set widens', async () => {
      const { service, world, log, locks, createdPivots, tems, attempts } = build({
        products: { 'p-1': product() },
        pivots: [pivot('store-b')],
        // Between discovery and rederivation of attempt 1, a concurrent
        // operation removes store-b's pivot — store-b silently becomes a
        // PUBLISHING store whose lock attempt 1 never took.
        afterPivotRead: (attempt, read) => {
          if (attempt === 1 && read === 1) world.pivots = [];
        },
      });

      await service.update('p-1', { storeIds: ['store-a', 'store-b'] } as any, ORG, actor);

      expect(attempts()).toBe(2);
      // Rollback of the first transaction is COMPLETE before the second begins.
      expect(log.indexOf('tx:1:rollback')).toBeLessThan(log.indexOf('tx:2:start'));
      // A fresh transaction means a fresh entity manager, not a reused graph.
      expect(tems).toHaveLength(2);
      expect(tems[0]).not.toBe(tems[1]);
      // Attempt 1 held family + store-a only; attempt 2 named all three.
      expect(locks.filter((l) => l.attempt === 1)).toHaveLength(2);
      expect(locks.filter((l) => l.attempt === 2)).toHaveLength(3);
      // Nothing the doomed attempt staged survives: pivots exist only from tx 2.
      const tx1Window = log.slice(log.indexOf('tx:1:start'), log.indexOf('tx:1:rollback'));
      expect(tx1Window).not.toContain('persist:StoreProduct');
      expect(createdPivots.map((p) => idOf(p.store)).sort()).toEqual(['store-a', 'store-b']);
    });

    it('gives up after three whole transactions of contention, as a conflict', async () => {
      const { service, world, log, attempts } = build({
        products: { 'p-1': product() },
        onAttemptStart: () => {
          world.pivots = [pivot('store-b')];
        },
        afterPivotRead: (_attempt, read) => {
          if (read === 1) world.pivots = [];
        },
      });

      const err = await service.update('p-1', { storeIds: ['store-a', 'store-b'] } as any, ORG, actor).catch((e) => e);

      // The internal widening signal never leaks; the caller sees a 409 that
      // says what happened in the caller's terms.
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.message).toMatch(/kept changing/);
      expect(attempts()).toBe(3);
      expect(log).toContain('tx:3:rollback');
    });

    it('does not retry a publication refusal', async () => {
      const { service, attempts } = build({
        products: { 'p-1': product() },
        definitions: [{ id: 'd1', key: 'weight', type: ProductFieldType.NUMBER, archivedAt: null }],
        settings: [{ store: { id: 'store-b' }, definition: { id: 'd1', key: 'weight' }, active: true, required: true }],
      });

      const err = await service.update('p-1', { storeIds: ['store-b'] } as any, ORG, actor).catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err.getResponse() as any).storeId).toBe('store-b');
      expect(attempts()).toBe(1);
    });

    it('takes no locks for an edit that publishes nowhere', async () => {
      const { service, log, attempts, auditLog } = build({ products: { 'p-1': product() } });

      const updated = await service.update('p-1', { name: 'Silla Nordica' } as any, ORG, actor);

      expect(updated.name).toBe('Silla Nordica');
      expect(lockEntries(log)).toEqual([]);
      expect(attempts()).toBe(1);
      expect(auditLog.recordAuditEntry).toHaveBeenCalled();
    });

    it('removes membership under the family lock alone, validating nothing', async () => {
      const removable = pivot('store-a');
      const { service, log, removedPivots, createdPivots } = build({
        products: { 'p-1': product() },
        pivots: [removable],
      });

      await service.update('p-1', { storeIds: [] } as any, ORG, actor);

      // A leaving pivot can violate nothing; only PUBLISHING needs the guard.
      expect(removedPivots).toEqual([removable]);
      expect(createdPivots).toHaveLength(0);
      // But whether p-1 is a card is a family-shape fact, and an attachment
      // promoting it holds its family key: a removal that held nothing could
      // strip a branch from what had just become a card. No store key —
      // nothing new is shown, so no store requirement is read.
      const family = productFamilyLock('p-1');
      expect(lockEntries(log)).toEqual([`lock:${family.ns}:${family.key}`]);
      expect(log).not.toContain('read:StoreFieldSetting');
    });

    it('rolls back scalar and membership changes when a store price is refused', async () => {
      const { service, log, em, auditLog, attempts } = build({ products: { 'p-1': product() } });

      const err = await service
        .update(
          'p-1',
          {
            name: 'Renamed',
            storeIds: ['store-a'],
            // store-b never became a member, so this override has nothing to
            // attach to — refused AFTER the rename and the membership staging.
            storePrices: [{ storeId: 'store-b', price: 5 }],
          } as any,
          ORG,
          actor,
        )
        .catch((e) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.message).toMatch(/do not exist/);
      // The membership work had already been staged in this very transaction;
      // the refusal rolls it back together with the rename.
      expect(log).toContain('persist:StoreProduct');
      expect(log).toContain('tx:1:rollback');
      expect(log).not.toContain('tx:1:commit');
      expect(attempts()).toBe(1);
      // Nothing committed, so nothing is audited as changed.
      expect(auditLog.recordAuditEntry).not.toHaveBeenCalled();
      expect(em.find).not.toHaveBeenCalled();
      expect(em.flush).not.toHaveBeenCalled();
    });

    it('reapplies pricing on the fresh transactional manager after a widening retry', async () => {
      const { service, world, em, tems, createdPivots, attempts } = build({
        products: { 'p-1': product() },
        pivots: [pivot('store-b')],
        afterPivotRead: (attempt, read) => {
          if (attempt === 1 && read === 1) world.pivots = [];
        },
      });

      await service.update(
        'p-1',
        { storeIds: ['store-a', 'store-b'], storePrices: [{ storeId: 'store-a', price: 42 }] } as any,
        ORG,
        actor,
      );

      expect(attempts()).toBe(2);
      // Attempt 1 died at the widening check — discovery and rederivation only,
      // no pricing read. Attempt 2 read pivots twice to take its keys before
      // its first write, a third time to validate under them, and a fourth for
      // pricing, all on ITS OWN manager; the override landed on the pivot
      // attempt 2 created.
      expect(storeProductReads(tems[0])).toBe(2);
      expect(storeProductReads(tems[1])).toBe(4);
      const byStore = new Map(createdPivots.map((p) => [idOf(p.store), p]));
      expect(byStore.get('store-a')).toMatchObject({ price: 42, salePrice: null });
      expect(byStore.get('store-b')).toMatchObject({ price: null });
      expect(em.find).not.toHaveBeenCalled();
      expect(em.flush).not.toHaveBeenCalled();
    });

    describe('status → PUBLISHED', () => {
      it('validates every already-published pivot of the final state, not just new ones', async () => {
        const { service, log, attempts } = build({
          products: { 'p-1': product({ status: ProductStatus.DRAFT }) },
          pivots: [pivot('store-a'), pivot('store-b', { published: false })],
          definitions: [{ id: 'd1', key: 'weight', type: ProductFieldType.NUMBER, archivedAt: null }],
          settings: [
            { store: { id: 'store-a' }, definition: { id: 'd1', key: 'weight' }, active: true, required: true },
          ],
        });

        const err = await service.update('p-1', { status: ProductStatus.PUBLISHED } as any, ORG, actor).catch((e) => e);

        // No pivot was created or touched — the status flip alone is what
        // would have turned store-a's published pivot live, so it is refused.
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getResponse()).toMatchObject({ storeId: 'store-a', missingFieldKeys: ['weight'] });
        expect(attempts()).toBe(1);
        expect(log).toContain('tx:1:rollback');
        expect(log).not.toContain('tx:1:commit');
      });

      it('locks exactly the pivots the flip turns live — unpublished ones stay out of it', async () => {
        const { service, log, createdPivots, removedPivots } = build({
          products: { 'p-1': product({ status: ProductStatus.DRAFT }) },
          pivots: [pivot('store-a'), pivot('store-b', { published: false })],
        });

        const updated = await service.update('p-1', { status: ProductStatus.PUBLISHED } as any, ORG, actor);

        expect(updated.status).toBe(ProductStatus.PUBLISHED);
        const expected = sortLockKeys([productFamilyLock('p-1'), storePublicationLock('store-a')]).map(
          (k) => `lock:${k.ns}:${k.key}`,
        );
        expect(lockEntries(log)).toEqual(expected);
        // A pure status flip edits no membership.
        expect(createdPivots).toHaveLength(0);
        expect(removedPivots).toHaveLength(0);
      });

      it('validates the union of created and retained-published stores when storeIds ride along', async () => {
        const { service, log } = build({
          products: { 'p-1': product({ status: ProductStatus.DRAFT }) },
          pivots: [pivot('store-a')],
          definitions: [{ id: 'd1', key: 'weight', type: ProductFieldType.NUMBER, archivedAt: null }],
          settings: [
            { store: { id: 'store-a' }, definition: { id: 'd1', key: 'weight' }, active: true, required: true },
          ],
        });

        const err = await service
          .update('p-1', { storeIds: ['store-a', 'store-b'], status: ProductStatus.PUBLISHED } as any, ORG, actor)
          .catch((e) => e);

        // The blocker is store-a — a RETAINED pivot. Validating only the
        // created set would have waved this request through on store-b.
        expect(err).toBeInstanceOf(ConflictException);
        expect((err.getResponse() as any).storeId).toBe('store-a');
        // Both exposed stores were locked, with the family root, before the
        // guard decided; and store-b's pivot was never created.
        const expected = sortLockKeys([
          productFamilyLock('p-1'),
          storePublicationLock('store-a'),
          storePublicationLock('store-b'),
        ]).map((k) => `lock:${k.ns}:${k.key}`);
        expect(lockEntries(log)).toEqual(expected);
        expect(log).not.toContain('persist:StoreProduct');
      });

      it('retries when a concurrent publication widens the exposure mid-flip', async () => {
        const { service, world, locks, attempts, createdPivots } = build({
          products: { 'p-1': product({ status: ProductStatus.DRAFT }) },
          pivots: [pivot('store-a')],
          // Between discovery and rederivation, a concurrent operation
          // publishes store-b's pivot — the flip would turn it live too.
          afterPivotRead: (attempt, read) => {
            if (attempt === 1 && read === 1) world.pivots.push(pivot('store-b'));
          },
        });

        const updated = await service.update('p-1', { status: ProductStatus.PUBLISHED } as any, ORG, actor);

        expect(updated.status).toBe(ProductStatus.PUBLISHED);
        expect(attempts()).toBe(2);
        expect(locks.filter((l) => l.attempt === 1)).toHaveLength(2);
        expect(locks.filter((l) => l.attempt === 2)).toHaveLength(3);
        expect(createdPivots).toHaveLength(0);
      });

      it('leaving published state validates nothing, even with membership changes riding along', async () => {
        const { service, log, createdPivots } = build({
          products: { 'p-1': product() },
          definitions: [{ id: 'd1', key: 'weight', type: ProductFieldType.NUMBER, archivedAt: null }],
          settings: [
            { store: { id: 'store-b' }, definition: { id: 'd1', key: 'weight' }, active: true, required: true },
          ],
        });

        const updated = await service.update(
          'p-1',
          { storeIds: ['store-b'], status: ProductStatus.DRAFT } as any,
          ORG,
          actor,
        );

        // The final state is unpublished: nothing reaches a customer, so the
        // unanswered requirement on store-b blocks nothing.
        expect(updated.status).toBe(ProductStatus.DRAFT);
        expect(createdPivots).toHaveLength(1);
        expect(idOf(createdPivots[0].store)).toBe('store-b');
        expect(log).not.toContain('read:StoreFieldSetting');
      });
    });
  });

  describe('assignToStore', () => {
    it('refuses to flip a hidden pivot published where a required field is unanswered', async () => {
      const link = pivot('store-a', { published: false });
      const { service, log, attempts } = build({
        products: { 'p-1': product() },
        pivots: [link],
        ...requiredWeight(),
      });

      const err = await service.assignToStore('p-1', 'store-a', { published: true } as any, actor).catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect((err.getResponse() as any).storeId).toBe('store-a');
      // The pivot was never touched: validation precedes every write, and the
      // whole assignment rolled back. Nothing was silently unpublished either
      // — the row still says exactly what the branch last said.
      expect(link.published).toBe(false);
      expect(log).toContain('tx:1:rollback');
      expect(log).not.toContain('tx:1:commit');
      expect(attempts()).toBe(1);
    });

    it('locks the family root and the one store it newly exposes', async () => {
      const link = pivot('store-a', { published: false });
      const { service, log } = build({ products: { 'p-1': product() }, pivots: [link] });

      const result = await service.assignToStore('p-1', 'store-a', { published: true } as any, actor);

      expect(result.published).toBe(true);
      const expected = sortLockKeys([productFamilyLock('p-1'), storePublicationLock('store-a')]).map(
        (k) => `lock:${k.ns}:${k.key}`,
      );
      expect(lockEntries(log)).toEqual(expected);
    });

    it('holds only the family lock and validates nothing when the pivot is not newly exposed', async () => {
      const link = pivot('store-a');
      const { service, log } = build({
        products: { 'p-1': product() },
        pivots: [link],
        ...requiredWeight(),
      });

      // An explicit unpublish — the only way publication ever goes away —
      // plus a price change: no exposure, so the unanswered requirement on
      // store-a blocks nothing.
      const result = await service.assignToStore('p-1', 'store-a', { published: false, price: 12 } as any, actor);

      expect(result.published).toBe(false);
      expect(result.price).toBe(12);
      // Whether p-1 is a card is decided under its family key even when
      // nothing is exposed — an attachment promoting it holds that key. No
      // store key: nothing new is shown, so no store requirement is read.
      expect(lockEntries(log)).toEqual([`lock:${productFamilyLock('p-1').ns}:${productFamilyLock('p-1').key}`]);
      expect(log).not.toContain('read:StoreFieldSetting');
    });

    it('retries on a fresh manager when a concurrent unpublish widens the exposure', async () => {
      const link = pivot('store-a');
      const { service, tems, locks, attempts } = build({
        products: { 'p-1': product() },
        pivots: [link],
        // Discovery sees a published link — publishing it again exposes
        // nothing. Between the two reads a concurrent operation unpublishes
        // it, so the second read suddenly needs a lock the first never took.
        afterLinkRead: (attempt, read) => {
          if (attempt === 1 && read === 1) link.published = false;
        },
      });

      const result = await service.assignToStore('p-1', 'store-a', { published: true } as any, actor);

      expect(result.published).toBe(true);
      expect(attempts()).toBe(2);
      expect(tems).toHaveLength(2);
      expect(tems[0]).not.toBe(tems[1]);
      // Attempt 1 held only the family key; its second read needed the store
      // key too, so it restarted, and attempt 2 named family + store from the
      // start.
      const family = productFamilyLock('p-1');
      expect(locks.filter((l) => l.attempt === 1).map((l) => [l.ns, l.key])).toEqual([[family.ns, family.key]]);
      expect(locks.filter((l) => l.attempt === 2)).toHaveLength(2);
    });
  });
});
