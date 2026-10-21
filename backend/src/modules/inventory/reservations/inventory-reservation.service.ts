import { randomBytes } from 'crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { InventoryPostingService } from '../ledger/inventory-posting.service';
import { InventoryStockService } from '../ledger/inventory-stock.service';
import { InventoryCommand, InventoryPrincipal, PhysicalCondition } from '../ledger/inventory.types';

/**
 * P5-B4 — the two reservation aggregates.
 *
 * A PHYSICAL reservation moves existing units AVAILABLE -> RESERVED at one
 * location. A BACKORDER records a promise about units that do not exist and
 * writes nothing to the ledger. Keeping them apart is what stops a promise from
 * turning into imaginary stock.
 *
 * Everything here takes the caller's EntityManager, so a reservation and the
 * ledger movement behind it commit or roll back together.
 */

/** The customer snapshot (ADR 013 §8). Never logged, never returned publicly. */
export interface CustomerSnapshot {
  customerName?: string | null;
  customerPhone?: string | null;
  customerEmail?: string | null;
  customerId?: string | null;
  salesOrderId?: string | null;
}

@Injectable()
export class InventoryReservationService {
  constructor(
    private readonly posting: InventoryPostingService,
    private readonly stock: InventoryStockService,
  ) {}

  private async sequence(em: EntityManager, organizationId: string, prefix: string): Promise<number> {
    const rows: { n: number }[] = await em.execute(
      `select count(*)::int as n from inventory_transactions where organization_id = ? and idempotency_key like ?`,
      [organizationId, `${prefix}%`],
    );
    return rows[0]?.n ?? 0;
  }

  /** Moves units between two states of the same cell — the shape of every reservation move. */
  private async postCellMove(
    em: EntityManager,
    params: {
      organizationId: string;
      type: 'RESERVE' | 'RELEASE';
      idempotencyKey: string;
      principal: InventoryPrincipal;
      productId: string;
      locationId: string;
      physicalCondition: PhysicalCondition;
      quantity: number;
      from: 'AVAILABLE' | 'RESERVED';
      to: 'AVAILABLE' | 'RESERVED';
      auditStoreId?: string | null;
    },
  ): Promise<string> {
    const command: InventoryCommand = {
      organizationId: params.organizationId,
      type: params.type,
      idempotencyKey: params.idempotencyKey,
      principal: params.principal,
      auditStoreId: params.auditStoreId ?? null,
      intents: [{ productId: params.productId, declaredAmount: params.quantity, intentSign: 0 }],
      movements: [
        {
          productId: params.productId,
          locationId: params.locationId,
          physicalCondition: params.physicalCondition,
          operationalState: params.from,
          quantityDelta: -params.quantity,
        },
        {
          productId: params.productId,
          locationId: params.locationId,
          physicalCondition: params.physicalCondition,
          operationalState: params.to,
          quantityDelta: params.quantity,
        },
      ],
    };
    const posted = await this.posting.postWithin(em, command);
    return posted.transactionId;
  }

  /**
   * Sets aside stock that exists.
   *
   * Returns null when the cell is short — a refusal, not a fault, so the caller
   * can decide whether to raise a backorder instead. The database makes that
   * decision under the row lock, not a read taken a moment earlier.
   */
  async reservePhysical(
    em: EntityManager,
    params: {
      organizationId: string;
      productId: string;
      locationId: string;
      quantity: number;
      physicalCondition?: PhysicalCondition;
      principal: InventoryPrincipal;
      customer?: CustomerSnapshot;
      auditStoreId?: string | null;
    },
  ): Promise<{ reservationId: string; transactionId: string } | null> {
    if (params.quantity <= 0) throw new BadRequestException('A reservation needs a positive quantity');
    const condition = params.physicalCondition ?? 'GOOD';
    const prefix = `reserve:${params.productId}:${params.locationId}:`;
    const seq = await this.sequence(em, params.organizationId, prefix);
    // A savepoint, for the same reason `InventoryStockService.attemptDraw` needs
    // one: catching the constraint violation does not un-abort the transaction,
    // and the caller usually has a follow-up question — raise a backorder
    // instead? try the next location? — that a dead transaction cannot answer.
    const savepoint = `sp_reserve_${randomBytes(6).toString('hex')}`;
    let transactionId: string;
    await em.execute(`savepoint ${savepoint}`);
    try {
      transactionId = await this.postCellMove(em, {
        organizationId: params.organizationId,
        type: 'RESERVE',
        idempotencyKey: `${prefix}${seq}`,
        principal: params.principal,
        productId: params.productId,
        locationId: params.locationId,
        physicalCondition: condition,
        quantity: params.quantity,
        from: 'AVAILABLE',
        to: 'RESERVED',
        auditStoreId: params.auditStoreId,
      });
      await em.execute(`release savepoint ${savepoint}`);
    } catch (error) {
      await em.execute(`rollback to savepoint ${savepoint}`);
      if (error instanceof Error && /inventory_balances_nonnegative_check/.test(error.message)) return null;
      throw error;
    }

    const [row]: { id: string }[] = await em.execute(
      `insert into inventory_reservations
         (organization_id, product_id, location_id, physical_condition, quantity, status,
          customer_name, customer_phone, customer_email, customer_id, sales_order_id,
          reserve_transaction_id, created_at, updated_at)
       values (?, ?::uuid, ?::uuid, ?, ?, 'ACTIVE', ?, ?, ?, ?::uuid, ?::uuid, ?::uuid, now(), now())
       returning id`,
      [
        params.organizationId,
        params.productId,
        params.locationId,
        condition,
        params.quantity,
        params.customer?.customerName ?? null,
        params.customer?.customerPhone ?? null,
        params.customer?.customerEmail ?? null,
        params.customer?.customerId ?? null,
        params.customer?.salesOrderId ?? null,
        transactionId,
      ],
    );
    return { reservationId: row.id, transactionId };
  }

  /** Gives reserved units back to AVAILABLE. */
  async releasePhysical(
    em: EntityManager,
    params: { organizationId: string; reservationId: string; principal: InventoryPrincipal },
  ): Promise<void> {
    const reservation = await this.loadActive(em, params.organizationId, params.reservationId);
    const prefix = `release:${params.reservationId}:`;
    const seq = await this.sequence(em, params.organizationId, prefix);
    const transactionId = await this.postCellMove(em, {
      organizationId: params.organizationId,
      type: 'RELEASE',
      idempotencyKey: `${prefix}${seq}`,
      principal: params.principal,
      productId: reservation.product_id,
      locationId: reservation.location_id,
      physicalCondition: reservation.physical_condition as PhysicalCondition,
      quantity: reservation.quantity,
      from: 'RESERVED',
      to: 'AVAILABLE',
    });
    await em.execute(
      `update inventory_reservations set status = 'RELEASED', settle_transaction_id = ?::uuid, updated_at = now()
        where id = ?::uuid`,
      [transactionId, params.reservationId],
    );
  }

  /**
   * Issues reserved units — the sale finally happens.
   *
   * The units leave from RESERVED, not from AVAILABLE: they were already set
   * aside, so taking them from AVAILABLE would double-count the reservation.
   */
  async fulfilPhysical(
    em: EntityManager,
    params: { organizationId: string; reservationId: string; principal: InventoryPrincipal },
  ): Promise<void> {
    const reservation = await this.loadActive(em, params.organizationId, params.reservationId);
    const prefix = `fulfil:${params.reservationId}:`;
    const seq = await this.sequence(em, params.organizationId, prefix);
    const command: InventoryCommand = {
      organizationId: params.organizationId,
      type: 'SALE_ISSUE',
      idempotencyKey: `${prefix}${seq}`,
      principal: params.principal,
      salesOrderId: reservation.sales_order_id,
      intents: [{ productId: reservation.product_id, declaredAmount: reservation.quantity, intentSign: -1 }],
      movements: [
        {
          productId: reservation.product_id,
          locationId: reservation.location_id,
          physicalCondition: reservation.physical_condition as PhysicalCondition,
          operationalState: 'RESERVED',
          quantityDelta: -reservation.quantity,
        },
      ],
    };
    const posted = await this.posting.postWithin(em, command);
    await em.execute(
      `update inventory_reservations set status = 'FULFILLED', settle_transaction_id = ?::uuid, updated_at = now()
        where id = ?::uuid`,
      [posted.transactionId, params.reservationId],
    );
  }

  private async loadActive(
    em: EntityManager,
    organizationId: string,
    reservationId: string,
  ): Promise<{
    product_id: string;
    location_id: string;
    physical_condition: string;
    quantity: number;
    sales_order_id: string | null;
  }> {
    const rows: any[] = await em.execute(
      `select product_id, location_id, physical_condition, quantity, sales_order_id
         from inventory_reservations where id = ?::uuid and organization_id = ? and status = 'ACTIVE'`,
      [reservationId, organizationId],
    );
    if (!rows[0]) throw new NotFoundException('Active reservation not found');
    return rows[0];
  }

  // ── backorders ────────────────────────────────────────────────────────────

  /**
   * Records a promise. Writes NOTHING to the ledger: the units do not exist, so
   * there is no movement to record and no balance to touch.
   */
  async createBackorder(
    em: EntityManager,
    params: {
      organizationId: string;
      productId: string;
      quantity: number;
      origin: 'OPERATOR' | 'SALES_OVERSELL';
      storeId?: string | null;
      customer?: CustomerSnapshot;
    },
  ): Promise<string> {
    if (params.quantity <= 0) throw new BadRequestException('A backorder needs a positive quantity');
    const [row]: { id: string }[] = await em.execute(
      `insert into inventory_backorders
         (organization_id, product_id, store_id, quantity, allocated_quantity, origin, status,
          customer_name, customer_phone, customer_email, customer_id, sales_order_id, created_at, updated_at)
       values (?, ?::uuid, ?::uuid, ?, 0, ?, 'OPEN', ?, ?, ?, ?::uuid, ?::uuid, now(), now())
       returning id`,
      [
        params.organizationId,
        params.productId,
        params.storeId ?? null,
        params.quantity,
        params.origin,
        params.customer?.customerName ?? null,
        params.customer?.customerPhone ?? null,
        params.customer?.customerEmail ?? null,
        params.customer?.customerId ?? null,
        params.customer?.salesOrderId ?? null,
      ],
    );
    return row.id;
  }

  async cancelBackorder(em: EntityManager, organizationId: string, backorderId: string): Promise<void> {
    await em.execute(
      `update inventory_backorders set status = 'CANCELLED', updated_at = now()
        where id = ?::uuid and organization_id = ? and status in ('OPEN', 'PARTIALLY_ALLOCATED')`,
      [backorderId, organizationId],
    );
  }

  /**
   * Meets open promises with stock that now exists, oldest promise first
   * (Decision 3).
   *
   * Each allocation becomes a real physical reservation, so the units stop being
   * sellable the moment they are spoken for. Partial allocation is normal: a
   * promise for ten met by four stays open for six, and keeps its place in the
   * queue rather than going to the back of it.
   *
   * Runs inside the caller's transaction, which is what lets B6 call it from
   * inside a receipt (ADR 013 §6).
   */
  async allocateBackorders(
    em: EntityManager,
    params: {
      organizationId: string;
      productId: string;
      locationId: string;
      principal: InventoryPrincipal;
      physicalCondition?: PhysicalCondition;
    },
  ): Promise<{ allocated: number; backordersTouched: number }> {
    const condition = params.physicalCondition ?? 'GOOD';
    const queue: { id: string; quantity: number; allocated_quantity: number }[] = await em.execute(
      `select id, quantity, allocated_quantity from inventory_backorders
        where organization_id = ? and product_id = ?::uuid and status in ('OPEN', 'PARTIALLY_ALLOCATED')
        order by created_at, id`,
      [params.organizationId, params.productId],
    );

    let allocated = 0;
    let touched = 0;
    for (const backorder of queue) {
      const outstanding = backorder.quantity - backorder.allocated_quantity;
      if (outstanding <= 0) continue;
      const available = await this.stock.locationAvailable(
        em,
        params.organizationId,
        params.locationId,
        params.productId,
      );
      if (available <= 0) break;
      const take = Math.min(outstanding, available);

      const reservation = await this.reservePhysical(em, {
        organizationId: params.organizationId,
        productId: params.productId,
        locationId: params.locationId,
        quantity: take,
        physicalCondition: condition,
        principal: params.principal,
      });
      if (!reservation) break;

      await em.execute(
        `insert into inventory_backorder_allocations
           (organization_id, backorder_id, reservation_id, quantity, allocated_at)
         values (?, ?::uuid, ?::uuid, ?, now())`,
        [params.organizationId, backorder.id, reservation.reservationId, take],
      );
      const nowAllocated = backorder.allocated_quantity + take;
      await em.execute(
        `update inventory_backorders
            set allocated_quantity = ?, status = ?, updated_at = now()
          where id = ?::uuid`,
        [nowAllocated, nowAllocated >= backorder.quantity ? 'ALLOCATED' : 'PARTIALLY_ALLOCATED', backorder.id],
      );
      allocated += take;
      touched += 1;
    }
    return { allocated, backordersTouched: touched };
  }

  /** Whether this organization refuses a short sale or promises it instead. */
  async enforcesStockAvailability(em: EntityManager, organizationId: string): Promise<boolean> {
    const rows: { enforce: boolean }[] = await em.execute(
      `select enforce_stock_availability as enforce from organizations where id = ?::uuid
       /* removed_at: a configuration flag read by id; the reservation write is guarded by the lifecycle trigger (#294) */`,
      [organizationId],
    );
    return rows[0]?.enforce ?? true;
  }
}
