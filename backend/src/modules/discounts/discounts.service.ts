import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, QueryOrder } from '@mikro-orm/postgresql';
import { DiscountCode } from './entities/discount-code.entity';
import { TenantScope } from '../auth/tenancy/tenant-scope';
import { resolveScopedStoreTarget } from '../auth/tenancy/tenant-assertions';

export interface CartLine {
  productId: string;
  categoryId?: string | null;
  unit: number;
  quantity: number;
}

export interface DiscountResult {
  code: DiscountCode | null;
  codeText: string | null;
  discountUsd: number;
  reason?: string;
}

export interface DiscountCodeInput {
  code: string;
  type: 'PERCENT' | 'FIXED';
  value: number;
  appliesTo: 'ORDER' | 'PRODUCTS' | 'CATEGORIES';
  productIds?: string[];
  categoryIds?: string[];
  minOrderUsd?: number | null;
  maxUses?: number | null;
  expiresAt?: string | null;
  active?: boolean;
}

@Injectable()
export class DiscountsService {
  constructor(
    @InjectRepository(DiscountCode)
    private readonly repo: EntityRepository<DiscountCode>,
  ) {}

  /**
   * The branch this call may touch (P5-A2 family 5, D-5.3).
   *
   * It was `if (actor?.store && actor.store.id !== storeId) throw` — which
   * refused nothing at all for a STORE-LESS actor: an organization manager, or
   * a platform session, could name ANY `:storeId` in the URL and create,
   * rewrite or delete another company's discount codes. Authority now comes
   * from the resolved scope, which refuses an unscoped owner outright and
   * holds every organization actor to a branch its scope allows.
   */
  private requireStore(scope: TenantScope | undefined, storeId: string): string {
    return resolveScopedStoreTarget(scope, storeId);
  }

  async list(scope: TenantScope | undefined, storeId: string): Promise<DiscountCode[]> {
    this.requireStore(scope, storeId);
    return this.repo.find({ store: storeId }, { orderBy: { createdAt: QueryOrder.DESC } });
  }

  async create(scope: TenantScope | undefined, storeId: string, dto: DiscountCodeInput): Promise<DiscountCode> {
    this.requireStore(scope, storeId);
    const code = this.normalizeCode(dto.code);
    // #295 G2: live codes only — the filter hides removed ones, and the partial
    // unique index releases their text, so the two agree about what is taken.
    const existing = await this.repo.findOne({ store: storeId, code });
    if (existing) {
      throw new BadRequestException('A discount with that code already exists');
    }
    const entity = this.repo.create({
      store: storeId as any,
      code,
      type: dto.type === 'FIXED' ? 'FIXED' : 'PERCENT',
      value: this.cleanValue(dto).toFixed(2),
      appliesTo: this.cleanAppliesTo(dto.appliesTo),
      productIds: dto.appliesTo === 'PRODUCTS' ? (dto.productIds ?? []) : [],
      categoryIds: dto.appliesTo === 'CATEGORIES' ? (dto.categoryIds ?? []) : [],
      minOrderUsd: dto.minOrderUsd ? Number(dto.minOrderUsd).toFixed(2) : undefined,
      maxUses: dto.maxUses ?? undefined,
      usedCount: 0,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      active: dto.active !== false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await this.repo.getEntityManager().persistAndFlush(entity);
    return entity;
  }

  async update(
    scope: TenantScope | undefined,
    storeId: string,
    id: string,
    dto: Partial<DiscountCodeInput>,
  ): Promise<DiscountCode> {
    this.requireStore(scope, storeId);
    const entity = await this.repo.findOne({ id, store: storeId });
    if (!entity) throw new NotFoundException('Discount not found');
    if (dto.code !== undefined) {
      const code = this.normalizeCode(dto.code);
      const clash = await this.repo.findOne({ store: storeId, code, id: { $ne: id } });
      if (clash) throw new BadRequestException('A discount with that code already exists');
      entity.code = code;
    }
    if (dto.type !== undefined) entity.type = dto.type === 'FIXED' ? 'FIXED' : 'PERCENT';
    if (dto.value !== undefined)
      entity.value = this.cleanValue({ ...dto, type: dto.type ?? (entity.type as any) } as DiscountCodeInput).toFixed(
        2,
      );
    if (dto.appliesTo !== undefined) {
      entity.appliesTo = this.cleanAppliesTo(dto.appliesTo);
      entity.productIds = entity.appliesTo === 'PRODUCTS' ? (dto.productIds ?? entity.productIds) : [];
      entity.categoryIds = entity.appliesTo === 'CATEGORIES' ? (dto.categoryIds ?? entity.categoryIds) : [];
    } else {
      if (dto.productIds !== undefined && entity.appliesTo === 'PRODUCTS') entity.productIds = dto.productIds;
      if (dto.categoryIds !== undefined && entity.appliesTo === 'CATEGORIES') entity.categoryIds = dto.categoryIds;
    }
    if (dto.minOrderUsd !== undefined)
      entity.minOrderUsd = dto.minOrderUsd ? Number(dto.minOrderUsd).toFixed(2) : undefined;
    if (dto.maxUses !== undefined) entity.maxUses = dto.maxUses ?? undefined;
    if (dto.expiresAt !== undefined) entity.expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : undefined;
    if (dto.active !== undefined) entity.active = dto.active;
    await this.repo.getEntityManager().flush();
    return entity;
  }

  /**
   * Computes the discount a code grants on a priced cart. Pure w.r.t. the
   * lines (prices already resolved server-side by the caller). Both the
   * public preview and order creation call this so they never disagree.
   */
  async compute(storeId: string, codeText: string, lines: CartLine[], total: number): Promise<DiscountResult> {
    const code = codeText?.trim()
      ? await this.repo.findOne({ store: storeId, code: this.normalizeCode(codeText) })
      : null;
    if (!code) return { code: null, codeText: null, discountUsd: 0, reason: 'not_found' };
    if (!code.active) return { code: null, codeText: null, discountUsd: 0, reason: 'inactive' };
    if (code.expiresAt && code.expiresAt.getTime() <= Date.now())
      return { code: null, codeText: null, discountUsd: 0, reason: 'expired' };
    if (code.maxUses != null && code.usedCount >= code.maxUses)
      return { code: null, codeText: null, discountUsd: 0, reason: 'exhausted' };
    if (code.minOrderUsd != null && total < Number(code.minOrderUsd))
      return { code: null, codeText: null, discountUsd: 0, reason: 'min_order' };

    // The portion of the cart the code applies to
    let eligible = total;
    if (code.appliesTo === 'PRODUCTS') {
      eligible = lines
        .filter((l) => code.productIds.includes(l.productId))
        .reduce((sum, l) => sum + l.unit * l.quantity, 0);
    } else if (code.appliesTo === 'CATEGORIES') {
      eligible = lines
        .filter((l) => l.categoryId && code.categoryIds.includes(l.categoryId))
        .reduce((sum, l) => sum + l.unit * l.quantity, 0);
    }
    if (eligible <= 0) return { code: null, codeText: null, discountUsd: 0, reason: 'no_eligible_items' };

    const value = Number(code.value);
    const raw = code.type === 'PERCENT' ? (eligible * value) / 100 : Math.min(value, eligible);
    const discountUsd = Math.min(total, Math.round(raw * 100) / 100);
    return { code, codeText: code.code, discountUsd };
  }

  private normalizeCode(code: string): string {
    return (code || '').trim().toUpperCase().slice(0, 40);
  }

  private cleanValue(dto: DiscountCodeInput): number {
    const v = Number(dto.value);
    if (!Number.isFinite(v) || v <= 0) throw new BadRequestException('Discount value must be greater than zero');
    if (dto.type === 'PERCENT' && v > 100) throw new BadRequestException('A percentage discount cannot exceed 100%');
    return v;
  }

  private cleanAppliesTo(appliesTo: string): string {
    return ['ORDER', 'PRODUCTS', 'CATEGORIES'].includes(appliesTo) ? appliesTo : 'ORDER';
  }
}
