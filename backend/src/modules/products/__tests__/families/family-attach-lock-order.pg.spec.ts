import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { Product } from '../../entities/product.entity';
import { ProductFieldDefinition } from '../../entities/product-field-definition.entity';
import { ProductFamilyService } from '../../families/product-family.service';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { ProductsService } from '../../catalogue/products.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import {
  AdvisoryLockKey,
  LOCK_NS_PRODUCT_FAMILY,
  LOCK_NS_STORE_PUBLICATION,
  productFamilyLock,
  storePublicationLock,
} from '../../families/advisory-lock.util';
import { realStock } from '../../../../../test/inventory-stock-support';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const ACTOR = { id: '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e', email: 'owner@example.test' };

/**
 * ATTACHING TAKES ITS KEYS IN THE CANONICAL ORDER (real PostgreSQL).
 *
 * `POST /products/:id/family/members` decides under the two family keys
 * (namespace 2), and the `reconcileStoresOfParent` it runs afterwards acquires
 * a store key (namespace 1) for every branch the card GAINS — which for an
 * attachment is the ordinary case, because giving the card the newcomer's
 * branches is why that call exists. Namespace 1 after namespace 2 is the one
 * order this codebase forbids, and it deadlocks against any writer taking them
 * the other way round: `PUT /products/:id/stores/:storeId` publishing a sibling
 * in that same branch takes the store key FIRST and then the family key.
 *
 * Nothing refused it and nothing detected it: `assertNotWidened` compares the
 * reconciliation's own two derivations, never the outer transaction's held set.
 * `withLockRetry` does not rescue it either — only a widening retries — so an
 * ordinary attachment surfaced as a 500.
 *
 * These tests are about the ORDER and the deadlock, not about visibility: the
 * attachment rules themselves are a separate change.
 */
d('attaching takes its locks in the canonical order (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;

  const uid = (label: string) => `${label}-${Math.random().toString(16).slice(2, 10)}`;
  const sql = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => em.execute(text, params);

  /**
   * THE LOCK-ORDER ASSERTION, AND IT LIVES ONLY HERE.
   *
   * Deliberately a test-only check, not a precondition in the guard. In
   * production an unnamed key only bites when a specific concurrent writer
   * exists, so the deadlock is occasional; a runtime assertion would instead
   * fail EVERY call on any path that has not named its keys — including
   * removal-restore and `removeMember`, which have not been changed. Turning
   * the rule into a runtime precondition is a separate decision that belongs
   * after those paths name their keys, not before.
   */
  const orderingGuard = () => {
    const guard = new PublicationGuardService();
    const original = guard.acquire.bind(guard);
    const taken: AdvisoryLockKey[] = [];
    /**
     * Keys this transaction already holds. Advisory keys are transaction-scoped
     * and re-entrant, so re-acquiring one is free and harmless — what must never
     * happen is acquiring a store key it does NOT yet hold once a family key is
     * held. `firstStore < firstFamily` cannot see that: it only answers "was a
     * store key the first key taken", so a change that named one branch and
     * missed a second would keep passing. This tracks the held set instead.
     */
    let held = new Set<string>();
    const violations: string[] = [];
    let holdsFamily = false;
    /*
     * PER ATTEMPT, not per call. Advisory keys are transaction-scoped, and
     * `withLockRetry` runs each attempt in a FRESH transaction that holds
     * nothing — so carrying the previous attempt's set forward would judge a
     * re-acquired key "already held" and drop a genuine violation, with
     * `holdsFamily` arriving stale as well. Resetting inside the retry wrapper
     * is the only place that sees an attempt boundary: `acquire` alone cannot
     * tell one transaction from the next.
     */
    const originalRetry = guard.withLockRetry.bind(guard);
    (guard as unknown as { withLockRetry: unknown }).withLockRetry = <T>(operation: () => Promise<T>) =>
      originalRetry(async () => {
        held = new Set<string>();
        holdsFamily = false;
        return operation();
      });
    (guard as unknown as { acquire: unknown }).acquire = async (tem: EntityManager, keys: AdvisoryLockKey[]) => {
      const ordered = await original(tem, keys);
      for (const key of ordered) {
        const id = `${key.ns}:${key.key}`;
        const isNew = !held.has(id);
        if (isNew && key.ns === LOCK_NS_STORE_PUBLICATION && holdsFamily) {
          violations.push(`store key ${key.key} acquired while a family key was already held`);
        }
        held.add(id);
        if (key.ns === LOCK_NS_PRODUCT_FAMILY) holdsFamily = true;
      }
      taken.push(...ordered);
      return ordered;
    };
    const assertCanonicalOrder = () => {
      // No unheld namespace-1 key may be taken once namespace 2 is held.
      expect(violations).toEqual([]);
      // And the scenario must actually exercise both kinds, or it proves nothing.
      expect(taken.some((k) => k.ns === LOCK_NS_STORE_PUBLICATION)).toBe(true);
      expect(taken.some((k) => k.ns === LOCK_NS_PRODUCT_FAMILY)).toBe(true);
      const firstStore = taken.findIndex((k) => k.ns === LOCK_NS_STORE_PUBLICATION);
      const firstFamily = taken.findIndex((k) => k.ns === LOCK_NS_PRODUCT_FAMILY);
      expect(firstStore).toBeLessThan(firstFamily);
    };
    return { guard, taken, assertCanonicalOrder };
  };

  const servicesOn = (fork: EntityManager, supplied?: PublicationGuardService) => {
    const guard = supplied ?? new PublicationGuardService();
    const audit = { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never };
    const fields = new ProductFieldsService(fork.getRepository(ProductFieldDefinition) as any, fork as any, guard);
    return {
      family: new ProductFamilyService(fork.getRepository(Product) as any, audit as any, guard),
      products: new ProductsService(
        fork.getRepository(Product) as any,
        fork.getRepository(Product) as any,
        { findById: async () => undefined } as any,
        audit as any,
        { learnFromAcceptedGroup: async () => undefined } as any,
        guard,
        fields,
        realStock(fork as any),
      ),
    };
  };

  const seed = async () => {
    const slug = uid('org');
    const [org] = await sql<{ id: string }>(
      `insert into organizations (name, slug, created_at, updated_at) values (?, ?, now(), now()) returning id`,
      [slug, slug],
    );
    const store = async (label: string) => {
      const name = uid(label);
      const [row] = await sql<{ id: string }>(
        `insert into stores (name, slug, organization_id, created_at, updated_at)
         values (?, ?, ?::uuid, now(), now()) returning id`,
        [name, name, org.id],
      );
      return { id: row.id, name };
    };
    const product = async (label: string, links: { storeId: string; published: boolean }[]) => {
      const name = uid(label);
      const [row] = await sql<{ id: string }>(
        `insert into products (name, slug, organization_id, status, price, track_inventory, created_at, updated_at)
         values (?, ?, ?::uuid, 'PUBLISHED', 10, false, now(), now()) returning id`,
        [name, name, org.id],
      );
      for (const link of links) {
        await sql(
          `insert into store_products
             (organization_id, store_id, product_id, published, track_inventory, created_at, updated_at)
           values (?::uuid, ?::uuid, ?::uuid, ?, false, now(), now())`,
          [org.id, link.storeId, row.id, link.published],
        );
      }
      return { id: row.id, name };
    };
    return { organizationId: org.id, store, product };
  };

  const pivot = async (productId: string, storeId: string) => {
    const [row] = await sql<{ published: boolean }>(
      `select published from store_products where product_id = ?::uuid and store_id = ?::uuid`,
      [productId, storeId],
    );
    return row ?? null;
  };
  const parentOf = async (productId: string): Promise<string | null> => {
    const [row] = await sql<{ parent_id: string | null }>(`select parent_id from products where id = ?::uuid`, [
      productId,
    ]);
    return row?.parent_id ?? null;
  };

  /**
   * A card with one existing child, and a standalone item carrying a branch the
   * card does NOT have — so attaching it makes the card gain that branch, which
   * is what needs the store key.
   */
  const promotionShape = async () => {
    const s = await seed();
    const home = await s.store('home');
    const x = await s.store('x');
    const card = await s.product('card', [{ storeId: home.id, published: true }]);
    // The existing child holds ONLY `home`. That is what makes the newcomer the
    // sole reason the card gains `x`, so the store key can be named only from
    // the member's own branches — the one mechanism this change adds. An
    // earlier version of this fixture also gave the sibling a pivot in `x`,
    // which meant the sibling-union half already named the key and every test
    // here passed with the member's branches dropped entirely.
    const sibling = await s.product('sibling', [{ storeId: home.id, published: true }]);
    await sql(`update products set parent_id = ?::uuid, option_label = 'Uno' where id = ?::uuid`, [
      card.id,
      sibling.id,
    ]);
    const incoming = await s.product('incoming', [{ storeId: x.id, published: true }]);
    return { s, home, x, card, sibling, incoming };
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  it('takes the store key BEFORE the family key when the card gains a branch', async () => {
    const { x, card, incoming } = await promotionShape();
    const watcher = orderingGuard();

    await servicesOn(pg.orm.em.fork() as EntityManager, watcher.guard).family.addMember(
      card.id,
      { productId: incoming.id, label: 'Dos' } as any,
      ACTOR as any,
    );

    watcher.assertCanonicalOrder();
    expect(await parentOf(incoming.id)).toBe(card.id);
    // The card really did gain the branch — otherwise no store key was needed
    // and the ordering assertion proves nothing about this scenario.
    expect((await pivot(card.id, x.id))?.published).toBe(true);
  });

  it('does not deadlock against a branch publication in the same branch', async () => {
    const { x, card, sibling, incoming } = await promotionShape();

    /*
     * Deterministic: hold the attachment right after it has acquired its keys,
     * then start the branch publication, which takes the store key first and
     * then the card's family key. Releasing the attachment closes the cycle if
     * one exists.
     *
     * Against the base this reports `deadlock detected`, because the attachment
     * holds only the two family keys and then asks for the store key the
     * publication already has.
     */
    const holder = new PublicationGuardService();
    const original = holder.acquire.bind(holder);
    let signalAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => (signalAcquired = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    (holder as unknown as { acquire: unknown }).acquire = async (tem: EntityManager, keys: AdvisoryLockKey[]) => {
      const ordered = await original(tem, keys);
      if (first) {
        first = false;
        signalAcquired();
        await gate;
      }
      return ordered;
    };

    const attach = servicesOn(pg.orm.em.fork() as EntityManager, holder)
      .family.addMember(card.id, { productId: incoming.id, label: 'Dos' } as any, ACTOR as any)
      .then(
        () => 'ok' as const,
        (err: any) => `failed: ${String(err?.message)}`,
      );
    /*
     * Wait for the pause, but not only for the pause. If the attachment ever
     * fails BEFORE its first `acquire` — a tenancy or eligibility refusal after
     * some future rule change — `signalAcquired` is never called, and its
     * rejection is already absorbed by the handler above. Awaiting the pause
     * alone would then park until jest's 300 s timeout and report nothing
     * useful. Racing the two surfaces the real error immediately.
     */
    const early = await Promise.race([
      acquired.then(() => null),
      attach.then((outcome) => `the attachment settled before pausing: ${outcome}`),
    ]);
    if (early) throw new Error(early);

    const publish = servicesOn(pg.orm.em.fork() as EntityManager)
      .products.assignToStore(sibling.id, x.id, { published: true } as any, ACTOR as any)
      .then(
        () => 'ok' as const,
        (err: any) => `failed: ${String(err?.message)}`,
      );

    /*
     * Wait until PostgreSQL itself reports the publication BLOCKED on one of
     * the two keys this scenario turns on, rather than sleeping and hoping. A
     * sleep fails in the false-pass direction: if the publication had not
     * reached its wait, releasing the attachment lets both finish and the test
     * goes green even against a base that deadlocks.
     *
     * BOTH keys, because which one it blocks on is exactly what this change
     * alters. With the store key named up front the attachment holds it and the
     * publication waits there; without it the publication takes the store key
     * freely and waits on the card's family key instead. Polling only the store
     * key would time out in the second world and prove nothing about it.
     *
     * Pinned to those two keys and to a backend other than this reader's own,
     * so no unrelated advisory waiter anywhere in the cluster can satisfy it.
     */
    const asOid = (key: number) => (key < 0 ? key + 2 ** 32 : key);
    const watched = [storePublicationLock(x.id), productFamilyLock(card.id)];
    let blocked = false;
    try {
      for (let i = 0; i < 100 && !blocked; i += 1) {
        const [row] = await sql<{ n: number }>(
          `select count(*)::int n
             from pg_locks
            where locktype = 'advisory'
              and not granted
              and pid <> pg_backend_pid()
              and (classid, objid) in ((?::oid, ?::oid), (?::oid, ?::oid))`,
          [watched[0].ns, asOid(watched[0].key), watched[1].ns, asOid(watched[1].key)],
        );
        blocked = row.n > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      // ALWAYS release, even if the poll loop itself threw. Leaving the
      // attachment parked on its gate would wedge the whole run instead of
      // reporting one failure — which is exactly what happened before this
      // `finally` existed. The assertion deliberately sits AFTER the block, so
      // the release is never skipped by a failing expectation.
      release();
    }
    // Without this the test would prove nothing about a deadlock, so it fails
    // here rather than passing for the wrong reason.
    expect(blocked).toBe(true);

    expect(await attach).toBe('ok');
    expect(await publish).toBe('ok');
    expect(await parentOf(incoming.id)).toBe(card.id);
    expect((await pivot(sibling.id, x.id))?.published).toBe(true);
  });

  it('names a branch only an EXISTING sibling holds, which the newcomer does not', async () => {
    /*
     * The other half of `storesToGain`. Here the newcomer brings nothing new,
     * and the branch the card gains comes from a sibling that already had it —
     * committed drift, which `reconcileStoresOfParent` repairs whether or not
     * this attachment caused it. Legacy rows predating the derived-membership
     * reconciliation look like this, and so does a pivot created through the
     * unlocked price-only window this change documents but does not close.
     *
     * Without it the sibling-union half of `storesToGain` could be deleted with
     * the suite still green, which is how the previous fixture hid the member
     * half.
     */
    const s = await seed();
    const home = await s.store('home');
    const drift = await s.store('drift');
    const card = await s.product('card', [{ storeId: home.id, published: true }]);
    // The sibling serves a branch the card does not list in — the drift.
    const sibling = await s.product('sibling', [
      { storeId: home.id, published: true },
      { storeId: drift.id, published: true },
    ]);
    await sql(`update products set parent_id = ?::uuid, option_label = 'Uno' where id = ?::uuid`, [
      card.id,
      sibling.id,
    ]);
    // The newcomer brings only a branch the card already has.
    const incoming = await s.product('incoming', [{ storeId: home.id, published: true }]);

    const watcher = orderingGuard();
    await servicesOn(pg.orm.em.fork() as EntityManager, watcher.guard).family.addMember(
      card.id,
      { productId: incoming.id, label: 'Dos' } as any,
      ACTOR as any,
    );

    watcher.assertCanonicalOrder();
    expect(await parentOf(incoming.id)).toBe(card.id);
    // The drift really was repaired, so a store key really was needed.
    expect((await pivot(card.id, drift.id))?.published).toBe(true);
  });

  it('still attaches normally when the card already holds every branch', async () => {
    const s = await seed();
    const home = await s.store('home');
    const card = await s.product('card', [{ storeId: home.id, published: true }]);
    const sibling = await s.product('sibling', [{ storeId: home.id, published: true }]);
    await sql(`update products set parent_id = ?::uuid, option_label = 'Uno' where id = ?::uuid`, [
      card.id,
      sibling.id,
    ]);
    const incoming = await s.product('incoming', [{ storeId: home.id, published: true }]);

    // Nothing is gained, so no store key is needed and none is taken; the
    // attachment must still work.
    await servicesOn(pg.orm.em.fork() as EntityManager).family.addMember(
      card.id,
      { productId: incoming.id, label: 'Dos' } as any,
      ACTOR as any,
    );

    expect(await parentOf(incoming.id)).toBe(card.id);
  });
});
