import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { InventoryLocation } from './inventory-location.entity';
import { InventoryOpeningReconciliation } from './inventory-opening-reconciliation.entity';

/**
 * One approved destination and quantity of an opening reconciliation (P5-B2).
 *
 * These rows ARE the approved allocation structure. A JSON map could not carry
 * the composite tenant reference, the per-row non-negative check, or the
 * uniqueness that stops the same destination being approved twice — and it
 * could not be reconciled in SQL against the ledger afterwards.
 *
 * The warehouse remainder is not special: it is the row whose destination is
 * the organization's default warehouse. Treating it as a scalar would have made
 * a negative remainder representable, which it now is not.
 */
@Entity({ tableName: 'inventory_opening_reconciliation_allocations' })
export class InventoryOpeningReconciliationAllocation {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id' })
  organization!: Organization;

  @ManyToOne(() => InventoryOpeningReconciliation, { fieldName: 'reconciliation_id' })
  reconciliation!: InventoryOpeningReconciliation;

  @ManyToOne(() => InventoryLocation, { fieldName: 'destination_location_id' })
  destinationLocation!: InventoryLocation;

  @Property({ type: 'integer' })
  approvedQuantity!: number;

  @Property()
  createdAt: Date = new Date();
}
