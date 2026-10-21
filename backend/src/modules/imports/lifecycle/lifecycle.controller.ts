import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { requireOrganizationScope } from '../../auth/tenancy/tenant-assertions';
import { CallerScope, ImportLifecycleService, ImportType } from './import-lifecycle.service';
import {
  CompleteAnalysisDto,
  CreatePlanDto,
  CreateUploadTicketDto,
  RegisterSourceDto,
  RowResultsQueryDto,
  StartExecutionDto,
} from './lifecycle.dto';
import { TableMapping } from '../preview/normalized-preview';
import { RelationshipPlan } from '../relationships/relationship-plan';
import type { Issue } from '../issues/issue-taxonomy';

/**
 * The import lifecycle over HTTP.
 *
 * Authority is the same as the import it leads to (P5-A2 family 4): building
 * and running an import rewrites catalogue data organization-wide, so it
 * belongs to a scoped platform administrator or a company manager. A branch
 * ADMIN is refused, and the refusal says why rather than showing an empty list.
 *
 * Two things this controller never does:
 *
 *  - it never takes an organization from the body. Tenancy comes from the
 *    resolved scope, so a request cannot name somebody else's company;
 *  - it never returns an object key, a bucket name, an endpoint or a
 *    credential. The browser receives a signed URL with a five-minute life and
 *    nothing that outlives it.
 */
const CATALOGUE_IMPORT_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER'] as const;

interface ScopedRequest {
  scope?: {
    organizationId?: string | null;
    role?: string;
    storeId?: string | null;
    allowedStoreIds?: string[];
  };
  user?: { id?: string; email?: string | null };
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('import/lifecycle')
export class ImportLifecycleController {
  constructor(private readonly lifecycle: ImportLifecycleService) {}

  /**
   * The caller, as the service needs them.
   *
   * `requireOrganizationScope` throws when a platform administrator has not
   * entered a company, so every route below is company-scoped by construction
   * rather than by remembering to filter.
   */
  private caller(req: ScopedRequest): CallerScope {
    const organizationId = requireOrganizationScope(req.scope as never);
    return {
      organizationId,
      userId: req.user?.id ?? '',
      email: req.user?.email ?? null,
      role: req.scope?.role ?? '',
      allowedStoreIds: req.scope?.allowedStoreIds ?? [],
      storeId: req.scope?.storeId ?? null,
    };
  }

  // ---- source ------------------------------------------------------------

  /**
   * A signed ticket the browser uploads against.
   *
   * The response carries the URL, the headers to send and the key to echo back.
   * It carries no bucket name, endpoint or credential: the signature is the
   * whole permission, and it expires in five minutes.
   */
  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Post('sources/ticket')
  async createUploadTicket(@Req() req: ScopedRequest, @Body() body: CreateUploadTicketDto) {
    const ticket = await this.lifecycle.createUploadTicket(
      this.caller(req),
      body.fileName,
      body.contentType,
      body.maxBytes,
    );
    return {
      data: {
        objectKey: ticket.objectKey,
        url: ticket.url,
        headers: ticket.headers,
        maxBytes: ticket.maxBytes,
        expiresInSeconds: ticket.expiresInSeconds,
      },
    };
  }

  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Post('sources')
  async registerSource(@Req() req: ScopedRequest, @Body() body: RegisterSourceDto) {
    const registered = await this.lifecycle.registerSource(this.caller(req), body);
    return { data: registered };
  }

  @Roles(...CATALOGUE_IMPORT_ROLES)
  /**
   * The imports this company has started.
   *
   * Declared BEFORE `sources/:id` so that `/sources` is not read as a source
   * whose id is the empty string.
   */
  @Get('sources')
  @Header('Cache-Control', 'no-store')
  async listSources(@Req() req: ScopedRequest, @Query('limit') limit?: string, @Query('offset') offset?: string) {
    const toNumber = (value: string | undefined): number | undefined => {
      if (value === undefined) return undefined;
      const parsed = Number(value);
      // A non-numeric page size is a mistake, not a request for everything.
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    return {
      data: await this.lifecycle.listSources(this.caller(req), {
        limit: toNumber(limit),
        offset: toNumber(offset),
      }),
    };
  }

  @Get('sources/:id')
  @Header('Cache-Control', 'no-store')
  async getSource(@Req() req: ScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const caller = this.caller(req);
    const source = await this.lifecycle.getSource(caller, id);
    const status = await this.lifecycle.sourceStatus(caller, id);
    return {
      data: {
        id: source.id,
        originalFileName: source.original_file_name,
        detectedFormat: source.detected_format,
        contentHash: source.content_hash,
        status,
        createdAt: source.created_at,
        // Deliberately NOT the object key: nothing the browser could turn into
        // a request against storage.
      },
    };
  }

  /**
   * The choices this caller may make, for the relationships step.
   *
   * Tenant-scoped and derived; the panel holds no list of its own.
   */
  @Get('relationship-options')
  @Header('Cache-Control', 'no-store')
  async relationshipOptions(@Req() req: ScopedRequest, @Query('storeId') storeId?: string) {
    return { data: await this.lifecycle.relationshipOptions(this.caller(req), storeId ?? null) };
  }

  // ---- analysis ----------------------------------------------------------

  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Post('sources/:id/analysis')
  async startAnalysis(@Req() req: ScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.lifecycle.startAnalysis(this.caller(req), id) };
  }

  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Get('analyses/:id')
  @Header('Cache-Control', 'no-store')
  async getAnalysis(@Req() req: ScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const analysis = await this.lifecycle.getAnalysis(this.caller(req), id);
    return {
      data: {
        id: analysis.id,
        sourceId: analysis.source_id,
        status: analysis.status,
        tables: analysis.tables,
        proposals: analysis.proposals,
        findings: analysis.findings,
        rowsAnalyzed: Number(analysis.rows_analyzed),
        failureReason: analysis.failure_reason,
      },
    };
  }

  /**
   * Record what an analysis found.
   *
   * Separate from starting it because reading a hundred-thousand-row workbook
   * belongs to a job rather than to a request.
   */
  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Post('analyses/:id/complete')
  async completeAnalysis(
    @Req() req: ScopedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CompleteAnalysisDto,
  ) {
    const analysis = await this.lifecycle.completeAnalysis(this.caller(req), id, {
      tables: body.tables ?? null,
      proposals: body.proposals ?? null,
      findings: (body.findings ?? []) as Issue[],
      rowsAnalyzed: body.rowsAnalyzed,
      cellsAnalyzed: body.cellsAnalyzed,
    });
    return { data: { id: analysis.id, status: analysis.status } };
  }

  // ---- plan --------------------------------------------------------------

  /**
   * Create the durable dry run somebody will approve.
   *
   * The plan records what the same preview function the editor used produced,
   * so what was reviewed and what is stored cannot disagree.
   */
  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Post('plans')
  async createPlan(@Req() req: ScopedRequest, @Body() body: CreatePlanDto) {
    const created = await this.lifecycle.createPlan(this.caller(req), {
      sourceId: body.sourceId,
      importType: body.importType as ImportType,
      mapping: body.mapping as unknown as TableMapping,
      relationships: (body.relationships ?? {}) as RelationshipPlan,
      sample: body.sample,
      columnTypes: body.columnTypes,
      storeId: body.storeId ?? null,
      acknowledgedIssueCodes: body.acknowledgedIssueCodes,
    });
    return { data: created };
  }

  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Get('plans/:id')
  @Header('Cache-Control', 'no-store')
  async getPlan(@Req() req: ScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const plan = await this.lifecycle.getPlan(this.caller(req), id);
    return {
      data: {
        id: plan.id,
        sourceId: plan.source_id,
        importType: plan.import_type,
        planHash: plan.plan_hash,
        status: plan.status,
        storeId: plan.store_id,
        mapping: plan.mapping,
        decisions: plan.decisions,
        summary: plan.summary,
      },
    };
  }

  /**
   * Approve a plan.
   *
   * The proof is returned ONCE and never stored in this form. It is a bearer
   * credential for a catalogue-wide write until it is consumed or expires.
   */
  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Post('plans/:id/approve')
  async approvePlan(@Req() req: ScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const approval = await this.lifecycle.approvePlan(this.caller(req), id);
    return {
      data: {
        approvalId: approval.approvalId,
        proof: approval.proof,
        expiresAt: approval.expiresAt,
        notice: 'Keep this to start the import. It can be used once and expires in 72 hours.',
      },
    };
  }

  // ---- execution ---------------------------------------------------------

  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Post('plans/:id/execute')
  async startExecution(
    @Req() req: ScopedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: StartExecutionDto,
  ) {
    return { data: await this.lifecycle.startExecution(this.caller(req), id, body.proof) };
  }

  /**
   * The authoritative status of a run.
   *
   * Read from the execution row and its checkpoints, never from logs: a worker
   * whose logs are delayed has still committed its batches, and a status that
   * waited for logs would report a finishing run as stalled.
   *
   * `no-store` is not decoration. Every read on this controller describes state
   * that a job changes underneath the reader, and these are the routes a client
   * POLLS. Without it a client — or any proxy between — may answer a poll from
   * its own cache, and the wizard sits watching a spinner over an import that
   * finished minutes ago. That was not hypothetical: it is exactly what the
   * integrated journey caught, with the database saying COMPLETED and the
   * screen still saying QUEUED.
   */
  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Get('executions/:id')
  @Header('Cache-Control', 'no-store')
  async executionStatus(@Req() req: ScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const execution = await this.lifecycle.executionStatus(this.caller(req), id);
    return {
      data: {
        id: execution.id,
        planId: execution.plan_id,
        status: execution.status,
        batchesCompleted: Number(execution.batches_completed),
        batchesTotal: Number(execution.batches_total),
        rows: {
          created: Number(execution.rows_created),
          updated: Number(execution.rows_updated),
          skipped: Number(execution.rows_skipped),
          failed: Number(execution.rows_failed),
        },
        cancelRequested: execution.cancel_requested_at !== null,
        resumable: execution.resumable,
        failureReason: execution.failure_reason,
        startedAt: execution.started_at,
        finishedAt: execution.finished_at,
        checkpoints: execution.checkpoints.map((c) => ({
          batchIndex: Number(c.batch_index),
          firstRow: Number(c.first_row),
          lastRow: Number(c.last_row),
          committedAt: c.committed_at,
        })),
      },
    };
  }

  @Roles(...CATALOGUE_IMPORT_ROLES)
  /**
   * Cancel an import before it becomes a plan.
   *
   * Deliberately NOT `executions/:id/cancel`. That one interrupts work already
   * committing rows; this one ends a file, its reading and the mapping built on
   * it, and refuses when a run is live or has already finished — pointing the
   * operator at the path that actually applies.
   */
  @Post('sources/:id/cancel')
  @Header('Cache-Control', 'no-store')
  async cancelSource(
    @Req() req: ScopedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { reason?: string } = {},
  ) {
    return { data: await this.lifecycle.cancelSource(this.caller(req), id, body?.reason ?? null) };
  }

  /**
   * What state an import is really in.
   *
   * Separate from `GET plans/:id`, which reports the row. This reports the
   * lifecycle — plan, approval and execution reconciled — because the row's own
   * status column has been observed disagreeing with a completed run for days,
   * and the wizard offered an Approve button on the strength of it.
   */
  @Get('plans/:id/lifecycle')
  @Header('Cache-Control', 'no-store')
  async planLifecycle(@Req() req: ScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.lifecycle.planLifecycle(this.caller(req), id) };
  }

  /**
   * Withdraw an approval whose one-time proof is no longer held.
   *
   * The proof is returned once and never stored, so a refresh loses it and the
   * plan cannot be run. This clears the authorisation — auditably, and only
   * while nothing has been started — so the same unchanged plan can be
   * approved again.
   */
  @Post('plans/:id/approval/withdraw')
  @Header('Cache-Control', 'no-store')
  async withdrawApproval(
    @Req() req: ScopedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { reason?: string } = {},
  ) {
    return { data: await this.lifecycle.withdrawApproval(this.caller(req), id, body?.reason ?? null) };
  }

  @Post('executions/:id/cancel')
  async cancel(@Req() req: ScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.lifecycle.requestCancellation(this.caller(req), id) };
  }

  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Post('executions/:id/resume')
  async resume(@Req() req: ScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return { data: await this.lifecycle.resumeExecution(this.caller(req), id) };
  }

  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Get('executions/:id/rows')
  @Header('Cache-Control', 'no-store')
  async rowResults(
    @Req() req: ScopedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: RowResultsQueryDto,
  ) {
    const rows = await this.lifecycle.rowResults(this.caller(req), id, query.limit ?? 200, query.offset ?? 0);
    return {
      data: rows.map((row) => ({
        sourceTable: row.source_table,
        sourceRow: Number(row.source_row),
        outcome: row.outcome,
        targetType: row.target_type,
        targetId: row.target_id,
        matchedBy: row.match_provenance,
        reason: row.reason,
        // Additive and nullable. Rows written before effects existed carry
        // null, and it is passed through rather than defaulted: a row that
        // recorded nothing must not read as one that recorded "nothing
        // happened". Clients written before this field ignore it.
        effects: row.effects ?? null,
      })),
    };
  }

  /**
   * The report, as a file.
   *
   * Streamed as CSV with a download disposition. Every cell has passed through
   * the export-boundary neutralization, because the reason column carries text
   * from the customer's own file.
   */
  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Get('executions/:id/report.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async reportCsv(
    @Req() req: ScopedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { csv } = await this.lifecycle.report(this.caller(req), id);
    res.setHeader('Content-Disposition', `attachment; filename="import-${id}.csv"`);
    return csv;
  }

  @Roles(...CATALOGUE_IMPORT_ROLES)
  @Get('executions/:id/report')
  @Header('Cache-Control', 'no-store')
  async reportSummary(@Req() req: ScopedRequest, @Param('id', ParseUUIDPipe) id: string) {
    const { summary } = await this.lifecycle.report(this.caller(req), id);
    return { data: summary };
  }
}
