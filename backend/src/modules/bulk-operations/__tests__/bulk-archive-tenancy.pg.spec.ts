import { EntityManager } from '@mikro-orm/postgresql';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../test/pg-harness';
import { BulkOperationsController } from '../bulk-operations.controller';
import { BulkOperationsService } from '../bulk-operations.service';
import { ExportsService } from '../../exports/exports.service';
import { ProductsService } from '../../products/catalogue/products.service';
import { PublicationGuardService } from '../../products/publication/publication-guard.service';
import { Product } from '../../products/entities/product.entity';
import { Category } from '../../categories/entities/category.entity';
import { Store } from '../../stores/entities/store.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { ProductStatus } from '../../products/catalogue/product-status.enum';
import { TenantScope } from '../../auth/tenancy/tenant-scope';
import { stockDouble, realStock } from '../../../../test/inventory-stock-support';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * P5-A2 canonical family 7 against real PostgreSQL.
 *
 * The bulk services filtered by organization CONDITIONALLY
 * (`...(organizationId ? { organization: organizationId } : {})`), and six of
 * the seven routes handed them `req.scope?.organizationId ?? undefined`. This
 * suite proves against the DATABASE, with two companies present, that no bulk
 * path reaches a foreign row and that a refused batch writes nothing at all.
 */
d('P5-A2 family 7 bulk + archival tenancy (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let controller: BulkOperationsController;
  let exportsService: ExportsService;

  let ORG_A: string;
  let ORG_B: string;
  let STORE_A1: string;
  let PRODUCT_A: string;
  let PRODUCT_B: string;

  let managerA: TenantScope;
  let narrowedA: TenantScope;
  const platform: TenantScope = {
    platform: true,
    role: 'SUPER_ADMIN',
    organizationId: null,
    storeId: null,
    allowedStoreIds: [],
  };
  const actor = { id: '00000000-0000-4000-8000-00000000000a', email: 'om@alpha.test' };

  const fingerprint = async (id: string) => {
    const [row]: any[] = await em
      .fork()
      .getConnection()
      .execute(
        `select status, archived_at, price, stock_quantity, track_inventory
         from products where id = ?`,
        [id],
      );
    return JSON.stringify(row);
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork();

    const productsService = new ProductsService(
      em.getRepository(Product) as any,
      em.getRepository(Category) as any,
      { findAll: async () => [] } as any, // CategoriesService — unused by these paths
      { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
      { learnedWordsFor: async () => [], dismissedSignaturesFor: async () => [] } as any,
      new PublicationGuardService(),
      { resolveForImport: async () => ({}) } as any,
      realStock(em as any),
    );
    const service = new BulkOperationsService(
      em.getRepository(Product) as any,
      em.getRepository(Category) as any,
      productsService as any,
      { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
      new PublicationGuardService(),
      stockDouble() as any,
    );
    controller = new BulkOperationsController(service);
    exportsService = new ExportsService(em.getRepository(Category) as any, em.getRepository(Product) as any);

    const organizationA = em.create(Organization, { name: 'Alpha', slug: 'alpha-bulk' } as any);
    const organizationB = em.create(Organization, { name: 'Beta', slug: 'beta-bulk' } as any);
    await em.persistAndFlush([organizationA, organizationB]);
    ORG_A = organizationA.id;
    ORG_B = organizationB.id;

    const a1 = em.create(Store, {
      name: 'Alpha Centro',
      slug: 'alpha-centro-bulk',
      organization: organizationA,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    await em.persistAndFlush([a1]);
    STORE_A1 = a1.id;

    const product = (name: string, organization: Organization) =>
      em.create(Product, {
        name,
        slug: `${name}-${organization.slug}`,
        organization,
        status: ProductStatus.PUBLISHED,
        price: '10.00',
        stockQuantity: 4,
        trackInventory: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
    const pA = product('bulk-alpha', organizationA);
    const pB = product('bulk-beta', organizationB);
    await em.persistAndFlush([pA, pB]);
    PRODUCT_A = pA.id;
    PRODUCT_B = pB.id;

    managerA = {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId: ORG_A,
      storeId: null,
      allowedStoreIds: [STORE_A1],
    };
    narrowedA = { ...managerA, storeId: STORE_A1 };
  });

  afterAll(async () => {
    await pg.close();
  });

  describe('a bulk batch never leaves its company', () => {
    it("names a foreign product and it simply is not found — org B's row is byte-identical after", async () => {
      const before = await fingerprint(PRODUCT_B);

      const result: any = await controller.bulkArchive({ scope: managerA, user: actor }, {
        ids: [PRODUCT_A, PRODUCT_B],
      } as any);

      expect(result.successCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.failures[0].id).toBe(PRODUCT_B);
      // Same wording as a nonexistent id — nothing about org B is disclosed.
      expect(result.failures[0].message).toMatch(/not found/i);
      expect(await fingerprint(PRODUCT_B)).toBe(before);
    });

    it('restores only its own, leaving the foreign row untouched', async () => {
      const before = await fingerprint(PRODUCT_B);
      const result: any = await controller.bulkRestore({ scope: managerA, user: actor }, {
        ids: [PRODUCT_A, PRODUCT_B],
      } as any);
      expect(result.successCount).toBe(1);
      expect(await fingerprint(PRODUCT_B)).toBe(before);
    });
  });

  describe('the unscoped platform owner reaches no bulk path at all', () => {
    const cases: Array<[string, (c: BulkOperationsController, req: any) => Promise<unknown>, any]> = [
      ['archive', (c, r) => c.bulkArchive(r, { ids: [] } as any), ForbiddenException],
      ['restore', (c, r) => c.bulkRestore(r, { ids: [] } as any), ForbiddenException],
      ['status', (c, r) => c.bulkStatus(r, { ids: [], status: ProductStatus.DRAFT } as any), BadRequestException],
      ['stores', (c, r) => c.bulkStores(r, { ids: [], storeIds: [] } as any), BadRequestException],
      ['category', (c, r) => c.bulkCategory(r, { ids: [], categoryId: null } as any), BadRequestException],
      ['inventory', (c, r) => c.bulkInventory(r, { ids: [], stockQuantity: 1 } as any), BadRequestException],
      ['pricing', (c, r) => c.bulkPricing(r, { ids: [], price: 1 } as any), BadRequestException],
    ];

    it.each(cases)('%s is refused and BOTH companies are byte-identical after', async (_name, call, error) => {
      const beforeA = await fingerprint(PRODUCT_A);
      const beforeB = await fingerprint(PRODUCT_B);

      await expect(call(controller, { scope: platform, user: actor })).rejects.toThrow(error);

      expect(await fingerprint(PRODUCT_A)).toBe(beforeA);
      expect(await fingerprint(PRODUCT_B)).toBe(beforeB);
    });

    it('the whole table is larger than any single company can reach', async () => {
      // The defect's shape: one unfiltered query would have returned this count.
      const whole = await em.fork().count(Product, {});
      const alpha = await em.fork().count(Product, { organization: ORG_A });
      expect(alpha).toBeLessThan(whole);
    });
  });

  describe('archival in bulk obeys the organization-administrator predicate', () => {
    it('a NARROWED manager cannot bulk-archive, and nothing changes', async () => {
      const before = await fingerprint(PRODUCT_A);
      await expect(
        controller.bulkArchive({ scope: narrowedA, user: actor }, { ids: [PRODUCT_A] } as any),
      ).rejects.toThrow(ForbiddenException);
      expect(await fingerprint(PRODUCT_A)).toBe(before);
    });

    it('an un-narrowed manager can', async () => {
      const result: any = await controller.bulkArchive({ scope: managerA, user: actor }, {
        ids: [PRODUCT_A],
      } as any);
      expect(result.successCount).toBe(1);
      await controller.bulkRestore({ scope: managerA, user: actor }, { ids: [PRODUCT_A] } as any);
    });
  });

  describe('an export is a tenant read', () => {
    it('returns one company only, and never the whole table', async () => {
      const alpha = await exportsService.exportProducts(ORG_A);
      const beta = await exportsService.exportProducts(ORG_B);

      expect(alpha).toContain('bulk-alpha');
      expect(alpha).not.toContain('bulk-beta');
      expect(beta).toContain('bulk-beta');
      expect(beta).not.toContain('bulk-alpha');
    });
  });
});
