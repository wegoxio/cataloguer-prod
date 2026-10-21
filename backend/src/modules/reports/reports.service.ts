import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';

export interface ReportSummary {
  organizationId: string | null;
  /** The branches actually aggregated. */
  storeIds: string[];
  sales: {
    todayCount: number;
    todayTotal: number;
    weekCount: number;
    weekTotal: number;
    totalCount: number;
    totalRevenue: number;
  };
  stock: { trackedItems: number; lowStock: number; outOfStock: number };
  products: { total: number; draft: number; published: number; archived: number };
  activity: { ordersLast7Days: number };
}

/**
 * Server-side aggregates for the dashboard and reports (P0-08).
 *
 * Everything is computed in SQL over the WHOLE dataset of the organization
 * (optionally narrowed to some of its branches). The previous dashboard
 * derived its KPIs in the browser from `limit=100` samples, so any client
 * past a hundred orders a week was silently shown wrong numbers.
 *
 * The caller (controller) is responsible for having validated storeIds
 * against the scope — this service trusts them, and always additionally
 * pins every query to the organization.
 */
@Injectable()
export class ReportsService {
  constructor(private readonly em: EntityManager) {}

  async summary(organizationId: string | null, storeIds: string[]): Promise<ReportSummary> {
    const run = async (sql: string, params: unknown[]): Promise<any> =>
      (await this.em.getConnection().execute(sql, params))[0] ?? {};

    // Store filter shared by the store-shaped tables (P5-A2 family 7).
    //
    // PRE-EXISTING DEFECT, found by this family's PostgreSQL proof: the filter
    // was `and store_id = any(?)` with the id ARRAY passed as one parameter.
    // MikroORM flattens array parameters, so the placeholder received a single
    // uuid string and PostgreSQL rejected the statement with
    // `malformed array literal` — every branch-scoped report (ADMIN's default
    // view, and any narrowed actor's) failed outright. Only the organization-
    // wide path, where this fragment is empty, ever worked.
    //
    // The repair binds one placeholder PER ID instead of one array parameter:
    // nothing is interpolated, the values stay parameterized, and the shape is
    // immune to flattening for one id or many. `storeIds` has already been
    // validated against the caller's scope by the controller, and the
    // organization wall below is retained in every query regardless.
    const storePlaceholders = storeIds.map(() => '?').join(', ');
    const byStores = storeIds.length > 0 ? `and store_id in (${storePlaceholders})` : '';
    const storeParams = storeIds;

    // Cancelled orders count for volume history but not for revenue
    const sales = await run(
      `
      select
        count(*) filter (where created_at >= date_trunc('day', now()))::int                  as today_count,
        coalesce(sum(total_usd::numeric) filter (where created_at >= date_trunc('day', now()) and status <> 'CANCELLED'), 0)::float as today_total,
        count(*) filter (where created_at >= date_trunc('week', now()))::int                as week_count,
        coalesce(sum(total_usd::numeric) filter (where created_at >= date_trunc('week', now()) and status <> 'CANCELLED'), 0)::float as week_total,
        count(*)::int                                                                       as total_count,
        coalesce(sum(total_usd::numeric) filter (where status <> 'CANCELLED'), 0)::float    as total_revenue,
        count(*) filter (where created_at >= now() - interval '7 days')::int                as last7
      from sales_orders
      where store_id in (select id from stores where organization_id = ? and removed_at is null) ${byStores}
      `,
      [organizationId, ...storeParams],
    );

    // Stock lives per branch since P0-06 — aggregate the branch rows
    const stock = await run(
      `
      select
        count(*) filter (where track_inventory)::int                                as tracked,
        count(*) filter (where track_inventory and stock_quantity between 1 and 5)::int as low,
        count(*) filter (where track_inventory and stock_quantity <= 0)::int        as out
      from store_products
      where organization_id = ? ${byStores}
      `,
      [organizationId, ...storeParams],
    );

    // Products belong to the organization, not a branch; when the caller
    // narrows to branches, count what those branches carry
    const products = storeIds.length
      ? await run(
          `
          select count(distinct p.id)::int as total,
            count(distinct p.id) filter (where p.status = 'DRAFT' and p.archived_at is null)::int  as draft,
            count(distinct p.id) filter (where p.status = 'PUBLISHED' and p.archived_at is null)::int as published,
            count(distinct p.id) filter (where p.archived_at is not null)::int as archived
          from products p join store_products sp on sp.product_id = p.id
          -- #292: a removed item is counted nowhere. Reporting is an ordinary
          -- operation, and a total that includes invisible rows is a number
          -- nobody can reconcile against the screen that produced it.
          where p.organization_id = ? and p.removed_at is null and sp.store_id in (${storePlaceholders})
          `,
          [organizationId, ...storeIds],
        )
      : await run(
          `
          select count(*)::int as total,
            count(*) filter (where status = 'DRAFT' and archived_at is null)::int  as draft,
            count(*) filter (where status = 'PUBLISHED' and archived_at is null)::int as published,
            count(*) filter (where archived_at is not null)::int as archived
          -- #292: as above, removed items are counted nowhere.
          from products where organization_id = ? and removed_at is null
          `,
          [organizationId],
        );

    return {
      organizationId,
      storeIds,
      sales: {
        todayCount: sales.today_count ?? 0,
        todayTotal: sales.today_total ?? 0,
        weekCount: sales.week_count ?? 0,
        weekTotal: sales.week_total ?? 0,
        totalCount: sales.total_count ?? 0,
        totalRevenue: sales.total_revenue ?? 0,
      },
      stock: {
        trackedItems: stock.tracked ?? 0,
        lowStock: stock.low ?? 0,
        outOfStock: stock.out ?? 0,
      },
      products: {
        total: products.total ?? 0,
        draft: products.draft ?? 0,
        published: products.published ?? 0,
        archived: products.archived ?? 0,
      },
      activity: { ordersLast7Days: sales.last7 ?? 0 },
    };
  }
}
