import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/core';
import { InventoryLocation } from '../entities/inventory-location.entity';
import { InventoryPostingService } from './inventory-posting.service';
import { InventoryStockService } from './inventory-stock.service';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { Action, EntityType } from '../../audit-log/entities/audit-log.entity';
import { TenantScope, isOrganizationAdministrator } from '../../auth/tenancy/tenant-scope';
import { requireOrganizationScope } from '../../auth/tenancy/tenant-assertions';
import { InventoryCommand, InventoryPrincipal, PhysicalCondition, storeLocationCode } from './inventory.types';

/**
 * P5-B8 — the operator's inventory commands, and who may issue them.
 *
 * AUTHORITY FOLLOWS ADR 014, not convenience:
 *
 *   - ORGANIZATION_MANAGER has full operational authority INSIDE ITS OWN
 *     organization: adjustments anywhere, reclassification, reassignment,
 *     distribution, location administration.
 *   - ADMIN is a branch role. It may RECOUNT its own branch and nothing else —
 *     not a sibling's branch, not the warehouse, not a reclassification.
 *   - Platform lifecycle (opening epoch, cutover, destructive cleanup) is
 *     unscoped SUPER_ADMIN only, and none of it lives here.
 *
 * THE AUDIT CONTRACT (the reconciliation this boundary owes).
 *
 * `inventory_transactions` is the canonical operational trail: it is written in
 * the same transaction as its entries and cannot outlive a rolled-back posting.
 * But it answers "what moved", not "who decided". So:
 *
 *   - an OPERATOR-INITIATED command — the ones in this service — also writes an
 *     `AuditLogService` entry carrying the affected organization and branch
 *     (#171/#203), because a person made a decision and the audit history is
 *     where a person's decisions are read;
 *   - a WORKFLOW-DRIVEN movement — a checkout drawing stock, a receipt posting
 *     units, a transfer leg — does NOT. Those are consequences of an act that
 *     is already audited elsewhere (the order, the receipt, the transfer), and
 *     one audit row per unit movement would bury the decisions in noise.
 *
 * The AuditLog write is deliberately AFTER the ledger work and outside its
 * guarantee: `AuditLogService` fails open by design. Claiming otherwise would
 * be false, so the ledger — not the audit row — remains the record of record.
 */
@Injectable()
export class InventoryCommandService {
  constructor(
    @InjectRepository(InventoryLocation)
    private readonly locationRepository: EntityRepository<InventoryLocation>,
    private readonly posting: InventoryPostingService,
    private readonly stock: InventoryStockService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private get em(): EntityManager {
    return this.locationRepository.getEntityManager() as EntityManager;
  }

  /** Full operational authority inside one's own organization (ADR 014). */
  private assertOrganizationOperator(scope: TenantScope | undefined): string {
    const organizationId = requireOrganizationScope(scope);
    if (!isOrganizationAdministrator(scope)) {
      throw new ForbiddenException('Only an organization manager may issue this inventory command');
    }
    return organizationId;
  }

  /**
   * A branch role may act on ITS OWN branch and nowhere else. The narrowing is
   * the authority: a request cannot name a sibling, because the branch is never
   * taken from the request.
   */
  private async assertBranchOperator(scope: TenantScope | undefined, locationId: string): Promise<string> {
    const organizationId = requireOrganizationScope(scope);
    if (isOrganizationAdministrator(scope)) return organizationId;
    const rows: { store_id: string | null; kind: string }[] = await this.em.execute(
      `select store_id, kind from inventory_locations where id = ?::uuid and organization_id = ?`,
      [locationId, organizationId],
    );
    if (!rows[0]) throw new NotFoundException('Location not found');
    const narrowedTo = scope?.storeId;
    if (rows[0].kind !== 'STORE' || !narrowedTo || rows[0].store_id !== narrowedTo) {
      throw new ForbiddenException('A branch role may only recount its own branch');
    }
    return organizationId;
  }

  private principal(actor: { id: string; email?: string }): InventoryPrincipal {
    return { kind: 'USER', userId: actor.id, email: actor.email ?? null };
  }

  private async audit(
    actor: { id: string; email?: string },
    action: Action,
    entityId: string,
    changes: Record<string, unknown> | null,
    message: string,
    context: { organizationId: string | null; storeId: string | null },
  ): Promise<void> {
    await this.auditLogService.recordAuditEntry(
      actor.id,
      actor.email ?? null,
      EntityType.PRODUCT,
      entityId,
      action,
      changes,
      message,
      context,
    );
  }

  /**
   * A recount: "this cell actually holds N". Expressed as the difference, so
   * the ledger records units arriving or disappearing rather than a figure
   * being overwritten.
   */
  async recount(params: {
    scope: TenantScope | undefined;
    actor: { id: string; email?: string };
    productId: string;
    locationId: string;
    countedQuantity: number;
    reason: string;
  }): Promise<{ posted: boolean; delta: number }> {
    const organizationId = await this.assertBranchOperator(params.scope, params.locationId);
    if (!params.reason?.trim()) throw new BadRequestException('A recount must say why');
    const result = await this.em.transactional(async (tem) =>
      this.stock.setProductQuantity(tem as EntityManager, {
        organizationId,
        productId: params.productId,
        targetQuantity: params.countedQuantity,
        origin: 'inventory-recount',
        actor: params.actor,
        locationId: params.locationId,
      }),
    );
    const storeId = await this.storeOf(organizationId, params.locationId);
    await this.audit(
      params.actor,
      Action.BULK_INVENTORY,
      params.productId,
      { countedQuantity: params.countedQuantity, delta: result.delta, reason: params.reason },
      `Recounted inventory (${result.delta >= 0 ? '+' : ''}${result.delta})`,
      { organizationId, storeId },
    );
    return result;
  }

  /**
   * Makes damaged units sellable, or takes sound units out of sale.
   *
   * ADR 013 §2 and §6: condition and operational state are separate dimensions,
   * and sellability is derived from their permitted combinations plus THIS
   * explicit, audited act. It is not a stored dimension and it is not automatic.
   */
  async reclassifySellability(params: {
    scope: TenantScope | undefined;
    actor: { id: string; email?: string };
    productId: string;
    locationId: string;
    quantity: number;
    from: { physicalCondition: PhysicalCondition; operationalState: 'AVAILABLE' | 'NON_SELLABLE' };
    to: { physicalCondition: PhysicalCondition; operationalState: 'AVAILABLE' | 'NON_SELLABLE' };
    reason: string;
    /**
     * Supplied by the caller so a double-submit is a REPLAY, not a second
     * adjustment. These commands are deltas: without a stable key, clicking
     * twice would apply twice. The posting mechanism settles a repeated key as
     * a replay and a changed payload under the same key as a conflict.
     */
    idempotencyKey?: string;
  }): Promise<void> {
    const organizationId = this.assertOrganizationOperator(params.scope);
    if (params.quantity <= 0) throw new BadRequestException('A reclassification needs a positive quantity');
    if (!params.reason?.trim()) throw new BadRequestException('A reclassification must say why');
    if (
      params.from.physicalCondition === params.to.physicalCondition &&
      params.from.operationalState === params.to.operationalState
    ) {
      throw new BadRequestException('A reclassification must change something');
    }
    const command: InventoryCommand = {
      organizationId,
      type: 'SELLABILITY_RECLASSIFY',
      idempotencyKey:
        params.idempotencyKey ??
        `reclassify:${params.locationId}:${params.productId}:${await this.nextSequence(
          organizationId,
          `reclassify:${params.locationId}:${params.productId}:`,
        )}`,
      principal: this.principal(params.actor),
      intents: [{ productId: params.productId, declaredAmount: params.quantity, intentSign: 0 }],
      movements: [
        {
          productId: params.productId,
          locationId: params.locationId,
          physicalCondition: params.from.physicalCondition,
          operationalState: params.from.operationalState,
          quantityDelta: -params.quantity,
        },
        {
          productId: params.productId,
          locationId: params.locationId,
          physicalCondition: params.to.physicalCondition,
          operationalState: params.to.operationalState,
          quantityDelta: params.quantity,
        },
      ],
    };
    await this.em.transactional(async (tem) => this.posting.postWithin(tem as EntityManager, command));
    await this.audit(
      params.actor,
      Action.UPDATE,
      params.productId,
      { quantity: params.quantity, from: params.from, to: params.to, reason: params.reason },
      `Reclassified ${params.quantity} units`,
      { organizationId, storeId: await this.storeOf(organizationId, params.locationId) },
    );
  }

  /**
   * Moves stock from one product to another (R12, generalized). Any two
   * distinct products of the organization — no family relationship required.
   */
  async reassignStock(params: {
    scope: TenantScope | undefined;
    actor: { id: string; email?: string };
    sourceProductId: string;
    destinationProductId: string;
    locationId: string;
    quantity: number;
    reason: string;
    /**
     * Supplied by the caller so a double-submit is a REPLAY, not a second
     * adjustment. These commands are deltas: without a stable key, clicking
     * twice would apply twice. The posting mechanism settles a repeated key as
     * a replay and a changed payload under the same key as a conflict.
     */
    idempotencyKey?: string;
  }): Promise<void> {
    const organizationId = this.assertOrganizationOperator(params.scope);
    if (!params.reason?.trim()) throw new BadRequestException('A reassignment must say why');
    const command: InventoryCommand = {
      organizationId,
      type: 'PRODUCT_STOCK_REASSIGNMENT',
      idempotencyKey:
        params.idempotencyKey ??
        `reassign:${params.sourceProductId}:${params.destinationProductId}:${await this.nextSequence(
          organizationId,
          `reassign:${params.sourceProductId}:${params.destinationProductId}:`,
        )}`,
      principal: this.principal(params.actor),
      scopeProductId: params.sourceProductId,
      intents: [
        { productId: params.sourceProductId, declaredAmount: params.quantity, intentSign: -1 },
        { productId: params.destinationProductId, declaredAmount: params.quantity, intentSign: 1 },
      ],
      movements: [
        {
          productId: params.sourceProductId,
          locationId: params.locationId,
          physicalCondition: 'GOOD',
          operationalState: 'AVAILABLE',
          quantityDelta: -params.quantity,
        },
        {
          productId: params.destinationProductId,
          locationId: params.locationId,
          physicalCondition: 'GOOD',
          operationalState: 'AVAILABLE',
          quantityDelta: params.quantity,
        },
      ],
    };
    await this.em.transactional(async (tem) => this.posting.postWithin(tem as EntityManager, command));
    await this.audit(
      params.actor,
      Action.UPDATE,
      params.sourceProductId,
      { destinationProductId: params.destinationProductId, quantity: params.quantity, reason: params.reason },
      `Reassigned ${params.quantity} units to another product`,
      { organizationId, storeId: await this.storeOf(organizationId, params.locationId) },
    );
  }

  /**
   * Spreads a family card's stock across its versions (R12, constrained).
   * Total-preserving by construction: the card gives up exactly what the
   * children receive.
   */
  async distributeFamilyStock(params: {
    scope: TenantScope | undefined;
    actor: { id: string; email?: string };
    rootProductId: string;
    locationId: string;
    allocations: { productId: string; quantity: number }[];
    reason: string;
    /**
     * Supplied by the caller so a double-submit is a REPLAY, not a second
     * adjustment. These commands are deltas: without a stable key, clicking
     * twice would apply twice. The posting mechanism settles a repeated key as
     * a replay and a changed payload under the same key as a conflict.
     */
    idempotencyKey?: string;
  }): Promise<void> {
    const organizationId = this.assertOrganizationOperator(params.scope);
    if (!params.reason?.trim()) throw new BadRequestException('A distribution must say why');
    const total = params.allocations.reduce((sum, entry) => sum + entry.quantity, 0);
    if (total <= 0) throw new BadRequestException('A distribution needs a positive quantity');
    const command: InventoryCommand = {
      organizationId,
      type: 'FAMILY_STOCK_DISTRIBUTION',
      idempotencyKey:
        params.idempotencyKey ??
        `distribute:${params.rootProductId}:${await this.nextSequence(
          organizationId,
          `distribute:${params.rootProductId}:`,
        )}`,
      principal: this.principal(params.actor),
      scopeProductId: params.rootProductId,
      intents: [
        { productId: params.rootProductId, declaredAmount: total, intentSign: -1 },
        ...params.allocations.map((entry) => ({
          productId: entry.productId,
          declaredAmount: entry.quantity,
          intentSign: 1 as const,
        })),
      ],
      movements: [
        {
          productId: params.rootProductId,
          locationId: params.locationId,
          physicalCondition: 'GOOD' as const,
          operationalState: 'AVAILABLE' as const,
          quantityDelta: -total,
        },
        ...params.allocations.map((entry) => ({
          productId: entry.productId,
          locationId: params.locationId,
          physicalCondition: 'GOOD' as const,
          operationalState: 'AVAILABLE' as const,
          quantityDelta: entry.quantity,
        })),
      ],
    };
    await this.em.transactional(async (tem) => this.posting.postWithin(tem as EntityManager, command));
    await this.audit(
      params.actor,
      Action.UPDATE,
      params.rootProductId,
      { allocations: params.allocations, reason: params.reason },
      `Distributed ${total} units across the family`,
      { organizationId, storeId: await this.storeOf(organizationId, params.locationId) },
    );
  }

  // ── location administration ───────────────────────────────────────────────

  /** Warehouses are internal. Creating one is an organization-manager act. */
  async createWarehouse(params: {
    scope: TenantScope | undefined;
    actor: { id: string; email?: string };
    code: string;
    name: string;
  }): Promise<string> {
    const organizationId = this.assertOrganizationOperator(params.scope);
    if (!params.code?.trim() || !params.name?.trim()) {
      throw new BadRequestException('A warehouse needs a code and a name');
    }
    if (params.code.startsWith('STORE:')) {
      throw new BadRequestException('That code belongs to branch custody, not a warehouse');
    }
    const [row]: { id: string }[] = await this.em.execute(
      `insert into inventory_locations (organization_id, kind, code, name, store_id, is_default, created_at, updated_at)
       values (?, 'WAREHOUSE', ?, ?, null, false, now(), now()) returning id`,
      [organizationId, params.code.trim(), params.name.trim()],
    );
    await this.audit(
      params.actor,
      Action.CREATE,
      row.id,
      { code: params.code, name: params.name },
      `Created warehouse "${params.name}"`,
      { organizationId, storeId: null },
    );
    return row.id;
  }

  /**
   * Moves the default flag. Exactly one default per organization is a database
   * fact, so this swaps rather than adds — inside one transaction, or the
   * partial unique index would refuse the intermediate state.
   */
  async setDefaultWarehouse(params: {
    scope: TenantScope | undefined;
    actor: { id: string; email?: string };
    locationId: string;
  }): Promise<void> {
    const organizationId = this.assertOrganizationOperator(params.scope);
    await this.em.transactional(async (tem) => {
      const rows: { kind: string }[] = await tem.execute(
        `select kind from inventory_locations where id = ?::uuid and organization_id = ?`,
        [params.locationId, organizationId],
      );
      if (!rows[0]) throw new NotFoundException('Location not found');
      if (rows[0].kind !== 'WAREHOUSE') throw new BadRequestException('Only a warehouse can be the default');
      await tem.execute(
        `update inventory_locations set is_default = false, updated_at = now()
          where organization_id = ? and is_default`,
        [organizationId],
      );
      await tem.execute(`update inventory_locations set is_default = true, updated_at = now() where id = ?::uuid`, [
        params.locationId,
      ]);
    });
    await this.audit(
      params.actor,
      Action.UPDATE,
      params.locationId,
      { isDefault: { before: false, after: true } },
      'Changed the default warehouse',
      { organizationId, storeId: null },
    );
  }

  /** The branch's canonical custody location, created on demand. */
  async ensureStoreLocation(params: {
    scope: TenantScope | undefined;
    actor: { id: string; email?: string };
    storeId: string;
    name: string;
  }): Promise<string> {
    const organizationId = this.assertOrganizationOperator(params.scope);
    const existing: { id: string }[] = await this.em.execute(
      `select id from inventory_locations where organization_id = ? and store_id = ?::uuid and kind = 'STORE'`,
      [organizationId, params.storeId],
    );
    if (existing[0]) return existing[0].id;
    const [row]: { id: string }[] = await this.em.execute(
      `insert into inventory_locations (organization_id, kind, code, name, store_id, is_default, created_at, updated_at)
       values (?, 'STORE', ?, ?, ?::uuid, false, now(), now()) returning id`,
      [organizationId, storeLocationCode(params.storeId), params.name, params.storeId],
    );
    await this.audit(
      params.actor,
      Action.CREATE,
      row.id,
      { storeId: params.storeId },
      'Created branch custody location',
      { organizationId, storeId: params.storeId },
    );
    return row.id;
  }

  private async nextSequence(organizationId: string, prefix: string): Promise<number> {
    const rows: { n: number }[] = await this.em.execute(
      `select count(*)::int as n from inventory_transactions where organization_id = ? and idempotency_key like ?`,
      [organizationId, `${prefix}%`],
    );
    return rows[0]?.n ?? 0;
  }

  private async storeOf(organizationId: string, locationId: string): Promise<string | null> {
    const rows: { store_id: string | null }[] = await this.em.execute(
      `select store_id from inventory_locations where id = ?::uuid and organization_id = ?`,
      [locationId, organizationId],
    );
    return rows[0]?.store_id ?? null;
  }
}
