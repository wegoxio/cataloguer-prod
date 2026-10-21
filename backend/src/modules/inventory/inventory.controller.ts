import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { TenantScope, isOrganizationAdministrator, scopeAllowsStore } from '../auth/tenancy/tenant-scope';
import { requireOrganizationScope } from '../auth/tenancy/tenant-assertions';
import { ForbiddenException } from '@nestjs/common';
import { InventoryCommandService } from './ledger/inventory-command.service';
import { InventoryReconciliationService } from './ledger/inventory-reconciliation.service';
import { InventoryStockService } from './ledger/inventory-stock.service';
import { InventoryTransferService } from './transfers/inventory-transfer.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { Action, EntityType } from '../audit-log/entities/audit-log.entity';
import {
  CreateTransferDto,
  DistributeFamilyStockDto,
  ReassignStockDto,
  ReclassifyDto,
  RecountDto,
  TransferQuantitiesDto,
} from './dto/inventory-commands.dto';

/**
 * Phase 8 — the operational inventory surface.
 *
 * The Phase 5 ledger deliberately shipped with NO controller: it was written by
 * the sales, receipt and cutover flows, and the administration UX was left to
 * this phase. Everything below is therefore a thin, explicit wrapper over
 * services that already exist, already post through the classified mechanism,
 * and already carry the invariants — no new posting path is introduced here.
 *
 * AUTHORITY (ADR 014, ADR 013 §20, Phase 8 decision D1). It is resolved
 * server-side from the TenantScope on every route; the panel hiding a control
 * is presentation, never enforcement:
 *
 *   SUPER_ADMIN (scoped to an organization) . every command below
 *   ORGANIZATION_MANAGER ................... every command, inside its own org
 *   ADMIN .................................. reads for its own branch, and the
 *                                            RECOUNT of that branch — nothing
 *                                            else: no adjustment, no
 *                                            reclassification, no reassignment,
 *                                            no family distribution, no transfer
 *   EDITOR / VIEWER ........................ no inventory mutation at all
 *
 * The narrow commands enforce the last mile themselves: `assertBranchOperator`
 * refuses a branch role any location but its own store's, and
 * `assertOrganizationOperator` refuses a branch role outright. An unscoped
 * platform actor has no organization and is refused by `requireOrganizationScope`.
 */
const INVENTORY_READ_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN'] as const;
const INVENTORY_COMMAND_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN'] as const;
const ORGANIZATION_COMMAND_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER'] as const;

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...INVENTORY_READ_ROLES)
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly em: EntityManager,
    private readonly stock: InventoryStockService,
    private readonly commands: InventoryCommandService,
    private readonly transfers: InventoryTransferService,
    private readonly reconciliation: InventoryReconciliationService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private actorOf(req: any): { id: string; email?: string } {
    return { id: req.user?.id, email: req.user?.email };
  }

  /**
   * A material command must be deliberate AND replayable-safe. The header is
   * required for the delta commands (reclassify, reassign, distribute), because
   * those APPLY a change rather than converge on a target: without a stable key
   * a double-submit would adjust twice. The posting mechanism settles a
   * repeated key as a replay and a changed payload under one as a conflict.
   */
  private requireIdempotencyKey(value: string | undefined): string {
    const key = (value ?? '').trim();
    if (key.length < 8 || key.length > 200) {
      throw new BadRequestException('This command requires an Idempotency-Key header (8-200 characters)');
    }
    return key;
  }

  /** Transfers are an organization act (D1): a branch role never issues one. */
  private assertOrganizationCommand(scope: TenantScope | undefined): string {
    const organizationId = requireOrganizationScope(scope);
    if (!isOrganizationAdministrator(scope)) {
      throw new ForbiddenException('Only an organization manager may issue this inventory command');
    }
    return organizationId;
  }

  /**
   * Operator decisions are audit history (ADR 013 §19, #171/#203). The ledger
   * remains the record of record; this row records that a PERSON decided, with
   * the organization and branch the decision touched.
   */
  private async recordDecision(
    req: any,
    action: Action,
    entityId: string,
    changes: Record<string, unknown>,
    description: string,
    storeId: string | null = null,
  ): Promise<void> {
    const scope: TenantScope | undefined = req.scope;
    await this.auditLogService.recordAuditEntry(
      req.user?.id,
      req.user?.email,
      EntityType.PRODUCT,
      entityId,
      action,
      changes,
      description,
      { organizationId: scope?.organizationId ?? null, storeId },
    );
  }

  // ─────────────────────────── reads ───────────────────────────

  /**
   * What a product's stock actually is, told in the terms an operator needs:
   * what the company owns, what each branch holds, what remains in the
   * warehouse, and what can be sold right now.
   *
   * `sellable` is DERIVED and never edited (ADR 013 decision 15): it excludes
   * reserved, transfer-committed, in-transit and non-sellable units, which is
   * why it can be lower than what the shelf shows.
   */
  @Roles(...INVENTORY_READ_ROLES)
  @Get('products/:productId')
  async productStock(@Req() req: any, @Param('productId') productId: string) {
    const scope: TenantScope | undefined = req.scope;
    const organizationId = requireOrganizationScope(scope);

    const stores: { id: string; name: string }[] = await this.em.execute(
      `select id, name from stores where organization_id = ? and archived_at is null and removed_at is null order by name`,
      [organizationId],
    );
    // A branch role sees its own branch and nothing else; the company total
    // still answers, because it is the number its own allocation is part of.
    const visible = isOrganizationAdministrator(scope)
      ? stores
      : stores.filter((store) => scopeAllowsStore(scope, store.id) && store.id === scope?.storeId);

    const perStore = await Promise.all(
      visible.map(async (store) => ({
        storeId: store.id,
        storeName: store.name,
        held: await this.reconciliation.storeHeldQuantity(organizationId, store.id, productId),
      })),
    );

    const organizationTotal = await this.reconciliation.organizationPhysicalTotal(organizationId, productId);
    const sellable = await this.reconciliation.sellableQuantity(organizationId, productId);
    const warehouseId = await this.stock.defaultWarehouseId(this.em, organizationId).catch(() => null);
    const warehouseRemainder = warehouseId
      ? await this.stock.locationAvailable(this.em, organizationId, warehouseId, productId)
      : 0;

    const [buckets]: { reserved: number; committed: number; inTransit: number; nonSellable: number }[] =
      await this.em.execute(
        `select
           coalesce(sum(quantity) filter (where operational_state = 'RESERVED'), 0)::int as reserved,
           coalesce(sum(quantity) filter (where operational_state = 'TRANSFER_COMMITTED'), 0)::int as committed,
           coalesce(sum(quantity) filter (where operational_state = 'IN_TRANSIT'), 0)::int as "inTransit",
           coalesce(sum(quantity) filter (where operational_state = 'NON_SELLABLE'
             or physical_condition = 'DAMAGED'), 0)::int as "nonSellable"
           from inventory_balances where organization_id = ? and product_id = ?::uuid`,
        [organizationId, productId],
      );

    return {
      data: {
        productId,
        organizationTotal,
        sellable,
        warehouseRemainder,
        perStore,
        reserved: buckets?.reserved ?? 0,
        transferCommitted: buckets?.committed ?? 0,
        inTransit: buckets?.inTransit ?? 0,
        nonSellable: buckets?.nonSellable ?? 0,
      },
    };
  }

  /** The locations stock can sit in: the warehouses and the branch shelves. */
  @Roles(...INVENTORY_READ_ROLES)
  @Get('locations')
  async locations(@Req() req: any) {
    const scope: TenantScope | undefined = req.scope;
    const organizationId = requireOrganizationScope(scope);
    const rows: { id: string; kind: string; name: string; store_id: string | null; is_default: boolean }[] =
      await this.em.execute(
        `select id, kind, name, store_id, is_default from inventory_locations
          where organization_id = ? order by kind, name`,
        [organizationId],
      );
    const visible = isOrganizationAdministrator(scope)
      ? rows
      : rows.filter((row) => row.kind === 'STORE' && row.store_id === scope?.storeId);
    return {
      data: visible.map((row) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        storeId: row.store_id,
        isDefault: row.is_default,
      })),
    };
  }

  /**
   * The invariants, checked live. Findings are WARNINGS for an operator, not
   * an error state: they name a disagreement between projections so a person
   * can investigate before it becomes a wrong number on a website.
   */
  @Roles(...ORGANIZATION_COMMAND_ROLES)
  @Get('reconciliation')
  async reconcile(@Req() req: any) {
    const organizationId = this.assertOrganizationCommand(req.scope);
    const findings = await this.reconciliation.verifyAll(organizationId);
    return { data: { organizationId, findings, healthy: findings.length === 0 } };
  }

  /** The movements behind a product's current numbers, newest first. */
  @Roles(...INVENTORY_READ_ROLES)
  @Get('products/:productId/history')
  async history(@Req() req: any, @Param('productId') productId: string, @Query('limit') limit?: string) {
    const scope: TenantScope | undefined = req.scope;
    const organizationId = requireOrganizationScope(scope);
    const take = Math.min(200, Math.max(1, parseInt(limit ?? '50', 10) || 50));
    const rows = await this.em.execute(
      `select t.id, t.type, t.posted_at as "postedAt", t.idempotency_key as "idempotencyKey",
              t.actor_email as "actorEmail", t.actor_kind as "actorKind",
              e.quantity_delta as "quantityDelta", e.operational_state as "operationalState",
              e.physical_condition as "physicalCondition", l.name as "locationName", l.store_id as "storeId"
         from inventory_entries e
         join inventory_transactions t on t.id = e.transaction_id
         left join inventory_locations l on l.id = e.location_id
        where e.organization_id = ? and e.product_id = ?::uuid
        order by t.posted_at desc, t.id desc
        limit ?`,
      [organizationId, productId, take],
    );
    // A branch role reads only the movements that touched its own shelf.
    const visible = isOrganizationAdministrator(scope)
      ? rows
      : (rows as any[]).filter((row) => row.storeId === scope?.storeId);
    return { data: visible };
  }

  // ────────────────────────── commands ─────────────────────────

  /**
   * "I counted the shelf and it holds N."
   *
   * A TARGET, not a delta, which is what makes it the one command a branch
   * administrator may issue for its own branch (ADR 013 §20): repeating it
   * converges instead of accumulating, so a double submit changes nothing.
   */
  @Roles(...INVENTORY_COMMAND_ROLES)
  @Post('recount')
  async recount(@Req() req: any, @Body() dto: RecountDto) {
    const result = await this.commands.recount({
      scope: req.scope,
      actor: this.actorOf(req),
      productId: dto.productId,
      locationId: dto.locationId,
      countedQuantity: dto.countedQuantity,
      reason: dto.reason,
    });
    return { data: result };
  }

  /** "These units are damaged / these are sellable again." */
  @Roles(...ORGANIZATION_COMMAND_ROLES)
  @Post('reclassify')
  async reclassify(@Req() req: any, @Body() dto: ReclassifyDto, @Headers('idempotency-key') idempotencyKey?: string) {
    // The controller states the boundary itself as well as the service:
    // three independent layers (route @Roles, this assertion, the
    // service's own) so no single omission can open the command.
    this.assertOrganizationCommand(req.scope);
    const key = this.requireIdempotencyKey(idempotencyKey);
    await this.commands.reclassifySellability({
      scope: req.scope,
      actor: this.actorOf(req),
      productId: dto.productId,
      locationId: dto.locationId,
      quantity: dto.quantity,
      from: dto.from,
      to: dto.to,
      reason: dto.reason,
      idempotencyKey: `reclassify:client:${key}`,
    });
    return { data: { applied: true } };
  }

  /** "This stock was filed under the wrong product." */
  @Roles(...ORGANIZATION_COMMAND_ROLES)
  @Post('reassign')
  async reassign(@Req() req: any, @Body() dto: ReassignStockDto, @Headers('idempotency-key') idempotencyKey?: string) {
    // The controller states the boundary itself as well as the service:
    // three independent layers (route @Roles, this assertion, the
    // service's own) so no single omission can open the command.
    this.assertOrganizationCommand(req.scope);
    const key = this.requireIdempotencyKey(idempotencyKey);
    await this.commands.reassignStock({
      scope: req.scope,
      actor: this.actorOf(req),
      sourceProductId: dto.sourceProductId,
      destinationProductId: dto.destinationProductId,
      locationId: dto.locationId,
      quantity: dto.quantity,
      reason: dto.reason,
      idempotencyKey: `reassign:client:${key}`,
    });
    return { data: { applied: true } };
  }

  /** "Split the family card's stock across its versions." */
  @Roles(...ORGANIZATION_COMMAND_ROLES)
  @Post('distribute')
  async distribute(
    @Req() req: any,
    @Body() dto: DistributeFamilyStockDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    // The controller states the boundary itself as well as the service:
    // three independent layers (route @Roles, this assertion, the
    // service's own) so no single omission can open the command.
    this.assertOrganizationCommand(req.scope);
    const key = this.requireIdempotencyKey(idempotencyKey);
    await this.commands.distributeFamilyStock({
      scope: req.scope,
      actor: this.actorOf(req),
      rootProductId: dto.rootProductId,
      locationId: dto.locationId,
      allocations: dto.allocations,
      reason: dto.reason,
      idempotencyKey: `distribute:client:${key}`,
    });
    return { data: { applied: true } };
  }

  // ───────────────────────── transfers ─────────────────────────

  /**
   * Moving stock between the warehouse and a branch, or between branches.
   *
   * The lifecycle is a state machine — DRAFT → COMMITTED → IN_TRANSIT →
   * RECEIVED — and each step refuses to run twice, which is what gives the
   * legs their idempotency: dispatching an already-dispatched transfer is a
   * refusal, not a second movement.
   */
  @Roles(...ORGANIZATION_COMMAND_ROLES)
  @Get('transfers')
  async listTransfers(@Req() req: any, @Query('status') status?: string) {
    const organizationId = this.assertOrganizationCommand(req.scope);
    const rows = await this.em.execute(
      `select t.id, t.status, t.reference, t.created_at as "createdAt",
              s.name as "sourceName", d.name as "destinationName"
         from inventory_transfers t
         join inventory_locations s on s.id = t.source_location_id
         join inventory_locations d on d.id = t.destination_location_id
        where t.organization_id = ?${status ? ' and t.status = ?' : ''}
        order by t.created_at desc limit 100`,
      status ? [organizationId, status] : [organizationId],
    );
    return { data: rows };
  }

  @Roles(...ORGANIZATION_COMMAND_ROLES)
  @Post('transfers')
  async createTransfer(@Req() req: any, @Body() dto: CreateTransferDto) {
    const organizationId = this.assertOrganizationCommand(req.scope);
    const transferId = await this.em.transactional(async (tem) =>
      this.transfers.createDraft(tem as EntityManager, {
        organizationId,
        sourceLocationId: dto.sourceLocationId,
        destinationLocationId: dto.destinationLocationId,
        lines: dto.lines,
        reference: dto.reference ?? null,
        actorUserId: req.user?.id ?? null,
      }),
    );
    await this.recordDecision(
      req,
      Action.CREATE,
      transferId,
      { transfer: { source: dto.sourceLocationId, destination: dto.destinationLocationId, lines: dto.lines.length } },
      `Created stock transfer with ${dto.lines.length} line(s)`,
    );
    return { data: { id: transferId, status: 'DRAFT' } };
  }

  @Roles(...ORGANIZATION_COMMAND_ROLES)
  @Post('transfers/:id/commit')
  async commitTransfer(@Req() req: any, @Param('id') id: string) {
    return this.runTransferStep(req, id, 'commit', 'Committed stock transfer');
  }

  @Roles(...ORGANIZATION_COMMAND_ROLES)
  @Post('transfers/:id/dispatch')
  async dispatchTransfer(@Req() req: any, @Param('id') id: string, @Body() dto: TransferQuantitiesDto) {
    return this.runTransferStep(req, id, 'dispatch', 'Dispatched stock transfer', dto.quantities);
  }

  @Roles(...ORGANIZATION_COMMAND_ROLES)
  @Post('transfers/:id/receive')
  async receiveTransfer(@Req() req: any, @Param('id') id: string, @Body() dto: TransferQuantitiesDto) {
    return this.runTransferStep(req, id, 'receive', 'Received stock transfer', dto.quantities);
  }

  /**
   * Turning travelling goods around. A transfer that has left cannot be
   * cancelled — the units are physically on the road — so the service refuses
   * `cancel` there and says to return instead. `start-return` reverses the
   * travelling units (or the named partial quantities); `complete-return`
   * lands them back at the source shelf.
   */
  @Roles(...ORGANIZATION_COMMAND_ROLES)
  @Post('transfers/:id/start-return')
  async startTransferReturn(@Req() req: any, @Param('id') id: string, @Body() dto: TransferQuantitiesDto) {
    return this.runTransferStep(req, id, 'start-return', 'Started stock transfer return', dto.quantities);
  }

  @Roles(...ORGANIZATION_COMMAND_ROLES)
  @Post('transfers/:id/complete-return')
  async completeTransferReturn(@Req() req: any, @Param('id') id: string) {
    return this.runTransferStep(req, id, 'complete-return', 'Completed stock transfer return');
  }

  @Roles(...ORGANIZATION_COMMAND_ROLES)
  @Post('transfers/:id/cancel')
  async cancelTransfer(@Req() req: any, @Param('id') id: string) {
    return this.runTransferStep(req, id, 'cancel', 'Cancelled stock transfer');
  }

  private async runTransferStep(
    req: any,
    transferId: string,
    step: 'commit' | 'dispatch' | 'receive' | 'start-return' | 'complete-return' | 'cancel',
    description: string,
    quantities?: Record<string, number>,
  ) {
    const organizationId = this.assertOrganizationCommand(req.scope);
    const principal = { kind: 'USER' as const, userId: req.user?.id, email: req.user?.email ?? null };
    await this.em.transactional(async (tem) => {
      const manager = tem as EntityManager;
      if (step === 'commit') return this.transfers.commit(manager, { organizationId, transferId, principal });
      if (step === 'dispatch')
        return this.transfers.dispatch(manager, { organizationId, transferId, principal, quantities });
      if (step === 'receive')
        return this.transfers.receive(manager, { organizationId, transferId, principal, quantities });
      if (step === 'start-return')
        return this.transfers.startReturn(manager, { organizationId, transferId, principal, quantities });
      if (step === 'complete-return')
        return this.transfers.completeReturn(manager, { organizationId, transferId, principal });
      return this.transfers.cancel(manager, { organizationId, transferId, principal });
    });
    await this.recordDecision(req, Action.UPDATE, transferId, { transfer: { step } }, description);
    return { data: { id: transferId, step, applied: true } };
  }
}
