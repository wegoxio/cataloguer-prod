import { BadRequestException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager, EntityRepository, QueryOrder } from '@mikro-orm/postgresql';
import { randomBytes } from 'crypto';
import { SalesOrder, SalesOrderItem, SalesOrderStatus } from './sales-order.entity';
import { Product } from '../products/entities/product.entity';
import { StoreProduct } from '../products/entities/store-product.entity';
import { familyVisibleClause, visibleChildWhere } from '../public-catalogue/query/child-visibility';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EntityType, Action } from '../audit-log/entities/audit-log.entity';
import { DiscountsService } from '../discounts/discounts.service';
import { Actor } from '../audit-log/types/actor.type';
import { TenantScope } from '../auth/tenancy/tenant-scope';
import { requireOrganizationScope, resolveScopedStoreTarget } from '../auth/tenancy/tenant-assertions';
import { Store } from '../stores/entities/store.entity';
import { InventoryStockService } from '../inventory/ledger/inventory-stock.service';
import { InventoryReservationService } from '../inventory/reservations/inventory-reservation.service';

export interface PublicOrderItem {
  productId: string;
  /**
   * B4c tombstone marker: the legacy `product_variants` model no longer
   * exists. The field is accepted only so that a stale storefront posting it
   * gets an explicit 410 instead of silently buying the wrong item.
   */
  variantId?: string;
  quantity: number;
}

interface PricedLine {
  product: Product;
  /** The product as THIS branch sells it (P0-06): its price and its stock. */
  link?: StoreProduct;
  unit: number;
  quantity: number;
}

/** Lower effective price wins: sale price only counts when it's a discount. */
const effectivePrice = (price: unknown, salePrice: unknown): number => {
  const base = Number(price) || 0;
  const sale = salePrice !== null && salePrice !== undefined ? Number(salePrice) : null;
  return sale !== null && sale < base ? sale : base;
};

@Injectable()
export class SalesService {
  constructor(
    @InjectRepository(SalesOrder)
    private readonly orderRepository: EntityRepository<SalesOrder>,
    @InjectRepository(Product)
    private readonly productRepository: EntityRepository<Product>,
    private readonly auditLogService: AuditLogService,
    private readonly discountsService: DiscountsService,
    private readonly stock: InventoryStockService,
    private readonly reservations: InventoryReservationService,
  ) {}

  /**
   * B4c: the legacy variant model is gone — table, map and all. Any cart
   * still posting a variantId comes from a storefront cached before the
   * retirement; refusing loudly is the only safe answer, because there is
   * nothing left to translate the id against.
   */
  private rejectLegacyVariantIds(items: PublicOrderItem[]): void {
    const variantIds = [...new Set(items.map((i) => i.variantId).filter((id): id is string => !!id))].sort();
    if (variantIds.length === 0) return;
    throw new GoneException({
      code: 'LEGACY_VARIANTS_REMOVED',
      message:
        'This option uses an identifier from the retired variant system, which has been removed. Please reload the catalogue.',
      variantIds: variantIds.slice(0, 10),
      truncated: variantIds.length > 10,
    });
  }

  /** Resolves cart items to priced lines (validates products/variants). */
  async priceCart(storeId: string, rawItems: PublicOrderItem[]): Promise<{ lines: PricedLine[]; total: number }> {
    if (!rawItems?.length) {
      throw new BadRequestException('Order has no items');
    }
    if (rawItems.length > 100) {
      throw new BadRequestException('Too many items');
    }
    const em = this.orderRepository.getEntityManager();
    this.rejectLegacyVariantIds(rawItems);
    const items = rawItems;
    // A branch only sells what it has published (P0-06)
    // A branch only sells what it has published (P0-06) — expressed with the
    // SAME builders the public catalogue browses by, rather than a hand-copied
    // clause. The first three conditions were already identical to
    // `visibleChildWhere`; what was missing is the family condition, so a child
    // of a Draft, archived or store-hidden card stayed buyable long after its
    // card had disappeared from the shop.
    const products = await this.productRepository.find(
      {
        id: { $in: items.map((i) => i.productId) },
        $and: [visibleChildWhere({ storeId }), familyVisibleClause({ storeId })],
      },
      { populate: ['categories'] },
    );
    const byId = new Map(products.map((p) => [p.id, p]));
    // A family parent describes the model; only its versions are real items.
    // The card may stay visible in the catalogue, but it is never buyable:
    // it holds no stock of its own, so an order against it would deduct
    // nothing and promise something that does not physically exist.
    const parentRows = products.length
      ? await em.find(Product, { parent: { $in: products.map((p) => p.id) } }, { fields: ['parent'] as never })
      : [];
    const parentIds = new Set(
      parentRows.map((child: any) => (typeof child.parent === 'string' ? child.parent : child.parent?.id)),
    );
    const links = await em.find(StoreProduct, {
      store: storeId,
      product: { $in: products.map((p) => p.id) },
    });
    const linkByProduct = new Map(links.map((l) => [l.product.id, l]));

    let total = 0;
    const lines: PricedLine[] = [];
    for (const item of items) {
      const product = byId.get(item.productId);
      if (!product) {
        throw new BadRequestException(`Product ${item.productId} is not available in this store`);
      }
      // Same message as an unavailable product: a card and a missing item must
      // look identical from outside, so neither confirms what the other is.
      if (parentIds.has(product.id)) {
        throw new BadRequestException(`Product ${item.productId} is not available in this store`);
      }
      const quantity = Math.max(1, Math.min(999, Math.floor(item.quantity || 1)));
      const link = linkByProduct.get(product.id);
      // Branch price wins over the base; sale logic applies to whichever won
      const basePrice = link?.price ?? product.price;
      const baseSale = link?.price != null ? link?.salePrice : (link?.salePrice ?? product.salePrice);
      const unit = effectivePrice(basePrice, baseSale);
      total += unit * quantity;
      lines.push({ product, link, unit, quantity });
    }
    return { lines, total };
  }

  /** Public checkout preview: does this code apply, and for how much? */
  async previewDiscount(storeId: string, code: string, items: PublicOrderItem[]) {
    const { lines, total } = await this.priceCart(storeId, items);
    const result = await this.discountsService.compute(
      storeId,
      code || '',
      lines.map((l) => ({
        productId: l.product.id,
        categoryId: (l.product.categories as any)?.getItems?.()[0]?.id ?? null,
        unit: l.unit,
        quantity: l.quantity,
      })),
      total,
    );
    return {
      valid: !!result.code,
      code: result.codeText,
      discountUsd: Number(result.discountUsd.toFixed(2)),
      subtotalUsd: Number(total.toFixed(2)),
      totalUsd: Number(Math.max(0, total - result.discountUsd).toFixed(2)),
      reason: result.code ? undefined : result.reason,
    };
  }

  /** Website checkout: creates a NEW order for the key's store. */
  /** Manual sale entered from the panel (phone/in-person orders). */
  async createManual(
    scope: TenantScope | undefined,
    actor: Actor,
    dto: {
      storeId?: string;
      customerName?: string;
      customerPhone?: string;
      items: PublicOrderItem[];
    },
  ) {
    // P5-A2 family 5: the affected branch is NAMED and validated against the
    // resolved scope. `actor.store?.id ?? dto.storeId` preferred the actor's
    // own binding and let a store-less actor post a sale into any branch.
    const storeId = resolveScopedStoreTarget(scope, dto.storeId ?? scope?.storeId ?? undefined);
    const result = await this.createFromWebsite(storeId, dto.items, dto.customerName, dto.customerPhone);
    // Affected resource is the sale's store; its own organization is the context
    const store = await this.orderRepository.getEntityManager().findOne(Store, { id: storeId });
    await this.auditLogService.recordAuditEntry(
      actor.id,
      actor.email,
      EntityType.STORE,
      storeId,
      Action.CREATE,
      null,
      `Manually recorded sale #${result.orderNumber} for $${result.totalUsd}`,
      {
        organizationId: (store?.organization as any)?.id ?? (store?.organization as any) ?? null,
        storeId,
      },
    );
    return result;
  }

  async createFromWebsite(
    storeId: string,
    items: PublicOrderItem[],
    customerName?: string,
    customerPhone?: string,
    idempotencyKey?: string,
    discountCode?: string,
  ) {
    // Retry-safety: the same key returns the already-created order
    const key = idempotencyKey?.trim().slice(0, 80) || undefined;
    if (key) {
      const existing = await this.orderRepository.findOne({ store: storeId, idempotencyKey: key });
      if (existing) {
        return { orderNumber: existing.orderNumber, totalUsd: existing.totalUsd, id: existing.id };
      }
    }
    const { lines, total } = await this.priceCart(storeId, items);
    // Discount (re-validated server-side; never trusts the website's math)
    const discount = await this.discountsService.compute(
      storeId,
      discountCode ?? '',
      lines.map((l) => ({
        productId: l.product.id,
        categoryId: (l.product.categories as any)?.getItems?.()[0]?.id ?? null,
        unit: l.unit,
        quantity: l.quantity,
      })),
      total,
    );

    const em = this.orderRepository.getEntityManager();
    // The branch's company, which every ledger command is scoped to. Read once,
    // outside the transaction, because it cannot change during a checkout.
    const store = await em.findOne(Store, { id: storeId });
    const orderOrganizationId = ((store?.organization as any)?.id ?? (store?.organization as any) ?? null) as
      | string
      | null;
    // Tenant integrity (P5-X2 acceptance finding): the organization is DERIVED
    // here, from the tenant-validated store target, and never accepted from a
    // caller — no DTO on any path carries an organization id. A store that does
    // not resolve to exactly one organization refuses the checkout BEFORE any
    // write, because an order row without its company is invisible to every
    // organization-scoped report and audit filter.
    if (!store || !orderOrganizationId) {
      throw new BadRequestException('This store does not resolve to an organization');
    }

    try {
      // One transaction for the whole checkout (#160): every tracked line draws
      // through the ledger under its row lock, so two simultaneous buyers
      // cannot both take the last unit — and a failed line rolls everything
      // back, the order row and the ledger postings together.
      return await em.transactional(async (tem) => {
        const orderNumber = `${randomBytes(3).toString('hex').toUpperCase()}`;
        // Deterministic per checkout: the caller's key when it supplied one,
        // otherwise this order's own number. Two attempts of the SAME checkout
        // therefore address the same ledger commands.
        const idempotencyScope = key ?? orderNumber;
        const order = tem.create(SalesOrder, {
          store: storeId as any,
          // Stamped from the store's own company, atomically with store_id in
          // the same INSERT; the composite foreign key installed by the same
          // change makes a mismatched pair impossible at the database layer.
          organization: orderOrganizationId as any,
          orderNumber,
          idempotencyKey: key,
          status: SalesOrderStatus.NEW,
          customerName: customerName?.slice(0, 120) || undefined,
          customerPhone: customerPhone?.slice(0, 40) || undefined,
          totalUsd: '0.00',
          discountUsd: '0.00',
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        for (const { product, link, unit, quantity } of lines) {
          // Selling lowers THIS branch's inventory (P0-06), never another's.
          //
          // P5-B3: the branch's units leave through the ledger. The gate is
          // unchanged — the per-link `trackInventory` flag is still the sole
          // committed gate (ADR 013 §7) — and so is the refusal: not enough
          // stock is still a 400 naming the product. What changed is that the
          // movement is now recorded instead of merely happening.
          const stockTarget = link?.trackInventory ? link : null;
          let deducted = 0;
          if (stockTarget) {
            if (!orderOrganizationId) {
              throw new BadRequestException('This branch has no company; inventory cannot move');
            }
            const taken = await this.stock.issueForSale(tem as EntityManager, {
              organizationId: orderOrganizationId,
              storeId,
              productId: product.id,
              quantity,
              salesOrderId: null,
              idempotencyScope: `order:${idempotencyScope}`,
            });
            if (taken) {
              deducted = quantity;
            } else if (await this.reservations.enforcesStockAvailability(tem as EntityManager, orderOrganizationId)) {
              // The organization refuses to sell what it does not hold. This is
              // the default and today's behaviour, wording included.
              throw new BadRequestException(`Not enough stock for "${product.name}"`);
            } else {
              // Enforcement is off, so the shortfall becomes an honest promise
              // rather than a silent negative balance (Decision A1). It is
              // marked SALES_OVERSELL so nobody mistakes it for a backorder an
              // operator chose to make.
              await this.reservations.createBackorder(tem as EntityManager, {
                organizationId: orderOrganizationId,
                productId: product.id,
                quantity,
                origin: 'SALES_OVERSELL',
                storeId,
                customer: {
                  customerName: customerName?.slice(0, 120) || null,
                  customerPhone: customerPhone?.slice(0, 40) || null,
                },
              });
              deducted = 0;
            }
          }

          tem.create(SalesOrderItem, {
            order,
            product,
            productName: product.name,
            unitPriceUsd: unit.toFixed(2),
            quantity,
            stockDeducted: deducted,
          });
        }
        order.discountCode = discount.codeText ?? undefined;
        order.discountUsd = discount.discountUsd.toFixed(2);
        order.totalUsd = Math.max(0, total - discount.discountUsd).toFixed(2);
        if (discount.code) {
          // Atomic for the same reason as stock: two checkouts, one counter.
          // #295 G2: and only while the code is LIVE. `compute` read it before
          // this transaction took the row; a removal that committed in between
          // makes this match nothing (it re-reads the removed row behind the
          // removal's lock), and the checkout is refused rather than redeeming a
          // code nobody can see. The database freezes a removed code as well.
          const redeemed = await tem.execute<{ id: string }[]>(
            `update discount_codes set used_count = used_count + 1
              where id = ? and removed_at is null returning id`,
            [discount.code.id],
          );
          if (redeemed.length === 0) {
            throw new BadRequestException('This discount code is no longer available');
          }
        }
        tem.persist(order);
        // Flush INSIDE the transaction, after every order and item write is
        // staged: the database generates the order's UUID, so reading
        // `order.id` before this point returns undefined on a fresh creation
        // — proven against real PostgreSQL by legacy-conversion.pg.spec.ts.
        // A failure after this line still rolls the whole transaction back.
        await tem.flush();
        return { orderNumber: order.orderNumber, totalUsd: order.totalUsd, id: order.id };
      });
    } catch (error) {
      // Two same-key retries can race past the lookup above; the per-store
      // unique index turns the loser into "return the winner's order"
      if (key && error instanceof UniqueConstraintViolationException) {
        const existing = await this.orderRepository.findOne({ store: storeId, idempotencyKey: key });
        if (existing) {
          return { orderNumber: existing.orderNumber, totalUsd: existing.totalUsd, id: existing.id };
        }
      }
      throw error;
    }
  }

  /**
   * #160's oversell fix did not go away — it moved.
   *
   * `takeStock` used to be one conditional statement here; the same guarantee
   * now lives in the posting mechanism, where `CHECK (quantity >= 0)` refuses
   * the draw under the row lock. The property is identical and still proved by
   * `oversell-concurrency.pg.spec.ts`; what B3 added is that the units are
   * recorded leaving, by whom, and under which order.
   */

  /**
   * The tenant filter every panel order query is built on (P5-A2 family 5).
   * See `InvoicesService.scopedStoreWhere` — same contract, same reason: the
   * old `if (actor.store) … else if (storeId) …` fell through to an unfiltered
   * query for a store-less actor and trusted any branch it named.
   *
   * The public storefront path (`createFromWebsite`) is untouched: it is not a
   * panel actor and carries its own store from the public route.
   */
  private scopedStoreWhere(scope: TenantScope | undefined, requestedStoreId?: string): Record<string, unknown> {
    const organizationId = requireOrganizationScope(scope);
    const narrowedTo = scope?.storeId;
    if (typeof narrowedTo === 'string' && narrowedTo.length > 0) {
      if (requestedStoreId && requestedStoreId !== narrowedTo) {
        throw new NotFoundException('Order not found');
      }
      return { store: narrowedTo };
    }
    if (requestedStoreId) return { store: resolveScopedStoreTarget(scope, requestedStoreId) };
    return { store: { organization: organizationId } };
  }

  async findAll(scope: TenantScope | undefined, status?: string, page = 1, limit = 25, storeId?: string) {
    const where: Record<string, unknown> = { ...this.scopedStoreWhere(scope, storeId) };
    if (status) where.status = status;
    const [orders, total] = await this.orderRepository.findAndCount(where, {
      populate: ['store', 'items'],
      orderBy: { createdAt: QueryOrder.DESC },
      limit: Math.min(100, limit),
      offset: (Math.max(1, page) - 1) * limit,
    });
    return {
      items: orders.map((o) => this.toDto(o)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  async findOne(scope: TenantScope | undefined, id: string) {
    const where: Record<string, unknown> = { id, ...this.scopedStoreWhere(scope) };
    const order = await this.orderRepository.findOne(where, { populate: ['store', 'items'] });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return this.toDto(order);
  }

  async setStatus(scope: TenantScope | undefined, actor: Actor, id: string, status: string) {
    if (!Object.values(SalesOrderStatus).includes(status as SalesOrderStatus)) {
      throw new BadRequestException(`Unknown status '${status}'`);
    }
    const where: Record<string, unknown> = { id, ...this.scopedStoreWhere(scope) };
    const order = await this.orderRepository.findOne(where, {
      populate: ['store', 'items', 'items.product'],
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    const before = order.status;
    order.status = status;

    // Inventory follows the order's life: cancelling puts back exactly what
    // was taken; reviving a cancelled order takes it again — atomically, with
    // the same "enough stock or nothing" rule as the checkout itself (#160).
    // Explicit begin/commit so the stock movements and the order's own row
    // land (or roll back) together.
    const em = this.orderRepository.getEntityManager();
    await em.begin();
    try {
      // Stock only ever moves on branch pivots. Order rows are never
      // rewritten; an item whose product is gone simply has no stock home.
      const stockTargetFor = async (item: SalesOrderItem): Promise<StoreProduct | null> => {
        return item.product ? em.findOne(StoreProduct, { store: order.store.id, product: item.product.id }) : null;
      };
      // P5-B3: cancelling returns the units through the ledger and reactivating
      // draws them again, so a cancel/reactivate cycle leaves a readable trail
      // instead of two silent column edits. The refusal on reactivation is
      // unchanged, wording included.
      const organizationId = ((order.store as any)?.organization?.id ?? (order.store as any)?.organization ?? null) as
        | string
        | null;
      if (before !== SalesOrderStatus.CANCELLED && status === SalesOrderStatus.CANCELLED) {
        for (const item of order.items.getItems()) {
          if (item.stockDeducted > 0) {
            // Stock goes back to the branch it was taken from (P0-06)
            const target = await stockTargetFor(item);
            if (target && organizationId && item.product) {
              await this.stock.restoreFromCancellation(em, {
                organizationId,
                storeId: order.store.id,
                productId: item.product.id,
                quantity: item.stockDeducted,
                salesOrderId: order.id,
                idempotencyScope: `order:${order.id}`,
              });
            }
            item.stockDeducted = 0;
          }
        }
      } else if (before === SalesOrderStatus.CANCELLED && status !== SalesOrderStatus.CANCELLED) {
        for (const item of order.items.getItems()) {
          const target = await stockTargetFor(item);
          if (target?.trackInventory && organizationId && item.product) {
            const taken = await this.stock.issueForSale(em, {
              organizationId,
              storeId: order.store.id,
              productId: item.product.id,
              quantity: item.quantity,
              salesOrderId: order.id,
              idempotencyScope: `order:${order.id}`,
            });
            if (!taken) {
              throw new BadRequestException(
                `Not enough stock to reactivate "${item.productName}" — the units were sold while the order was cancelled`,
              );
            }
            item.stockDeducted = item.quantity;
          }
        }
      }
      await em.flush();
      await em.commit();
    } catch (error) {
      await em.rollback();
      // The entity kept the in-memory change; undo it so nothing later in
      // this request can accidentally flush a status the DB refused
      order.status = before;
      throw error;
    }
    await this.auditLogService.recordAuditEntry(
      actor.id,
      actor.email,
      EntityType.STORE,
      order.store.id,
      Action.UPDATE,
      { status: { before, after: status } },
      `Sales order #${order.orderNumber}: ${before} → ${status}`,
      {
        organizationId: (order.organization as any)?.id ?? (order.organization as any) ?? null,
        storeId: (order.store as any)?.id ?? (order.store as any) ?? null,
      },
    );
    return this.toDto(order);
  }

  private toDto(order: SalesOrder) {
    return {
      id: order.id,
      orderNumber: order.orderNumber,
      store: { id: order.store.id, name: order.store.name },
      status: order.status,
      customerName: order.customerName ?? null,
      customerPhone: order.customerPhone ?? null,
      totalUsd: order.totalUsd,
      discountCode: order.discountCode ?? null,
      discountUsd: order.discountUsd ?? '0.00',
      createdAt: order.createdAt,
      items: order.items.getItems().map((item) => ({
        productName: item.productName,
        variantName: item.variantName ?? null,
        unitPriceUsd: item.unitPriceUsd,
        quantity: item.quantity,
      })),
    };
  }
}
