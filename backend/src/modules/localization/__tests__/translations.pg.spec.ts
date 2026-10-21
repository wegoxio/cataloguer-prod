import { EntityManager, MikroORM } from '@mikro-orm/postgresql';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../test/pg-harness';
import { Organization } from '../../organizations/entities/organization.entity';
import { Store } from '../../stores/entities/store.entity';
import { Product } from '../../products/entities/product.entity';
import { Category } from '../../categories/entities/category.entity';
import { TranslationsService } from '../translations.service';
import { TenantScope } from '../../auth/tenancy/tenant-scope';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const PREV_MIGRATION = 'Migration20260821120000';
const THIS_MIGRATION = 'Migration20260821130000';

d('P5-W2 catalogue translations (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let orm: MikroORM;
  let em: EntityManager;
  let service: TranslationsService;

  let ORG_A: string;
  let ORG_B: string;
  let STORE_A1: string;
  let STORE_A2: string;
  let PRODUCT_A: string;
  let PRODUCT_B: string;
  let CATEGORY_A: string;

  let managerA: TenantScope;
  let narrowedA1: TenantScope;
  let managerB: TenantScope;
  const unscopedPlatform: TenantScope = {
    platform: true,
    role: 'SUPER_ADMIN',
    organizationId: null,
    storeId: null,
    allowedStoreIds: [],
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    orm = pg.orm;
    em = orm.em.fork();
    service = new TranslationsService(em as never);

    const a = em.create(Organization, { name: 'Alpha', slug: 'alpha-i18n' } as never);
    const b = em.create(Organization, { name: 'Beta', slug: 'beta-i18n' } as never);
    await em.persistAndFlush([a, b]);
    ORG_A = (a as unknown as { id: string }).id;
    ORG_B = (b as unknown as { id: string }).id;

    const s1 = em.create(Store, { name: 'A1', slug: 'a1-i18n', organization: a } as never);
    const s2 = em.create(Store, { name: 'A2', slug: 'a2-i18n', organization: a } as never);
    await em.persistAndFlush([s1, s2]);
    STORE_A1 = (s1 as unknown as { id: string }).id;
    STORE_A2 = (s2 as unknown as { id: string }).id;

    const pa = em.create(Product, {
      name: 'Silla nórdica',
      slug: 'silla-nordica',
      organization: a,
      description: 'Hecha a mano',
      price: 100,
    } as never);
    const pb = em.create(Product, { name: 'Otra empresa', slug: 'otra-empresa', organization: b, price: 5 } as never);
    const ca = em.create(Category, { name: 'Sillas', slug: 'sillas', organization: a } as never);
    await em.persistAndFlush([pa, pb, ca]);
    PRODUCT_A = (pa as unknown as { id: string }).id;
    PRODUCT_B = (pb as unknown as { id: string }).id;
    CATEGORY_A = (ca as unknown as { id: string }).id;

    managerA = {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId: ORG_A,
      storeId: null,
      allowedStoreIds: [STORE_A1, STORE_A2],
    };
    narrowedA1 = { ...managerA, storeId: STORE_A1 };
    managerB = {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId: ORG_B,
      storeId: null,
      allowedStoreIds: [],
    };
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  describe('the canonical content locale', () => {
    it('is `es` for every organization, as decision 13 seeds it', async () => {
      await expect(service.canonicalLocaleOf(ORG_A)).resolves.toBe('es');
      await expect(service.canonicalLocaleOf(ORG_B)).resolves.toBe('es');
    });

    it('is a DEFAULT, not a fence: it can be changed', async () => {
      await em
        .getConnection()
        .execute(`update organizations set default_content_locale = 'en' where id = ?::uuid`, [ORG_B]);
      // The raw UPDATE went round the identity map, so clear it before asking
      // again — otherwise this asserts the cached row, not the database.
      em.clear();
      await expect(service.canonicalLocaleOf(ORG_B)).resolves.toBe('en');
      await em
        .getConnection()
        .execute(`update organizations set default_content_locale = 'es' where id = ?::uuid`, [ORG_B]);
      em.clear();
      await expect(service.canonicalLocaleOf(ORG_B)).resolves.toBe('es');
    });

    it('refuses a malformed tag at the DATABASE, not only in code', async () => {
      await expect(
        em
          .getConnection()
          .execute(`update organizations set default_content_locale = 'NOT A LOCALE' where id = ?::uuid`, [ORG_A]),
      ).rejects.toThrow();
      await expect(service.canonicalLocaleOf(ORG_A)).resolves.toBe('es');
    });
  });

  describe('writing', () => {
    it('stores a translation and reads it back', async () => {
      await service.upsert(managerA, 'product', PRODUCT_A, 'en', { name: 'Nordic chair', description: 'Handmade' });
      const listed = await service.list(managerA, 'product', PRODUCT_A);
      expect(listed.canonicalLocale).toBe('es');
      expect(listed.translations).toEqual([
        { locale: 'en', name: 'Nordic chair', description: 'Handmade', metaTitle: null, metaDescription: null },
      ]);
    });

    it('NORMALIZES the locale before storing it', async () => {
      await service.upsert(managerA, 'product', PRODUCT_A, 'pt_br', { name: 'Cadeira nórdica' });
      const listed = await service.list(managerA, 'product', PRODUCT_A);
      expect(listed.translations.map((t) => t.locale)).toEqual(['en', 'pt-BR']);
    });

    it('leaves omitted fields alone and clears the ones sent empty', async () => {
      await service.upsert(managerA, 'product', PRODUCT_A, 'en', { metaTitle: 'Nordic chair | DesignHof' });
      let row = (await service.list(managerA, 'product', PRODUCT_A)).translations.find((t) => t.locale === 'en');
      expect(row).toEqual({
        locale: 'en',
        name: 'Nordic chair',
        description: 'Handmade',
        metaTitle: 'Nordic chair | DesignHof',
        metaDescription: null,
      });

      await service.upsert(managerA, 'product', PRODUCT_A, 'en', { description: '' });
      row = (await service.list(managerA, 'product', PRODUCT_A)).translations.find((t) => t.locale === 'en');
      expect(row?.description).toBeNull();
      expect(row?.name).toBe('Nordic chair');
    });

    it('DELETES the row when a translation is emptied completely', async () => {
      await service.upsert(managerA, 'product', PRODUCT_A, 'fr', { name: 'Chaise' });
      expect((await service.list(managerA, 'product', PRODUCT_A)).translations.map((t) => t.locale)).toContain('fr');

      const result = await service.upsert(managerA, 'product', PRODUCT_A, 'fr', { name: '' });
      expect(result.deleted).toBe(true);
      expect((await service.list(managerA, 'product', PRODUCT_A)).translations.map((t) => t.locale)).not.toContain(
        'fr',
      );
    });

    it('refuses a translation for the CANONICAL locale — that is the item itself', async () => {
      await expect(service.upsert(managerA, 'product', PRODUCT_A, 'es', { name: 'Otra silla' })).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.upsert(managerA, 'product', PRODUCT_A, 'ES', { name: 'Otra silla' })).rejects.toThrow(
        /canonical content language/,
      );
    });

    it('refuses a malformed language tag with a usable message', async () => {
      await expect(service.upsert(managerA, 'product', PRODUCT_A, 'klingon-ish!', { name: 'x' })).rejects.toThrow(
        /is not a language tag/,
      );
    });

    it('works for categories too', async () => {
      await service.upsert(managerA, 'category', CATEGORY_A, 'en', { name: 'Chairs' });
      const listed = await service.list(managerA, 'category', CATEGORY_A);
      expect(listed.translations).toEqual([
        { locale: 'en', name: 'Chairs', description: null, metaTitle: null, metaDescription: null },
      ]);
    });
  });

  describe('authority and tenancy', () => {
    it("refuses another company's product as NOT FOUND, never as forbidden-but-existing", async () => {
      await expect(service.list(managerA, 'product', PRODUCT_B)).rejects.toThrow(NotFoundException);
      await expect(service.upsert(managerA, 'product', PRODUCT_B, 'en', { name: 'x' })).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.remove(managerA, 'product', PRODUCT_B, 'en')).rejects.toThrow(NotFoundException);
    });

    it('refuses a NARROWED actor: shared catalogue copy is not one branch to rewrite', async () => {
      await expect(service.upsert(narrowedA1, 'product', PRODUCT_A, 'de', { name: 'Stuhl' })).rejects.toThrow(
        /company-wide access/,
      );
      await expect(service.remove(narrowedA1, 'product', PRODUCT_A, 'en')).rejects.toThrow(/company-wide access/);
    });

    it('refuses the UNSCOPED platform owner: translations are tenant data', async () => {
      await expect(service.list(unscopedPlatform, 'product', PRODUCT_A)).rejects.toThrow(/Organization context/);
      await expect(service.upsert(unscopedPlatform, 'product', PRODUCT_A, 'de', { name: 'x' })).rejects.toThrow(
        /company-wide access|Organization context/,
      );
    });

    it("does not let another company's manager see or touch our translations", async () => {
      await expect(service.list(managerB, 'product', PRODUCT_A)).rejects.toThrow(NotFoundException);
      const stillOurs = await service.list(managerA, 'product', PRODUCT_A);
      expect(stillOurs.translations.map((t) => t.locale)).toEqual(['en', 'pt-BR']);
    });

    it('refuses a CROSS-TENANT translation at the DATABASE, not only in the service', async () => {
      // The composite key is the wall: an organization that does not own the
      // product cannot file a translation for it even by raw SQL.
      await expect(
        em
          .getConnection()
          .execute(
            `insert into product_translations (organization_id, product_id, locale, name) values (?::uuid, ?::uuid, 'de', 'Stuhl')`,
            [ORG_B, PRODUCT_A],
          ),
      ).rejects.toThrow();
    });
  });

  describe('the database refuses meaningless rows', () => {
    it('refuses a translation that translates nothing', async () => {
      await expect(
        em
          .getConnection()
          .execute(
            `insert into product_translations (organization_id, product_id, locale) values (?::uuid, ?::uuid, 'it')`,
            [ORG_A, PRODUCT_A],
          ),
      ).rejects.toThrow();
    });

    it('refuses a blank string dressed up as a translation', async () => {
      await expect(
        em
          .getConnection()
          .execute(
            `insert into product_translations (organization_id, product_id, locale, name) values (?::uuid, ?::uuid, 'it', '   ')`,
            [ORG_A, PRODUCT_A],
          ),
      ).rejects.toThrow();
    });

    it('refuses a non-canonical locale spelling', async () => {
      await expect(
        em
          .getConnection()
          .execute(
            `insert into product_translations (organization_id, product_id, locale, name) values (?::uuid, ?::uuid, 'PT_br', 'x')`,
            [ORG_A, PRODUCT_A],
          ),
      ).rejects.toThrow();
    });

    it('refuses a SECOND row for the same product and locale', async () => {
      await expect(
        em
          .getConnection()
          .execute(
            `insert into product_translations (organization_id, product_id, locale, name) values (?::uuid, ?::uuid, 'en', 'Duplicate')`,
            [ORG_A, PRODUCT_A],
          ),
      ).rejects.toThrow();
    });

    it('removes translations with the product they belong to', async () => {
      const fork = orm.em.fork();
      const doomed = fork.create(Product, {
        name: 'Efímero',
        slug: 'efimero',
        organization: fork.getReference(Organization, ORG_A),
        price: 1,
      } as never);
      await fork.persistAndFlush(doomed);
      const doomedId = (doomed as unknown as { id: string }).id;
      await service.upsert(managerA, 'product', doomedId, 'en', { name: 'Ephemeral' });

      await em.getConnection().execute(`delete from products where id = ?::uuid`, [doomedId]);
      const [{ n }] = await em
        .getConnection()
        .execute(`select count(*)::int as n from product_translations where product_id = ?::uuid`, [doomedId]);
      expect(n).toBe(0);
    });
  });
});

d('P5-W2 localization migration (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let orm: MikroORM;

  const tableExists = async (name: string): Promise<boolean> =>
    (
      await orm.em
        .getConnection()
        .execute(`select 1 from information_schema.tables where table_schema='public' and table_name=?`, [name])
    ).length === 1;

  const columnExists = async (): Promise<boolean> =>
    (
      await orm.em.getConnection().execute(
        `select 1 from information_schema.columns
          where table_schema='public' and table_name='organizations' and column_name='default_content_locale'`,
      )
    ).length === 1;

  beforeAll(async () => {
    pg = await withDisposablePg({ migrateTo: PREV_MIGRATION });
    orm = pg.orm;
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  it('nothing localization-related exists before the migration', async () => {
    expect(await columnExists()).toBe(false);
    expect(await tableExists('product_translations')).toBe(false);
    expect(await tableExists('category_translations')).toBe(false);
  });

  it('up() seeds every EXISTING organization to `es` without rewriting its copy', async () => {
    // RAW SQL on purpose: the entity already declares `defaultContentLocale`,
    // and this database deliberately predates the column, so an ORM insert
    // would fail for a reason that has nothing to do with the migration.
    const em = orm.em.fork();
    const [created] = await em.getConnection().execute(
      `insert into organizations (name, slug, plan, billing_status, created_at, updated_at)
         values ('Pre', 'pre-i18n', 'BASICO', 'ACTIVE', now(), now()) returning id`,
    );
    const orgId = created.id as string;
    await em.getConnection().execute(
      `insert into products (name, slug, organization_id, price, created_at, updated_at)
         values ('Silla previa', 'silla-previa', ?::uuid, 10, now(), now())`,
      [orgId],
    );

    await orm.getMigrator().up({ to: THIS_MIGRATION });

    expect(await columnExists()).toBe(true);
    expect(await tableExists('product_translations')).toBe(true);
    expect(await tableExists('category_translations')).toBe(true);

    const [row] = await orm.em
      .getConnection()
      .execute(`select default_content_locale from organizations where id = ?::uuid`, [orgId]);
    expect(row.default_content_locale).toBe('es');

    // The canonical copy is untouched and stayed exactly where it was.
    const [product] = await orm.em.getConnection().execute(`select name from products where slug = 'silla-previa'`);
    expect(product.name).toBe('Silla previa');
    // Nothing was copied into a translation row.
    const [{ n }] = await orm.em.getConnection().execute(`select count(*)::int as n from product_translations`);
    expect(n).toBe(0);
  });

  it('down() removes exactly what it added, and up() restores it', async () => {
    await orm.getMigrator().down({ to: PREV_MIGRATION });
    expect(await columnExists()).toBe(false);
    expect(await tableExists('product_translations')).toBe(false);
    expect(await tableExists('category_translations')).toBe(false);
    // The catalogue survives the rollback untouched.
    const [product] = await orm.em.getConnection().execute(`select name from products where slug = 'silla-previa'`);
    expect(product.name).toBe('Silla previa');

    await orm.getMigrator().up({ to: THIS_MIGRATION });
    expect(await columnExists()).toBe(true);
    expect(await tableExists('product_translations')).toBe(true);
  });
});
