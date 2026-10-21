import 'reflect-metadata';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ReportsController } from '../reports.controller';
import { DashboardMetricsController } from '../../dashboard-metrics/dashboard-metrics.controller';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';
import { TenantScope } from '../../auth/tenancy/tenant-scope';

/**
 * P5-A2 family 7 — reporting and metrics authority.
 *
 * Two different shapes, deliberately governed differently:
 *
 *   REPORTS are store-shaped in SQL (`sales_orders`, `invoices` and
 *   `store_products` all carry a store id), so branch isolation is real:
 *   organization authority sees the company, ADMIN its own branch.
 *
 *   DASHBOARD METRICS count categories, products and product images, which are
 *   organization-owned by construction — a category's store is provenance and
 *   never a boundary, an image has no store at all, and a draft product usually
 *   carries no branch link. Rather than redefine those numbers for a branch,
 *   the route is restricted to un-narrowed organization authority (option A).
 */

const ORG_A = 'org-a';
const STORE_A1 = 'store-a1';
const STORE_A2 = 'store-a2';

const scopeOf = (over: Partial<TenantScope>): TenantScope => ({
  platform: false,
  role: 'ORGANIZATION_MANAGER',
  organizationId: ORG_A,
  storeId: null,
  allowedStoreIds: [STORE_A1, STORE_A2],
  ...over,
});

const unscopedOwner = scopeOf({ platform: true, role: 'SUPER_ADMIN', organizationId: null, allowedStoreIds: [] });
const managedOwner = scopeOf({ platform: true, role: 'SUPER_ADMIN' });
const orgManager = scopeOf({});
const narrowedManager = scopeOf({ storeId: STORE_A1 });
const narrowedOwner = scopeOf({ platform: true, role: 'SUPER_ADMIN', storeId: STORE_A1 });
const storeAdmin = scopeOf({ role: 'ADMIN', storeId: STORE_A1, allowedStoreIds: [STORE_A1] });

const admits = (controller: any, handler: (...args: any[]) => unknown, roleName: string): boolean => {
  const guard = new RolesGuard(new Reflector());
  try {
    return (
      guard.canActivate({
        getHandler: () => handler,
        getClass: () => controller,
        switchToHttp: () => ({ getRequest: () => ({ user: { role: { name: roleName } } }) }),
      } as any) === true
    );
  } catch (error) {
    if (error instanceof ForbiddenException) return false;
    throw error;
  }
};

describe('reports route authority', () => {
  it('carries a complete explicit role list — an absent one admitted everyone', () => {
    expect(Reflect.getMetadata(ROLES_KEY, ReportsController)).toEqual(['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN']);
  });

  it('REFUSES EDITOR and VIEWER, which previously read organization revenue', () => {
    for (const role of ['EDITOR', 'VIEWER']) {
      expect(admits(ReportsController, ReportsController.prototype.summary, role)).toBe(false);
    }
    for (const role of ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN']) {
      expect(admits(ReportsController, ReportsController.prototype.summary, role)).toBe(true);
    }
  });
});

describe('reports scoping', () => {
  const build = () => {
    const reportsService = { summary: jest.fn().mockResolvedValue({}) };
    return { controller: new ReportsController(reportsService as any), reportsService };
  };

  it('refuses the unscoped platform owner — there is no cross-client report', async () => {
    const { controller, reportsService } = build();
    await expect(controller.summary({ scope: unscopedOwner })).rejects.toThrow(BadRequestException);
    expect(reportsService.summary).not.toHaveBeenCalled();
  });

  it('gives an un-narrowed organization actor the whole company', async () => {
    const { controller, reportsService } = build();
    await controller.summary({ scope: orgManager });
    expect(reportsService.summary).toHaveBeenCalledWith(ORG_A, []);
  });

  it('defaults a narrowed actor and an ADMIN to their own branch', async () => {
    for (const scope of [narrowedManager, narrowedOwner, storeAdmin]) {
      const { controller, reportsService } = build();
      await controller.summary({ scope });
      expect(reportsService.summary).toHaveBeenCalledWith(ORG_A, [STORE_A1]);
    }
  });

  it('lets an un-narrowed actor name a branch its scope allows', async () => {
    const { controller, reportsService } = build();
    await controller.summary({ scope: orgManager }, STORE_A2);
    expect(reportsService.summary).toHaveBeenCalledWith(ORG_A, [STORE_A2]);
  });

  it('NARROWING BINDS: a narrowed actor may not name a sibling branch', async () => {
    // `scopeAllowsStore` alone would have admitted this — a narrowed manager's
    // allow-list still contains every branch of its company.
    for (const scope of [narrowedManager, narrowedOwner]) {
      const { controller, reportsService } = build();
      await expect(controller.summary({ scope }, STORE_A2)).rejects.toThrow(NotFoundException);
      expect(reportsService.summary).not.toHaveBeenCalled();
    }
  });

  it('refuses a branch of another company', async () => {
    const { controller, reportsService } = build();
    await expect(controller.summary({ scope: orgManager }, 'store-of-another-tenant')).rejects.toThrow(
      NotFoundException,
    );
    expect(reportsService.summary).not.toHaveBeenCalled();
  });
});

describe('dashboard metrics are organization-wide only (option A)', () => {
  const build = () => {
    const dashboardMetricsService = { getMetrics: jest.fn().mockResolvedValue({}) };
    return {
      controller: new DashboardMetricsController(dashboardMetricsService as any),
      dashboardMetricsService,
    };
  };

  it('carries a complete explicit list: SUPER_ADMIN and ORGANIZATION_MANAGER', () => {
    expect(Reflect.getMetadata(ROLES_KEY, DashboardMetricsController.prototype.getMetrics)).toEqual([
      'SUPER_ADMIN',
      'ORGANIZATION_MANAGER',
    ]);
    for (const role of ['ADMIN', 'EDITOR', 'VIEWER']) {
      expect(admits(DashboardMetricsController, DashboardMetricsController.prototype.getMetrics, role)).toBe(false);
    }
  });

  it('serves un-narrowed organization authority', async () => {
    for (const scope of [orgManager, managedOwner]) {
      const { controller, dashboardMetricsService } = build();
      await controller.getMetrics({ scope });
      expect(dashboardMetricsService.getMetrics).toHaveBeenCalledWith(ORG_A);
    }
  });

  it('refuses while NARROWED — leave branch context to see the company', async () => {
    for (const scope of [narrowedManager, narrowedOwner]) {
      const { controller, dashboardMetricsService } = build();
      await expect(controller.getMetrics({ scope })).rejects.toThrow(ForbiddenException);
      expect(dashboardMetricsService.getMetrics).not.toHaveBeenCalled();
    }
  });

  it('refuses the unscoped platform owner, and issues no query', async () => {
    const { controller, dashboardMetricsService } = build();
    await expect(controller.getMetrics({ scope: unscopedOwner })).rejects.toThrow(ForbiddenException);
    expect(dashboardMetricsService.getMetrics).not.toHaveBeenCalled();
  });

  it('refuses a request with no resolved scope', async () => {
    const { controller, dashboardMetricsService } = build();
    await expect(controller.getMetrics({})).rejects.toThrow(ForbiddenException);
    expect(dashboardMetricsService.getMetrics).not.toHaveBeenCalled();
  });
});
