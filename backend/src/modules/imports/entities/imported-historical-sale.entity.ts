import { Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Store } from '../../stores/entities/store.entity';
import { Product } from '../../products/entities/product.entity';
import { ImportExecution } from './import-execution.entity';

/**
 * A sale that happened before this catalogue existed.
 *
 * Deliberately NOT a `SalesOrder`. Everything that drives fulfilment,
 * availability and the inventory ledger reads `sales_orders` and
 * `sales_order_items`; this is neither, so a historical sale cannot reach any
 * of them however carelessly a later query is written.
 *
 * Three properties are structural rather than conventional:
 *
 *  - `stockDeducted` is false and a CHECK constraint refuses anything else, so
 *    the guarantee survives a code path that tries;
 *  - there is nowhere to put a customer's name, email, address or phone, which
 *    is PII minimization that cannot be forgotten;
 *  - `occurredAt` is the business time. `createdAt` is when we wrote it down.
 *    Conflating them would date a customer's whole history to the day they
 *    migrated.
 */
@Entity({ tableName: 'imported_historical_sales' })
@Unique({ properties: ['execution', 'sourceTable', 'sourceRow'] })
@Index({ properties: ['store', 'occurredAt'] })
export class ImportedHistoricalSale {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id', nullable: false, deleteRule: 'restrict' })
  organization!: Organization;

  /** The shop the sale belongs to. Chosen explicitly; never inferred. */
  @ManyToOne(() => Store, { fieldName: 'store_id', nullable: false, deleteRule: 'restrict' })
  store!: Store;

  /**
   * The product, when a row could be matched to one.
   *
   * Nullable on purpose. A history full of discontinued products will not all
   * match, and refusing those rows would throw away most of what the customer
   * came to keep — so the original text is preserved instead.
   */
  @ManyToOne(() => Product, { fieldName: 'product_id', nullable: true, deleteRule: 'set null' })
  product?: Product | null;

  /** Exactly what the source called it, matched or not. */
  @Property({ fieldName: 'item_text', length: 500 })
  itemText!: string;

  @Property({ fieldName: 'variant_text', length: 255, nullable: true })
  variantText?: string | null;

  @Property({ fieldName: 'quantity', type: 'decimal', precision: 14, scale: 3 })
  quantity!: string;

  @Property({ fieldName: 'unit_price', type: 'decimal', precision: 14, scale: 2, nullable: true })
  unitPrice?: string | null;

  @Property({ fieldName: 'line_total', type: 'decimal', precision: 14, scale: 2, nullable: true })
  lineTotal?: string | null;

  @Property({ fieldName: 'currency', length: 3, nullable: true })
  currency?: string | null;

  /** When the sale happened, not when it was recorded. */
  @Property({ fieldName: 'occurred_at' })
  occurredAt!: Date;

  /** The reference the source system used, so the customer can reconcile. */
  @Property({ fieldName: 'external_ref', length: 255, nullable: true })
  externalRef?: string | null;

  /**
   * An opaque customer reference, and nothing more.
   *
   * Whatever the source used to identify a buyer — an account number, an order
   * code. Never a name, an email or an address: there is no column for those,
   * which is the point.
   */
  @Property({ fieldName: 'customer_reference', length: 255, nullable: true })
  customerReference?: string | null;

  /**
   * Always false, and the database enforces it.
   *
   * Present as a column rather than assumed, so a report can say "inventory
   * unaffected" from stored data instead of from a convention nobody can check.
   */
  @Property({ fieldName: 'stock_deducted', default: false })
  stockDeducted = false;

  @ManyToOne(() => ImportExecution, { fieldName: 'execution_id', nullable: false, deleteRule: 'cascade' })
  execution!: ImportExecution;

  @Property({ fieldName: 'source_table', length: 128 })
  sourceTable!: string;

  @Property({ fieldName: 'source_row' })
  sourceRow!: number;

  @Property({ fieldName: 'created_at', onCreate: () => new Date() })
  createdAt: Date = new Date();
}
