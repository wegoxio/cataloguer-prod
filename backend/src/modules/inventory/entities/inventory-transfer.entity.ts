import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { InventoryLocation } from './inventory-location.entity';

export type TransferStatus =
  | 'DRAFT'
  | 'COMMITTED'
  | 'IN_TRANSIT'
  | 'PARTIALLY_RECEIVED'
  | 'COMPLETED'
  | 'RETURNING'
  | 'CANCELLED';

/**
 * Custody moving between two of an organization's own locations (Decision 4).
 *
 * A transfer never changes what the organization owns — only where it is. The
 * quantity leaves the source's AVAILABLE, waits as TRANSFER_COMMITTED, travels
 * as IN_TRANSIT (owned, at no location), and arrives in the destination's
 * AVAILABLE. Each step is a balanced command, so the organization total is
 * identical before and after.
 */
@Entity({ tableName: 'inventory_transfers' })
export class InventoryTransfer {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id' })
  organization!: Organization;

  @ManyToOne(() => InventoryLocation, { fieldName: 'source_location_id' })
  sourceLocation!: InventoryLocation;

  @ManyToOne(() => InventoryLocation, { fieldName: 'destination_location_id' })
  destinationLocation!: InventoryLocation;

  @Property({ type: 'text' })
  status: TransferStatus = 'DRAFT';

  @Property({ type: 'text', nullable: true })
  reference?: string | null;

  @Property({ type: 'uuid', nullable: true })
  actorUserId?: string | null;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
