import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Product } from '../../products/entities/product.entity';
import { Store } from '../../stores/entities/store.entity';

export type BackorderOrigin = 'OPERATOR' | 'SALES_OVERSELL';
export type BackorderStatus = 'OPEN' | 'PARTIALLY_ALLOCATED' | 'ALLOCATED' | 'CANCELLED';

/**
 * A promise about stock that does NOT exist yet (ADR 013 §5).
 *
 * It creates no ledger entries — that is the entire point. A backorder recorded
 * as a negative balance, or as a reservation against absent stock, is how a
 * system acquires imaginary inventory; the projections stay non-negative
 * precisely because this table sits outside them.
 *
 * `origin` keeps an operator's deliberate promise distinguishable from a
 * `SALES_OVERSELL` the system raised because enforcement was off (Decision A1).
 * They mean different things to whoever has to fulfil them.
 *
 * Queue position is `createdAt` (Decision 3): first promised, first served.
 */
@Entity({ tableName: 'inventory_backorders' })
export class InventoryBackorder {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id' })
  organization!: Organization;

  @ManyToOne(() => Product, { fieldName: 'product_id' })
  product!: Product;

  /** Where it is owed, when a branch is known. */
  @ManyToOne(() => Store, { fieldName: 'store_id', nullable: true })
  store?: Store | null;

  @Property({ type: 'integer' })
  quantity!: number;

  @Property({ type: 'integer', default: 0 })
  allocatedQuantity: number = 0;

  @Property({ type: 'text' })
  origin!: BackorderOrigin;

  @Property({ type: 'text' })
  status: BackorderStatus = 'OPEN';

  @Property({ type: 'text', nullable: true })
  customerName?: string | null;

  @Property({ type: 'text', nullable: true })
  customerPhone?: string | null;

  @Property({ type: 'text', nullable: true })
  customerEmail?: string | null;

  /** Forward compatibility only (ADR 013 §8). */
  @Property({ type: 'uuid', nullable: true })
  customerId?: string | null;

  @Property({ type: 'uuid', nullable: true })
  salesOrderId?: string | null;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
