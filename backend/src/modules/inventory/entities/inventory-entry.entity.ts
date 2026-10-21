import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Product } from '../../products/entities/product.entity';
import { InventoryLocation } from './inventory-location.entity';
import { InventoryTransaction } from './inventory-transaction.entity';
import { OperationalState, PhysicalCondition, TransitDirection } from '../ledger/inventory.types';

/**
 * One immutable signed ledger line (ADR 013 §1). Append-only: a database
 * trigger refuses UPDATE and DELETE.
 *
 * TRANSIT IDENTITY LIVES HERE, not in an inference through the transaction.
 * A transit projection cell is keyed by
 * `(organization, transfer, direction, product, condition)`, so an entry that
 * cannot name its transfer and direction cannot be grouped into exactly one
 * cell. The three-way coherence CHECK ties them together:
 *
 *     (state = 'IN_TRANSIT') = (location_id IS NULL)
 *                            = (transfer_id IS NOT NULL)
 *                            = (transit_direction IS NOT NULL)
 *
 * That partitions every entry into LOCATED (a location, no transfer) and
 * TRANSIT (a transfer and a direction, no location), disjointly and at the
 * database. It is what makes the organization total additive without
 * double-counting: located balances and transit balances cover the entry set
 * exactly once each.
 *
 * `transfer_id` carries no foreign key in B1 — `inventory_transfers` does not
 * exist until B5, and a single-column FK would be organization-blind. It is a
 * reserved identity column whose composite FK lands with that table.
 */
@Entity({ tableName: 'inventory_entries' })
export class InventoryEntry {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => InventoryTransaction, { fieldName: 'transaction_id' })
  transaction!: InventoryTransaction;

  @ManyToOne(() => Organization, { fieldName: 'organization_id' })
  organization!: Organization;

  @ManyToOne(() => Product, { fieldName: 'product_id' })
  product!: Product;

  /** Null exactly when the state is IN_TRANSIT. */
  @ManyToOne(() => InventoryLocation, { fieldName: 'location_id', nullable: true })
  location?: InventoryLocation | null;

  @Property({ type: 'text' })
  physicalCondition!: PhysicalCondition;

  @Property({ type: 'text' })
  operationalState!: OperationalState;

  /** Set exactly when the state is IN_TRANSIT. */
  @Property({ type: 'uuid', nullable: true })
  transferId?: string | null;

  /** Set exactly when the state is IN_TRANSIT. */
  @Property({ type: 'text', nullable: true })
  transitDirection?: TransitDirection | null;

  /** Signed and never zero: a line that moves nothing is not a line. */
  @Property({ type: 'integer' })
  quantityDelta!: number;

  @Property()
  createdAt: Date = new Date();
}
