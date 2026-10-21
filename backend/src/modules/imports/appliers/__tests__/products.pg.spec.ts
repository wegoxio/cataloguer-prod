import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { ProductMutation, ProductsApplier, slugify } from '../products.applier';
import { PlannedUnit } from '../../execution/batch-planner';
import { RowOutcome } from '../../entities/import-row-result.entity';
import { PublicationGuardService } from '../../../products/publication/publication-guard.service';

/** The approver an execution runs under; appliers attribute writes to them. */
const APPROVER = '00000000-0000-4000-8000-000000000001';

/**
 * Writing products, against a real catalogue.
 *
 * Every case here is one the legacy importer got wrong or could not express:
 * a family committed whole, two shops that must not borrow each other's
 * prices, a publication that must not happen by accident, and an update that
 * must not blank a description nobody mapped.
 */

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

d('products applier (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let applier: ProductsApplier;
  let organizationId: string;
  let storeA: string;
  let storeB: string;
  let categoryId: string;

  const exec = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
    pg.orm.em.getConnection().execute(sql, params) as Promise<T>;

  const context = () => ({
    organizationId,
    executionId: randomUUID(),
    importType: 'PRODUCTS',
    approvedByUserId: APPROVER,
    em: pg.orm.em as EntityManager,
  });

  const unit = (mutations: ProductMutation[]): PlannedUnit =>
    ({ kind: 'ROW', sourceRows: mutations.map((m) => m.sourceRow), mutations }) as PlannedUnit;

  /**
   * Apply a unit the way the runner does: inside ONE transaction.
   *
   * These cases used to call `apply` directly, which no production caller
   * does. It mattered once the card's listing reconciliation began asserting
   * it is in a transaction — outside one its statements would autocommit, and
   * a rolled-back import would leave a card listed in a shop whose own rows
   * were undone.
   */
  const applyUnit = (u: PlannedUnit, ctx: ReturnType<typeof context> = context()) =>
    (pg.orm.em as EntityManager).transactional(async (tem) => applier.apply(u, { ...ctx, em: tem as EntityManager }));

  const product = (over: Partial<ProductMutation> = {}): ProductMutation => ({
    sourceRow: 2,
    fields: { name: 'Silla Nordic' },
    ...over,
  });

  const readProduct = async (id: string) =>
    (
      await exec<
        {
          name: string;
          slug: string;
          status: string;
          description: string | null;
          price: string;
          parent_id: string | null;
          option_label: string | null;
        }[]
      >(
        `select name, slug, status, description, price, parent_id, option_label
           from products where id = ?`,
        [id],
      )
    )[0];

  beforeAll(async () => {
    pg = await withDisposablePg();
    applier = new ProductsApplier(new PublicationGuardService());

    organizationId = (
      await exec<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), 'Prod Co', ?, now(), now()) returning id`,
        [`prod-co-${Date.now()}`],
      )
    )[0].id;

    const store = async (label: string) =>
      (
        await exec<{ id: string }[]>(
          `insert into stores (id, name, slug, organization_id, created_at, updated_at)
           values (gen_random_uuid(), ?, ?, ?, now(), now()) returning id`,
          [label, `${label}-${randomUUID().slice(0, 8)}`, organizationId],
        )
      )[0].id;

    storeA = await store('centro');
    storeB = await store('norte');

    categoryId = (
      await exec<{ id: string }[]>(
        `insert into categories (id, name, slug, organization_id, created_at, updated_at)
         values (gen_random_uuid(), 'Sillas', ?, ?, now(), now()) returning id`,
        [`sillas-${randomUUID().slice(0, 8)}`, organizationId],
      )
    )[0].id;
  }, 300_000);

  afterAll(async () => {
    await pg?.close();
  });

  describe('a standalone product', () => {
    it('is created as a DRAFT when the mapping said nothing about publishing', async () => {
      // Creating hundreds of published products from a spreadsheet is the
      // surprise this avoids.
      const [result] = await applyUnit(unit([product()]), context());
      expect(result.outcome).toBe(RowOutcome.CREATED);
      expect(result.reason).toMatch(/Created as a draft/);

      const row = await readProduct(result.targetId!);
      expect(row.status).toBe('DRAFT');
    });

    it('is published only when a mapped column said so', async () => {
      const [result] = await applyUnit(
        unit([product({ sourceRow: 3, fields: { name: 'Mesa Oslo', published: true } })]),
        context(),
      );
      expect((await readProduct(result.targetId!)).status).toBe('PUBLISHED');
    });

    it('gets a readable slug, suffixed when the name is taken', async () => {
      const first = await applyUnit(unit([product({ sourceRow: 4, fields: { name: 'Lámpara Roja' } })]), context());
      const second = await applyUnit(unit([product({ sourceRow: 5, fields: { name: 'Lámpara Roja' } })]), context());

      expect((await readProduct(first[0].targetId!)).slug).toBe('lampara-roja');
      expect((await readProduct(second[0].targetId!)).slug).toBe('lampara-roja-2');
    });

    it('refuses a row with no name rather than inventing one', async () => {
      const [result] = await applyUnit(unit([product({ sourceRow: 6, fields: { name: '  ' } })]), context());
      expect(result.outcome).toBe(RowOutcome.FAILED);
      expect(result.reason).toMatch(/no name/);
    });
  });

  describe('a family', () => {
    it('creates the parent and every variant, linked', async () => {
      const results = await applyUnit(
        unit([
          product({
            sourceRow: 10,
            fields: { name: 'Camiseta' },
            children: [
              { sourceRow: 11, fields: { name: 'Camiseta M', optionLabel: 'M' } },
              { sourceRow: 12, fields: { name: 'Camiseta L', optionLabel: 'L' } },
            ],
          }),
        ]),
        context(),
      );

      expect(results.map((r) => r.sourceRow)).toEqual([10, 11, 12]);
      expect(results.every((r) => r.outcome === RowOutcome.CREATED)).toBe(true);

      const parentId = results[0].targetId!;
      for (const child of results.slice(1)) {
        const row = await readProduct(child.targetId!);
        expect(row.parent_id).toBe(parentId);
      }
      expect((await readProduct(results[1].targetId!)).option_label).toBe('M');
    });

    /**
     * The card's listings are DERIVED from its children's, in the importer too.
     *
     * This path writes pivots with SQL and holds no entity graph, so it carries
     * its own statement of the rule that `PublicationGuardService` applies for
     * every ORM writer. These cases pin that the two reach the same rows — a
     * card listed exactly where its children are, no more and no less.
     */
    describe("the card's listings are derived from its children's", () => {
      const storesOf = async (productId: string): Promise<string[]> => {
        const rows = await exec<{ store_id: string }[]>(
          `select store_id from store_products where product_id = ?::uuid order by store_id`,
          [productId],
        );
        return rows.map((r) => r.store_id).sort();
      };

      it('lists the card in the union of its children stores', async () => {
        const results = await applyUnit(
          unit([
            product({
              sourceRow: 70,
              fields: { name: 'Union Tee' },
              children: [
                {
                  sourceRow: 71,
                  fields: { name: 'Union Tee M', optionLabel: 'M' },
                  storeValues: [{ storeId: storeA, published: true }],
                },
                {
                  sourceRow: 72,
                  fields: { name: 'Union Tee L', optionLabel: 'L' },
                  storeValues: [{ storeId: storeB, published: true }],
                },
              ],
            }),
          ]),
          context(),
        );

        expect(await storesOf(results[0].targetId!)).toEqual([storeA, storeB].sort());
      });

      it('drops a card listing the plan asked for in a store carrying no child', async () => {
        const results = await applyUnit(
          unit([
            product({
              sourceRow: 80,
              fields: { name: 'Stranded Tee' },
              // The plan lists the CARD in store B, but no child is sold there.
              storeValues: [
                { storeId: storeA, published: true },
                { storeId: storeB, published: true },
              ],
              children: [
                {
                  sourceRow: 81,
                  fields: { name: 'Stranded Tee M', optionLabel: 'M' },
                  storeValues: [{ storeId: storeA, published: true }],
                },
              ],
            }),
          ]),
          context(),
        );

        // The union wins: a card cannot be advertised where nothing of it sells.
        expect(await storesOf(results[0].targetId!)).toEqual([storeA]);
      });

      it('leaves a childless product entirely alone', async () => {
        const [result] = await applyUnit(
          unit([
            product({
              sourceRow: 90,
              fields: { name: 'Plain Tee' },
              storeValues: [
                { storeId: storeA, published: true },
                { storeId: storeB, published: true },
              ],
            }),
          ]),
          context(),
        );

        // No children, so nothing is derived — the plan's listings stand.
        expect(await storesOf(result.targetId!)).toEqual([storeA, storeB].sort());
      });
    });

    it('reports a result for the parent AND each variant', async () => {
      // The report has to account for every source row, including the ones
      // that only exist as children.
      const results = await applyUnit(
        unit([
          product({
            sourceRow: 20,
            fields: { name: 'Mesa' },
            children: [{ sourceRow: 21, fields: { name: 'Mesa 160' } }],
          }),
        ]),
        context(),
      );
      expect(results).toHaveLength(2);
    });
  });

  describe('two shops', () => {
    it('writes ONLY the shop the plan named', async () => {
      // A shop absent from the list is not written to at all — not set to a
      // default, not given the organization's price.
      const [result] = await applyUnit(
        unit([
          product({
            sourceRow: 30,
            fields: { name: 'Butaca' },
            storeValues: [{ storeId: storeA, price: 99.5, published: true }],
          }),
        ]),
        context(),
      );

      const pivots = await exec<{ store_id: string; price: string; published: boolean }[]>(
        `select store_id, price, published from store_products where product_id = ?`,
        [result.targetId],
      );
      expect(pivots).toHaveLength(1);
      expect(pivots[0].store_id).toBe(storeA);
      expect(Number(pivots[0].price)).toBe(99.5);
    });

    it('never copies the company price into a shop that has none', async () => {
      // One shop's commercial decisions stay its own.
      const [result] = await applyUnit(
        unit([
          product({
            sourceRow: 31,
            fields: { name: 'Taburete', price: 45 },
            storeValues: [{ storeId: storeA, published: true }],
          }),
        ]),
        context(),
      );

      const [pivot] = await exec<{ price: string | null }[]>(
        `select price from store_products where product_id = ? and store_id = ?`,
        [result.targetId, storeA],
      );
      expect(pivot.price).toBeNull();
    });

    it('leaves the other shop untouched when only one is named', async () => {
      const [created] = await applyUnit(
        unit([
          product({
            sourceRow: 32,
            fields: { name: 'Estantería' },
            storeValues: [
              { storeId: storeA, price: 10, published: true },
              { storeId: storeB, price: 20, published: false },
            ],
          }),
        ]),
        context(),
      );

      // A second import names only shop A.
      await applyUnit(
        unit([
          product({
            sourceRow: 33,
            targetId: created.targetId,
            fields: { price: 11 },
            storeValues: [{ storeId: storeA, price: 11 }],
          }),
        ]),
        context(),
      );

      const [b] = await exec<{ price: string; published: boolean }[]>(
        `select price, published from store_products where product_id = ? and store_id = ?`,
        [created.targetId, storeB],
      );
      expect(Number(b.price)).toBe(20);
      expect(b.published).toBe(false);
    });

    it('creates a new shop pivot unpublished unless told otherwise', async () => {
      const [result] = await applyUnit(
        unit([
          product({
            sourceRow: 34,
            fields: { name: 'Perchero' },
            storeValues: [{ storeId: storeB, price: 30 }],
          }),
        ]),
        context(),
      );

      const [pivot] = await exec<{ published: boolean }[]>(
        `select published from store_products where product_id = ? and store_id = ?`,
        [result.targetId, storeB],
      );
      expect(pivot.published).toBe(false);
    });
  });

  describe('stock', () => {
    it('is REFUSED, because the inventory ledger owns it', async () => {
      // Phase 5 made the ledger the single owner of what is in stock. A number
      // written here would immediately disagree with the ledger everything
      // else reads, so it is refused by name rather than dropped.
      const [result] = await applyUnit(
        unit([product({ sourceRow: 60, fields: { name: 'Con stock', stock: 40 } })]),
        context(),
      );
      expect(result.outcome).toBe(RowOutcome.BLOCKED);
      expect(result.reason).toMatch(/Stock cannot be set by a product import/);
      expect(result.reason).toMatch(/set opening balances from Inventory/);
    });

    it('is refused at shop level too', async () => {
      const [result] = await applyUnit(
        unit([
          product({
            sourceRow: 61,
            fields: { name: 'Con stock por tienda' },
            storeValues: [{ storeId: storeA, stock: 5 }],
          }),
        ]),
        context(),
      );
      expect(result.outcome).toBe(RowOutcome.BLOCKED);
    });

    it('blocks the whole family rather than half of it', async () => {
      const results = await applyUnit(
        unit([
          product({
            sourceRow: 62,
            fields: { name: 'Familia' },
            children: [{ sourceRow: 63, fields: { name: 'Variante', stock: 1 } }],
          }),
        ]),
        context(),
      );
      expect(results.map((r) => r.sourceRow)).toEqual([62, 63]);
      expect(results.every((r) => r.outcome === RowOutcome.BLOCKED)).toBe(true);
    });

    it('writes nothing at all when it refuses', async () => {
      const before = await exec<{ count: string }[]>(
        `select count(*)::text as count from products where organization_id = ?`,
        [organizationId],
      );
      await applyUnit(unit([product({ sourceRow: 64, fields: { name: 'Nada', stock: 1 } })]), context());
      const after = await exec<{ count: string }[]>(
        `select count(*)::text as count from products where organization_id = ?`,
        [organizationId],
      );
      expect(after[0].count).toBe(before[0].count);
    });
  });

  describe('updating an existing product', () => {
    let existingId: string;

    beforeAll(async () => {
      const [created] = await applyUnit(
        unit([
          product({
            sourceRow: 40,
            fields: {
              name: 'Sofá',
              description: 'Escrito a mano por el cliente',
              price: 500,
              published: true,
            },
          }),
        ]),
        context(),
      );
      existingId = created.targetId!;
    });

    it('writes only the fields the mapping provided', async () => {
      // A column the person did not map is a column they did not intend to
      // change, and blanking it would erase a description written by hand.
      const [result] = await applyUnit(
        unit([product({ sourceRow: 41, targetId: existingId, fields: { price: 550 } })]),
        context(),
      );

      expect(result.outcome).toBe(RowOutcome.UPDATED);
      const row = await readProduct(existingId);
      expect(Number(row.price)).toBe(550);
      expect(row.description).toBe('Escrito a mano por el cliente');
      expect(row.name).toBe('Sofá');
    });

    it('leaves publication alone when the mapping said nothing about it', async () => {
      await applyUnit(unit([product({ sourceRow: 42, targetId: existingId, fields: { price: 560 } })]), context());
      expect((await readProduct(existingId)).status).toBe('PUBLISHED');
    });

    it('unpublishes only when a mapped column said so', async () => {
      await applyUnit(
        unit([product({ sourceRow: 43, targetId: existingId, fields: { published: false } })]),
        context(),
      );
      expect((await readProduct(existingId)).status).toBe('DRAFT');
    });

    it('records the provenance of the match, so a wrong one is explainable', async () => {
      const [result] = await applyUnit(
        unit([
          product({
            sourceRow: 44,
            targetId: existingId,
            matchProvenance: 'INTERNAL_SKU',
            fields: { price: 570 },
          }),
        ]),
        context(),
      );
      expect(result.matchProvenance).toBe('INTERNAL_SKU');
    });

    it('FAILS rather than creating when the matched product has since gone', async () => {
      // Inventing a product here would apply a CREATE nobody approved.
      const [result] = await applyUnit(
        unit([product({ sourceRow: 45, targetId: randomUUID(), fields: { price: 1 } })]),
        context(),
      );
      expect(result.outcome).toBe(RowOutcome.FAILED);
      expect(result.reason).toMatch(/no longer exists/);
    });

    it('refuses to reach a product in another company', async () => {
      const otherOrg = (
        await exec<{ id: string }[]>(
          `insert into organizations (id, name, slug, created_at, updated_at)
           values (gen_random_uuid(), 'Otra', ?, now(), now()) returning id`,
          [`otra-${randomUUID().slice(0, 8)}`],
        )
      )[0].id;
      const foreign = (
        await exec<{ id: string }[]>(
          `insert into products (id, name, slug, status, organization_id, price, created_at, updated_at)
           values (gen_random_uuid(), 'Ajeno', ?, 'PUBLISHED', ?, 1, now(), now()) returning id`,
          [`ajeno-${randomUUID()}`, otherOrg],
        )
      )[0].id;

      const [result] = await applyUnit(
        unit([product({ sourceRow: 46, targetId: foreign, fields: { price: 999 } })]),
        context(),
      );

      // The UPDATE is scoped by organization, so it matches nothing.
      expect(result.outcome).toBe(RowOutcome.FAILED);
      const [row] = await exec<{ price: string }[]>(`select price from products where id = ?`, [foreign]);
      expect(Number(row.price)).toBe(1);
    });
  });

  describe('categories', () => {
    it('adds the categories the row names', async () => {
      const [result] = await applyUnit(
        unit([product({ sourceRow: 50, fields: { name: 'Silla Roja' }, categoryIds: [categoryId] })]),
        context(),
      );

      const links = await exec<{ category_id: string }[]>(
        `select category_id from product_categories where product_id = ?`,
        [result.targetId],
      );
      expect(links.map((l) => l.category_id)).toEqual([categoryId]);
    });

    it('does not un-file a product from categories the row does not mention', async () => {
      // A spreadsheet column rarely lists every category a product is already
      // in, and treating it as authoritative would silently un-file things.
      const [created] = await applyUnit(
        unit([product({ sourceRow: 51, fields: { name: 'Silla Verde' }, categoryIds: [categoryId] })]),
        context(),
      );
      await applyUnit(unit([product({ sourceRow: 52, targetId: created.targetId, fields: { price: 5 } })]), context());

      const links = await exec<{ category_id: string }[]>(
        `select category_id from product_categories where product_id = ?`,
        [created.targetId],
      );
      expect(links).toHaveLength(1);
    });

    it('adding the same category twice is harmless', async () => {
      const [created] = await applyUnit(
        unit([product({ sourceRow: 53, fields: { name: 'Silla Azul' }, categoryIds: [categoryId] })]),
        context(),
      );
      await applyUnit(
        unit([product({ sourceRow: 54, targetId: created.targetId, fields: {}, categoryIds: [categoryId] })]),
        context(),
      );

      const links = await exec<{ count: string }[]>(
        `select count(*)::text as count from product_categories where product_id = ?`,
        [created.targetId],
      );
      expect(Number(links[0].count)).toBe(1);
    });
  });
});

describe('slugs', () => {
  it('folds accents and punctuation into something readable', () => {
    expect(slugify('Lámpara Roja')).toBe('lampara-roja');
    expect(slugify('Mesa "Oslo" / Comedor')).toBe('mesa-oslo-comedor');
    expect(slugify('  espacios  ')).toBe('espacios');
  });

  it('never produces leading or trailing separators', () => {
    expect(slugify('---abc---')).toBe('abc');
    expect(slugify('!!!')).toBe('');
  });
});

if (!gate.enabled) {
  // eslint-disable-next-line no-console
  console.log(`products applier PG suite skipped: ${gate.reason}`);
}
