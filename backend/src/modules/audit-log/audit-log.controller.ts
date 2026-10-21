import { ForbiddenException, Req, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuditLogService, AuditTenantView } from './audit-log.service';
import { isOrganizationAdministrator, scopeAllowsStore, TenantScope } from '../auth/tenancy/tenant-scope';
import { EntityType, Action } from './entities/audit-log.entity';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('audit-logs')
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  /**
   * P5-A2 family 1: the tenant view derives from the resolved TenantScope and
   * from NOTHING else — the user object's store binding is never consulted.
   * The grant requires role/scope COHERENCE, not field shape alone; any
   * combination outside the table below refuses.
   *
   *   unscoped platform SUPER_ADMIN ............... unfiltered platform view
   *   OM / platform under managed org ............. organization-wide view
   *   ADMIN, SUPER_ADMIN or OM on an allowed store  exact-store view
   *
   * An ORGANIZATION_MANAGER narrowed to one of its own branches — the resolver
   * legitimately produces this (tenant-scope.service.ts `wantedStore ??
   * ownStore?.id`) — receives the exact-store view of that branch: a
   * RESTRICTION of its normal organization-wide view, never an expansion.
   * Deliberate refusals: ADMIN with no store (store-level role in an
   * organization-shaped scope is incoherent), any store view whose scope lacks
   * an organization or carries an empty store, and any store outside the
   * scope's allowedStoreIds.
   */
  private tenantViewOf(scope: TenantScope | undefined): AuditTenantView | undefined {
    if (!scope) {
      throw new ForbiddenException('Access denied: no tenant scope resolved');
    }
    const { platform, organizationId, storeId, role } = scope;
    // Unfiltered view: only the GENUINE unscoped platform owner — platform
    // flag, pinned role, and no tenant context at all.
    if (platform === true && role === 'SUPER_ADMIN' && organizationId === null && storeId === null) {
      return undefined;
    }
    // Organization-wide view: role-pinned by the shared predicate (OM of its
    // own company, or the platform owner under a managed organization).
    if (isOrganizationAdministrator(scope)) {
      return { kind: 'organization', organizationId: organizationId as string };
    }
    // Exact-store view: a store-appropriate role (or an OM narrowed to an own
    // branch), a real organization, and a store the scope actually allows.
    if (
      typeof storeId === 'string' &&
      storeId.length > 0 &&
      typeof organizationId === 'string' &&
      organizationId.length > 0 &&
      (role === 'ADMIN' || role === 'SUPER_ADMIN' || role === 'ORGANIZATION_MANAGER') &&
      scopeAllowsStore(scope, storeId)
    ) {
      return { kind: 'store', organizationId, storeId };
    }
    throw new ForbiddenException('Access denied: tenant scope does not grant an audit view');
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'ORGANIZATION_MANAGER')
  @Get()
  async findAll(
    @Req() req: any,
    @Query('entityType') entityType?: EntityType,
    @Query('entityId') entityId?: string,
    @Query('actorEmail') actorEmail?: string,
    @Query('action') action?: Action,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDirection') sortDirection?: 'asc' | 'desc',
  ) {
    const tenantView = this.tenantViewOf(req.scope);
    return this.auditLogService.findAll(
      {
        entityType,
        entityId,
        actorEmail,
        action,
      },
      {
        page: page ? parseInt(page, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
        sortBy,
        sortDirection,
      },
      tenantView,
    );
  }
}
