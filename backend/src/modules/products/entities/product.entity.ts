import {
  Entity,
  PrimaryKey,
  Property,
  Enum,
  ManyToOne,
  ManyToMany,
  OneToMany,
  Collection,
} from '@mikro-orm/core';
import { ProductStatus } from '../catalogue/product-status.enum';
import { Category } from '../../categories/entities/category.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { ProductImage } from '../../product-images/entities/product-image.entity';
import { Store } from '../../stores/entities/store.entity';
import { StoreProduct } from './store-product.entity';
import { ProductSaleMode } from '../catalogue/product-sale-mode.enum';

/**
 * AN ITEM, AND — FROM #292 — A REMOVABLE ONE.
 *
 * Identity is per client (P0-05): two organizations may both sell a
 * "silla-nordica" or reuse a supplier's SKU without colliding.
 *
 * `@Filter(removedFilterDef)` is the whole boundary. It is default-on, so every
 * ordinary `find`, `findOne`, `count`, `findAndCount`, populate and
 * `nativeUpdate`/`nativeDelete` stops seeing a removed item without a single
 * caller writing a predicate — listings, selectors, search, counts, quotas,
 * exports, import matching, suggestions, inventory reads, the public catalogue
 * and the storefront widget all compose it for free.
 *
 * `archivedAt` is UNCHANGED and remains the tenant-reversible state. `removedAt`
 * is the stronger state layered above it: a removed item is absent from the
 * tenant entirely and only an unscoped Superadmin can bring it back.
 *
 * UNIQUENESS IS THE DATABASE'S, NOT THIS MAPPING'S. `(organization, slug)` and
 * `(organization, sku)` are partial unique indexes over `removed_at is null`,
 * so a removed item releases both identifiers. `@Unique` here would ask the
 * schema generator to put the total constraints back and take the release away.
 */
@Entity({ tableName: 'products' })
export class Product {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @Property()
  name!: string;

  @Property()
  slug!: string;

  @Property({ nullable: true, type: 'text' })
  description?: string;

  @Property({ nullable: true, length: 160 })
  metaTitle?: string;

  @Property({ nullable: true, length: 300 })
  metaDescription?: string;

  @Property({ nullable: true })
  sku?: string;

  /**
   * The SUPPLIER's reference for this item — a different identity from `sku`
   * (governing decision 18).
   *
   * `sku` is Cataloguer's own identifier and is unique per company; this is
   * the manufacturer's part number, and it is deliberately NOT unique at any
   * scope. Two products of one company may carry the same one, and two
   * companies may reuse the same string meaning entirely different things.
   * Matching on it is therefore organization-scoped, case-insensitive, and
   * REFUSES when more than one product answers — never "the first row".
   *
   * Null means "not recorded", which is what every product predating this
   * column says. Nothing derives it from the SKU.
   */
  @Property({ nullable: true })
  manufacturerCode?: string;

  @Enum({ items: () => ProductStatus, default: ProductStatus.DRAFT })
  status!: ProductStatus;

  /** DIRECT is buyable; ON_REQUEST is visible but requires contacting the shop. */
  @Enum({ items: () => ProductSaleMode, default: ProductSaleMode.DIRECT })
  saleMode: ProductSaleMode = ProductSaleMode.DIRECT;

  /**
   * The client whose catalogue this item belongs to (P0-05). Nullable only
   * until the backfill assigns existing rows; new products always carry one.
   */
  @ManyToOne(() => Organization, { nullable: true })
  organization?: Organization | null;

  // Categories are paths to an item, not containers holding it: the same
  // chair is reached through "chairs" and through a brand's new collection,
  // and it stays one item. They say nothing about identity — that two rows
  // are the same product is the parent/children family below.
  @ManyToMany(() => Category, undefined, { owner: true, pivotTable: 'product_categories' })
  categories = new Collection<Category>(this);

  /**
   * The parent product this item is a child of (industry-standard parent/child
   * family). The parent is the card the website shows; its children are the
   * buyable products, each with its own SKU, price, stock and photos.
   */
  @ManyToOne(() => Product, { nullable: true, deleteRule: 'set null' })
  parent?: Product | null;

  /** The children of this product. Non-empty means this product IS a parent. */
  @OneToMany(() => Product, (child) => child.parent)
  children = new Collection<Product>(this);

  /**
   * The option this child offers, e.g. "Green" or "Large" — what a storefront
   * selector shows for it.
   *
   * It is an attribute OF THE CHILD and nothing more. It carries no hierarchy:
   * `parent` alone decides whether this product is a child, and a product with
   * a label but no parent is simply a standalone item whose label is unused.
   */
  @Property({ fieldName: 'option_label', nullable: true })
  optionLabel?: string;

  @Property({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  price!: number;

  @Property({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  salePrice?: number;

  @Property({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  cost?: number;

  @Property({ type: 'integer', default: 0 })
  stockQuantity!: number;

  @Property({ type: 'boolean', default: false })
  trackInventory!: boolean;

  // Sales channels this product is visible in (ADR 007). A product with
  // no stores appears on no website.
  // The pivot is a real entity now (P0-06): membership plus the branch's own
  // published flag, price and stock. Adding a store here creates a
  // StoreProduct with defaults (visible, base price, no stock).
  // The join columns are EXPLICIT: with a custom pivot entity MikroORM
  // infers them from the pivot's property order, and StoreProduct declares
  // `organization` first — the inference silently joined products.id against
  // store_products.organization_id, so every `{stores: X}` filter and every
  // `stores` hydration matched nothing (store-bound admins saw an empty
  // catalog). Explicit columns pin the join to the real pivot pair.
  @ManyToMany({
    entity: () => Store,
    pivotEntity: () => StoreProduct,
    joinColumn: 'product_id',
    inverseJoinColumn: 'store_id',
  })
  stores = new Collection<Store>(this);

  /** The same links with their branch data (published, price, stock). */
  @OneToMany(() => StoreProduct, (link) => link.product)
  branchLinks = new Collection<StoreProduct>(this);

  @OneToMany(() => ProductImage, (image) => image.product)
  images = new Collection<ProductImage>(this);

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
   * The slug and SKU another item may now hold, and the family parent this
   * item was explicitly detached from. Facts a restoration must revalidate
   * against today's world, never a snapshot of the record and never a secret.
   */
}
