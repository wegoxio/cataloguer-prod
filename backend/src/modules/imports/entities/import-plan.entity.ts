import { Entity, Enum, Index, ManyToOne, PrimaryKey, Property, Unique } from '@mikro-orm/core';
import { Organization } from '../../organizations/entities/organization.entity';
import { ImportSource } from './import-source.entity';

/**
 * A durable, hashed statement of exactly what an import would do.
 *
 * The plan is the thing a person approves, and it is deliberately separate from
 * both the mapping that produced it and the execution that consumes it. That
 * separation is what stops a preview from becoming a mutation: execution takes
 * a plan id and an approval proof, never a body of rows, so there is no request
 * shape that can carry "and also change these" past a review.
 *
 * `planHash` covers everything a reviewer relied on — source bytes, parser
 * version, chosen ranges, mappings, transformations, manual decisions, target
 * assumptions and the resulting mutation set. Any edit changes the hash, which
 * is what makes a stale approval detectable rather than merely unlikely.
 */

export enum ImportType {
  PRODUCTS = 'PRODUCTS',
  CATEGORIES = 'CATEGORIES',
  /** Decision A: record-only. Never posts to the inventory ledger. */
  HISTORICAL_STORE_SALES = 'HISTORICAL_STORE_SALES',
}

export enum ImportPlanStatus {
  DRAFT = 'DRAFT',
  /** Validated and hashed; awaiting approval. */
  READY = 'READY',
  APPROVED = 'APPROVED',
  /** Source, mapping, target state or authority changed after approval. */
  STALE = 'STALE',
  EXECUTING = 'EXECUTING',
  COMPLETED = 'COMPLETED',
  PARTIALLY_COMPLETED = 'PARTIALLY_COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
}

/**
 * How a historical sales import treats stock.
 *
 * Only one value exists, and that is the point. The ledger cannot represent a
 * backdated movement at all — entries carry only `createdAt`, the SECURITY
 * DEFINER doors hardcode `now()`, and the application role cannot post an
 * opening — so an inventory-affecting mode would have to manufacture history or
 * double-decrement stock that already reflects those sales. The enum exists so
 * the plan STATES the choice rather than leaving it implied.
 */
export enum SalesInventoryMode {
  HISTORICAL_RECORD_ONLY = 'HISTORICAL_RECORD_ONLY',
}

@Entity({ tableName: 'import_plans' })
@Unique({ properties: ['organization', 'planHash'] })
@Index({ properties: ['organization', 'status'] })
export class ImportPlan {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  @ManyToOne(() => Organization, { fieldName: 'organization_id', nullable: false, deleteRule: 'restrict' })
  organization!: Organization;

  @ManyToOne(() => ImportSource, { fieldName: 'source_id', nullable: false, deleteRule: 'restrict' })
  source!: ImportSource;

  /**
   * The single store a plan targets, when it targets one.
   *
   * Required for historical sales (decision F binds a branch ADMIN to its own
   * store); null for organization-wide catalogue work, which is owned by the
   * organization rather than by a branch.
   */
  @Property({ fieldName: 'store_id', type: 'uuid', nullable: true })
  storeId?: string | null;

  @Enum({ items: () => ImportType, fieldName: 'import_type' })
  importType!: ImportType;

  @Enum({
    items: () => SalesInventoryMode,
    fieldName: 'sales_inventory_mode',
    nullable: true,
  })
  salesInventoryMode?: SalesInventoryMode | null;

  @Enum({ items: () => ImportPlanStatus, fieldName: 'status', default: ImportPlanStatus.DRAFT })
  status: ImportPlanStatus = ImportPlanStatus.DRAFT;

  /** Monotonic per plan lineage; an edit produces a new version, never a mutation. */
  @Property({ fieldName: 'version', default: 1 })
  version = 1;

  /** Covers source, parser, ranges, mappings, transformations, decisions, mutations. */
  @Property({ fieldName: 'plan_hash', length: 64 })
  planHash!: string;

  /** Source bytes the plan was built from; compared again before execution. */
  @Property({ fieldName: 'source_hash', length: 64 })
  sourceHash!: string;

  @Property({ fieldName: 'analyzer_version', length: 32 })
  analyzerVersion!: string;

  /** Selected sheets/tables/ranges, mappings and transformations. */
  @Property({ fieldName: 'mapping', type: 'json' })
  mapping!: unknown;

  /** Per-row create/update/skip/unresolved decisions and their provenance. */
  @Property({ fieldName: 'decisions', type: 'json' })
  decisions!: unknown;

  /**
   * What the plan assumed about existing records — counts and identities it
   * matched against. Revalidated immediately before execution, because target
   * state can drift between approval and run.
   */
  @Property({ fieldName: 'target_assumptions', type: 'json' })
  targetAssumptions!: unknown;

  /** Counts by outcome, for display without loading the whole mutation set. */
  @Property({ fieldName: 'summary', type: 'json' })
  summary!: unknown;

  @Property({ fieldName: 'created_by_user_id', type: 'uuid', nullable: true })
  createdByUserId?: string | null;

  @Property({ fieldName: 'created_at', onCreate: () => new Date() })
  createdAt: Date = new Date();

  @Property({ fieldName: 'updated_at', onCreate: () => new Date(), onUpdate: () => new Date() })
  updatedAt: Date = new Date();
}
