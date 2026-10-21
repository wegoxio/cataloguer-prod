import { BadRequestException, Controller, ForbiddenException, Post, Body, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { BulkOperationsService, BulkResult, BulkBranchPublicationResult } from './bulk-operations.service';
import {
  BulkArchiveRestoreDto,
  BulkStatusDto,
  BulkCategoryDto,
  BulkInventoryDto,
  BulkPricingDto,
  BulkStoresDto,
  BulkBranchPublicationDto,
} from './dto/bulk-products.dto';
import { isOrganizationAdministrator } from '../auth/tenancy/tenant-scope';

/**
 * P5-A2 family 4 (D-4.1). Every route here mutates ORGANIZATION-OWNED catalogue
 * data across the whole company: the services receive an organization id and no
 * store filter, so a branch admin running one of these would archive, restore,
 * re-status, re-price or re-link products its own store does not even carry.
 *
 * That is the defect class P5-A0 closed for `POST /bulk/products/category`, and
 * the same rule now governs the rest of the surface: bulk mutation of shared
 * organization data belongs to SUPER_ADMIN (explicitly scoped) and
 * ORGANIZATION_MANAGER only. ADMIN keeps every per-product operation.
 *
 * P5-A2 CANONICAL FAMILY 7 completes it. The role lists above were only half
 * the repair: P5-A0 made the unfiltered global branch unreachable for
 * `POST /bulk/products/category` alone, while its six siblings still passed
 * `req.scope?.organizationId ?? undefined` into services that applied the
 * organization filter CONDITIONALLY. For an unscoped platform session that
 * filter simply disappeared, and one call archived, restored, re-statused,
 * re-priced or re-linked products BY ID ACROSS EVERY COMPANY.
 *
 * The organization is now mandatory on every route through `requireOrganization`
 * — P5-A0's own gate, wording and 400 status unchanged — and the services take
 * a required `string`, so the conditional filter no longer exists to fall
 * through. Archival in bulk additionally obeys the organization-administrator
 * predicate, matching archival of a single product.
 */
const ORGANIZATION_BULK_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER'] as const;

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('bulk/products')
export class BulkOperationsController {
  constructor(private readonly bulkOperationsService: BulkOperationsService) {}

  @Roles(...ORGANIZATION_BULK_ROLES)
  @Post('archive')
  async bulkArchive(@Req() req: any, @Body() dto: BulkArchiveRestoreDto): Promise<BulkResult> {
    this.assertOrganizationAdministrator(req, 'archive');
    return this.bulkOperationsService.bulkArchive(this.requireOrganization(req), dto.ids, req.user);
  }

  @Roles(...ORGANIZATION_BULK_ROLES)
  @Post('restore')
  async bulkRestore(@Req() req: any, @Body() dto: BulkArchiveRestoreDto): Promise<BulkResult> {
    this.assertOrganizationAdministrator(req, 'restore');
    return this.bulkOperationsService.bulkRestore(this.requireOrganization(req), dto.ids, req.user);
  }

  @Roles(...ORGANIZATION_BULK_ROLES)
  @Post('status')
  async bulkStatus(@Req() req: any, @Body() dto: BulkStatusDto): Promise<BulkResult> {
    return this.bulkOperationsService.bulkStatus(this.requireOrganization(req), dto.ids, dto.status, req.user);
  }

  @Roles(...ORGANIZATION_BULK_ROLES)
  @Post('stores')
  async bulkStores(@Req() req: any, @Body() dto: BulkStoresDto): Promise<BulkResult> {
    this.requireOrganization(req);
    // D-4.2: re-linking products to stores is an ORGANIZATION-WIDE act, so a
    // narrowed actor may not perform it — exactly as `PATCH /products/:id`
    // already refuses `storeIds` from an actor working inside one branch. The
    // operation is refused outright rather than reinterpreted as a delta
    // limited to the selected branch.
    if (req.scope?.storeId != null) {
      throw new BadRequestException(
        'Store assignment is an organization-wide operation; leave the branch selector to perform it',
      );
    }
    // The whole scope, not just its organization id: this route names target
    // stores, and those must be resolved under the caller's authority.
    return this.bulkOperationsService.bulkStores(req.scope, dto.ids, dto.storeIds, req.user);
  }

  /**
   * Publish or hide many products on ONE website (ADR 029).
   *
   * This is a write to the branch flag `store_products.published` and nothing
   * else — it never adds a product to a website, never removes one, never
   * touches a card, and never reads the product's global status for writing.
   * Membership-shaped changes stay with `POST /bulk/products/stores`.
   *
   * The whole scope goes to the service, as for `POST /bulk/products/stores`:
   * the target website is resolved under the caller's authority before any
   * product is read, and a foreign, unauthorized or nonexistent store answers
   * "not found" with nothing read or written.
   */
  @Roles(...ORGANIZATION_BULK_ROLES)
  @Post('branch-publication')
  async bulkBranchPublication(
    @Req() req: any,
    @Body() dto: BulkBranchPublicationDto,
  ): Promise<BulkBranchPublicationResult> {
    this.requireOrganization(req);
    return this.bulkOperationsService.bulkBranchPublication(req.scope, dto.ids, dto.storeId, dto.published, req.user);
  }

  @Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER')
  @Post('category')
  async bulkCategory(@Req() req: any, @Body() dto: BulkCategoryDto): Promise<BulkResult> {
    // Organization-owned catalogue data: the affected organization must be
    // explicit for every actor — an organization manager carries its own, a
    // platform administrator names it through X-Managed-Organization.
    const organizationId = this.requireOrganization(req);
    return this.bulkOperationsService.bulkCategory(organizationId, dto.ids, dto.categoryId ?? null, req.user);
  }

  @Roles(...ORGANIZATION_BULK_ROLES)
  @Post('inventory')
  async bulkInventory(@Req() req: any, @Body() dto: BulkInventoryDto): Promise<BulkResult> {
    return this.bulkOperationsService.bulkInventory(
      this.requireOrganization(req),
      dto.ids,
      dto.stockQuantity,
      dto.trackInventory,
      req.user,
    );
  }

  @Roles(...ORGANIZATION_BULK_ROLES)
  @Post('pricing')
  async bulkPricing(@Req() req: any, @Body() dto: BulkPricingDto): Promise<BulkResult> {
    return this.bulkOperationsService.bulkPricing(
      this.requireOrganization(req),
      dto.ids,
      dto.price,
      dto.salePrice,
      dto.cost,
      req.user,
    );
  }

  /**
   * P5-A0's organization-context gate, now shared by ALL SEVEN routes.
   *
   * It guarded `POST /bulk/products/category` alone; its six siblings passed
   * `req.scope?.organizationId ?? undefined` into services whose organization
   * filter was conditional, so for an unscoped platform session the filter
   * vanished and one call reached every company's products by id.
   *
   * The wording and the 400 status are P5-A0's, unchanged: that repair was
   * live-accepted with this exact response, and normalizing the six siblings
   * onto it is a widening of the guard, never a change to the accepted one.
   */
  private requireOrganization(req: any): string {
    const organizationId = req.scope?.organizationId;
    if (typeof organizationId !== 'string' || organizationId.length === 0) {
      throw new BadRequestException(
        'This operation requires an organization context; a platform administrator must supply X-Managed-Organization',
      );
    }
    return organizationId;
  }

  /**
   * Archival in bulk obeys the SAME predicate as archival of one product
   * (`products.controller.ts`): it is an organization-administrator act, so a
   * NARROWED manager is refused. Without this, the per-product rule would be
   * trivially bypassable — one product refused, five hundred allowed.
   *
   * The other bulk routes are edits rather than removals and keep the role
   * list as their boundary, exactly as their per-product counterparts do.
   */
  private assertOrganizationAdministrator(req: any, action: string): void {
    if (!isOrganizationAdministrator(req.scope)) {
      throw new ForbiddenException(
        `Only an organization administrator may ${action} products in bulk — they are shared by every store in the company`,
      );
    }
  }
}
