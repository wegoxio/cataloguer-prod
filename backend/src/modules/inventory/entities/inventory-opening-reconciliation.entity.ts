import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Product } from '../../products/entities/product.entity';

export type OpeningReconciliationStatus = 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'POSTED';

/**
 * How one product's opening inventory was decided (P5-B2).
 *
 * `products.stock_quantity` and the sum of `store_products.stock_quantity` are
 * two disconnected pre-ledger columns that disagree in real data, and no global
 * rule can choose between them. So each tracked product gets this: what the
 * legacy columns said, what the system proposed, what a person approved, why
 * they classified the discrepancy that way, who they were, when, and a
 * fingerprint of the exact legacy bytes the decision was made against.
 *
 * The fingerprint is what stops an approval being applied to data that moved
 * afterwards: the opening epoch recomputes it and refuses on any drift.
 *
 * `legacySnapshotJson` exists ONLY to be fingerprinted. The authoritative
 * approved structure is the normalized allocation child rows.
 */
@Entity({ tableName: 'inventory_opening_reconciliations' })
export class InventoryOpeningReconciliation {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id' })
  organization!: Organization;

  @ManyToOne(() => Product, { fieldName: 'product_id' })
  product!: Product;

  /** Canonical legacy bytes; the fingerprint source, never the approved shape. */
  @Property({ type: 'json' })
  legacySnapshotJson!: unknown;

  @Property({ type: 'integer' })
  legacyProductQuantity!: number;

  @Property({ type: 'integer' })
  proposedOrgTotal!: number;

  @Property({ type: 'integer', nullable: true })
  approvedOrgTotal?: number | null;

  /** Zero until B5 supplies a real transfer to reference (CHECK enforces it). */
  @Property({ type: 'integer', default: 0 })
  approvedInTransitQuantity: number = 0;

  @Property({ type: 'text' })
  discrepancyClass!: 'MATCHED' | 'PRODUCT_ONLY' | 'ALLOCATION_ONLY' | 'DIVERGENT';

  @Property({ type: 'text', nullable: true })
  discrepancyReason?: string | null;

  @Property({ type: 'uuid', nullable: true })
  approvedByUserId?: string | null;

  @Property({ type: 'timestamptz', nullable: true })
  approvedAt?: Date | null;

  @Property({ type: 'text' })
  sourceFingerprint!: string;

  @Property({ type: 'text' })
  idempotencyKey!: string;

  @Property({ type: 'text' })
  status: OpeningReconciliationStatus = 'PROPOSED';

  @Property({ type: 'uuid', nullable: true })
  postedTransactionId?: string | null;

  @Property()
  createdAt: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
