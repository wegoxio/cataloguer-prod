import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { StoresService } from './stores.service';
import { CreateStoreDto, UpdateStoreDto } from './dto/store.dto';
import { SetStorePlanDto } from './dto/store-admin.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { isUnscopedPlatform, TenantScope } from '../auth/tenancy/tenant-scope';

/**
 * P5-A2 family 2. Authorization derives from the resolved TenantScope
 * (`req.scope`, set for every authenticated request in JwtAuthGuard) and never
 * from `req.user.store`. `req.user` is passed on ONLY as the audit actor.
 *
 * Every route carries an explicit, complete @Roles list: RolesGuard treats a
 * method list as a REPLACEMENT for the class list, and an absent list as
 * "every authenticated role" — so an undecorated read is an unstated decision,
 * not a safe default.
 *
 * §12 / ADR 014 authority:
 *   store structure (create/update/archive/restore) . SUPER_ADMIN, OM
 *   website content and pop-ups ..................... SUPER_ADMIN, OM, ADMIN (own store)
 *   organization subscription ....................... SUPER_ADMIN, OM
 *   plans, add-ons, cross-client overview ........... unscoped SUPER_ADMIN only
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('stores')
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  /**
   * A REFUSED REMOVAL IS A 409, and the audit still survives — the identical
   * note stands in `products.controller.ts`. The service's transaction, and the
   * blocked audit row inside it, has committed before this runs, so throwing
   * here cannot roll the evidence back.
   */

  /** Platform-lifecycle routes require the platform owner acting globally. */
  private assertPlatformOwner(scope: TenantScope | undefined): void {
    if (!isUnscopedPlatform(scope)) {
      throw new ForbiddenException('Access denied: this is a platform-owner operation');
    }
  }

  // Readable by every authenticated role: powers "View on site" links and
  // the Website page for editors/viewers too.
  @Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN', 'EDITOR', 'VIEWER')
  @Get()
  async findAll(@Req() req: any, @Query('includeArchived') includeArchived?: string) {
    const stores = await this.storesService.findAll(includeArchived === 'true', req.scope);
    return { data: stores };
  }

  // A Cataloguer subscription belongs to the ORGANIZATION; ADMIN, EDITOR and
  // VIEWER hold no billing authority, and narrowing to a branch never changes
  // which organization is described.
  @Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER')
  @Get('subscription')
  async subscription(@Req() req: any) {
    return { data: await this.storesService.getSubscription(req.scope) };
  }

  // Platform-owner control panel: cross-client plans, modules and revenue.
  @Roles('SUPER_ADMIN')
  @Get('overview')
  async overview(@Req() req: any) {
    this.assertPlatformOwner(req.scope);
    return { data: await this.storesService.getOwnerOverview() };
  }

  // Editing website content is admin-only (P2-01, #164): VIEWER (and EDITOR)
  // are read-only for the site — they keep getContent above, not this.
  // Pop-up history: every pop-up this website has run — browsable, and any
  // entry can be made the live pop-up again.
  // Commercial plan of a client: sold by the platform, never self-served.
  @Roles('SUPER_ADMIN')
  @Patch(':id/plan')
  async setPlan(@Req() req: any, @Param('id') id: string, @Body() body: SetStorePlanDto) {
    this.assertPlatformOwner(req.scope);
    const store = await this.storesService.setPlan(id, body.plan, req.user);
    return { data: store };
  }

  // Store structure (§12): organization-level authority. ADMIN holds none.
  @Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER')
  @Post()
  async create(@Req() req: any, @Body() dto: CreateStoreDto) {
    return { data: await this.storesService.create(dto, req.scope, req.user) };
  }

  @Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER')
  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateStoreDto) {
    return { data: await this.storesService.update(id, dto, req.scope, req.user) };
  }

  @Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER')
  @Patch(':id/archive')
  async archive(@Req() req: any, @Param('id') id: string) {
    return { data: await this.storesService.archive(id, req.scope, req.user) };
  }

  @Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER')
  @Patch(':id/restore')
  async restore(@Req() req: any, @Param('id') id: string) {
    return { data: await this.storesService.restore(id, req.scope, req.user) };
  }

}
