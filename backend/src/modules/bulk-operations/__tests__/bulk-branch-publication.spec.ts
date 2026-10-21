import { NotFoundException } from '@nestjs/common';
import { BulkOperationsService } from '../bulk-operations.service';
import { PublicationGuardService } from '../../products/publication/publication-guard.service';
import { ProductStatus } from '../../products/catalogue/product-status.enum';
import { Action } from '../../audit-log/entities/audit-log.entity';
import { productFamilyLock, sortLockKeys, storePublicationLock } from '../../products/families/advisory-lock.util';
import { stockDouble } from '../../../../test/inventory-stock-support';

/**
 * Bulk per-website publication (ADR 029) under the publication guard.
 *
 * The guard, the lock keys and the family-root derivation are the REAL code —
 * only the database is faked. Pinned here:
 *
 *   - the ONLY column written is `store_products.published`; no pivot is
 *     created or removed, no other branch field is touched;
 *   - the family-root advisory lock is held for BOTH directions, and the card
 *     decision is made under it; publishing adds exactly the store key;
 *   - a card is SKIPPED_PARENT (not FAILED), a non-member is FAILED without an
 *     insert, an unchanged link is UNCHANGED without a flush or an audit row;
 *   - each product runs in its own fresh retryable transaction, and only a
 *     widened lock set retries — a guard refusal never does.
 */
describe('bulk website publication (ADR 029)', () => {
  const ORG = 'org-1';
  const SCOPE = {
    platform: false,
    organizationId: ORG,
    storeId: null,
    allowedStoreIds: ['store-a', 'store-b'],
    role: 'ORGANIZATION_MANAGER',
  } as any;
  const actor = { id: 'u1', email: 'ana@acme.test' };
  const idOf = (ref: any): string => (typeof ref === 'string' ? ref : ref?.id);

  interface World {
    stores: Record<string, any>;
    products: Record<string, any>;
    pivots: any[];
    settings: any[];
    values: any[];
    /** children per parent id — the card decision reads this under the lock */
    childCount: Record<string, number>;
    afterPivotRead?: (attempt: number, read: number, pivot: any | null) => void;
  }

  const product = (id: string, over: Record<string, any> = {}) => ({
    id,
    name: `item-${id}`,
    status: ProductStatus.PUBLISHED,
    archivedAt: null,
    organization: { id: ORG },
    parent: null,
    ...over,
  });

  const pivot = (productId: string, storeId: string, over: Record<string, any> = {}) => ({
    store: { id: storeId },
    product: { id: productId },
    published: false,
    price: '12.50',
    salePrice: null,
    cost: '7.00',
    stockQuantity: 4,
    trackInventory: true,
    leadTimeDays: 3,
    ...over,
  });

  const build = (over: Partial<World> = {}) => {
    const world: World = {
      stores: {
        'store-a': { id: 'store-a', name: 'Elite', slug: 'elite', archivedAt: null, organization: { id: ORG } },
        'store-b': { id: 'store-b', name: 'Norte', slug: 'norte', archivedAt: null, organization: { id: ORG } },
      },
      products: {},
      pivots: [],
      settings: [],
      values: [],
      childCount: {},
      ...over,
    };

    const log: string[] = [];
    const locks: { attempt: number; ns: number; key: number }[] = [];
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
            const row = where?.id ? world.products[where.id] : null;
            if (!row) return null;
            if (where.organization && row.organization?.id !== where.organization) return null;
            // A fresh transaction hydrates its own entity.
            return { ...row };
          }
          if (name === 'Store') {
            const row = world.stores[where.id];
            if (!row || (where.archivedAt === null && row.archivedAt)) return null;
            return { ...row };
          }
          if (name === 'StoreProduct') {
            const row =
              world.pivots.find((p) => idOf(p.store) === where.store && idOf(p.product) === where.product) ?? null;
            pivotReads += 1;
            log.push(`read:pivot:${attempt}:${pivotReads}`);
            world.afterPivotRead?.(attempt, pivotReads, row);
            // The SAME object: what the service assigns is what the world holds.
            return row;
          }
          return null;
        }),
        find: jest.fn(async (entity: any, where: any) => {
          const name = typeof entity === 'function' ? entity.name : String(entity);
          if (name === 'Store') return storeRows(where);
          if (name === 'StoreFieldSetting') {
            log.push('read:settings');
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
        count: jest.fn(async (_entity: any, where: any) => {
          log.push(`count:children:${attempt}`);
          return world.childCount[where?.parent] ?? 0;
        }),
        create: jest.fn(() => {
          log.push('create');
          return {};
        }),
        persist: jest.fn(() => log.push('persist')),
        remove: jest.fn(() => log.push('remove')),
        flush: jest.fn(async () => {
          log.push(`flush:${attempt}`);
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
      // Root manager: resolveStoresInScope resolves the target store here, once
      // for the whole batch; everything else is transactional.
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

    return { service, world, log, locks, tems, em, auditLog, attempts: () => attempts };
  };

  const requireWeightIn = (storeId: string) => [
    { store: { id: storeId }, definition: { id: 'd1', key: 'weight' }, active: true, required: true },
  ];

  const held = (locks: { ns: number; key: number }[], attempt = 1) =>
    locks.filter((l: any) => l.attempt === attempt).map(({ ns, key }) => ({ ns, key }));

  describe('the family root is derived from the product as it is UNDER the lock', () => {
    it.each([
      ['publish', false, true],
      ['hide', true, false],
    ])(
      '%s: a parent gained between the first read and the lock widens the set — the retry holds the PARENT’s root',
      async (_label, linkPublished, published) => {
        const { service, world, attempts, locks } = build({
          products: { 'p-1': product('p-1') },
          pivots: [pivot('p-1', 'store-a', { published: linkPublished })],
        });
        // The grouping lands after the first derivation decided on root p-1 and
        // before the second reads the product again: the product is now a
        // child of `card`, so its root — and its lock — is the card's.
        world.afterPivotRead = (attempt, read) => {
          if (attempt === 1 && read === 1) world.products['p-1'].parent = { id: 'card' };
        };

        const result = await service.bulkBranchPublication(SCOPE, ['p-1'], 'store-a', published, actor);

        expect(attempts()).toBe(2);
        expect(result.outcomes[0]).toMatchObject({ outcome: 'UPDATED' });
        const expected = published
          ? sortLockKeys([productFamilyLock('card'), storePublicationLock('store-a')])
          : [productFamilyLock('card')];
        expect(held(locks, 2)).toEqual(expected);
        // The stale root was never the one the write relied on.
        expect(held(locks, 1)).toContainEqual(productFamilyLock('p-1'));
        expect(world.pivots[0].published).toBe(published);
      },
    );
  });

  describe('a narrowed caller and an archived website', () => {
    const narrowedTo = (storeId: string) =>
      ({ ...SCOPE, storeId, allowedStoreIds: ['store-a', 'store-b'], role: 'ORGANIZATION_MANAGER' }) as any;

    it('a caller narrowed to store-a may publish on store-a', async () => {
      const { service } = build({ products: { 'p-1': product('p-1') }, pivots: [pivot('p-1', 'store-a')] });

      const result = await service.bulkBranchPublication(narrowedTo('store-a'), ['p-1'], 'store-a', true, actor);

      expect(result.outcomes[0]).toMatchObject({ outcome: 'UPDATED' });
    });

    it('a caller narrowed to store-a is refused a SIBLING store with the uniform not-found, before any transaction', async () => {
      const { service, em } = build({ products: { 'p-1': product('p-1') }, pivots: [pivot('p-1', 'store-b')] });

      await expect(
        service.bulkBranchPublication(narrowedTo('store-a'), ['p-1'], 'store-b', true, actor),
      ).rejects.toThrow('Store with ID store-b not found');
      expect(em.transactional).not.toHaveBeenCalled();
    });

    it('an archived website refuses the WHOLE request with not-found, before any transaction', async () => {
      const { service, em, world } = build({ products: { 'p-1': product('p-1') }, pivots: [pivot('p-1', 'store-a')] });
      world.stores['store-a'].archivedAt = new Date();

      await expect(service.bulkBranchPublication(SCOPE, ['p-1'], 'store-a', true, actor)).rejects.toThrow(
        'Store with ID store-a not found',
      );
      expect(em.transactional).not.toHaveBeenCalled();
    });
  });

  describe('publishing a hidden product on one website', () => {
    it('flips ONLY the published flag and leaves every other branch field alone', async () => {
      const { service, world, log } = build({
        products: { 'p-1': product('p-1') },
        pivots: [pivot('p-1', 'store-a'), pivot('p-1', 'store-b', { published: true })],
      });

      const result = await service.bulkBranchPublication(SCOPE, ['p-1'], 'store-a', true, actor);

      expect(result.outcomes).toEqual([{ id: 'p-1', outcome: 'UPDATED', globalStatus: 'PUBLISHED' }]);
      expect(result).toMatchObject({ updatedCount: 1, unchangedCount: 0, skippedParentCount: 0, failedCount: 0 });
      const [target, sibling] = world.pivots;
      expect(target).toMatchObject({
        published: true,
        price: '12.50',
        salePrice: null,
        cost: '7.00',
        stockQuantity: 4,
        trackInventory: true,
        leadTimeDays: 3,
      });
      // The sibling branch is untouched — not even read for writing.
      expect(sibling).toMatchObject({ published: true, price: '12.50' });
      expect(log.filter((l) => ['create', 'persist', 'remove'].includes(l))).toEqual([]);
      expect(log.filter((l) => l.startsWith('flush'))).toEqual(['flush:1']);
    });

    it('holds the family root AND the store key, in the guard’s canonical order', async () => {
      const { service, locks } = build({
        products: { 'p-1': product('p-1') },
        pivots: [pivot('p-1', 'store-a')],
      });

      await service.bulkBranchPublication(SCOPE, ['p-1'], 'store-a', true, actor);

      expect(held(locks)).toEqual(sortLockKeys([productFamilyLock('p-1'), storePublicationLock('store-a')]));
    });

    it('names the PARENT as the family root for a child product', async () => {
      const { service, locks } = build({
        products: { kid: product('kid', { parent: { id: 'card' } }) },
        pivots: [pivot('kid', 'store-a')],
      });

      await service.bulkBranchPublication(SCOPE, ['kid'], 'store-a', true, actor);

      expect(held(locks)).toEqual(sortLockKeys([productFamilyLock('card'), storePublicationLock('store-a')]));
    });

    it('runs the existing publication guard over exactly that store, and a refusal is this product’s FAILED', async () => {
      const { service, world, log, auditLog } = build({
        products: { 'p-1': product('p-1') },
        pivots: [pivot('p-1', 'store-a')],
        settings: requireWeightIn('store-a'),
      });

      const result = await service.bulkBranchPublication(SCOPE, ['p-1'], 'store-a', true, actor);

      expect(result.outcomes[0]).toMatchObject({ id: 'p-1', outcome: 'FAILED' });
      expect(result.outcomes[0].message).toMatch(/cannot be published/);
      expect(result.failedCount).toBe(1);
      expect(world.pivots[0].published).toBe(false);
      expect(log.filter((l) => l.startsWith('flush'))).toEqual([]);
      expect(log).toContain('tx:1:rollback');
      expect(auditLog.recordAuditEntry).not.toHaveBeenCalled();
    });

    it('does not retry a guard refusal — it is not a widening', async () => {
      const { service, attempts } = build({
        products: { 'p-1': product('p-1') },
        pivots: [pivot('p-1', 'store-a')],
        settings: requireWeightIn('store-a'),
      });

      await service.bulkBranchPublication(SCOPE, ['p-1'], 'store-a', true, actor);

      expect(attempts()).toBe(1);
    });

    it('retries ONLY the product whose lock set widened, on a fresh transaction', async () => {
      const { service, world, attempts, locks } = build({
        products: { 'p-1': product('p-1') },
        pivots: [pivot('p-1', 'store-a', { published: true })],
      });
      // First derivation sees the link already published (nothing to expose,
      // family lock only); between the reads a sibling writer hides it, so the
      // second derivation exposes the store — a lock the first pass never took.
      // The hook fires as the SECOND read is served, i.e. after the first
      // derivation has already decided on the published link.
      world.afterPivotRead = (attempt, read, row) => {
        if (attempt === 1 && read === 2 && row) row.published = false;
      };

      const result = await service.bulkBranchPublication(SCOPE, ['p-1'], 'store-a', true, actor);

      expect(attempts()).toBe(2);
      expect(result.outcomes[0]).toMatchObject({ outcome: 'UPDATED' });
      expect(held(locks, 2)).toEqual(sortLockKeys([productFamilyLock('p-1'), storePublicationLock('store-a')]));
      expect(world.pivots[0].published).toBe(true);
    });

    it('audits PUBLISH with the branch flag before→after and the website in its context', async () => {
      const { service, auditLog } = build({
        products: { 'p-1': product('p-1') },
        pivots: [pivot('p-1', 'store-a')],
      });

      await service.bulkBranchPublication(SCOPE, ['p-1'], 'store-a', true, actor);

      expect(auditLog.recordAuditEntry).toHaveBeenCalledTimes(1);
      const [, , , entityId, action, changes, message, context] = auditLog.recordAuditEntry.mock.calls[0];
      expect(entityId).toBe('p-1');
      expect(action).toBe(Action.PUBLISH);
      expect(changes).toEqual({ branchPublished: { before: false, after: true } });
      expect(message).toMatch(/published "item-p-1" on website "Elite"/);
      expect(context).toEqual({ organizationId: ORG, storeId: 'store-a' });
    });
  });

  describe('hiding a published product on one website', () => {
    it('takes the family-root lock and NO store key, and never consults the guard', async () => {
      const { service, world, locks, log } = build({
        products: { 'p-1': product('p-1') },
        pivots: [pivot('p-1', 'store-a', { published: true })],
        // A requirement the product does not answer: publishing would be
        // refused, hiding is not that operation's concern.
        settings: requireWeightIn('store-a'),
      });

      const result = await service.bulkBranchPublication(SCOPE, ['p-1'], 'store-a', false, actor);

      expect(result.outcomes[0]).toMatchObject({ outcome: 'UPDATED' });
      expect(held(locks)).toEqual([productFamilyLock('p-1')]);
      expect(log).not.toContain('read:settings');
      expect(world.pivots[0].published).toBe(false);
    });

    it('audits UNPUBLISH', async () => {
      const { service, auditLog } = build({
        products: { 'p-1': product('p-1') },
        pivots: [pivot('p-1', 'store-a', { published: true })],
      });

      await service.bulkBranchPublication(SCOPE, ['p-1'], 'store-a', false, actor);

      const [, , , , action, changes] = auditLog.recordAuditEntry.mock.calls[0];
      expect(action).toBe(Action.UNPUBLISH);
      expect(changes).toEqual({ branchPublished: { before: true, after: false } });
    });

    it('decides "card or not" UNDER the family lock, so a product that just became a card is skipped, not written', async () => {
      const { service, world, log } = build({
        products: { 'p-1': product('p-1') },
        pivots: [pivot('p-1', 'store-a', { published: true })],
      });
      // The grouping lands between the discovery read and the read under the
      // lock: the second derivation must see it.
      world.afterPivotRead = (attempt, read) => {
        if (attempt === 1 && read === 1) world.childCount['p-1'] = 2;
      };

      const result = await service.bulkBranchPublication(SCOPE, ['p-1'], 'store-a', false, actor);

      expect(result.outcomes[0]).toMatchObject({ id: 'p-1', outcome: 'SKIPPED_PARENT' });
      expect(world.pivots[0].published).toBe(true);
      // The card count is read once per derivation; the lock sits between them.
      const order = log.filter((l) => /^(count:children|lock:)/.test(l));
      expect(order[0]).toBe('count:children:1');
      expect(order[1]).toMatch(/^lock:/);
      expect(order[2]).toBe('count:children:1');
      expect(log.filter((l) => l.startsWith('flush'))).toEqual([]);
    });
  });

  describe('outcomes that write nothing', () => {
    it('UNCHANGED when the link already holds the requested state: no flush, no audit', async () => {
      const { service, log, auditLog } = build({
        products: { 'p-1': product('p-1', { status: ProductStatus.DRAFT }) },
        pivots: [pivot('p-1', 'store-a', { published: true })],
      });

      const result = await service.bulkBranchPublication(SCOPE, ['p-1'], 'store-a', true, actor);

      expect(result.outcomes).toEqual([{ id: 'p-1', outcome: 'UNCHANGED', globalStatus: 'DRAFT' }]);
      expect(result.unchangedCount).toBe(1);
      expect(log.filter((l) => l.startsWith('flush'))).toEqual([]);
      expect(auditLog.recordAuditEntry).not.toHaveBeenCalled();
    });

    it('SKIPPED_PARENT for a family card, with the explanation and nothing written', async () => {
      const { service, log, auditLog } = build({
        products: { card: product('card') },
        pivots: [pivot('card', 'store-a')],
        childCount: { card: 3 },
      });

      const result = await service.bulkBranchPublication(SCOPE, ['card'], 'store-a', true, actor);

      expect(result.outcomes[0]).toMatchObject({ id: 'card', outcome: 'SKIPPED_PARENT' });
      expect(result.outcomes[0].message).toMatch(
        /parent card, so its website publication is set on its child products/,
      );
      expect(result).toMatchObject({ skippedParentCount: 1, failedCount: 0, updatedCount: 0 });
      expect(log.filter((l) => /^(flush|create|persist|remove)/.test(l))).toEqual([]);
      expect(auditLog.recordAuditEntry).not.toHaveBeenCalled();
    });

    it('FAILED for a product that is not on that website — nothing is added', async () => {
      const { service, log } = build({
        products: { 'p-1': product('p-1') },
        pivots: [pivot('p-1', 'store-b', { published: true })],
      });

      const result = await service.bulkBranchPublication(SCOPE, ['p-1'], 'store-a', true, actor);

      expect(result.outcomes[0]).toMatchObject({ outcome: 'FAILED' });
      expect(result.outcomes[0].message).toMatch(/not on that website/);
      expect(log.filter((l) => /^(create|persist|flush)/.test(l))).toEqual([]);
    });

    it('FAILED for an archived product', async () => {
      const { service } = build({
        products: { 'p-1': product('p-1', { archivedAt: new Date(), status: ProductStatus.ARCHIVED }) },
        pivots: [pivot('p-1', 'store-a')],
      });

      const result = await service.bulkBranchPublication(SCOPE, ['p-1'], 'store-a', true, actor);

      expect(result.outcomes[0]).toMatchObject({ outcome: 'FAILED' });
      expect(result.outcomes[0].message).toMatch(/archived/);
    });

    it('FAILED with the same not-found for a foreign product as for a missing one', async () => {
      const { service } = build({
        products: { theirs: product('theirs', { organization: { id: 'org-2' } }) },
        pivots: [pivot('theirs', 'store-a')],
      });

      const result = await service.bulkBranchPublication(SCOPE, ['theirs', 'nope'], 'store-a', true, actor);

      expect(result.outcomes.map((o) => o.message)).toEqual([
        'Product with ID theirs not found',
        'Product with ID nope not found',
      ]);
      expect(result.failedCount).toBe(2);
    });
  });

  describe('the batch', () => {
    it('keeps one fresh transaction per product and reports every id in request order', async () => {
      const { service, em, world } = build({
        products: {
          ok: product('ok'),
          card: product('card'),
          same: product('same'),
          absent: product('absent'),
        },
        pivots: [pivot('ok', 'store-a'), pivot('card', 'store-a'), pivot('same', 'store-a', { published: true })],
        childCount: { card: 2 },
      });

      const result = await service.bulkBranchPublication(
        SCOPE,
        ['ok', 'card', 'same', 'absent'],
        'store-a',
        true,
        actor,
      );

      expect(result.outcomes.map((o) => [o.id, o.outcome])).toEqual([
        ['ok', 'UPDATED'],
        ['card', 'SKIPPED_PARENT'],
        ['same', 'UNCHANGED'],
        ['absent', 'FAILED'],
      ]);
      expect(result).toMatchObject({
        storeId: 'store-a',
        published: true,
        updatedCount: 1,
        skippedParentCount: 1,
        unchangedCount: 1,
        failedCount: 1,
      });
      expect(em.transactional).toHaveBeenCalledTimes(4);
      expect(world.pivots.map((p) => p.published)).toEqual([true, false, true]);
    });

    it('refuses a website outside the caller’s authority before any transaction opens', async () => {
      const { service, em } = build({ products: { 'p-1': product('p-1') }, pivots: [pivot('p-1', 'store-a')] });

      await expect(service.bulkBranchPublication(SCOPE, ['p-1'], 'store-z', true, actor)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(em.transactional).not.toHaveBeenCalled();
    });

    it('refuses a store the caller may not act on with the same not-found', async () => {
      const narrowed = {
        ...SCOPE,
        allowedStoreIds: ['store-b'],
        storeId: 'store-b',
        role: 'SUPER_ADMIN',
        platform: true,
      };
      const { service, em } = build({ products: { 'p-1': product('p-1') }, pivots: [pivot('p-1', 'store-a')] });

      await expect(service.bulkBranchPublication(narrowed, ['p-1'], 'store-a', true, actor)).rejects.toThrow(
        'Store with ID store-a not found',
      );
      expect(em.transactional).not.toHaveBeenCalled();
    });
  });
});
