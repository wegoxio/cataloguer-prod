import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Product } from '../../products/entities/product.entity';
import { InventoryLocation } from './inventory-location.entity';
import { PhysicalCondition } from '../ledger/inventory.types';

export type ReservationStatus = 'ACTIVE' | 'RELEASED' | 'FULFILLED';

/**
 * Stock that EXISTS and has been set aside (ADR 013 §5).
 *
 * Backed by ledger entries moving units AVAILABLE -> RESERVED at one location:
 * the organization still owns them and still counts them, they are simply no
 * longer sellable. Releasing moves them back; fulfilling issues them.
 *
 * Customer identity is a structured inline snapshot (§8) — there is no Customer
 * entity and none is invented. It must never reach a public API, a log, an
 * error message or an evidence artifact.
 */
@Entity({ tableName: 'inventory_reservations' })
export class InventoryReservation {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id' })
  organization!: Organization;

  @ManyToOne(() => Product, { fieldName: 'product_id' })
  product!: Product;

  @ManyToOne(() => InventoryLocation, { fieldName: 'location_id' })
  location!: InventoryLocation;

  @Property({ type: 'text' })
  physicalCondition!: PhysicalCondition;

  @Property({ type: 'integer' })
  quantity!: number;

  @Property({ type: 'text' })
  status: ReservationStatus = 'ACTIVE';

  @Property({ type: 'text', nullable: true })
  customerName?: string | null;

  @Property({ type: 'text', nullable: true })
  customerPhone?: string | null;

  @Property({ type: 'text', nullable: true })
  customerEmail?: string | null;

  /** Forward compatibility only: no Customer entity exists (ADR 013 §8). */
  @Property({ type: 'uuid', nullable: true })
  customerId?: string | null;

  @Property({ type: 'uuid', nullable: true })
  salesOrderId?: string | null;

  @Property({ type: 'uuid' })
  reserveTransactionId!: string;

  /** The release or fulfilment that ended it; null while ACTIVE. */
  @Property({ type: 'uuid', nullable: true })
  settleTransactionId?: string | null;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
