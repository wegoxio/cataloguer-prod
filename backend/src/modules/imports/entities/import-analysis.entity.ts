import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { ImportSource } from './import-source.entity';

/**
 * One derivation of meaning from one source.
 *
 * Analyses are append-only against an immutable source: re-analyzing under a
 * newer analyzer, or after a person selects a different table, creates a NEW
 * analysis rather than editing the old one. That is what lets a plan cite the
 * exact derivation it was built from, months later, without wondering whether
 * the analyzer has changed underneath it.
 *
 * The analysis holds proposals and confidence, never decisions — a proposal is
 * something a person can overrule, and keeping the two in separate rows is what
 * keeps "what the machine suggested" distinguishable from "what the person
 * chose" in the audit trail.
 */

export enum ImportAnalysisStatus {
  QUEUED = 'QUEUED',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

@Entity({ tableName: 'import_analyses' })
@Index({ properties: ['organization', 'createdAt'] })
@Index({ properties: ['source'] })
export class ImportAnalysis {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id', nullable: false, deleteRule: 'restrict' })
  organization!: Organization;

  @ManyToOne(() => ImportSource, { fieldName: 'source_id', nullable: false, deleteRule: 'restrict' })
  source!: ImportSource;

  @Enum({ items: () => ImportAnalysisStatus, fieldName: 'status', default: ImportAnalysisStatus.QUEUED })
  status: ImportAnalysisStatus = ImportAnalysisStatus.QUEUED;

  /** Bound to the bytes analyzed, not merely to the source row. */
  @Property({ fieldName: 'source_hash', length: 64 })
  sourceHash!: string;

  @Property({ fieldName: 'analyzer_version', length: 32 })
  analyzerVersion!: string;

  /** Exact execution identity when the analysis ran as a job. */
  @Property({ fieldName: 'execution_identity', length: 255, nullable: true })
  executionIdentity?: string | null;

  @Property({ fieldName: 'lease_owner', length: 255, nullable: true })
  leaseOwner?: string | null;

  @Property({ fieldName: 'lease_expires_at', type: 'timestamptz', nullable: true })
  leaseExpiresAt?: Date | null;

  @Property({ fieldName: 'heartbeat_at', type: 'timestamptz', nullable: true })
  heartbeatAt?: Date | null;

  /**
   * Detected tables: sheet, header row, data range, columns with inferred types
   * and representative values, formulas, merges, duplicates and anomalies.
   */
  @Property({ fieldName: 'tables', type: 'json', nullable: true })
  tables?: unknown;

  /** Proposed import type, field mappings and relationships, with reasons. */
  @Property({ fieldName: 'proposals', type: 'json', nullable: true })
  proposals?: unknown;

  /** Blocking / warning / informational findings raised during analysis. */
  @Property({ fieldName: 'findings', type: 'json', nullable: true })
  findings?: unknown;

  @Property({ fieldName: 'rows_analyzed', default: 0 })
  rowsAnalyzed = 0;

  @Property({ fieldName: 'cells_analyzed', default: 0 })
  cellsAnalyzed = 0;

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
