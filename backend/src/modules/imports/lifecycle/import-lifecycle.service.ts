import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import {
  ImportSourceStorageService,
  SOURCE_RETENTION_DAYS,
  isSourceExpired,
} from '../storage/import-source-storage.service';
import { ImportApprovalService } from '../plan/import-approval.service';
import { hashPlan, fingerprintSourceShape, canonicalize, type PlanDecisions } from '../plan/plan-hash';
import { IMPORT_PIPELINE_VERSION } from '../shared/import-limits';
import { planHashInputs } from '../plan/plan-hash-inputs';
import { mayApprove, mayExecute, projectPlanLifecycle, statusIsStale } from './plan-lifecycle';
import { TableMapping, buildNormalizedPreview } from '../preview/normalized-preview';
import { RelationshipPlan } from '../relationships/relationship-plan';
import { Issue, canExecute, groupIssues, summarize } from '../issues/issue-taxonomy';
import { RunOutcome, isResumable } from '../execution/cancellation';
import { buildReport, renderReportCsv, ReportRow } from '../execution/import-report';
import { RowOutcome } from '../entities/import-row-result.entity';

/**
 * The import's life, from an uploaded file to a report.
 *
 * Every step is a durable row, because every step is something somebody may be
 * asked about later: which file, what it looked like, what was decided, who
 * approved it, what ran, and what happened to each row. Holding any of it in
 * memory would mean a restarted container loses the answer.
 *
 * The shape is deliberately narrow at each boundary:
 *
 *  - a SOURCE is bytes plus an identity. Registering one records what the
 *    storage layer already verified; it never trusts a client's claim about
 *    size or type.
 *  - an ANALYSIS is what we read from those bytes. It is derived, so it can be
 *    recomputed, and it carries the source hash it was computed from.
 *  - a PLAN is what somebody DECIDED. It is immutable once created: an edit
 *    produces a new plan, because an approval attests to a specific one.
 *  - an APPROVAL is a single-use proof bound to the plan hash, the source hash
 *    and the approver's authority.
 *  - an EXECUTION is a run of an approved plan, and a plan may be executed
 *    once, ever.
 *
 * Tenancy is not a filter applied at the end. Every lookup takes the caller's
 * organization and matches on it, so a row belonging to somebody else is
 * indistinguishable from one that does not exist.
 */

export interface CallerScope {
  organizationId: string;
  userId: string;
  email?: string | null;
  role: string;
  /** Stores the caller may write to. Empty means organization level only. */
  allowedStoreIds: string[];
  /** Set when the caller is bound to one store. */
  storeId?: string | null;
}

export type ImportType = 'PRODUCTS' | 'CATEGORIES' | 'HISTORICAL_STORE_SALES';

/** The four types, in one place, so a fifth cannot be added in only one of them. */
export const IMPORT_TYPES: ImportType[] = ['PRODUCTS', 'CATEGORIES', 'HISTORICAL_STORE_SALES'];

export interface RegisterSourceInput {
  objectKey: string;
  originalFileName: string;
  sizeBytes: number;
  /**
   * What the client believes it uploaded.
   *
   * Optional, and verified against the bytes we actually fetch. A client's
   * claim about what it sent is a cross-check, never the identity — the hash we
   * record is always the one we computed.
   */
  contentHash?: string;
  detectedFormat: string;
}

@Injectable()
export class ImportLifecycleService {
  constructor(
    private readonly em: EntityManager,
    private readonly storage: ImportSourceStorageService,
    private readonly approvals: ImportApprovalService,
  ) {}

  /** A short-lived signed ticket for the browser to upload against. */
  async createUploadTicket(scope: CallerScope, fileName: string, contentType: string, maxBytes: number) {
    return this.storage.createUploadTicket(scope.organizationId, fileName, contentType, maxBytes);
  }

  /**
   * Record an uploaded file as a source.
   *
   * The object key must belong to the caller's organization — it is
   * server-minted and carries the tenant segment, so a key from elsewhere is
   * refused before any read. The content hash is recomputed from the bytes we
   * actually fetch rather than taken from the request: a client's claim about
   * what it uploaded is not evidence.
   */
  async registerSource(scope: CallerScope, input: RegisterSourceInput) {
    // Reads the object, which asserts the key's tenant segment first.
    const bytes = await this.storage.read(input.objectKey, scope.organizationId);
    const contentHash = ImportSourceStorageService.contentHash(bytes);

    if (input.contentHash && input.contentHash !== contentHash) {
      throw new BadRequestException('The uploaded file does not match what was expected. Upload it again.');
    }

    const rows = await this.em.getConnection().execute<{ id: string }[]>(
      `insert into import_sources
         (organization_id, object_key, original_file_name, size_bytes, content_hash,
          detected_format, status, uploaded_by_user_id, uploaded_by_email, parser_version,
          retention_expires_at)
       values (?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, now() + (? || ' days')::interval)
       returning id`,
      [
        scope.organizationId,
        input.objectKey,
        input.originalFileName,
        bytes.length,
        contentHash,
        input.detectedFormat,
        scope.userId,
        scope.email ?? null,
        IMPORT_PIPELINE_VERSION,
        String(SOURCE_RETENTION_DAYS),
      ],
    );

    return { id: rows[0].id, contentHash, sizeBytes: bytes.length };
  }

  /** One source, or nothing — a source elsewhere reads as absent. */
  async getSource(scope: CallerScope, sourceId: string) {
    const rows = await this.em.getConnection().execute<
      {
        id: string;
        object_key: string;
        original_file_name: string;
        content_hash: string;
        status: string;
        detected_format: string;
        created_at: Date;
        retention_expires_at: Date | null;
      }[]
    >(
      `select id, object_key, original_file_name, content_hash, status, detected_format,
              created_at, retention_expires_at
         from import_sources where id = ? and organization_id = ?`,
      [sourceId, scope.organizationId],
    );
    const source = rows[0];
    if (!source) throw new NotFoundException('That file is no longer available.');
    return source;
  }

  /**
   * Whether a source can still be worked with.
   *
   * Retention is enforced on our clock, not the provider's lifecycle schedule,
   * so "expired" is a promise we keep rather than one we hope has been applied.
   */
  async sourceStatus(scope: CallerScope, sourceId: string): Promise<'AVAILABLE' | 'EXPIRED' | 'MISSING' | 'CANCELLED'> {
    try {
      const source = await this.getSource(scope, sourceId);
      // Cancellation is checked BEFORE the retention clock. A file somebody
      // ended is ended whether or not it has also aged out, and offering to
      // carry on with it — which is what happened while this returned
      // AVAILABLE for anything that existed — undoes the decision they made.
      if (source.status === 'CANCELLED') return 'CANCELLED';
      if (isSourceExpired(new Date(source.created_at))) return 'EXPIRED';
      return 'AVAILABLE';
    } catch {
      return 'MISSING';
    }
  }

  /**
   * Start reading a source.
   *
   * One live analysis per source, enforced by a partial unique index rather
   * than by a check-then-insert that two requests could both pass.
   */
  async startAnalysis(scope: CallerScope, sourceId: string) {
    const source = await this.getSource(scope, sourceId);
    if (isSourceExpired(new Date(source.created_at))) {
      throw new BadRequestException(
        `This file was uploaded more than ${SOURCE_RETENTION_DAYS} days ago and is no longer available. Upload it again to continue.`,
      );
    }

    // A file that has ALREADY been read is not read again.
    //
    // The uniqueness index covers only a LIVE analysis, so a second request
    // while one was running was refused — but a request after one COMPLETED
    // inserted another. Every reload of the wizard therefore started a fresh
    // analysis of bytes already analysed, and the operator watched a queue they
    // had just rejoined the back of. Five analyses of one 577-byte file were
    // produced that way before anybody noticed.
    //
    // Returning the finished one is safe because a source is IMMUTABLE: the
    // object is written create-only and `content_hash` is fixed at
    // registration. The hash is compared rather than assumed, so an analysis of
    // different bytes is re-run instead of trusted.
    const finished = await this.em.getConnection().execute<{ id: string }[]>(
      `select id from import_analyses
        where source_id = ? and organization_id = ?
          and status = 'COMPLETED' and source_hash = ?
        order by created_at desc
        limit 1`,
      [sourceId, scope.organizationId, source.content_hash],
    );
    if (finished.length) {
      return { id: finished[0].id, status: 'COMPLETED' as const };
    }

    try {
      const rows = await this.em.getConnection().execute<{ id: string }[]>(
        `insert into import_analyses
           (organization_id, source_id, status, source_hash, analyzer_version, execution_identity, started_at)
         values (?, ?, 'QUEUED', ?, ?, ?, now())
         returning id`,
        [scope.organizationId, sourceId, source.content_hash, IMPORT_PIPELINE_VERSION, `analysis-${randomUUID()}`],
      );
      return { id: rows[0].id, status: 'QUEUED' as const };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // One is already live. Hand back ITS id rather than an error whose only
        // useful response is to ask again: the caller wants an analysis to
        // watch, and there is one to watch.
        const live = await this.em.getConnection().execute<{ id: string; status: string }[]>(
          `select id, status from import_analyses
            where source_id = ? and organization_id = ? and status in ('QUEUED','RUNNING')
            order by created_at desc
            limit 1`,
          [sourceId, scope.organizationId],
        );
        if (live.length) {
          return { id: live[0].id, status: live[0].status as 'QUEUED' | 'RUNNING' };
        }
        throw new ConflictException('This file is already being read. Wait for it to finish.');
      }
      throw error;
    }
  }

  async getAnalysis(scope: CallerScope, analysisId: string) {
    const rows = await this.em.getConnection().execute<
      {
        id: string;
        source_id: string;
        status: string;
        source_hash: string;
        tables: unknown;
        proposals: unknown;
        findings: unknown;
        rows_analyzed: number;
        failure_reason: string | null;
      }[]
    >(
      `select id, source_id, status, source_hash, tables, proposals, findings,
              rows_analyzed, failure_reason
         from import_analyses where id = ? and organization_id = ?`,
      [analysisId, scope.organizationId],
    );
    const analysis = rows[0];
    if (!analysis) throw new NotFoundException('That analysis is no longer available.');
    return analysis;
  }

  /**
   * Record what an analysis found.
   *
   * Split from `startAnalysis` because the reading itself belongs to a job, not
   * to a request: a hundred-thousand-row workbook cannot be parsed inside an
   * HTTP timeout, and the serving container has 512 MiB.
   */
  async completeAnalysis(
    scope: CallerScope,
    analysisId: string,
    result: { tables: unknown; proposals: unknown; findings: Issue[]; rowsAnalyzed: number; cellsAnalyzed: number },
  ) {
    await this.getAnalysis(scope, analysisId);
    await this.em.getConnection().execute(
      `update import_analyses
          set status = 'COMPLETED', tables = ?::jsonb, proposals = ?::jsonb, findings = ?::jsonb,
              rows_analyzed = ?, cells_analyzed = ?, finished_at = now(), updated_at = now(),
              lease_owner = null, lease_expires_at = null
        where id = ? and organization_id = ?`,
      [
        JSON.stringify(result.tables ?? null),
        JSON.stringify(result.proposals ?? null),
        JSON.stringify(result.findings ?? []),
        result.rowsAnalyzed,
        result.cellsAnalyzed,
        analysisId,
        scope.organizationId,
      ],
    );
    return this.getAnalysis(scope, analysisId);
  }

  /**
   * Create a durable plan — the dry run somebody will approve.
   *
   * A plan is IMMUTABLE. Editing a mapping produces a new plan rather than
   * mutating this one, because an approval attests to a specific plan hash and
   * rewriting the plan underneath it would make the attestation describe
   * something that no longer exists.
   *
   * The store scope is checked here as well as at execution: a plan naming a
   * shop the caller cannot reach should never become a durable row.
   */
  /**
   * What this caller may choose from when deciding relationships.
   *
   * Everything here is derived from the caller's OWN organization and the shop
   * the import is scoped to. The panel must not hold a list of locations or
   * shops of its own: a hardcoded id is a cross-tenant bug waiting for a second
   * customer, and a stale one is a plan naming somewhere that no longer exists.
   *
   * Locations are filtered the same way `assertStockDestination` validates
   * them, so the list cannot offer something plan creation would then refuse.
   */
  async relationshipOptions(scope: CallerScope, storeId?: string | null) {
    if (storeId && !scope.allowedStoreIds.includes(storeId)) {
      throw new NotFoundException('That shop is not available to you.');
    }

    const locations = await this.em
      .getConnection()
      .execute<{ id: string; name: string; kind: string; store_id: string | null; is_default: boolean }[]>(
        `select id::text as id, name, kind, store_id::text as store_id, is_default
         from inventory_locations
        where organization_id = ?
          and (store_id is null or store_id = ?)
        order by (store_id is not null) desc, is_default desc, name`,
        [scope.organizationId, storeId ?? null],
      );

    const stores = await this.em.getConnection().execute<{ id: string; name: string }[]>(
      `select id::text as id, name from stores
        where organization_id = ? and archived_at is null and removed_at is null
        order by name`,
      [scope.organizationId],
    );

    // Existing category names, so the panel can say which paths it would CREATE
    // rather than implying every path is new.
    const categories = await this.em.getConnection().execute<{ name: string }[]>(
      // #292: the mapping wizard offers live categories only; a removed one is
      // not a destination an operator can choose.
      `select name from categories where organization_id = ? and removed_at is null order by name`,
      [scope.organizationId],
    );

    return {
      // The shop the import is scoped to, echoed so the panel never has to
      // remember which question it asked.
      storeId: storeId ?? null,
      stockDestinations: locations.map((l) => ({
        id: l.id,
        name: l.name,
        kind: l.kind,
        storeId: l.store_id,
        isDefault: l.is_default,
        /** The one belonging to the scoped shop is the natural proposal. */
        proposed: Boolean(storeId) && l.store_id === storeId,
      })),
      stores: stores.filter((s) => scope.allowedStoreIds.includes(s.id)),
      existingCategoryNames: categories.map((c) => c.name),
    };
  }

  /**
   * A plan may only list products in shops it was built for.
   *
   * The compiler used to DROP a shop outside the import's reach and carry on,
   * which is safe in the sense that nothing was written where it should not
   * be — and unsafe in the sense that nobody was told. An approval that named a
   * shop and quietly did not list anything there is the same silent
   * under-delivery as a missing pivot or a missing category.
   *
   * So it is refused where it can be answered plainly: before a plan exists.
   */
  private assertStoreAssociation(
    scope: CallerScope,
    input: { relationships?: RelationshipPlan; storeId?: string | null },
  ): void {
    for (const storeId of input.relationships?.stores?.storeIds ?? []) {
      if (!scope.allowedStoreIds.includes(storeId)) {
        throw new NotFoundException('That shop is not available to you.');
      }
      if (input.storeId && storeId !== input.storeId) {
        throw new BadRequestException(
          'This import is for one shop but names another. Choose shops within the one this import is for.',
        );
      }
    }
  }

  /**
   * A file that carries stock must name where that stock is held.
   *
   * The destination is never inferred. The organization has a default
   * warehouse and the import may be scoped to a shop, and either would be an
   * easy guess — which is exactly why neither is used. Custody is a decision
   * about somebody's goods, and a wrong guess puts real units in a place
   * nobody chose and nobody is looking at.
   *
   * The rule is deliberately coarse: if a `stock` column is mapped at all, a
   * destination is required, even for a file whose rows all happen to read
   * zero. Sampling cannot prove the absence of a positive quantity in a file
   * larger than the sample, and a plan that is only conditionally executable is
   * the defect this replaces. Zero-stock ROWS still post nothing — that is the
   * compiler's decision, per row, and it is unchanged.
   */
  private async assertStockDestination(
    scope: CallerScope,
    input: {
      importType: ImportType;
      mapping: TableMapping;
      relationships?: RelationshipPlan;
      storeId?: string | null;
    },
  ): Promise<void> {
    if (input.importType !== 'PRODUCTS') return;

    const carriesStock = (input.mapping?.columns ?? []).some((column) => column.field === 'stock');
    if (!carriesStock) return;

    const locationId = input.relationships?.inventory?.defaultLocationId;
    if (!locationId) {
      throw new BadRequestException(
        'This file has a stock column, so it needs a destination. ' +
          'Choose where the stock is held before creating the plan.',
      );
    }

    // The named location must be real, this company's, and reachable from the
    // shop the import is scoped to. Read as ONE query against the tenant's own
    // rows: a location belonging to somebody else is indistinguishable from one
    // that does not exist.
    const rows = await this.em
      .getConnection()
      .execute<{ id: string; name: string; kind: string; store_id: string | null }[]>(
        `select id::text as id, name, kind, store_id::text as store_id
         from inventory_locations
        where id = ? and organization_id = ?`,
        [locationId, scope.organizationId],
      );
    if (!rows.length) {
      throw new NotFoundException('That stock destination is not available to you.');
    }

    const location = rows[0];
    // A store-owned location may only be used by an import scoped to that
    // store. An organization-level warehouse is reachable either way. Nothing
    // reaches ANOTHER shop's custody — that is the cross-shop leak this whole
    // family of checks exists to prevent.
    if (location.store_id && location.store_id !== (input.storeId ?? null)) {
      throw new BadRequestException(
        `"${location.name}" belongs to a different shop. Choose a destination for the shop this import is for.`,
      );
    }
  }

  async createPlan(
    scope: CallerScope,
    input: {
      sourceId: string;
      importType: ImportType;
      mapping: TableMapping;
      relationships?: RelationshipPlan;
      sample: { headers: string[]; rows: string[][]; firstRowNumber: number; sheet?: string };
      columnTypes: string[];
      storeId?: string | null;
      acknowledgedIssueCodes?: string[];
    },
  ) {
    const source = await this.getSource(scope, input.sourceId);

    if (input.storeId && !scope.allowedStoreIds.includes(input.storeId)) {
      // Indistinguishable from a shop that does not exist.
      throw new NotFoundException('That shop is not available to you.');
    }
    if (input.importType === 'HISTORICAL_STORE_SALES' && !input.storeId) {
      throw new BadRequestException('Historical sales belong to one shop. Choose which shop this file describes.');
    }

    // Stock needs somewhere to be, and that is decided HERE — before anybody
    // approves anything.
    //
    // This check used to live in the plan compiler, which runs inside the
    // runner at execution time. So a plan naming no custody location was
    // created, reviewed, approved and consumed, and only then refused row by
    // row. An approval had been spent on an import that could never have run.
    // The condition is knowable the moment a mapping exists, so it is answered
    // the moment a mapping exists.
    await this.assertStockDestination(scope, input);
    this.assertStoreAssociation(scope, input);

    // The SAME preview function the editor calls, so what was reviewed and what
    // is recorded cannot disagree.
    const preview = buildNormalizedPreview(input.sample.rows, input.sample.firstRowNumber, input.mapping, {
      importType: input.importType,
    });

    const acknowledged = new Set(input.acknowledgedIssueCodes ?? []);
    const outstanding = preview.issues.filter(
      (i) => i.severity === 'BLOCKING' || (i.severity === 'WARNING' && !acknowledged.has(i.code)),
    );
    const readiness = canExecute(
      preview.issues.map((i) =>
        i.severity === 'WARNING' && acknowledged.has(i.code) ? { ...i, acknowledged: true } : i,
      ),
    );

    /*
      What is STORED, built once and used for both the hash and the row.

      These were two expressions before — one inlined into `hashPlan`, one
      inlined into the insert — and they had drifted apart: the insert wrote the
      relationships and acknowledgements into `decisions`, and the hash never
      saw them. Deriving them once means the hash cannot attest to something
      other than what the row holds.
    */
    const decisions: PlanDecisions = {
      relationships: (input.relationships ?? {}) as Record<string, unknown>,
      acknowledged: [...acknowledged].sort(),
    };
    const targetAssumptions = {
      sourceShape: fingerprintSourceShape(input.sample.headers, input.columnTypes),
    };
    const salesInventoryMode = input.importType === 'HISTORICAL_STORE_SALES' ? 'HISTORICAL_RECORD_ONLY' : null;

    const planHash = hashPlan(
      planHashInputs({
        organizationId: scope.organizationId,
        storeId: input.storeId ?? null,
        importType: input.importType,
        sourceHash: source.content_hash,
        mapping: input.mapping,
        sample: input.sample,
        decisions,
        targetAssumptions,
      }),
    );

    // Creating the same plan twice is IDEMPOTENT rather than an error. The hash
    // covers the source bytes and every decision, so an identical hash means
    // identical decisions over an identical file — that is one plan, and
    // returning the existing one is what a person re-submitting the same
    // screen expects. `import_plans_org_plan_hash_unique` is what makes it
    // true rather than a check two requests could both pass.
    //
    // That claim was FALSE until the hash inputs above were completed, and the
    // comparison below exists because it was.
    const rows = await this.em.getConnection().execute<{ id: string }[]>(
      `insert into import_plans
         (organization_id, source_id, import_type, plan_hash, source_hash, analyzer_version,
          mapping, decisions, target_assumptions, summary, status, store_id, sales_inventory_mode)
       values (?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?::jsonb, ?::jsonb, 'DRAFT', ?, ?)
       on conflict (organization_id, plan_hash) do nothing
       returning id`,
      [
        scope.organizationId,
        input.sourceId,
        // The stored vocabulary. HISTORICAL_STORE_SALES is the type's name in
        // the product; the column's check constraint carries the same value.
        input.importType,
        planHash,
        source.content_hash,
        IMPORT_PIPELINE_VERSION,
        JSON.stringify(input.mapping),
        JSON.stringify(decisions),
        JSON.stringify(targetAssumptions),
        JSON.stringify({
          issues: groupIssues(preview.issues),
          summary: summarize(preview.issues),
          readiness,
          previewedRows: preview.previewedRows,
          blankRowCount: preview.blankRowCount,
          ignoredColumns: preview.ignoredColumns,
        }),
        input.storeId ?? null,
        salesInventoryMode,
      ],
    );

    if (Array.isArray(rows) && rows.length === 1) {
      return { id: rows[0].id, planHash, readiness, outstanding: outstanding.length, alreadyExisted: false };
    }

    const existing = await this.em
      .getConnection()
      .execute<
        { id: string; mapping: unknown; decisions: unknown }[]
      >(`select id, mapping, decisions from import_plans where organization_id = ? and plan_hash = ?`, [scope.organizationId, planHash]);

    /*
      The plan we are about to hand back must BE the plan that was asked for.

      Reaching here means the hash matched an existing row, and the whole point
      of the hash is that this implies identical decisions. Checking anyway is
      cheap and answers the question the previous defect could not: when the
      hash covered only four of twelve inputs, this path returned a plan with
      DIFFERENT stock custody under the words "These exact decisions were
      already prepared", and nothing anywhere noticed.

      Refusing rather than returning: a plan that does not match the request is
      not a plan the caller can review, and quietly substituting one is exactly
      how an approval comes to describe something its reviewer never saw. If
      this ever fires the hash has a gap again, and it should stop the request
      rather than paper over it.
    */
    const stored = existing[0];
    const sameAs = (a: unknown, b: unknown) => JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
    if (!sameAs(stored.decisions, decisions) || !sameAs(stored.mapping, input.mapping)) {
      throw new ConflictException(
        'This import could not be prepared: an existing plan with the same reference describes different decisions. Nothing has been changed. Please report this.',
      );
    }

    return { id: stored.id, planHash, readiness, outstanding: outstanding.length, alreadyExisted: true };
  }

  async getPlan(scope: CallerScope, planId: string) {
    const rows = await this.em.getConnection().execute<
      {
        id: string;
        source_id: string;
        import_type: string;
        plan_hash: string;
        source_hash: string;
        mapping: unknown;
        decisions: unknown;
        target_assumptions: unknown;
        summary: unknown;
        status: string;
        store_id: string | null;
        version: number;
      }[]
    >(
      `select id, source_id, import_type, plan_hash, source_hash, mapping, decisions,
              target_assumptions, summary, status, store_id, version
         from import_plans where id = ? and organization_id = ?`,
      [planId, scope.organizationId],
    );
    const plan = rows[0];
    if (!plan) throw new NotFoundException('That import plan is no longer available.');
    return plan;
  }

  /**
   * Approve a plan, receiving a single-use proof.
   *
   * The proof is server-issued and bound to the plan hash, the source hash and
   * the approver's authority; only its hash is stored. Everything about what it
   * refuses lives in the approval service, which is where it can be reasoned
   * about in one place.
   */
  async approvePlan(scope: CallerScope, planId: string) {
    const plan = await this.getPlan(scope, planId);
    if (plan.status !== 'DRAFT' && plan.status !== 'VALIDATED') {
      throw new ConflictException('This plan can no longer be approved.');
    }

    const summary = plan.summary as { readiness?: { allowed: boolean; reason?: string } } | null;
    if (summary?.readiness && summary.readiness.allowed === false) {
      throw new BadRequestException(summary.readiness.reason ?? 'This import is not ready to run.');
    }

    const proof = await this.approvals.issue({
      organizationId: scope.organizationId,
      planId: plan.id,
      planVersion: Number(plan.version ?? 1),
      planHash: plan.plan_hash,
      sourceHash: plan.source_hash,
      approver: {
        userId: scope.userId,
        role: scope.role,
        storeId: scope.storeId ?? null,
        email: scope.email ?? '',
      },
    });

    await this.em
      .getConnection()
      .execute(`update import_plans set status = 'APPROVED', updated_at = now() where id = ? and organization_id = ?`, [
        plan.id,
        scope.organizationId,
      ]);

    return proof;
  }

  /**
   * Queue an execution for an approved plan.
   *
   * Two database rules do the work that a check-then-insert could not: a plan
   * may be executed once ever, and only one execution per company may be live.
   * Both surface as sentences rather than as a constraint name.
   */
  async startExecution(scope: CallerScope, planId: string, proof: string) {
    const plan = await this.getPlan(scope, planId);

    // The proof is verified but NOT consumed here: consuming belongs with the
    // pre-execution checks, immediately before the first write.
    const verdict = await this.approvals.verify({
      organizationId: scope.organizationId,
      proof,
      currentPlanHash: plan.plan_hash,
      currentSourceHash: plan.source_hash,
      currentAuthority: { userId: scope.userId, role: scope.role, storeId: scope.storeId ?? null },
    });

    if (!verdict.valid) {
      throw new BadRequestException(verdict.message ?? 'This import needs to be approved again before it can run.');
    }

    try {
      const rows = await this.em.getConnection().execute<{ id: string }[]>(
        `insert into import_executions (organization_id, plan_id, execution_identity, status, started_at)
         values (?, ?, ?, 'QUEUED', now())
         returning id`,
        [scope.organizationId, plan.id, `exec-${randomUUID()}`],
      );
      return { id: rows[0].id, status: 'QUEUED' as const };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const message = String((error as { message?: string }).message ?? '');
        throw new ConflictException(
          message.includes('one_per_plan')
            ? 'This plan has already been run. Build a new import for the rows that still need doing.'
            : 'Another import is already running for this company. Wait for it to finish.',
        );
      }
      throw error;
    }
  }

  /**
   * The authoritative status of a run.
   *
   * Read from the execution row and its CHECKPOINTS, never from logs. A worker
   * whose logs are delayed has still committed its batches, and a status that
   * waited for logs would report a run as stalled while it was finishing.
   */
  async executionStatus(scope: CallerScope, executionId: string) {
    const rows = await this.em.getConnection().execute<
      {
        id: string;
        plan_id: string;
        status: string;
        batches_completed: number;
        batches_total: number;
        rows_created: number;
        rows_updated: number;
        rows_skipped: number;
        rows_failed: number;
        failure_reason: string | null;
        cancel_requested_at: Date | null;
        started_at: Date | null;
        finished_at: Date | null;
        heartbeat_at: Date | null;
      }[]
    >(
      `select id, plan_id, status, batches_completed, batches_total, rows_created, rows_updated,
              rows_skipped, rows_failed, failure_reason, cancel_requested_at, started_at,
              finished_at, heartbeat_at
         from import_executions where id = ? and organization_id = ?`,
      [executionId, scope.organizationId],
    );
    const execution = rows[0];
    if (!execution) throw new NotFoundException('That import run is no longer available.');

    const checkpoints = await this.em
      .getConnection()
      .execute<
        { batch_index: number; first_row: number; last_row: number; committed_at: Date }[]
      >(`select batch_index, first_row, last_row, committed_at from import_checkpoints where execution_id = ? order by batch_index`, [executionId]);

    return {
      ...execution,
      // The checkpoints ARE the progress. A batch with a checkpoint committed,
      // whatever a log says.
      checkpoints,
      resumable: isResumable(execution.status as RunOutcome),
    };
  }

  /**
   * Ask a run to stop at its next safe boundary.
   *
   * Recorded as a request rather than applied: the worker decides where it is
   * safe to stop, and cancelling does not undo what already committed.
   */
  /**
   * Cancel an import BEFORE it becomes a plan.
   *
   * A different thing from `requestCancellation`, which stops an execution
   * already committing rows to a catalogue. This one ends the stage before
   * that — a source, its reading, and the mapping somebody was building on it —
   * and the two must never be confused: one is a decision to abandon work not
   * yet done, the other is an interruption of work in flight.
   *
   * Nothing in the catalogue is touched, and the object is NOT deleted:
   * retention owns that, and deciding against a file is not a reason to destroy
   * evidence ahead of schedule.
   *
   * Idempotent. Cancelling twice is one cancellation, because the second press
   * of a button whose first press succeeded is the same intent.
   */
  /**
   * The imports this company has started, newest first.
   *
   * Metadata only. No object key, no signed URL, no source contents — a
   * listing is read by anyone who may see the import page, and none of those
   * things belong on a screen that merely says which files exist.
   *
   * The lifecycle STAGE is computed here rather than left to the browser,
   * because it is the same reconciliation `planLifecycle` does and two answers
   * to "what state is this in" is how an Approve button appeared on a finished
   * import. A source is only an editable draft while nothing has been approved
   * against it.
   *
   * Paginated, and bounded whether or not a caller asks: an unbounded listing
   * is a table scan that grows with the tenant.
   */
  async listSources(scope: CallerScope, options: { limit?: number; offset?: number } = {}) {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 50);
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0);

    /*
      One row per PLAN, plus one for a source that has none yet.

      It used to be one row per source, with `limit 1` lateral joins picking the
      newest plan and its execution. That silently hid work: a source can carry
      several plans — they are content-addressed, so remapping the same file
      produces a second one — and each plan can have its own run. Two real
      imports of one file would have shown as one, with the older run simply
      absent from the only page that lists it.

      A plan, by contrast, has AT MOST ONE execution: `import_executions` carries
      a unique index on `plan_id`, and resuming updates that row in place rather
      than inserting another. So keying on the plan represents every execution
      exactly once, which keying on the source cannot.

      Still one query. The joins fan out on plan rather than collapsing to it.
    */
    const rows = await this.em.getConnection().execute<
      {
        id: string;
        original_file_name: string;
        status: string;
        created_at: Date;
        updated_at: Date;
        organization_id: string;
        analysis_status: string | null;
        plan_id: string | null;
        plan_status: string | null;
        plan_store_id: string | null;
        import_type: string | null;
        execution_id: string | null;
        execution_status: string | null;
        finished_at: Date | null;
        rows_created: number | null;
        rows_updated: number | null;
        rows_skipped: number | null;
        rows_failed: number | null;
        activity_at: Date;
      }[]
    >(
      `select s.id, s.original_file_name, s.status, s.created_at, s.updated_at, s.organization_id,
              a.status as analysis_status,
              p.id as plan_id, p.status as plan_status, p.store_id as plan_store_id, p.import_type,
              e.id as execution_id, e.status as execution_status, e.finished_at,
              e.rows_created, e.rows_updated, e.rows_skipped, e.rows_failed,
              -- Latest MEANINGFUL activity: when the run ended, else when it
              -- started, else when the plan was built, else the upload. Ordering
              -- by upload time buries a run somebody watched five minutes ago
              -- under a file they uploaded last week.
              coalesce(e.finished_at, e.created_at, p.created_at, s.created_at) as activity_at
         from import_sources s
         left join lateral (
           select status from import_analyses where source_id = s.id order by created_at desc limit 1
         ) a on true
         left join import_plans p on p.source_id = s.id and p.organization_id = s.organization_id
         left join import_executions e on e.plan_id = p.id and e.organization_id = s.organization_id
        where s.organization_id = ?
        order by coalesce(e.finished_at, e.created_at, p.created_at, s.created_at) desc, s.id desc, p.id desc
        limit ? offset ?`,
      [scope.organizationId, limit + 1, offset],
    );

    const page = rows.slice(0, limit);
    return {
      items: page.map((r) => ({
        sourceId: r.id,
        // The name as uploaded, stripped of anything a browser would act on.
        fileName: sanitizeFileName(r.original_file_name),
        importType: r.import_type ?? null,
        organizationId: r.organization_id,
        storeId: r.plan_store_id,
        stage: draftStage(r),
        sourceStatus: r.status,
        analysisStatus: r.analysis_status,
        planStatus: r.plan_status,
        executionStatus: r.execution_status,
        /** True only while the work can still be edited into a new plan. */
        hasUnexecutedDraftPlan: r.plan_status === 'DRAFT' && r.execution_status === null,
        /**
         * The plan to open for review, when there is one to review.
         *
         * The plan to open, whenever this source HAS one.
         *
         * Not filtered by status, and deliberately not by whether a run exists.
         * It used to be withheld unless the plan was unexecuted, which made
         * every finished, failed, partial and cancelled import unreachable: the
         * results moved onto the plan surface and the listing had nothing to
         * link to. `bcdb9687…` completed correctly and could not be opened.
         *
         * A navigation HINT and nothing more. Every route that accepts it
         * re-derives what the caller may do from the lifecycle, and answers 404
         * for another tenant's plan — so widening this grants no authority. The
         * listing decides reachability; the projection decides capability.
         */
        planId: r.plan_id,
        /**
         * The run this plan HAS, and what it did.
         *
         * A plan carries at most one execution, so these describe that one run
         * rather than a latest-of-many. `null` throughout when the plan has not
         * been started, which is a different fact from a run that wrote nothing.
         */
        executionId: r.execution_id,
        finishedAt: r.finished_at,
        rowsCreated: r.rows_created ?? null,
        rowsUpdated: r.rows_updated ?? null,
        rowsSkipped: r.rows_skipped ?? null,
        rowsFailed: r.rows_failed ?? null,
        /** When this import last did something, which is what history sorts on. */
        activityAt: r.activity_at,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      limit,
      offset,
      hasMore: rows.length > limit,
    };
  }

  async cancelSource(scope: CallerScope, sourceId: string, reason?: string | null) {
    const rows = await this.em
      .getConnection()
      .execute<
        { id: string; status: string; cancelled_at: Date | null }[]
      >(`select id, status, cancelled_at from import_sources where id = ? and organization_id = ?`, [sourceId, scope.organizationId]);

    // Tenancy first, and it answers with NOT FOUND rather than FORBIDDEN: that
    // a file exists in a company the caller cannot see is itself a disclosure.
    const source = rows[0];
    if (!source) throw new NotFoundException('That import is no longer available.');

    if (source.status === 'CANCELLED') {
      return { cancelled: true, alreadyCancelled: true, notice: 'This import was already cancelled.' };
    }

    // A run in flight belongs to the OTHER cancel, and saying so points the
    // operator at the path that actually stops it.
    const live = await this.em.getConnection().execute<{ id: string; status: string }[]>(
      `select e.id, e.status from import_executions e
         join import_plans p on p.id = e.plan_id
        where p.source_id = ? and e.organization_id = ? and e.status in ('QUEUED','RUNNING')
        limit 1`,
      [sourceId, scope.organizationId],
    );
    if (live.length > 0) {
      throw new ConflictException(
        'This import is running. Stop the run itself first — cancelling the file will not stop work already in progress.',
      );
    }

    const done = await this.em.getConnection().execute<{ id: string }[]>(
      `select e.id from import_executions e
         join import_plans p on p.id = e.plan_id
        where p.source_id = ? and e.organization_id = ?
          and e.status in ('COMPLETED','PARTIALLY_COMPLETED')
        limit 1`,
      [sourceId, scope.organizationId],
    );
    if (done.length > 0) {
      // Cancelling here would suggest the import can be undone. It cannot:
      // rows are in the catalogue and only a person can decide what to do
      // about them.
      throw new ConflictException('This import has already run. Cancelling it now would not undo anything it changed.');
    }

    await this.em.getConnection().execute(
      `update import_sources
          set status = 'CANCELLED',
              cancelled_at = now(),
              cancelled_by_user_id = ?,
              cancelled_by_email = ?,
              cancelled_reason = ?,
              updated_at = now()
        where id = ? and organization_id = ? and status <> 'CANCELLED'`,
      [scope.userId, scope.email ?? null, reason ?? null, sourceId, scope.organizationId],
    );

    return {
      cancelled: true,
      alreadyCancelled: false,
      notice: 'This import was cancelled. Nothing in your catalogue was changed.',
    };
  }

  /**
   * What state an import is really in, and what may be offered.
   *
   * Reads the plan, its approval and its executions together and projects them
   * with `projectPlanLifecycle`, where the EXECUTION is authoritative. The
   * plan's own status column is consulted last, because nothing advances it
   * after a run and it has been observed disagreeing with reality for days.
   *
   * Read-only. Where the column disagrees it is REPORTED as stale, never
   * repaired: rewriting rows while answering a GET is a mutation nobody asked
   * for, and the backfill it implies is a migration with its own authorization.
   */
  async planLifecycle(scope: CallerScope, planId: string) {
    const plan = await this.getPlan(scope, planId);

    const approvals = await this.em
      .getConnection()
      .execute<{ id: string; expires_at: Date; consumed_at: Date | null; revoked_at: Date | null }[]>(
        `select id, expires_at, consumed_at, revoked_at from import_approvals
        where plan_id = ? and organization_id = ? order by created_at desc limit 1`,
        [planId, scope.organizationId],
      );

    const executions = await this.em
      .getConnection()
      .execute<
        { id: string; status: string; created_at: Date; finished_at: Date | null; cancel_requested_at: Date | null }[]
      >(
        `select id, status, created_at, finished_at, cancel_requested_at from import_executions
        where plan_id = ? and organization_id = ? order by created_at desc`,
        [planId, scope.organizationId],
      );

    const projected = projectPlanLifecycle({
      plan: { status: plan.status },
      approval: approvals[0] ?? null,
      executions,
      now: new Date(),
    });

    const latest = executions[0] ?? null;
    return {
      planId: plan.id,
      planHash: plan.plan_hash,
      sourceId: plan.source_id,
      importType: plan.import_type,
      storeId: plan.store_id,
      state: projected.state,
      authority: projected.authority,
      /** True when the plan's own column disagrees with what actually happened. */
      statusIsStale: statusIsStale({ status: plan.status }, projected.state),
      storedStatus: plan.status,
      mayApprove: mayApprove(projected.state),
      mayExecute: mayExecute(projected.state),
      approval: approvals[0]
        ? {
            id: approvals[0].id,
            state: projected.approval,
            expiresAt: approvals[0].expires_at,
            consumedAt: approvals[0].consumed_at,
          }
        : null,
      execution: latest
        ? {
            id: latest.id,
            status: latest.status,
            startedAt: latest.created_at,
            finishedAt: latest.finished_at,
            cancelRequested: Boolean(latest.cancel_requested_at),
          }
        : null,
    };
  }

  /**
   * Withdraw an approval whose proof can no longer be used.
   *
   * The proof is returned once, to one browser, and only its hash is kept. A
   * refresh loses it irrecoverably — and until now that stranded the plan for
   * good: the approval could not be spent (no proof), could not be cleared (no
   * route), and blocked re-approval, with expiry making it worse rather than
   * better. This is the way out, and it is a decision somebody makes and signs
   * rather than a repair applied behind their back.
   *
   * ATOMIC against execution. The update carries its own preconditions —
   * unconsumed, unrevoked, and no execution for the plan — so the database
   * decides between a withdrawal and a run starting at the same moment. Exactly
   * one wins: a run that has already consumed the approval leaves nothing to
   * revoke, and a withdrawal that lands first makes the proof fail
   * verification.
   *
   * The revoked row is KEPT. It is the record that this authorisation existed
   * and who ended it; deleting it would erase the audit rather than complete it.
   */
  async withdrawApproval(scope: CallerScope, planId: string, reason?: string | null) {
    // Tenancy first, and it answers NOT FOUND: that a plan exists in a company
    // the caller cannot see is itself a disclosure.
    const plan = await this.getPlan(scope, planId);

    // Both writes or neither.
    //
    // The approval carries the authorisation and the plan's column carries the
    // state that authorisation put it in. Revoking one without reverting the
    // other leaves a plan the projection calls PREPARED and `approvePlan`
    // refuses, which is the same trap in a new shape.
    const rows = await this.em.transactional(async (tx) => {
      const revoked = await tx.execute<{ id: string; revoked_at: Date }[]>(
        `update import_approvals a
            set revoked_at = now(),
                revoked_reason = ?
          where a.plan_id = ?
            and a.organization_id = ?
            and a.consumed_at is null
            and a.revoked_at is null
            and not exists (
              select 1 from import_executions e where e.plan_id = a.plan_id
            )
          returning a.id, a.revoked_at`,
        [
          // Who and why, in one string: `import_approvals` has no actor column
          // for revocation, and inventing one is a migration this does not
          // need. The APPROVING actor is already recorded on the row.
          `Withdrawn by ${scope.email ?? scope.userId}${reason ? `: ${reason}` : ''}`,
          planId,
          scope.organizationId,
        ],
      );

      if (revoked.length > 0) {
        // Back to DRAFT, so the column agrees with the projection and
        // `approvePlan` — which insists on DRAFT — will accept it again. Still
        // conditional on there being no execution, so a run starting in this
        // window cannot find its plan reverted underneath it.
        await tx.execute(
          `update import_plans p
              set status = 'DRAFT', updated_at = now()
            where p.id = ? and p.organization_id = ? and p.status = 'APPROVED'
              and not exists (select 1 from import_executions e where e.plan_id = p.id)`,
          [planId, scope.organizationId],
        );
      }
      return revoked;
    });

    if (rows.length === 0) {
      // Nothing live to withdraw. Which of the reasons it was matters to the
      // person, so it is read back rather than guessed at.
      const existing = await this.em.getConnection().execute<{ consumed_at: Date | null; revoked_at: Date | null }[]>(
        `select consumed_at, revoked_at from import_approvals
          where plan_id = ? and organization_id = ? order by created_at desc limit 1`,
        [planId, scope.organizationId],
      );
      const executions = await this.em
        .getConnection()
        .execute<{ n: string }[]>(`select count(*)::text as n from import_executions where plan_id = ?`, [planId]);

      if (Number(executions[0]?.n ?? 0) > 0) {
        throw new ConflictException(
          'This import has already started, so its approval cannot be withdrawn. Check the run instead.',
        );
      }
      if (existing[0]?.consumed_at) {
        throw new ConflictException('That approval has already been used to start an import.');
      }
      if (existing[0]?.revoked_at) {
        return { withdrawn: false, alreadyWithdrawn: true, notice: 'That approval was already withdrawn.' };
      }
      throw new ConflictException('There is no approval on this import to withdraw.');
    }

    return {
      withdrawn: true,
      alreadyWithdrawn: false,
      approvalId: rows[0].id,
      planId: plan.id,
      notice:
        'The approval was withdrawn. Nothing in your catalogue changed, and the plan is unchanged — you can approve it again.',
    };
  }

  async requestCancellation(scope: CallerScope, executionId: string) {
    const execution = await this.executionStatus(scope, executionId);
    if (!['QUEUED', 'RUNNING'].includes(execution.status)) {
      throw new ConflictException('That import is not running, so there is nothing to stop.');
    }

    await this.em.getConnection().execute(
      `update import_executions set cancel_requested_at = coalesce(cancel_requested_at, now()), updated_at = now()
          where id = ? and organization_id = ? and status in ('QUEUED','RUNNING')`,
      [executionId, scope.organizationId],
    );

    return {
      requested: true,
      notice: 'The import will stop at the next safe point. Anything already imported is kept.',
    };
  }

  /**
   * Resume a run that stopped without being asked to.
   *
   * A CANCELLED run is deliberately not resumable: somebody stopped it on
   * purpose, and quietly continuing would be the opposite of what they asked.
   */
  async resumeExecution(scope: CallerScope, executionId: string) {
    const execution = await this.executionStatus(scope, executionId);
    if (!isResumable(execution.status as RunOutcome)) {
      throw new ConflictException(
        execution.status === 'CANCELLED'
          ? 'You stopped this import. Start a new one for the rows that still need doing.'
          : 'That import does not need resuming.',
      );
    }

    await this.em.getConnection().execute(
      `update import_executions set status = 'QUEUED', finished_at = null, failure_reason = null, updated_at = now()
          where id = ? and organization_id = ?`,
      [executionId, scope.organizationId],
    );

    return { id: executionId, status: 'QUEUED' as const, resumedFromBatch: execution.checkpoints.length };
  }

  /** Every row's verdict, paged, because a report can be a hundred thousand rows. */
  async rowResults(scope: CallerScope, executionId: string, limit = 200, offset = 0) {
    await this.executionStatus(scope, executionId);
    const rows = await this.em.getConnection().execute<
      {
        source_table: string;
        source_row: number;
        outcome: string;
        target_type: string | null;
        target_id: string | null;
        match_provenance: string | null;
        reason: string | null;
        effects: unknown;
      }[]
    >(
      `select source_table, source_row, outcome, target_type, target_id, match_provenance, reason, effects
         from import_row_results where execution_id = ?
        order by source_row limit ? offset ?`,
      [executionId, Math.min(limit, 1000), Math.max(offset, 0)],
    );
    // `effects` is nullable and every row written before it existed carries
    // null. It is passed through as-is rather than defaulted to an empty
    // object: a row that recorded nothing must not read as a row that recorded
    // "nothing happened". Callers that predate the field simply ignore it.
    return rows;
  }

  /**
   * The downloadable report.
   *
   * Rendered from the stored row results, and every cell passes through the
   * export-boundary neutralization: the reason column carries text from the
   * customer's own file, so a product name typed as a formula would otherwise
   * execute when the report was opened.
   */
  async report(scope: CallerScope, executionId: string): Promise<{ csv: string; summary: unknown }> {
    await this.executionStatus(scope, executionId);
    const rows = await this.em.getConnection().execute<
      {
        source_table: string;
        source_row: number;
        outcome: string;
        target_type: string | null;
        target_id: string | null;
        match_provenance: string | null;
        reason: string | null;
      }[]
    >(
      `select source_table, source_row, outcome, target_type, target_id, match_provenance, reason
         from import_row_results where execution_id = ? order by source_row`,
      [executionId],
    );

    const reportRows: ReportRow[] = rows.map((row) => ({
      sourceTable: row.source_table,
      sourceRow: Number(row.source_row),
      outcome: row.outcome as RowOutcome,
      targetType: row.target_type,
      targetId: row.target_id,
      matchProvenance: row.match_provenance,
      reason: row.reason,
    }));

    const built = buildReport(reportRows);
    return {
      csv: renderReportCsv(reportRows),
      summary: { headline: built.headline, ...built.summary, repair: built.repair },
    };
  }
}

/** A unique-constraint violation, whatever driver wrapped it. */
function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  const message = String((error as { message?: string })?.message ?? '');
  return code === '23505' || /duplicate key value|unique constraint/i.test(message);
}

/**
 * A file name safe to render.
 *
 * Uploads carry whatever the operating system allowed, and a listing puts that
 * string on a page. Path separators and control characters are removed so a
 * name cannot pretend to be a path or break the line it is shown on.
 */
function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  let cleaned = '';
  for (const ch of base) {
    const code = ch.codePointAt(0) ?? 0;
    cleaned += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return cleaned.trim().slice(0, 200) || 'untitled';
}

/**
 * Which stage of its life an import is in.
 *
 * Named for what a person can DO with it, because that is the question the
 * listing exists to answer. An approved or running import is not an editable
 * draft, and offering to resume one would invite a second mutation over work
 * already in flight.
 */
function draftStage(row: {
  status: string;
  analysis_status: string | null;
  plan_status: string | null;
  execution_status: string | null;
}):
  | 'CANCELLED'
  | 'UPLOADING'
  | 'READING'
  | 'MAPPING_IN_PROGRESS'
  | 'PLAN_REVIEW'
  | 'APPROVED_PENDING'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'RECOVERY' {
  if (row.status === 'CANCELLED') return 'CANCELLED';

  // The execution decides, wherever there is one.
  if (row.execution_status) {
    if (['QUEUED', 'RUNNING'].includes(row.execution_status)) return 'ACTIVE';
    if (row.execution_status === 'COMPLETED') return 'COMPLETED';
    if (row.execution_status === 'CANCELLED') return 'CANCELLED';
    return 'RECOVERY';
  }

  // Approved, but nothing has been started.
  //
  // This used to be folded into ACTIVE, which the listing renders as "Importing
  // — it cannot be edited", with no link. An approval whose one-time proof was
  // lost was therefore unreachable: the tab that approved it was the only route
  // back to the plan, so the approval could be neither spent nor withdrawn. It
  // is its own stage precisely so it can be opened.
  if (row.plan_status === 'APPROVED') return 'APPROVED_PENDING';
  if (row.plan_status === 'DRAFT' || row.plan_status === 'READY') return 'PLAN_REVIEW';
  if (row.analysis_status === 'COMPLETED') return 'MAPPING_IN_PROGRESS';
  if (row.analysis_status) return 'READING';
  return 'UPLOADING';
}
