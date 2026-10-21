import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';

/**
 * The durable record of a document a tenant uploaded.
 *
 * Before Phase 9 an upload existed only as a Multer buffer for the length of
 * one request, so nothing could be re-analyzed, nothing could be audited, and
 * "which file produced this catalogue change?" had no answer. A source row is
 * the answer, and it is immutable: re-analysis produces a NEW analysis against
 * the same source, never an edit of what was uploaded.
 *
 * `contentHash` is the identity everything downstream binds to. A plan approved
 * against a hash is void the moment the bytes differ, which is what makes
 * "approve now, execute later" safe.
 */

export enum ImportSourceStatus {
  /** Ticket issued; bytes may not have arrived yet. */
  PENDING = 'PENDING',
  /** Bytes present, verified, and censused. */
  READY = 'READY',
  /** Refused at the security or capacity boundary; kept for the diagnosis. */
  REJECTED = 'REJECTED',
  /** Object removed by retention; the row survives as evidence. */
  EXPIRED = 'EXPIRED',
  /**
   * A person decided not to go on with this file, before any plan existed.
   *
   * Distinct from EXPIRED on purpose: that one means retention removed the
   * object, which is a lapse of time with a different remedy. Collapsing the
   * two would make a deliberate decision indistinguishable from a deadline.
   */
  CANCELLED = 'CANCELLED',
}

@Entity({ tableName: 'import_sources' })
@Unique({ properties: ['organization', 'objectKey'] })
@Index({ properties: ['organization', 'createdAt'] })
export class ImportSource {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  /** Tenant anchor. Required — an unattributable source may not exist. */
  @ManyToOne(() => Organization, { fieldName: 'organization_id', nullable: false, deleteRule: 'restrict' })
  organization!: Organization;

  /** Server-minted private-bucket key. Never accepted from a request. */
  @Property({ fieldName: 'object_key', length: 512 })
  objectKey!: string;

  /** What the uploader called it. Display only — never used to decide format. */
  @Property({ fieldName: 'original_file_name', length: 512 })
  originalFileName!: string;

  @Property({ fieldName: 'size_bytes', type: 'bigint' })
  sizeBytes!: number;

  /** SHA-256 of the exact bytes. The identity plans and approvals bind to. */
  @Property({ fieldName: 'content_hash', length: 64 })
  @Index()
  contentHash!: string;

  /** Container decided from the bytes, not from the name. */
  @Property({ fieldName: 'detected_format', length: 32 })
  detectedFormat!: string;

  @Enum({ items: () => ImportSourceStatus, fieldName: 'status', default: ImportSourceStatus.PENDING })
  status: ImportSourceStatus = ImportSourceStatus.PENDING;

  /** Why a REJECTED source was refused. User-safe; never echoes content. */
  @Property({ fieldName: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason?: string | null;

  @Property({ fieldName: 'uploaded_by_user_id', type: 'uuid', nullable: true })
  uploadedByUserId?: string | null;

  @Property({ fieldName: 'uploaded_by_email', length: 255, nullable: true })
  uploadedByEmail?: string | null;

  /**
   * Parser build that produced the census. Stored so a re-analysis under a
   * newer parser is visibly a different derivation rather than silently
   * replacing the old one.
   */
  @Property({ fieldName: 'parser_version', length: 32 })
  parserVersion!: string;

  /** Sheet/table census and active-content findings, as analyzed at upload. */
  @Property({ fieldName: 'census', type: 'json', nullable: true })
  census?: unknown;

  /**
   * When the stored object may be deleted. The ROW outlives it: plans,
   * approvals and row results reference this source long after the bytes are
   * gone, and losing the audit trail with the upload would be the wrong trade.
   */
  @Property({ fieldName: 'retention_expires_at', type: 'timestamptz', nullable: true })
  retentionExpiresAt?: Date | null;

  @Property({ fieldName: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt?: Date | null;

  @Property({ fieldName: 'cancelled_by_user_id', type: 'uuid', nullable: true })
  cancelledByUserId?: string | null;

  @Property({ fieldName: 'cancelled_by_email', length: 255, nullable: true })
  cancelledByEmail?: string | null;

  @Property({ fieldName: 'cancelled_reason', type: 'text', nullable: true })
  cancelledReason?: string | null;

  @Property({ fieldName: 'object_deleted_at', type: 'timestamptz', nullable: true })
  objectDeletedAt?: Date | null;

  @Property({ fieldName: 'created_at', onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ fieldName: 'updated_at', onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
