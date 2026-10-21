import { randomBytes } from 'crypto';
import { BadRequestException, Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { InventoryPostingService } from './inventory-posting.service';
import { InventoryCommand, InventoryPrincipal, InventoryTransactionType } from './inventory.types';

/**
 * P5-B3 — the ONE door every business service walks through to move stock.
 *
 * Before this, six services each owned a little arithmetic on
 * `products.stock_quantity` or `store_products.stock_quantity`: a raw
 * conditional decrement in checkout, a `+=` in supplier receiving, three
 * overwrites in the catalogue, three more in the importers. Nine different
 * ideas of what "stock" meant, none of them recorded anywhere.
 *
 * They now all express the same thing — a command against the ledger — and the
 * legacy columns are refreshed from that ledger by the posting mechanism. No
 * service adds to them, subtracts from them, or sets them.
 *
 * Every method takes the CALLER'S EntityManager. The business mutation, the
 * ledger posting, the postcondition and the compatibility caches then share one
 * transaction and commit or roll back together.
 */
@Injectable()
export class InventoryStockService {
  constructor(private readonly posting: InventoryPostingService) {}

  /**
   * A panel operation is attributable to the person who performed it; a
   * background or public path is attributable to the subsystem. Both are stable
   * identities, and both enter the command fingerprint.
   */
  static principalFor(origin: string, actor?: { id: string; email?: string } | null): InventoryPrincipal {
    return actor?.id ? { kind: 'USER', userId: actor.id, email: actor.email ?? null } : { kind: 'SYSTEM', origin };
  }

  /** The organization's default warehouse. Product-level movements land here. */
  async defaultWarehouseId(em: EntityManager, organizationId: string): Promise<string> {
    const rows: { id: string }[] = await em.execute(
      `select id from inventory_locations where organization_id = ? and is_default and kind = 'WAREHOUSE'`,
      [organizationId],
    );
    if (!rows[0]) {
      throw new BadRequestException(
        'This organization has no default warehouse; inventory cannot move until its opening epoch is prepared',
      );
    }
    return rows[0].id;
  }

  /** A branch's custody location. Branch-level movements land here. */
  async storeLocationId(em: EntityManager, organizationId: string, storeId: string): Promise<string> {
    const rows: { id: string }[] = await em.execute(
      `select id from inventory_locations where organization_id = ? and store_id = ?::uuid and kind = 'STORE'`,
      [organizationId, storeId],
    );
    if (!rows[0]) {
      throw new BadRequestException('This branch has no custody location; inventory cannot move until it is prepared');
    }
    return rows[0].id;
  }

  /** What the organization owns of a product right now, from the ledger. */
  async organizationTotal(em: EntityManager, organizationId: string, productId: string): Promise<number> {
    const rows: { total: number }[] = await em.execute(
      `select (coalesce((select sum(quantity) from inventory_balances
                          where organization_id = ? and product_id = ?::uuid), 0)
             + coalesce((select sum(quantity) from inventory_transit_balances
                          where organization_id = ? and product_id = ?::uuid), 0))::int as total`,
      [organizationId, productId, organizationId, productId],
    );
    return rows[0]?.total ?? 0;
  }

  /** What one location holds of a product, GOOD and AVAILABLE. */
  async locationAvailable(
    em: EntityManager,
    organizationId: string,
    locationId: string,
    productId: string,
  ): Promise<number> {
    const rows: { quantity: number }[] = await em.execute(
      `select coalesce(sum(quantity), 0)::int as quantity from inventory_balances
        where organization_id = ? and location_id = ?::uuid and product_id = ?::uuid
          and physical_condition = 'GOOD' and operational_state = 'AVAILABLE'`,
      [organizationId, locationId, productId],
    );
    return rows[0]?.quantity ?? 0;
  }

  /**
   * How many transactions of this type already exist under a key prefix.
   *
   * Idempotency keys must be DETERMINISTIC, and a business event that can
   * legitimately recur — cancel, reactivate, cancel again — needs to be
   * distinguishable from a replay of the first one. The count of what already
   * happened is derived from the database rather than from a clock or a random
   * value, so the same request against the same state always produces the same
   * key.
   */
  private async sequence(em: EntityManager, organizationId: string, prefix: string): Promise<number> {
    const rows: { n: number }[] = await em.execute(
      `select count(*)::int as n from inventory_transactions
        where organization_id = ? and idempotency_key like ?`,
      [organizationId, `${prefix}%`],
    );
    return rows[0]?.n ?? 0;
  }

  private async postSimple(
    em: EntityManager,
    params: {
      organizationId: string;
      type: InventoryTransactionType;
      idempotencyKey: string;
      principal: InventoryPrincipal;
      productId: string;
      locationId: string;
      quantity: number;
      sign: 1 | -1;
      auditStoreId?: string | null;
      salesOrderId?: string | null;
    },
  ): Promise<string> {
    const command: InventoryCommand = {
      organizationId: params.organizationId,
      type: params.type,
      idempotencyKey: params.idempotencyKey,
      principal: params.principal,
      auditStoreId: params.auditStoreId ?? null,
      salesOrderId: params.salesOrderId ?? null,
      intents: [{ productId: params.productId, declaredAmount: params.quantity, intentSign: params.sign }],
      movements: [
        {
          productId: params.productId,
          locationId: params.locationId,
          physicalCondition: 'GOOD',
          operationalState: 'AVAILABLE',
          quantityDelta: params.sign * params.quantity,
        },
      ],
    };
    const posted = await this.posting.postWithin(em, command);
    return posted.transactionId;
  }

  /**
   * Selling. Returns false when the branch does not hold enough — the caller
   * refuses the line exactly as the old conditional decrement did.
   *
   * The check is not "read then subtract": the posting mechanism draws against
   * `CHECK (quantity >= 0)` under the row lock, so two simultaneous buyers
   * cannot both take the last unit.
   */
  async issueForSale(
    em: EntityManager,
    params: {
      organizationId: string;
      storeId: string;
      productId: string;
      quantity: number;
      salesOrderId?: string | null;
      idempotencyScope: string;
      actor?: { id: string; email?: string } | null;
    },
  ): Promise<boolean> {
    const locationId = await this.storeLocationId(em, params.organizationId, params.storeId);
    const prefix = `sale-issue:${params.idempotencyScope}:${params.productId}:`;
    const seq = await this.sequence(em, params.organizationId, prefix);
    return this.attemptDraw(em, () =>
      this.postSimple(em, {
        organizationId: params.organizationId,
        type: 'SALE_ISSUE',
        idempotencyKey: `${prefix}${seq}`,
        principal: InventoryStockService.principalFor('sales-checkout', params.actor),
        productId: params.productId,
        locationId,
        quantity: params.quantity,
        sign: -1,
        auditStoreId: params.storeId,
        salesOrderId: params.salesOrderId ?? null,
      }),
    );
  }

  /**
   * Attempts a draw that may legitimately be refused, and leaves the caller's
   * transaction USABLE either way.
   *
   * This needs a savepoint, and the reason is easy to get wrong: catching the
   * constraint violation in JavaScript does not un-abort the PostgreSQL
   * transaction. Once a statement fails, every later statement in that
   * transaction is rejected with "current transaction is aborted" — so a caller
   * that wanted to ask a follow-up question (does this organization enforce
   * stock availability? should this become a backorder?) would hit a dead
   * transaction instead of an answer. Rolling back to a savepoint discards only
   * the failed attempt.
   */
  private async attemptDraw(em: EntityManager, attempt: () => Promise<unknown>): Promise<boolean> {
    const savepoint = `sp_draw_${randomBytes(6).toString('hex')}`;
    await em.execute(`savepoint ${savepoint}`);
    try {
      await attempt();
      await em.execute(`release savepoint ${savepoint}`);
      return true;
    } catch (error) {
      await em.execute(`rollback to savepoint ${savepoint}`);
      // A refused draw is a business answer ("not enough stock"), not a fault.
      // Anything else is a fault and must not be swallowed.
      if (error instanceof Error && /inventory_balances_nonnegative_check/.test(error.message)) return false;
      throw error;
    }
  }

  /** Cancelling an order returns its units to the branch they left. */
  async restoreFromCancellation(
    em: EntityManager,
    params: {
      organizationId: string;
      storeId: string;
      productId: string;
      quantity: number;
      salesOrderId?: string | null;
      idempotencyScope: string;
      actor?: { id: string; email?: string } | null;
    },
  ): Promise<void> {
    const locationId = await this.storeLocationId(em, params.organizationId, params.storeId);
    const prefix = `sale-return:${params.idempotencyScope}:${params.productId}:`;
    const seq = await this.sequence(em, params.organizationId, prefix);
    await this.postSimple(em, {
      organizationId: params.organizationId,
      type: 'SALE_RETURN',
      idempotencyKey: `${prefix}${seq}`,
      principal: InventoryStockService.principalFor('sales-order-status', params.actor),
      productId: params.productId,
      locationId,
      quantity: params.quantity,
      sign: 1,
      auditStoreId: params.storeId,
      salesOrderId: params.salesOrderId ?? null,
    });
  }

  /**
   * "This product now holds N units" — the shape every catalogue and import
   * writer actually wanted.
   *
   * It is expressed as an ADJUSTMENT of the difference, because the ledger
   * records movements and not assignments: setting 5 to 7 is two units arriving,
   * and the ledger should say so. Setting a value it already holds moves
   * nothing and posts nothing.
   */
  async setProductQuantity(
    em: EntityManager,
    params: {
      organizationId: string;
      productId: string;
      targetQuantity: number;
      origin: string;
      actor?: { id: string; email?: string } | null;
      locationId?: string | null;
      auditStoreId?: string | null;
    },
  ): Promise<{ posted: boolean; delta: number }> {
    if (params.targetQuantity < 0) throw new BadRequestException('Stock quantity cannot be negative');
    const locationId = params.locationId ?? (await this.defaultWarehouseId(em, params.organizationId));
    const current = params.locationId
      ? await this.locationAvailable(em, params.organizationId, locationId, params.productId)
      : await this.organizationTotal(em, params.organizationId, params.productId);
    const delta = params.targetQuantity - current;
    if (delta === 0) return { posted: false, delta: 0 };

    const prefix = `adjust:${params.origin}:${params.productId}:${current}->${params.targetQuantity}:`;
    const seq = await this.sequence(em, params.organizationId, prefix);
    await this.postSimple(em, {
      organizationId: params.organizationId,
      type: 'ADJUSTMENT',
      idempotencyKey: `${prefix}${seq}`,
      principal: InventoryStockService.principalFor(params.origin, params.actor),
      productId: params.productId,
      locationId,
      quantity: Math.abs(delta),
      sign: delta > 0 ? 1 : -1,
      auditStoreId: params.auditStoreId ?? null,
    });
    return { posted: true, delta };
  }

  /** The branch-level form of `setProductQuantity`. */
  async setBranchQuantity(
    em: EntityManager,
    params: {
      organizationId: string;
      storeId: string;
      productId: string;
      targetQuantity: number;
      origin: string;
      actor?: { id: string; email?: string } | null;
    },
  ): Promise<{ posted: boolean; delta: number }> {
    const locationId = await this.storeLocationId(em, params.organizationId, params.storeId);
    return this.setProductQuantity(em, {
      organizationId: params.organizationId,
      productId: params.productId,
      targetQuantity: params.targetQuantity,
      origin: params.origin,
      actor: params.actor,
      locationId,
      auditStoreId: params.storeId,
    });
  }
}
