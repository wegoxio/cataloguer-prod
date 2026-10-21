import { Controller, ForbiddenException, Get, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PublicCatalogueService } from './public-catalogue.service';

/**
 * "Live right now" counts for the panel's Website page (#175 / P2-12).
 *
 * The panel used to read these from `/public/products` and `/public/categories`
 * with a raw admin Bearer token. That path was blocked cross-origin (public
 * CORS never allowed `Authorization`) AND, when it did run, an unscoped admin
 * JWT read the catalogue across every tenant. This endpoint replaces it:
 *
 *  - it is an ordinary authenticated panel route (JwtAuthGuard builds the
 *    validated `req.scope` via TenantScopeService, P0-03), so the panel's own
 *    origin + credentials CORS applies — no `/public` Bearer request remains;
 *  - it reuses PublicCatalogueService, so the numbers still match exactly what
 *    a visitor of that store's website sees;
 *  - it FAILS CLOSED: every actor — SUPER_ADMIN included — needs a validated
 *    organization or store in scope. An unmanaged platform owner has neither
 *    and is refused before any catalogue query runs, so this route can never
 *    return cross-tenant totals.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('catalogue')
export class CatalogueLiveController {
  constructor(private readonly publicCatalogueService: PublicCatalogueService) {}

  @Get('live-counts')
  async liveCounts(@Req() req: any): Promise<{ data: { products: number; categories: number } }> {
    const organizationId = req.scope?.organizationId ?? undefined;
    const storeId = req.scope?.storeId ?? undefined;
    if (!organizationId && !storeId) {
      throw new ForbiddenException('No tenant context to read the catalogue');
    }
    const [products, categories] = await Promise.all([
      this.publicCatalogueService.getProducts({ organizationId, storeId, limit: 1 }),
      this.publicCatalogueService.getCategories({ organizationId, storeId, limit: 1 }),
    ]);
    return { data: { products: products.total, categories: categories.total } };
  }
}
