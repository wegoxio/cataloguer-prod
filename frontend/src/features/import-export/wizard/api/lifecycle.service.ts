import { apiFetch } from '../../../../lib/api-client';
import type { GroupedIssue, IssueSummary, SourceSample, TableMapping } from './wizard-contract.types';

/**
 * The import's lifecycle, as the browser sees it.
 *
 * Every endpoint here is under `/import/lifecycle`, and none of them returns
 * anything that outlives the request that produced it — no bucket, no endpoint,
 * no credential, and no object key the page could turn into a request against
 * storage. The upload ticket is the one exception by design: a signed URL with
 * a five-minute life, which is the whole permission and expires on its own.
 */

export type ImportType = 'PRODUCTS' | 'CATEGORIES' | 'HISTORICAL_STORE_SALES';

export interface UploadTicket {
  objectKey: string;
  url: string;
  headers: Record<string, string>;
  maxBytes: number;
  expiresInSeconds: number;
}

export interface RegisteredSource {
  id: string;
  contentHash: string;
  sizeBytes: number;
}

export interface StockDestination {
  id: string;
  name: string;
  kind: string;
  storeId: string | null;
  isDefault: boolean;
  /** The scoped shop's own custody. A proposal, never an application. */
  proposed: boolean;
}

export interface RelationshipOptions {
  storeId: string | null;
  stockDestinations: StockDestination[];
  stores: { id: string; name: string }[];
  existingCategoryNames: string[];
}

export interface SourceSummary {
  id: string;
  originalFileName: string;
  detectedFormat: string;
  contentHash: string;
  status: 'AVAILABLE' | 'EXPIRED' | 'MISSING';
  createdAt: string;
}

export interface AnalysisSummary {
  id: string;
  sourceId: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  tables: unknown;
  proposals: unknown;
  findings: unknown;
  rowsAnalyzed: number;
  failureReason: string | null;
}

/**
 * What state an import is really in, as the server reconciles it.
 *
 * The plan's own status column is not this answer and must not be used as one:
 * nothing advances it after a run, and it has been observed reading APPROVED
 * for two days beside a COMPLETED execution and a consumed approval. The server
 * projects plan, approval and execution together and says which of them it
 * believed.
 */
export interface PlanLifecycle {
  planId: string;
  planHash: string;
  sourceId: string;
  importType: string;
  storeId: string | null;
  state:
    | 'PREPARED'
    | 'APPROVED'
    | 'EXECUTING'
    | 'COMPLETED'
    | 'PARTIALLY_COMPLETED'
    | 'FAILED'
    | 'CANCELLED'
    | 'APPROVAL_SPENT';
  authority: 'EXECUTION' | 'APPROVAL' | 'PLAN';
  statusIsStale: boolean;
  storedStatus: string;
  mayApprove: boolean;
  mayExecute: boolean;
  approval: { id: string; state: 'NONE' | 'ACTIVE' | 'CONSUMED' | 'EXPIRED' | 'REVOKED'; expiresAt: string; consumedAt: string | null } | null;
  execution: { id: string; status: string; startedAt: string; finishedAt: string | null; cancelRequested: boolean } | null;
}

/** One import this company has started, as the listing describes it. */
export interface DraftImport {
  sourceId: string;
  fileName: string;
  importType: string | null;
  organizationId: string;
  storeId: string | null;
  stage:
    | 'CANCELLED'
    | 'UPLOADING'
    | 'READING'
    | 'MAPPING_IN_PROGRESS'
    | 'PLAN_REVIEW'
    /** Approved and not yet started. Openable, so a lost proof can be withdrawn. */
    | 'APPROVED_PENDING'
    | 'ACTIVE'
    | 'COMPLETED'
    | 'RECOVERY';
  /** The plan to open, for PLAN_REVIEW and APPROVED_PENDING. Navigation hint only. */
  planId: string | null;
  sourceStatus: string;
  analysisStatus: string | null;
  planStatus: string | null;
  executionStatus: string | null;
  hasUnexecutedDraftPlan: boolean;
  /**
   * The run this plan HAS, and what it did.
   *
   * A plan carries at most one execution — `import_executions` has a unique
   * index on `plan_id`, and resuming updates that row rather than adding one —
   * so these describe that run, not the latest of several. Null throughout
   * when nothing has been started, which is a different fact from a run that
   * wrote nothing.
   */
  executionId: string | null;
  finishedAt: string | null;
  rowsCreated: number | null;
  rowsUpdated: number | null;
  rowsSkipped: number | null;
  rowsFailed: number | null;
  /** When this import last did something. What the listing sorts on. */
  activityAt: string;
  createdAt: string;
  updatedAt: string;
}

/** A stored plan, as the server holds it. */
export interface StoredPlan {
  id: string;
  importType: ImportType;
  planHash: string;
  status: string;
  storeId: string | null;
  sourceId?: string;
  mapping?: { sheet?: string; headerRow?: number; columns: { columnIndex: number; header: string; field: string | null }[] };
  decisions?: unknown;
  summary: {
    issues?: GroupedIssue[];
    readiness?: { allowed: boolean; reason?: string };
    previewedRows?: number;
    blankRowCount?: number;
    summary?: { total?: number; blocking?: number; warning?: number; informational?: number };
  };
}

export interface CreatedPlan {
  id: string;
  planHash: string;
  readiness: { allowed: boolean; reason?: string };
  outstanding: number;
  alreadyExisted: boolean;
}

export interface Approval {
  approvalId: string;
  /** Returned once. Held only in memory, never written to storage. */
  proof: string;
  expiresAt: string;
  notice: string;
}

export interface ExecutionStatus {
  id: string;
  planId: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIALLY_COMPLETED' | 'FAILED' | 'CANCELLED' | 'ABANDONED';
  batchesCompleted: number;
  batchesTotal: number;
  rows: { created: number; updated: number; skipped: number; failed: number };
  cancelRequested: boolean;
  resumable: boolean;
  failureReason: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  checkpoints: { batchIndex: number; firstRow: number; lastRow: number; committedAt: string }[];
}

/**
 * What one row actually did, thing by thing.
 *
 * Deliberately nullable end to end. A row written before the server recorded
 * effects carries `null`, and that is a different fact from a row that recorded
 * "nothing happened" — the screen has to be able to say so rather than invent
 * an answer on its behalf.
 *
 * Every state is an open `string` rather than a closed union: the server owns
 * this vocabulary, and a frontend that type-errors on a state the server added
 * is a frontend that must ship in lockstep with it.
 */
export interface RowEffects {
  product?: { state: string; sku?: string | null } | null;
  storeAssociation?: { state: string; storeName?: string | null; published?: boolean } | null;
  categories?: {
    state: string;
    created?: string[];
    reused?: string[];
    associated?: string[];
    blocked?: string[];
  } | null;
  inventory?: {
    state: string;
    locationName?: string | null;
    locationKind?: string | null;
    quantity?: number;
  } | null;
}

export interface RowResult {
  sourceTable: string;
  sourceRow: number;
  outcome: string;
  targetType: string | null;
  targetId: string | null;
  matchedBy: string | null;
  reason: string | null;
  /** Absent or null on rows imported before the run recorded its effects. */
  effects?: RowEffects | null;
}

export interface ReportSummary extends IssueSummary {
  headline: string;
  repair: string[];
}

export const lifecycleService = {
  async createUploadTicket(
    token: string,
    body: { fileName: string; contentType: string; maxBytes: number },
  ): Promise<UploadTicket> {
    const response = await apiFetch('/import/lifecycle/sources/ticket', {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    });
    return response.data as UploadTicket;
  },

  async registerSource(
    token: string,
    body: { objectKey: string; originalFileName: string; sizeBytes: number; contentHash?: string; detectedFormat: string },
  ): Promise<RegisteredSource> {
    const response = await apiFetch('/import/lifecycle/sources', {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    });
    return response.data as RegisteredSource;
  },

  async getSource(token: string, sourceId: string): Promise<SourceSummary> {
    const response = await apiFetch(`/import/lifecycle/sources/${encodeURIComponent(sourceId)}`, {
      method: 'GET',
      token,
    });
    return response.data as SourceSummary;
  },

  async startAnalysis(token: string, sourceId: string): Promise<{ id: string; status: string }> {
    const response = await apiFetch(`/import/lifecycle/sources/${encodeURIComponent(sourceId)}/analysis`, {
      method: 'POST',
      token,
      body: JSON.stringify({}),
    });
    return response.data;
  },

  async getAnalysis(token: string, analysisId: string): Promise<AnalysisSummary> {
    const response = await apiFetch(`/import/lifecycle/analyses/${encodeURIComponent(analysisId)}`, {
      method: 'GET',
      token,
    });
    return response.data as AnalysisSummary;
  },

  /**
   * What this caller may choose from in the relationships step.
   *
   * Fetched, never held locally: a hardcoded location or shop id is a
   * cross-tenant bug waiting for a second customer.
   */
  async relationshipOptions(token: string, storeId?: string | null): Promise<RelationshipOptions> {
    const query = storeId ? `?storeId=${encodeURIComponent(storeId)}` : '';
    const response = await apiFetch(`/import/lifecycle/relationship-options${query}`, { method: 'GET', token });
    return response.data as RelationshipOptions;
  },

  async createPlan(
    token: string,
    body: {
      sourceId: string;
      importType: ImportType;
      mapping: TableMapping;
      relationships?: unknown;
      sample: SourceSample;
      columnTypes: string[];
      storeId?: string;
      acknowledgedIssueCodes?: string[];
    },
  ): Promise<CreatedPlan> {
    const response = await apiFetch('/import/lifecycle/plans', {
      method: 'POST',
      token,
      body: JSON.stringify(body),
    });
    return response.data as CreatedPlan;
  },

  async getPlan(token: string, planId: string) {
    const response = await apiFetch(`/import/lifecycle/plans/${encodeURIComponent(planId)}`, {
      method: 'GET',
      token,
    });
    return response.data as {
      id: string;
      importType: ImportType;
      planHash: string;
      status: string;
      storeId: string | null;
      summary: { issues?: GroupedIssue[]; readiness?: { allowed: boolean; reason?: string } };
    };
  },

  /**
   * Approve a plan and receive the proof.
   *
   * The proof is a bearer credential for a catalogue-wide write until it is
   * used or expires. It is held in memory for the length of the session and
   * never written to browser storage.
   */
  async approvePlan(token: string, planId: string): Promise<Approval> {
    const response = await apiFetch(`/import/lifecycle/plans/${encodeURIComponent(planId)}/approve`, {
      method: 'POST',
      token,
      body: JSON.stringify({}),
    });
    return response.data as Approval;
  },

  async startExecution(token: string, planId: string, proof: string): Promise<{ id: string; status: string }> {
    const response = await apiFetch(`/import/lifecycle/plans/${encodeURIComponent(planId)}/execute`, {
      method: 'POST',
      token,
      body: JSON.stringify({ proof }),
    });
    return response.data;
  },

  async executionStatus(token: string, executionId: string): Promise<ExecutionStatus> {
    const response = await apiFetch(`/import/lifecycle/executions/${encodeURIComponent(executionId)}`, {
      method: 'GET',
      token,
    });
    return response.data as ExecutionStatus;
  },

  /**
   * End a source before it becomes a plan.
   *
   * Distinct from `cancel`, which stops a run already committing rows. The
   * server refuses this one while a run is live or has finished, and says which
   * — so its message is shown as it arrives rather than guessed at here.
   */
  /**
   * Ask the server what state this import is really in.
   *
   * Called before any approval or execution control is rendered. Deciding from
   * the plan row alone is what produced an Approve button on an import that had
   * already run, behind a proof that was already spent.
   */
  async planLifecycle(token: string, planId: string): Promise<PlanLifecycle> {
    const response = await apiFetch(`/import/lifecycle/plans/${encodeURIComponent(planId)}/lifecycle`, {
      method: 'GET',
      token,
    });
    return response.data as PlanLifecycle;
  },

  /**
   * The imports this company has started.
   *
   * The SOURCES are server-durable and listed here. The mapping decisions made
   * against them are not: those live in this browser's storage, and the listing
   * deliberately does not pretend otherwise.
   */
  async listSources(token: string, options: { limit?: number; offset?: number } = {}) {
    const query = new URLSearchParams();
    if (options.limit !== undefined) query.set('limit', String(options.limit));
    if (options.offset !== undefined) query.set('offset', String(options.offset));
    const suffix = query.toString() ? `?${query.toString()}` : '';
    const response = await apiFetch(`/import/lifecycle/sources${suffix}`, { method: 'GET', token });
    return response.data as { items: DraftImport[]; limit: number; offset: number; hasMore: boolean };
  },

  /**
   * Withdraw an approval whose one-time proof is no longer held.
   *
   * The server refuses once anything has started, and keeps the withdrawn row
   * as the record that the authorisation existed.
   */
  async withdrawApproval(token: string, planId: string, reason?: string) {
    const response = await apiFetch(`/import/lifecycle/plans/${encodeURIComponent(planId)}/approval/withdraw`, {
      method: 'POST',
      token,
      body: JSON.stringify(reason ? { reason } : {}),
    });
    return response.data as { withdrawn: boolean; alreadyWithdrawn: boolean; notice: string };
  },

  async cancelSource(
    token: string,
    sourceId: string,
    reason?: string,
  ): Promise<{ cancelled: boolean; alreadyCancelled: boolean; notice: string }> {
    const response = await apiFetch(`/import/lifecycle/sources/${encodeURIComponent(sourceId)}/cancel`, {
      method: 'POST',
      token,
      body: JSON.stringify(reason ? { reason } : {}),
    });
    return response.data as { cancelled: boolean; alreadyCancelled: boolean; notice: string };
  },

  async cancel(token: string, executionId: string): Promise<{ requested: boolean; notice: string }> {
    const response = await apiFetch(`/import/lifecycle/executions/${encodeURIComponent(executionId)}/cancel`, {
      method: 'POST',
      token,
      body: JSON.stringify({}),
    });
    return response.data;
  },

  async resume(token: string, executionId: string): Promise<{ id: string; status: string; resumedFromBatch: number }> {
    const response = await apiFetch(`/import/lifecycle/executions/${encodeURIComponent(executionId)}/resume`, {
      method: 'POST',
      token,
      body: JSON.stringify({}),
    });
    return response.data;
  },

  async rowResults(token: string, executionId: string, limit = 200, offset = 0): Promise<RowResult[]> {
    const response = await apiFetch(
      `/import/lifecycle/executions/${encodeURIComponent(executionId)}/rows?limit=${limit}&offset=${offset}`,
      { method: 'GET', token },
    );
    return (response?.data ?? []) as RowResult[];
  },

  async reportSummary(token: string, executionId: string): Promise<ReportSummary> {
    const response = await apiFetch(`/import/lifecycle/executions/${encodeURIComponent(executionId)}/report`, {
      method: 'GET',
      token,
    });
    return response.data as ReportSummary;
  },

  /**
   * Where the downloadable report lives.
   *
   * Returned as a path rather than fetched, because the browser's own
   * navigation handles the download — and the response carries an attachment
   * disposition the fetch API would have to reimplement.
   */
  reportCsvPath(executionId: string): string {
    return `/import/lifecycle/executions/${encodeURIComponent(executionId)}/report.csv`;
  },
};
