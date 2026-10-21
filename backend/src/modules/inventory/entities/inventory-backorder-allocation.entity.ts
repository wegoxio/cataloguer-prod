import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { InventoryBackorder } from './inventory-backorder.entity';
import { InventoryReservation } from './inventory-reservation.entity';

/**
 * One moment at which a backorder was met by real stock (ADR 013 §5, §6).
 *
 * Allocation turns a promise into a physical reservation: the units now exist,
 * so they are reserved at a location and this row records which promise they
 * answered. Immutable, because it is a record of something that happened.
 */
@Entity({ tableName: 'inventory_backorder_allocations' })
export class InventoryBackorderAllocation {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id' })
  organization!: Organization;

  @ManyToOne(() => InventoryBackorder, { fieldName: 'backorder_id' })
  backorder!: InventoryBackorder;

  @ManyToOne(() => InventoryReservation, { fieldName: 'reservation_id' })
  reservation!: InventoryReservation;

  @Property({ type: 'integer' })
  quantity!: number;

  @Property()
  allocatedAt: Date = new Date();
}
