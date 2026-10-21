import { Category } from '../../categories/entities/category.entity';
import { Product } from '../../products/entities/product.entity';
import { ProductSaleMode } from '../../products/catalogue/product-sale-mode.enum';
import { isChildVisible } from '../query/child-visibility';
import { ResolvedLocalizedText } from '../../localization/shared/locale.util';

/** One step of a category's path, root-first. */
export interface PublicCategoryAncestorDto {
  id: string;
  name: string;
  slug: string;
  publicLabel: string | null;
}

/**
 * The single-level parent the catalogue has always embedded.
 *
 * Given its own type deliberately: it must keep emitting exactly these six
 * keys. Typing it as a full `PublicCategoryDto` would drag the Phase 4 fields
 * into a nested object that never carried them, changing a published shape as
 * a side effect of adding to the outer one.
 */
export interface PublicCategorySummaryDto {
  id: string;
  name: string;
  slug: string;
  description?: string;
  metaTitle?: string;
  metaDescription?: string;
}

export interface PublicCategoryDto {
  id: string;
  name: string;
  slug: string;
  description?: string;
  metaTitle?: string;
  metaDescription?: string;
  parentCategory?: PublicCategorySummaryDto | null;

  // ---------- Phase 4, all additive ----------
  /**
   * The full chain from the root down to the immediate parent, self excluded.
   * `parentCategory` above still carries only one level and keeps its exact
   * shape; this is where arbitrary depth lives.
   *
   * Truncated at the first archived ancestor, because an archived category is
   * not publicly visible and a path through one would imply a route the caller
   * cannot take.
   */
  ancestors: PublicCategoryAncestorDto[];
  /** Storefront heading override. Null means "use `name`" — never invented. */
  publicLabel: string | null;
  /** Resolved only from a same-company, same-branch, IMAGE asset. */
  imageUrl: string | null;
  /** Position among siblings; ties fall to (name, id). */
  sortOrder: number;
  /** Presentational only — hides nothing, secures nothing. */
  showInNavigation: boolean;
  /** PRODUCT_TYPE | BRAND | DESIGNER | COLLECTION | MERCHANDISING, or null. */
  kind: string | null;

  // ---------- P5-W2, additive ----------
  /**
   * The language `name`, `description`, `metaTitle` and `metaDescription`
   * above are actually IN.
   *
   * It reports what was SERVED, not what was asked for: a request for `de`
   * that fell back to the canonical copy says `es`, so a consumer never caches
   * Spanish under a German key. Without a requested locale it is the
   * organization's canonical content locale and every text field is exactly
   * what this API has always returned.
   */
  locale: string;
  /** Store/channel publication metadata. Null/empty on legacy unconfigured reads. */
  channelKey?: string | null;
  placements?: string[];
  groupKeys?: string[];
  productCount?: number;
}

export interface PublicImageDto {
  url: string;
  altText?: string;
  isPrimary: boolean;
  displayMode: string;
  sortOrder: number;
}

/**
 * One field the key's branch shows for this product (B4a3).
 *
 * Only that branch's ACTIVE, PUBLICLY VISIBLE settings on live definitions
 * appear — nothing internal (required-state, ids, sibling branches' choices)
 * ever does. `value` is type-correct: TEXT a string, BOOLEAN a boolean, and
 * NUMBER a canonical decimal STRING — numeric(18,6) outruns a double. Null
 * means this product has not answered; absence is a fact, never inherited
 * from a family card or one of its children.
 */
export interface PublicFieldDto {
  key: string;
  label: string;
  /** Presentation group (store override, else the definition's), if any. */
  group: string | null;
  type: string;
  unit: string | null;
  value: string | boolean | null;
  /**
   * True when the value came from the parent product rather than the product
   * itself (Phase 2). Additive: consumers that ignore it see the effective
   * value exactly as before.
   */
  inherited: boolean;
}

/**
 * A document a product publishes: technical sheet, manual, care guide,
 * certificate, warranty (Phase 3).
 *
 * `contentKind` comes from the library file's own recorded type, never from
 * guessing at the URL, so a site can choose between a thumbnail and a download
 * link without parsing anything.
 *
 * Only documents explicitly marked public appear here. That flag governs API
 * EXPOSURE; it is not storage confidentiality — see ADR 011.
 */
export interface PublicDocumentDto {
  kind: string;
  label: string | null;
  url: string;
  /** IMAGE | VIDEO | FILE, as recorded on the library asset. */
  contentKind: string;
  /** True when the parent product supplies it rather than this product. */
  inherited: boolean;
}

/**
 * Another product this one points at (Phase 3). Only targets that are
 * themselves publicly visible in the SAME context appear — the identical
 * publication predicate the catalogue applies to any product.
 */
export interface PublicRelatedProductDto {
  id: string;
  name: string;
  slug: string;
  type: string;
  primaryImage: PublicImageDto | null;
}

/**
 * One buyable CHILD of a parent card.
 *
 * Every field is read from an ordinary child product; there is no separate
 * option or variant entity behind this representation.
 */
export interface PublicChildDto {
  id: string;
  name: string;
  slug?: string;
  sku?: string;
  attributes: Record<string, any>;
  price: number;
  salePrice?: number | null;
  saleMode: ProductSaleMode;
  purchasable: boolean;
  trackInventory: boolean;
  stockQuantity: number;
  /**
   * What can actually be sold right now (P5-B7).
   *
   * `stockQuantity` is what the organization OWNS; this is what is free to
   * sell. They differ whenever units are reserved for somebody, committed to a
   * transfer, travelling between locations, or held as damaged and not yet
   * reclassified — all of which are owned and none of which a website should
   * offer.
   *
   * Additive and never null: before an organization's ledger epoch it equals
   * `stockQuantity`, so an existing consumer sees exactly what it saw before.
   */
  availableQuantity: number;
  /** The option this child offers, e.g. "Green". Canonical field. */
  optionLabel?: string | null;
  primaryImage?: PublicImageDto | null;
  /** Days THIS branch needs to deliver this child. Null = not stated. */
  leadTimeDays: number | null;
  /** The language this child's `name` is in (P5-W2). Additive. */
  locale: string;
}

export interface PublicProductDto {
  id: string;
  name: string;
  slug: string;
  description?: string;
  metaTitle?: string;
  metaDescription?: string;
  price: number;
  salePrice?: number | null;
  saleMode: ProductSaleMode;
  trackInventory: boolean;
  stockQuantity: number;
  /** Sellable now, as opposed to owned. */
  availableQuantity: number;
  category: PublicCategoryDto | null;
  categories: PublicCategoryDto[];
  /** The option this product offers when it is a child. Canonical field. */
  optionLabel: string | null;
  /** Set when this item is a child of a parent product (its family's card). */
  parentId: string | null;
  /**
   * Whether this id may be posted to checkout. False for a family card: it is
   * a container, and the buyable ids are in `children`. Standalone items and
   * children are true. Checkout enforces this server-side regardless.
   */
  purchasable: boolean;
  /**
   * Days this branch needs to deliver. Null when not stated — and ALWAYS null
   * for a family card: the card is not fulfilled, its children are, and each
   * one carries its own value in `children`. A card-level number would claim
   * one delivery time for children that may differ.
   */
  leadTimeDays: number | null;
  /**
   * UNCHANGED by Phase 3. Still the image flagged primary among the active
   * ones, still null when none carries the flag, still falling back to the
   * first child's primary for a family card. `images[0]` is deliberately NOT
   * promoted here: silently inventing a primary where the catalogue previously
   * reported none would change what published sites render.
   */
  primaryImage: PublicImageDto | null;
  /**
   * Every active image, ordered primary-first then by the branch's own order
   * (Phase 3). Additive: `primaryImage` keeps its own independent meaning, and
   * the two may legitimately disagree when no image carries the flag.
   */
  images: PublicImageDto[];
  /** Public documents, this product's own first, then the parent product's. */
  /** Ordered suggestions, filtered to targets visible in this same context. */
  relatedProducts: PublicRelatedProductDto[];
  /**
   * The buyable children of this card. A parent's children arrive here, so a
   * site renders ONE card per family with a selector — no client grouping.
   */
  children: PublicChildDto[];
  /**
   * The branch's public fields for THIS product, in the branch's own order.
   * ALWAYS an array: empty without a resolved store context, and empty when
   * the branch shows no fields. Values are the product's own — a card and its
   * children each answer for themselves, exactly like lead time.
   */
  fields: PublicFieldDto[];

  // ---------- P5-W2, additive ----------
  /**
   * The language this product's `name`/`description`/`metaTitle`/
   * `metaDescription` are in. See `PublicCategoryDto.locale`: it reports what
   * was served, never what was requested, and a missing or partial translation
   * NEVER suppresses the product — the untranslated fields simply arrive in
   * the canonical language beside the translated ones.
   */
  locale: string;
}

/**
 * The picture a category may publish.
 *
 * Attachment alone is NEVER enough. `StoreAsset.url` always points at the
 * public CDN — there is no private storage tier — so the gate has to be here:
 * the asset must load, belong to the same company, sit in a compatible branch
 * (its own, or company-wide), and actually be an IMAGE. A reference that fails
 * any of those degrades to null rather than leaking a file the category has no
 * business showing. The database enforces the same rules independently.
 */
/**
 * The canonical copy of an item, as the localization resolver's shape (P5-W2).
 *
 * Used when no locale was requested — which is every existing consumer — so
 * the mapped DTO is byte-identical to what it was before translations existed.
 */
function canonicalText(
  canonicalLocale: string,
  item: { name: string; description?: string | null; metaTitle?: string | null; metaDescription?: string | null },
): ResolvedLocalizedText {
  return {
    locale: canonicalLocale,
    name: item.name,
    description: item.description ?? null,
    metaTitle: item.metaTitle ?? null,
    metaDescription: item.metaDescription ?? null,
  };
}

export function mapCategoryToPublicDto(
  category: Category,
  ancestors: PublicCategoryAncestorDto[] = [],
  /**
   * Resolved copy per category id (P5-W2), covering this category, its parent
   * and its ancestors — so a breadcrumb never arrives half translated. An
   * EMPTY map means "no locale was requested" and the canonical columns
   * answer, which is the exact previous behaviour and what keeps this
   * additive.
   */
  localizedByCategoryId: Map<string, ResolvedLocalizedText> = new Map(),
  /** The organization's canonical content locale; `es` when unknown. */
  canonicalLocale = 'es',
): PublicCategoryDto {
  const text = localizedByCategoryId.get(category.id) ?? canonicalText(canonicalLocale, category);
  return {
    id: category.id,
    name: text.name,
    slug: category.slug,
    description: text.description || undefined,
    metaTitle: text.metaTitle || undefined,
    metaDescription: text.metaDescription || undefined,
    parentCategory:
      category.parentCategory && category.parentCategory.archivedAt === null
        ? ((): PublicCategorySummaryDto => {
            // Still EXACTLY six keys — only the text they carry is resolved.
            const parent =
              localizedByCategoryId.get(category.parentCategory.id) ??
              canonicalText(canonicalLocale, category.parentCategory);
            return {
              id: category.parentCategory.id,
              name: parent.name,
              slug: category.parentCategory.slug,
              description: parent.description || undefined,
              metaTitle: parent.metaTitle || undefined,
              metaDescription: parent.metaDescription || undefined,
            };
          })()
        : null,
    ancestors: ancestors.map((ancestor) => {
      const resolved = localizedByCategoryId.get(ancestor.id);
      return resolved ? { ...ancestor, name: resolved.name } : ancestor;
    }),
    publicLabel: category.publicLabel ?? null,
    imageUrl: category.imageUrl ?? null,
    sortOrder: category.sortOrder ?? 0,
    showInNavigation: category.showInNavigation ?? true,
    kind: category.kind ?? null,
    locale: text.locale,
  };
}

/** A family child as its card's selector entry, with the branch's own price. */
function mapChildToPublicChildDto(
  child: Product,
  storeId?: string,
  /** Sellable-now per product; absent falls back to the owned figure. */
  availableByProductId: Map<string, number> = new Map(),
  /** Resolved copy per product id (P5-W2); empty means canonical. */
  localizedByProductId: Map<string, ResolvedLocalizedText> = new Map(),
  canonicalLocale = 'es',
): PublicChildDto {
  let price = Number(child.price);
  let salePrice = child.salePrice !== undefined && child.salePrice !== null ? Number(child.salePrice) : null;
  let stockQuantity = child.stockQuantity;
  let trackInventory = child.trackInventory;
  // Lead time is the branch's own statement about THIS child. It never
  // falls back to the product and never comes from the family card.
  let leadTimeDays: number | null = null;
  if (storeId && child.branchLinks && child.branchLinks.isInitialized()) {
    const link = child.branchLinks
      .getItems()
      .find((entry) => (typeof entry.store === 'string' ? entry.store : entry.store.id) === storeId);
    if (link) {
      if (link.price !== undefined && link.price !== null) {
        price = Number(link.price);
        salePrice = link.salePrice !== undefined && link.salePrice !== null ? Number(link.salePrice) : null;
      }
      stockQuantity = link.stockQuantity;
      trackInventory = link.trackInventory;
      leadTimeDays = link.leadTimeDays ?? null;
    }
  }
  const images = child.images && child.images.isInitialized() ? child.images.getItems() : [];
  const primary = images.find((img) => img.isPrimary && img.archivedAt === null) || null;
  const text = localizedByProductId.get(child.id) ?? canonicalText(canonicalLocale, child);
  return {
    id: child.id,
    name: text.name,
    locale: text.locale,
    slug: child.slug,
    sku: child.sku || undefined,
    attributes: child.optionLabel ? { optionLabel: child.optionLabel } : {},
    price,
    salePrice,
    saleMode: child.saleMode ?? ProductSaleMode.DIRECT,
    purchasable: (child.saleMode ?? ProductSaleMode.DIRECT) === ProductSaleMode.DIRECT,
    trackInventory,
    stockQuantity,
    availableQuantity: availableByProductId.get(child.id) ?? stockQuantity,
    optionLabel: child.optionLabel ?? null,
    // Deprecated alias — same value, same source, never a second field.
    leadTimeDays,
    primaryImage: primary
      ? {
          url: primary.url,
          altText: primary.altText || undefined,
          isPrimary: primary.isPrimary,
          displayMode: primary.displayMode || 'CONTAIN',
          sortOrder: primary.sortOrder,
        }
      : null,
  };
}

/** One image row as the public contract renders it. */
function mapImageToPublicDto(image: {
  url: string;
  altText?: string;
  isPrimary: boolean;
  displayMode?: string;
  sortOrder: number;
}): PublicImageDto {
  return {
    url: image.url,
    altText: image.altText || undefined,
    isPrimary: image.isPrimary,
    displayMode: image.displayMode || 'CONTAIN',
    sortOrder: image.sortOrder,
  };
}

export function mapProductToPublicDto(
  product: Product,
  storeId?: string,
  fields: PublicFieldDto[] = [],
  relatedProducts: PublicRelatedProductDto[] = [],
  /**
   * Ancestry for the product's categories, resolved once per request by the
   * caller (Phase 4). Absent means "no path" rather than "walk the relations":
   * a lazy walk here would be one query per level per category per product.
   */
  ancestorsByCategoryId: Map<string, PublicCategoryAncestorDto[]> = new Map(),
  /**
   * Sellable quantity per product, resolved once per request by the caller.
   * Absent means "no ledger answer", and the owned figure stands in — which is
   * exactly right for an organization that has not cut over yet.
   */
  availableByProductId: Map<string, number> = new Map(),
  /**
   * Resolved copy per product id (P5-W2), covering this product and its
   * children. An EMPTY map means no locale was requested and the canonical
   * columns answer — byte-identical to the pre-localization contract.
   */
  localizedByProductId: Map<string, ResolvedLocalizedText> = new Map(),
  /** Resolved copy per category id, for the categories this product carries. */
  localizedByCategoryId: Map<string, ResolvedLocalizedText> = new Map(),
  /** The organization's canonical content locale; `es` when unknown. */
  canonicalLocale = 'es',
): PublicProductDto {
  const liveCategories = product.categories.isInitialized()
    ? product.categories.getItems().filter((c) => c.archivedAt === null || c.archivedAt === undefined)
    : [];
  // Branch view (P0-06): the store's own link carries its price and stock.
  // Base values apply when the branch has no override.
  let price = Number(product.price);
  let salePrice = product.salePrice !== undefined && product.salePrice !== null ? Number(product.salePrice) : null;
  let stockQuantity = product.stockQuantity;
  let trackInventory = product.trackInventory;
  let leadTimeDays: number | null = null;
  if (storeId && product.branchLinks && product.branchLinks.isInitialized()) {
    const link = product.branchLinks
      .getItems()
      .find((entry) => (typeof entry.store === 'string' ? entry.store : entry.store.id) === storeId);
    if (link) {
      if (link.price !== undefined && link.price !== null) {
        price = Number(link.price);
        salePrice = link.salePrice !== undefined && link.salePrice !== null ? Number(link.salePrice) : null;
      }
      // Stock is never shared between branches
      stockQuantity = link.stockQuantity;
      trackInventory = link.trackInventory;
      leadTimeDays = link.leadTimeDays ?? null;
    }
  }
  // A card is a container: it is never fulfilled, so it states no lead time
  // even if its visibility pivot happens to carry one. Each child answers
  // for itself in `children`.
  const isCard = !!(product.children && product.children.isInitialized() && product.children.count() > 0);
  if (isCard) leadTimeDays = null;

  const activeImages = product.images ? product.images.getItems().filter((img) => img.archivedAt === null) : [];

  const primaryImageEntity = activeImages.find((img) => img.isPrimary) || null;

  const primaryImage = primaryImageEntity ? mapImageToPublicDto(primaryImageEntity) : null;

  // The whole gallery (Phase 3), deterministic across loads: the flagged
  // image first, then the branch's own order, ties broken by creation and id
  // so two images sharing a position never swap between requests.
  const images = [...activeImages]
    .sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      const at = a.createdAt ? a.createdAt.getTime() : 0;
      const bt = b.createdAt ? b.createdAt.getTime() : 0;
      if (at !== bt) return at - bt;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map(mapImageToPublicDto);

  // Children render in a deterministic order: insertion order, tie-broken by
  // id. The collections arrive DB-arbitrary, so without this sort a selector
  // could reorder between loads — and the legacy conversion (B4b) copied
  // each variant's createdAt onto its child precisely so the converted
  // family keeps the order buyers already saw.
  const byCreationThenId = (a: { createdAt?: Date; id: string }, b: { createdAt?: Date; id: string }): number => {
    const at = a.createdAt ? a.createdAt.getTime() : 0;
    const bt = b.createdAt ? b.createdAt.getTime() : 0;
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };

  // A parent's children ride in `children`, so the public integration contract
  // (one card + selector) needs no client-side grouping.
  const familyVersions =
    product.children && product.children.isInitialized()
      ? product.children
          .getItems()
          // ONE visibility rule, shared with the query fragment the search
          // clause uses. Filtering only on status/archival here — as this did —
          // disclosed a child belonging solely to ANOTHER store, and rendered it
          // as a selectable option a shopper could not buy.
          .filter((child) => isChildVisible(child, { storeId }))
          .sort(byCreationThenId)
          .map((child) =>
            mapChildToPublicChildDto(child, storeId, availableByProductId, localizedByProductId, canonicalLocale),
          )
      : [];

  const text = localizedByProductId.get(product.id) ?? canonicalText(canonicalLocale, product);
  return {
    id: product.id,
    name: text.name,
    slug: product.slug,
    description: text.description || undefined,
    metaTitle: text.metaTitle || undefined,
    metaDescription: text.metaDescription || undefined,
    locale: text.locale,
    price,
    salePrice,
    saleMode: product.saleMode ?? ProductSaleMode.DIRECT,
    trackInventory,
    stockQuantity,
    availableQuantity: availableByProductId.get(product.id) ?? stockQuantity,
    // `category` stays the first live folder so already-published sites and
    // the embed widget keep working; `categories` carries the full set.
    category:
      liveCategories.length > 0
        ? mapCategoryToPublicDto(
            liveCategories[0],
            ancestorsByCategoryId.get(liveCategories[0].id) ?? [],
            localizedByCategoryId,
            canonicalLocale,
          )
        : null,
    categories: liveCategories.map((c) =>
      mapCategoryToPublicDto(c, ancestorsByCategoryId.get(c.id) ?? [], localizedByCategoryId, canonicalLocale),
    ),
    optionLabel: product.optionLabel ?? null,
    // Deprecated alias — same value, same source, never a second field.
    parentId: (product.parent as any)?.id ?? (product.parent as any) ?? null,
    // A card is not an item: having children is exactly what makes it one.
    purchasable: !isCard && (product.saleMode ?? ProductSaleMode.DIRECT) === ProductSaleMode.DIRECT,
    leadTimeDays,
    // A freshly minted card may have no photo of its own; its first child's applies
    primaryImage: primaryImage ?? familyVersions.find((v) => v.primaryImage)?.primaryImage ?? null,
    // Deliberately NOT given the card←child fallback: `images` is this
    // product's own gallery, and borrowing a child's photos into it would
    // make a card claim pictures it does not have.
    images,
    relatedProducts,
    children: familyVersions,
    // Deprecated alias — the SAME array instance, so the two cannot diverge.
    fields,
  };
}
