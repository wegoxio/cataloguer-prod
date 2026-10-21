/**
 * The one Category shape, matching what the backend returns. Components that
 * only need part of it still take this type — the fields are optional, and
 * three drifted local copies is how the interfaces diverged in the first place.
 *
 * Categories are navigation only: "these rows are one product" lives on the
 * product family (Product.parent), never here.
 */
/** What sort of grouping a category is (Phase 4). Navigation only. */
export type CategoryKind = 'PRODUCT_TYPE' | 'BRAND' | 'DESIGNER' | 'COLLECTION' | 'MERCHANDISING';

export interface Category {
  id: string;
  name: string;
  slug: string;
  description?: string;
  metaTitle?: string | null;
  metaDescription?: string | null;
  archivedAt?: string | null;
  parentCategory?: {
    id: string;
    name: string;
    archivedAt?: string | null;
  } | null;

  // ---------- Phase 4 presentation metadata ----------
  kind?: CategoryKind | null;
  /** Storefront heading. Null means "use `name`" — never a fabricated fallback. */
  publicLabel?: string | null;
  /** Position among siblings; ties fall to (name, id). */
  sortOrder?: number;
  /** Whether a storefront offers this in navigation. Hides nothing else. */
  showInNavigation?: boolean;
  /** A file from the company's library, linked — never uploaded twice. */
}

/**
 * Order among SIBLINGS — categories sharing a parent, or all roots together.
 *
 * The backend implements the identical rule in `category-ancestry.ts`. The two
 * are NOT one module: backend and frontend share no runtime package, and
 * introducing one for a three-line comparator would be scope this phase does
 * not need. The backend copy is pinned by unit tests; this project has no
 * frontend unit-test framework (only Playwright end-to-end), so this copy is
 * held by typecheck, build and the duplicated documentation — not by a test.
 * Changing one means changing both.
 */
export function compareCategorySiblings(a: Category, b: Category): number {
  const aOrder = a.sortOrder ?? 0;
  const bOrder = b.sortOrder ?? 0;
  if (aOrder !== bOrder) return aOrder - bOrder;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The slim shape other features (products, filters) carry around when they
 * only tag or list categories. Pick keeps it in sync with Category by
 * construction.
 */
export type CategoryRef = Pick<Category, 'id' | 'name' | 'archivedAt'>;
