import { ConflictException } from '@nestjs/common';
import { PublicationGuardService, LockSetWidenedError } from '../../publication/publication-guard.service';
import { ProductStatus } from '../../catalogue/product-status.enum';
import { storePublicationLock, productFamilyLock, sortLockKeys } from '../../families/advisory-lock.util';

/**
 * The publication invariant's enforcement point.
 *
 * The invariant concerns ABSENT rows — a missing field value — so it cannot be
 * defended by row locks, and the guard's whole job is to make the window in
 * which "absent" is decided a serialized one. These tests pin the two halves
 * separately: that the locks are the ones PostgreSQL will actually take, in the
 * one order everybody uses; and that the required-field predicate refuses
 * exactly the products that can reach a customer.
 */
describe('PublicationGuardService', () => {
  const guard = new PublicationGuardService();

  const emWith = (over: Record<string, any> = {}) => {
    const executed: { sql: string; params: any[] }[] = [];
    const em: any = {
      // The TRANSACTION manager's own execute — pool connections autocommit,
      // so a getConnection()-based lock would not survive its own statement.
      execute: jest.fn(async (sql: string, params: any[]) => {
        executed.push({ sql, params });
        return [];
      }),
      count: jest.fn(async () => 0),
      find: jest.fn(async () => []),
      ...over,
    };
    return { em, executed };
  };

  const product = (over: Record<string, any> = {}) =>
    ({
      id: 'prod-1',
      status: ProductStatus.PUBLISHED,
      archivedAt: null,
      ...over,
    }) as any;

  describe('lock acquisition', () => {
    it('uses the two-int4 overload, with explicit casts', async () => {
      const { em, executed } = emWith();
      await guard.acquire(em, [storePublicationLock('store-a')]);

      expect(executed).toHaveLength(1);
      // Both casts present: without them a numeric parameter could resolve to
      // pg_advisory_xact_lock(bigint), a DIFFERENT lock space, and the (ns,key)
      // ordering would serialize nothing.
      expect(executed[0].sql).toContain('?::int4, ?::int4');
      expect(executed[0].params).toHaveLength(2);
    });

    it('acquires in exactly sortLockKeys order', async () => {
      const { em, executed } = emWith();
      const keys = [productFamilyLock('prod-z'), storePublicationLock('store-b'), storePublicationLock('store-a')];

      const held = await guard.acquire(em, keys);

      const expected = sortLockKeys(keys);
      expect(held).toEqual(expected);
      expect(executed.map((e) => e.params)).toEqual(expected.map((k) => [k.ns, k.key]));
    });

    it('acquires a de-duplicated key once', async () => {
      const { em, executed } = emWith();
      const k = storePublicationLock('store-a');
      await guard.acquire(em, [k, { ...k }]);
      expect(executed).toHaveLength(1);
    });
  });

  describe('phase-two widening', () => {
    const a = storePublicationLock('store-a');
    const b = storePublicationLock('store-b');
    const f = productFamilyLock('prod-1');

    it('proceeds when the re-derived set is identical', () => {
      expect(() => guard.assertNotWidened([a, b, f], [f, b, a])).not.toThrow();
    });

    it('proceeds when the re-derived set narrowed', () => {
      // A store that dropped out just leaves a lock we no longer need.
      expect(() => guard.assertNotWidened([a, b, f], [a, f])).not.toThrow();
    });

    it('throws LockSetWidenedError when a key is not held', () => {
      let thrown: any;
      try {
        guard.assertNotWidened([a, f], [a, b, f]);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(LockSetWidenedError);
      expect(thrown.missing).toEqual([b]);
    });

    it('performs no internal loop: one discovery, one acquisition, one re-derivation', async () => {
      // Drives the real two-phase shape a transaction owner uses. If the guard
      // retried internally, any of these counters would exceed one before the
      // error escaped — and the owner would be retrying inside a transaction
      // that is already doomed.
      const { em, executed } = emWith();
      const discover = jest.fn(() => [a, f]);
      const rederive = jest.fn(() => [a, b, f]); // widened: store-b appeared

      const attempt = async () => {
        const held = await guard.acquire(em, discover());
        guard.assertNotWidened(held, rederive());
      };

      await expect(attempt()).rejects.toBeInstanceOf(LockSetWidenedError);

      expect(discover).toHaveBeenCalledTimes(1);
      expect(rederive).toHaveBeenCalledTimes(1);
      // Exactly the two keys discovery produced — never the widened third.
      expect(executed.map((e) => e.params)).toEqual(sortLockKeys([a, f]).map((k) => [k.ns, k.key]));
    });
  });

  describe('exempt shapes', () => {
    const settingsFor = (rows: any[]) => ({ find: jest.fn(async (entity: any) => (entity ? rows : rows)) });

    it('exempts a DRAFT product', async () => {
      const { em } = emWith(settingsFor([{ id: 'must-not-be-consulted' }]));
      await expect(
        guard.assertPublishable(em, product({ status: ProductStatus.DRAFT }), ['store-a']),
      ).resolves.toBeUndefined();
      expect(em.find).not.toHaveBeenCalled();
    });

    it('exempts an archived product', async () => {
      const { em } = emWith();
      await expect(
        guard.assertPublishable(em, product({ archivedAt: new Date() }), ['store-a']),
      ).resolves.toBeUndefined();
      expect(em.find).not.toHaveBeenCalled();
    });

    it('exempts a family card', async () => {
      const { em } = emWith({ count: jest.fn(async () => 2) });
      await expect(guard.assertPublishable(em, product(), ['store-a'])).resolves.toBeUndefined();
      expect(em.find).not.toHaveBeenCalled();
    });

    it('still treats a product whose only children are archived as a card', async () => {
      // The child count deliberately carries no archivedAt filter, matching the
      // checkout guard. Archiving the last active child does not make the card
      // sellable.
      const { em } = emWith({ count: jest.fn(async () => 1) });
      await guard.assertPublishable(em, product(), ['store-a']);
      expect(em.count).toHaveBeenCalledWith(expect.anything(), { parent: 'prod-1' });
      expect(em.find).not.toHaveBeenCalled();
    });

    it('validates a standalone, active, PUBLISHED product', async () => {
      const { em } = emWith({
        count: jest.fn(async () => 0),
        find: jest.fn(async () => []),
      });
      await expect(guard.assertPublishable(em, product(), ['store-a'])).resolves.toBeUndefined();
      // It DID look: settings were queried rather than skipped.
      expect(em.find).toHaveBeenCalled();
    });

    it('validates only the stores it is given', async () => {
      const { em } = emWith();
      await guard.assertPublishable(em, product(), ['store-b', 'store-a', 'store-b']);
      const where = em.find.mock.calls[0][1];
      expect(where.store.$in.sort()).toEqual(['store-a', 'store-b']);
      expect(where.active).toBe(true);
      expect(where.required).toBe(true);
    });

    it('does nothing when no store is transitioning to published', async () => {
      const { em } = emWith();
      await expect(guard.assertPublishable(em, product(), [])).resolves.toBeUndefined();
      expect(em.count).not.toHaveBeenCalled();
      expect(em.find).not.toHaveBeenCalled();
    });
  });

  describe('refusal payload', () => {
    const setting = (storeId: string, key: string, definitionId = key) => ({
      store: { id: storeId },
      definition: { id: definitionId, key, archivedAt: null },
    });

    const guardWith = (settings: any[], values: any[] = []) =>
      emWith({
        count: jest.fn(async () => 0),
        find: jest.fn(async (entity: any) => {
          const name = typeof entity === 'function' ? entity.name : String(entity);
          return name === 'StoreFieldSetting' ? settings : values;
        }),
      });

    it('reports the FIRST blocking store by ascending id', async () => {
      const { em } = guardWith([setting('store-z', 'color'), setting('store-a', 'size')]);

      const err = await guard.assertPublishable(em, product(), ['store-z', 'store-a']).catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      const body: any = err.getResponse();
      expect(body.storeId).toBe('store-a');
      expect(body.missingFieldKeys).toEqual(['size']);
    });

    it('sorts missing keys, caps at 10, and reports the true total with truncated', async () => {
      const many = Array.from({ length: 14 }, (_, i) => setting('store-a', `f${String(i).padStart(2, '0')}`)).reverse();
      const { em } = guardWith(many);

      const err = await guard.assertPublishable(em, product(), ['store-a']).catch((e) => e);
      const body: any = err.getResponse();

      expect(body.missingFieldKeys).toHaveLength(10);
      expect(body.missingFieldKeys).toEqual([...body.missingFieldKeys].sort());
      expect(body.missingFieldKeys[0]).toBe('f00');
      expect(body.missingFieldCount).toBe(14);
      expect(body.truncated).toBe(true);
    });

    it('reports truncated false when everything fits', async () => {
      const { em } = guardWith([setting('store-a', 'color')]);
      const err = await guard.assertPublishable(em, product(), ['store-a']).catch((e) => e);
      const body: any = err.getResponse();
      expect(body.missingFieldCount).toBe(1);
      expect(body.truncated).toBe(false);
    });

    it('passes when every required field is answered', async () => {
      // Phase 2: the answered set is EFFECTIVE, so each value row must name
      // its owning product — the guard now distinguishes own values from a
      // family model's.
      const { em } = guardWith(
        [setting('store-a', 'color', 'def-color')],
        [{ product: { id: 'prod-1' }, definition: { id: 'def-color' } }],
      );
      await expect(guard.assertPublishable(em, product(), ['store-a'])).resolves.toBeUndefined();
    });

    it('fails CLOSED on a required setting whose definition is archived', async () => {
      // archiveDefinition refuses while a setting is active, so this state
      // cannot arise through the API. Reaching it means direct SQL or a defect,
      // and the requirement is unsatisfiable because the field no longer
      // accepts values. Publishing around it would conceal the corruption.
      const archived = { store: { id: 'store-a' }, definition: { id: 'd1', key: 'legacy', archivedAt: new Date() } };
      const { em } = guardWith([archived]);

      const err = await guard.assertPublishable(em, product(), ['store-a']).catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().missingFieldKeys).toEqual(['legacy']);
    });
  });
});
