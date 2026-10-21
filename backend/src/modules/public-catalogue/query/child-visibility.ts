import { Product } from '../../products/entities/product.entity';
import { ProductStatus } from '../../products/catalogue/product-status.enum';

/**
 * When a family child may appear on a store's public surface.
 *
 * ONE rule, expressed twice — as a query fragment for the database and as a
 * predicate for rows already in memory — because both are needed and they must
 * never disagree. `child-visibility.spec.ts` pins that they agree.
 *
 * Before this module the two halves DID disagree: the search clause required a
 * published link to the requested store, while the projection filtered only on
 * status and archival. A child belonging solely to another store was therefore
 * disclosed in this store's card and rendered as a selectable option. Checkout
 * refused it (`sales.service.priceCart`), so it was never orderable — but its
 * name, SKU, price and stock were visible to the wrong store's visitors, and a
 * shopper could pick something they could not buy.
 *
 * A store-scoped request MUST pass its store. Omitting it is not a way to skip
 * the filter: the only callers that legitimately have no store are enumerated
 * in the spec, and they are not store-scoped surfaces.
 */
export interface ChildVisibilityContext {
  /** The store whose catalogue is being served, when the surface is scoped. */
  storeId?: string;
}

/** The database fragment: what a child row must satisfy to be visible. */
export function visibleChildWhere(context?: ChildVisibilityContext): Record<string, unknown> {
  return {
    archivedAt: null,
    status: ProductStatus.PUBLISHED,
    ...(context?.storeId ? { branchLinks: { store: context.storeId, published: true } } : {}),
  };
}

/**
 * The in-memory predicate, for children already loaded with their links.
 *
 * Requires `branchLinks` to be populated when a store is given. Every public
 * query path populates `children.branchLinks`, so this costs no extra query —
 * and an unpopulated collection is treated as NOT visible rather than as
 * visible, so a future query that forgets to populate fails closed.
 */
export function isChildVisible(child: Product, context?: ChildVisibilityContext): boolean {
  if (child.status !== ProductStatus.PUBLISHED) return false;
  if (child.archivedAt) return false;
  if (!context?.storeId) return true;
  if (!child.branchLinks || !child.branchLinks.isInitialized()) return false;
  return child.branchLinks
    .getItems()
    .some(
      (link) => link.published && (typeof link.store === 'string' ? link.store : link.store?.id) === context.storeId,
    );
}

/**
 * A card that shows nothing must not be returned at all.
 *
 * Expressed for the database so paging and totals stay correct: filtering the
 * page after the query would leave `total` counting cards the caller never
 * receives, and short pages.
 *
 * The clause is wrapped in `$and` rather than exposing a bare `$or` key.
 * `publicVisibilityWhere` flattens the clause list with `Object.assign`, so a
 * second top-level `$or` would SILENTLY REPLACE the category clause already
 * using that key and drop a tenancy-adjacent filter. `$and` collides with
 * nothing, and the emitted SQL is the same conjunction.
 */
export function cardHasVisibleChildrenWhere(context?: ChildVisibilityContext): Record<string, unknown> {
  return {
    $and: [
      {
        $or: [
          // A standalone product has no children and is unaffected.
          { children: { $none: {} } },
          // A card must have at least one child visible HERE.
          { children: { $some: visibleChildWhere(context) } },
        ],
      },
    ],
  };
}

/**
 * A product is publicly reachable only if its FAMILY is.
 *
 * The card was already judged on itself everywhere; a CHILD was not. The
 * listing hides the family, because it returns one row per card
 * (`{ parent: null }`) and a hidden card is not returned — but
 * `getProductBySlug` looked the child up on its own slug and never consulted
 * the parent, and `priceCart` hand-built the same child clause and likewise
 * never consulted it. A Draft, archived or store-hidden card therefore hid its
 * own page while its children stayed both reachable by direct URL and
 * BUYABLE.
 *
 * Both callers use this builder, so browsing and checkout cannot drift into
 * disagreeing about what a shop sells.
 *
 * The parent condition is `visibleChildWhere` itself, which is exactly the
 * three ways a family is hidden: `status` (Draft), `archivedAt` (archived),
 * and the store link (invisible in the store being asked).
 *
 * Tenancy needs no clause of its own: `products_parent_tenant_foreign` is a
 * composite key on `(parent_id, organization_id)`, so a child and its parent
 * are always the same company's.
 *
 * Returned as a bare `$or` CLAUSE, to be placed inside an `$and` array —
 * never spread into an object beside another clause. `cardHasVisibleChildrenWhere`
 * already wraps itself in `$and` for that reason, and spreading a second
 * `$and`-wrapped builder next to it would not merge the two: the later key
 * would silently REPLACE the earlier, dropping the empty-card suppression
 * entirely. Both callers compose an explicit array, so no key can collide.
 */
export function familyVisibleClause(context?: ChildVisibilityContext): Record<string, unknown> {
  return {
    $or: [
      // A card or a standalone answers for itself.
      { parent: null },
      // A child answers for its parent too.
      { parent: visibleChildWhere(context) },
    ],
  };
}

/**
 * The in-memory twin, for rows already loaded with their parent.
 *
 * An unloaded parent reference is treated as NOT visible, so a caller that
 * forgets to populate fails closed rather than selling something hidden.
 */
export function isFamilyVisible(product: Product, context?: ChildVisibilityContext): boolean {
  const parent = product.parent as unknown as Product | string | null | undefined;
  if (!parent) return true;
  if (typeof parent === 'string') return false;
  return isChildVisible(parent, context);
}
