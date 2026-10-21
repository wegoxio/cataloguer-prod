import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { DiscountsService, DiscountCodeInput } from './discounts.service';

/**
 * Per-website discount management (website module → Descuentos tab).
 *
 * P5-A2 family 5 (D-5.3): ORGANIZATION_MANAGER administers discounts for the
 * branches of its own company; ADMIN stays on its exact branch; EDITOR and
 * VIEWER are refused; an unscoped platform owner must enter a managed company
 * first. The `:storeId` in the path is validated against the resolved scope by
 * the service — it used to be trusted whenever the caller had no store binding.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN')
@Controller('stores/:storeId/discounts')
export class DiscountsController {
  constructor(private readonly discounts: DiscountsService) {}

  @Get()
  async list(@Req() req: any, @Param('storeId') storeId: string) {
    return { data: await this.discounts.list(req.scope, storeId) };
  }

  @Post()
  async create(@Req() req: any, @Param('storeId') storeId: string, @Body() body: DiscountCodeInput) {
    return { data: await this.discounts.create(req.scope, storeId, body) };
  }

  @Patch(':id')
  async update(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('id') id: string,
    @Body() body: Partial<DiscountCodeInput>,
  ) {
    return { data: await this.discounts.update(req.scope, storeId, id, body) };
  }

}
