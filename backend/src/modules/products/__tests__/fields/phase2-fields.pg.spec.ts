import { EntityManager } from '@mikro-orm/postgresql';
import { ConflictException } from '@nestjs/common';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { Organization } from '../../../organizations/entities/organization.entity';
import { Store } from '../../../stores/entities/store.entity';
import { Product } from '../../entities/product.entity';
import { ProductStatus } from '../../catalogue/product-status.enum';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { CuratedFieldRegistryService } from '../../fields/curated-field-registry.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { ProductFieldDefinition } from '../../entities/product-field-definition.entity';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const PREV_MIGRATION = 'Migration20260804190000'; // the Phase 1 head (67)
const THIS_MIGRATION = 'Migration20260805200000';
/** Phase 3 now sits on top; reversals here address migrations by name. */
const NEXT_MIGRATION = 'Migration20260805210000';

/**
 * Phase 2 against real PostgreSQL: the additive migration from the exact
 * Phase 1 head (fail-closed classifier, honest down()), the new CHECK
 * semantics, per-type persistence, the composite-FK ecosystem surviving the
 * constraint swaps, and the effective-value publication invariants that only
 * a real database can prove (inheritance satisfying `required`, parent-value
 * deletion guarded across the family, transition refusals over real rows).
 */
d('Phase 2 predefined specifications (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  const orgWideScope = (organizationId: string): TenantScope => ({
    platform: false,
    organizationId,
    storeId: null,
    allowedStoreIds: [],
    role: 'ORGANIZATION_MANAGER',
  });

  const fieldsService = (em: EntityManager) =>
    new ProductFieldsService(em.getRepository(ProductFieldDefinition) as any, em as any, new PublicationGuardService());

  const defIdByKey = async (em: EntityManager, organizationId: string, key: string): Promise<string | null> => {
    const rows = await em
      .getConnection()
      .execute(`select id from product_field_definitions where organization_id = ? and key = ?`, [organizationId, key]);
    return rows[0]?.id ?? null;
  };

  describe('migration classifier and reversal', () => {
    let pg: DisposablePg;
    let em: EntityManager;

    beforeAll(async () => {
      pg = await withDisposablePg({ migrateTo: PREV_MIGRATION });
      em = pg.orm.em.fork();
    });

    afterAll(async () => {
      if (pg) await pg.close();
    });

    it('refuses a partial shape, rolls back whole, then applies after repair', async () => {
      // Stage an unknown intermediate state: one new column already present.
      await em.getConnection().execute(`alter table "product_field_definitions" add column "source" text`);
      await expect(pg.orm.getMigrator().up({ to: NEXT_MIGRATION })).rejects.toThrow(/P2_REFUSE_PARTIAL_SHAPE/);
      const applied = await em
        .getConnection()
        .execute(`select count(*)::int as n from mikro_orm_migrations where name = ?`, [THIS_MIGRATION]);
      expect(applied[0].n).toBe(0);
      await em.getConnection().execute(`alter table "product_field_definitions" drop column "source"`);

      await pg.orm.getMigrator().up({ to: NEXT_MIGRATION });
      const after = await em
        .getConnection()
        .execute(`select count(*)::int as n from mikro_orm_migrations where name = ?`, [THIS_MIGRATION]);
      expect(after[0].n).toBe(1);
    });

    it('keeps both composite foreign keys on values and settings', async () => {
      for (const table of ['product_field_values', 'store_field_settings']) {
        const fks = await em
          .getConnection()
          .execute(
            `select count(*)::int as n from pg_constraint where conrelid = 'public.${table}'::regclass and contype = 'f'`,
          );
        expect(fks[0].n).toBe(2);
      }
    });

    it('down() refuses while the Phase 2 surface is in use, then reverses when clean', async () => {
      const conn = em.getConnection();
      const [org] = await conn.execute(
        `insert into organizations (name, slug, created_at, updated_at) values ('P2', 'p2-down', now(), now()) returning id`,
      );
      const [def] = await conn.execute(
        `insert into product_field_definitions
           (organization_id, key, label, type, source, created_at, updated_at)
         values (?, 'launch-date', 'Launch date', 'DATE', 'CUSTOM', now(), now()) returning id`,
        [org.id],
      );
      // The chain has grown past Phase 2 (Phase 3 sits on top), so the head
      // must come off first and every reversal is addressed BY NAME — a bare
      // down() would revert whatever happens to be newest, not the migration
      // under test. For the same reason this suite migrates UP only as far as
      // Phase 3: Phase 4's category/asset foreign key depends on a Phase 3
      // index, so Phase 3 cannot be reverted while Phase 4 sits above it.
      await pg.orm.getMigrator().down(NEXT_MIGRATION);
      await expect(pg.orm.getMigrator().down(THIS_MIGRATION)).rejects.toThrow(/P2_IRREVERSIBLE/);

      await conn.execute(`delete from product_field_definitions where id = ?`, [def.id]);
      await pg.orm.getMigrator().down(THIS_MIGRATION);
      const gone = await conn.execute(
        `select count(*)::int as n from information_schema.columns
          where table_schema='public' and table_name='product_field_values' and column_name='value_date'`,
      );
      expect(gone[0].n).toBe(0);
      // Forward again so later suites in this file never see the old shape.
      await pg.orm.getMigrator().up({ to: NEXT_MIGRATION });
    });
  });

  describe('typed persistence, checks and effective invariants', () => {
    let pg: DisposablePg;
    let em: EntityManager;
    let orgId: string;
    let storeId: string;
    let parentId: string;
    let childId: string;
    let scope: TenantScope;

    beforeAll(async () => {
      pg = await withDisposablePg(); // full chain: Phase 2 schema
      em = pg.orm.em.fork();
      const org = em.create(Organization, { name: 'P2', slug: 'p2' } as any);
      em.persist(org);
      await em.flush();
      orgId = org.id;
      scope = orgWideScope(orgId);
      const store = em.create(Store, { name: 'Main', slug: 'main', organization: org } as any);
      em.persist(store);
      await em.flush();
      storeId = store.id;
      const product = (slug: string, over: Record<string, unknown> = {}) =>
        em.create(Product, {
          name: slug,
          slug,
          organization: orgId,
          price: 10,
          stockQuantity: 0,
          trackInventory: false,
          status: ProductStatus.PUBLISHED,
          ...over,
        } as any);
      const parent = product('family-model');
      em.persist(parent);
      await em.flush();
      parentId = parent.id;
      const child = product('family-version', { parent: parentId, optionLabel: 'V1' });
      em.persist(child);
      await em.flush();
      childId = child.id;
      await em.getConnection().execute(
        `insert into store_products
           (organization_id, store_id, product_id, published, track_inventory, stock_quantity, created_at, updated_at)
         values (?, ?, ?, true, false, 0, now(), now())`,
        [orgId, storeId, childId],
      );
    });

    afterAll(async () => {
      if (pg) await pg.close();
    });

    it('activation materializes ONE definitions row and zero schema columns', async () => {
      const registry = new CuratedFieldRegistryService(em as any);
      const before = await em
        .getConnection()
        .execute(
          `select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='products'`,
        );
      const activated = await registry.activate(scope, 'material');
      expect(activated.source).toBe('CURATED');
      const again = await registry.activate(scope, 'material'); // idempotent
      expect(again.id).toBe(activated.id);
      const after = await em
        .getConnection()
        .execute(
          `select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='products'`,
        );
      expect(after[0].n).toBe(before[0].n);
    });

    it('persists every new type round-trip and the CHECKs refuse mixed columns', async () => {
      const registry = new CuratedFieldRegistryService(em as any);
      const service = fieldsService(pg.orm.em.fork());
      const mk = async (key: string, type: string, options: string[] | undefined = undefined) =>
        service.createDefinition(scope, { label: key, key, type, options } as any);
      const select = await mk('shell', 'SELECT', ['Matte', 'Gloss']);
      const date = await mk('launched', 'DATE');
      const url = await mk('datasheet', 'URL');

      const alone = pg.orm.em.fork();
      const aloneSvc = fieldsService(alone);
      expect((await aloneSvc.upsertValue(scope, parentId, select.id, { value: 'Matte' } as any)).value).toBe('Matte');
      expect((await aloneSvc.upsertValue(scope, parentId, date.id, { value: '2026-08-05' } as any)).value).toBe(
        '2026-08-05',
      );
      expect(
        (await aloneSvc.upsertValue(scope, parentId, url.id, { value: 'https://example.com/a.pdf' } as any)).value,
      ).toBe('https://example.com/a.pdf');

      // Database-level exactly-one rule for a new type.
      await expect(
        em.getConnection().execute(
          `insert into product_field_values
             (organization_id, product_id, definition_id, definition_type, value_number, created_at, updated_at)
           values (?, ?, ?, 'DATE', '1', now(), now())`,
          [orgId, parentId, date.id],
        ),
      ).rejects.toThrow(/type_value_check/);
      // Options belong to SELECT alone.
      await expect(
        em
          .getConnection()
          .execute(`update product_field_definitions set options = '["x"]'::jsonb where id = ?`, [date.id]),
      ).rejects.toThrow(/options_check/);
      // The curated registry survived alongside: activation from the earlier
      // test still resolves.
      const listed = await registry.list(scope);
      expect(listed.find((entry) => entry.key === 'material')?.activatedDefinitionId).toBeTruthy();
    });

    it('an inherited parent value satisfies a required field for a published child', async () => {
      const service = fieldsService(pg.orm.em.fork());
      const guard = new PublicationGuardService();
      const width = await service.createDefinition(scope, {
        label: 'Both Width',
        key: 'both-width',
        type: 'NUMBER',
      } as any);
      await service.upsertValue(scope, parentId, width.id, { value: '120' } as any);

      // Making the field required scans the store's shown products with the
      // EFFECTIVE predicate: the child is shown, unanswered directly, but
      // inherits the model's 120 — so this must pass. The scope must name
      // the store among its allowed branches to touch its settings.
      const storeScoped: TenantScope = { ...scope, allowedStoreIds: [storeId] };
      await service.upsertStoreSetting(storeScoped, storeId, width.id, { active: true, required: true } as any);

      // And the direct guard agrees for the child itself.
      const fresh = pg.orm.em.fork();
      const child = await fresh.findOne(Product, { id: childId });
      await expect(guard.assertPublishable(fresh, child!, [storeId])).resolves.toBeUndefined();
    });

    it('refuses deleting the parent value the published child depends on, bounded and precise', async () => {
      const service = fieldsService(pg.orm.em.fork());
      const defId = (await defIdByKey(em, orgId, 'both-width'))!;
      const err = await service.deleteValue(scope, parentId, defId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      const body = (err as ConflictException).getResponse() as any;
      expect(body.blockingStoreIds).toEqual([storeId]);
      expect(body.affectedProductIds).toEqual([childId]);
    });

    it('refuses narrowing applicability while real rows sit on the excluded side', async () => {
      const service = fieldsService(pg.orm.em.fork());
      const defId = (await defIdByKey(em, orgId, 'both-width'))!;
      const err = await service
        .updateDefinition(scope, defId, { applicability: 'CHILD' } as any)
        .catch((e: unknown) => e);
      // The parent holds the only row -> CHILD narrowing must refuse.
      expect(err).toBeInstanceOf(ConflictException);
      expect(((err as ConflictException).getResponse() as any).code).toBe('FIELD_APPLICABILITY_ROWS');
    });
  });
});
