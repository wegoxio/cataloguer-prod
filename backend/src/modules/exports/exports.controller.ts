import { Controller, Get, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { ExportsService } from './exports.service';
import { requireOrganizationScope } from '../auth/tenancy/tenant-assertions';

/**
 * P5-A2 family 4 (D-4.3). Export is READ-ONLY and returns the caller's own
 * organization catalogue, which ADMIN may already read in the panel — so ADMIN
 * keeps it and ORGANIZATION_MANAGER gains it. The import workflow next door is
 * deliberately narrower.
 *
 * P5-A2 CANONICAL FAMILY 7 closes the tenant-boundary defect the role widening
 * left behind: `req.scope?.organizationId ?? undefined` fell through to a
 * service that filtered CONDITIONALLY, so an unscoped platform session
 * downloaded EVERY company's categories and products in one CSV. A read is
 * still a tenant read; the company is mandatory, and a platform administrator
 * names it through `X-Managed-Organization`.
 */
const CATALOGUE_EXPORT_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN'] as const;

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('export')
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  @Roles(...CATALOGUE_EXPORT_ROLES)
  @Get('categories')
  async exportCategories(@Req() req: any, @Res() res: Response) {
    // P0-07: an export is the actor's catalogue, never the platform's
    const csv = await this.exportsService.exportCategories(requireOrganizationScope(req.scope));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="categories.csv"');
    return res.send(csv);
  }

  @Roles(...CATALOGUE_EXPORT_ROLES)
  @Get('products')
  async exportProducts(@Req() req: any, @Res() res: Response) {
    const csv = await this.exportsService.exportProducts(requireOrganizationScope(req.scope));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="products.csv"');
    return res.send(csv);
  }
}
