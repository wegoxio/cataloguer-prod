import { Cascade, Collection, Entity, ManyToOne, OneToMany, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Store } from '../stores/entities/store.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { Product } from '../products/entities/product.entity';

export enum SalesOrderStatus {
  NEW = 'NEW',
  CONFIRMED = 'CONFIRMED',
  PAID = 'PAID',
  DELIVERED = 'DELIVERED',
  CANCELLED = 'CANCELLED',
}

/** An order placed by a final user on a client's website (Sales). */
@Entity({ tableName: 'sales_orders' })
export class SalesOrder {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Store)
  store!: Store;

  /** The client the sale belongs to (P0-10); the store says which branch. */
  @ManyToOne(() => Organization, { nullable: true })
  organization?: Organization | null;

  @Property()
  @Unique()
  orderNumber!: string;

  // Public checkout retry-safety: same key = same order, never a duplicate
  @Property({ nullable: true, unique: true })
  idempotencyKey?: string;

  @Property({ default: SalesOrderStatus.NEW })
  status: string = SalesOrderStatus.NEW;

  @Property({ nullable: true })
  customerName?: string;

  @Property({ nullable: true })
  customerPhone?: string;

  @Property({ type: 'decimal', precision: 10, scale: 2 })
  totalUsd!: string;

  // Discount applied at checkout (null when none). totalUsd is already net.
  @Property({ nullable: true })
  discountCode?: string;

  @Property({ type: 'decimal', precision: 10, scale: 2, default: 0 })
  discountUsd: string = '0.00';

  @OneToMany(() => SalesOrderItem, (item) => item.order, { cascade: [Cascade.ALL] })
  items = new Collection<SalesOrderItem>(this);

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}

/** Line item with a price snapshot (catalog prices change over time). */
@Entity({ tableName: 'sales_order_items' })
export class SalesOrderItem {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => SalesOrder)
  order!: SalesOrder;

  @ManyToOne(() => Product, { nullable: true })
  product?: Product | null;

  @Property()
  productName!: string;

  // Snapshot of the chosen variant (size/color) at order time
  @Property({ nullable: true })
  variantName?: string;

  @Property({ type: 'decimal', precision: 10, scale: 2 })
  unitPriceUsd!: string;

  @Property()
  quantity!: number;

  // Units actually taken from inventory when the order was created —
  // restored on cancellation (0 for untracked items)
  @Property({ type: 'integer', default: 0 })
  stockDeducted: number = 0;
}
