import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Product } from '../../products/entities/product.entity';
import { InventoryTransaction } from './inventory-transaction.entity';

/**
 * What a command DECLARED it would do, per product. Append-only.
 *
 * This table exists because a transaction-level total cannot express intent
 * safely. `SUM(quantity_delta) = 0` over a whole transaction accepts "remove
 * five units of product A and add five of product B" — a reservation that
 * silently teleports stock between products. Conservation is therefore checked
 * against a PER-PRODUCT declaration, and the transaction-wide net is an
 * additional assertion rather than the only one.
 *
 * `declaredAmount` is always positive; direction lives in `intentSign`:
 *   0  — the product's own entries net to zero and `declaredAmount` is the
 *        GROSS quantity moved between its cells, so an in-place command proves
 *        how much actually moved instead of merely balancing.
 *   ±1 — the product's owned total changes by `intentSign * declaredAmount`.
 */
@Entity({ tableName: 'inventory_transaction_intents' })
export class InventoryTransactionIntent {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => InventoryTransaction, { fieldName: 'transaction_id' })
  transaction!: InventoryTransaction;

  @ManyToOne(() => Organization, { fieldName: 'organization_id' })
  organization!: Organization;

  @ManyToOne(() => Product, { fieldName: 'product_id' })
  product!: Product;

  @Property({ type: 'integer' })
  declaredAmount!: number;

  @Property({ type: 'smallint' })
  intentSign!: number;
}
