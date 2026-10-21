import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Product } from '../../products/entities/product.entity';
import { InventoryTransfer } from './inventory-transfer.entity';
import { PhysicalCondition } from '../ledger/inventory.types';

/**
 * One product's journey inside a transfer.
 *
 * The quantities are deliberately separate rather than one "status": a
 * dispatch of ten can arrive as six with four still travelling and one on its
 * way back, and a single status could not say that. Each is a subset of the one
 * before it, held by a database CHECK.
 */
@Entity({ tableName: 'inventory_transfer_lines' })
export class InventoryTransferLine {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id' })
  organization!: Organization;

  @ManyToOne(() => InventoryTransfer, { fieldName: 'transfer_id' })
  transfer!: InventoryTransfer;

  @ManyToOne(() => Product, { fieldName: 'product_id' })
  product!: Product;

  @Property({ type: 'text' })
  physicalCondition: PhysicalCondition = 'GOOD';

  /** What the transfer set out to move. */
  @Property({ type: 'integer' })
  quantity!: number;

  @Property({ type: 'integer', default: 0 })
  dispatchedQuantity: number = 0;

  @Property({ type: 'integer', default: 0 })
  receivedQuantity: number = 0;

  /** Travelling back, not yet home. */
  @Property({ type: 'integer', default: 0 })
  returningQuantity: number = 0;

  @Property({ type: 'integer', default: 0 })
  returnedQuantity: number = 0;
}
