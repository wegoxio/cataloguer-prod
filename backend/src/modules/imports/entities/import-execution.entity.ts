import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { ImportPlan } from './import-plan.entity';

/**
 * One attempt to execute one approved plan, and the checkpoints that make the
 * attempt resumable.
 *
 * The execution row is the authority on what happened — not the logs. That
 * distinction is deliberate and inherited from the Phase 5 cutover work: if a
 * batch committed but its log never arrived, the correct response is to read
 * the checkpoint and continue, never to re-run a mutation in the hope of
 * producing the missing line.
 *
 * A durable lease is what keeps two workers off the same plan. It is held with
 * a heartbeat rather than a lock, because a worker can die without releasing
 * anything, and an expired lease is safe to steal precisely because the
 * checkpoints say exactly how far the dead worker got.
 */

export enum ImportExecutionStatus {
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  /** Some batches committed durably; the rest did not. Not a failure to hide. */
  PARTIALLY_COMPLETED = 'PARTIALLY_COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  /** Lease expired without completion; resumable from the last checkpoint. */
  ABANDONED = 'ABANDONED',
}

@Entity({ tableName: 'import_executions' })
@Index({ properties: ['organization', 'status'] })
export class ImportExecution {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id', nullable: false, deleteRule: 'restrict' })
  organization!: Organization;

  @ManyToOne(() => ImportPlan, { fieldName: 'plan_id', nullable: false, deleteRule: 'restrict' })
  plan!: ImportPlan;

  /**
   * Exact execution identity — the ephemeral Docker container name when run as a
   * job, or a local worker id. Recorded so "which run did this?" is answerable
   * without correlating timestamps.
   */
  @Property({ fieldName: 'execution_identity', length: 255 })
  executionIdentity!: string;

  @Enum({ items: () => ImportExecutionStatus, fieldName: 'status', default: ImportExecutionStatus.QUEUED })
  status: ImportExecutionStatus = ImportExecutionStatus.QUEUED;

  /** Worker currently holding the lease, if any. */
  @Property({ fieldName: 'lease_owner', length: 255, nullable: true })
  leaseOwner?: string | null;

  /** Lease is valid until this instant; a later heartbeat extends it. */
  @Property({ fieldName: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt?: Date | null;

  @Property({ fieldName: 'heartbeat_at', type: 'timestamptz', nullable: true })
  heartbeatAt?: Date | null;

  /** Batches fully committed. The resume point, and the reason a rerun is never needed. */
  @Property({ fieldName: 'batches_completed', default: 0 })
  batchesCompleted = 0;

  @Property({ fieldName: 'batches_total', default: 0 })
  batchesTotal = 0;

  @Property({ fieldName: 'rows_created', default: 0 })
  rowsCreated = 0;

  @Property({ fieldName: 'rows_updated', default: 0 })
  rowsUpdated = 0;

  @Property({ fieldName: 'rows_skipped', default: 0 })
  rowsSkipped = 0;

  @Property({ fieldName: 'rows_failed', default: 0 })
  rowsFailed = 0;

  /** Set when a person asks to stop; the worker finishes its batch, then stops. */
  @Property({ fieldName: 'cancel_requested_at', type: 'timestamptz', nullable: true })
  cancelRequestedAt?: Date | null;

  @Property({ fieldName: 'failure_reason', type: 'text', nullable: true })
  failureReason?: string | null;

  @Property({ fieldName: 'started_at', type: 'timestamptz', nullable: true })
  startedAt?: Date | null;

  @Property({ fieldName: 'finished_at', type: 'timestamptz', nullable: true })
  finishedAt?: Date | null;

  @Property({ fieldName: 'created_at', onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ fieldName: 'updated_at', onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}

/**
 * One durably committed batch.
 *
 * The unique key is what makes resume idempotent: a batch that already has a
 * row was already committed, so a resumed worker skips it by insertion failure
 * rather than by trusting an in-memory counter.
 */
@Entity({ tableName: 'import_checkpoints' })
@Unique({ properties: ['execution', 'batchIndex'] })
export class ImportCheckpoint {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => ImportExecution, { fieldName: 'execution_id', nullable: false, deleteRule: 'cascade' })
  execution!: ImportExecution;

  @Property({ fieldName: 'batch_index' })
  batchIndex!: number;

  @Property({ fieldName: 'first_row' })
  firstRow!: number;

  @Property({ fieldName: 'last_row' })
  lastRow!: number;

  /**
   * Digest of the batch's intended mutations, so a resumed worker can prove the
   * committed batch is the same work the current plan describes.
   */
  @Property({ fieldName: 'batch_fingerprint', length: 64 })
  batchFingerprint!: string;

  @Property({ fieldName: 'rows_created', default: 0 })
  rowsCreated = 0;

  @Property({ fieldName: 'rows_updated', default: 0 })
  rowsUpdated = 0;

  @Property({ fieldName: 'rows_skipped', default: 0 })
  rowsSkipped = 0;

  @Property({ fieldName: 'rows_failed', default: 0 })
  rowsFailed = 0;

  @Property({ fieldName: 'committed_at', onCreate: () => new Date() })
  committedAt: Date = new Date();
}
