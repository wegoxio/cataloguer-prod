import { Req, Controller, ForbiddenException, Get, UseGuards } from '@nestjs/common';
import { requireOrganizationScope } from '../auth/tenancy/tenant-assertions';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { DashboardMetricsService, MetricsResponse } from './dashboard-metrics.service';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('dashboard-metrics')
export class DashboardMetricsController {
  constructor(private readonly dashboardMetricsService: DashboardMetricsService) {}

  /**
   * P5-A2 family 7 (option A). These counts describe a WHOLE COMPANY, so they
   * belong to organization-wide authority only:
   *
   *   managed SUPER_ADMIN, un-narrowed .... yes
   *   ORGANIZATION_MANAGER, un-narrowed ... yes
   *   either, while NARROWED .............. refused — leave branch context
   *   unscoped SUPER_ADMIN ................ refused — enter a company first
   *   ADMIN / EDITOR / VIEWER ............. refused; ADMIN gets genuine branch
   *                                         numbers from Reports instead
   *
   * The unscoped platform dashboard is a separate future surface of aggregate
   * client/plan statistics; this route must not be repurposed for it.
   */
  @Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER')
  @Get()
  async getMetrics(@Req() req: any): Promise<MetricsResponse> {
    const organizationId = requireOrganizationScope(req.scope);
    if (req.scope?.storeId) {
      throw new ForbiddenException('These metrics describe the whole company; leave the branch selector to see them');
    }
    return this.dashboardMetricsService.getMetrics(organizationId);
  }
}
