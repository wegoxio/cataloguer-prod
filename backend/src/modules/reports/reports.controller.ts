import { BadRequestException, Controller, Get, NotFoundException, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ReportsService } from './reports.service';
import { scopeAllowsStore } from '../auth/tenancy/tenant-scope';

/**
 * Multi-branch reports, always inside ONE organization (P0-08).
 *
 * `storeIds` narrows the aggregate to some of the actor's branches. Every id
 * is checked against the scope: a branch of another organization 404s exactly
 * like a nonexistent one, and a branch-level actor can only name its own.
 */
/**
 * P5-A2 family 7. The route carried NO `@Roles` at all, and an absent list
 * admits every authenticated role — so VIEWER could read organization-wide
 * revenue. Reports are commercial data: organization authority sees the
 * company, ADMIN its own branch, EDITOR and VIEWER nothing.
 */
const REPORT_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN'] as const;

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...REPORT_ROLES)
@Controller('reports')
export class ReportsController {
  constructor(private readonly reportsService: ReportsService) {}

  @Get('summary')
  async summary(@Req() req: any, @Query('storeIds') storeIdsRaw?: string) {
    const scope = req.scope;
    // Reports are tenant data: the platform owner must enter a company
    // (X-Managed-Organization) to see one — there is no cross-client report.
    if (!scope?.organizationId) {
      throw new BadRequestException('Reports require an organization context');
    }

    const requested = (storeIdsRaw ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const storeId of requested) {
      // NARROWING BINDS (family 7). `scopeAllowsStore` tests `allowedStoreIds`,
      // which for a narrowed organization actor still lists every branch of the
      // company — so a narrowed actor could read a SIBLING branch's report by
      // naming it here. The selected branch is now the only nameable one.
      if (scope.storeId && storeId !== scope.storeId) {
        throw new NotFoundException(`Store with ID ${storeId} not found`);
      }
      if (!scopeAllowsStore(scope, storeId)) {
        throw new NotFoundException(`Store with ID ${storeId} not found`);
      }
    }

    // No explicit selection: a branch-bound actor reports on its branch,
    // a company-level actor on the whole organization
    const storeIds = requested.length > 0 ? requested : scope.storeId ? [scope.storeId] : [];
    return { data: await this.reportsService.summary(scope.organizationId, storeIds) };
  }
}
