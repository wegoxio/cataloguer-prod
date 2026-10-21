import { EntityManager } from '@mikro-orm/postgresql';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../test/pg-harness';
import { ReportsController } from '../reports.controller';
import { ReportsService } from '../reports.service';
import { DashboardMetricsController } from '../../dashboard-metrics/dashboard-metrics.controller';
import { DashboardMetricsService } from '../../dashboard-metrics/dashboard-metrics.service';
import { Category } from '../../categories/entities/category.entity';
import { Product } from '../../products/entities/product.entity';
import { ProductImage } from '../../product-images/entities/product-image.entity';
import { SalesOrder } from '../../sales/sales-order.entity';
import { Store } from '../../stores/entities/store.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { TenantScope } from '../../auth/tenancy/tenant-scope';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * P5-A2 family 7 against real PostgreSQL.
 *
 * `getMetrics(organizationId ?? undefined)` produced an UNFILTERED count query
 * whenever the caller had no company, so this is a persistence-isolation
 * change and is proven against the database with two companies present.
 * Reports are store-shaped and additionally proven not to leak across branches.
 */
d('P5-A2 family 7 reporting tenancy (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let reports: ReportsController;
  let metrics: DashboardMetricsController;
  let metricsService: DashboardMetricsService;

  let ORG_A: string;
  let ORG_B: string;
  let STORE_A1: string;
  let STORE_A2: string;

  let managerA: TenantScope;
  let narrowedA: TenantScope;
  let managerB: TenantScope;
  const platform: TenantScope = {
    platform: true,
    role: 'SUPER_ADMIN',
    organizationId: null,
    storeId: null,
    allowedStoreIds: [],
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork();
    reports = new ReportsController(new ReportsService(em as any));
    metricsService = new DashboardMetricsService(
      em.getRepository(Category) as any,
      em.getRepository(Product) as any,
      em.getRepository(ProductImage) as any,
    );
    metrics = new DashboardMetricsController(metricsService);

    const organizationA = em.create(Organization, { name: 'Alpha', slug: 'alpha-reporting' } as any);
    const organizationB = em.create(Organization, { name: 'Beta', slug: 'beta-reporting' } as any);
    await em.persistAndFlush([organizationA, organizationB]);
    ORG_A = organizationA.id;
    ORG_B = organizationB.id;

    const mk = (name: string, slug: string, organization: Organization) =>
      em.create(Store, { name, slug, organization, createdAt: new Date(), updatedAt: new Date() } as any);
    const a1 = mk('Alpha Centro', 'alpha-centro-reporting', organizationA);
    const a2 = mk('Alpha Norte', 'alpha-norte-reporting', organizationA);
    const b1 = mk('Beta Única', 'beta-unica-reporting', organizationB);
    await em.persistAndFlush([a1, a2, b1]);
    STORE_A1 = a1.id;
    STORE_A2 = a2.id;

    // Money: A1 = 30, A2 = 50, B1 = 700 — a total that is impossible to confuse.
    const order = (store: Store, number: string, total: string) =>
      em.create(SalesOrder, {
        store,
        organization: (store as any).organization,
        orderNumber: number,
        status: 'PAID',
        totalUsd: total,
        subtotalUsd: total,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
    // Catalogue: 2 categories for A, 1 for B.
    const category = (name: string, organization: Organization) =>
      em.create(Category, { name, slug: `${name}-${organization.slug}`, organization } as any);
    await em.persistAndFlush([
      order(a1, 'RA1-1', '30.00'),
      order(a2, 'RA2-1', '50.00'),
      order(b1, 'RB1-1', '700.00'),
      category('cat-one', organizationA),
      category('cat-two', organizationA),
      category('cat-solo', organizationB),
    ]);

    // One published product per company, carried by one branch each, so the
    // product aggregate has something branch-shaped to count.
    const product = (name: string, organization: Organization) =>
      em.create(Product, {
        name,
        slug: `${name}-${organization.slug}`,
        organization,
        status: 'PUBLISHED',
        createdAt: new Date(),
        updatedAt: new Date(),
      } as any);
    const pA = product('prod-alpha', organizationA);
    const pB = product('prod-beta', organizationB);
    await em.persistAndFlush([pA, pB]);
    const conn = em.getConnection();
    await conn.execute(
      `insert into store_products (id, store_id, product_id, organization_id, track_inventory, stock_quantity, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?, true, 3, now(), now())`,
      [a1.id, pA.id, organizationA.id],
    );
    await conn.execute(
      `insert into store_products (id, store_id, product_id, organization_id, track_inventory, stock_quantity, created_at, updated_at)
       values (gen_random_uuid(), ?, ?, ?, true, 9, now(), now())`,
      [b1.id, pB.id, organizationB.id],
    );

    managerA = {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId: ORG_A,
      storeId: null,
      allowedStoreIds: [STORE_A1, STORE_A2],
    };
    narrowedA = { ...managerA, storeId: STORE_A1 };
    managerB = {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId: ORG_B,
      storeId: null,
      allowedStoreIds: [b1.id],
    };
  });

  afterAll(async () => {
    await pg.close();
  });

  /**
   * The branch-filtered path was BROKEN before this family: the store id array
   * was bound as one parameter, MikroORM flattened it, and PostgreSQL rejected
   * `any('<uuid>')` with `malformed array literal`. Every case below exercises
   * the repaired binding — one placeholder per id, nothing interpolated.
   */
  describe('reports', () => {
    it('(6) totals one company only — organization A never observes B', async () => {
      const res: any = await reports.summary({ scope: managerA });
      expect(res.data.sales.totalRevenue).toBe(80);
      const beta: any = await reports.summary({ scope: managerB });
      expect(beta.data.sales.totalRevenue).toBe(700);
    });

    it('(5) organization-wide reporting is correct with NO store filter', async () => {
      const res: any = await reports.summary({ scope: managerA });
      expect(res.data.storeIds).toEqual([]);
      expect(res.data.sales.totalCount).toBe(2);
      expect(res.data.products.total).toBe(1);
      expect(res.data.stock.trackedItems).toBe(1);
    });

    it('(1) an ADMIN reports on its exact branch', async () => {
      const admin: TenantScope = {
        platform: false,
        role: 'ADMIN',
        organizationId: ORG_A,
        storeId: STORE_A1,
        allowedStoreIds: [STORE_A1],
      };
      const res: any = await reports.summary({ scope: admin });
      expect(res.data.storeIds).toEqual([STORE_A1]);
      expect(res.data.sales.totalRevenue).toBe(30);
      expect(res.data.sales.totalCount).toBe(1);
    });

    it('(2) a narrowed manager and a narrowed managed owner see their exact branch', async () => {
      for (const scope of [narrowedA, { ...narrowedA, platform: true, role: 'SUPER_ADMIN' }]) {
        const res: any = await reports.summary({ scope });
        expect(res.data.sales.totalRevenue).toBe(30);
      }
    });

    it('(3) a sibling request from a narrowed actor is refused', async () => {
      await expect(reports.summary({ scope: narrowedA }, STORE_A2)).rejects.toThrow(NotFoundException);
    });

    it('(4) an un-narrowed authority may request ONE or MANY of its own branches', async () => {
      const one: any = await reports.summary({ scope: managerA }, STORE_A2);
      expect(one.data.sales.totalRevenue).toBe(50);

      const many: any = await reports.summary({ scope: managerA }, `${STORE_A1},${STORE_A2}`);
      expect(many.data.storeIds).toEqual([STORE_A1, STORE_A2]);
      expect(many.data.sales.totalRevenue).toBe(80);
    });

    it('(7) all four aggregates follow the same filter semantics', async () => {
      const branch: any = await reports.summary({ scope: managerA }, STORE_A1);
      // sales — only A1's order
      expect(branch.data.sales.totalCount).toBe(1);
      // stock — only A1's branch row
      expect(branch.data.stock.trackedItems).toBe(1);
      expect(branch.data.stock.lowStock).toBe(1);
      // products — what A1 carries
      expect(branch.data.products.total).toBe(1);
      // invoices — none seeded for A1
      expect(branch.data.invoices.total).toBe(0);

      const emptyBranch: any = await reports.summary({ scope: managerA }, STORE_A2);
      expect(emptyBranch.data.stock.trackedItems).toBe(0);
      expect(emptyBranch.data.products.total).toBe(0);
    });

    it("a foreign organization's branch never contributes, even if named", async () => {
      const foreignStore = (await em.fork().findOne(Store, { slug: 'beta-unica-reporting' }))!.id;
      await expect(reports.summary({ scope: managerA }, foreignStore)).rejects.toThrow(NotFoundException);
    });

    it('refuses the unscoped platform owner — no cross-client report is issued', async () => {
      await expect(reports.summary({ scope: platform })).rejects.toThrow(BadRequestException);
    });
  });

  describe('dashboard metrics', () => {
    it('counts one company only', async () => {
      const alpha: any = await metrics.getMetrics({ scope: managerA });
      const beta: any = await metrics.getMetrics({ scope: managerB });
      expect(alpha.categories.total).toBe(2);
      expect(beta.categories.total).toBe(1);
    });

    it('REFUSES the unscoped platform owner, and issues no unfiltered query', async () => {
      // Both layers refuse: the controller for lack of an organization, and the
      // service itself if any future caller reached it directly.
      await expect(metrics.getMetrics({ scope: platform })).rejects.toThrow(ForbiddenException);
      await expect(metricsService.getMetrics(undefined as any)).rejects.toThrow(ForbiddenException);

      // Proof the unfiltered shape is gone: the sum of the two companies is the
      // whole table, and neither call could ever have returned it.
      const wholeTable = await em.fork().count(Category, {});
      const alpha: any = await metrics.getMetrics({ scope: managerA });
      const beta: any = await metrics.getMetrics({ scope: managerB });
      expect(alpha.categories.total + beta.categories.total).toBe(wholeTable);
      expect(alpha.categories.total).toBeLessThan(wholeTable);
    });

    it('refuses a NARROWED organization actor — these numbers are company-wide', async () => {
      await expect(metrics.getMetrics({ scope: narrowedA })).rejects.toThrow(ForbiddenException);
    });
  });
});
