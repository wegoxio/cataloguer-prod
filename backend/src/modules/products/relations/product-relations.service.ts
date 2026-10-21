import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql';
import { ProductRelation, ProductRelationType } from '../entities/product-relation.entity';
import { Product } from '../entities/product.entity';
import { TenantScope, hasOrganizationWideAuthority, scopeAllowsStore } from '../../auth/tenancy/tenant-scope';
import {
  CreateProductRelationDto,
  DeleteProductRelationDto,
  UpdateProductRelationDto,
} from '../dto/product-relation.dto';

const notFound = (what: string) => new NotFoundException(`${what} not found`);

/** Postgres unique-violation. The signal that a concurrent request won. */
const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(error: unknown): boolean {
  const code = (error as any)?.code ?? (error as any)?.originalError?.code ?? (error as any)?.cause?.code;
  return code === UNIQUE_VIOLATION;
}

/**
 * Directed product suggestions (Phase 3).
 *
 * DIRECTED, NOT SYMMETRIC. Each edge is its own statement with its own type
 * and its own position, so a reciprocal pair is two rows. They are written in
 * ONE transaction — either both suggestions exist or neither does — and only
 * when the caller explicitly asks; nothing is inferred from a single edge.
 *
 * IDEMPOTENT UNDER CONCURRENCY. Two identical requests racing each other both
 * try to insert the same (source, target, type). The database's unique index
 * settles it: the loser catches the violation, re-reads the winning row and
 * returns it. Repeating a create therefore converges instead of erroring, and
 * no duplicate edge can exist even under a race the service never sees.
 *
 * AUTHORITY mirrors documents and Phase 2 field values: writes need
 * company-wide access, reads are open to branch-bound actors for products
 * their own branch shows.
 */
@Injectable()
export class ProductRelationsService {
  constructor(
    @InjectRepository(ProductRelation)
    private readonly relationRepository: EntityRepository<ProductRelation>,
    private readonly em: EntityManager,
  ) {}

  private organizationOf(scope: TenantScope | undefined): string {
    const organizationId = scope?.organizationId ?? null;
    if (!organizationId) {
      throw new BadRequestException('Organization context required: choose a company before managing its relations');
    }
    return organizationId;
  }

  private assertOrgWide(scope: TenantScope | undefined): void {
    if (!hasOrganizationWideAuthority(scope)) {
      throw new BadRequestException(
        'Product relations belong to the whole company catalogue, so they can only be changed with company-wide access.',
      );
    }
  }

  private async resolveProduct(scope: TenantScope | undefined, productId: string): Promise<Product> {
    const organization = this.organizationOf(scope);
    const product = await this.em.findOne(Product, { id: productId, organization });
    if (!product) throw notFound('Product');
    if (!hasOrganizationWideAuthority(scope)) {
      const storeId = scope?.storeId ?? null;
      if (!storeId || !scopeAllowsStore(scope, storeId)) throw notFound('Product');
      const visible = await this.em.count(Product, { id: productId, organization, stores: storeId });
      if (visible === 0) throw notFound('Product');
    }
    return product;
  }

  async list(scope: TenantScope | undefined, productId: string) {
    await this.resolveProduct(scope, productId);
    const relations = await this.relationRepository.find(
      { sourceProduct: productId },
      { populate: ['targetProduct'] as never, orderBy: { sortOrder: 'ASC', createdAt: 'ASC', id: 'ASC' } },
    );
    return relations.map((relation) => this.toDto(relation));
  }

  async create(scope: TenantScope | undefined, productId: string, dto: CreateProductRelationDto) {
    this.assertOrgWide(scope);
    const organizationId = this.organizationOf(scope);
    const source = await this.resolveProduct(scope, productId);

    if (dto.targetProductId === productId) {
      throw new BadRequestException({
        code: 'RELATION_SELF_LINK',
        reason: 'A product cannot suggest itself.',
      });
    }
    // The target must belong to the same company. A foreign id is a 404 —
    // indistinguishable from one that does not exist, so the endpoint never
    // becomes a probe for another company's catalogue.
    const target = await this.em.findOne(Product, { id: dto.targetProductId, organization: organizationId });
    if (!target) throw notFound('Product');

    return this.em.transactional(async (tem) => {
      const forward = await this.upsertEdge(tem, organizationId, source.id, target.id, dto.type, dto.sortOrder ?? 0);
      let reciprocal: ProductRelation | null = null;
      if (dto.reciprocal) {
        reciprocal = await this.upsertEdge(tem, organizationId, target.id, source.id, dto.type, dto.sortOrder ?? 0);
      }
      return {
        ...this.toDto(forward, target),
        reciprocalRelationId: reciprocal?.id ?? null,
      };
    });
  }

  /**
   * Insert-or-return for one edge. The unique index is the arbiter: on a
   * collision the existing row is returned unchanged, which is what makes a
   * repeated or concurrent create converge rather than fail.
   */
  private async upsertEdge(
    tem: EntityManager,
    organizationId: string,
    sourceId: string,
    targetId: string,
    type: ProductRelationType,
    sortOrder: number,
  ): Promise<ProductRelation> {
    const existing = await tem.findOne(ProductRelation, {
      sourceProduct: sourceId,
      targetProduct: targetId,
      type,
    });
    if (existing) return existing;

    const relation = tem.create(ProductRelation, {
      organization: organizationId as any,
      sourceProduct: sourceId as any,
      targetProduct: targetId as any,
      type,
      sortOrder,
    } as any);
    try {
      await tem.persistAndFlush(relation);
      return relation;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent request created exactly this edge between our read and
      // our insert. Its row is as good as ours would have been.
      const winner = await tem.findOne(ProductRelation, {
        sourceProduct: sourceId,
        targetProduct: targetId,
        type,
      });
      if (!winner) throw error;
      return winner;
    }
  }

  /** Updates exactly the addressed edge; the mirror is a separate statement. */
  async update(scope: TenantScope | undefined, productId: string, relationId: string, dto: UpdateProductRelationDto) {
    this.assertOrgWide(scope);
    await this.resolveProduct(scope, productId);
    const relation = await this.relationRepository.findOne(
      { id: relationId, sourceProduct: productId },
      { populate: ['targetProduct'] as never },
    );
    if (!relation) throw notFound('Relation');

    if (dto.type !== undefined) relation.type = dto.type;
    if (dto.sortOrder !== undefined) relation.sortOrder = dto.sortOrder;
    await this.em.flush();
    return this.toDto(relation);
  }

  /**
   * Removes the addressed edge. The mirror survives unless explicitly
   * included, and is reported either way so the caller knows what remains.
   */
  async remove(
    scope: TenantScope | undefined,
    productId: string,
    relationId: string,
    dto: DeleteProductRelationDto = {},
  ) {
    this.assertOrgWide(scope);
    await this.resolveProduct(scope, productId);
    const relation = await this.relationRepository.findOne({ id: relationId, sourceProduct: productId });
    if (!relation) throw notFound('Relation');

    const targetId = (relation.targetProduct as any)?.id ?? (relation.targetProduct as any);
    const type = relation.type;

    return this.em.transactional(async (tem) => {
      const mirror = await tem.findOne(ProductRelation, {
        sourceProduct: targetId,
        targetProduct: productId,
        type,
      });
      const managed = await tem.findOne(ProductRelation, { id: relationId });
      if (managed) tem.remove(managed);
      let removedReciprocal = false;
      if (mirror && dto.includeReciprocal) {
        tem.remove(mirror);
        removedReciprocal = true;
      }
      await tem.flush();
      return {
        removed: true,
        removedReciprocal,
        // Null once it is gone; otherwise the caller learns the mirror is
        // still there rather than assuming a cascade that never happened.
        remainingReciprocalRelationId: mirror && !removedReciprocal ? mirror.id : null,
      };
    });
  }

  private toDto(relation: ProductRelation, target?: Product) {
    const resolved = (target ?? (relation.targetProduct as any)) as Product | undefined;
    return {
      id: relation.id,
      targetProductId: resolved?.id ?? (relation.targetProduct as any as string),
      targetName: resolved?.name ?? null,
      targetSlug: resolved?.slug ?? null,
      type: relation.type,
      sortOrder: relation.sortOrder,
    };
  }
}
