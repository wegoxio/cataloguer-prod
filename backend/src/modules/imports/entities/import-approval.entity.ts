import { Entity, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { ImportPlan } from './import-plan.entity';

/**
 * A server-issued proof that a named person approved one exact plan.
 *
 * The proof is issued by the server and never assembled by a client, because an
 * approval a caller can construct is not an approval. Execution presents the
 * proof and the server re-derives everything it binds: the plan hash, the
 * source hash, the approver's authority at THIS moment (not at approval time),
 * and the target state the plan assumed.
 *
 * Expiry is 72 hours. Long enough that a reviewer can approve on Friday and run
 * on Monday; short enough that a proof does not outlive the catalogue it was
 * reasoned about.
 */

export const APPROVAL_TTL_HOURS = 72;

@Entity({ tableName: 'import_approvals' })
@Unique({ properties: ['plan', 'planHash'] })
@Index({ properties: ['organization', 'createdAt'] })
export class ImportApproval {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id', nullable: false, deleteRule: 'restrict' })
  organization!: Organization;

  @ManyToOne(() => ImportPlan, { fieldName: 'plan_id', nullable: false, deleteRule: 'restrict' })
  plan!: ImportPlan;

  /** The plan version this approval was granted for. */
  @Property({ fieldName: 'plan_version' })
  planVersion!: number;

  /** Re-checked at execution; a differing hash voids the proof. */
  @Property({ fieldName: 'plan_hash', length: 64 })
  planHash!: string;

  @Property({ fieldName: 'source_hash', length: 64 })
  sourceHash!: string;

  /**
   * Opaque, high-entropy token. Stored hashed for the same reason a password
   * is: a database read should not yield a usable authorization.
   */
  @Property({ fieldName: 'proof_hash', length: 64 })
  @Index()
  proofHash!: string;

  @Property({ fieldName: 'approved_by_user_id', type: 'uuid' })
  approvedByUserId!: string;

  @Property({ fieldName: 'approved_by_email', length: 255 })
  approvedByEmail!: string;

  /**
   * The authority the approver held, recorded as a fact.
   *
   * Authority is re-checked at execution rather than trusted from here — a role
   * can be revoked between approval and run — but recording it makes "who could
   * do this, and under what role" answerable afterwards.
   */
  @Property({ fieldName: 'approved_with_role', length: 64 })
  approvedWithRole!: string;

  @Property({ fieldName: 'approved_with_store_id', type: 'uuid', nullable: true })
  approvedWithStoreId?: string | null;

  @Property({ fieldName: 'expires_at' })
  expiresAt!: Date;

  /** Set when the plan, source, target state or authority changed underneath it. */
  @Property({ fieldName: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt?: Date | null;

  @Property({ fieldName: 'revoked_reason', type: 'text', nullable: true })
  revokedReason?: string | null;

  /** Set when the proof has been spent, so one approval cannot run twice. */
  @Property({ fieldName: 'consumed_at', type: 'timestamptz', nullable: true })
  consumedAt?: Date | null;

  @Property({ fieldName: 'created_at', onCreate: () => new Date() })
  createdAt: Date = new Date();
}
