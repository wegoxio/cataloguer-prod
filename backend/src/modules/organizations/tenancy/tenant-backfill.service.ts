import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { Organization } from '../entities/organization.entity';

export interface BackfillConflict {
  kind: string;
  detail: string;
  count: number;
}

export interface BackfillReport {
  organizations: number;
  stores: number;
  storesWithoutOrganization: number;
  /** Per-table row counts, so the numbers can be reconciled after migrating. */
  tenantRows: Record<string, number>;
  conflicts: BackfillConflict[];
  /** True when nothing needs a human decision. */
  clean: boolean;
}

/**
 * Reports what the tenant backfill did, and what it could not decide alone
 * (P0-02).
 *
 * The migration itself never guesses that two stores are one company. This
 * report is how a human sees the cases that need judgement — above all a
 * product shared by stores that ended up in different organizations, which
 * only appears once a catalogue spans branches.
 */
@Injectable()
export class TenantBackfillService {
  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: EntityRepository<Organization>,
  ) {}

  async report(): Promise<BackfillReport> {
    const em = this.organizationRepository.getEntityManager();
    const one = async (sql: string): Promise<number> => {
      const rows = await em.getConnection().execute(sql);
      return Number(rows?.[0]?.n ?? 0);
    };

    const organizations = await one(
      `select count(*)::int as n from organizations /* removed_at: a structural census counts every company, removed ones included, by design */`,
    );
    /**
     * A STRUCTURAL CENSUS COUNTS EVERY ROW, INCLUDING REMOVED ONES (#293).
     *
     * This report answers "does every store have an organization?", which is a
     * question about the SHAPE of the table rather than about what a tenant can
     * see. A removed branch with a null `organization_id` is exactly as broken
     * as a live one, and hiding it would let the backfill report the schema as
     * clean while leaving a row nothing could ever repair.
     */
    const stores = await one(
      `select count(*)::int as n from stores /* removed_at: a structural census counts all rows */`,
    );
    const storesWithoutOrganization = await one(
      `select count(*)::int as n from stores where organization_id is null /* removed_at: structural, counts all rows */`,
    );

    const tenantRows: Record<string, number> = {};
    for (const table of [
      'users',
      'categories',
      'products',
      'sales_orders',
      'payments',
      'api_keys',
      'discount_codes',
    ]) {
      tenantRows[table] = await one(`select count(*)::int as n from ${table}`);
    }

    const conflicts: BackfillConflict[] = [];

    // The one case the backfill genuinely cannot resolve: a product sold by
    // stores that are now different organizations has two owners.
    const crossOrgProducts = await one(`
      select count(*)::int as n from (
        select ps.product_id
        from store_products ps
        join stores s on s.id = ps.store_id
        where s.organization_id is not null
        group by ps.product_id
        having count(distinct s.organization_id) > 1
      ) x
      /* removed_at: structural — a product split across companies is
         unresolvable whether or not one of those branches is removed, and
         ignoring the removed side would report a conflict as resolved */
    `);
    if (crossOrgProducts > 0) {
      conflicts.push({
        kind: 'product-spans-organizations',
        detail: 'Sold by stores now in different organizations; ownership needs a human decision (see #202).',
        count: crossOrgProducts,
      });
    }

    // #292: a removed item is not a tenancy conflict waiting to be repaired.
    // It is deliberately outside every branch, so counting it here would
    // report work that must not be done.
    const orphanProducts = await one(`
      select count(*)::int as n from products p
      where p.removed_at is null
        and not exists (select 1 from store_products ps where ps.product_id = p.id)
    `);
    if (orphanProducts > 0) {
      conflicts.push({
        kind: 'product-without-store',
        detail: 'Belongs to no store, so no organization can be inferred.',
        count: orphanProducts,
      });
    }

    // A tenant user with no store cannot be placed. A real SUPER_ADMIN with no
    // store is correct and is not counted.
    const tenantUsersWithoutStore = await one(`
      select count(*)::int as n from users u
      left join roles r on r.id = u.role_id
      where u.store_id is null and coalesce(r.name, '') <> 'SUPER_ADMIN'
        and u.removed_at is null
    `);
    if (tenantUsersWithoutStore > 0) {
      conflicts.push({
        kind: 'tenant-user-without-store',
        detail: 'Not a SUPER_ADMIN yet belongs to no store, so no organization can be inferred (see #194).',
        count: tenantUsersWithoutStore,
      });
    }

    // #292: likewise for categories.
    const categoriesWithoutStore = await one(
      `select count(*)::int as n from categories where store_id is null and removed_at is null`,
    );
    if (categoriesWithoutStore > 0) {
      conflicts.push({
        kind: 'category-without-store',
        detail: 'Legacy global category; needs assigning to an organization (see #195).',
        count: categoriesWithoutStore,
      });
    }

    return {
      organizations,
      stores,
      storesWithoutOrganization,
      tenantRows,
      conflicts,
      clean: storesWithoutOrganization === 0 && conflicts.length === 0,
    };
  }
}
