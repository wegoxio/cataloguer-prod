import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../test/pg-harness';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * #292 is TWO migrations, and every reversal below is driven one step at a
 * time with a bare `down()`.
 *
 * `down({ to })` was tried first and is the wrong tool here: it reverts THROUGH
 * the named migration rather than stopping above it, so "revert only the
 * triggers" silently took the columns with it and a passing assertion would
 * have meant nothing. One step is unambiguous.
 */
const LIFECYCLE_COLUMNS = 'Migration20260911120000';
const LIFECYCLE_TRIGGERS = 'Migration20260911130000';

/**
 * SLICE C'S OWN DATABASE OBJECTS, NAMED.
 *
 * This suite used to count `wegox_%removed%` across the whole schema, which was
 * correct exactly until another slice added objects to the same namespace —
 * #293's store triggers did, and every count in this file went wrong at once.
 * A suite about ONE migration must measure that migration, so the three
 * functions #292 creates are named and the triggers are counted by which of
 * them they call.
 */
const SLICE_C_FUNCTIONS = [
  'wegox_refuse_dependency_on_removed_product',
  'wegox_refuse_dependency_on_removed_category',
  'wegox_refuse_child_of_removed_category',
];

/**
 * #292's MIGRATIONS, UP, DOWN AND UP AGAIN.
 *
 * Two properties matter here and they pull in opposite directions.
 *
 *   1. The migrations must be REVERSIBLE on a database that has not yet been
 *      used: a rollout that cannot be undone before anyone has removed anything
 *      is a rollout nobody can rehearse.
 *   2. They must REFUSE to reverse once the feature has been used. Dropping
 *      `removed_at` destroys every removed record silently — the row stops
 *      being removed and reappears in the catalogue — and restoring a TOTAL
 *      unique index over identifiers that a removal deliberately freed cannot
 *      work at all if two rows now hold one.
 *
 * The second is why a `down` here is a separate owner decision and never an
 * automatic part of an application rollback. This suite is the proof that the
 * refusal is real rather than documented.
 */
d('#292 · migration reversibility (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;

  const sql = async <T = any>(text: string, params: unknown[] = []): Promise<T[]> => em.execute(text, params);
  const migrator = () => pg.orm.getMigrator();
  /** One step back: the trigger migration. */
  const revertTriggers = () => migrator().down();
  /** The step after that: the lifecycle columns and the partial indexes. */
  const revertColumns = () => migrator().down();
  const applied = async (): Promise<string[]> =>
    (await migrator().getExecutedMigrations()).map((entry) => entry.name.replace(/\.[tj]s$/, ''));

  const columnExists = async (table: string, column: string): Promise<boolean> => {
    const rows = await sql<{ n: number }>(
      `select count(*)::int as n from information_schema.columns
        where table_schema = 'public' and table_name = ? and column_name = ?`,
      [table, column],
    );
    return rows[0].n > 0;
  };
  const indexDef = async (name: string): Promise<string | null> => {
    const rows = await sql<{ indexdef: string }>(`select indexdef from pg_indexes where indexname = ?`, [name]);
    return rows[0]?.indexdef ?? null;
  };
  /** The table-constraint rows PostgreSQL reports for a name, if any. */
  const constraintType = async (name: string): Promise<string | null> => {
    const rows = await sql<{ constraint_type: string }>(
      `select constraint_type from information_schema.table_constraints
        where table_schema = 'public' and constraint_name = ?`,
      [name],
    );
    return rows[0]?.constraint_type ?? null;
  };

  /** Triggers that call one of #292's functions — not every trigger that looks like one. */
  const triggerCount = async (): Promise<number> => {
    const rows = await sql<{ n: number }>(
      `select count(*)::int as n
         from pg_trigger t
         join pg_proc p on p.oid = t.tgfoid
        where p.proname in (?) and not t.tgisinternal`,
      [SLICE_C_FUNCTIONS],
    );
    return rows[0].n;
  };
  const functionCount = async (): Promise<number> => {
    const rows = await sql<{ n: number }>(`select count(*)::int as n from pg_proc where proname in (?)`, [
      SLICE_C_FUNCTIONS,
    ]);
    return rows[0].n;
  };

  const seedOrganization = async (): Promise<string> => {
    const slug = `org-${Math.random().toString(16).slice(2, 10)}`;
    const [row] = await sql<{ id: string }>(
      `insert into organizations (name, slug, created_at, updated_at) values (?, ?, now(), now()) returning id`,
      [slug, slug],
    );
    return row.id;
  };
  const seedProduct = async (organizationId: string, slug: string, sku: string | null = null): Promise<string> => {
    const [row] = await sql<{ id: string }>(
      `insert into products (name, slug, sku, organization_id, status, price, track_inventory, created_at, updated_at)
       values (?, ?, ?, ?::uuid, 'PUBLISHED', 10, false, now(), now()) returning id`,
      [slug, slug, sku, organizationId],
    );
    return row.id;
  };

  /**
   * PUT #292 BACK ON TOP OF THE STACK BEFORE MEASURING IT.
   *
   * `revertTriggers` and `revertColumns` are single `down()` steps, which is
   * deliberate — `down({ to })` reverts THROUGH the named migration rather than
   * stopping above it, so "revert only the triggers" would silently take the
   * columns too. But a single step is a step from the TOP, and #293 put two
   * migrations above these. Without this the first `down()` reverted a store
   * migration and every assertion below was about the wrong thing.
   *
   * So each case first unwinds whatever a later slice added, one step at a
   * time, until #292's trigger migration is the newest applied. The loop is
   * bounded and asserts what it reached, so a future slice that changes the
   * ordering fails here loudly instead of silently measuring its own work.
   */
  const rewindToSliceC = async (): Promise<void> => {
    for (let step = 0; step < 20; step += 1) {
      const executed = await applied();
      const newest = executed[executed.length - 1];
      if (newest === LIFECYCLE_TRIGGERS) return;
      if (!newest || newest < LIFECYCLE_TRIGGERS) break;
      await migrator().down();
    }
    const executed = await applied();
    throw new Error(
      `could not rewind to ${LIFECYCLE_TRIGGERS}; newest applied is ${executed[executed.length - 1] ?? '(none)'}`,
    );
  };

  beforeEach(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    await rewindToSliceC();
  }, 300_000);

  afterEach(async () => {
    if (pg) await pg.close();
  });

  describe('on an unused database', () => {
    it('applies both migrations: columns, partial indexes, triggers and functions', async () => {
      expect(await columnExists('products', 'removed_at')).toBe(true);
      expect(await columnExists('products', 'removal_tombstone')).toBe(true);
      expect(await columnExists('categories', 'removed_at')).toBe(true);

      // PARTIAL, and each keeping the semantics it already had.
      expect(await indexDef('products_organization_id_slug_unique')).toContain('WHERE (removed_at IS NULL)');
      const sku = await indexDef('products_organization_id_sku_unique');
      expect(sku).toContain('sku IS NOT NULL');
      expect(sku).toContain('removed_at IS NULL');
      expect(await indexDef('categories_organization_id_slug_unique')).toContain('WHERE (removed_at IS NULL)');

      // NOT touched: this is the composite key the tenancy foreign keys point
      // at, not an identity constraint.
      const composite = await indexDef('categories_id_organization_id_unique');
      expect(composite).not.toBeNull();
      expect(composite).not.toContain('WHERE');

      expect(await triggerCount()).toBeGreaterThanOrEqual(20);
      expect(await functionCount()).toBe(3);
    });

    it('reverses cleanly, leaving no column, no partial index, no trigger and no function', async () => {
      await revertTriggers();
      await revertColumns();
      expect(await applied()).not.toContain(LIFECYCLE_COLUMNS);
      expect(await applied()).not.toContain(LIFECYCLE_TRIGGERS);

      expect(await columnExists('products', 'removed_at')).toBe(false);
      expect(await columnExists('products', 'removal_tombstone')).toBe(false);
      expect(await columnExists('categories', 'removed_at')).toBe(false);
      expect(await triggerCount()).toBe(0);
      expect(await functionCount()).toBe(0);

      // The TOTAL rules are back, with their original semantics.
      expect(await indexDef('products_organization_id_slug_unique')).not.toContain('removed_at');
      const sku = await indexDef('products_organization_id_sku_unique');
      expect(sku).toContain('sku IS NOT NULL');
      expect(sku).not.toContain('removed_at');
      expect(await indexDef('categories_organization_id_slug_unique')).not.toContain('removed_at');
    });

    it('restores the original SHAPE, not merely the original effect', async () => {
      /**
       * The two slug rules were created as TABLE CONSTRAINTS and the SKU rule
       * as a partial index. A `down` that brought all three back as plain
       * indexes would enforce the same uniqueness while leaving the schema in a
       * shape the database never had — absent from
       * `information_schema.table_constraints`, unresolvable by
       * `on conflict on constraint`, and drift to the next schema diff.
       */
      // While the migration is applied, all three are INDEXES: a partial
      // unique rule cannot be a table constraint in PostgreSQL.
      expect(await constraintType('products_organization_id_slug_unique')).toBeNull();
      expect(await constraintType('categories_organization_id_slug_unique')).toBeNull();

      await revertTriggers();
      await revertColumns();

      expect(await constraintType('products_organization_id_slug_unique')).toBe('UNIQUE');
      expect(await constraintType('categories_organization_id_slug_unique')).toBe('UNIQUE');
      // The SKU rule was a partial INDEX from the start and stays one.
      expect(await constraintType('products_organization_id_sku_unique')).toBeNull();
      expect(await indexDef('products_organization_id_sku_unique')).toContain('sku IS NOT NULL');
    });

    it('and the restored rules ENFORCE, not merely exist', async () => {
      const org = await seedOrganization();
      await revertTriggers();
      await revertColumns();

      await seedProduct(org, 'taken', 'SKU-T');
      // Slug: refused by the restored table constraint.
      await expect(seedProduct(org, 'taken')).rejects.toThrow();
      // SKU: refused by the restored partial index…
      await expect(seedProduct(org, 'other-slug', 'SKU-T')).rejects.toThrow();
      // …while two NULL skus still coexist, which is what `sku is not null` buys.
      await expect(seedProduct(org, 'null-sku-a')).resolves.toBeDefined();
      await expect(seedProduct(org, 'null-sku-b')).resolves.toBeDefined();
    });

    it('REAPPLY after that down puts the partial rules back, and the constraints go', async () => {
      await revertTriggers();
      await revertColumns();
      expect(await constraintType('products_organization_id_slug_unique')).toBe('UNIQUE');

      await migrator().up();

      expect(await constraintType('products_organization_id_slug_unique')).toBeNull();
      expect(await constraintType('categories_organization_id_slug_unique')).toBeNull();
      expect(await indexDef('products_organization_id_slug_unique')).toContain('WHERE (removed_at IS NULL)');
      expect(await indexDef('categories_organization_id_slug_unique')).toContain('WHERE (removed_at IS NULL)');
    });

    it('REAPPLIES after a reversal — the triggers are replaced, not duplicated', async () => {
      await revertTriggers();
      await revertColumns();
      await migrator().up();

      expect(await columnExists('products', 'removed_at')).toBe(true);
      expect(await indexDef('products_organization_id_slug_unique')).toContain('WHERE (removed_at IS NULL)');
      // `create or replace function` and dropped-then-created triggers must not
      // leave two copies firing on one write.
      expect(await functionCount()).toBe(3);
      const duplicated = await sql<{ tgname: string; n: number }>(
        `select tgname, count(*)::int as n from pg_trigger
          where tgname like 'wegox_%removed%' and not tgisinternal
          group by tgname having count(*) > 1`,
      );
      expect(duplicated).toEqual([]);
    });

    it('reverses only the TRIGGER migration, leaving the columns in place', async () => {
      await revertTriggers();
      expect(await applied()).toContain(LIFECYCLE_COLUMNS);

      expect(await triggerCount()).toBe(0);
      expect(await functionCount()).toBe(0);
      // The lifecycle columns and the partial indexes are the other
      // migration's, and they stay.
      expect(await columnExists('products', 'removed_at')).toBe(true);
      expect(await indexDef('products_organization_id_slug_unique')).toContain('WHERE (removed_at IS NULL)');
    });
  });

  describe('once the feature has been used, the reversal REFUSES', () => {
    it('refuses while any removed item exists, and changes nothing', async () => {
      const org = await seedOrganization();
      const id = await seedProduct(org, 'kept');
      await sql(`update products set removed_at = now() where id = ?::uuid`, [id]);

      // The triggers come off freely — they protect, they do not store.
      await revertTriggers();
      await expect(revertColumns()).rejects.toThrow(/removed record/i);

      // Not half-reversed: the column the refusal protects is still there, and
      // so is the record it protects.
      expect(await columnExists('products', 'removed_at')).toBe(true);
      const [row] = await sql<{ removed_at: Date | null }>(`select removed_at from products where id = ?::uuid`, [id]);
      expect(row.removed_at).not.toBeNull();
    });

    it('refuses while any removed CATEGORY exists', async () => {
      const org = await seedOrganization();
      const [category] = await sql<{ id: string }>(
        `insert into categories (name, slug, organization_id, created_at, updated_at)
         values ('Gone', 'gone', ?::uuid, now(), now()) returning id`,
        [org],
      );
      await sql(`update categories set removed_at = now() where id = ?::uuid`, [category.id]);

      await revertTriggers();
      await expect(revertColumns()).rejects.toThrow(/removed record/i);
      expect(await columnExists('categories', 'removed_at')).toBe(true);
    });

    it('refuses when a freed SLUG is now held twice — the total index could not be restored', async () => {
      // The exact state the partial index exists to permit: a removed item and
      // a live one holding one slug. Restoring a TOTAL index over that is
      // impossible, so the migration says so instead of failing halfway.
      const org = await seedOrganization();
      const first = await seedProduct(org, 'shared');
      await sql(`update products set removed_at = now() where id = ?::uuid`, [first]);
      await seedProduct(org, 'shared');

      await revertTriggers();
      await expect(revertColumns()).rejects.toThrow(/removed record/i);

      // And with the removal cleared, the DUPLICATE is what refuses — a
      // different sentence, so the operator learns which problem they have.
      await sql(`update products set removed_at = null where id = ?::uuid`, [first]).catch(() => undefined);
      const [live] = await sql<{ n: number }>(
        `select count(*)::int as n from products where organization_id = ?::uuid and slug = 'shared'`,
        [org],
      );
      expect(live.n).toBe(2);
    });

    it('refuses when a freed SKU is now held twice', async () => {
      const org = await seedOrganization();
      const first = await seedProduct(org, 'a-slug', 'SKU-X');
      await sql(`update products set removed_at = now() where id = ?::uuid`, [first]);
      await seedProduct(org, 'b-slug', 'SKU-X');

      await revertTriggers();
      await expect(revertColumns()).rejects.toThrow(/removed record/i);
      expect(await columnExists('products', 'removed_at')).toBe(true);
    });

    it('the TRIGGER migration alone still reverses — it destroys no data', async () => {
      // Removing the triggers loses protection, not records, so it carries no
      // guard. Proving that keeps the two migrations honestly separate.
      const org = await seedOrganization();
      const id = await seedProduct(org, 'still-here');
      await sql(`update products set removed_at = now() where id = ?::uuid`, [id]);

      await revertTriggers();

      expect(await triggerCount()).toBe(0);
      expect(await applied()).toContain(LIFECYCLE_COLUMNS);
      const [row] = await sql<{ removed_at: Date | null }>(`select removed_at from products where id = ?::uuid`, [id]);
      expect(row.removed_at).not.toBeNull();
    });
  });
});
