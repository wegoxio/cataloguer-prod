import { Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Store } from '../../stores/entities/store.entity';

/**
 * What sort of grouping a category is (Phase 4).
 *
 * Navigation semantics only — never an identity claim about the products
 * inside it. A storefront needs to render brands, designers and collections
 * differently from merchandising groups ("New In", "Special Prices"), and
 * deriving that from tree position breaks the moment the tree is reorganised.
 *
 * Nullable on purpose: every category that exists today predates this column
 * and is not misdescribed by any of these values.
 */
export enum CategoryKind {
  PRODUCT_TYPE = 'PRODUCT_TYPE',
  BRAND = 'BRAND',
  DESIGNER = 'DESIGNER',
  COLLECTION = 'COLLECTION',
  MERCHANDISING = 'MERCHANDISING',
}

/**
 * How deep a category chain may be, for both the runtime ancestry resolver and
 * the migration's cycle preflight. A chain longer than this is refused at
 * migration time rather than silently becoming unreadable later.
 */
export const MAX_CATEGORY_DEPTH = 64;

/**
 * A CATEGORY, AND — FROM #292 — A REMOVABLE ONE.
 *
 * `@Filter(removedFilterDef)` is the boundary, default-on, exactly as it is for
 * items: every ordinary read stops seeing a removed category without a caller
 * writing a predicate. `archivedAt` is unchanged and stays the tenant's
 * reversible state, with its existing storefront consequences.
 *
 * SLUG UNIQUENESS MOVED TO THE DATABASE. `(organization, slug)` is a partial
 * unique index over `removed_at is null`, so a removed category releases its
 * slug; `@Unique` here would ask the schema generator to restore the total one.
 *
 * `(id, organization)` IS STILL DECLARED, and must stay total. It is not an
 * identity — it is the composite target every tenancy foreign key points at,
 * including `product_categories` and `category_translations`. Making it partial
 * would pull that target out from under the foreign keys of a removed
 * category, and the database would refuse the removal.
 */
@Entity({ tableName: 'categories' })
// Phase 4: the composite target that lets parent, store and image references
// be tenant-checked by the database instead of by service code alone.
@Unique({ properties: ['id', 'organization'] })
export class Category {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property()
  name!: string;

  @Property()
  slug!: string;

  @Property({ nullable: true })
  description?: string;

  @Property({ nullable: true, length: 160 })
  metaTitle?: string;

  @Property({ nullable: true, length: 300 })
  metaDescription?: string;

  /** The client this category belongs to (P0-05). Nullable until backfill. */
  @ManyToOne(() => Organization, { nullable: true })
  organization?: Organization | null;

  // ORIGIN store — provenance, not a boundary (Phase 4, corrected).
  //
  // A category belongs to the ORGANIZATION; every store of that company shares
  // it. This records which branch created it, and may carry publication
  // context, but it must never restrict who can see, use, parent or assign the
  // category. Null means the category was created at organization level.
  //
  // It previously read "global/legacy, visible to unscoped users only", which
  // described the superseded store-as-tenant model and matched a listing query
  // that hid both sibling branches' categories and every organization-level one.
  @ManyToOne(() => Store, { nullable: true })
  store?: Store | null;

  @ManyToOne(() => Category, { nullable: true })
  parentCategory?: Category;

  // ---------- Phase 4: presentation metadata ----------

  /**
   * What sort of grouping this is. Null means "unclassified", which is what
   * every pre-Phase-4 category is — never guessed from the name or the tree.
   */
  @Property({ nullable: true })
  kind?: CategoryKind | null;

  /**
   * The storefront's display name when it should differ from the internal
   * one. Null means "use `name`" — the serializer never invents a fallback,
   * so absence stays meaningful.
   */
  @Property({ nullable: true, length: 160 })
  publicLabel?: string | null;

  /**
   * Position among SIBLINGS — categories sharing a parent, or all roots.
   * Ties fall to (name, id) so equal ranks are still deterministic. Not a
   * global rank: comparing the order of two categories in different branches
   * is meaningless.
   */
  @Property({ default: 0 })
  sortOrder: number = 0;

  /**
   * Whether a storefront should offer this category in navigation. Purely
   * presentational: it hides NOTHING. Descendants keep their positions and
   * remain reachable, and the products inside stay published and purchasable.
   * This is not a security control and must never be used as one.
   */
  @Property({ default: true })
  showInNavigation: boolean = true;

  /** Public URL of the category's own storefront image. */
  @Property({ nullable: true, length: 2048 })
  imageUrl?: string | null;

  /** Canonical key in the category-image bucket; URLs can change, keys do not. */
  @Property({ nullable: true, length: 512 })
  imageObjectKey?: string | null;

  /**
   * The category's picture, LINKED from the company's asset library — never
   * copied. A brand's logo is simply the image of its BRAND category.
   *
   * `restrict` on delete: a file a category still displays cannot be removed
   * out from under it. Cross-tenant and cross-branch references are refused by
   * the database (composite foreign key plus the scope trigger), not by
   * service code alone.
   */

  // Categories are navigation only. "These rows are one product in several
  // colours" is an identity claim and lives on Product.parent — the
  // variant-group flag that used to sit here created one pseudo-category
  // per product and is gone.

  @Property()
  createdAt?: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt?: Date = new Date();

  @Property({ nullable: true })
  archivedAt?: Date;

  /** Internal lifecycle marker; no recovery surface is exposed. */
  @Property({ type: 'timestamptz', nullable: true })
  removedAt?: Date | null;

  // ── the removal lifecycle (#292, columns defined by Slice A) ──────────────
  //
  // Written only by the removal/restoration service, under the organization
  // access lock, the row lock and the lifecycle lock. Nothing else sets them.

  /** The remover's email AS RECORDED AT THE TIME. Never rewritten. */

  /**
   * WHAT REMOVAL RELEASED, so restoration can re-check it — and nothing else.
   *
   * The slug another category may now hold, and the parent this category was
   * detached from. Facts a restoration must revalidate against today's world,
   * never a snapshot of the record and never a secret.
   */
}
