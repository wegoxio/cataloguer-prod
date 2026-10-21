import { Check, Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Product } from '../../products/entities/product.entity';
import { PhysicalCondition, TransitDirection } from '../ledger/inventory.types';

/**
 * The LOCATION-LESS transit projection (ADR 013 §4, confirmed by R11).
 *
 * Stock in transit is organization-owned but present at no location, so it
 * cannot live in `inventory_balances` — that table requires a location and
 * excludes IN_TRANSIT by CHECK. It is kept as its own entity rather than folded
 * into the located projection because its key is the transfer and its direction,
 * not a location, and because B5 grows it with the transfer lifecycle.
 *
 * Its key is exactly the tuple an IN_TRANSIT entry carries, so equation 2 joins
 * entries to cells without inferring anything.
 *
 * `transfer_id` has no foreign key until B5 introduces `inventory_transfers`;
 * see the entry entity for why a single-column reference is not used instead.
 */
@Entity({ tableName: 'inventory_transit_balances' })
@Unique({ name: 'inventory_transit_balances_cell_unique', properties: ['organization', 'transferId', 'transitDirection', 'product', 'physicalCondition'] })
@Check({ name: 'inventory_transit_balances_nonnegative_check', expression: '"quantity" >= 0' })
export class InventoryTransitBalance {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id' })
  organization!: Organization;

  @Property({ type: 'uuid' })
  transferId!: string;

  @Property({ type: 'text' })
  transitDirection!: TransitDirection;

  @ManyToOne(() => Product, { fieldName: 'product_id' })
  product!: Product;

  @Property({ type: 'text' })
  physicalCondition!: PhysicalCondition;

  @Property({ type: 'integer' })
  quantity!: number;

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
