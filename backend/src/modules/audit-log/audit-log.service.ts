import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityManager, EntityRepository, QueryOrder } from '@mikro-orm/postgresql';
import { AuditContext } from './types/audit-context.type';
import { AuditLog, EntityType, Action } from './entities/audit-log.entity';

/**
 * The viewer's tenant identity for listing (P5-A2 family 1). Rows are matched
 * by their STORED affected-resource context (#203):
 *
 *  - 'store'        — exact organization AND exact store (ADMIN, or a platform
 *                     actor narrowed to one store). Never sees sibling-store,
 *                     organization-level (store_id IS NULL), platform-level,
 *                     foreign-organization, or legacy unresolved rows.
 *  - 'organization' — every row of ONE organization, store-level and
 *                     organization-level alike (ORGANIZATION_MANAGER, or the
 *                     platform owner under a managed organization). Never sees
 *                     platform-level, foreign-organization, or legacy null rows.
 *
 * The unfiltered platform view is `undefined`, so a tenant view can never
 * express a null organization at the type level.
 */
export type AuditTenantView =
  | { kind: 'store'; organizationId: string; storeId: string }
  | { kind: 'organization'; organizationId: string };

export interface AuditLogFilters {
  entityType?: EntityType;
  entityId?: string;
  actorEmail?: string;
  action?: Action;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
}

@Injectable()
export class AuditLogService {
  constructor(
    @InjectRepository(AuditLog)
    private readonly auditLogRepository: EntityRepository<AuditLog>,
  ) {}

  async recordAuditEntry(
    actorUserId: string | null | undefined,
    actorEmail: string | null | undefined,
    entityType: EntityType,
    entityId: string,
    action: Action,
    changes: Record<string, any> | null,
    message: string | null,
    // Required (#171): the AFFECTED RESOURCE's tenant context. Callers derive
    // it from the entity they mutated; { organizationId: null } is an explicit
    // platform-level statement, never a fallback.
    context: AuditContext,
  ): Promise<void> {
    try {
      const entry = this.auditLogRepository.create({
        actorUserId: actorUserId || null,
        actorEmail: actorEmail || null,
        organizationId: context.organizationId ?? null,
        storeId: context.storeId ?? null,
        entityType,
        entityId,
        action,
        changes,
        message,
        createdAt: new Date(),
      });
      // We flush immediately since audit records are individual and independent.
      // Business operations succeed even if audit logging fails (it must not rollback).
      await this.auditLogRepository.getEntityManager().persistAndFlush(entry);
    } catch (err) {
      console.error('Audit log save failed, ignoring to prevent rollback:', err);
    }
  }

  /**
   * The STRICT variant (#248, PR B): writes through the caller's transactional
   * EntityManager and THROWS on failure, so the business write it describes
   * rolls back with it. Used where an unrecorded state change is worse than a
   * retried one — the Stripe webhook transitions, whose retries are safe by
   * construction. Returns the persisted entry so its id can be linked.
   */
  async recordAuditEntryIn(
    em: EntityManager,
    actorUserId: string | null | undefined,
    actorEmail: string | null | undefined,
    entityType: EntityType,
    entityId: string,
    action: Action,
    changes: Record<string, any> | null,
    message: string | null,
    context: AuditContext,
  ): Promise<AuditLog> {
    const entry = em.create(AuditLog, {
      actorUserId: actorUserId || null,
      actorEmail: actorEmail || null,
      organizationId: context.organizationId ?? null,
      storeId: context.storeId ?? null,
      entityType,
      entityId,
      action,
      changes,
      message,
      createdAt: new Date(),
    });
    em.persist(entry);
    await em.flush();
    return entry;
  }

  async findAll(
    filters: AuditLogFilters,
    pagination: PaginationParams,
    tenantView?: AuditTenantView,
  ): Promise<{
    items: AuditLog[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }> {
    const page = pagination.page && pagination.page > 0 ? pagination.page : 1;
    const limit = pagination.limit && pagination.limit > 0 ? Math.min(pagination.limit, 100) : 25;
    const offset = (page - 1) * limit;

    const where: any = {};
    if (tenantView) {
      // #203: tenant views match the rows' STORED affected-resource context —
      // never derived from who acted. Runtime re-validation stays even though
      // the union forbids null at compile time: request state is untrusted,
      // and a malformed view must refuse rather than degrade toward the
      // unfiltered platform view.
      if (typeof tenantView.organizationId !== 'string' || tenantView.organizationId.length === 0) {
        throw new ForbiddenException('Access denied: tenant view without an organization');
      }
      where.organizationId = tenantView.organizationId;
      if (tenantView.kind === 'store') {
        if (typeof tenantView.storeId !== 'string' || tenantView.storeId.length === 0) {
          throw new ForbiddenException('Access denied: store view without a store');
        }
        where.storeId = tenantView.storeId;
      }
    }
    if (filters.entityType) where.entityType = filters.entityType;
    if (filters.entityId) where.entityId = filters.entityId;
    if (filters.actorEmail) where.actorEmail = { $ilike: `%${filters.actorEmail}%` };
    if (filters.action) where.action = filters.action;

    const sortBy = pagination.sortBy || 'createdAt';
    const sortDirection = pagination.sortDirection === 'asc' ? QueryOrder.ASC : QueryOrder.DESC;

    const [items, total] = await this.auditLogRepository.findAndCount(where, {
      limit,
      offset,
      orderBy: { [sortBy]: sortDirection },
    });

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
