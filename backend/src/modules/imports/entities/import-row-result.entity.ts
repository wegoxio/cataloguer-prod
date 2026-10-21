import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { ImportExecution } from './import-execution.entity';

/**
 * What happened to one source row, and which record it became.
 *
 * This is the source-to-target identity the reports are built from, and it is
 * also what makes a second import of the same document recognizable: a row that
 * already produced a record can be matched by its durable source identity
 * rather than guessed at by name.
 *
 * Row results outlive the uploaded object. When retention removes the bytes,
 * "row 412 of the March price list became product X" is still true and still
 * answerable — losing that with the file would defeat the point of keeping a
 * plan at all.
 */

export enum RowOutcome {
  CREATED = 'CREATED',
  UPDATED = 'UPDATED',
  SKIPPED = 'SKIPPED',
  /** Refused before execution by a blocking validation. */
  BLOCKED = 'BLOCKED',
  /** Attempted and failed; carries the reason. */
  FAILED = 'FAILED',
  /** Needed a human decision that was never made. */
  UNRESOLVED = 'UNRESOLVED',
}

@Entity({ tableName: 'import_row_results' })
@Unique({ properties: ['execution', 'sourceRow', 'sourceTable'] })
@Index({ properties: ['organization', 'targetType', 'targetId'] })
export class ImportRowResult {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id', nullable: false, deleteRule: 'restrict' })
  organization!: Organization;

  @ManyToOne(() => ImportExecution, { fieldName: 'execution_id', nullable: false, deleteRule: 'cascade' })
  execution!: ImportExecution;

  /** Sheet or table within the source document. */
  @Property({ fieldName: 'source_table', length: 128 })
  sourceTable!: string;

  /** 1-based row number in the source, so an issue can point at the exact cell. */
  @Property({ fieldName: 'source_row' })
  sourceRow!: number;

  @Enum({ items: () => RowOutcome, fieldName: 'outcome' })
  outcome!: RowOutcome;

  /** `product`, `category`, `sales_order`, … — what the row became. */
  @Property({ fieldName: 'target_type', length: 64, nullable: true })
  targetType?: string | null;

  @Property({ fieldName: 'target_id', type: 'uuid', nullable: true })
  targetId?: string | null;

  /**
   * How the row was matched to an existing record: prior source identity,
   * internal SKU, manufacturer code, exact normalized identity, or a person's
   * choice. Recorded because "why did this update rather than create?" is the
   * question every surprising import raises.
   */
  @Property({ fieldName: 'match_provenance', length: 64, nullable: true })
  matchProvenance?: string | null;

  /** User-safe explanation for SKIPPED / BLOCKED / FAILED / UNRESOLVED. */
  @Property({ fieldName: 'reason', type: 'text', nullable: true })
  reason?: string | null;

  /** Warnings a person acknowledged for this row, kept with the outcome. */
  @Property({ fieldName: 'acknowledged_warnings', type: 'json', nullable: true })
  acknowledgedWarnings?: unknown;

  @Property({ fieldName: 'created_at', onCreate: () => new Date() })
  createdAt: Date = new Date();
}

/**
 * The durable link between a source document's row identity and the record it
 * produced, independent of any one execution.
 *
 * This is what makes re-importing a corrected export an UPDATE rather than a
 * duplicate — and it matters more here than in most systems, because the real
 * DesignHof export carries no SKU at all on any of its 841 rows. Its
 * WooCommerce `ID` column is the only stable identity it has, so external
 * identity is not a nicety: without it that catalogue can only ever be matched
 * by name, and six of its names are duplicates.
 */
@Entity({ tableName: 'import_external_identities' })
@Unique({ properties: ['organization', 'sourceSystem', 'externalId', 'targetType'] })
@Index({ properties: ['organization', 'targetType', 'targetId'] })
export class ImportExternalIdentity {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id', nullable: false, deleteRule: 'restrict' })
  organization!: Organization;

  /** `woocommerce`, `shopify`, `manual-spreadsheet`, … */
  @Property({ fieldName: 'source_system', length: 64 })
  sourceSystem!: string;

  /** The identifier that system used. Verbatim; never normalized into a SKU. */
  @Property({ fieldName: 'external_id', length: 255 })
  externalId!: string;

  @Property({ fieldName: 'target_type', length: 64 })
  targetType!: string;

  @Property({ fieldName: 'target_id', type: 'uuid' })
  targetId!: string;

  @Property({ fieldName: 'first_seen_at', onCreate: () => new Date() })
  firstSeenAt: Date = new Date();

  @Property({ fieldName: 'last_seen_at', onCreate: () => new Date(), onUpdate: () => new Date() })
  lastSeenAt: Date = new Date();
}
