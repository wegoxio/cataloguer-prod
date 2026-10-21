import { Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Product } from './product.entity';
import { Store } from '../../stores/entities/store.entity';
import { Organization } from '../../organizations/entities/organization.entity';

/**
 * One product as one branch sells it (P0-06).
 *
 * The catalogue entry (Product) is the organization's; what differs per branch
 * lives here: whether the branch shows it, at what price, and how many units
 * that branch actually holds. Store A selling out or discounting never touches
 * Store B.
 *
 * This table replaces both `product_stores` (membership) and
 * `product_store_prices` (price overrides). It doubles as the pivot entity of
 * the `product.stores` many-to-many, so every existing "which stores show
 * this" query keeps working while the pivot rows carry the branch data.
 *
 * `organization` is denormalized on purpose: it lets the database itself
 * refuse a row pairing a product with a store of another client, without a
 * join at write time.
 */
@Entity({ tableName: 'store_products' })
@Unique({ properties: ['store', 'product'] })
export class StoreProduct {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { nullable: true })
  organization?: Organization | null;

  @ManyToOne(() => Store, { deleteRule: 'cascade' })
  store!: Store;

  @ManyToOne(() => Product, { deleteRule: 'cascade' })
  product!: Product;

  /**
   * Whether this branch shows the product.
   *
   * Defaults to HIDDEN (B4a3). Publication is a stated act, not what happens
   * when nobody says otherwise: a pivot created without naming this column —
   * including one the ORM mints implicitly when a product's store collection
   * changes — must not begin showing a product that answers none of the fields
   * the branch requires. Paths meaning "attach and publish" set it explicitly.
   *
   * Both defaults matter and must agree: this initializer governs rows the ORM
   * creates, the column default governs raw SQL and any insert omitting the
   * column. Changing one alone leaves the other still publishing.
   */
  @Property({ type: 'boolean', default: false })
  published: boolean = false;

  /** Branch price. Null = the product's base price applies. */
  @Property({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  price?: number | null;

  @Property({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  salePrice?: number | null;

  @Property({ type: 'decimal', precision: 10, scale: 2, nullable: true })
  cost?: number | null;

  /** Physical units in THIS branch. Never a fallback — stock is not shared. */
  @Property({ type: 'integer', default: 0 })
  stockQuantity: number = 0;

  @Property({ type: 'boolean', default: false })
  trackInventory: boolean = false;

  /**
   * Days THIS branch needs to deliver. Null = not stated, which is not the
   * same as 0 (ships immediately). Never inherited from the product or from a
   * family card: only the branch that fulfils knows how long it takes.
   */
  @Property({ type: 'integer', nullable: true })
  leadTimeDays?: number | null;

  @Property()
  createdAt?: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt?: Date = new Date();
}
