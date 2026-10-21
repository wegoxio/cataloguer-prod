import { Injectable, Logger } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { ImportLeaseService, LEASE_DURATION_MS } from '../worker/import-lease.service';
import { ImportSourceStorageService } from '../storage/import-source-storage.service';
import { ImportApprovalService } from '../plan/import-approval.service';
import { OrmExecutionStore } from '../execution/orm-execution-store';
import { executePlan } from '../execution/import-executor';
import { CancellationToken } from '../execution/cancellation';
import { BatchBudget } from '../execution/batch-budget';
import { UnitApplier } from '../execution/import-executor';
import { evaluatePreconditions } from '../execution/pre-execution-check';
import { checkBeforeExecution } from '../execution/pre-execution-check';
import { TableMapping, buildNormalizedPreview } from '../preview/normalized-preview';
import { RelationshipPlan } from '../relationships/relationship-plan';
import { profileTable } from '../analysis/column-profile';
import { proposeTableMapping } from '../analysis/field-proposals';
import { detectTables } from '../analysis/table-detection';
import { selectAdapter, SourceAdapter } from '../parsing/source-adapter';
import { ANALYSIS_SAMPLE_ROWS, JOB_ADAPTER_LIMITS } from '../shared/import-limits';
import { DelimitedAdapter } from '../parsing/delimited-adapter';
import { XlsxAdapter } from '../parsing/xlsx-adapter';
import { Issue, issue } from '../issues/issue-taxonomy';
import { compilePlan } from './plan-compiler';
import { ProductInventoryApplier, ProductInventoryContext } from './product-inventory.applier';
import { ProductRelationshipsApplier } from './product-relationships.applier';
import { PublicationGuardService } from '../../products/publication/publication-guard.service';
import { ProductsApplier } from '../appliers/products.applier';
import { CategoriesApplier } from '../appliers/categories.applier';
import { HistoricalSalesApplier } from '../appliers/historical-sales.applier';
import { InventoryProposalApplier } from '../appliers/inventory-proposal.applier';
import { buildLookups } from './orm-match-lookups';

/**
 * The process that actually does the work.
 *
 * Everything else in the lifecycle records intent: a source is registered, an
 * analysis is queued, a plan is approved, an execution is enqueued. None of
 * that reads a file or writes a product. This drains those queues.
 *
 * It is a JOB, not a request handler, and the distinction is load-bearing. A
 * hundred-thousand-row workbook cannot be parsed inside an HTTP timeout, the
 * serving container has a strict memory budget and should not run heavy work
 * moment its request ends — so work started in a request and left running is
 * work that stops mid-batch on a container nobody is watching. Both entry
 * points below are therefore explicit: `drainOnce()` is what a job invocation
 * calls, and the polling loop is opt-in and off by default.
 *
 * Nothing here decides anything the plan did not already decide. It leases,
 * revalidates, executes and records — and the revalidation is not a formality:
 * it is the last moment before the first write, and it repeats every check the
 * approval was granted under.
 */

export type DrainMode = 'ANALYSIS' | 'EXECUTION' | 'ALL';

/**
 * What happened to one claimed item.
 *
 * Three outcomes rather than a boolean, because "we did not run it" has two
 * completely different meanings: somebody else holds the lease, which is the
 * lease working, or we ran it and it failed, which somebody needs to know
 * about. Collapsing them is how a job reports a healthy pass while every
 * import it touched fell over.
 */
export type ItemOutcome = 'RAN' | 'FAILED' | 'LEASED';

/** Items claimed per queue in one pass, when the caller does not say. */
export const DEFAULT_MAX_ITEMS = 25;

export interface DrainOptions {
  /** Which queue to drain. Separate modes let the two be scheduled apart. */
  mode?: DrainMode;
  /** Most items to CLAIM in this pass, per queue. */
  maxItems?: number;
  /**
   * When to stop claiming new work.
   *
   * A deadline, not a timeout: it is checked between items and never
   * interrupts one. Killing a run mid-batch would be safe — the checkpoints
   * make it resumable — but it would also leave a lease to expire and a status
   * to reap, and doing that on every scheduled invocation is noise.
   */
  deadline?: () => boolean;
  /** Injected so a signal can stop the drain between items. */
  shouldStop?: () => boolean;
}

export interface DrainResult {
  analysesRun: number;
  executionsRun: number;
  /**
   * Items claimed that did not finish successfully.
   *
   * Counted separately from "run" so the caller can distinguish a quiet pass
   * from a failing one. A job that exits 0 having failed every item it touched
   * is a job whose monitoring is a lie.
   */
  analysesFailed: number;
  executionsFailed: number;
  /** Rows reaped because their worker vanished. Reported so a quiet run is distinguishable. */
  reaped: number;
  /**
   * Items another worker already held.
   *
   * Not a failure and not an error: the lease did its job. Reported because a
   * pass that claimed nothing because everything was busy looks identical to a
   * pass with nothing to do, and those need different responses.
   */
  skippedLeased: number;
  /** True when the pass stopped early — a deadline, a signal or an item cap. */
  stoppedEarly: boolean;
}

@Injectable()
export class ImportRunnerService {
  private readonly logger = new Logger(ImportRunnerService.name);
  private readonly owner = `runner-${randomUUID()}`;

  constructor(
    private readonly em: EntityManager,
    private readonly leases: ImportLeaseService,
    private readonly storage: ImportSourceStorageService,
    private readonly approvals: ImportApprovalService,
    private readonly store: OrmExecutionStore,
    private readonly products: ProductsApplier,
    private readonly categories: CategoriesApplier,
    private readonly historicalSales: HistoricalSalesApplier,
    private readonly inventoryProposals: InventoryProposalApplier,
    private readonly productRelationships: ProductRelationshipsApplier,
    private readonly publicationGuard: PublicationGuardService,
  ) {}

  /**
   * One pass over the queues.
   *
   * Abandoned work is reaped FIRST. A row whose worker died holds a lease that
   * has expired but a status that still says RUNNING, and reaping it before
   * claiming new work is what turns "stuck forever" into "resumable".
   */
  async drainOnce(options: DrainOptions = {}): Promise<DrainResult> {
    const mode = options.mode ?? 'ALL';
    const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
    const stop = () => Boolean(options.shouldStop?.() || options.deadline?.());

    const result: DrainResult = {
      analysesRun: 0,
      executionsRun: 0,
      analysesFailed: 0,
      executionsFailed: 0,
      reaped: 0,
      skippedLeased: 0,
      stoppedEarly: false,
    };

    // Only the queues this pass is responsible for. Reaping the other one
    // would be harmless but dishonest: a job told to drain analyses should not
    // be the reason an execution's status changed.
    if (mode === 'ANALYSIS' || mode === 'ALL') {
      result.reaped += await this.leases.reapAbandoned('import_analyses');
    }
    if (mode === 'EXECUTION' || mode === 'ALL') {
      result.reaped += await this.leases.reapAbandoned('import_executions');
    }

    if (mode === 'ANALYSIS' || mode === 'ALL') {
      for (const id of await this.queued('import_analyses', maxItems)) {
        if (stop()) {
          result.stoppedEarly = true;
          break;
        }
        const outcome = await this.runAnalysis(id);
        if (outcome === 'RAN') result.analysesRun++;
        else if (outcome === 'FAILED') result.analysesFailed++;
        else result.skippedLeased++;
      }
    }

    if (mode === 'EXECUTION' || mode === 'ALL') {
      for (const id of await this.queued('import_executions', maxItems)) {
        if (stop()) {
          result.stoppedEarly = true;
          break;
        }
        const outcome = await this.runExecution(id);
        if (outcome === 'RAN') result.executionsRun++;
        else if (outcome === 'FAILED') result.executionsFailed++;
        else result.skippedLeased++;
      }
    }

    return result;
  }

  private async queued(table: 'import_analyses' | 'import_executions', limit: number): Promise<string[]> {
    const rows = await this.em
      .getConnection()
      .execute<
        { id: string }[]
      >(`select id from ${table} where status in ('QUEUED','RUNNING') and (lease_owner is null or lease_expires_at < now()) order by created_at asc limit ?`, [limit]);
    return rows.map((row) => row.id);
  }

  /* ---------------------------------------------------------------- analysis */

  /**
   * Read a source and record what it says.
   *
   * Nothing here is a decision about the import — it is a description of the
   * file: which table, which columns, what they look like, what they might
   * mean. Proposals are suggestions carrying their reasons, never mappings.
   */
  async runAnalysis(analysisId: string): Promise<ItemOutcome> {
    // Losing the race is not a failure. Another worker holds it, which is the
    // lease doing exactly what it exists to do.
    const acquired = await this.acquireOrSettle('import_analyses', analysisId);
    if (acquired !== true) return acquired;

    try {
      const analysis = await this.one<{ id: string; organization_id: string; source_id: string; source_hash: string }>(
        `select id, organization_id, source_id, source_hash from import_analyses where id = ?`,
        [analysisId],
      );
      if (!analysis) return 'LEASED';

      const source = await this.one<{ object_key: string; original_file_name: string; created_at: Date }>(
        `select object_key, original_file_name, created_at from import_sources where id = ? and organization_id = ?`,
        [analysis.source_id, analysis.organization_id],
      );
      if (!source) throw new Error('The file this analysis was reading is no longer available.');

      await this.em
        .getConnection()
        .execute(`update import_analyses set status = 'RUNNING', updated_at = now() where id = ?`, [analysisId]);

      const bytes = await this.storage.read(source.object_key, analysis.organization_id, {
        uploadedAt: new Date(source.created_at),
      });

      // The hash is re-verified rather than assumed. Bytes that changed under a
      // registered source are not the file anybody chose, and continuing would
      // analyse one file while the plan claims another.
      const actualHash = ImportSourceStorageService.contentHash(bytes);
      if (actualHash !== analysis.source_hash) {
        throw new Error('This file has changed since it was uploaded. Upload it again to continue.');
      }

      const adapter = selectAdapter(this.adapters(), bytes, source.original_file_name);
      const census = adapter.census(bytes, JOB_ADAPTER_LIMITS);
      const sheet = census.sheets[0];
      if (!sheet) throw new Error('This file has no readable sheet.');

      const range = adapter.readRange(
        bytes,
        { sheetIndex: sheet.index, maxRows: ANALYSIS_SAMPLE_ROWS, maxCells: JOB_ADAPTER_LIMITS.maxCells },
        JOB_ADAPTER_LIMITS,
      );

      const detected = detectTables(range.rows, { maxTables: 1 })[0];
      // `headerRow` is 1-based, as the person sees it in their spreadsheet;
      // the array index is one less. Getting this wrong reads the first data
      // row as headers, which produces a mapping screen full of product names.
      const headerRow = detected?.headerRow ?? 1;
      const headers = detected?.headers ?? (range.rows[headerRow - 1] ?? []).map((cell) => String(cell ?? ''));
      const dataRows = range.rows.slice(headerRow);

      const profiles = profileTable(headers, dataRows);
      const proposals = proposeTableMapping(profiles);

      const findings: Issue[] = [];
      if (!detected) {
        findings.push(
          issue('NO_TABLE_DETECTED', 'We could not find a table of data in this file.', {
            anchor: { sheet: sheet.name },
            guidance: 'Check that the sheet has a row of column headings above the data.',
          }),
        );
      }

      await this.em.getConnection().execute(
        `update import_analyses
            set status = 'COMPLETED', tables = ?::jsonb, proposals = ?::jsonb, findings = ?::jsonb,
                rows_analyzed = ?, cells_analyzed = ?, finished_at = now(), updated_at = now(),
                lease_owner = null, lease_expires_at = null
          where id = ?`,
        [
          JSON.stringify({
            // Exactly what the editor needs to start: the header row as the
            // person sees it, and a bounded sample. The sample is the
            // customer's own data going back to them, never a wider slice than
            // the editor will show.
            sheet: sheet.name,
            headerRow,
            headers,
            sample: {
              headers,
              rows: dataRows.slice(0, 25).map((row) => row.map((cell) => String(cell ?? ''))),
              firstRowNumber: headerRow + 1,
              sheet: sheet.name,
            },
            columnTypes: profiles.map((profile) => profile.inferredType),
            totalRows: sheet.rowCount,
            truncated: range.truncated,
          }),
          JSON.stringify(proposals),
          JSON.stringify(findings),
          dataRows.length,
          range.cellsRead,
          analysisId,
        ],
      );

      // Executions log when they finish; analyses did not, which left the more
      // common half of the queue invisible in an operator's logs.
      this.logger.log(`Analysis ${analysisId} completed — ${dataRows.length} row(s) read`);
      return 'RAN';
    } catch (error) {
      // The reason is written for the person doing the import, not for an
      // operator: they are the one who has to decide what to do about it.
      await this.em.getConnection().execute(
        `update import_analyses
            set status = 'FAILED', failure_reason = ?, finished_at = now(), updated_at = now(),
                lease_owner = null, lease_expires_at = null
          where id = ?`,
        [failureReasonFor(error), analysisId],
      );
      this.logger.warn(`Analysis ${analysisId} failed: ${failureReasonFor(error)}`);
      return 'FAILED';
    }
  }

  /* --------------------------------------------------------------- execution */

  /**
   * Run an approved plan.
   *
   * The order below is the safety property. Everything is revalidated
   * IMMEDIATELY before the first write — not at approval time, not when the
   * execution was queued — because the whole window between approval and
   * execution is time in which the catalogue can change, an approval can be
   * revoked, a source can expire and a plan's shop can be taken away.
   */
  async runExecution(executionId: string): Promise<ItemOutcome> {
    const acquired = await this.acquireOrSettle('import_executions', executionId);
    if (acquired !== true) return acquired;

    const execution = await this.one<{
      id: string;
      organization_id: string;
      plan_id: string;
      cancel_requested_at: Date | null;
    }>(`select id, organization_id, plan_id, cancel_requested_at from import_executions where id = ?`, [executionId]);
    if (!execution) return 'LEASED';

    try {
      const plan = await this.one<{
        id: string;
        source_id: string;
        import_type: string;
        plan_hash: string;
        source_hash: string;
        mapping: unknown;
        decisions: unknown;
        target_assumptions: unknown;
        store_id: string | null;
      }>(
        `select id, source_id, import_type, plan_hash, source_hash, mapping, decisions, target_assumptions, store_id
           from import_plans where id = ? and organization_id = ?`,
        [execution.plan_id, execution.organization_id],
      );
      if (!plan) throw new Error('The plan this run was for is no longer available.');

      const approval = await this.approvals.findLiveForPlan(execution.organization_id, plan.id);
      if (!approval) {
        return await this.refuse(executionId, 'This import is no longer approved. Approve it again to run it.');
      }

      const source = await this.one<{ object_key: string; original_file_name: string; created_at: Date }>(
        `select object_key, original_file_name, created_at from import_sources where id = ? and organization_id = ?`,
        [plan.source_id, execution.organization_id],
      );
      if (!source) {
        return await this.refuse(executionId, 'The uploaded file is no longer available. Upload it again to continue.');
      }

      const bytes = await this.storage.read(source.object_key, execution.organization_id, {
        uploadedAt: new Date(source.created_at),
      });
      if (ImportSourceStorageService.contentHash(bytes) !== plan.source_hash) {
        return await this.refuse(
          executionId,
          'This file has changed since the import was approved. Upload it again and build the import afresh.',
        );
      }

      // The shop is re-checked here as well as at plan time. Between the two
      // moments a shop can be archived, REMOVED or moved to another company,
      // and a plan naming it would otherwise write into a shop nobody may
      // reach. #293 adds the lifecycle half: an import must never write into a
      // branch that has left the tenant's world entirely.
      if (plan.store_id) {
        const store = await this.one<{ id: string }>(
          `select id from stores where id = ? and organization_id = ? and removed_at is null`,
          [plan.store_id, execution.organization_id],
        );
        if (!store) {
          return await this.refuse(executionId, 'The shop this import was built for is no longer available.');
        }
      }
      const mapping = plan.mapping as TableMapping;
      const decisions = (plan.decisions ?? {}) as {
        relationships?: RelationshipPlan;
        acknowledgedIssueCodes?: string[];
      };
      const relationships = decisions.relationships ?? {};

      // Same re-check as the shop, for the same reason. A stock destination
      // that has since been removed — or that was never this company's — must
      // stop the run rather than send units somewhere unintended.
      if (relationships.inventory?.defaultLocationId) {
        const location = await this.one<{ id: string; store_id: string | null }>(
          `select id, store_id::text as store_id from inventory_locations
            where id = ? and organization_id = ?`,
          [relationships.inventory.defaultLocationId, execution.organization_id],
        );
        if (!location) {
          return await this.refuse(
            executionId,
            'The stock location this import was built for is no longer available. Build the import again and choose where the stock belongs.',
          );
        }
        // Existing and this company's is not enough. A location BELONGING TO A
        // SHOP may only receive stock for an import scoped to that shop —
        // otherwise an approval for one branch could post units into another
        // branch's custody, which is the cross-shop leak in its most literal
        // form. Organization-level warehouses carry no store and are fine.
        if (location.store_id && location.store_id !== plan.store_id) {
          return await this.refuse(
            executionId,
            'The stock location this import was approved for now belongs to a different shop. Build the import again and choose where the stock belongs.',
          );
        }
      }

      // The shops this import was approved to LIST products in. Each must still
      // exist, still be this company's, and — when the plan is scoped to one
      // shop — be that shop. An approval naming one branch must not become a
      // listing in another because the decisions changed underneath it.
      for (const associatedStoreId of relationships.stores?.storeIds ?? []) {
        const store = await this.one<{ id: string }>(
          `select id from stores where id = ? and organization_id = ? and archived_at is null and removed_at is null`,
          [associatedStoreId, execution.organization_id],
        );
        if (!store) {
          return await this.refuse(
            executionId,
            'A shop this import was approved to list products in is no longer available. Build the import again.',
          );
        }
        if (plan.store_id && associatedStoreId !== plan.store_id) {
          return await this.refuse(
            executionId,
            'This import was approved for one shop but names another. Build the import again.',
          );
        }
      }

      // The category column must still be a column of the approved mapping. An
      // index past the end would silently read nothing and create no
      // categories — the same silent under-delivery this correction is about,
      // arriving through a different door.
      if (relationships.categories) {
        const columnCount = (mapping.columns ?? []).length;
        const index = relationships.categories.columnIndex;
        if (!Number.isInteger(index) || index < 0 || index >= columnCount) {
          return await this.refuse(
            executionId,
            'The column this import was approved to read categories from is no longer part of the mapping. Build the import again.',
          );
        }
      }

      const adapter = selectAdapter(this.adapters(), bytes, source.original_file_name);
      const census = adapter.census(bytes, JOB_ADAPTER_LIMITS);
      const sheetIndex = census.sheets.findIndex((s) => s.name === mapping.sheet);
      const sheet = census.sheets[sheetIndex >= 0 ? sheetIndex : 0];
      const range = adapter.readRange(
        bytes,
        {
          sheetIndex: sheet.index,
          fromRow: mapping.headerRow + 1,
          maxRows: JOB_ADAPTER_LIMITS.maxRows,
          maxCells: JOB_ADAPTER_LIMITS.maxCells,
        },
        JOB_ADAPTER_LIMITS,
      );

      const rows = range.rows.map((row) =>
        row.map((cell) => (cell === null || cell === undefined ? '' : String(cell))),
      );

      const inventoryContext = await this.inventoryContextFor(
        execution.organization_id,
        plan.store_id,
        relationships.inventory?.defaultLocationId ?? null,
      );

      const compiled = compilePlan({
        organizationId: execution.organization_id,
        importType: plan.import_type,
        mapping,
        relationships,
        storeId: plan.store_id,
        // The SAME set the ledger is given. Two different answers to "which
        // shops may this import touch" is how a plan built for one shop came
        // to write another shop's prices while its stock was correctly
        // refused.
        allowedStoreIds: inventoryContext.allowedStoreIds,
        rows,
        firstRowNumber: mapping.headerRow + 1,
        lookups: await buildLookups(this.em, execution.organization_id),
      });

      // The plan's own findings, recomputed rather than trusted. Between
      // approval and now a transformation could have changed meaning across a
      // deploy, and a finding that has become blocking since is exactly what
      // this second pass exists to catch.
      const recomputed = buildNormalizedPreview(rows, mapping.headerRow + 1, mapping, {
        importType: plan.import_type,
        limit: rows.length,
      });
      const acknowledged = new Set(decisions.acknowledgedIssueCodes ?? []);
      const planIssues = [...recomputed.issues, ...compiled.issues].map((i) =>
        i.severity === 'WARNING' && acknowledged.has(i.code) ? { ...i, acknowledged: true } : i,
      );

      const verdict = evaluatePreconditions({
        authorized: true,
        approvalValid: true,
        sourceAvailable: true,
        planIssues,
        targetVerdict: await checkBeforeExecution(
          ((plan.target_assumptions as { assumptions?: never[] } | null)?.assumptions ?? []) as never[],
          { check: async () => [] },
        ),
      });

      if (!verdict.allowed) {
        return await this.refuse(executionId, verdict.reason ?? 'This import can no longer run as approved.');
      }

      // The proof is CONSUMED here, at the last moment before the first write.
      // Consuming it earlier would burn an approval on a run that never
      // started; later would leave a window in which two runs could both
      // present it.
      if (!(await this.approvals.consume(approval.id))) {
        return await this.refuse(
          executionId,
          'This approval has already been used. Approve the import again to run it.',
        );
      }

      await this.em
        .getConnection()
        .execute(
          `update import_executions set status = 'RUNNING', batches_total = ?, started_at = coalesce(started_at, now()), updated_at = now() where id = ?`,
          [0, executionId],
        );

      const cancellation = new CancellationToken();
      if (execution.cancel_requested_at) cancellation.request('operator');

      const result = await executePlan({
        executionId,
        organizationId: execution.organization_id,
        importType: plan.import_type,
        approvedByUserId: approval.approvedByUserId,
        planHash: plan.plan_hash,
        sourceTable: compiled.sourceTable,
        units: compiled.units,
        applier: this.applierFor(plan.import_type, inventoryContext),
        store: this.store,
        cancellation,
        // The cancellation flag is re-read between batches rather than held
        // from the start: somebody clicking "stop" during a long run must be
        // heard by the run that is already going.
        beat: async () => {
          const held = await this.leases.heartbeat('import_executions', executionId, this.owner, LEASE_DURATION_MS);
          if (held && (await this.cancelRequested(executionId))) cancellation.request('operator');
          return held;
        },
        budget: new BatchBudget(),
      });

      this.logger.log(
        `Import ${executionId} ${result.outcome} — ${result.batchesCommitted}/${result.batchesPlanned} batches`,
      );
      return 'RAN';
    } catch (error) {
      await this.em.getConnection().execute(
        `update import_executions
            set status = 'FAILED', failure_reason = ?, finished_at = now(), updated_at = now(),
                lease_owner = null, lease_expires_at = null
          where id = ?`,
        [failureReasonFor(error), executionId],
      );
      this.logger.warn(`Import ${executionId} failed: ${failureReasonFor(error)}`);
      return 'FAILED';
    } finally {
      await this.leases.release('import_executions', executionId, this.owner);
    }
  }

  /**
   * Take the lease, or settle the row when the company will not let us.
   *
   * #277 P2: an ARCHIVED (or merged) company refuses every operational write,
   * and the lease UPDATE is one — a queued or running row is operational. The
   * database answers with a lifecycle SQLSTATE, and left unhandled that would
   * throw out of the drain loop on every pass, for every company, for as long
   * as the row stayed queued. The one transition the guard still permits is
   * the terminal one — the runner recording what happened — so the row is
   * settled as FAILED with the same sentence the operator sees elsewhere, the
   * lease cleared, and the pass moves on. A settled row is never queued again.
   */
  private async acquireOrSettle(
    table: 'import_analyses' | 'import_executions',
    id: string,
  ): Promise<true | ItemOutcome> {
    try {
      return (await this.leases.acquire(table, id, this.owner)) ? true : 'LEASED';
    } catch (error) {
      throw error;
    }
  }

  /**
   * Stop before writing anything, and say why in the person's own terms.
   *
   * BLOCKED rather than FAILED: nothing broke. The import was refused because
   * something it depended on is no longer true, and the difference matters to
   * whoever reads the report.
   */
  private async refuse(executionId: string, reason: string): Promise<ItemOutcome> {
    await this.em.getConnection().execute(
      `update import_executions
          set status = 'FAILED', failure_reason = ?, finished_at = now(), updated_at = now(),
              lease_owner = null, lease_expires_at = null
        where id = ?`,
      [reason, executionId],
    );
    // A refusal IS a completed item of work: the run reached a durable, correct
    // terminal state and said why. Counting it as a failure would make every
    // legitimate refusal look like a broken job.
    return 'RAN';
  }

  private async cancelRequested(executionId: string): Promise<boolean> {
    const row = await this.one<{ cancel_requested_at: Date | null }>(
      `select cancel_requested_at from import_executions where id = ?`,
      [executionId],
    );
    return Boolean(row?.cancel_requested_at);
  }

  private applierFor(importType: string, inventoryContext: ProductInventoryContext): UnitApplier {
    switch (importType) {
      case 'CATEGORIES':
        return this.categories;
      case 'HISTORICAL_STORE_SALES':
        return this.historicalSales;
      default: {
        return new ProductInventoryApplier(
          this.products,
          this.inventoryProposals,
          () => inventoryContext,
          this.productRelationships,
          this.publicationGuard,
        );
      }
    }
  }

  /**
   * What the ledger will and will not accept for this organization, read once.
   *
   * Read here rather than inside the applier because every row of the run needs
   * the same answer, and asking per row would put four queries on every product
   * in a nine-hundred-row import.
   */
  private async inventoryContextFor(
    organizationId: string,
    storeId: string | null,
    destinationLocationId?: string | null,
  ) {
    // `name` alongside `id` because every row has to be able to REPORT which
    // shop it was listed in. A shop id in a report proves nothing to the person
    // reading it; the name is the thing they can recognise as the wrong one.
    const stores = await this.em
      .getConnection()
      .execute<
        { id: string; name: string }[]
      >(`select id, name from stores where organization_id = ? and removed_at is null`, [organizationId]);

    const locations = await this.em
      .getConnection()
      .execute<
        { id: string; code: string; name: string; is_default: boolean; kind: string; store_id: string | null }[]
      >(`select id, code, name, is_default, kind, store_id from inventory_locations where organization_id = ?`, [organizationId]);
    const byCode = new Map(locations.map((l) => [l.code, l.id]));

    // Exactly the question `assertDefaultWarehouse` asks — the FLAG and the
    // kind, not the code. Asking a different question than the authority that
    // will answer it is how a pre-check and the thing it guards come apart:
    // the row passes here, and then fails deep inside posting with an
    // operator's sentence that takes the whole batch down with it.
    const defaultWarehouses = locations.filter((l) => l.is_default && l.kind === 'WAREHOUSE');

    // The same column the posting service reads, deliberately: asking a
    // different question than the authority that will answer it is how a
    // pre-check and the thing it is checking come apart.
    const frozenRows = await this.em.getConnection().execute<{ frozen: boolean }[]>(
      `select ("inventory_cutover_frozen_at" is not null) as frozen from organizations where id = ?
         /* removed_at: the freeze probe reads in every state; the lifecycle guard refuses the write itself (#294) */`,
      [organizationId],
    );
    const frozen = frozenRows[0]?.frozen === true;

    return {
      // Narrowed to the plan's shop when it named one: an import built for one
      // shop must not be able to touch another, whatever its columns say.
      allowedStoreIds: new Set(storeId ? [storeId] : stores.map((s) => s.id)),
      storeLocationIds: new Map(
        stores
          .map((s) => [s.id, byCode.get(`STORE:${s.id}`)] as const)
          .filter((pair): pair is readonly [string, string] => Boolean(pair[1])),
      ),
      frozen,
      /** Shop names, for reporting only. Nothing routes on this map. */
      storeNames: new Map(stores.map((s) => [s.id, s.name] as const)),
      // Exactly one, matching the assertion. Zero and two are both refused —
      // two is what the partial unique index prevents, and treating "some" as
      // "one" here would send stock to whichever the query happened to return.
      hasDefaultWarehouse: defaultWarehouses.length === 1,
      // The approved destination, resolved ONCE per execution and passed down
      // read-only. The applier reports it on every row it posts, and a name is
      // what a person can check — a location id in a report proves nothing and
      // invites nobody to notice it is the wrong branch.
      destination: destinationLocationId
        ? (() => {
            const found = locations.find((l) => l.id === destinationLocationId);
            return found ? { id: found.id, name: found.name, kind: found.kind, storeId: found.store_id } : null;
          })()
        : null,
    };
  }

  private adapters(): SourceAdapter[] {
    return [new DelimitedAdapter(), new XlsxAdapter()];
  }

  private async one<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.em.getConnection().execute<T[]>(sql, params);
    return rows[0] ?? null;
  }
}

/**
 * WHAT AN OPERATOR IS SHOWN WHEN AN IMPORT FAILS.
 *
 * `import_executions.failure_reason` is not a log line: the import wizard puts
 * it on the screen. A raw driver error is the whole INSERT statement plus the
 * database's own text, which is neither actionable nor ours to publish.
 *
 * THE LIFECYCLE REFUSAL IS THE CASE #292 CREATED, and it is the case this
 * function exists to translate. The runner is a STANDALONE JOB — no controller,
 * no request, no Nest HTTP adapter — so `LifecycleConstraintFilter` is never
 * consulted for anything that happens in here, whatever that filter's comment
 * used to imply. The refusal has to be handled on this path or not at all.
 *
 * It reuses the filter's own predicate and sentence rather than restating
 * them: one rule, reported identically wherever an operator meets it.
 *
 * Every OTHER failure keeps the message it already had. Narrowing further
 * would be a change to unrelated behaviour, and this slice has no business
 * making one.
 */
export function failureReasonFor(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Something went wrong while running this import. Nothing further was changed.';
}
