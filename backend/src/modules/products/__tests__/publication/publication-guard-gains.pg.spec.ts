/* eslint-disable @typescript-eslint/no-explicit-any */
import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { RaceRecorder } from '../../../../../test/lock-race-support';
import { Product } from '../../entities/product.entity';
import { StoreProduct } from '../../entities/store-product.entity';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { storeIdOf } from '../../shared/store-membership.util';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * WHAT A CARD WOULD GAIN, READ ONCE (real PostgreSQL).
 *
 * `storesToGainForCards` names the store keys a writer has to hold before a
 * card is reconciled. It used to be three reads through the caller's identity
 * map — the card's children, their pivots, the card's pivots. It is now one
 * read, detached and without a flush.
 *
 * Three things are held here. That the one read answers what the three
 * answered for a card that is in the catalogue, including for the rows the
 * ORM's filters leave out. That for a card that is NOT — removed, with a child
 * still pointing at it — it names more stores and never fewer, and both
 * answers are written down. And that it leaves the caller's entities and the
 * caller's pending changes alone, which is the reason it was rewritten.
 */
d('what a card would gain, read once (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let race: RaceRecorder;
  const guard = new PublicationGuardService();

  const uid = (label: string) => `${label}-${Math.random().toString(16).slice(2, 10)}`;
  const sql = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => em.execute(text, params);

  /**
   * THE THREE READS, AS THEY WERE. The body of `storesToGainForCards` at
   * `c6f95b3`, statement for statement: the children of the cards, each
   * counted for the card ITS OWN loaded `parent` names; their pivots; the
   * cards' pivots. Kept as the reference the single read is compared with.
   *
   * The mapping through the child's loaded parent is part of what it did, and
   * is the step at which the two differ: a parent hidden by the removed filter
   * is loaded as no parent, and the child is then counted for no card.
   */
  const threeReads = async (
    tem: EntityManager,
    parentIds: string[],
    alsoGaining: string[] = [],
  ): Promise<Map<string, string[]>> => {
    const parentIdOf = (product: Product): string | null => {
      const parent = product.parent as unknown as { id?: string } | string | null | undefined;
      if (!parent) return null;
      return (typeof parent === 'string' ? parent : (parent.id ?? null)) || null;
    };
    const cards = Array.from(new Set(parentIds));
    const gained = new Map<string, Set<string>>(cards.map((card) => [card, new Set(alsoGaining)]));
    if (cards.length === 0) return new Map();

    const productIdOf = (link: StoreProduct): string => {
      const product = link.product as unknown as { id?: string } | string;
      return typeof product === 'string' ? product : (product.id as string);
    };
    const siblings = await tem.find(Product, { parent: { $in: cards } }, { refresh: true });
    const cardOf = new Map<string, string>();
    for (const sibling of siblings) {
      const card = parentIdOf(sibling);
      if (card) cardOf.set(sibling.id, card);
    }
    const links = siblings.length
      ? await tem.find(StoreProduct, { product: { $in: siblings.map((sibling) => sibling.id) } }, { refresh: true })
      : [];
    for (const link of links) {
      const card = cardOf.get(productIdOf(link));
      if (card) gained.get(card)?.add(storeIdOf(link));
    }
    const held = await tem.find(StoreProduct, { product: { $in: cards } }, { refresh: true });
    for (const link of held) gained.get(productIdOf(link))?.delete(storeIdOf(link));

    return new Map(Array.from(gained.entries()).map(([card, stores]) => [card, Array.from(stores)]));
  };
  const asItWas = async (cardId: string, alsoGaining: string[] = []): Promise<string[]> =>
    (await threeReads(pg.orm.em.fork() as EntityManager, [cardId], alsoGaining)).get(cardId) ?? [];

  const world = async (branches: string[]) => {
    const slug = uid('org');
    const [org] = await sql<{ id: string }>(
      `insert into organizations (name, slug, created_at, updated_at) values (?, ?, now(), now()) returning id`,
      [slug, slug],
    );
    const stores: Record<string, string> = {};
    for (const label of branches) {
      const name = uid(label);
      const [row] = await sql<{ id: string }>(
        `insert into stores (name, slug, organization_id, created_at, updated_at)
         values (?, ?, ?::uuid, now(), now()) returning id`,
        [name, name, org.id],
      );
      stores[label] = row.id;
      race.nameStore(row.id, label);
    }
    const product = async (
      label: string,
      links: { in: string; published?: boolean }[],
      parentId: string | null = null,
    ): Promise<string> => {
      const name = uid(label);
      const [row] = await sql<{ id: string }>(
        `insert into products
           (name, slug, organization_id, status, price, track_inventory, parent_id, option_label, created_at, updated_at)
         values (?, ?, ?::uuid, 'PUBLISHED', 10, false, ?::uuid, ?, now(), now()) returning id`,
        [name, name, org.id, parentId, parentId ? label : null],
      );
      race.nameProduct(row.id, label);
      for (const link of links) {
        await sql(
          `insert into store_products
             (organization_id, store_id, product_id, published, track_inventory, created_at, updated_at)
           values (?::uuid, ?::uuid, ?::uuid, ?, false, now(), now())`,
          [org.id, stores[link.in], row.id, link.published ?? true],
        );
      }
      return row.id;
    };
    const named = (storeIds: string[]) =>
      storeIds.map((id) => Object.entries(stores).find(([, value]) => value === id)?.[0] ?? id).sort();
    return { organizationId: org.id, stores, product, named };
  };

  /** The single read and the three reads, asked the same question. */
  const both = async (w: Awaited<ReturnType<typeof world>>, cardId: string, alsoGaining: string[] = []) => {
    const now = (await guard.storesToGainForCards(pg.orm.em.fork() as EntityManager, [cardId], alsoGaining)).get(
      cardId,
    );
    const one = await guard.storesToGain(pg.orm.em.fork() as EntityManager, cardId, alsoGaining);
    return {
      now: w.named(now ?? []),
      forOneCard: w.named(one),
      asItWas: w.named(await asItWas(cardId, alsoGaining)),
    };
  };
  const agreeing = (branches: string[]) => ({ now: branches, forOneCard: branches, asItWas: branches });

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    race = new RaceRecorder(pg);
  });
  afterAll(async () => {
    await pg?.close();
  });
  beforeEach(() => race.reset());

  describe('for a card in the catalogue, it answers what the three reads answered', () => {
    it('a card that is where its children are gains nothing', async () => {
      const w = await world(['A', 'B']);
      const card = await w.product('CARD', [{ in: 'A' }, { in: 'B' }]);
      await w.product('ONE', [{ in: 'A' }, { in: 'B' }], card);
      await w.product('TWO', [{ in: 'A' }], card);

      expect(await both(w, card)).toEqual(agreeing([]));
    });

    it('a card missing one branch a child is in gains that branch', async () => {
      const w = await world(['A', 'B', 'C']);
      const card = await w.product('CARD', [{ in: 'A' }, { in: 'C' }]);
      await w.product('ONE', [{ in: 'A' }, { in: 'B' }, { in: 'C' }], card);

      expect(await both(w, card)).toEqual(agreeing(['B']));
    });

    it('a card missing several branches, held by different children, gains them all', async () => {
      const w = await world(['A', 'B', 'C', 'D']);
      const card = await w.product('CARD', [{ in: 'A' }]);
      await w.product('ONE', [{ in: 'A' }, { in: 'B' }], card);
      await w.product('TWO', [{ in: 'C' }, { in: 'D' }], card);
      await w.product('THREE', [{ in: 'B' }, { in: 'D' }], card);

      expect(await both(w, card)).toEqual(agreeing(['B', 'C', 'D']));
    });

    it('a branch a child is HIDDEN in counts: it may be published there tomorrow', async () => {
      const w = await world(['A', 'B']);
      const card = await w.product('CARD', [{ in: 'A' }]);
      await w.product('ONE', [{ in: 'A' }, { in: 'B', published: false }], card);

      expect(await both(w, card)).toEqual(agreeing(['B']));
    });

    it('a branch the card is hidden in is a branch the card is in', async () => {
      const w = await world(['A', 'B']);
      const card = await w.product('CARD', [{ in: 'A' }, { in: 'B', published: false }]);
      await w.product('ONE', [{ in: 'A' }, { in: 'B' }], card);

      expect(await both(w, card)).toEqual(agreeing([]));
    });

    it('an ARCHIVED child still counts', async () => {
      const w = await world(['A', 'B']);
      const card = await w.product('CARD', [{ in: 'A' }]);
      await w.product('LIVE', [{ in: 'A' }], card);
      const archived = await w.product('ARCHIVED', [{ in: 'B' }], card);
      await sql(`update products set status = 'ARCHIVED', archived_at = now() where id = ?::uuid`, [archived]);

      expect(await both(w, card)).toEqual(agreeing(['B']));
    });

    it('a child REMOVED from the catalogue does not count, even one still pointing at the card', async () => {
      const w = await world(['A', 'B']);
      const card = await w.product('CARD', [{ in: 'A' }]);
      await w.product('LIVE', [{ in: 'A' }], card);
      const removed = await w.product('REMOVED', [{ in: 'B' }], card);
      // Removal clears a child's parent in the statement that removes it. An
      // attachment beside the removal of its member still leaves a removed
      // row that names its card (#337). The filter is what is under test, so
      // the row is written as the filter would have to meet it.
      await sql(`update products set removed_at = now() where id = ?::uuid`, [removed]);

      expect(await both(w, card)).toEqual(agreeing([]));
    });

    it('a branch REMOVED from the catalogue is not gained', async () => {
      const w = await world(['A', 'B']);
      const card = await w.product('CARD', [{ in: 'A' }]);
      await w.product('ONE', [{ in: 'A' }, { in: 'B' }], card);
      await sql(`update stores set removed_at = now() where id = ?::uuid`, [w.stores.B]);

      expect(await both(w, card)).toEqual(agreeing([]));
    });

    it('a removed branch the CARD is in no longer counts as held', async () => {
      const w = await world(['A', 'B']);
      const card = await w.product('CARD', [{ in: 'A' }, { in: 'B' }]);
      await w.product('ONE', [{ in: 'A' }, { in: 'B' }], card);
      await sql(`update stores set removed_at = now() where id = ?::uuid`, [w.stores.A]);

      expect(await both(w, card)).toEqual(agreeing([]));
    });

    it('a branch stated by the caller is gained unless the card is in it', async () => {
      const w = await world(['A', 'B', 'C']);
      const card = await w.product('CARD', [{ in: 'A' }]);
      await w.product('ONE', [{ in: 'A' }], card);

      expect(await both(w, card, [w.stores.A, w.stores.C])).toEqual(agreeing(['C']));
    });

    it('a card with no children gains only what the caller states', async () => {
      const w = await world(['A', 'B']);
      const lone = await w.product('LONE', [{ in: 'A' }]);

      expect(await both(w, lone)).toEqual(agreeing([]));
      expect(await both(w, lone, [w.stores.B])).toEqual(agreeing(['B']));
    });

    it('a product with no pivots at all gains what its children have', async () => {
      const w = await world(['A', 'B']);
      const card = await w.product('CARD', []);
      await w.product('ONE', [{ in: 'A' }, { in: 'B' }], card);

      expect(await both(w, card)).toEqual(agreeing(['A', 'B']));
    });

    it('many cards at once are each answered as they would be alone', async () => {
      const w = await world(['A', 'B', 'C']);
      const first = await w.product('FIRST', [{ in: 'A' }]);
      await w.product('FIRST-1', [{ in: 'A' }, { in: 'B' }], first);
      const second = await w.product('SECOND', [{ in: 'A' }, { in: 'B' }, { in: 'C' }]);
      await w.product('SECOND-1', [{ in: 'C' }], second);
      const third = await w.product('THIRD', [{ in: 'C' }]);
      await w.product('THIRD-1', [{ in: 'A' }], third);
      await w.product('THIRD-2', [{ in: 'B' }], third);
      const lone = await w.product('LONE', [{ in: 'B' }]);

      const together = await guard.storesToGainForCards(pg.orm.em.fork() as EntityManager, [
        first,
        second,
        third,
        lone,
        first,
      ]);

      const before = await threeReads(pg.orm.em.fork() as EntityManager, [first, second, third, lone, first]);

      expect(Array.from(together.keys()).sort()).toEqual([first, second, third, lone].sort());
      expect(Array.from(before.keys()).sort()).toEqual([first, second, third, lone].sort());
      for (const card of [first, second, third, lone]) {
        expect(w.named(together.get(card) ?? [])).toEqual(w.named(before.get(card) ?? []));
        expect(w.named(together.get(card) ?? [])).toEqual(w.named(await asItWas(card)));
      }
      expect(w.named(together.get(first) ?? [])).toEqual(['B']);
      expect(w.named(together.get(second) ?? [])).toEqual([]);
      expect(w.named(together.get(third) ?? [])).toEqual(['A', 'B']);
    });

    it('a card of another company is answered from its own rows, as it was', async () => {
      const mine = await world(['A', 'B']);
      const theirs = await world(['A', 'B']);
      const card = await mine.product('CARD', [{ in: 'A' }]);
      await mine.product('ONE', [{ in: 'A' }, { in: 'B' }], card);
      const other = await theirs.product('OTHER', [{ in: 'A' }]);
      await theirs.product('OTHER-1', [{ in: 'B' }], other);

      // No company is named by the read, and none was: each card is answered
      // by its own children, and neither sees the other's.
      expect(await both(mine, card)).toEqual(agreeing(['B']));
      expect(await both(theirs, other)).toEqual(agreeing(['B']));
    });
  });

  /**
   * THE ONE STATE IN WHICH THE TWO DIFFER. A card removed from the catalogue
   * while a child that is still in it points at the card. Removal, under the
   * card's family key, refuses a card with a child that has not been removed.
   * Attachment does not check under its keys that its card is still in the
   * catalogue, and beside the removal of its card it can produce this state
   * (#337). It is written here directly.
   *
   * The three reads loaded each child with its parent; the filter hid the
   * removed parent, the child was loaded with none, and it was counted for no
   * card. The single read never loads the parent. It answers with MORE stores
   * and never with fewer.
   *
   * What is held about the reconciliation is narrow. Asked from a transaction
   * that has NOT loaded the card, it issues none of the statements the
   * recorder labels and leaves the pivots as they were. A transaction that
   * holds the card loaded from before it was removed is not covered here.
   */
  describe('a removed card a child still points at: it names more, never fewer', () => {
    const removedCard = async () => {
      const w = await world(['A', 'B']);
      const card = await w.product('CARD', [{ in: 'A' }]);
      const child = await w.product('CHILD', [{ in: 'A' }, { in: 'B' }], card);
      await sql(`update products set removed_at = now() where id = ?::uuid`, [card]);
      return { w, card, child };
    };

    it('the three reads answered nothing; the single read answers with the child’s branches', async () => {
      const { w, card } = await removedCard();

      expect(await both(w, card)).toEqual({ now: ['A', 'B'], forOneCard: ['A', 'B'], asItWas: [] });
    });

    it('what the caller states is added to both, and that is all the three reads answered', async () => {
      const { w, card } = await removedCard();

      expect(await both(w, card, [w.stores.B])).toEqual({ now: ['A', 'B'], forOneCard: ['A', 'B'], asItWas: ['B'] });
    });

    it('every store the three reads named is among the ones the single read names', async () => {
      const { w, card } = await removedCard();

      for (const stated of [[], [w.stores.A], [w.stores.B], [w.stores.A, w.stores.B]]) {
        const { now, asItWas: before } = await both(w, card, stated);
        expect(now).toEqual(expect.arrayContaining(before));
      }
    });

    it('reconciling the removed card, from a transaction that has not loaded it, issues none of the statements the recorder labels', async () => {
      const { w, card, child } = await removedCard();
      const pivots = async (productId: string) =>
        w.named(
          (
            await sql<{ store_id: string }>(`select store_id from store_products where product_id = ?::uuid`, [
              productId,
            ])
          ).map((row) => row.store_id),
        );
      const fork = pg.orm.em.fork() as EntityManager;

      const outcome = await race.run('reconcile', () =>
        fork.transactional((tem) => guard.reconcileStoresOfParent(tem, card, w.organizationId)),
      ).settled;

      expect(outcome).toBe('completed');
      // The whole of what the recorder saw, not a search for what it should
      // not have seen: a recorder that attributed nothing would show nothing
      // either, and would not show the transaction. What it labels is an
      // advisory key in either of the guard's two forms, a FOR SHARE row lock,
      // a lock timeout, the child count, an insert or update on `products`,
      // and an insert, update or delete on `store_products`. It does not
      // label the lifecycle and organization keys, other row locks, or a
      // write to any other table, and this says nothing about those.
      expect(race.sequenceOf('reconcile')).toEqual(['BEGIN', 'COMMIT', 'SETTLED — completed']);
      expect(await pivots(card)).toEqual(['A']);
      expect(await pivots(child)).toEqual(['A', 'B']);
    });
  });

  describe('it leaves the caller alone', () => {
    it('is one statement, whatever the number of cards', async () => {
      const w = await world(['A', 'B']);
      const cards: string[] = [];
      for (let i = 0; i < 12; i += 1) {
        const card = await w.product(`CARD${i}`, [{ in: 'A' }]);
        await w.product(`CHILD${i}`, [{ in: 'A' }, { in: 'B' }], card);
        cards.push(card);
      }
      const connection: any = pg.orm.em.getDriver().getConnection();
      const execute = connection.execute;
      let statements = 0;
      connection.execute = function counted(...args: unknown[]) {
        statements += 1;
        return execute.apply(this, args);
      };
      try {
        const gained = await guard.storesToGainForCards(pg.orm.em.fork() as EntityManager, cards);
        expect(gained.size).toBe(12);
      } finally {
        connection.execute = execute;
      }

      expect(statements).toBe(1);
    });

    it('does not flush what the caller has pending, and does not refresh the entity it is editing', async () => {
      const w = await world(['A', 'B']);
      const card = await w.product('CARD', [{ in: 'A' }]);
      const childId = await w.product('CHILD', [{ in: 'A' }, { in: 'B' }], card);
      const renamed = uid('renamed');
      const fork = pg.orm.em.fork() as EntityManager;

      const outcome = await race.run('caller', () =>
        fork.transactional(async (tem) => {
          const child = await tem.findOne(Product, { id: childId });
          if (!child) throw new Error('the child was not found');
          child.name = renamed;

          const gained = await guard.storesToGainForCards(tem, [card]);

          expect(w.named(gained.get(card) ?? [])).toEqual(['B']);
          // Still the caller's edit, still unwritten.
          expect(child.name).toBe(renamed);
          expect(race.sequenceOf('caller').filter((label) => label.startsWith('UPDATE'))).toEqual([]);
          const [row] = await tem.execute(`select name from products where id = ?::uuid`, [childId]);
          expect(row.name).not.toBe(renamed);
        }),
      ).settled;

      expect(outcome).toBe('completed');
      // Written when the caller's transaction flushed, and not before.
      expect(race.sequenceOf('caller').filter((label) => label.startsWith('UPDATE'))).toEqual([
        'UPDATE products [CHILD]',
      ]);
      const [row] = await sql<{ name: string }>(`select name from products where id = ?::uuid`, [childId]);
      expect(row.name).toBe(renamed);
    });

    it('sees what the caller’s own transaction has already written', async () => {
      const w = await world(['A', 'B', 'C']);
      const card = await w.product('CARD', [{ in: 'A' }]);
      const child = await w.product('CHILD', [{ in: 'A' }], card);
      const fork = pg.orm.em.fork() as EntityManager;

      await fork.transactional(async (tem) => {
        await tem.execute(
          `insert into store_products
             (organization_id, store_id, product_id, published, track_inventory, created_at, updated_at)
           values (?::uuid, ?::uuid, ?::uuid, true, false, now(), now())`,
          [w.organizationId, w.stores.C, child],
        );

        const gained = await guard.storesToGainForCards(tem, [card]);

        expect(w.named(gained.get(card) ?? [])).toEqual(['C']);
        // And nobody outside the transaction does, yet.
        expect(w.named(await asItWas(card))).toEqual([]);
      });
    });

    it('hands back nothing the caller’s identity map then holds', async () => {
      const w = await world(['A', 'B']);
      const card = await w.product('CARD', [{ in: 'A' }]);
      await w.product('CHILD', [{ in: 'A' }, { in: 'B' }], card);
      const fork = pg.orm.em.fork() as EntityManager;

      await guard.storesToGainForCards(fork, [card]);

      expect(fork.getUnitOfWork().getIdentityMap().values()).toHaveLength(0);
    });
  });
});
