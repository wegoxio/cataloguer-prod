import { Check, Entity, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { Product } from '../../products/entities/product.entity';
import { Store } from '../../stores/entities/store.entity';
import { InventoryTransactionType } from '../ledger/inventory.types';

/**
 * One posted command (ADR 013 §1). Append-only: a database trigger refuses
 * UPDATE and DELETE.
 *
 * Idempotency is `(organization_id, idempotency_key)` PLUS
 * `command_fingerprint`. The unique key alone would let a second, DIFFERENT
 * command under a reused key pass as a replay of the first; the fingerprint
 * turns that into a refused conflict.
 *
 * The affected organization IS `organization` — there is no second audit
 * organization column that could drift from it. The affected branch is
 * `auditStore`, bound by a composite `(audit_store_id, organization_id)`
 * reference so it can never name another client's branch.
 *
 * `salesOrder` and `transfer` are provenance columns with NO
 * foreign key, deliberately:
 *   - `sales_orders.organization_id` is still NULLABLE and neither
 *     external business records do not carry `(id, organization_id)`
 *     unique, so a tenant-safe composite reference is impossible today;
 *   - a single-column FK would be organization-blind, which is exactly the
 *     class of defect Phase 5 has been closing.
 * Their tenancy is asserted by the posting service instead, and the schema work
 * that would make them composite-safe is recorded in the boundary notes.
 * `transfer_id` gets its composite FK in B5, with `inventory_transfers`.
 */
@Entity({ tableName: 'inventory_transactions' })
@Unique({ name: 'inventory_transactions_org_idempotency_unique', properties: ['organization', 'idempotencyKey'] })
@Check({ name: 'inventory_transactions_actor_check', expression: `("actor_kind" = 'USER' and "actor_user_id" is not null and "system_origin" is null) or ("actor_kind" = 'SYSTEM' and "actor_user_id" is null and "system_origin" is not null)` })
export class InventoryTransaction {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id' })
  organization!: Organization;

  @Property({ type: 'text' })
  type!: InventoryTransactionType;

  @Property({ type: 'text' })
  idempotencyKey!: string;

  /** SHA-256 of the canonical command payload, lowercase hex. */
  @Property({ type: 'text' })
  commandFingerprint!: string;

  /** Family root / reassignment scope for the two CROSS_PRODUCT types. */
  @ManyToOne(() => Product, { fieldName: 'scope_product_id', nullable: true })
  scopeProduct?: Product | null;

  /** P5-A1 affected-resource branch. Null for organization-wide commands. */
  @ManyToOne(() => Store, { fieldName: 'audit_store_id', nullable: true })
  auditStore?: Store | null;

  /**
   * Provenance. `actorKind` decides which of the next two columns is set, and a
   * CHECK holds the pair coherent, so a row can never be half-attributed.
   *
   * This entity IS the canonical durable operational audit record for the
   * ledger in B1: it is written in the same transaction as its entries, so it
   * cannot survive a rolled-back posting. `AuditLogService` integration is
   * deliberately deferred to the B3-B8 caller conversions — its row is written
   * outside the posting transaction and fails open, so claiming it is already
   * transactionally coupled to a posting would be untrue.
   */
  @Property({ type: 'text' })
  actorKind!: 'USER' | 'SYSTEM';

  @Property({ type: 'uuid', nullable: true })
  actorUserId?: string | null;

  /** A display snapshot, never the identity — excluded from the fingerprint. */
  @Property({ type: 'text', nullable: true })
  actorEmail?: string | null;

  /** Set only for system postings, e.g. a converted legacy writer in B3. */
  @Property({ type: 'text', nullable: true })
  systemOrigin?: string | null;

  @Property({ type: 'uuid', nullable: true })
  salesOrderId?: string | null;

  @Property({ type: 'uuid', nullable: true })
  transferId?: string | null;

  @Property()
  postedAt: Date = new Date();
}
