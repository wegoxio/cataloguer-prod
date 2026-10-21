import { Check, Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Product } from '../../products/entities/product.entity';
import { InventoryLocation } from './inventory-location.entity';
import { OperationalState, PhysicalCondition } from '../ledger/inventory.types';

/**
 * The LOCATED balance projection (ADR 013 §1) — never a source of truth.
 *
 * It is written only by the posting mechanism, in the same PostgreSQL
 * transaction as the entries it summarises, and a database trigger refuses any
 * other write. `CHECK (quantity >= 0)` is where an over-draw is actually
 * refused: the posting mechanism does not decide whether enough stock exists,
 * the database does, under the row lock.
 *
 * A balance has NO transaction reference — it is an aggregate, not a line. Its
 * three composite references are organization, location and product.
 *
 * IN_TRANSIT never appears here; transit custody lives in
 * `inventory_transit_balances`, keyed by transfer rather than by location.
 */
@Entity({ tableName: 'inventory_balances' })
@Unique({ name: 'inventory_balances_cell_unique', properties: ['organization', 'location', 'product', 'physicalCondition', 'operationalState'] })
@Check({ name: 'inventory_balances_nonnegative_check', expression: '"quantity" >= 0' })
export class InventoryBalance {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id' })
  organization!: Organization;

  @ManyToOne(() => InventoryLocation, { fieldName: 'location_id' })
  location!: InventoryLocation;

  @ManyToOne(() => Product, { fieldName: 'product_id' })
  product!: Product;

  @Property({ type: 'text' })
  physicalCondition!: PhysicalCondition;

  @Property({ type: 'text' })
  operationalState!: OperationalState;

  @Property({ type: 'integer' })
  quantity!: number;

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
