import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg, insertOrganizationRaw } from '../../../../../test/pg-harness';
import { Organization } from '../../../organizations/entities/organization.entity';
import { Product } from '../../entities/product.entity';
import { resolveByManufacturerCode } from '../../shared/manufacturer-code.util';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const PREV_MIGRATION = 'Migration20260820160000';
const THIS_MIGRATION = 'Migration20260821120000';
const INDEX = 'products_organization_manufacturer_code_idx';

/**
 * P5-W1 against real PostgreSQL.
 *
 * Everything asserted here needs real rows and a real catalog: that two
 * products of ONE company may share a manufacturer code (a mocked repository
 * would simply return whatever it was told), that two companies may reuse the
 * same string with no relationship, and that the column carries no uniqueness
 * of any kind — which is the whole of governing decision 18 and the one thing
 * a "second SKU" would violate.
 */
d('P5-W1 manufacturer code (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let orm: MikroORM;
  let em: EntityManager;

  let ORG_A: string;
  let ORG_B: string;

  const seed = async (organizationId: string, name: string, slug: string, extra: Record<string, unknown> = {}) => {
    const fork = orm.em.fork();
    const product = fork.create(Product, {
      name,
      slug,
      organization: fork.getReference(Organization, organizationId),
      price: 0,
      ...extra,
    } as never);
    await fork.persistAndFlush(product);
    return (product as unknown as { id: string }).id;
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    orm = pg.orm;
    em = orm.em.fork();

    const a = em.create(Organization, { name: 'Alpha', slug: 'alpha-mfr' } as never);
    const b = em.create(Organization, { name: 'Beta', slug: 'beta-mfr' } as never);
    await em.persistAndFlush([a, b]);
    ORG_A = (a as unknown as { id: string }).id;
    ORG_B = (b as unknown as { id: string }).id;
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  describe('storage: a separate identity, never a second SKU', () => {
    it('carries NO unique constraint or unique index of any kind', async () => {
      const constraints = await em.getConnection().execute(
        `select conname from pg_constraint
          where conrelid = 'products'::regclass and contype in ('u','p')
            and pg_get_constraintdef(oid) ilike '%manufacturer_code%'`,
      );
      expect(constraints).toEqual([]);

      const indexes = await em.getConnection().execute(
        `select indexname, indexdef from pg_indexes
          where schemaname = 'public' and tablename = 'products'
            and indexdef ilike '%manufacturer_code%'`,
      );
      expect(indexes).toHaveLength(1);
      expect(indexes[0].indexname).toBe(INDEX);
      expect(String(indexes[0].indexdef).toLowerCase()).not.toContain('unique');
      // Organization-scoped, case-folded and partial — the shape of the two
      // queries that actually run.
      expect(String(indexes[0].indexdef).toLowerCase()).toContain('organization_id');
      expect(String(indexes[0].indexdef).toLowerCase()).toContain('lower((manufacturer_code)::text)');
      expect(String(indexes[0].indexdef).toLowerCase()).toContain('where (manufacturer_code is not null)');
    });

    it('is nullable, and every pre-existing product simply has none', async () => {
      const [column] = await em.getConnection().execute(
        `select is_nullable, column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'products' and column_name = 'manufacturer_code'`,
      );
      expect(column.is_nullable).toBe('YES');
      expect(column.column_default).toBeNull();

      const id = await seed(ORG_A, 'No code', 'no-code-a');
      const [row] = await em.getConnection().execute(`select manufacturer_code from products where id = ?::uuid`, [id]);
      expect(row.manufacturer_code).toBeNull();
    });

    it('ALLOWS two products of one company to share a manufacturer code', async () => {
      // The everyday case: one supplier article sold as two Cataloguer
      // products. A unique constraint would refuse this insert.
      const first = await seed(ORG_A, 'Chair green', 'chair-green-a', { manufacturerCode: 'KARE-71234' });
      const second = await seed(ORG_A, 'Chair blue', 'chair-blue-a', { manufacturerCode: 'KARE-71234' });
      expect(first).not.toBe(second);

      const [{ n }] = await em
        .getConnection()
        .execute(
          `select count(*)::int as n from products where organization_id = ?::uuid and manufacturer_code = 'KARE-71234'`,
          [ORG_A],
        );
      expect(n).toBe(2);
    });

    it('ALLOWS two DIFFERENT companies to use the identical code', async () => {
      await seed(ORG_B, 'Something else entirely', 'unrelated-b', { manufacturerCode: 'KARE-71234' });
      const [{ n }] = await em
        .getConnection()
        .execute(`select count(*)::int as n from products where manufacturer_code = 'KARE-71234'`);
      expect(n).toBe(3);
    });

    it('keeps SKU identity exactly as it was — still unique per company', async () => {
      await seed(ORG_A, 'Sku one', 'sku-one-a', { sku: 'INT-0001', manufacturerCode: 'KARE-71234' });
      // The same SKU in ANOTHER company is fine, and always was.
      await expect(seed(ORG_B, 'Sku one elsewhere', 'sku-one-b', { sku: 'INT-0001' })).resolves.toBeTruthy();
      // The same SKU twice in ONE company is still refused by the database.
      await expect(seed(ORG_A, 'Sku one again', 'sku-one-again-a', { sku: 'INT-0001' })).rejects.toThrow();
    });
  });

  describe('matching', () => {
    it('resolves an unambiguous code to exactly one product', async () => {
      const id = await seed(ORG_A, 'Lamp', 'lamp-a', { manufacturerCode: 'LMP-9' });
      await expect(resolveByManufacturerCode(orm.em.fork(), ORG_A, 'LMP-9')).resolves.toEqual({
        outcome: 'UNIQUE',
        code: 'LMP-9',
        productId: id,
      });
    });

    it('matches case-insensitively and ignores surrounding whitespace', async () => {
      await expect(resolveByManufacturerCode(orm.em.fork(), ORG_A, '  lmp-9  ')).resolves.toMatchObject({
        outcome: 'UNIQUE',
      });
    });

    it('REFUSES an ambiguous code instead of choosing one', async () => {
      const match = await resolveByManufacturerCode(orm.em.fork(), ORG_A, 'KARE-71234');
      expect(match.outcome).toBe('AMBIGUOUS');
      // Every candidate is carried, so a report can name what collided.
      expect(match.outcome === 'AMBIGUOUS' && match.productIds.length).toBe(3);
    });

    it('NEVER resolves a product belonging to another company', async () => {
      // ORG_B owns exactly one 'KARE-71234' product, so a leaking query would
      // look UNIQUE — the most dangerous shape, because it would silently
      // succeed. It must be invisible from ORG_A's perspective and vice versa.
      const fromB = await resolveByManufacturerCode(orm.em.fork(), ORG_B, 'KARE-71234');
      expect(fromB.outcome).toBe('UNIQUE');
      const bId = fromB.outcome === 'UNIQUE' ? fromB.productId : null;

      const fromA = await resolveByManufacturerCode(orm.em.fork(), ORG_A, 'KARE-71234');
      expect(fromA.outcome).toBe('AMBIGUOUS');
      expect(fromA.outcome === 'AMBIGUOUS' && fromA.productIds).not.toContain(bId);

      // And a code only ORG_A has does not resolve from ORG_B at all.
      await expect(resolveByManufacturerCode(orm.em.fork(), ORG_B, 'LMP-9')).resolves.toEqual({
        outcome: 'NONE',
        code: 'LMP-9',
      });
    });

    it('does not resurrect an ARCHIVED product', async () => {
      const id = await seed(ORG_B, 'Retired', 'retired-b', { manufacturerCode: 'ARCH-1' });
      await expect(resolveByManufacturerCode(orm.em.fork(), ORG_B, 'ARCH-1')).resolves.toMatchObject({
        outcome: 'UNIQUE',
      });
      await em.getConnection().execute(`update products set archived_at = now() where id = ?::uuid`, [id]);
      await expect(resolveByManufacturerCode(orm.em.fork(), ORG_B, 'ARCH-1')).resolves.toEqual({
        outcome: 'NONE',
        code: 'ARCH-1',
      });
    });

    it('treats a blank code as "not stated" and matches the null rows to nothing', async () => {
      await expect(resolveByManufacturerCode(orm.em.fork(), ORG_A, '   ')).resolves.toEqual({ outcome: 'BLANK' });
      await expect(resolveByManufacturerCode(orm.em.fork(), ORG_A, null)).resolves.toEqual({ outcome: 'BLANK' });
    });
  });
});

/**
 * The migration itself, on a database that genuinely predates it.
 */
d('P5-W1 manufacturer code migration (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let orm: MikroORM;

  const columnExists = async (): Promise<boolean> =>
    (
      await orm.em.getConnection().execute(
        `select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'products' and column_name = 'manufacturer_code'`,
      )
    ).length === 1;

  const indexExists = async (): Promise<boolean> =>
    (
      await orm.em
        .getConnection()
        .execute(`select 1 from pg_indexes where schemaname = 'public' and indexname = '${INDEX}'`)
    ).length === 1;

  beforeAll(async () => {
    pg = await withDisposablePg({ migrateTo: PREV_MIGRATION });
    orm = pg.orm;
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  it('the column and index do not exist before the migration', async () => {
    expect(await columnExists()).toBe(false);
    expect(await indexExists()).toBe(false);
  });

  it('up() adds exactly the column and the index, and rewrites no row', async () => {
    // A product created BEFORE the column exists must survive untouched.
    // RAW SQL: this database predates later Organization columns; see
    // `insertOrganizationRaw`.
    const em = orm.em.fork();
    const organizationId = await insertOrganizationRaw(em.getConnection() as never, {
      name: 'Pre',
      slug: 'pre-mfr-migration',
    });
    await em.getConnection().execute(
      `insert into products (name, slug, organization_id, price, created_at, updated_at)
                values ('Legacy', 'legacy-pre', ?::uuid, 10, now(), now())`,
      [organizationId],
    );

    await orm.getMigrator().up({ to: THIS_MIGRATION });

    expect(await columnExists()).toBe(true);
    expect(await indexExists()).toBe(true);
    const [row] = await orm.em
      .getConnection()
      .execute(`select name, price::int as price, manufacturer_code from products where slug = 'legacy-pre'`);
    expect(row.name).toBe('Legacy');
    expect(row.price).toBe(10);
    // Not backfilled from anything — "nobody has recorded one yet".
    expect(row.manufacturer_code).toBeNull();
  });

  it('down() removes both on a DISPOSABLE database, and up() restores them', async () => {
    await orm.getMigrator().down({ to: PREV_MIGRATION });
    expect(await columnExists()).toBe(false);
    expect(await indexExists()).toBe(false);

    await orm.getMigrator().up({ to: THIS_MIGRATION });
    expect(await columnExists()).toBe(true);
    expect(await indexExists()).toBe(true);
  });
});
