import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { raw } from '@mikro-orm/core';
import { EntityRepository } from '@mikro-orm/postgresql';
import { Product } from '../entities/product.entity';
import { Category } from '../../categories/entities/category.entity';
import { ProductStatus } from './product-status.enum';

export interface ProductListFilters {
  /**
   * An EXPLICIT store filter requested by the caller â€” "show me what branch X
   * publishes". Phase 4: this is a view preference, NOT a tenant boundary. It
   * is never derived from the actor's own binding; a branch admin sees the
   * whole company's catalogue unless they ask to narrow it.
   */
  storeFilterId?: string;
  /**
   * Per-website publication state, read WITH `storeFilterId` (ADR 029):
   * `true` = a member of that website and published there, `false` = a
   * member of that website but hidden there. Membership is part of both
   * answers â€” "not on that website" matches neither â€” so the list can name
   * exactly the products a bulk publish or hide would act on, and never a
   * product it would have to add first.
   */
  branchPublished?: boolean;
  /** Tenant boundary for list filters (P0-05); resolved from req.scope. */
  organizationId?: string;
  search?: string;
  status?: ProductStatus;
  categoryId?: string;
  trackInventory?: boolean;
  lowStock?: boolean;
  hasChildren?: boolean;
  /** Hierarchy role: parent product, child product, or standalone. */
  family?: 'parent' | 'child' | 'standalone';
  includeArchived?: boolean;
  minPrice?: number;
  maxPrice?: number;
  hasSalePrice?: boolean;
  hasImages?: boolean;
  hasCategory?: boolean;
  /**
   * Phase 8 C: SELLABLE NOW â€” the summed AVAILABLE ledger (P5-B7's rule, with
   * the owned figure as the pre-epoch fallback), never the owned column alone.
   * An untracked product is always sellable: it has no stock to run out of.
   */
  sellable?: boolean;
  /**
   * Exclude PARENT products â€” the cards a family shows on the website.
   *
   * WHAT THIS IS: a server-side filter on the SOURCE a selector is populated
   * from. Asking for it means "give me products that could be a line item", so
   * a picker never offers a card that holds no stock and no price of its own.
   * Doing it here rather than in the component means the parent is never sent
   * to the browser at all.
   *
   * WHAT THIS IS NOT: a submission boundary. It is optional and caller-chosen,
   * so it stops nothing that arrives by another route. The authority over a
   * submitted product id lives where the write happens â€”
   * `SalesService.priceCart`, which refuses a parent for every order path,
   * website and manual alike. Invoices need no such boundary: their lines carry
   * a name, a quantity and a price and no product id at all.
   *
   * DISTINCT from `sellable`, which is about STOCK, and from
   * `family: 'standalone'`, which also excludes children â€” and children are
   * exactly what a family sells.
   */
  excludeParents?: boolean;
  /**
   * Phase 8 C: ACTUAL publication completeness â€” the same predicate the
   * publication guard refuses on (an active+required branch field with no
   * effective answer), not a proxy like hasImages.
   */
  complete?: boolean;
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

/**
 * How many matching ids one "select everything that matches" may carry.
 *
 * A ceiling exists because the caller holds the whole list in memory and
 * sends it back in a request body. It is deliberately far above any catalogue
 * this product serves, so reaching it means something unusual is happening and
 * the answer says so rather than quietly returning a slice.
 */
export const PRODUCT_ID_SNAPSHOT_CAP = 10000;

export class ProductQueryService {
  constructor(
    private readonly productRepository: EntityRepository<Product>,
    private readonly categoryRepository: EntityRepository<Category>,
  ) {}

  async findAll(filters?: ProductListFilters): Promise<{
    items: Product[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const where = await this.buildProductWhere(filters);

    const page = Math.max(1, filters?.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters?.limit ?? 25));
    const offset = (page - 1) * limit;

    // Whitelist: an unknown sort field falls back instead of reaching SQL
    const SORTABLE = ['name', 'price', 'salePrice', 'stockQuantity', 'status', 'createdAt', 'updatedAt'];
    const sortBy = filters?.sortBy && SORTABLE.includes(filters.sortBy) ? filters.sortBy : 'createdAt';
    const sortDirection = filters?.sortDirection === 'asc' ? 'asc' : 'desc';

    const [items, total] = await this.productRepository.findAndCount(where, {
      // parent + children ride along so the list can badge each item's
      // family role (model / version) without extra requests
      populate: ['categories', 'images', 'stores', 'branchLinks', 'parent', 'children'],
      limit,
      offset,
      orderBy: { [sortBy]: sortDirection },
    });

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * A SNAPSHOT OF THE IDS MATCHING THE FILTERS, AND HOW MANY THERE REALLY ARE.
   *
   * `total` is counted WITHOUT the cap, so it is how many products match, not
   * how many ids came back; `truncated` says the two differ. Returning only a
   * capped list whose `total` was its own length made a selection of the
   * ceiling indistinguishable from a selection of everything: the list would
   * report "10,000 selected" for a filter matching far more, and a bulk action
   * would then run on an arbitrary part of it with nobody told. A caller that
   * must not act on a partial snapshot can now refuse instead.
   */
  async findMatchingIdSnapshot(
    filters?: ProductListFilters,
    cap: number = PRODUCT_ID_SNAPSHOT_CAP,
  ): Promise<{ ids: string[]; total: number; truncated: boolean }> {
    const where = await this.buildProductWhere(filters);
    const [rows, total] = await this.productRepository.findAndCount(where, {
      fields: ['id'],
      limit: cap,
    });
    const ids = rows.map((r) => r.id);
    return { ids, total, truncated: total > ids.length };
  }

  /** Every product id matching the filters, up to the snapshot cap. */
  async findMatchingIds(filters?: ProductListFilters): Promise<string[]> {
    return (await this.findMatchingIdSnapshot(filters)).ids;
  }

  /** Shared filter â†’ where-clause builder used by list + select-all. */
  private async buildProductWhere(filters?: ProductListFilters): Promise<any> {
    const andClauses: any[] = [];
    // PHASE 4: the company is the ONLY tenant boundary. Products belong to the
    // organization and every store shares them, so a branch admin listing
    // products sees the whole catalogue. Requiring the organization also closes
    // the store-less case, which previously produced an unscoped query.
    if (!filters?.organizationId) {
      throw new ForbiddenException(
        'Listing products requires an organization context; a platform administrator must supply X-Managed-Organization',
      );
    }
    andClauses.push({ organization: filters.organizationId });
    // An explicit, caller-requested narrowing â€” publication view, not tenancy.
    if (filters.storeFilterId) {
      andClauses.push({ stores: filters.storeFilterId });
    }
    // Publication state ON that website. It cannot be asked without naming
    // the website: "hidden" is a fact about one branch link, not a product.
    if (filters.branchPublished !== undefined) {
      if (!filters.storeFilterId) {
        throw new BadRequestException('branchPublished requires storeId');
      }
      andClauses.push({
        branchLinks: { $some: { store: filters.storeFilterId, published: filters.branchPublished } },
      });
    }
    if (!filters?.includeArchived) {
      andClauses.push({ archivedAt: null });
    }

    if (filters) {
      const {
        search,
        status,
        categoryId,
        trackInventory,
        lowStock,
        hasChildren,
        minPrice,
        maxPrice,
        hasSalePrice,
        hasImages,
        hasCategory,
        sellable,
        complete,
      } = filters;

      if (search) {
        // Subqueries stay inside the tenant (P0-05): matching another
        // client's category names would leak their vocabulary into results
        const tenant = filters.organizationId ? { organization: filters.organizationId } : {};
        const categories = await this.categoryRepository.find({
          name: { $ilike: `%${search}%` },
          archivedAt: null,
          ...tenant,
        });
        const categoryIds = categories.map((c) => c.id);

        const orClauses: any[] = [
          { name: { $ilike: `%${search}%` } },
          { slug: { $ilike: `%${search}%` } },
          { sku: { $ilike: `%${search}%` } },
          // A version's SKU should surface its model too â€” versions are
          // products themselves, so the direct sku clause already finds them.
          { children: { $some: { sku: { $ilike: `%${search}%` }, archivedAt: null } } },
          // The SUPPLIER's reference is searchable alongside our own (P5-W1,
          // governing decision 18): staff reconciling a supplier document have
          // the manufacturer's number in front of them, not ours. It is a
          // separate clause rather than a replacement â€” SKU identity is
          // unchanged, and a product answering either identity is found.
          { manufacturerCode: { $ilike: `%${search}%` } },
          { children: { $some: { manufacturerCode: { $ilike: `%${search}%` }, archivedAt: null } } },
        ];

        if (categoryIds.length > 0) {
          orClauses.push({ categories: { $in: categoryIds } });
        }

        andClauses.push({ $or: orClauses });
      }

      if (status) {
        andClauses.push({ status });
      }

      if (categoryId) {
        andClauses.push({ categories: categoryId });
      }

      if (lowStock) {
        // Running out: tracked items with 5 or fewer units left
        andClauses.push({ trackInventory: true, stockQuantity: { $lte: 5 } });
      }
      if (trackInventory !== undefined) {
        andClauses.push({ trackInventory });
      }

      if (hasChildren !== undefined) {
        // A family exists when the product has live children.
        if (hasChildren) {
          andClauses.push({ children: { $some: { archivedAt: null } } });
        } else {
          andClauses.push({ children: { $none: { archivedAt: null } } });
        }
      }

      // A parent is never a line item, so a selector asking for line-item
      // candidates is not handed one. The refusal of a parent id that arrives
      // anyway is `SalesService.priceCart`'s, not this filter's.
      if (filters.excludeParents) {
        andClauses.push({ children: { $none: {} } });
      }

      // Family role (P0-15): a model is any item with versions pointing at it
      if (filters.family === 'child') {
        andClauses.push({ parent: { $ne: null } });
      } else if (filters.family === 'parent') {
        andClauses.push({ children: { $some: {} } });
      } else if (filters.family === 'standalone') {
        andClauses.push({ parent: null, children: { $none: {} } });
      }

      if (minPrice !== undefined) {
        andClauses.push({ price: { $gte: minPrice } });
      }

      if (maxPrice !== undefined) {
        andClauses.push({ price: { $lte: maxPrice } });
      }

      if (hasSalePrice !== undefined) {
        if (hasSalePrice) {
          andClauses.push({ salePrice: { $ne: null } });
        } else {
          andClauses.push({ salePrice: null });
        }
      }

      if (hasImages !== undefined) {
        // #177: the previous version loaded EVERY active image row of the
        // organization into memory and pushed the distinct product ids back as
        // a giant $in â€” unbounded on both sides of the wire. The relational
        // subquery is the same shape `hasChildren` has always used, and the
        // database answers it without materializing anything.
        if (hasImages) {
          // A family card displays a live image from one of its versions when
          // it has no gallery of its own. Completeness must use that same
          // effective-image rule instead of reporting healthy cards as empty.
          andClauses.push({
            $or: [
              { images: { $some: { archivedAt: null } } },
              { children: { $some: { archivedAt: null, images: { $some: { archivedAt: null } } } } },
            ],
          });
        } else {
          andClauses.push({
            images: { $none: { archivedAt: null } },
            children: { $none: { archivedAt: null, images: { $some: { archivedAt: null } } } },
          });
        }
      }

      if (hasCategory !== undefined) {
        if (hasCategory) {
          andClauses.push({ categories: { $ne: null } });
        } else {
          andClauses.push({ categories: null });
        }
      }

      if (sellable !== undefined) {
        // The DISPLAYED availability rule (P5-B7), verbatim from the public
        // filter: summed AVAILABLE ledger, owned figure only as the pre-epoch
        // fallback â€” so this filter and the number on the screen cannot
        // disagree. The branch filter narrows the ledger probe to that
        // branch's shelf, exactly as the public channel's does. An untracked
        // product is always sellable: it has no stock to run out of.
        const ledger = filters.storeFilterId
          ? `(select sum(b.quantity) from inventory_balances b
                join inventory_locations l on l.id = b.location_id
               where b.product_id = {alias}.id and b.organization_id = ? and b.operational_state = 'AVAILABLE'
                 and l.kind = 'STORE' and l.store_id = ?)`
          : `(select sum(b.quantity) from inventory_balances b
               where b.product_id = {alias}.id and b.organization_id = ? and b.operational_state = 'AVAILABLE')`;
        const params = [filters.organizationId, ...(filters.storeFilterId ? [filters.storeFilterId] : [])];
        const sellableNow = (alias: string) =>
          `(${alias}.track_inventory = false or coalesce(${ledger.replace(/\{alias\}/g, alias)}, ${alias}.stock_quantity, 0) > 0)`;
        andClauses.push({
          [raw((alias) => (sellable ? sellableNow(alias) : `not ${sellableNow(alias)}`), params) as any]: true,
        });
      }

      if (complete !== undefined) {
        // The publication guard's own question, asked in SQL: does any branch
        // this product is assigned to demand (active + required) a field the
        // product does not EFFECTIVELY answer â€” its own value, or its model's
        // where applicability lets a version display it? Family models are
        // never incomplete themselves: the guard skips non-sellable shapes,
        // and so does this.
        //
        // #292: `products ch` needs no `removed_at` predicate. Removing a
        // version DETACHES it â€” `parent_id` is set to null and the original
        // parent is recorded in the tombstone â€” so a removed item is a child
        // of nobody in every query, filtered or raw. This fragment and
        // `PublicationGuardService.isSellableShape` therefore still agree,
        // which is the property the comment above claims.
        const missingRequired = (alias: string) => `(
          /* removed_at: a removed version is detached, so it is nobody's child */
          not exists (select 1 from products ch where ch.parent_id = ${alias}.id)
          and exists (
            select 1 from store_products sp
              join store_field_settings sfs
                on sfs.store_id = sp.store_id and sfs.active = true and sfs.required = true
             where sp.product_id = ${alias}.id
               and not exists (select 1 from product_field_values v
                                where v.product_id = ${alias}.id and v.definition_id = sfs.definition_id)
               and not exists (select 1 from product_field_values pv
                                 join product_field_definitions d on d.id = pv.definition_id
                                where ${alias}.parent_id is not null and pv.product_id = ${alias}.parent_id
                                  and pv.definition_id = sfs.definition_id and d.applicability <> 'CHILD')
          ))`;
        andClauses.push({
          [raw((alias) => (complete ? `not ${missingRequired(alias)}` : missingRequired(alias)), []) as any]: true,
        });
      }
    }

    return andClauses.length > 0 ? { $and: andClauses } : {};
  }

}

