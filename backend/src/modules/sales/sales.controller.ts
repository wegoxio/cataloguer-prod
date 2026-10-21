import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { SalesService } from './sales.service';
import { CreateManualSaleDto } from './dto/create-manual-sale.dto';
import { SetSaleStatusDto } from './dto/set-sale-status.dto';
import { EntityManager } from '@mikro-orm/postgresql';
import { assertStoreInOrganization } from '../auth/tenancy/tenant-assertions';

/**
 * P5-A2 family 5. The resolved scope, not the session user, decides which
 * orders exist for this caller; ORGANIZATION_MANAGER joins the contract per
 * ADR 014 (customer orders are organization data), EDITOR keeps its existing
 * work bound to its own branch, and VIEWER stays excluded as before.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN', 'EDITOR')
@Controller('sales')
export class SalesController {
  constructor(
    private readonly salesService: SalesService,
    private readonly em: EntityManager,
  ) {}

  @Get()
  async findAll(
    @Req() req: any,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('storeId') storeId?: string,
  ) {
    if (storeId) await assertStoreInOrganization(this.em, req.scope, storeId);
    return this.salesService.findAll(
      req.scope,
      status || undefined,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 25,
      storeId,
    );
  }

  // Single order detail: powers "create invoice from this sale"
  @Get(':id')
  async findOne(@Req() req: any, @Param('id') id: string) {
    return { data: await this.salesService.findOne(req.scope, id) };
  }

  // Manual entry: sales agreed by phone or in person
  @Post()
  async createManual(@Req() req: any, @Body() body: CreateManualSaleDto) {
    return { data: await this.salesService.createManual(req.scope, req.user, body) };
  }

  @Patch(':id/status')
  async setStatus(@Req() req: any, @Param('id') id: string, @Body() body: SetSaleStatusDto) {
    return { data: await this.salesService.setStatus(req.scope, req.user, id, body.status) };
  }
}
