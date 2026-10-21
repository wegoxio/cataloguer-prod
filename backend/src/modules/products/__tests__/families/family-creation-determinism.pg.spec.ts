import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { ProductsService } from '../../catalogue/products.service';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { ProductFieldDefinition } from '../../entities/product-field-definition.entity';
import { Product } from '../../entities/product.entity';
import { realStock } from '../../../../../test/inventory-stock-support';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;
const ACTOR = { id: '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e', email: 'op@e.test' } as any;

/**
 * What `createFamily` guarantees about the card it mints, and about labels.
 *
 * Manual grouping (PR B) hands this endpoint a user's selection, so two things
 * that did not matter when only the suggestion heuristic called it now do:
 *
 *   - the card's status and sorting price must NOT depend on the order the
 *     members happen to arrive in. A person selecting the same three items in a
 *     different order must get the same card;
 *   - the labels a person types must be usable. A blank label leaves a selector
 *     option nobody can read, and two labels that differ only in case leave two
 *     options a shopper cannot tell apart.
 */
d('family creation: determinism and labels (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let products: ProductsService;
  let ORG: string;
  let STORE: string;

  const exec = async <T>(sql: string, params: unknown[] = []): Promise<T> => em.execute(sql, params) as Promise<T>;
  const uid = (l: string) => `${l}-${randomUUID().slice(0, 8)}`;

  const mkProduct = async (over: { price?: number; status?: string } = {}) => {
    const name = uid('p');
    const [row] = await exec<{ id: string }[]>(
      `insert into products (id, name, slug, organization_id, status, price, track_inventory, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?::uuid, ?, ?, false, now(), now()) returning id`,
      [name, name, ORG, over.status ?? 'PUBLISHED', over.price ?? 10],
    );
    await exec(
      `insert into store_products (id, organization_id, store_id, product_id, published, track_inventory, created_at, updated_at)
       values (gen_random_uuid(), ?::uuid, ?::uuid, ?::uuid, true, false, now(), now())`,
      [ORG, STORE, row.id],
    );
    return row.id;
  };

  const parentOf = async (id: string) =>
    (await exec<{ status: string; price: string }[]>(`select status, price from products where id = ?::uuid`, [id]))[0];

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    const guard = new PublicationGuardService();
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
    ORG = (
      await exec<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), 'Det Co', ?, now(), now()) returning id`,
        [uid('det')],
      )
    )[0].id;
    STORE = (
      await exec<{ id: string }[]>(
        `insert into stores (id, name, slug, organization_id, created_at, updated_at)
         values (gen_random_uuid(), 'Centro', ?, ?::uuid, now(), now()) returning id`,
        [uid('centro'), ORG],
      )
    )[0].id;
  }, 300_000);

  afterAll(async () => {
    if (pg) await pg.close();
  });

  /** Everything creating a family would touch, so "wrote nothing" is checkable. */
  const census = async () => ({
    products: (
      await exec<{ n: number }[]>(`select count(*)::int n from products where organization_id=?::uuid`, [ORG])
    )[0].n,
    pivots: (
      await exec<{ n: number }[]>(`select count(*)::int n from store_products where organization_id=?::uuid`, [ORG])
    )[0].n,
    parented: (
      await exec<{ n: number }[]>(
        `select count(*)::int n from products where organization_id=?::uuid and parent_id is not null`,
        [ORG],
      )
    )[0].n,
    labels: (
      await exec<{ n: number }[]>(
        // `option_label` is the COLUMN; `optionLabel` is the property and the wire
        // spelling (ADR 018 kept the column through the rollback window).
        `select count(*)::int n from products where organization_id=?::uuid and option_label is not null`,
        [ORG],
      )
    )[0].n,
    audit: (await exec<{ n: number }[]>(`select count(*)::int n from audit_logs`))[0].n,
    vocab: (await exec<{ n: number }[]>(`select count(*)::int n from family_vocabulary`))[0].n,
  });

  describe('the card does not depend on the order members arrive in', () => {
    it('copies the LOWEST base price whatever order the caller sends', async () => {
      const cheap = await mkProduct({ price: 10 });
      const mid = await mkProduct({ price: 20 });
      const dear = await mkProduct({ price: 30 });

      const a = await products.createFamily(
        uid('fam'),
        [
          { id: dear, label: 'L' },
          { id: mid, label: 'M' },
          { id: cheap, label: 'S' },
        ],
        ACTOR,
      );
      const b = await products.createFamily(
        uid('fam'),
        [
          { id: await mkProduct({ price: 30 }), label: 'L' },
          { id: await mkProduct({ price: 10 }), label: 'S' },
          { id: await mkProduct({ price: 20 }), label: 'M' },
        ],
        ACTOR,
      );

      // The same set in a different order must produce the same card price.
      expect(Number((await parentOf(a.id)).price)).toBe(10);
      expect(Number((await parentOf(b.id)).price)).toBe(10);
    });

    it('breaks a price tie on product id, so equal prices are still deterministic', async () => {
      const one = await mkProduct({ price: 15 });
      const two = await mkProduct({ price: 15 });
      const lowestId = [one, two].sort()[0];
      const expected = (await parentOf(lowestId)).status;

      const created = await products.createFamily(
        uid('fam'),
        [
          { id: two, label: 'B' },
          { id: one, label: 'A' },
        ],
        ACTOR,
      );
      expect(Number((await parentOf(created.id)).price)).toBe(15);
      expect((await parentOf(created.id)).status).toBe(expected);
    });

    it('takes the status the members AGREE on, whatever order they arrive in', async () => {
      // This used to assert which of two DISAGREEING members won. That question
      // no longer has an answer worth having: a mixed selection is refused
      // outright (see "every member must share one publication status"), so all
      // that is left to guarantee is that agreement survives the reordering.
      const cheap = await mkProduct({ price: 5, status: 'DRAFT' });
      const dear = await mkProduct({ price: 50, status: 'DRAFT' });

      const created = await products.createFamily(
        uid('fam'),
        [
          { id: dear, label: 'Big' },
          { id: cheap, label: 'Small' },
        ],
        ACTOR,
      );
      const card = await parentOf(created.id);
      expect(Number(card.price)).toBe(5);
      expect(card.status).toBe('DRAFT');
    });
  });

  describe('labels must be usable', () => {
    it('refuses a blank label', async () => {
      const a = await mkProduct();
      const b = await mkProduct();
      await expect(
        products.createFamily(
          uid('fam'),
          [
            { id: a, label: 'Small' },
            { id: b, label: '   ' },
          ],
          ACTOR,
        ),
      ).rejects.toThrow(/label cannot be empty/i);
    });

    it('refuses two labels that differ only in case', async () => {
      const a = await mkProduct();
      const b = await mkProduct();
      await expect(
        products.createFamily(
          uid('fam'),
          [
            { id: a, label: 'Verde' },
            { id: b, label: 'verde' },
          ],
          ACTOR,
        ),
      ).rejects.toThrow(/could not tell them apart/i);
    });

    it('refuses duplicates ignoring surrounding space', async () => {
      const a = await mkProduct();
      const b = await mkProduct();
      await expect(
        products.createFamily(
          uid('fam'),
          [
            { id: a, label: 'Rojo' },
            { id: b, label: ' Rojo ' },
          ],
          ACTOR,
        ),
      ).rejects.toThrow(/could not tell them apart/i);
    });

    it('writes nothing when a label is refused', async () => {
      const a = await mkProduct();
      const b = await mkProduct();
      const before = (
        await exec<{ n: number }[]>(`select count(*)::int n from products where organization_id = ?::uuid`, [ORG])
      )[0].n;

      await products
        .createFamily(
          uid('fam'),
          [
            { id: a, label: 'X' },
            { id: b, label: 'x' },
          ],
          ACTOR,
        )
        .catch(() => undefined);

      const after = (
        await exec<{ n: number }[]>(`select count(*)::int n from products where organization_id = ?::uuid`, [ORG])
      )[0].n;
      expect(after).toBe(before);
      const [child] = await exec<{ parent_id: string | null }[]>(`select parent_id from products where id = ?::uuid`, [
        a,
      ]);
      expect(child.parent_id).toBeNull();
    });

    it('accepts distinct labels', async () => {
      const a = await mkProduct();
      const b = await mkProduct();
      const created = await products.createFamily(
        uid('fam'),
        [
          { id: a, label: 'Small' },
          { id: b, label: 'Large' },
        ],
        ACTOR,
      );
      expect(created.members).toBe(2);
    });
  });
  /**
   * The preflight answers the same question and writes nothing.
   */
  describe('the advisory preflight', () => {
    it('accepts a grouping the real call would accept, and writes NOTHING', async () => {
      const a = await mkProduct();
      const b = await mkProduct();
      const before = await census();

      const verdict = await products.validateFamilyCreation(uid('fam'), [
        { id: a, label: 'Small' },
        { id: b, label: 'Large' },
      ]);

      expect(verdict).toEqual({ ok: true, problem: null });
      // No product, no pivot, no audit entry, no learned vocabulary.
      expect(await census()).toEqual(before);
    });

    it('refuses what the real call refuses, and still writes nothing', async () => {
      const a = await mkProduct();
      const b = await mkProduct();
      const before = await census();

      const dupe = await products.validateFamilyCreation(uid('fam'), [
        { id: a, label: 'Verde' },
        { id: b, label: 'verde' },
      ]);
      const blank = await products.validateFamilyCreation(uid('fam'), [
        { id: a, label: 'Verde' },
        { id: b, label: '  ' },
      ]);
      const tooFew = await products.validateFamilyCreation(uid('fam'), [{ id: a, label: 'Verde' }]);

      expect(dupe.ok).toBe(false);
      expect(dupe.problem?.message).toMatch(/could not tell them apart/i);
      expect(blank.ok).toBe(false);
      expect(blank.problem?.message).toMatch(/label cannot be empty/i);
      expect(tooFew.ok).toBe(false);
      expect(tooFew.problem?.message).toMatch(/at least two/i);
      expect(await census()).toEqual(before);
    });

    it('refuses an item that is already a child, and names it', async () => {
      const a = await mkProduct();
      const b = await mkProduct();
      await products.createFamily(
        uid('fam'),
        [
          { id: a, label: 'S' },
          { id: b, label: 'L' },
        ],
        ACTOR,
      );
      const c = await mkProduct();
      const before = await census();

      const verdict = await products.validateFamilyCreation(uid('fam'), [
        { id: a, label: 'S' },
        { id: c, label: 'M' },
      ]);
      expect(verdict.ok).toBe(false);
      expect(verdict.problem?.message).toMatch(/already a child/i);
      expect(await census()).toEqual(before);
    });

    it('is ADVISORY: a verdict can go stale, and the transaction is what decides', async () => {
      const a = await mkProduct();
      const b = await mkProduct();
      const ok = await products.validateFamilyCreation(uid('fam'), [
        { id: a, label: 'S' },
        { id: b, label: 'L' },
      ]);
      expect(ok.ok).toBe(true);

      // Somebody else groups `a` between the preview and the confirmation.
      const other = await mkProduct();
      await products.createFamily(
        uid('other'),
        [
          { id: a, label: 'S' },
          { id: other, label: 'L' },
        ],
        ACTOR,
      );

      // The stale "ok" does not make the real call succeed.
      await expect(
        products.createFamily(
          uid('fam'),
          [
            { id: a, label: 'S' },
            { id: b, label: 'L' },
          ],
          ACTOR,
        ),
      ).rejects.toThrow(/already a child/i);
      // ...and `b` was not quietly grouped by the failed attempt.
      const [row] = await exec<{ parent_id: string | null }[]>(`select parent_id from products where id = ?::uuid`, [
        b,
      ]);
      expect(row.parent_id).toBeNull();
    });
  });

  /**
   * ONE publication status per family.
   *
   * The interface refused to offer the button for a mixed selection, but the
   * endpoint accepted one — and deterministic ordering only made the arbitrary
   * outcome repeatable. A direct API request is the case that matters: nothing
   * in front of it was enforcing the rule.
   */
  describe('every member must share one publication status', () => {
    const mixed = async () => ({
      live: await mkProduct({ status: 'PUBLISHED' }),
      draft: await mkProduct({ status: 'DRAFT' }),
    });

    it('creation refuses a mixed selection, and writes NOTHING', async () => {
      const { live, draft } = await mixed();
      const before = await census();

      await expect(
        products.createFamily(
          uid('fam'),
          [
            { id: live, label: 'Live' },
            { id: draft, label: 'Draft' },
          ],
          ACTOR,
        ),
      ).rejects.toThrow(/not all published or all draft/i);

      // No card, no relationship, no label, no pivot, no audit, no vocabulary.
      expect(await census()).toEqual(before);
    });

    it('refuses the same way with the members REVERSED, naming the same pair', async () => {
      const { live, draft } = await mixed();

      const forward = await products
        .createFamily(
          uid('fam'),
          [
            { id: live, label: 'A' },
            { id: draft, label: 'B' },
          ],
          ACTOR,
        )
        .catch((e) => e);
      const backward = await products
        .createFamily(
          uid('fam'),
          [
            { id: draft, label: 'B' },
            { id: live, label: 'A' },
          ],
          ACTOR,
        )
        .catch((e) => e);

      expect(forward.message).toMatch(/not all published or all draft/i);
      // The refusal is a property of the SELECTION: same sentence, same two
      // products named, whichever order they were sent in.
      expect(backward.message).toBe(forward.message);
    });

    it('preflight refuses it too, in both orders, and writes nothing', async () => {
      const { live, draft } = await mixed();
      const before = await census();

      const forward = await products.validateFamilyCreation(uid('fam'), [
        { id: live, label: 'A' },
        { id: draft, label: 'B' },
      ]);
      const backward = await products.validateFamilyCreation(uid('fam'), [
        { id: draft, label: 'B' },
        { id: live, label: 'A' },
      ]);

      expect(forward.ok).toBe(false);
      expect(forward.problem?.message).toMatch(/not all published or all draft/i);
      expect(backward.problem?.message).toBe(forward.problem?.message);
      // It names the product a reader has to act on.
      expect(forward.problem?.productId).toBe(backward.problem?.productId);
      expect([live, draft]).toContain(forward.problem?.productId);
      expect(await census()).toEqual(before);
    });

    /**
     * The prelude runs TWICE inside creation: once before anything is written,
     * and once after the advisory locks are held. This proves the second pass
     * is load-bearing — that it is not a decoration on top of the first.
     *
     * The competing write has to land in the window BETWEEN the two passes, so
     * it is made from a separate entity manager (its own connection, its own
     * transaction) at the one point the creation is guaranteed to be between
     * them: while it is minting the card's slug. Nothing about the seam is
     * synthetic — the row it changes is one the first pass merely read, so no
     * lock is held on it and the outside commit succeeds exactly as another
     * request's would.
     */
    it('re-checks under the locks: a member grouped after the first pass is refused', async () => {
      const a = await mkProduct();
      const b = await mkProduct();
      const elsewhere = await mkProduct();
      const host = await products.createFamily(
        uid('host'),
        [
          { id: elsewhere, label: 'X' },
          { id: await mkProduct(), label: 'Y' },
        ],
        ACTOR,
      );

      const outside = pg.orm.em.fork() as EntityManager;
      const slug = jest.spyOn(products as any, 'uniqueProductSlug');
      slug.mockImplementation(async (...args: any[]) => {
        // Somebody else files `a` under an existing card, and commits.
        await outside.execute(`update products set parent_id = ?::uuid where id = ?::uuid`, [host.id, a]);
        slug.mockRestore();
        return (products as any).uniqueProductSlug(...args);
      });

      const before = await census();
      await expect(
        products.createFamily(
          uid('fam'),
          [
            { id: a, label: 'A' },
            { id: b, label: 'B' },
          ],
          ACTOR,
        ),
      ).rejects.toThrow(/already a child/i);
      slug.mockRestore();

      // The card the doomed attempt had already minted went down with it, and
      // `b` was not quietly attached to anything.
      const after = await census();
      expect(after.products).toBe(before.products);
      expect(after.pivots).toBe(before.pivots);
      const [row] = await exec<{ parent_id: string | null }[]>(`select parent_id from products where id = ?::uuid`, [
        b,
      ]);
      expect(row.parent_id).toBeNull();
    });

    it('still accepts a selection that agrees', async () => {
      const a = await mkProduct({ status: 'DRAFT' });
      const b = await mkProduct({ status: 'DRAFT' });
      const verdict = await products.validateFamilyCreation(uid('fam'), [
        { id: a, label: 'A' },
        { id: b, label: 'B' },
      ]);
      expect(verdict).toEqual({ ok: true, problem: null });
      const created = await products.createFamily(
        uid('fam'),
        [
          { id: a, label: 'A' },
          { id: b, label: 'B' },
        ],
        ACTOR,
      );
      expect((await parentOf(created.id)).status).toBe('DRAFT');
    });
  });

  /**
   * Specification applicability, asked the same way twice.
   *
   * `validateFamilyCreation` used to stop before this check, so a member
   * holding a PARENT-only value was told the grouping was fine and refused
   * only at the confirmation. Both paths now run the one prelude, and these
   * tests are what would notice if they stopped doing so.
   */
  describe('specification applicability, in preflight and in creation', () => {
    /** A definition only a card may carry, and a member that carries one. */
    const conflicted = async () => {
      const [def] = await exec<{ id: string }[]>(
        `insert into product_field_definitions (organization_id, key, label, type, applicability, created_at, updated_at)
         values (?::uuid, ?, 'Parent only', 'TEXT', 'PARENT', now(), now()) returning id`,
        [ORG, `parentonly${randomUUID().slice(0, 8).replace(/-/g, '')}`],
      );
      const offender = await mkProduct();
      const clean = await mkProduct();
      await exec(
        `insert into product_field_values (organization_id, product_id, definition_id, definition_type, value_text, created_at, updated_at)
         values (?::uuid, ?::uuid, ?::uuid, 'TEXT', 'oak', now(), now())`,
        [ORG, offender, def.id],
      );
      return { offender, clean };
    };

    it('preflight rejects a static specification conflict, and writes nothing', async () => {
      const { offender, clean } = await conflicted();
      const before = await census();

      const verdict = await products.validateFamilyCreation(uid('fam'), [
        { id: offender, label: 'A' },
        { id: clean, label: 'B' },
      ]);

      expect(verdict.ok).toBe(false);
      expect(verdict.problem?.message).toMatch(/specification values/i);
      expect(await census()).toEqual(before);
    });

    it('creation rejects the SAME conflict, with a compatible reason, and writes nothing', async () => {
      const { offender, clean } = await conflicted();
      const preflight = await products.validateFamilyCreation(uid('fam'), [
        { id: offender, label: 'A' },
        { id: clean, label: 'B' },
      ]);
      const before = await census();

      const refusal = await products
        .createFamily(
          uid('fam'),
          [
            { id: offender, label: 'A' },
            { id: clean, label: 'B' },
          ],
          ACTOR,
        )
        .catch((e) => e);

      // Same sentence out of both paths — the preflight reads it off
      // `response`, the thrown error carries it there too.
      const thrown = refusal?.response?.message ?? refusal?.message;
      expect(thrown).toBe(preflight.problem?.message);
      expect(thrown).toMatch(/specification values/i);
      expect(await census()).toEqual(before);
    });
  });
});
