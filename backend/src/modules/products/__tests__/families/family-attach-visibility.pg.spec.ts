import { EntityManager } from '@mikro-orm/postgresql';
import { LockMode } from '@mikro-orm/core';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { Product } from '../../entities/product.entity';
import { productFamilyLock, storePublicationLock } from '../../families/advisory-lock.util';
import { ProductFieldDefinition } from '../../entities/product-field-definition.entity';
import { ProductFamilyService } from '../../families/product-family.service';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { ProductsService } from '../../catalogue/products.service';
import { PublicationGuardService, isLockNotAvailable } from '../../publication/publication-guard.service';
import { realStock } from '../../../../../test/inventory-stock-support';
import { createLocation } from '../../../../../test/inventory-fixtures';
import { RaceRecorder, gateOf, within } from '../../../../../test/lock-race-support';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const ACTOR = { id: '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e', email: 'owner@example.test' };

/**
 * ATTACHING MUST NOT TAKE A LIVE ITEM OFF THE WEBSITE (real PostgreSQL).
 *
 * A child never lists on its own, so attaching hands its visibility to the
 * parent. Two ways the parent can fail to carry it, and the second is the
 * quiet one: both products Published, but the card HIDDEN in a branch the
 * child was visible in. `reconcileStoresOfParent` does not fix that — a store
 * the parent already holds keeps whatever publication it had.
 *
 * Driven against real rows because the rule is about rows: which pivots exist,
 * which are published, and what a concurrent writer can do to them mid-flight.
 */
d('attaching keeps a live child visible (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let family: ProductFamilyService;
  let products: ProductsService;

  const uid = (label: string) => `${label}-${Math.random().toString(16).slice(2, 10)}`;
  const sql = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => em.execute(text, params);

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
    /** A product, with one pivot per named store at the publication asked for. */
    const product = async (
      label: string,
      links: { storeId: string; published: boolean }[],
      status: 'PUBLISHED' | 'DRAFT' = 'PUBLISHED',
      trackInventory = false,
    ) => {
      const name = uid(label);
      const [row] = await sql<{ id: string }>(
        `insert into products (name, slug, organization_id, status, price, track_inventory, created_at, updated_at)
         values (?, ?, ?::uuid, ?, 10, ?, now(), now()) returning id`,
        [name, name, org.id, status, trackInventory],
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
    /** A parent must already have a child to be a parent at all. */
    const parentWithChild = async (
      label: string,
      links: { storeId: string; published: boolean }[],
      status: 'PUBLISHED' | 'DRAFT' = 'PUBLISHED',
    ) => {
      const card = await product(label, links, status);
      const first = await product(`${label}-first`, links, status);
      await sql(`update products set parent_id = ?::uuid, option_label = 'Uno' where id = ?::uuid`, [
        card.id,
        first.id,
      ]);
      return card;
    };
    return { organizationId: org.id, store, product, parentWithChild };
  };

  const parentOf = async (productId: string): Promise<string | null> => {
    const [row] = await sql<{ parent_id: string | null }>(`select parent_id from products where id = ?::uuid`, [
      productId,
    ]);
    return row?.parent_id ?? null;
  };

  const pivot = async (productId: string, storeId: string) => {
    const [row] = await sql<{ published: boolean }>(
      `select published from store_products where product_id = ?::uuid and store_id = ?::uuid`,
      [productId, storeId],
    );
    return row ?? null;
  };

  /** Every branch a product holds a pivot in, by the label the test gave the store, removed or not. */
  const branchesOf = async (productId: string, stores: Record<string, string>) => {
    const rows = await sql<{ store_id: string }>(`select store_id from store_products where product_id = ?::uuid`, [
      productId,
    ]);
    const label = (id: string) => Object.entries(stores).find(([, value]) => value === id)?.[0] ?? id;
    return rows.map((row) => label(row.store_id)).sort();
  };

  /** Attempts, rollbacks, and whether anything was written before a rollback. */
  const attemptsOf = (race: RaceRecorder, actor: string) => {
    const sequence = race.sequenceOf(actor);
    const begins = sequence.filter((label) => label === 'BEGIN').length;
    const rollbacks = sequence.filter((label) => label === 'ROLLBACK').length;
    let writtenBeforeRollback = 0;
    let writes = 0;
    for (const label of sequence) {
      if (label === 'BEGIN') writes = 0;
      else if (/^(INSERT|UPDATE|DELETE) /.test(label)) writes += 1;
      else if (label === 'ROLLBACK') writtenBeforeRollback += writes;
    }
    return { begins, rollbacks, writtenBeforeRollback };
  };

  /**
   * An actor's transactions, told apart by what they are: an ATTEMPT takes
   * advisory keys; a WAIT between attempts takes none, and is held to one row
   * lock and nothing else (`ProductFamilyService.waitForRows`). Counting BEGINs
   * could not tell one wait over two rows — the shape that deadlocked — from
   * two waits over one row each.
   */
  const transactionsOf = (race: RaceRecorder, actor: string) => {
    const all: string[][] = [];
    let current: string[] | null = null;
    for (const label of race.sequenceOf(actor)) {
      if (label === 'BEGIN') {
        current = [];
        all.push(current);
      } else if (current) {
        current.push(label);
      }
    }
    const isAttempt = (tx: string[]) => tx.some((label) => label.startsWith('ADVISORY '));
    const attempts = all.filter(isAttempt);
    const rolledBack = attempts.filter((tx) => tx.includes('ROLLBACK'));
    return {
      attempts: attempts.length,
      rolledBack: rolledBack.length,
      writtenBeforeRollback: rolledBack.reduce(
        (n, tx) => n + tx.filter((label) => /^(INSERT|UPDATE|DELETE) /.test(label)).length,
        0,
      ),
      waits: all
        .filter((tx) => !isAttempt(tx))
        .map((tx) => tx.filter((label) => label.startsWith('ROW LOCK ') || /^(INSERT|UPDATE|DELETE) /.test(label))),
    };
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    const guard = new PublicationGuardService();
    family = new ProductFamilyService(
      em.getRepository(Product) as any,
      { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
      guard,
    );
    const fields = new ProductFieldsService(em.getRepository(ProductFieldDefinition) as any, em as any, guard);
    products = new ProductsService(
      em.getRepository(Product) as any,
      em.getRepository(Product) as any,
      { findById: async () => undefined } as any,
      { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
      { learnFromAcceptedGroup: async () => undefined } as any,
      guard,
      fields,
      realStock(em as any),
    );
  });

  /** Services bound to their OWN fork, so two of them can run at once. */
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

  afterAll(async () => {
    if (pg) await pg.close();
  });

  describe('the branch rule', () => {
    it('refuses when the parent is HIDDEN in a branch the child is published in, and writes nothing', async () => {
      const s = await seed();
      const centro = await s.store('centro');
      // The card exists in Centro but is hidden there; the child is visible there.
      const card = await s.parentWithChild('alioli', [{ storeId: centro.id, published: false }]);
      const child = await s.product('pequena', [{ storeId: centro.id, published: true }]);

      await expect(
        family.addMember(card.id, { productId: child.id, label: 'Pequeña' } as any, ACTOR as any),
      ).rejects.toThrow(new RegExp(`hidden in "${centro.name}"`));

      // Refused BEFORE any write: the child is still standalone.
      expect(await parentOf(child.id)).toBeNull();
    });

    it('allows when the parent does not hold that branch at all — the new pivot is born published', async () => {
      const s = await seed();
      const centro = await s.store('centro');
      const chacao = await s.store('chacao');
      // The card lives in Chacao only; the child is published in Centro.
      const card = await s.parentWithChild('alioli', [{ storeId: chacao.id, published: true }]);
      const child = await s.product('pequena', [{ storeId: centro.id, published: true }]);

      await family.addMember(card.id, { productId: child.id, label: 'Pequeña' } as any, ACTOR as any);

      expect(await parentOf(child.id)).toBe(card.id);
      // reconcileStoresOfParent widened the card into Centro, published.
      expect((await pivot(card.id, centro.id))?.published).toBe(true);
    });

    it('allows when the child is attached but HIDDEN in that branch: it was showing nothing there', async () => {
      const s = await seed();
      const centro = await s.store('centro');
      const card = await s.parentWithChild('alioli', [{ storeId: centro.id, published: false }]);
      const child = await s.product('pequena', [{ storeId: centro.id, published: false }]);

      await family.addMember(card.id, { productId: child.id, label: 'Pequeña' } as any, ACTOR as any);
      expect(await parentOf(child.id)).toBe(card.id);
    });
  });

  describe('the company-wide rule', () => {
    it('refuses a published child under a draft parent', async () => {
      const s = await seed();
      const centro = await s.store('centro');
      const card = await s.parentWithChild('alioli', [{ storeId: centro.id, published: true }], 'DRAFT');
      const child = await s.product('pequena', [{ storeId: centro.id, published: true }]);

      await expect(
        family.addMember(card.id, { productId: child.id, label: 'Pequeña' } as any, ACTOR as any),
      ).rejects.toThrow(/would remove it from the website/);
      expect(await parentOf(child.id)).toBeNull();
    });

    it('allows a draft child under a draft parent: the ordinary way a family is assembled', async () => {
      const s = await seed();
      const centro = await s.store('centro');
      const card = await s.parentWithChild('alioli', [{ storeId: centro.id, published: true }], 'DRAFT');
      const child = await s.product('pequena', [{ storeId: centro.id, published: true }], 'DRAFT');

      await family.addMember(card.id, { productId: child.id, label: 'Pequeña' } as any, ACTOR as any);
      expect(await parentOf(child.id)).toBe(card.id);
    });
  });

  /**
   * THE CARD'S OWN STATE, RACED.
   *
   * The company-wide rule reads `status` and `archived_at` on the card. Nothing
   * in the advisory protocol covers those: `PATCH /products/:id { status }`
   * reaches `applyGuardedPublication` only when membership changes or the
   * product becomes published, so drafting a card takes no key, and `archive`
   * is not even transactional.
   *
   * Each case pauses the attachment after it has loaded the card and BEFORE it
   * takes its row locks, lets the owner's change commit, and then releases. The
   * attachment must decide on what is true at that point, not on what it read
   * first. Against the previous head both cases leave a live child behind a
   * card nobody can see.
   */
  describe("the card's own state changing underneath the attachment", () => {
    const pausedAttach = async (
      parentId: string,
      childId: string,
      interleave: () => Promise<void>,
    ): Promise<string> => {
      /*
       * The pause point is on the GUARD, not on this change's own method:
       * `assertMembersAttachable` is the last call `addMember` makes before the
       * visibility rules, and it exists on `develop` too. So the same test runs
       * against the code before this change and shows the OUTCOME differ, rather
       * than failing there with a harness error.
       *
       * At the pause the family keys are held and no row is locked yet.
       */
      const guard = new PublicationGuardService();
      const attacher = servicesOn(pg.orm.em.fork() as EntityManager, guard).family;
      const original = guard.assertMembersAttachable.bind(guard);
      let signal!: () => void;
      const reached = new Promise<void>((resolve) => (signal = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      guard.assertMembersAttachable = async (...args: Parameters<typeof original>) => {
        signal();
        await gate;
        return original(...args);
      };

      const attach = attacher.addMember(parentId, { productId: childId, label: 'Pequeña' } as any, ACTOR as any).then(
        () => 'attached' as const,
        (err: any) => `refused: ${String(err?.message)}`,
      );
      // Do not wait on the pause alone: a failure before it would park here.
      const early = await Promise.race([
        reached.then(() => null),
        attach.then((outcome) => `settled before pausing: ${outcome}`),
      ]);
      if (early) throw new Error(early);

      try {
        await interleave();
      } finally {
        release();
      }
      return attach;
    };

    it('refuses when the card is DRAFTED while the attachment is deciding', async () => {
      const s = await seed();
      const centro = await s.store('centro');
      const card = await s.parentWithChild('alioli', [{ storeId: centro.id, published: true }]);
      const child = await s.product('pequena', [{ storeId: centro.id, published: true }]);

      const outcome = await pausedAttach(card.id, child.id, async () => {
        await sql(`update products set status = 'DRAFT' where id = ?::uuid`, [card.id]);
      });

      expect(outcome).toMatch(/refused: .*is draft/);
      // THE INVARIANT: no live child left behind a card nobody can see.
      expect(await parentOf(child.id)).toBeNull();
    });

    it('refuses when the card is ARCHIVED while the attachment is deciding', async () => {
      const s = await seed();
      const centro = await s.store('centro');
      const card = await s.parentWithChild('alioli', [{ storeId: centro.id, published: true }]);
      const child = await s.product('pequena', [{ storeId: centro.id, published: true }]);

      const outcome = await pausedAttach(card.id, child.id, async () => {
        await sql(`update products set archived_at = now() where id = ?::uuid`, [card.id]);
      });

      expect(outcome).toMatch(/refused: .*is archived/);
      expect(await parentOf(child.id)).toBeNull();
    });

    it('still attaches when nothing changes underneath it', async () => {
      const s = await seed();
      const centro = await s.store('centro');
      const card = await s.parentWithChild('alioli', [{ storeId: centro.id, published: true }]);
      const child = await s.product('pequena', [{ storeId: centro.id, published: true }]);

      const outcome = await pausedAttach(card.id, child.id, async () => undefined);

      expect(outcome).toBe('attached');
      expect(await parentOf(child.id)).toBe(card.id);
    });
  });

  /**
   * WHAT THE ROW LOCKS BUY — PROVED THROUGH THE SERVICE, NOT AROUND IT.
   *
   * An earlier version of this block asserted that `FOR SHARE` blocks an
   * UPDATE and `FOR KEY SHARE` does not. True, but it proved a fact about
   * PostgreSQL rather than a fact about `addMember`: it would have kept passing
   * if the service stopped taking the lock altogether.
   *
   * These drive the real service, and each holds a CONFLICTING lock from a
   * second transaction so that "waits" is observed rather than assumed. Two
   * rows are locked, and each guards a different half of the rule:
   *
   *   - the PIVOTS, against a writer that holds no family key for the
   *     member — the plan-based import runner, for a product that is and
   *     stays a standalone. Since #333 every membership edit behind the API
   *     takes the family key before it writes. The lock makes such a writer
   *     WAIT for the attachment; it does not decide what it does once the
   *     attachment has committed;
   *   - the card's own PRODUCT ROW, against `PATCH /products/:id { status }`,
   *     `bulkStatus` to draft and `archive`, which take no advisory key at all.
   *
   * The second is the one a plain `refresh: true` re-read would not buy: the
   * DRAFTED/ARCHIVED races above commit before the read and so pass without
   * any lock. Only holding the row from another transaction proves the lock
   * is taken.
   */
  describe('the row lock, through the service', () => {
    it("addMember WAITS for a conflicting lock on the card's own product row", async () => {
      const s = await seed();
      const centro = await s.store('centro');
      const card = await s.parentWithChild('alioli', [{ storeId: centro.id, published: true }]);
      const child = await s.product('pequena', [{ storeId: centro.id, published: true }]);

      const holder = pg.orm.em.fork() as EntityManager;
      await holder.begin();
      // The CARD's row, deliberately — not the member's: the attachment waits
      // on the member's row anyway when it flushes `parent_id`. And an
      // UNCOMMITTED UPDATE, deliberately — not `FOR UPDATE`: this is the lock a
      // concurrent `PATCH /products/:id { status }` really holds, FOR NO KEY
      // UPDATE, and it is the one that discriminates. `FOR UPDATE` would block
      // the attachment even without the pessimistic read, because writing
      // `parent_id` takes FOR KEY SHARE on the referenced card row; FOR NO KEY
      // UPDATE does not conflict with that, only with the FOR SHARE the
      // service asks for. Drop `LockMode.PESSIMISTIC_READ` from
      // `lockedFamilyVisibility` and this attachment completes straight
      // through the holder.
      await holder.execute(`update products set status = 'DRAFT' where id = ?::uuid`, [card.id]);

      const attach = servicesOn(pg.orm.em.fork() as EntityManager)
        .family.addMember(card.id, { productId: child.id, label: 'Pequeña' } as any, ACTOR as any)
        .then(() => 'completed' as const);
      const pending = Symbol('pending');
      let raced: unknown;
      try {
        raced = await Promise.race([
          attach,
          new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 2_000)),
        ]);
      } finally {
        await holder.rollback();
      }
      // Still pending after two seconds: it is waiting on the card's row, which
      // it could only be doing if it asked for the lock.
      expect(raced).toBe(pending);
      await expect(attach).resolves.toBe('completed');
      expect(await parentOf(child.id)).toBe(card.id);
    });

    it('addMember WAITS for a conflicting lock on the pivots it must read', async () => {
      const s = await seed();
      const centro = await s.store('centro');
      const card = await s.parentWithChild('alioli', [{ storeId: centro.id, published: true }]);
      const child = await s.product('pequena', [{ storeId: centro.id, published: true }]);

      const holder = pg.orm.em.fork() as EntityManager;
      await holder.begin();
      // A conflicting lock on the card's pivot — the row the branch check reads.
      await holder.execute(`select 1 from store_products where product_id = ?::uuid for update`, [card.id]);

      const attach = servicesOn(pg.orm.em.fork() as EntityManager)
        .family.addMember(card.id, { productId: child.id, label: 'Pequeña' } as any, ACTOR as any)
        .then(() => 'completed' as const);
      const pending = Symbol('pending');
      let raced: unknown;
      try {
        raced = await Promise.race([
          attach,
          new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 2_000)),
        ]);
      } finally {
        // ALWAYS roll the holder back. A failed assertion used to leave this
        // connection `idle in transaction` holding `FOR UPDATE`, so `pg.close()`
        // blocked draining the pool and the real failure was buried under a
        // hook timeout minutes later.
        await holder.rollback();
      }
      // Still pending after two seconds: it is waiting on the row, which it
      // could only be doing if it asked for the lock.
      expect(raced).toBe(pending);
      await expect(attach).resolves.toBe('completed');
      expect(await parentOf(child.id)).toBe(card.id);
    });

    it('and does not wait on rows of an unrelated product', async () => {
      const s = await seed();
      const centro = await s.store('centro');
      const card = await s.parentWithChild('alioli', [{ storeId: centro.id, published: true }]);
      const child = await s.product('pequena', [{ storeId: centro.id, published: true }]);
      const bystander = await s.product('otro', [{ storeId: centro.id, published: true }]);

      const holder = pg.orm.em.fork() as EntityManager;
      await holder.begin();
      await holder.execute(`select 1 from store_products where product_id = ?::uuid for update`, [bystander.id]);
      try {
        // No contention: this must finish without waiting for the holder.
        await servicesOn(pg.orm.em.fork() as EntityManager).family.addMember(
          card.id,
          { productId: child.id, label: 'Pequeña' } as any,
          ACTOR as any,
        );
        expect(await parentOf(child.id)).toBe(card.id);
      } finally {
        await holder.rollback();
      }
    });
  });

  /**
   * A BRANCH WRITE ON A PRODUCT THAT IS BEING PROMOTED TO A CARD.
   *
   * `addMember` accepts a parent with no children yet and holds that product's
   * family key while it promotes it. The single-branch PUT used to decide
   * "is this a card?" by counting children with no lock at all whenever the
   * body published nothing — so a `{ price }` or `{ published: false }` PUT on
   * the soon-to-be card, landing between the attachment's branch read and its
   * commit, created or hid the card's pivot in a branch where the incoming
   * child was already published. Neither write alone permits that end state.
   *
   * Deterministic, not timing-based: the attachment is paused immediately
   * after its branch read, the PUT is started on its own connection, and the
   * test waits until PostgreSQL itself reports that PUT as waiting on an
   * advisory lock before letting the attachment commit.
   */
  describe('a branch write racing the promotion of its product', () => {
    /**
     * True once SOMEBODY ELSE is waiting on exactly the attachment's family
     * key.
     *
     * Not "some advisory lock somewhere": PostgreSQL reports every advisory
     * wait in the cluster, so a bare count would go true for an unrelated
     * waiter and the `waited` assertion these cases rest on would stop proving
     * anything. The key is pinned to `productFamilyLock(parentId)`, and the
     * holder's own backend is excluded, so only the write under test can
     * satisfy it.
     *
     * `pg_advisory_xact_lock(ns, key)` with two int4s lands in `pg_locks` as
     * classid = ns and objid = key, read as unsigned — the same two-argument
     * form `acquire` uses.
     */
    const waiterOnFamilyKey = async (parentId: string) => {
      const wanted = productFamilyLock(parentId);
      // `pg_locks` reports classid/objid as oids, which are UNSIGNED; the key
      // is a signed int4, so a negative one is the same bits read the other
      // way round.
      const unsigned = wanted.key < 0 ? wanted.key + 2 ** 32 : wanted.key;
      const [row] = await sql<{ n: number }>(
        `select count(*)::int n
           from pg_locks
          where locktype = 'advisory'
            and not granted
            and classid = ?::oid
            and objid = ?::oid
            and pid <> pg_backend_pid()`,
        [wanted.ns, unsigned],
      );
      return row.n > 0;
    };

    const race = async (parentId: string, childId: string, storeId: string, body: Record<string, unknown>) => {
      // The pause point is on the guard, as above: the family keys are held,
      // the rules have not run. It exists on `develop` too, so this runs there.
      const guard = new PublicationGuardService();
      const attacher = servicesOn(pg.orm.em.fork() as EntityManager, guard).family;
      const original = guard.assertMembersAttachable.bind(guard);
      let signalRead!: () => void;
      const branchReadDone = new Promise<void>((resolve) => (signalRead = resolve));
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      guard.assertMembersAttachable = async (...args: Parameters<typeof original>) => {
        signalRead();
        await gate;
        return original(...args);
      };

      // Settled either way, so a rejection before the pause is a value we can
      // race on rather than an unhandled rejection under a hang.
      const attach = attacher.addMember(parentId, { productId: childId, label: 'Pequeña' } as any, ACTOR as any).then(
        () => null,
        (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
      );
      // Wait for the pause, but not only for the pause: if the attachment fails
      // BEFORE reaching it, the signal never fires and this would park until
      // jest's timeout with the real error hidden. Racing the two reports it.
      const early = await Promise.race([
        branchReadDone.then(() => null),
        attach.then((outcome) => `the attachment settled before pausing: ${outcome ? outcome.message : 'attached'}`),
      ]);
      if (early) throw new Error(early);

      const put = servicesOn(pg.orm.em.fork() as EntityManager)
        .products.assignToStore(parentId, storeId, body as any, ACTOR as any)
        .then(
          () => ({ ok: true as const, message: '' }),
          (err: any) => ({ ok: false as const, message: String(err?.message) }),
        );

      // The PUT must be WAITING on the attachment's family key, not finished.
      let waited = false;
      try {
        for (let i = 0; i < 100 && !waited; i += 1) {
          waited = await waiterOnFamilyKey(parentId);
          if (!waited) await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } finally {
        // ALWAYS release: a throwing poll must not leave the attachment parked
        // on its gate with its transaction open.
        release();
      }
      const failure = await attach;
      if (failure) throw failure;
      return { waited, put: await put };
    };

    const promotionState = async () => {
      const s = await seed();
      const centro = await s.store('centro');
      const chacao = await s.store('chacao');
      // A standalone product with no children yet — attachment will make it a
      // card — and a live item published in BOTH branches.
      const parent = await s.product('alioli', [{ storeId: centro.id, published: true }]);
      const child = await s.product('pequena', [
        { storeId: centro.id, published: true },
        { storeId: chacao.id, published: true },
      ]);
      return { centro, chacao, parent, child };
    };

    const expectVisibleFamily = async (parentId: string, childId: string, storeId: string) => {
      expect(await parentOf(childId)).toBe(parentId);
      expect((await pivot(childId, storeId))?.published).toBe(true);
      // THE INVARIANT: the card is published wherever the version is.
      expect((await pivot(parentId, storeId))?.published).toBe(true);
    };

    it('a price-only PUT creating the future card pivot waits, then is refused as a card', async () => {
      const { chacao, parent, child } = await promotionState();

      const { waited, put } = await race(parent.id, child.id, chacao.id, { price: 5 });

      expect(waited).toBe(true);
      expect(put.ok).toBe(false);
      expect(put.message).toMatch(/is a parent card, so its shops are worked out from its child products/);
      await expectVisibleFamily(parent.id, child.id, chacao.id);
    });

    it('a published:false PUT creating the future card pivot waits, then is refused as a card', async () => {
      const { chacao, parent, child } = await promotionState();

      const { waited, put } = await race(parent.id, child.id, chacao.id, { published: false });

      expect(waited).toBe(true);
      expect(put.ok).toBe(false);
      expect(put.message).toMatch(/is a parent card/);
      await expectVisibleFamily(parent.id, child.id, chacao.id);
    });

    it('a published:false PUT hiding the future card EXISTING pivot waits, then is refused as a card', async () => {
      const { centro, parent, child } = await promotionState();

      const { waited, put } = await race(parent.id, child.id, centro.id, { published: false });

      expect(waited).toBe(true);
      expect(put.ok).toBe(false);
      expect(put.message).toMatch(/is a parent card/);
      await expectVisibleFamily(parent.id, child.id, centro.id);
    });
  });

  /**
   * THE ORDINARY PRICE EDIT IS UNCHANGED.
   *
   * Taking the family key for every assignment must not turn an everyday
   * branch price edit into a refusal or a hang: with nothing else holding the
   * key it is granted at once.
   */
  describe('ordinary branch price edits', () => {
    it('create a hidden pivot for a standalone product, and edit an existing one in place', async () => {
      const s = await seed();
      const centro = await s.store('centro');
      const chacao = await s.store('chacao');
      const item = await s.product('salsa', [{ storeId: centro.id, published: true }]);

      await products.assignToStore(item.id, centro.id, { price: 7 } as any, ACTOR as any);
      await products.assignToStore(item.id, chacao.id, { price: 8 } as any, ACTOR as any);

      const [edited] = await sql<{ price: string; published: boolean }>(
        `select price::text, published from store_products where product_id = ?::uuid and store_id = ?::uuid`,
        [item.id, centro.id],
      );
      expect(Number(edited.price)).toBe(7);
      expect(edited.published).toBe(true);
      expect((await pivot(item.id, chacao.id))?.published).toBe(false);
    });
  });

  /**
   * STOCK POSTINGS BESIDE THE ATTACHMENT.
   *
   * A posting applies its balance through `inventory_definer_apply_balance`;
   * the #292 dependency trigger on `inventory_balances` takes `FOR SHARE` on
   * the product's row. The posting then refreshes the cached totals with an
   * UPDATE of that row and of the product's pivots. It takes no family key.
   *
   * Two things went wrong here before the row locks took their present form,
   * each reproduced against real PostgreSQL:
   *
   *   - holding `FOR SHARE` on the member's row while it decided, the
   *     attachment deadlocked with a posting on the member: its own write of
   *     the member waited on the posting's share, and the posting's UPDATE
   *     waited on the attachment's;
   *   - holding the member's row `FOR UPDATE` and then WAITING for the card's
   *     row, it deadlocked with a transaction that had written the card and
   *     went on to touch the member — a sale issuing stock line by line, an
   *     import batch updating both.
   *
   * Now the member's row is the one lock that may wait; the card's row and
   * the pivots are asked for with `NOWAIT`, a refusal rolls the attempt back
   * whole, the next attempt first waits for the busy rows holding nothing, and
   * `withLockRetry` bounds the attempts.
   *
   * WHAT IS DRIVEN. `InventoryPostingService.postWithin`, through
   * `InventoryStockService.setProductQuantity` — what a
   * `PATCH /products/:id { stockQuantity }` makes — and through
   * `InventoryStockService.issueForSale` — the body of the loop a sale runs
   * once per line, in one transaction (`sales.service.ts`, `createFromWebsite`
   * and `createManual`). The sale itself is not driven: its loop body is,
   * twice in one transaction, card and then member. By reading, the same
   * `postWithin`, balance function, trigger and cache refresh serve
   * reservations, supplier receipts, transfers and the import inventory
   * applier; none of those is driven here.
   */
  describe('a stock posting on the member', () => {
    let race: RaceRecorder;
    const ACTOR_WITH_EMAIL = { id: ACTOR.id, email: 'owner@example.test' };

    beforeAll(() => {
      race = new RaceRecorder(pg);
    });
    beforeEach(() => race.reset());

    /** A company with a warehouse, so a posting has somewhere to put the units. */
    const stocked = async (cardHiddenInMemberBranch = false) => {
      const s = await seed();
      await createLocation(em, s.organizationId, 'WAREHOUSE', `WH-${s.organizationId.slice(0, 8)}`, 'Main', null, true);
      const a = await s.store('a');
      const b = await s.store('b');
      const card = await s.product(
        'card',
        cardHiddenInMemberBranch
          ? [
              { storeId: a.id, published: true },
              { storeId: b.id, published: false },
            ]
          : [{ storeId: a.id, published: true }],
      );
      const member = await s.product('member', [{ storeId: b.id, published: true }], 'PUBLISHED', true);
      race.nameProduct(card.id, 'CARD');
      race.nameProduct(member.id, 'MEMBER');
      race.nameStore(a.id, 'A');
      race.nameStore(b.id, 'B');
      return { s, a, b, card, member };
    };

    const stockOf = async (productId: string): Promise<number> => {
      const [row] = await sql<{ stock_quantity: number }>(`select stock_quantity from products where id = ?::uuid`, [
        productId,
      ]);
      return Number(row.stock_quantity);
    };

    /** `PATCH { stockQuantity: 5 }` on MEMBER, optionally held inside the posting with its balance applied. */
    const postingOf = (organizationId: string, memberId: string, hold?: ReturnType<typeof gateOf>) => {
      const fork = pg.orm.em.fork() as EntityManager;
      const guard = new PublicationGuardService();
      const stock: any = realStock(fork as any);
      if (hold) {
        const original = stock.posting.syncCompatibilityCaches.bind(stock.posting);
        let used = false;
        stock.posting.syncCompatibilityCaches = async (...args: unknown[]) => {
          if (!used) {
            used = true;
            race.note('post', 'PAUSED — balance applied, its FOR SHARE on MEMBER held; caches not yet refreshed');
            hold.at();
            await hold.until;
            race.note('post', 'RESUMED');
          }
          return original(...args);
        };
      }
      const products = new ProductsService(
        fork.getRepository(Product) as any,
        fork.getRepository(Product) as any,
        { findById: async () => undefined } as any,
        { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
        { learnFromAcceptedGroup: async () => undefined } as any,
        guard,
        new ProductFieldsService(fork.getRepository(ProductFieldDefinition) as any, fork as any, guard),
        stock,
      );
      return () => products.update(memberId, { stockQuantity: 5 } as any, organizationId, ACTOR_WITH_EMAIL as any);
    };

    /** The attachment of MEMBER to CARD, optionally held with its keys and row locks held and the member written. */
    const attachmentOf = (cardId: string, memberId: string, hold?: ReturnType<typeof gateOf>) => {
      const guard = new PublicationGuardService();
      if (hold) {
        const original = guard.reconcileStoresOfParent.bind(guard);
        let used = false;
        guard.reconcileStoresOfParent = async (tem: EntityManager, ...rest: unknown[]) => {
          if (!used) {
            used = true;
            await tem.flush();
            race.note('attach', 'PAUSED — keys and row locks held, member written, card not yet reconciled');
            hold.at();
            await hold.until;
            race.note('attach', 'RESUMED');
          }
          return (original as any)(tem, ...rest);
        };
      }
      const family = servicesOn(pg.orm.em.fork() as EntityManager, guard).family;
      return () => family.addMember(cardId, { productId: memberId, label: 'Pequeña' } as any, ACTOR_WITH_EMAIL as any);
    };

    /** Hold `first` at its gate, run `second` to the end or to a wait, let go, and collect both. */
    const beside = async (
      first: { actor: string; run: () => Promise<unknown>; gate: ReturnType<typeof gateOf> },
      second: { actor: string; run: () => Promise<unknown> },
    ) => {
      const leading = race.run(first.actor, first.run);
      const early = await Promise.race([first.gate.reached.then(() => null), leading.settled]);
      if (early) throw new Error(`${first.actor} settled before it could be held: ${early}\n${race.timeline()}`);
      let during = '';
      let following: ReturnType<RaceRecorder['run']> | undefined;
      try {
        following = race.run(second.actor, second.run);
        during = await race.settledOrBlocked(second.actor, following.state);
      } finally {
        first.gate.release();
      }
      const outcomes: Record<string, string> = {
        [first.actor]: await within(leading.settled, 30_000, first.actor),
        [second.actor]: await within(following.settled, 30_000, second.actor),
      };
      return { during, ...outcomes, story: `\n${race.timeline()}` } as {
        during: string;
        attach: string;
        post: string;
        story: string;
      };
    };

    it('the posting first: the attachment waits for it, attaches, and the stock is kept', async () => {
      const { card, member, s, b } = await stocked();
      const gate = gateOf();

      const { during, attach, post, story } = await beside(
        { actor: 'post', run: postingOf(s.organizationId, member.id, gate), gate },
        { actor: 'attach', run: attachmentOf(card.id, member.id) },
      );

      expect({ attach, post, story }).toEqual({ attach: 'completed', post: 'completed', story });
      // It waited on the posting's row, not on an advisory key, and was not ended.
      expect({ during, story }).toEqual({ during: 'BLOCKED by post (Lock:transactionid)', story });
      expect({ parent: await parentOf(member.id), stock: await stockOf(member.id), story }).toEqual({
        parent: card.id,
        stock: 5,
        story,
      });
      expect((await pivot(card.id, b.id))?.published).toBe(true);
      expect({ attempts: race.sequenceOf('attach').filter((l) => l === 'BEGIN').length, story }).toEqual({
        attempts: 1,
        story,
      });
      expect({ attach: race.orderViolations('attach'), story }).toEqual({ attach: [], story });
    });

    it('a posting on the CARD first: the attachment reads beside its share, attaches, and the card keeps its stock', async () => {
      // The card's row is only read here, FOR SHARE NOWAIT: the posting's
      // trigger share on it is compatible, so the attachment goes through
      // beside it, and the posting's UPDATE of the card then waits for the
      // attachment's share. The reverse order — the attachment first — ends
      // with stock posted onto what has become a card, a state develop reaches
      // as well (the child count is read with no family key); it is not
      // asserted here.
      const s = await seed();
      await createLocation(em, s.organizationId, 'WAREHOUSE', `WH-${s.organizationId.slice(0, 8)}`, 'Main', null, true);
      const a = await s.store('a');
      const b = await s.store('b');
      const card = await s.product('card', [{ storeId: a.id, published: true }], 'PUBLISHED', true);
      const member = await s.product('member', [{ storeId: b.id, published: true }]);
      race.nameProduct(card.id, 'CARD');
      race.nameProduct(member.id, 'MEMBER');
      race.nameStore(a.id, 'A');
      race.nameStore(b.id, 'B');
      const gate = gateOf();

      const { during, attach, post, story } = await beside(
        { actor: 'post', run: postingOf(s.organizationId, card.id, gate), gate },
        { actor: 'attach', run: attachmentOf(card.id, member.id) },
      );

      expect({ attach, post, story }).toEqual({ attach: 'completed', post: 'completed', story });
      expect({ during, story }).toEqual({ during: 'finished: completed', story });
      expect({ parent: await parentOf(member.id), stock: await stockOf(card.id), story }).toEqual({
        parent: card.id,
        stock: 5,
        story,
      });
      expect({ attempts: attemptsOf(race, 'attach'), story }).toEqual({
        attempts: { begins: 1, rollbacks: 0, writtenBeforeRollback: 0 },
        story,
      });
      expect({ attach: race.orderViolations('attach'), story }).toEqual({ attach: [], story });
    });

    it('the attachment first: the posting waits for it, posts, and the stock is kept', async () => {
      const { card, member, s, b } = await stocked();
      const gate = gateOf();

      const { during, attach, post, story } = await beside(
        { actor: 'attach', run: attachmentOf(card.id, member.id, gate), gate },
        { actor: 'post', run: postingOf(s.organizationId, member.id) },
      );

      expect({ attach, post, story }).toEqual({ attach: 'completed', post: 'completed', story });
      expect({ during, story }).toEqual({ during: 'BLOCKED by attach (Lock:transactionid)', story });
      expect({ parent: await parentOf(member.id), stock: await stockOf(member.id), story }).toEqual({
        parent: card.id,
        stock: 5,
        story,
      });
      expect((await pivot(card.id, b.id))?.published).toBe(true);
    });

    /**
     * THE SALE: two lines in one transaction, the card and then the member.
     * Both are in B, both track inventory, both have 10 units at B's own
     * location. The sale issues one of each. It is held after the card's line
     * — the card's row written by the cache refresh — and before the member's.
     */
    const sold = async (cardHiddenInB = false) => {
      const s = await seed();
      await createLocation(em, s.organizationId, 'WAREHOUSE', `WH-${s.organizationId.slice(0, 8)}`, 'Main', null, true);
      const b = await s.store('b');
      await createLocation(em, s.organizationId, 'STORE', `ST-${b.id.slice(0, 8)}`, 'Branch B', b.id, false);
      const card = await s.product('card', [{ storeId: b.id, published: !cardHiddenInB }], 'PUBLISHED', true);
      const member = await s.product('member', [{ storeId: b.id, published: true }], 'PUBLISHED', true);
      const stock: any = realStock(pg.orm.em.fork() as any);
      for (const productId of [card.id, member.id]) {
        await (pg.orm.em.fork() as EntityManager).transactional((tem) =>
          stock.setBranchQuantity(tem, {
            organizationId: s.organizationId,
            storeId: b.id,
            productId,
            targetQuantity: 10,
            origin: 'test-seed',
          }),
        );
      }
      race.nameProduct(card.id, 'CARD');
      race.nameProduct(member.id, 'MEMBER');
      race.nameStore(b.id, 'B');
      return { s, b, card, member };
    };

    const saleOf = (
      organizationId: string,
      storeId: string,
      lines: string[],
      holdAfterFirstLine?: ReturnType<typeof gateOf>,
    ) => {
      const fork = pg.orm.em.fork() as EntityManager;
      const stock: any = realStock(fork as any);
      const scope = `order-${Math.random().toString(16).slice(2, 10)}`;
      return () =>
        fork.transactional(async (tem) => {
          for (const [index, productId] of lines.entries()) {
            const drawn = await stock.issueForSale(tem, {
              organizationId,
              storeId,
              productId,
              quantity: 1,
              idempotencyScope: scope,
              actor: ACTOR_WITH_EMAIL,
            });
            if (!drawn) throw new Error(`line ${index} could not be drawn`);
            if (index === 0 && holdAfterFirstLine) {
              race.note('sale', 'PAUSED — first line issued, the card’s row written; the member’s line not yet');
              holdAfterFirstLine.at();
              await holdAfterFirstLine.until;
              race.note('sale', 'RESUMED');
            }
          }
        });
    };

    it('the sale first, card then member: the attachment gives the card back, waits holding nothing, then attaches', async () => {
      const { card, member, s, b } = await sold();
      const gate = gateOf();

      const { during, attach, sale, story } = (await beside(
        { actor: 'sale', run: saleOf(s.organizationId, b.id, [card.id, member.id], gate), gate },
        { actor: 'attach', run: attachmentOf(card.id, member.id) },
      )) as unknown as { during: string; attach: string; sale: string; story: string };

      expect({ attach, sale, story }).toEqual({ attach: 'completed', sale: 'completed', story });
      // While the sale was held: the first attempt was refused its NOWAIT on
      // the card, rolled back, and the wait — holding nothing — was what stood
      // blocked. Not a deadlock, and not an attempt holding the member's row.
      expect({ during, story }).toEqual({ during: 'BLOCKED by sale (Lock:transactionid)', story });
      expect({ transactions: transactionsOf(race, 'attach'), story }).toEqual({
        transactions: {
          attempts: 2,
          rolledBack: 1,
          writtenBeforeRollback: 0,
          waits: [['ROW LOCK FOR SHARE on products [CARD]'], ['ROW LOCK FOR SHARE on products [MEMBER]']],
        },
        story,
      });
      const refusal = race.sequenceOf('attach').find((label) => label.startsWith('ROW LOCK FOR SHARE NOWAIT'));
      expect({ refusal, story }).toEqual({ refusal: 'ROW LOCK FOR SHARE NOWAIT on products [CARD]', story });
      expect({ attach: race.orderViolations('attach'), story }).toEqual({ attach: [], story });
      expect({ parent: await parentOf(member.id), story }).toEqual({ parent: card.id, story });
      expect({ stock: [await stockOf(card.id), await stockOf(member.id)], story }).toEqual({ stock: [9, 9], story });
      expect((await pivot(card.id, b.id))?.published).toBe(true);
      expect((await pivot(member.id, b.id))?.published).toBe(true);
    });

    it('the attachment first, then the sale card then member: the sale waits for it, then issues both lines', async () => {
      const { card, member, s, b } = await sold();
      const gate = gateOf();

      const { during, attach, sale, story } = (await beside(
        { actor: 'attach', run: attachmentOf(card.id, member.id, gate), gate },
        { actor: 'sale', run: saleOf(s.organizationId, b.id, [card.id, member.id]) },
      )) as unknown as { during: string; attach: string; sale: string; story: string };

      expect({ attach, sale, story }).toEqual({ attach: 'completed', sale: 'completed', story });
      expect({ during, story }).toEqual({ during: 'BLOCKED by attach (Lock:transactionid)', story });
      expect({ attempts: attemptsOf(race, 'attach'), story }).toEqual({
        attempts: { begins: 1, rollbacks: 0, writtenBeforeRollback: 0 },
        story,
      });
      expect({ attach: race.orderViolations('attach'), story }).toEqual({ attach: [], story });
      expect({ parent: await parentOf(member.id), story }).toEqual({ parent: card.id, story });
      expect({ stock: [await stockOf(card.id), await stockOf(member.id)], story }).toEqual({ stock: [9, 9], story });
    });

    it('the sale first, and the card hidden in B: the attachment waits holding nothing, then is refused', async () => {
      const { card, member, s, b } = await sold(true);
      const gate = gateOf();

      const { attach, sale, story } = (await beside(
        { actor: 'sale', run: saleOf(s.organizationId, b.id, [card.id, member.id], gate), gate },
        { actor: 'attach', run: attachmentOf(card.id, member.id) },
      )) as unknown as { during: string; attach: string; sale: string; story: string };

      expect({ sale, story }).toEqual({ sale: 'completed', story });
      expect({ attach, story }).toEqual({
        attach: expect.stringMatching(/is hidden in .* where the published item/),
        story,
      });
      // Refused its NOWAIT, waited row by row, then refused by the rule.
      expect({ transactions: transactionsOf(race, 'attach'), story }).toEqual({
        transactions: {
          attempts: 2,
          rolledBack: 2,
          writtenBeforeRollback: 0,
          waits: [['ROW LOCK FOR SHARE on products [CARD]'], ['ROW LOCK FOR SHARE on products [MEMBER]']],
        },
        story,
      });
      expect({ parent: await parentOf(member.id), story }).toEqual({ parent: null, story });
      expect({ stock: [await stockOf(card.id), await stockOf(member.id)], story }).toEqual({ stock: [9, 9], story });
    });

    it('the posting first, and the card hidden where the member is published: the attachment waits, then is refused', async () => {
      const { card, member, s } = await stocked(true);
      const gate = gateOf();

      const { during, attach, post, story } = await beside(
        { actor: 'post', run: postingOf(s.organizationId, member.id, gate), gate },
        { actor: 'attach', run: attachmentOf(card.id, member.id) },
      );

      expect({ post, story }).toEqual({ post: 'completed', story });
      expect({ attach, story }).toEqual({
        attach: expect.stringMatching(/is hidden in .* where the published item/),
        story,
      });
      expect({ during, story }).toEqual({ during: 'BLOCKED by post (Lock:transactionid)', story });
      // The rule decided on the member as the posting left it; the member is untouched.
      expect({ parent: await parentOf(member.id), stock: await stockOf(member.id), story }).toEqual({
        parent: null,
        stock: 5,
        story,
      });
      expect(race.sequenceOf('attach').filter((l) => /^(INSERT|UPDATE|DELETE) /.test(l))).toEqual([]);
    });
  });

  /**
   * A BRANCH THE MEMBER GAINS WHILE THE ATTACHMENT LOCKS ITS ROW.
   *
   * A writer that holds no family key for the member — the import runner, for
   * a standalone — can be inserting the member a pivot in a new branch when the
   * attachment asks for the member's row: the insert's foreign-key check holds
   * that row, so the `FOR UPDATE` waits for the insert to commit, and then
   * reads the pivot. But the attachment's derivation ran before the insert and
   * did not name that branch. Left to run, the reconciliation took the
   * branch's store key after the family keys, the row locks and the write —
   * and against a branch assignment of a sibling in that branch, which takes
   * the store key and then the card's family key, that was `40P01`.
   *
   * So a locked branch the derivation did not see is a widened key set,
   * raised before anything is written: the attempt starts again and names it.
   * The writer here is a raw transaction that takes the branch's store key and
   * inserts the pivot, which is the runner's shape for a standalone; the
   * runner itself is not driven.
   */
  describe('a branch the member gains while the attachment locks its row', () => {
    let race: RaceRecorder;
    beforeAll(() => {
      race = new RaceRecorder(pg);
    });
    beforeEach(() => race.reset());

    const seeded = async (withSibling: boolean) => {
      const s = await seed();
      const a = await s.store('a');
      const b = await s.store('b');
      const c = await s.store('c');
      const card = await s.product('card', [{ storeId: a.id, published: true }]);
      const member = await s.product('member', [{ storeId: b.id, published: true }]);
      const sibling = withSibling ? await s.product('sibling', [{ storeId: a.id, published: true }]) : null;
      if (sibling) {
        await sql(`update products set parent_id = ?::uuid, option_label = 'Uno' where id = ?::uuid`, [
          card.id,
          sibling.id,
        ]);
      }
      race.nameProduct(card.id, 'CARD');
      race.nameProduct(member.id, 'MEMBER');
      if (sibling) race.nameProduct(sibling.id, 'SIBLING');
      race.nameStore(a.id, 'A');
      race.nameStore(b.id, 'B');
      race.nameStore(c.id, 'C');
      return { s, a, b, c, card, member, sibling };
    };

    /** Store C's key, then MEMBER's pivot in C, held uncommitted: the runner's shape for a standalone. */
    const insertingMemberIntoC = (
      organizationId: string,
      memberId: string,
      storeId: string,
      hold: ReturnType<typeof gateOf>,
    ) => {
      const fork = pg.orm.em.fork() as EntityManager;
      const guard = new PublicationGuardService();
      return () =>
        fork.transactional(async (tem) => {
          await guard.acquire(tem, [storePublicationLock(storeId)]);
          await tem.execute(
            `insert into store_products
               (organization_id, store_id, product_id, published, track_inventory, created_at, updated_at)
             values (?::uuid, ?::uuid, ?::uuid, true, false, now(), now())`,
            [organizationId, storeId, memberId],
          );
          race.note('runner', 'PAUSED — store C held, MEMBER’s pivot in C written, not committed');
          hold.at();
          await hold.until;
          race.note('runner', 'RESUMED');
        });
    };

    const attachmentOf = (cardId: string, memberId: string) => {
      const family = servicesOn(pg.orm.em.fork() as EntityManager).family;
      return () => family.addMember(cardId, { productId: memberId, label: 'Pequeña' } as any, ACTOR as any);
    };

    it('the attachment waits for the insert, then starts again naming the branch, having written nothing', async () => {
      const { s, a, b, c, card, member } = await seeded(false);
      const hold = gateOf();

      const inserting = race.run('runner', insertingMemberIntoC(s.organizationId, member.id, c.id, hold));
      const early = await Promise.race([hold.reached.then(() => null), inserting.settled]);
      if (early) throw new Error(`the insert settled before it could be held: ${early}\n${race.timeline()}`);
      let during = '';
      let attaching: ReturnType<RaceRecorder['run']> | undefined;
      try {
        attaching = race.run('attach', attachmentOf(card.id, member.id));
        during = await race.settledOrBlocked('attach', attaching.state);
      } finally {
        hold.release();
      }
      const inserted = await within(inserting.settled, 30_000, 'runner');
      const attached = await within(attaching.settled, 30_000, 'attach');
      const story = `\n${race.timeline()}`;

      expect({ attached, inserted, story }).toEqual({ attached: 'completed', inserted: 'completed', story });
      expect({ during, story }).toEqual({ during: 'BLOCKED by runner (Lock:transactionid)', story });
      // Started again before writing, and the second attempt named C with the rest.
      expect({ attempts: attemptsOf(race, 'attach'), story }).toEqual({
        attempts: { begins: 2, rollbacks: 1, writtenBeforeRollback: 0 },
        story,
      });
      expect({ attach: race.orderViolations('attach'), story }).toEqual({ attach: [], story });
      const stores = { a: a.id, b: b.id, c: c.id };
      expect({ member: await branchesOf(member.id, stores), card: await branchesOf(card.id, stores), story }).toEqual({
        member: ['b', 'c'],
        card: ['b', 'c'],
        story,
      });
      expect(await parentOf(member.id)).toBe(card.id);
    });

    it('with a branch assignment of a sibling in that branch arriving: neither is ended, and the card is in all three', async () => {
      const { s, a, b, c, card, member, sibling } = await seeded(true);
      const hold = gateOf();

      const inserting = race.run('runner', insertingMemberIntoC(s.organizationId, member.id, c.id, hold));
      const early = await Promise.race([hold.reached.then(() => null), inserting.settled]);
      if (early) throw new Error(`the insert settled before it could be held: ${early}\n${race.timeline()}`);
      let attachDuring = '';
      let publishDuring = '';
      let attaching: ReturnType<RaceRecorder['run']> | undefined;
      let publishing: ReturnType<RaceRecorder['run']> | undefined;
      try {
        attaching = race.run('attach', attachmentOf(card.id, member.id));
        attachDuring = await race.settledOrBlocked('attach', attaching.state);
        // Store C, then the card's family key: the order a branch assignment takes them in.
        const products = servicesOn(pg.orm.em.fork() as EntityManager).products;
        publishing = race.run('publish', () =>
          products.assignToStore(sibling!.id, c.id, { published: true } as any, ACTOR as any),
        );
        publishDuring = await race.settledOrBlocked('publish', publishing.state);
      } finally {
        hold.release();
      }
      const inserted = await within(inserting.settled, 30_000, 'runner');
      const attached = await within(attaching.settled, 30_000, 'attach');
      const published = await within(publishing.settled, 30_000, 'publish');
      const story = `\n${race.timeline()}`;

      // Before this change the attachment took C's key after its write while the
      // assignment held C and waited for the card: 40P01.
      expect({ attached, published, inserted, story }).toEqual({
        attached: 'completed',
        published: 'completed',
        inserted: 'completed',
        story,
      });
      expect({ attachDuring, publishDuring, story }).toEqual({
        attachDuring: 'BLOCKED by runner (Lock:transactionid)',
        publishDuring: 'BLOCKED by runner (Lock:advisory)',
        story,
      });
      expect({ attach: race.orderViolations('attach'), publish: race.orderViolations('publish'), story }).toEqual({
        attach: [],
        publish: [],
        story,
      });
      expect({ attempts: attemptsOf(race, 'attach').writtenBeforeRollback, story }).toEqual({ attempts: 0, story });
      const stores = { a: a.id, b: b.id, c: c.id };
      expect({
        member: await branchesOf(member.id, stores),
        sibling: await branchesOf(sibling!.id, stores),
        card: await branchesOf(card.id, stores),
        story,
      }).toEqual({ member: ['b', 'c'], sibling: ['a', 'c'], card: ['a', 'b', 'c'], story });
      expect(await parentOf(member.id)).toBe(card.id);
    });
  });

  /**
   * A RETRY, WITH THE ENTITIES THE REQUEST ALREADY HELD.
   *
   * The controller loads both products into the request's manager before the
   * service runs, and `em.transactional` forks that manager without clearing
   * it: an attempt that is rolled back leaves its collections on the shared
   * entities, and the next attempt's load hands them back as they were. The
   * "at least one branch" rule used to decide from those. A member that lost
   * its only branch while the attachment waited between attempts was attached
   * as a child in no branch. The rule now decides from the pivots read under
   * the locks.
   */
  describe('a retry, with the entities the request already held', () => {
    let race: RaceRecorder;
    beforeAll(() => {
      race = new RaceRecorder(pg);
    });
    beforeEach(() => race.reset());

    it('a member that lost its only branch between attempts is refused, not attached', async () => {
      const s = await seed();
      const a = await s.store('a');
      const b = await s.store('b');
      const card = await s.product('card', [{ storeId: a.id, published: true }]);
      const member = await s.product('member', [{ storeId: b.id, published: true }]);
      race.nameProduct(card.id, 'CARD');
      race.nameProduct(member.id, 'MEMBER');
      race.nameStore(a.id, 'A');
      race.nameStore(b.id, 'B');

      // The controller loads both products into the request's manager (with
      // `organization`, `products.controller.ts`); the first attempt then
      // populates their collections on those same shared instances, and the
      // second attempt is handed them. Loaded here with the collections
      // directly: the shape the second attempt meets.
      const request = pg.orm.em.fork() as EntityManager;
      await request.findOne(Product, { id: card.id }, { populate: ['children', 'stores'] });
      await request.findOne(Product, { id: member.id }, { populate: ['children', 'stores'] });
      const family = servicesOn(request).family;

      // Somebody holds the card's row: the first attempt is refused its NOWAIT.
      const hold = gateOf();
      const holder = pg.orm.em.fork() as EntityManager;
      const holding = race.run('holder', () =>
        holder.transactional(async (tem) => {
          await tem.find(Product, { id: card.id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
          race.note('holder', 'PAUSED — the card’s row held for update');
          hold.at();
          await hold.until;
          race.note('holder', 'RESUMED');
        }),
      );
      const early = await Promise.race([hold.reached.then(() => null), holding.settled]);
      if (early) throw new Error(`the holder settled before it could be held: ${early}\n${race.timeline()}`);

      let during = '';
      let attaching: ReturnType<RaceRecorder['run']> | undefined;
      try {
        attaching = race.run('attach', () =>
          family.addMember(card.id, { productId: member.id, label: 'Pequeña' } as any, ACTOR as any),
        );
        during = await race.settledOrBlocked('attach', attaching.state);
        // While the attachment waits between attempts, the member loses its only branch.
        await sql(`delete from store_products where product_id = ?::uuid`, [member.id]);
        race.note('attach', 'MEMBER’s only pivot deleted by somebody else, committed');
      } finally {
        hold.release();
      }
      const held = await within(holding.settled, 30_000, 'holder');
      const attached = await within(attaching.settled, 30_000, 'attach');
      const story = `\n${race.timeline()}`;

      expect({ held, story }).toEqual({ held: 'completed', story });
      expect({ during, story }).toEqual({ during: 'BLOCKED by holder (Lock:transactionid)', story });
      // The second attempt decided from the pivots as locked, not from the
      // `stores` collection the first attempt had left on the entity.
      expect({ attached, story }).toEqual({
        attached: expect.stringMatching(/belongs to no store, so it cannot become a child product/),
        story,
      });
      expect({ parent: await parentOf(member.id), story }).toEqual({ parent: null, story });
      const writes = race.sequenceOf('attach').filter((label) => /^(INSERT|UPDATE|DELETE) /.test(label));
      expect({ writes, story }).toEqual({ writes: [], story });
    });
  });

  /**
   * A BRANCH THE COMPANY HAS REMOVED.
   *
   * Removing a store sets `stores.removed_at` and nothing else: its pivots
   * stay. Every read the attachment names its keys from, and every read the
   * reconciliation derives from, goes through the ORM, whose removed filter
   * on `Store` reaches through the pivot's relation — those pivots do not
   * exist for it. The locked read is raw, and a raw read sees them; compared
   * unfiltered, a pivot in a removed branch was a branch the keys were never
   * named for, on every attempt, and the attachment was refused for good. The
   * locked read now applies the filter the ORM applies.
   *
   * A store is removed or restored by a write to ITS row, which this locks
   * nothing on. So the branch set the attachment decides on can change after
   * the keys were named without any pivot changing, and the last four cases
   * hold what happens then. The removal here is the write
   * `StoreRemovalService.remove` makes, not the service: it takes its own
   * locks, none of which this attachment holds.
   */
  describe('a branch the company has removed', () => {
    let race: RaceRecorder;
    beforeAll(() => {
      race = new RaceRecorder(pg);
    });
    beforeEach(() => race.reset());

    const remove = (storeId: string) => sql(`update stores set removed_at = now() where id = ?::uuid`, [storeId]);
    const restore = (storeId: string) => sql(`update stores set removed_at = null where id = ?::uuid`, [storeId]);

    const attachmentOf = (cardId: string, memberId: string, guard?: PublicationGuardService, label = 'Pequeña') => {
      const family = servicesOn(pg.orm.em.fork() as EntityManager, guard).family;
      return () => family.addMember(cardId, { productId: memberId, label } as any, ACTOR as any);
    };

    /**
     * Pauses the FIRST attempt after its keys were named and before its rows
     * are locked — on the guard's `assertMembersAttachable`, as the group on
     * the card's state does. A second attempt, if there is one, runs through.
     */
    const pausedOnce = (guard: PublicationGuardService) => {
      const original = guard.assertMembersAttachable.bind(guard);
      const hold = gateOf();
      let used = false;
      guard.assertMembersAttachable = async (...args: Parameters<typeof original>) => {
        if (!used) {
          used = true;
          race.note('attach', 'PAUSED — keys named and held, no row locked yet');
          hold.at();
          await hold.until;
          race.note('attach', 'RESUMED');
        }
        return original(...args);
      };
      return hold;
    };

    const attachedAcross = async (
      cardId: string,
      memberId: string,
      meanwhile: () => Promise<void>,
      label?: string,
    ): Promise<{ attached: string; story: string }> => {
      const guard = new PublicationGuardService();
      const hold = pausedOnce(guard);
      const attaching = race.run('attach', attachmentOf(cardId, memberId, guard, label));
      const early = await Promise.race([hold.reached.then(() => null), attaching.settled]);
      if (early) throw new Error(`the attachment settled before it paused: ${early}\n${race.timeline()}`);
      try {
        await meanwhile();
      } finally {
        hold.release();
      }
      const attached = await within(attaching.settled, 30_000, 'attach');
      return { attached, story: `\n${race.timeline()}` };
    };

    it('the locked read holds the pivot rows and not the store rows they point at', async () => {
      const s = await seed();
      const a = await s.store('a');
      const b = await s.store('b');
      const card = await s.product('card', [{ storeId: a.id, published: true }]);
      const member = await s.product('member', [{ storeId: b.id, published: true }]);
      race.nameProduct(card.id, 'CARD');
      race.nameProduct(member.id, 'MEMBER');
      race.nameStore(a.id, 'A');
      race.nameStore(b.id, 'B');

      // Paused on the guard's reconciliation: after the locked read and the
      // write, before any pivot of the card is inserted. Everything the
      // attachment locks, it holds here.
      const guard = new PublicationGuardService();
      const original = guard.reconcileStoresOfParent.bind(guard);
      const hold = gateOf();
      guard.reconcileStoresOfParent = async (...args: Parameters<typeof original>) => {
        race.note('attach', 'PAUSED — rows locked and the member written; nothing reconciled yet');
        hold.at();
        await hold.until;
        race.note('attach', 'RESUMED');
        return original(...args);
      };
      const attaching = race.run('attach', attachmentOf(card.id, member.id, guard));
      const early = await Promise.race([hold.reached.then(() => null), attaching.settled]);
      if (early) throw new Error(`the attachment settled before it paused: ${early}\n${race.timeline()}`);

      // Asked for `FOR UPDATE NOWAIT`, which any lock on the row refuses: the
      // member's store row is free, the member's pivot row is not.
      const asked = async (text: string, params: unknown[]) => {
        const prober = pg.orm.em.fork() as EntityManager;
        try {
          await prober.transactional((tem) => tem.execute(text, params));
          return 'granted';
        } catch (err) {
          return isLockNotAvailable(err) ? 'refused: 55P03' : `failed: ${String((err as Error).message)}`;
        }
      };
      let storeRow = '';
      let pivotRow = '';
      try {
        storeRow = await asked(
          `select id from stores where id = ?::uuid /* removed_at: a lock by id, in any state */ for update nowait`,
          [b.id],
        );
        pivotRow = await asked(`select id from store_products where product_id = ?::uuid for update nowait`, [
          member.id,
        ]);
      } finally {
        hold.release();
      }
      const attached = await within(attaching.settled, 30_000, 'attach');
      const story = `\n${race.timeline()}`;

      expect({ storeRow, pivotRow, attached, story }).toEqual({
        storeRow: 'granted',
        pivotRow: 'refused: 55P03',
        attached: 'completed',
        story,
      });
      expect(await parentOf(member.id)).toBe(card.id);
    });

    it('a member with a pivot in a removed branch is attached, and the card follows it into its live branch only', async () => {
      const s = await seed();
      const a = await s.store('a');
      const b = await s.store('b');
      const r = await s.store('r');
      const card = await s.product('card', [{ storeId: a.id, published: true }]);
      const member = await s.product('member', [
        { storeId: b.id, published: true },
        { storeId: r.id, published: true },
      ]);
      await remove(r.id);
      race.nameProduct(card.id, 'CARD');
      race.nameProduct(member.id, 'MEMBER');
      race.nameStore(a.id, 'A');
      race.nameStore(b.id, 'B');
      race.nameStore(r.id, 'R');

      const attached = await within(race.run('attach', attachmentOf(card.id, member.id)).settled, 30_000, 'attach');
      const story = `\n${race.timeline()}`;

      expect({ attached, story }).toEqual({ attached: 'completed', story });
      expect({ attempts: attemptsOf(race, 'attach'), story }).toEqual({
        attempts: { begins: 1, rollbacks: 0, writtenBeforeRollback: 0 },
        story,
      });
      expect({ attach: race.orderViolations('attach'), story }).toEqual({ attach: [], story });
      const stores = { a: a.id, b: b.id, r: r.id };
      // The member keeps its pivot in R; the card is not taken there.
      expect({ member: await branchesOf(member.id, stores), card: await branchesOf(card.id, stores), story }).toEqual({
        member: ['b', 'r'],
        card: ['b'],
        story,
      });
      expect(await parentOf(member.id)).toBe(card.id);
    });

    it('a card HIDDEN in a removed branch where the member is published is no refusal: nobody is served there', async () => {
      const s = await seed();
      const a = await s.store('a');
      const b = await s.store('b');
      const r = await s.store('r');
      const card = await s.product('card', [
        { storeId: a.id, published: true },
        { storeId: r.id, published: false },
      ]);
      const member = await s.product('member', [
        { storeId: b.id, published: true },
        { storeId: r.id, published: true },
      ]);
      await remove(r.id);
      race.nameProduct(card.id, 'CARD');
      race.nameProduct(member.id, 'MEMBER');

      const attached = await within(race.run('attach', attachmentOf(card.id, member.id)).settled, 30_000, 'attach');
      const story = `\n${race.timeline()}`;

      expect({ attached, story }).toEqual({ attached: 'completed', story });
      expect(await parentOf(member.id)).toBe(card.id);
    });

    it('a member whose only branch is removed is refused, as it is before any key', async () => {
      const s = await seed();
      const a = await s.store('a');
      const r = await s.store('r');
      const card = await s.product('card', [{ storeId: a.id, published: true }]);
      const member = await s.product('member', [{ storeId: r.id, published: true }]);
      await remove(r.id);

      const attached = await within(race.run('attach', attachmentOf(card.id, member.id)).settled, 30_000, 'attach');
      const story = `\n${race.timeline()}`;

      expect({ attached, story }).toEqual({
        attached: expect.stringMatching(/belongs to no store, so it cannot become a child product/),
        story,
      });
      expect(await parentOf(member.id)).toBeNull();
    });

    it('a live branch gained while the row is locked is still caught, beside a removed one', async () => {
      const s = await seed();
      const a = await s.store('a');
      const b = await s.store('b');
      const c = await s.store('c');
      const r = await s.store('r');
      const card = await s.product('card', [{ storeId: a.id, published: true }]);
      const member = await s.product('member', [
        { storeId: b.id, published: true },
        { storeId: r.id, published: true },
      ]);
      await remove(r.id);
      race.nameProduct(card.id, 'CARD');
      race.nameProduct(member.id, 'MEMBER');
      race.nameStore(a.id, 'A');
      race.nameStore(b.id, 'B');
      race.nameStore(c.id, 'C');
      race.nameStore(r.id, 'R');

      // Store C's key, then MEMBER's pivot in C, held uncommitted: the runner's shape for a standalone.
      const hold = gateOf();
      const runner = pg.orm.em.fork() as EntityManager;
      const inserting = race.run('runner', () =>
        runner.transactional(async (tem) => {
          await new PublicationGuardService().acquire(tem, [storePublicationLock(c.id)]);
          await tem.execute(
            `insert into store_products
               (organization_id, store_id, product_id, published, track_inventory, created_at, updated_at)
             values (?::uuid, ?::uuid, ?::uuid, true, false, now(), now())`,
            [s.organizationId, c.id, member.id],
          );
          race.note('runner', 'PAUSED — store C held, MEMBER’s pivot in C written, not committed');
          hold.at();
          await hold.until;
          race.note('runner', 'RESUMED');
        }),
      );
      const early = await Promise.race([hold.reached.then(() => null), inserting.settled]);
      if (early) throw new Error(`the insert settled before it could be held: ${early}\n${race.timeline()}`);
      let during = '';
      let attaching: ReturnType<RaceRecorder['run']> | undefined;
      try {
        attaching = race.run('attach', attachmentOf(card.id, member.id));
        during = await race.settledOrBlocked('attach', attaching.state);
      } finally {
        hold.release();
      }
      const inserted = await within(inserting.settled, 30_000, 'runner');
      const attached = await within(attaching.settled, 30_000, 'attach');
      const story = `\n${race.timeline()}`;

      expect({ attached, inserted, story }).toEqual({ attached: 'completed', inserted: 'completed', story });
      expect({ during, story }).toEqual({ during: 'BLOCKED by runner (Lock:transactionid)', story });
      // Once for C, which is live; not again for R, which is not a branch.
      expect({ attempts: attemptsOf(race, 'attach'), story }).toEqual({
        attempts: { begins: 2, rollbacks: 1, writtenBeforeRollback: 0 },
        story,
      });
      expect({ attach: race.orderViolations('attach'), story }).toEqual({ attach: [], story });
      const stores = { a: a.id, b: b.id, c: c.id, r: r.id };
      expect({ member: await branchesOf(member.id, stores), card: await branchesOf(card.id, stores), story }).toEqual({
        member: ['b', 'c', 'r'],
        card: ['b', 'c'],
        story,
      });
      expect(await parentOf(member.id)).toBe(card.id);
    });

    it('a branch removed after the keys were named: the attachment goes on, and the card is not taken there', async () => {
      const s = await seed();
      const a = await s.store('a');
      const b = await s.store('b');
      const c = await s.store('c');
      const card = await s.product('card', [{ storeId: a.id, published: true }]);
      const member = await s.product('member', [
        { storeId: b.id, published: true },
        { storeId: c.id, published: true },
      ]);
      race.nameProduct(card.id, 'CARD');
      race.nameProduct(member.id, 'MEMBER');
      race.nameStore(a.id, 'A');
      race.nameStore(b.id, 'B');
      race.nameStore(c.id, 'C');

      const { attached, story } = await attachedAcross(card.id, member.id, async () => {
        await remove(c.id);
        race.note('attach', 'store C removed by somebody else, committed');
      });

      expect({ attached, story }).toEqual({ attached: 'completed', story });
      expect({ attempts: attemptsOf(race, 'attach'), story }).toEqual({
        attempts: { begins: 1, rollbacks: 0, writtenBeforeRollback: 0 },
        story,
      });
      expect({ attach: race.orderViolations('attach'), story }).toEqual({ attach: [], story });
      const stores = { a: a.id, b: b.id, c: c.id };
      expect({ member: await branchesOf(member.id, stores), card: await branchesOf(card.id, stores), story }).toEqual({
        member: ['b', 'c'],
        card: ['b'],
        story,
      });
      expect(await parentOf(member.id)).toBe(card.id);
    });

    it("the member's only branch removed after the keys were named: refused from the rows as they stand", async () => {
      const s = await seed();
      const a = await s.store('a');
      const b = await s.store('b');
      const card = await s.product('card', [{ storeId: a.id, published: true }]);
      const member = await s.product('member', [{ storeId: b.id, published: true }]);
      race.nameProduct(card.id, 'CARD');
      race.nameProduct(member.id, 'MEMBER');

      const { attached, story } = await attachedAcross(card.id, member.id, async () => {
        await remove(b.id);
        race.note('attach', 'store B removed by somebody else, committed');
      });

      // As the company now sees it, the member is in no branch: the same
      // refusal an attachment starting after the removal meets.
      expect({ attached, story }).toEqual({
        attached: expect.stringMatching(/belongs to no store, so it cannot become a child product/),
        story,
      });
      expect(await parentOf(member.id)).toBeNull();
      const writes = race.sequenceOf('attach').filter((label) => /^(INSERT|UPDATE|DELETE) /.test(label));
      expect({ writes, story }).toEqual({ writes: [], story });
    });

    it('a branch restored after the keys were named, where the card is not: its key was named with the rest, and the card is taken there', async () => {
      const s = await seed();
      const a = await s.store('a');
      const b = await s.store('b');
      const r = await s.store('r');
      const card = await s.product('card', [{ storeId: a.id, published: true }]);
      const member = await s.product('member', [
        { storeId: b.id, published: true },
        { storeId: r.id, published: true },
      ]);
      await remove(r.id);
      race.nameProduct(card.id, 'CARD');
      race.nameProduct(member.id, 'MEMBER');
      race.nameStore(a.id, 'A');
      race.nameStore(b.id, 'B');
      race.nameStore(r.id, 'R');

      const { attached, story } = await attachedAcross(card.id, member.id, async () => {
        await restore(r.id);
        race.note('attach', 'store R restored by somebody else, committed');
      });

      expect({ attached, story }).toEqual({ attached: 'completed', story });
      // R is a branch again and the card gains it. Nothing starts again: the
      // key of every store the member is in was named, removed ones included
      // (#342), so R's was held before it came back.
      expect({ attempts: attemptsOf(race, 'attach'), story }).toEqual({
        attempts: { begins: 1, rollbacks: 0, writtenBeforeRollback: 0 },
        story,
      });
      expect({ attach: race.orderViolations('attach'), story }).toEqual({ attach: [], story });
      const stores = { a: a.id, b: b.id, r: r.id };
      expect({ member: await branchesOf(member.id, stores), card: await branchesOf(card.id, stores), story }).toEqual({
        member: ['b', 'r'],
        card: ['b', 'r'],
        story,
      });
      expect(await parentOf(member.id)).toBe(card.id);
    });

    it('a branch restored after the keys were named, where the card already is: no key is needed, nothing starts again', async () => {
      const s = await seed();
      const a = await s.store('a');
      const b = await s.store('b');
      const r = await s.store('r');
      const card = await s.product('card', [
        { storeId: a.id, published: true },
        { storeId: r.id, published: true },
      ]);
      const member = await s.product('member', [
        { storeId: b.id, published: true },
        { storeId: r.id, published: true },
      ]);
      await remove(r.id);
      race.nameProduct(card.id, 'CARD');
      race.nameProduct(member.id, 'MEMBER');
      race.nameStore(a.id, 'A');
      race.nameStore(b.id, 'B');
      race.nameStore(r.id, 'R');

      const { attached, story } = await attachedAcross(card.id, member.id, async () => {
        await restore(r.id);
        race.note('attach', 'store R restored by somebody else, committed');
      });

      expect({ attached, story }).toEqual({ attached: 'completed', story });
      // The card's own pivot in R came back with the store: nothing to gain there.
      expect({ attempts: attemptsOf(race, 'attach'), story }).toEqual({
        attempts: { begins: 1, rollbacks: 0, writtenBeforeRollback: 0 },
        story,
      });
      expect({ attach: race.orderViolations('attach'), story }).toEqual({ attach: [], story });
      const stores = { a: a.id, b: b.id, r: r.id };
      expect({ member: await branchesOf(member.id, stores), card: await branchesOf(card.id, stores), story }).toEqual({
        member: ['b', 'r'],
        card: ['b', 'r'],
        story,
      });
      expect(await parentOf(member.id)).toBe(card.id);
    });

    /**
     * A RESTORATION THE COMPARISON ABOVE CANNOT SEE (#342).
     *
     * The comparison after the locked read looks at the member's branches.
     * A store restored AFTER that read reaches the reconciliation's own
     * derivation, which gains the card that branch. For a store the MEMBER is
     * in, the key was named with the rest — removed stores included — so it
     * is held and the card is taken there. For a store only an EXISTING child
     * is in, it was not named: the reconciliation, handed the keys the
     * attachment holds, refuses, and the attempt starts again naming it.
     * Left to acquire what it needed, it took that key after the family keys,
     * the row locks and the write.
     *
     * `restoreUnderRowLock` is the BARE write a restoration makes, under the
     * store row lock it takes — not `StoreRemovalService.restore`, which also
     * holds the store's key and reconciles the cards
     * (`store-restore-card-follows.pg.spec.ts`). The bare write is what lets
     * these cases put a restoration at a point the service would not reach
     * while an attachment holds that key.
     */
    const restoreUnderRowLock = async (storeId: string) => {
      const fork = pg.orm.em.fork() as EntityManager;
      await fork.transactional(async (tem) => {
        await tem.execute(
          `select id from stores where id = ?::uuid /* removed_at: the row, in any state */ for update`,
          [storeId],
        );
        await tem.execute(`update stores set removed_at = null where id = ?::uuid`, [storeId]);
      });
    };

    /** Pauses the FIRST reconciliation: after the locked read and the write, before any pivot of the card. */
    const pausedOnReconcileOnce = (guard: PublicationGuardService) => {
      const original = guard.reconcileStoresOfParent.bind(guard);
      const hold = gateOf();
      let used = false;
      guard.reconcileStoresOfParent = async (...args: Parameters<typeof original>) => {
        if (!used) {
          used = true;
          race.note('attach', 'PAUSED — rows locked and the member written; nothing reconciled yet');
          hold.at();
          await hold.until;
          race.note('attach', 'RESUMED');
        }
        return original(...args);
      };
      return hold;
    };

    it('a branch of the member restored after the locked read: its key is held, and the reconciliation takes the card there', async () => {
      const s = await seed();
      const a = await s.store('a');
      const b = await s.store('b');
      const r = await s.store('r');
      // A card in step with its child: both in A, and nowhere else.
      const card = await s.parentWithChild('card', [{ storeId: a.id, published: true }]);
      const member = await s.product('member', [
        { storeId: b.id, published: true },
        { storeId: r.id, published: true },
      ]);
      await remove(r.id);
      race.nameProduct(card.id, 'CARD');
      race.nameProduct(member.id, 'MEMBER');
      race.nameStore(a.id, 'A');
      race.nameStore(b.id, 'B');
      race.nameStore(r.id, 'R');

      const guard = new PublicationGuardService();
      const hold = pausedOnReconcileOnce(guard);
      const attaching = race.run('attach', attachmentOf(card.id, member.id, guard));
      const early = await Promise.race([hold.reached.then(() => null), attaching.settled]);
      if (early) throw new Error(`the attachment settled before it paused: ${early}\n${race.timeline()}`);
      try {
        await restoreUnderRowLock(r.id);
        race.note('attach', 'store R restored by somebody else, committed');
      } finally {
        hold.release();
      }
      const attached = await within(attaching.settled, 30_000, 'attach');
      const story = `\n${race.timeline()}`;

      expect({ attached, story }).toEqual({ attached: 'completed', story });
      // The reconciliation found R and gave the card a pivot there under the
      // key named for the member's removed store: one attempt, no key taken
      // after a row.
      expect({ attempts: attemptsOf(race, 'attach'), story }).toEqual({
        attempts: { begins: 1, rollbacks: 0, writtenBeforeRollback: 0 },
        story,
      });
      expect({ attach: race.orderViolations('attach'), story }).toEqual({ attach: [], story });
      const stores = { a: a.id, b: b.id, r: r.id };
      expect({ member: await branchesOf(member.id, stores), card: await branchesOf(card.id, stores), story }).toEqual({
        member: ['b', 'r'],
        card: ['a', 'b', 'r'],
        story,
      });
      // Visible in R: the child is published there, and so is its card.
      expect({ member: await pivot(member.id, r.id), card: await pivot(card.id, r.id), story }).toEqual({
        member: { published: true },
        card: { published: true },
        story,
      });
      expect(await parentOf(member.id)).toBe(card.id);
    });

    it('the bare write that restores a store moves no card: taking the card there is the restoration service’s work (#342)', async () => {
      const s = await seed();
      const a = await s.store('a');
      const r = await s.store('r');
      const card = await s.product('card', [{ storeId: a.id, published: true }]);
      const child = await s.product('child', [
        { storeId: a.id, published: true },
        { storeId: r.id, published: true },
      ]);
      await remove(r.id);
      const attached = await within(race.run('attach', attachmentOf(card.id, child.id)).settled, 30_000, 'attach');
      expect(attached).toBe('completed');
      await restoreUnderRowLock(r.id);

      // `removed_at = null` on its own reconciles nothing: the child is
      // published in R and its card holds no pivot there. That was the whole
      // of a restoration until #342; `StoreRemovalService.restore` now takes
      // the card into the store in the same transaction, held in
      // `store-restore-card-follows.pg.spec.ts`. This is the state the next
      // case starts from, reached the only way it still can be — by hand.
      const stores = { a: a.id, r: r.id };
      expect({ child: await branchesOf(child.id, stores), card: await branchesOf(card.id, stores) }).toEqual({
        child: ['a', 'r'],
        card: ['a'],
      });
      expect(await pivot(child.id, r.id)).toEqual({ published: true });
      expect(await pivot(card.id, r.id)).toBeNull();
      expect(await parentOf(child.id)).toBe(card.id);
    });

    it('a branch of an existing child restored after the keys were named: refused by the reconciliation, named by the next attempt, and the card follows', async () => {
      const s = await seed();
      const a = await s.store('a');
      const b = await s.store('b');
      const r = await s.store('r');
      const card = await s.product('card', [{ storeId: a.id, published: true }]);
      const first = await s.product('first', [
        { storeId: a.id, published: true },
        { storeId: r.id, published: true },
      ]);
      // The state the case above leaves: R live, FIRST in it, the card not.
      await remove(r.id);
      expect(
        await within(race.run('attach', attachmentOf(card.id, first.id, undefined, 'Uno')).settled, 30_000, 'attach'),
      ).toBe('completed');
      await restoreUnderRowLock(r.id);
      expect(await branchesOf(card.id, { a: a.id, r: r.id })).toEqual(['a']);
      // R removed again; a second child arrives while it comes back.
      await remove(r.id);
      race.reset();
      const member = await s.product('member', [{ storeId: b.id, published: true }]);
      race.nameProduct(card.id, 'CARD');
      race.nameProduct(first.id, 'FIRST');
      race.nameProduct(member.id, 'MEMBER');
      race.nameStore(a.id, 'A');
      race.nameStore(b.id, 'B');
      race.nameStore(r.id, 'R');

      const { attached, story } = await attachedAcross(card.id, member.id, async () => {
        await restoreUnderRowLock(r.id);
        race.note('attach', 'store R restored by somebody else, committed');
      });

      expect({ attached, story }).toEqual({ attached: 'completed', story });
      // Not the member's branch, so the comparison after the locked read did
      // not see it; the reconciliation did, refused it, and the next attempt
      // named it.
      expect({ attempts: attemptsOf(race, 'attach'), story }).toEqual({
        attempts: { begins: 2, rollbacks: 1, writtenBeforeRollback: 1 },
        story,
      });
      expect({ attach: race.orderViolations('attach'), story }).toEqual({ attach: [], story });
      const stores = { a: a.id, b: b.id, r: r.id };
      expect({ card: await branchesOf(card.id, stores), first: await branchesOf(first.id, stores), story }).toEqual({
        card: ['a', 'b', 'r'],
        first: ['a', 'r'],
        story,
      });
      expect({ first: await pivot(first.id, r.id), card: await pivot(card.id, r.id), story }).toEqual({
        first: { published: true },
        card: { published: true },
        story,
      });
      expect(await parentOf(member.id)).toBe(card.id);
    });

    it('the same, with the entities the request already held: the second attempt reads the member from its row', async () => {
      const s = await seed();
      const a = await s.store('a');
      const b = await s.store('b');
      const r = await s.store('r');
      const card = await s.product('card', [{ storeId: a.id, published: true }]);
      const first = await s.product('first', [
        { storeId: a.id, published: true },
        { storeId: r.id, published: true },
      ]);
      await remove(r.id);
      expect(
        await within(race.run('attach', attachmentOf(card.id, first.id, undefined, 'Uno')).settled, 30_000, 'attach'),
      ).toBe('completed');
      await restoreUnderRowLock(r.id);
      await remove(r.id);
      race.reset();
      const member = await s.product('member', [{ storeId: b.id, published: true }]);
      race.nameProduct(card.id, 'CARD');
      race.nameProduct(first.id, 'FIRST');
      race.nameProduct(member.id, 'MEMBER');
      race.nameStore(a.id, 'A');
      race.nameStore(b.id, 'B');
      race.nameStore(r.id, 'R');

      // As the controller does (`assertProductInOrganization`): both products
      // loaded into the request's manager before the service runs. The first
      // attempt writes `parent` on that shared instance and is rolled back by
      // the reconciliation's refusal; the second must not take the instance's
      // word for it.
      const request = pg.orm.em.fork() as EntityManager;
      await request.findOne(Product, { id: card.id }, { populate: ['organization'] as never });
      await request.findOne(Product, { id: member.id }, { populate: ['organization'] as never });
      const guard = new PublicationGuardService();
      const family = servicesOn(request, guard).family;
      const hold = pausedOnce(guard);
      const attaching = race.run('attach', () =>
        family.addMember(card.id, { productId: member.id, label: 'Pequeña' } as any, ACTOR as any),
      );
      const early = await Promise.race([hold.reached.then(() => null), attaching.settled]);
      if (early) throw new Error(`the attachment settled before it paused: ${early}\n${race.timeline()}`);
      try {
        await restoreUnderRowLock(r.id);
        race.note('attach', 'store R restored by somebody else, committed');
      } finally {
        hold.release();
      }
      const attached = await within(attaching.settled, 30_000, 'attach');
      const story = `\n${race.timeline()}`;

      expect({ attached, story }).toEqual({ attached: 'completed', story });
      expect({ attempts: attemptsOf(race, 'attach'), story }).toEqual({
        attempts: { begins: 2, rollbacks: 1, writtenBeforeRollback: 1 },
        story,
      });
      expect({ attach: race.orderViolations('attach'), story }).toEqual({ attach: [], story });
      const stores = { a: a.id, b: b.id, r: r.id };
      expect({ card: await branchesOf(card.id, stores), story }).toEqual({ card: ['a', 'b', 'r'], story });
      expect(await parentOf(member.id)).toBe(card.id);
    });
  });

  /**
   * THE LOCK ORDER, AND WHAT BREAKS WHEN IT INVERTS.
   *
   * `assignToStore` decides under the product's family key (namespace 2), and
   * the reconciliation it runs afterwards needs a store key (namespace 1) for
   * every branch the card GAINS. Namespace 1 taken while namespace 2 is held
   * is the one order the codebase forbids, because other writers take them the
   * other way round.
   *
   * It was reachable through the quietest body there is: a price with no
   * publication, creating the child's pivot in a branch the card did not have.
   */
  describe('the order a branch write takes its keys in', () => {
    /** Every advisory key a guard acquires, in the order PostgreSQL got it. */
    const watchingGuard = () => {
      const guard = new PublicationGuardService();
      const original = guard.acquire.bind(guard);
      const taken: { ns: number; key: number }[] = [];
      (guard as unknown as { acquire: unknown }).acquire = async (tem: EntityManager, keys: never[]) => {
        const ordered = await original(tem, keys);
        for (const k of ordered) taken.push({ ns: k.ns, key: k.key });
        return ordered;
      };
      return { guard, taken };
    };

    const cardWithChildIn = async (s: Awaited<ReturnType<typeof seed>>, home: { id: string }) => {
      const card = await s.product('card', [{ storeId: home.id, published: true }]);
      const child = await s.product('child', [{ storeId: home.id, published: true }]);
      await sql(`update products set parent_id = ?::uuid, option_label = 'A' where id = ?::uuid`, [card.id, child.id]);
      return { card, child };
    };

    it('takes the store key BEFORE the family key when the card will gain a branch', async () => {
      const s = await seed();
      const home = await s.store('home');
      const x = await s.store('x');
      const { card, child } = await cardWithChildIn(s, home);

      const { guard, taken } = watchingGuard();
      // Publishes nothing, but creates the child's pivot in X — so the card
      // gains X, and the reconciliation will want X's store key.
      await servicesOn(pg.orm.em.fork() as EntityManager, guard).products.assignToStore(
        child.id,
        x.id,
        { price: 5 } as any,
        ACTOR as any,
      );

      const firstStore = taken.findIndex((k) => k.ns === 1);
      const firstFamily = taken.findIndex((k) => k.ns === 2);
      // Both kinds are taken at all — otherwise the ordering below is vacuous.
      expect(firstStore).toBeGreaterThanOrEqual(0);
      expect(firstFamily).toBeGreaterThanOrEqual(0);
      // THE ORDERING RULE: namespace 1 before namespace 2, always.
      expect(firstStore).toBeLessThan(firstFamily);
      expect((await pivot(card.id, x.id))?.published).toBe(true);
    });

    it('does not deadlock against a publishing write in the same branch', async () => {
      const s = await seed();
      const home = await s.store('home');
      const x = await s.store('x');
      const { card, child } = await cardWithChildIn(s, home);
      // A sibling already attached to X, hidden there: publishing it takes the
      // store key first and then the family key — the opposite order.
      const sibling = await s.product('sibling', [
        { storeId: home.id, published: true },
        { storeId: x.id, published: false },
      ]);
      await sql(`update products set parent_id = ?::uuid, option_label = 'B' where id = ?::uuid`, [
        card.id,
        sibling.id,
      ]);

      // Hold the first writer between its family key and the store key its
      // reconciliation needs, so the cycle has time to form.
      const holder = new PublicationGuardService();
      const original = holder.acquire.bind(holder);
      let seenFamily = false;
      let signal!: () => void;
      const paused = new Promise<void>((r) => (signal = r));
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      (holder as unknown as { acquire: unknown }).acquire = async (tem: EntityManager, keys: never[]) => {
        if (seenFamily && (keys as { ns: number }[]).some((k) => k.ns === 1)) {
          signal();
          await gate;
        }
        const ordered = await original(tem, keys);
        if (ordered.some((k) => k.ns === 2)) seenFamily = true;
        return ordered;
      };

      const first = servicesOn(pg.orm.em.fork() as EntityManager, holder)
        .products.assignToStore(child.id, x.id, { price: 5 } as any, ACTOR as any)
        .then(
          () => 'ok' as const,
          (e: any) => `failed: ${String(e?.message)}`,
        );

      // With the keys named up front this never pauses; the timeout is what
      // keeps the test honest if a future change reintroduces the gap.
      await Promise.race([paused, new Promise((r) => setTimeout(r, 2_000))]);

      const second = servicesOn(pg.orm.em.fork() as EntityManager)
        .products.assignToStore(sibling.id, x.id, { published: true } as any, ACTOR as any)
        .then(
          () => 'ok' as const,
          (e: any) => `failed: ${String(e?.message)}`,
        );

      await new Promise((r) => setTimeout(r, 1_000));
      release();
      // Against the inverted order this reports `deadlock detected`.
      expect(await first).toBe('ok');
      expect(await second).toBe('ok');
      expect((await pivot(card.id, x.id))?.published).toBe(true);
    });
  });
});
