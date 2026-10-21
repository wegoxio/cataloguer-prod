import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { raw } from '@mikro-orm/core';
import { EntityRepository } from '@mikro-orm/postgresql';
import { PublicQueryError } from './query/public-query';
import { Category } from '../categories/entities/category.entity';
import { CategoryNode, resolveAncestors } from '../categories/hierarchy/category-ancestry';
import { Product } from '../products/entities/product.entity';
import { Store } from '../stores/entities/store.entity';
import { ProductStatus } from '../products/catalogue/product-status.enum';
import { cardHasVisibleChildrenWhere, familyVisibleClause, visibleChildWhere } from './query/child-visibility';
import { StoreFieldSetting } from '../products/entities/store-field-setting.entity';
import { ProductFieldValue } from '../products/entities/product-field-value.entity';
import { ProductFieldDefinition, ProductFieldType } from '../products/entities/product-field-definition.entity';
import { readFieldValue } from '../products/fields/product-field.util';
import { convertUnitValue, curatedFieldByKey } from '../products/fields/curated-field-registry';
import { ProductRelation } from '../products/entities/product-relation.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { ProductTranslation } from '../localization/entities/product-translation.entity';
import { CategoryTranslation } from '../localization/entities/category-translation.entity';
import {
  LocaleVariant,
  ResolvedLocalizedText,
  localeLanguage,
  normalizeLocale,
  resolveLocalizedText,
} from '../localization/shared/locale.util';
import {
  PublicCategoryAncestorDto,
  PublicCategoryDto,
  PublicFieldDto,
  PublicProductDto,
  PublicRelatedProductDto,
  mapCategoryToPublicDto,
  mapProductToPublicDto,
} from './dto/public-catalogue.dto';

/**
 * What makes a product publicly visible, in ONE place.
 *
 * Every public read composes these clauses — the listing, the slug lookup, the
 * category listing and (Phase 3) related-product resolution. Reproducing the
 * rules per call site is how a "related products" strip eventually leaks an
 * unpublished item: the copy that was never updated wins. Listing-only
 * concerns (one card per family) are added by the caller, because they are
 * about which rows to SHOW, not about who may see them.
 */
export function publicVisibilityClauses(options?: { organizationId?: string; storeId?: string }): any[] {
  const clauses: any[] = [
    { status: ProductStatus.PUBLISHED },
    { archivedAt: null },
    { $or: [{ categories: null }, { categories: { archivedAt: null } }] },
  ];
  if (options?.organizationId) clauses.push({ organization: options.organizationId });
  if (options?.storeId) clauses.push({ branchLinks: { store: options.storeId, published: true } });
  // A parent whose every child is hidden HERE shows an empty card with no
  // buyable option — and its detail page must be as absent as any other
  // unavailable product, so the suppression lives with the other visibility
  // rules rather than being repeated per endpoint. Appended last so the
  // category `$or` keeps the index `getProducts` locates it by.
  clauses.push(cardHasVisibleChildrenWhere({ storeId: options?.storeId }));
  return clauses;
}

/**
 * The same rules as one flat object, for the call sites that always built one.
 *
 * Every clause names a distinct key, so merging reproduces the exact `where`
 * those queries emitted before the extraction — which is how this refactor
 * proves it changed no query, only where the rules live.
 */
export function publicVisibilityWhere(options?: { organizationId?: string; storeId?: string }): Record<string, any> {
  return Object.assign({}, ...publicVisibilityClauses(options));
}

@Injectable()
export class PublicCatalogueService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: EntityRepository<Category>,
    @InjectRepository(Product)
    private readonly productRepository: EntityRepository<Product>,
    @InjectRepository(Store)
    private readonly storeRepository: EntityRepository<Store>,
    @InjectRepository(ProductRelation)
    private readonly productRelationRepository: EntityRepository<ProductRelation>,
  ) {}

  private async categoryPublications(options: {
    organizationId: string;
    storeId: string;
    channel?: string;
    placement?: string;
    group?: string;
  }): Promise<Array<{ category_id: string; channel_key: string; public_label: string | null; sort_order: number; placements: string[]; group_keys: string[]; image_url: string | null; product_count: number }>> {
    const params: unknown[] = [options.organizationId, options.storeId];
    const clauses = ['cp.organization_id = ?::uuid', 'cp.store_id = ?::uuid', 'cp.visible = true', 'ch.active = true'];
    if (options.channel) { clauses.push('ch.key = ?'); params.push(options.channel); }
    if (options.placement) { clauses.push('cp.placements @> ?::jsonb'); params.push(JSON.stringify([options.placement])); }
    if (options.group) {
      clauses.push(`exists (select 1 from catalogue_group_categories xgc join catalogue_groups xg on xg.id = xgc.group_id where xgc.category_id = cp.category_id and xg.channel_id = cp.channel_id and xg.active = true and xg.key = ?)`);
      params.push(options.group);
    }
    return this.categoryRepository.getEntityManager().execute(
      `select cp.category_id, ch.key as channel_key, cp.public_label, cp.sort_order,
              cp.placements,
              coalesce(array_agg(distinct g.key) filter (where g.active = true), '{}') as group_keys,
              img.url as image_url,
              (select count(distinct p.id)::int from product_categories pc
                join products p on p.id = pc.product_id
                join store_products sp on sp.product_id = p.id and sp.store_id = cp.store_id and sp.published = true
               where pc.category_id = cp.category_id and p.status = 'PUBLISHED' and p.parent_id is null
                 and p.archived_at is null and p.removed_at is null) as product_count
         from store_category_publications cp
         join catalogue_channels ch on ch.id = cp.channel_id
         left join catalogue_group_categories gc on gc.category_id = cp.category_id and gc.store_id = cp.store_id
         left join catalogue_groups g on g.id = gc.group_id and g.channel_id = cp.channel_id
         left join lateral (
           select pi.url from product_images pi
            where pi.product_id = coalesce(cp.cover_product_id, (
              select pc2.product_id from product_categories pc2
              join products p2 on p2.id = pc2.product_id and p2.status = 'PUBLISHED'
                and p2.parent_id is null and p2.archived_at is null and p2.removed_at is null
              join store_products sp2 on sp2.product_id = p2.id and sp2.store_id = cp.store_id and sp2.published = true
              where pc2.category_id = cp.category_id order by p2.created_at desc limit 1
            )) and pi.archived_at is null
            order by pi.is_primary desc, pi.sort_order asc, pi.created_at asc limit 1
         ) img on true
        where ${clauses.join(' and ')}
        group by cp.category_id, cp.store_id, cp.cover_product_id, ch.key, cp.public_label, cp.sort_order, cp.placements, img.url
        order by cp.sort_order asc, cp.category_id asc`,
      params,
    );
  }

  private async channelCategoryIdsForProducts(organizationId: string, storeId: string, channel: string): Promise<string[] | null> {
    const rows = await this.categoryRepository.getEntityManager().execute<{ category_id: string }[]>(
      `select cp.category_id from store_category_publications cp
       join catalogue_channels ch on ch.id = cp.channel_id
       where cp.organization_id = ?::uuid and cp.store_id = ?::uuid and ch.key = ? and ch.active = true and cp.visible = true`,
      [organizationId, storeId, channel],
    );
    return rows.length ? rows.map((row) => row.category_id) : null;
  }

  async getGroups(options: { organizationId?: string; storeId?: string; channel?: string; purpose?: string; placement?: string }) {
    if (!options.organizationId || !options.storeId) return { items: [] };
    const params: unknown[] = [options.organizationId, options.storeId];
    const clauses = ['g.organization_id = ?::uuid', 'g.store_id = ?::uuid', 'g.active = true', 'ch.active = true'];
    if (options.channel) { clauses.push('ch.key = ?'); params.push(options.channel); }
    if (options.purpose) { clauses.push('g.purpose = ?'); params.push(options.purpose); }
    if (options.placement) { clauses.push('g.placements @> ?::jsonb'); params.push(JSON.stringify([options.placement])); }
    const rows = await this.categoryRepository.getEntityManager().execute<any[]>(
      `select g.id, g.key, g.name, g.description, g.purpose, g.placements, g.sort_order, ch.key as channel_key,
              img.url as image_url,
              coalesce(array_agg(c.id order by gc.sort_order) filter (where c.id is not null), '{}') as category_ids,
              coalesce(array_agg(c.slug order by gc.sort_order) filter (where c.id is not null), '{}') as category_slugs,
              count(distinct sp.product_id)::int as product_count
         from catalogue_groups g join catalogue_channels ch on ch.id = g.channel_id
         left join catalogue_group_categories gc on gc.group_id = g.id
         left join categories c on c.id = gc.category_id and c.archived_at is null and c.removed_at is null
         left join store_category_publications cp on cp.category_id = c.id and cp.channel_id = ch.id and cp.store_id = g.store_id and cp.visible = true
         left join product_categories pc on pc.category_id = c.id
         left join products grouped_product on grouped_product.id = pc.product_id
           and grouped_product.organization_id = g.organization_id
           and grouped_product.status = 'PUBLISHED'
           and grouped_product.archived_at is null and grouped_product.removed_at is null
           and grouped_product.parent_id is null
         left join store_products sp on sp.product_id = grouped_product.id and sp.store_id = g.store_id and sp.published = true
         left join lateral (select pi.url from product_images pi where pi.product_id = coalesce(g.cover_product_id, (
           select pc2.product_id from catalogue_group_categories gc2
           join product_categories pc2 on pc2.category_id = gc2.category_id
           join products p2 on p2.id = pc2.product_id and p2.status = 'PUBLISHED'
             and p2.parent_id is null and p2.archived_at is null and p2.removed_at is null
           join store_products sp2 on sp2.product_id = p2.id and sp2.store_id = g.store_id and sp2.published = true
           where gc2.group_id = g.id order by p2.created_at desc limit 1
         )) and pi.archived_at is null order by pi.is_primary desc, pi.sort_order, pi.created_at limit 1) img on true
        where ${clauses.join(' and ')}
        group by g.id, ch.key, img.url order by g.sort_order, g.name, g.id`,
      params,
    );
    return { items: rows.map((row) => ({ id: row.id, key: row.key, name: row.name, description: row.description, purpose: row.purpose, placements: row.placements, sortOrder: row.sort_order, channelKey: row.channel_key, imageUrl: row.image_url, categoryIds: row.category_ids, categorySlugs: row.category_slugs, productCount: Number(row.product_count) })) };
  }

  private async groupCategoryIdsForProducts(organizationId: string, storeId: string, channel: string | undefined, group: string): Promise<string[] | null> {
    const params: unknown[] = [organizationId, storeId, group];
    const channelClause = channel ? 'and ch.key = ?' : '';
    if (channel) params.push(channel);
    const rows = await this.categoryRepository.getEntityManager().execute<{ category_id: string }[]>(
      `select gc.category_id from catalogue_group_categories gc
       join catalogue_groups g on g.id = gc.group_id and g.active = true
       join catalogue_channels ch on ch.id = g.channel_id and ch.active = true
       where g.organization_id = ?::uuid and g.store_id = ?::uuid and g.key = ? ${channelClause}`,
      params,
    );
    return rows.length ? rows.map((row) => row.category_id) : null;
  }

  /**
   * Every category the caller's key can see, as a lookup for ancestry (Phase 4).
   *
   * ONE bounded query per request, never a walk per category: resolving a
   * four-level path by following `parentCategory` relations would be four
   * round-trips for every category on every product.
   *
   * THE SCOPE IS THE COMPANY, and only the company (corrected in P5-W3). It
   * used to be the company AND `store_id IN (this branch, NULL)`, which read
   * a PROVENANCE column as a boundary: Phase 4 settled that a category belongs
   * to the organization and every branch shares it, and the entity says
   * outright that origin "must never restrict who can see, use, parent or
   * assign the category". The practical effect of the old filter was a
   * TRUNCATED breadcrumb — a path through a category a sibling branch happened
   * to create simply stopped — which published a route the visitor could not
   * take. Tenancy is unchanged and still absolute: the company is required,
   * and a parent outside it ends the path.
   */
  private async categoryAncestryIndex(organizationId: string): Promise<Map<string, CategoryNode>> {
    // `organizationId` is REQUIRED, not optional-with-a-fallback. An optional
    // parameter here would mean one forgetful caller could issue an unscoped
    // query across every company's categories — an additive presentation
    // feature is not allowed to open that. Callers that cannot establish a
    // company skip ancestry entirely rather than widening the query.
    if (!organizationId) throw new Error('categoryAncestryIndex requires an organization');

    const where: Record<string, unknown> = { organization: organizationId };

    const rows = await this.categoryRepository.find(where as never, {
      fields: ['id', 'parentCategory', 'name', 'slug', 'publicLabel', 'sortOrder', 'archivedAt'] as never,
    });

    const index = new Map<string, CategoryNode>();
    for (const row of rows as any[]) {
      index.set(row.id, {
        id: row.id,
        parentId: row.parentCategory?.id ?? row.parentCategory ?? null,
        name: row.name,
        slug: row.slug,
        publicLabel: row.publicLabel ?? null,
        sortOrder: row.sortOrder ?? 0,
        archivedAt: row.archivedAt ?? null,
      });
    }
    return index;
  }

  /**
   * Ancestry for every category on a page of products, from the SAME single
   * bounded index the category listing uses (Phase 4). One query per request
   * regardless of how many products or categories load.
   *
   * FAILS CLOSED ON SCOPE. The company is taken from the products themselves,
   * not from whatever the caller happened to pass — `getProductsByCategorySlug`
   * has never required an organization, so trusting the argument would let one
   * call site issue an unscoped category read. If the products do not agree on
   * exactly one company, or carry none, ancestry is omitted and NO query runs.
   * Paths are presentation; they are never worth a widened query.
   */
  private async ancestorsForProducts(
    products: Product[],
    options?: { organizationId?: string; storeId?: string },
  ): Promise<Map<string, PublicCategoryAncestorDto[]>> {
    const byCategory = new Map<string, PublicCategoryAncestorDto[]>();
    if (products.length === 0) return byCategory;

    const organizations = new Set<string>();
    for (const product of products) {
      const id = (product as any).organization?.id ?? (product as any).organization ?? null;
      if (id) organizations.add(String(id));
    }
    // Zero means untenanted rows reached a public read; more than one means a
    // page spanning companies. Neither should happen, and neither justifies
    // guessing which company's tree to walk.
    if (organizations.size !== 1) return byCategory;
    const organizationId = [...organizations][0];
    // A caller that named a different company than the products belong to is
    // incoherent; refuse rather than silently preferring one of them.
    if (options?.organizationId && options.organizationId !== organizationId) return byCategory;

    const categoryIds = new Set<string>();
    for (const product of products) {
      if (!product.categories?.isInitialized()) continue;
      for (const category of product.categories.getItems()) categoryIds.add(category.id);
    }
    if (categoryIds.size === 0) return byCategory;

    const index = await this.categoryAncestryIndex(organizationId);
    for (const id of categoryIds) byCategory.set(id, resolveAncestors(index, id));
    return byCategory;
  }

  /**
   * The categories a CHANNEL actually publishes (P5-W3).
   *
   * The listing this replaces filtered by `categories.store_id`, which is
   * PROVENANCE and not a boundary: Phase 4 corrected that column to mean
   * "which branch created this", and its own entity comment records that it
   * "must never restrict who can see, use, parent or assign the category".
   * The public listing was the last reader still treating it as a fence, and
   * it got the answer wrong in BOTH directions — an organization-level
   * category (`store_id IS NULL`) was invisible to every store key even when
   * that channel published products filed under it, while a category created
   * by this branch was listed even when the channel published nothing in it.
   *
   * Eligibility is now derived from the catalogue the channel actually
   * exposes: a category is listed when at least one product that THIS channel
   * publishes is filed under it, plus every ancestor on those categories'
   * paths so a breadcrumb resolves to a real chain. Family children count —
   * a child is publicly resolvable by slug — and archived categories and
   * archived products never do.
   *
   * ONE bounded query, scoped by organization AND store in the predicate, so
   * a category of another company cannot enter the set even if an id leaks.
   */
  private async channelCategoryIds(organizationId: string, storeId: string): Promise<string[]> {
    const rows: { category_id: string }[] = await this.categoryRepository.getEntityManager().execute(
      `select distinct pc.category_id
         from product_categories pc
         join products p on p.id = pc.product_id
         join store_products sp
           on sp.product_id = p.id and sp.store_id = ?::uuid and sp.published = true
         join categories c on c.id = pc.category_id
        where p.organization_id = ?::uuid
          and p.status = 'PUBLISHED'
          and p.archived_at is null
          -- #292: a removed item or a removed category is absent from the
          -- storefront. The ORM filter cannot reach a hand-written join, so
          -- both sides are excluded explicitly here.
          and p.removed_at is null
          and c.removed_at is null
          and c.organization_id = ?::uuid
          and c.archived_at is null`,
      [storeId, organizationId, organizationId],
    );
    return rows.map((row) => row.category_id);
  }

  async getCategories(options?: {
    organizationId?: string;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortDirection?: 'asc' | 'desc';
    storeId?: string;
    /** Requested content language (P5-W2). Absent = the canonical copy. */
    locale?: string | null;
    channel?: string;
    placement?: string;
    group?: string;
  }): Promise<{ items: PublicCategoryDto[]; total: number; page: number; limit: number; totalPages: number }> {
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.min(100, Math.max(1, options?.limit ?? 25));
    let offset = (page - 1) * limit;

    const sortBy = options?.sortBy || 'createdAt';
    const sortDirection = options?.sortDirection || 'desc';

    // Store-owned categories: a store's website (or its scoped admin)
    // only receives categories belonging to that store
    const where: Record<string, unknown> = { archivedAt: null };
    // P0-10: the key's client bounds everything, even if ids leak
    if (options?.organizationId) where.organization = options.organizationId;
    let publicationRows: Awaited<ReturnType<PublicCatalogueService['categoryPublications']>> | null = null;
    if (options?.storeId && (options.channel || options.placement || options.group)) {
      if (!options.organizationId) return { items: [], total: 0, page, limit, totalPages: 0 };
      publicationRows = await this.categoryPublications({
        organizationId: options.organizationId,
        storeId: options.storeId,
        channel: options.channel,
        placement: options.placement,
        group: options.group,
      });
      const pageRows = publicationRows.slice(offset, offset + limit);
      if (!pageRows.length) return { items: [], total: publicationRows.length, page, limit, totalPages: Math.ceil(publicationRows.length / limit) };
      where.id = { $in: pageRows.map((row) => row.category_id) };
      offset = 0;
    } else if (options?.storeId) {
      // P5-W3: a CHANNEL lists the categories its own published catalogue
      // reaches, plus their paths — not the categories that happened to be
      // created by this branch. See `channelCategoryIds`.
      //
      // Without a company there is nothing to derive eligibility from, and a
      // store id alone must not widen the read, so the listing is empty. A
      // real key always resolves both (ADR 005 / P0-10).
      if (!options.organizationId) {
        return { items: [], total: 0, page, limit, totalPages: 0 };
      }
      const direct = await this.channelCategoryIds(options.organizationId, options.storeId);
      const eligible = new Set(direct);
      if (eligible.size > 0) {
        const index = await this.categoryAncestryIndex(options.organizationId);
        for (const id of direct) {
          for (const ancestor of resolveAncestors(index, id)) eligible.add(ancestor.id);
        }
      }
      if (eligible.size === 0) {
        return { items: [], total: 0, page, limit, totalPages: 0 };
      }
      where.id = { $in: [...eligible] };
    }
    const [foundCategories, legacyTotal] = await this.categoryRepository.findAndCount(where, {
      // branch and type. An id alone must never be enough to publish a picture.
      populate: ['parentCategory'] as never,
      limit,
      offset,
      orderBy:
        // Deterministic on EVERY sort (Phase 6): equal ranks, equal names or
        // equal timestamps would otherwise come back in whatever order the
        // planner chose that day, and a paginated consumer would see rows
        // repeat or vanish across pages. The id is the final tie-break.
        sortBy === 'sortOrder'
          ? ({ sortOrder: sortDirection, name: 'asc', id: 'asc' } as never)
          : ({ [sortBy]: sortDirection, id: sortDirection } as never),
    });
    const publicationById = new Map((publicationRows ?? []).map((row) => [row.category_id, row]));
    const categories = publicationRows
      ? [...foundCategories].sort((a, b) => publicationRows!.findIndex((row) => row.category_id === a.id) - publicationRows!.findIndex((row) => row.category_id === b.id))
      : foundCategories;
    const total = publicationRows?.length ?? legacyTotal;

    // No company in context (an admin session rather than a store key) means
    // no ancestry: paths are omitted rather than resolved from an unscoped
    // read. Every other field is unaffected.
    const ancestry = options?.organizationId
      ? await this.categoryAncestryIndex(options.organizationId)
      : new Map<string, CategoryNode>();

    const ancestorsByCategory = new Map(
      categories.map((category) => [category.id, resolveAncestors(ancestry, category.id)]),
    );
    // Every id the rendered page can show text for: the categories themselves,
    // their single-level parents and their full paths.
    const localizedIds = new Set<string>();
    for (const category of categories) {
      localizedIds.add(category.id);
      const parent = (category as unknown as { parentCategory?: { id?: string } | string | null }).parentCategory;
      const parentId = typeof parent === 'string' ? parent : (parent?.id ?? null);
      if (parentId) localizedIds.add(parentId);
      for (const ancestor of ancestorsByCategory.get(category.id) ?? []) localizedIds.add(ancestor.id);
    }
    const localization = await this.localizationFor({
      organizationId: options?.organizationId,
      locale: options?.locale,
      categoryIds: [...localizedIds],
    });

    return {
      items: categories.map((category) => {
        const dto = mapCategoryToPublicDto(
          category,
          ancestorsByCategory.get(category.id) ?? [],
          localization.byCategory,
          localization.canonicalLocale,
        );
        const publication = publicationById.get(category.id);
        if (publication) {
          dto.publicLabel = publication.public_label ?? dto.publicLabel;
          dto.sortOrder = publication.sort_order;
          dto.imageUrl = publication.image_url;
          dto.channelKey = publication.channel_key;
          dto.placements = publication.placements;
          dto.groupKeys = publication.group_keys;
          dto.productCount = Number(publication.product_count);
        }
        return dto;
      }),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * The key's branch's public fields for a page of products (B4a3), in TWO
   * bounded queries — settings once, values once — never per product or per
   * field.
   *
   * Only the RESOLVED store's own choices appear: its active, publicly
   * visible settings on live definitions, in the branch's own order
   * (setting.sortOrder, falling back to the definition's, tie-broken by key
   * so equal ranks are deterministic). No store context, no fields. Values
   * are EFFECTIVE (Phase 2): a child without its own answer displays the
   * parent product's wherever applicability allows, labeled `inherited` — and
   * an unanswered field is null.
   */
  private async publicFieldsByProduct(
    storeId: string | undefined,
    products: { id: string; parentId: string | null }[],
  ): Promise<Map<string, PublicFieldDto[]>> {
    const fieldsByProduct = new Map<string, PublicFieldDto[]>();
    if (!storeId || products.length === 0) return fieldsByProduct;

    const em = this.storeRepository.getEntityManager();
    const settings = await em.find(
      StoreFieldSetting,
      { store: storeId, active: true, publiclyVisible: true },
      { populate: ['definition'] as never },
    );
    const shown = settings
      .map((setting) => ({ setting, definition: setting.definition as unknown as ProductFieldDefinition }))
      .filter(({ definition }) => !definition.archivedAt)
      .sort(
        (a, b) =>
          (a.setting.sortOrder ?? a.definition.sortOrder) - (b.setting.sortOrder ?? b.definition.sortOrder) ||
          a.definition.key.localeCompare(b.definition.key),
      );
    if (shown.length === 0) return fieldsByProduct;

    // EFFECTIVE resolution (Phase 2): one lookup covers the products AND
    // their parent products; a child without its own answer displays the
    // parent's, wherever applicability lets it (PARENT or BOTH). Nothing is
    // copied — inheritance is resolved per read.
    const lookupIds = new Set<string>();
    for (const product of products) {
      lookupIds.add(product.id);
      if (product.parentId) lookupIds.add(product.parentId);
    }
    const values = await em.find(ProductFieldValue, {
      product: { $in: Array.from(lookupIds) },
      definition: { $in: shown.map(({ definition }) => definition.id) },
    });
    const valueByProductAndDefinition = new Map<string, ProductFieldValue>();
    for (const value of values) {
      const productId = (value.product as any)?.id ?? (value.product as any);
      const definitionId = (value.definition as any)?.id ?? (value.definition as any);
      valueByProductAndDefinition.set(`${productId}:${definitionId}`, value);
    }

    for (const product of products) {
      fieldsByProduct.set(
        product.id,
        shown.map(({ setting, definition }) => {
          const direct = valueByProductAndDefinition.get(`${product.id}:${definition.id}`) ?? null;
          const inheritedRow =
            !direct && product.parentId && definition.applicability !== 'CHILD'
              ? (valueByProductAndDefinition.get(`${product.parentId}:${definition.id}`) ?? null)
              : null;
          const row = direct ?? inheritedRow;
          let unit = definition.unit ?? null;
          let value = row ? readFieldValue(definition.type, row) : null;
          // Display-unit conversion: CURATED NUMBER only, exact rationals,
          // serialization-side — the stored canonical value never changes.
          if (
            value !== null &&
            typeof value === 'string' &&
            definition.type === ProductFieldType.NUMBER &&
            definition.source === 'CURATED' &&
            setting.displayUnit &&
            unit &&
            setting.displayUnit !== unit
          ) {
            const entry = curatedFieldByKey(definition.key);
            if (entry?.unitFamily) {
              value = convertUnitValue(value, unit, setting.displayUnit, entry.unitFamily);
              unit = setting.displayUnit;
            }
          }
          return {
            key: definition.key,
            label: setting.labelOverride ?? definition.label,
            group: setting.groupOverride ?? definition.fieldGroup ?? null,
            type: definition.type,
            unit,
            value,
            inherited: !!inheritedRow,
          };
        }),
      );
    }
    return fieldsByProduct;
  }

  /**
   * What a CHILD must satisfy before it can answer a filter for its family
   * card (Phase 6). The admin search accepts any unarchived child; the public
   * surface must not let a DRAFT or channel-hidden child drag its card into
   * results — that would let a visitor observe unpublished work by probing.
   */
  private visibleChildWhere(options?: { storeId?: string }): Record<string, any> {
    // Delegates to the shared rule. This method WAS the rule, and the DTO
    // projection carried a second, weaker copy that omitted the store; they
    // are one definition now so they cannot drift apart again.
    return visibleChildWhere({ storeId: options?.storeId });
  }

  /**
   * The public text-search clause: the proven admin shape (products.service
   * findAll) transplanted behind the visibility rules, minus the manufacturer
   * code (D1 keeps that on its own parameter). A card matches through its own
   * name/slug/SKU, a VISIBLE child's name/SKU — the family card stays the
   * result unit, the matching child rides inside `children` — or a category
   * whose name matches.
   */
  private async searchClause(
    search: string,
    options?: { organizationId?: string; storeId?: string },
  ): Promise<Record<string, any>> {
    // Subqueries stay inside the tenant (P0-05): matching another client's
    // category names would leak their vocabulary into results.
    const tenant = options?.organizationId ? { organization: options.organizationId } : {};
    const categories = await this.categoryRepository.find({
      name: { $ilike: `%${search}%` },
      archivedAt: null,
      ...tenant,
    });
    const visibleChild = this.visibleChildWhere(options);
    const orClauses: any[] = [
      { name: { $ilike: `%${search}%` } },
      { slug: { $ilike: `%${search}%` } },
      { sku: { $ilike: `%${search}%` } },
      { children: { $some: { name: { $ilike: `%${search}%` }, ...visibleChild } } },
      { children: { $some: { sku: { $ilike: `%${search}%` }, ...visibleChild } } },
    ];
    if (categories.length > 0) {
      orClauses.push({ categories: { $in: categories.map((category) => category.id) } });
    }
    return { $or: orClauses };
  }

  /**
   * `categorySlug` filters by the category OR ANY DESCENDANT: a filter for
   * "sillas" must find products filed under "sillas/oficina", or path
   * filtering is a lie the navigation tells. Descendants come from the same
   * bounded per-company ancestry index every other path feature uses; archived
   * branches do not extend the subtree. Returns null when the slug names no
   * live category of this company — the caller serves an empty page.
   */
  private async categorySubtreeClause(
    categorySlug: string,
    organizationId?: string,
  ): Promise<Record<string, any> | null> {
    const category = await this.categoryRepository.findOne({
      slug: categorySlug,
      archivedAt: null,
      ...(organizationId ? { organization: organizationId } : {}),
    });
    if (!category) return null;
    // No company in context means no ancestry (same rule as breadcrumbs):
    // the filter still works, it just cannot widen into a descendant walk.
    if (!organizationId) return { categories: category.id };
    const index = await this.categoryAncestryIndex(organizationId);
    const subtree = [category.id];
    for (const node of index.values()) {
      if (node.id === category.id || node.archivedAt) continue;
      if (resolveAncestors(index, node.id).some((ancestor) => ancestor.id === category.id)) {
        subtree.push(node.id);
      }
    }
    return { categories: { $in: subtree } };
  }

  /**
   * The `inStock` filter, entirely in SQL (Phase 6).
   *
   * A card's PURCHASABLE MEMBERS are its published, channel-visible children —
   * or the product itself when it has no children at all, the same line
   * `SalesService` draws when it refuses family parents. `inStock=true` keeps
   * cards with at least one member sellable now; `inStock=false` keeps cards
   * where no member is (which includes a family whose members are all hidden —
   * nothing purchasable IS out of stock).
   *
   * A member that does not track inventory is sellable without a stock row.
   * For tracked members, "sellable now" is the DTO's own availability rule
   * (P5-B7): the summed
   * AVAILABLE ledger at this channel's store location, falling back to the
   * owned figure only for a product with no such ledger rows (an organization
   * whose opening epoch has not run). `sum()` over zero rows is NULL, so ONE
   * `coalesce(sum, owned)` encodes both halves of that rule exactly — a row
   * summing to zero stays zero, absence falls back — and the filter and the
   * displayed number cannot disagree.
   *
   * The ledger probe pins the ORGANIZATION alongside the product: tenancy is
   * already guaranteed by the outer query, but the balances index leads with
   * organization_id, and without it every member probe walks the whole
   * table — measured at ~12 SECONDS for one listing at the 96k-product scale
   * (docs/evidence/183) before this predicate existed.
   */
  private availabilityClause(inStock: boolean, storeId?: string, organizationId?: string): Record<string, any> {
    const tenant = organizationId ? ` and b.organization_id = ?` : '';
    const availability = storeId
      ? `coalesce((select sum(b.quantity)
            from inventory_balances b
            join inventory_locations l on l.id = b.location_id
           where b.product_id = m.id${tenant} and b.operational_state = 'AVAILABLE'
             and l.kind = 'STORE' and l.store_id = ?), m.stock_quantity)`
      : `coalesce((select sum(b.quantity)
            from inventory_balances b
           where b.product_id = m.id${tenant} and b.operational_state = 'AVAILABLE'), m.stock_quantity)`;
    const childLink = storeId
      ? ` and exists (select 1 from store_products sp
                       where sp.product_id = m.id and sp.store_id = ? and sp.published = true)`
      : '';
    const params: string[] = [
      ...(storeId ? [storeId] : []), // member predicate's channel link
      ...(organizationId ? [organizationId] : []), // the ledger probe's tenant pin
      ...(storeId ? [storeId] : []), // the ledger probe's store location
    ];
    // #292: `m.removed_at is null` on the member, and on the childless probe,
    // so a card whose only remaining version has been removed stops advertising
    // itself as sellable. Written into the SQL because the ORM filter does not
    // reach a raw sub-select.
    const sellableMemberExists = (alias: string) => `exists (
      select 1 from products m
       where ((not exists (select 1 from products c where c.parent_id = ${alias}.id and c.removed_at is null)
               and m.id = ${alias}.id)
           or (m.parent_id = ${alias}.id and m.status = 'PUBLISHED' and m.archived_at is null${childLink}))
         and m.removed_at is null
         and (m.track_inventory = false or (${availability}) > 0))`;
    return inStock
      ? { [raw((alias) => sellableMemberExists(alias), params) as any]: true }
      : { [raw((alias) => `not ${sellableMemberExists(alias)}`, params) as any]: true };
  }

  /**
   * `spec.<key>` filters (Phase 6). FAIL CLOSED: a key is usable only when
   * THIS channel's StoreFieldSetting has it active, publicly visible AND
   * filterable, and its definition alive — anything else (a typo, an inactive
   * or non-filterable key, another tenant's vocabulary) gets the SAME
   * `unknown_specification` 400, so the error channel confirms nothing about
   * what exists elsewhere.
   *
   * Matching is the DTO's own EFFECTIVE resolution: a member answers with its
   * direct value, or — where applicability allows — its parent's. The card
   * matches through its own effective value or a visible child's. Values of
   * one key OR together (a repeated parameter is a set of acceptable answers);
   * different keys AND. NUMBER values compare as numerics with the canonical
   * decimal string passed verbatim to the database — no float ever touches
   * the comparison.
   */
  private async specificationClauses(
    specs: Record<string, string[]>,
    storeId?: string,
    organizationId?: string,
  ): Promise<Record<string, any>[]> {
    const refuse = (key: string): never => {
      throw new PublicQueryError(
        'unknown_specification',
        `spec.${key}`,
        `Unknown or non-filterable specification: ${key}`,
      );
    };
    const keys = Object.keys(specs);
    // Without a channel there is no filterable vocabulary at all.
    if (!storeId || !organizationId) return refuse(keys[0]);

    const em = this.storeRepository.getEntityManager();
    const settings = await em.find(
      StoreFieldSetting,
      { store: storeId, organization: organizationId, active: true, publiclyVisible: true, filterable: true },
      { populate: ['definition'] as never },
    );
    const definitionByKey = new Map(
      settings
        .map((setting) => setting.definition as unknown as ProductFieldDefinition)
        .filter((definition) => !definition.archivedAt)
        .map((definition) => [definition.key, definition]),
    );

    const clauses: Record<string, any>[] = [];
    for (const key of keys) {
      const definition = definitionByKey.get(key);
      if (!definition) return refuse(key);

      // One (comparison, params) per accepted value, validated per type.
      const comparisons = specs[key].map((value) => {
        switch (definition.type) {
          case ProductFieldType.NUMBER:
            if (!/^-?\d+(\.\d+)?$/.test(value)) {
              throw new PublicQueryError('malformed_value', `spec.${key}`, `spec.${key} takes a number`);
            }
            return { sql: 'pv.value_number = ?::numeric', param: value };
          case ProductFieldType.BOOLEAN:
            if (value !== 'true' && value !== 'false') {
              throw new PublicQueryError('malformed_value', `spec.${key}`, `spec.${key} takes "true" or "false"`);
            }
            return { sql: 'pv.value_boolean = ?', param: value === 'true' };
          case ProductFieldType.DATE:
            if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
              throw new PublicQueryError(
                'malformed_value',
                `spec.${key}`,
                `spec.${key} takes an ISO date (YYYY-MM-DD)`,
              );
            }
            return { sql: 'pv.value_date = ?::date', param: value };
          default: // TEXT, SELECT, URL — exact text
            return { sql: 'pv.value_text = ?', param: value };
        }
      });
      const anyValue = comparisons.map((comparison) => `(${comparison.sql})`).join(' or ');
      const valueParams = comparisons.map((comparison) => comparison.param);

      const direct = (subject: string) => `exists (
        select 1 from product_field_values pv
         where pv.product_id = ${subject} and pv.definition_id = ? and (${anyValue}))`;
      // A member with no direct answer displays its parent's value (Phase 2
      // effective resolution) — unless the definition applies to children
      // only, in which case nothing is inherited and nothing may match by it.
      const inherited =
        definition.applicability !== 'CHILD'
          ? ` or (m.parent_id is not null
              and not exists (select 1 from product_field_values pv
                               where pv.product_id = m.id and pv.definition_id = ?)
              and ${direct('m.parent_id')})`
          : '';
      // #292: the matched member must not be removed — otherwise a filter could
      // still surface a card on the strength of a version nobody can see.
      const memberMatch = (alias: string) => `exists (
        select 1 from products m
         where (m.id = ${alias}.id
             or (m.parent_id = ${alias}.id and m.status = 'PUBLISHED' and m.archived_at is null
                 and exists (select 1 from store_products sp
                              where sp.product_id = m.id and sp.store_id = ? and sp.published = true)))
           and m.removed_at is null
           and (${direct('m.id')}${inherited}))`;
      const params: unknown[] = [
        storeId, // the child's channel link
        definition.id,
        ...valueParams, // direct arm
        ...(inherited ? [definition.id, definition.id, ...valueParams] : []), // no-own-row probe + parent's row
      ];
      clauses.push({ [raw((alias) => memberMatch(alias), params) as any]: true });
    }
    return clauses;
  }

  /** The (id, parentId) pair effective-field resolution needs. */
  private fieldSubject(product: Product): { id: string; parentId: string | null } {
    const parent = product.parent as unknown as { id?: string } | string | null | undefined;
    return { id: product.id, parentId: (typeof parent === 'string' ? parent : parent?.id) ?? null };
  }

  async getProducts(options?: {
    organizationId?: string;
    page?: number;
    limit?: number;
    minPrice?: number;
    maxPrice?: number;
    hasSalePrice?: boolean;
    sortBy?: string;
    sortDirection?: 'asc' | 'desc';
    /** Free text over the card's name/slug/SKU, its VISIBLE children and its categories (Phase 6). */
    search?: string;
    /** Manufacturer reference, product or visible child — its own parameter, never part of `search` (D1). */
    mfgCode?: string;
    /** Products in this category or any descendant. Unknown slug = empty page, never 404. */
    categorySlug?: string;
    /** true = at least one purchasable member sellable now; false = none. */
    inStock?: boolean;
    /** spec key → accepted values (values OR, keys AND). Unknown keys are 400s, resolved in specificationClauses. */
    specs?: Record<string, string[]>;
    /** Scopes results to a store's channel (from the API key, ADR 007) */
    storeId?: string;
    /** Requested content language (P5-W2). Absent = the canonical copy. */
    locale?: string | null;
    channel?: string;
    group?: string;
  }): Promise<{ items: PublicProductDto[]; total: number; page: number; limit: number; totalPages: number }> {
    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.min(100, Math.max(1, options?.limit ?? 25));
    const offset = (page - 1) * limit;

    const andClauses: any[] = publicVisibilityClauses(options);
    // One card per family: children ride inside their parent's `children`.
    // Inserted at its historical position (immediately before the category
    // clause) so the emitted query is byte-identical to the pre-extraction one.
    const categoryClauseIndex = andClauses.findIndex((clause) => Array.isArray(clause.$or));
    andClauses.splice(categoryClauseIndex >= 0 ? categoryClauseIndex : andClauses.length, 0, { parent: null });

    if (options) {
      const { minPrice, maxPrice, hasSalePrice, search, mfgCode, categorySlug, inStock, specs, channel, group } = options;

      if (channel !== undefined) {
        if (!options.storeId || !options.organizationId) return { items: [], total: 0, page, limit, totalPages: 0 };
        const categoryIds = await this.channelCategoryIdsForProducts(options.organizationId, options.storeId, channel);
        if (!categoryIds) return { items: [], total: 0, page, limit, totalPages: 0 };
        andClauses.push({ categories: { id: { $in: categoryIds } } });
      }
      if (group !== undefined) {
        if (!options.storeId || !options.organizationId) return { items: [], total: 0, page, limit, totalPages: 0 };
        const groupCategoryIds = await this.groupCategoryIdsForProducts(options.organizationId, options.storeId, channel, group);
        if (!groupCategoryIds) return { items: [], total: 0, page, limit, totalPages: 0 };
        andClauses.push({ categories: { id: { $in: groupCategoryIds } } });
      }

      if (minPrice !== undefined) {
        andClauses.push({ price: { $gte: minPrice } });
      }
      if (maxPrice !== undefined) {
        andClauses.push({ price: { $lte: maxPrice } });
      }
      if (hasSalePrice !== undefined) {
        const visibleChild = this.visibleChildWhere(options);
        if (hasSalePrice) {
          andClauses.push({
            $or: [
              { salePrice: { $ne: null } },
              { children: { $some: { salePrice: { $ne: null }, ...visibleChild } } },
            ],
          });
        } else {
          andClauses.push({
            salePrice: null,
            children: { $none: { salePrice: { $ne: null }, ...visibleChild } },
          });
        }
      }

      // Phase 6 discovery filters. All families AND-compose; every clause is a
      // bounded relational predicate the DATABASE answers (the #177 rule —
      // nothing materializes rows into the process to compute a filter).
      if (search !== undefined) {
        andClauses.push(await this.searchClause(search, options));
      }
      if (mfgCode !== undefined) {
        // The supplier's reference answers ONLY this parameter (D1): it is
        // deliberately absent from `search` and from every public DTO, so a
        // catalogue never advertises its sourcing unless the caller already
        // holds the manufacturer's number.
        andClauses.push({
          $or: [
            { manufacturerCode: { $ilike: `%${mfgCode}%` } },
            {
              children: { $some: { manufacturerCode: { $ilike: `%${mfgCode}%` }, ...this.visibleChildWhere(options) } },
            },
          ],
        });
      }
      if (categorySlug !== undefined) {
        const clause = await this.categorySubtreeClause(categorySlug, options.organizationId);
        if (!clause) {
          // An unknown slug asks for a real page of an empty set — same
          // envelope, zero rows. A 404 here would turn a filter into a probe.
          return { items: [], total: 0, page, limit, totalPages: 0 };
        }
        andClauses.push(clause);
      }
      if (inStock !== undefined) {
        andClauses.push(this.availabilityClause(inStock, options.storeId, options.organizationId));
      }
      if (specs !== undefined) {
        andClauses.push(...(await this.specificationClauses(specs, options.storeId, options.organizationId)));
      }
    }

    const where = { $and: andClauses };

    const sortBy = options?.sortBy || 'createdAt';
    const sortDirection = options?.sortDirection || 'desc';

    const [products, total] = await this.productRepository.findAndCount(where, {
      populate: ['categories', 'images', 'branchLinks', 'children', 'children.images', 'children.branchLinks'],
      limit,
      offset,
      // id tie-break on every sort (Phase 6): a page boundary through equal
      // prices or names must never duplicate or drop a product between pages.
      orderBy: { [sortBy]: sortDirection, id: sortDirection } as never,
    });

    const fieldsByProduct = await this.publicFieldsByProduct(
      options?.storeId,
      products.map((product) => this.fieldSubject(product)),
    );
    const relatedByProduct = await this.publicRelationsByProduct(products, options);
    // Scope comes from the PRODUCTS, not from `options`: this listing accepts an
    // optional organization, and ancestry must not inherit that optionality.
    const ancestorsByCategory = await this.ancestorsForProducts(products, options);
    const availableByProduct = await this.availableByProduct(products, options?.storeId);
    const localization = await this.localizationFor({
      organizationId: options?.organizationId,
      locale: options?.locale,
      productIds: this.productIdsFor(products),
      categoryIds: this.categoryIdsFor(products, ancestorsByCategory),
    });
    return {
      items: products.map((product) =>
        mapProductToPublicDto(
          product,
          options?.storeId,
          fieldsByProduct.get(product.id) ?? [],
          relatedByProduct.get(product.id) ?? [],
          ancestorsByCategory,
          availableByProduct,
          localization.byProduct,
          localization.byCategory,
          localization.canonicalLocale,
        ),
      ),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getProductBySlug(
    slug: string,
    storeId?: string,
    organizationId?: string,
    /** Requested content language (P5-W2). Absent = the canonical copy. */
    locale?: string | null,
    /** The site channel that is allowed to expose this detail page. */
    channel?: string,
  ): Promise<PublicProductDto> {
    let channelCategoryIds: string[] | null = null;
    if (channel !== undefined) {
      if (!storeId || !organizationId) throw new NotFoundException(`Product with slug '${slug}' not found`);
      channelCategoryIds = await this.channelCategoryIdsForProducts(organizationId, storeId, channel);
      if (!channelCategoryIds) throw new NotFoundException(`Product with slug '${slug}' not found`);
    }
    const product = await this.productRepository.findOne(
      {
        slug,
        // An explicit clause ARRAY, not two spread objects: both the empty-card
        // suppression and the family condition use `$and`, and spreading the
        // second over the first would drop the first without a word.
        //
        // A CHILD is reachable by its own slug only while its family is. The
        // listing already hides a hidden family because it returns one row per
        // card; this lookup bypassed that by asking for the child directly.
        // Same builder as `priceCart`, so a page that cannot be seen cannot be
        // bought either.
        $and: [
          ...publicVisibilityClauses({ organizationId, storeId }),
          familyVisibleClause({ storeId }),
          ...(channelCategoryIds ? [{ categories: { id: { $in: channelCategoryIds } } }] : []),
        ],
      },
      {
        populate: ['categories', 'images', 'branchLinks', 'children', 'children.images', 'children.branchLinks'],
      },
    );

    if (!product) {
      throw new NotFoundException(`Product with slug '${slug}' not found`);
    }

    const fieldsByProduct = await this.publicFieldsByProduct(storeId, [this.fieldSubject(product)]);
    const relatedByProduct = await this.publicRelationsByProduct([product], { organizationId, storeId });
    const ancestorsByCategory = await this.ancestorsForProducts([product], { organizationId, storeId });
    const availableByProduct = await this.availableByProduct(
      [product, ...(product.children?.isInitialized() ? product.children.getItems() : [])],
      storeId,
    );
    const localization = await this.localizationFor({
      organizationId,
      locale,
      productIds: this.productIdsFor([product]),
      categoryIds: this.categoryIdsFor([product], ancestorsByCategory),
    });
    return mapProductToPublicDto(
      product,
      storeId,
      fieldsByProduct.get(product.id) ?? [],
      relatedByProduct.get(product.id) ?? [],
      ancestorsByCategory,
      availableByProduct,
      localization.byProduct,
      localization.byCategory,
      localization.canonicalLocale,
    );
  }

  async getProductsByCategorySlug(
    categorySlug: string,
    storeId?: string,
    organizationId?: string,
    /** Requested content language (P5-W2). Absent = the canonical copy. */
    locale?: string | null,
  ): Promise<PublicProductDto[]> {
    const category = await this.categoryRepository.findOne({
      slug: categorySlug,
      ...(organizationId ? { organization: organizationId } : {}),
      archivedAt: null,
    });

    if (!category) {
      throw new NotFoundException(`Category with slug '${categorySlug}' not found`);
    }

    // The company this listing is bound to. The caller's own value wins when it
    // gave one; otherwise the resolved category supplies it. Either way the
    // product query below carries an explicit organization predicate rather
    // than inheriting one from the API key by implication.
    const scopeOrganizationId =
      organizationId ?? (category as any).organization?.id ?? (category as any).organization ?? null;

    const products = await this.productRepository.find(
      {
        categories: category,
        status: ProductStatus.PUBLISHED,
        archivedAt: null,
        // The family's card carries its children; they never list separately
        parent: null,
        // ...so a card with nothing visible here must not list either.
        ...cardHasVisibleChildrenWhere({ storeId }),
        // Phase 4 closes the Phase 3 note that used to sit here. This path
        // relied on the resolved category to imply the company — transitive
        // protection through the API key, not a predicate of its own. It is
        // explicit now, and never absent: when the caller names no company the
        // CATEGORY's own supplies it, and `categories.organization_id` is NOT
        // NULL, so a product of another company can no longer appear even if a
        // category id were somehow shared.
        organization: scopeOrganizationId,
        ...(storeId ? { branchLinks: { store: storeId, published: true } } : {}),
      },
      {
        populate: ['categories', 'images', 'branchLinks', 'children', 'children.images', 'children.branchLinks'],
      },
    );

    const fieldsByProduct = await this.publicFieldsByProduct(
      storeId,
      products.map((product) => this.fieldSubject(product)),
    );
    const relatedByProduct = await this.publicRelationsByProduct(products, { organizationId, storeId });
    const ancestorsByCategory = await this.ancestorsForProducts(products, { organizationId, storeId });
    const availableByProduct = await this.availableByProduct(products, storeId);
    const localization = await this.localizationFor({
      // The company this listing resolved, never the caller's optional one:
      // the localization read must be scoped by the same predicate the product
      // query carries.
      organizationId: scopeOrganizationId ?? undefined,
      locale,
      productIds: this.productIdsFor(products),
      categoryIds: this.categoryIdsFor(products, ancestorsByCategory),
    });
    return products.map((product) =>
      mapProductToPublicDto(
        product,
        storeId,
        fieldsByProduct.get(product.id) ?? [],
        relatedByProduct.get(product.id) ?? [],
        ancestorsByCategory,
        availableByProduct,
        localization.byProduct,
        localization.byCategory,
        localization.canonicalLocale,
      ),
    );
  }

  /**
   * Public documents per product: its own first, then the parent product's
   * inheritable ones, minus anything the product suppresses or overrides.
   *
   * Resolved in ONE query for the whole page (products and their parents
   * together), never per row. Private links never enter the result set: the
   * `is_public` filter is part of the query, not a post-filter someone can
   * forget.
   */

  /**
   * The localization resolution for one request (P5-W2), in at most THREE
   * bounded queries — canonical locale once, product translations once,
   * category translations once — regardless of how many items load.
   *
   * IT DOES NOTHING AT ALL when no locale was requested, when the request is
   * malformed, when it names the canonical locale, or when no company is in
   * context. In every one of those cases the maps come back empty, the DTO
   * mappers use the base columns, and the response is byte-identical to what
   * this API returned before translations existed. That is the whole
   * compatibility guarantee, and it is enforced here rather than promised.
   *
   * The candidate set is the exact tag PLUS every tag of the same LANGUAGE, so
   * a `pt-BR` request can still be answered by a stored `pt` — matching the
   * resolver's documented step 2 — while a request for `de` never drags in
   * unrelated languages.
   */
  private async localizationFor(options: {
    organizationId?: string;
    locale?: string | null;
    productIds?: string[];
    categoryIds?: string[];
  }): Promise<{
    canonicalLocale: string;
    byProduct: Map<string, ResolvedLocalizedText>;
    byCategory: Map<string, ResolvedLocalizedText>;
  }> {
    const empty = {
      canonicalLocale: 'es',
      byProduct: new Map<string, ResolvedLocalizedText>(),
      byCategory: new Map<string, ResolvedLocalizedText>(),
    };
    const organizationId = options.organizationId ?? null;
    const requested = normalizeLocale(options.locale ?? null);
    // A malformed or absent tag is not an error: it is simply not a request
    // for another language, and the canonical copy is the right answer.
    if (!organizationId || requested === null) return empty;

    const em = this.storeRepository.getEntityManager();
    const organization = await em.findOne(Organization, { id: organizationId });
    const canonicalLocale = normalizeLocale(organization?.defaultContentLocale ?? 'es') ?? 'es';
    if (requested === canonicalLocale) return { ...empty, canonicalLocale };

    const language = localeLanguage(requested);
    const localeClause = {
      $or: [{ locale: requested }, { locale: language }, { locale: { $like: `${language}-%` } }],
    };

    const byProduct = new Map<string, ResolvedLocalizedText>();
    const productIds = [...new Set(options.productIds ?? [])];
    if (productIds.length > 0) {
      const rows = await em.find(ProductTranslation, {
        organization: organizationId,
        product: { $in: productIds },
        ...localeClause,
      } as never);
      const variantsByProduct = new Map<string, LocaleVariant[]>();
      for (const row of rows as unknown as (LocaleVariant & { product: unknown })[]) {
        const productId = (row.product as { id?: string })?.id ?? (row.product as unknown as string);
        const bucket = variantsByProduct.get(productId) ?? [];
        bucket.push(row);
        variantsByProduct.set(productId, bucket);
      }
      // Only products that actually have a candidate translation enter the
      // map; everything else falls through to the canonical columns in the
      // mapper, which is the same answer with one fewer object. ONE query for
      // their canonical text, never one per product.
      if (variantsByProduct.size > 0) {
        const canonicalRows = await this.productRepository.find(
          { id: { $in: [...variantsByProduct.keys()] }, organization: organizationId },
          { fields: ['id', 'name', 'description', 'metaTitle', 'metaDescription'] as never },
        );
        for (const product of canonicalRows) {
          const variants = variantsByProduct.get(product.id) ?? [];
          byProduct.set(product.id, resolveLocalizedText({ canonicalLocale, canonical: product, variants, requested }));
        }
      }
    }

    const byCategory = new Map<string, ResolvedLocalizedText>();
    const categoryIds = [...new Set(options.categoryIds ?? [])];
    if (categoryIds.length > 0) {
      const rows = await em.find(CategoryTranslation, {
        organization: organizationId,
        category: { $in: categoryIds },
        ...localeClause,
      } as never);
      const variantsByCategory = new Map<string, LocaleVariant[]>();
      for (const row of rows as unknown as (LocaleVariant & { category: unknown })[]) {
        const categoryId = (row.category as { id?: string })?.id ?? (row.category as unknown as string);
        const bucket = variantsByCategory.get(categoryId) ?? [];
        bucket.push(row);
        variantsByCategory.set(categoryId, bucket);
      }
      if (variantsByCategory.size > 0) {
        const canonicalRows = await this.categoryRepository.find(
          { id: { $in: [...variantsByCategory.keys()] }, organization: organizationId },
          { fields: ['id', 'name', 'description', 'metaTitle', 'metaDescription'] as never },
        );
        for (const category of canonicalRows) {
          const variants = variantsByCategory.get(category.id) ?? [];
          byCategory.set(
            category.id,
            resolveLocalizedText({ canonicalLocale, canonical: category, variants, requested }),
          );
        }
      }
    }

    return { canonicalLocale, byProduct, byCategory };
  }

  /** Every category id a page of products can reach: its own, and its path. */
  private categoryIdsFor(
    products: Product[],
    ancestorsByCategoryId: Map<string, PublicCategoryAncestorDto[]>,
  ): string[] {
    const ids = new Set<string>();
    for (const product of products) {
      if (!product.categories?.isInitialized()) continue;
      for (const category of product.categories.getItems()) {
        ids.add(category.id);
        const parent = (category as unknown as { parentCategory?: { id?: string } | string | null }).parentCategory;
        const parentId = typeof parent === 'string' ? parent : (parent?.id ?? null);
        if (parentId) ids.add(parentId);
        for (const ancestor of ancestorsByCategoryId.get(category.id) ?? []) ids.add(ancestor.id);
      }
    }
    return [...ids];
  }

  /** Every product id a page renders: the cards and their children. */
  private productIdsFor(products: Product[]): string[] {
    const ids = new Set<string>();
    for (const product of products) {
      ids.add(product.id);
      if (product.children?.isInitialized()) {
        for (const child of product.children.getItems()) ids.add(child.id);
      }
    }
    return [...ids];
  }

  /**
   * Sellable-now quantities for a page of products, in ONE query (P5-B7).
   *
   * "Available" is not "owned": it excludes units reserved for somebody,
   * committed to a transfer, travelling, or held damaged and not yet
   * reclassified. A website that offered those would be selling things it
   * cannot ship.
   *
   * A product with no ledger rows is absent from the map, and the caller falls
   * back to the owned figure — which is the right answer for an organization
   * whose opening epoch has not run.
   */
  private async availableByProduct(products: Product[], storeId?: string): Promise<Map<string, number>> {
    const ids = [...new Set(products.map((product) => product.id))];
    if (!ids.length) return new Map();
    const placeholders = ids.map(() => '?::uuid').join(', ');
    const rows: { product_id: string; available: number }[] = storeId
      ? await this.productRepository.getEntityManager().execute(
          `select b.product_id, sum(b.quantity)::int as available
             from inventory_balances b
             join inventory_locations l on l.id = b.location_id
            where b.product_id in (${placeholders}) and b.operational_state = 'AVAILABLE'
              and l.kind = 'STORE' and l.store_id = ?::uuid
            group by b.product_id`,
          [...ids, storeId],
        )
      : await this.productRepository.getEntityManager().execute(
          `select product_id, sum(quantity)::int as available
             from inventory_balances
            where product_id in (${placeholders}) and operational_state = 'AVAILABLE'
            group by product_id`,
          ids,
        );
    return new Map(rows.map((row) => [row.product_id, Number(row.available)]));
  }

        // The library's own recorded type — the trusted fact.
            // The child's own row for the same file wins, whether it
            // overrides the document or suppresses it outright.
  /**
   * Public suggestions per product.
   *
   * The targets are re-resolved through `publicVisibilityClauses` — the SAME
   * predicate the catalogue applies to any product — so an unpublished,
   * archived or other-branch item simply does not appear. It is never returned
   * as a stub, because a stub is a link a visitor can follow into a 404.
   */
  private async publicRelationsByProduct(
    products: Product[],
    options?: { organizationId?: string; storeId?: string },
  ): Promise<Map<string, PublicRelatedProductDto[]>> {
    const byProduct = new Map<string, PublicRelatedProductDto[]>();
    if (products.length === 0) return byProduct;

    const relations = await this.productRelationRepository.find(
      { sourceProduct: { $in: products.map((product) => product.id) } },
      { orderBy: { sortOrder: 'ASC', createdAt: 'ASC', id: 'ASC' } },
    );
    if (relations.length === 0) {
      for (const product of products) byProduct.set(product.id, []);
      return byProduct;
    }

    const targetIds = [
      ...new Set(relations.map((relation) => (relation.targetProduct as any)?.id ?? (relation.targetProduct as any))),
    ];
    const visibleTargets = await this.productRepository.find(
      { id: { $in: targetIds }, $and: publicVisibilityClauses(options) },
      { populate: ['images'] as never },
    );
    const visibleById = new Map(visibleTargets.map((target) => [target.id, target]));

    for (const product of products) byProduct.set(product.id, []);
    for (const relation of relations) {
      const sourceId = (relation.sourceProduct as any)?.id ?? (relation.sourceProduct as any);
      const targetId = (relation.targetProduct as any)?.id ?? (relation.targetProduct as any);
      const target = visibleById.get(targetId);
      if (!target) continue;
      const activeImages = target.images ? target.images.getItems().filter((img) => img.archivedAt === null) : [];
      const primary = activeImages.find((img) => img.isPrimary) || null;
      byProduct.get(sourceId)!.push({
        id: target.id,
        name: target.name,
        slug: target.slug,
        type: String(relation.type),
        primaryImage: primary
          ? {
              url: primary.url,
              altText: primary.altText || undefined,
              isPrimary: primary.isPrimary,
              displayMode: primary.displayMode || 'CONTAIN',
              sortOrder: primary.sortOrder,
            }
          : null,
      });
    }
    return byProduct;
  }

  /** Minimal store identity associated with the API key. */
  async getSite(storeId?: string) {
    if (!storeId) {
      throw new BadRequestException('Site info is store-scoped: call this endpoint with a store API key');
    }
    const store = await this.storeRepository.findOne({ id: storeId });
    if (!store) {
      return {};
    }
    return {
      name: store.name,
      contact: {
        email: store.contactEmail ?? null,
        phone: store.contactPhone ?? null,
        address: store.contactAddress ?? null,
      },
    };
  }
}
