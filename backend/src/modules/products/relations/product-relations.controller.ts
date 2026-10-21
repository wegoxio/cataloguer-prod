import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { ProductRelationsService } from './product-relations.service';
import {
  CreateProductRelationDto,
  DeleteProductRelationDto,
  UpdateProductRelationDto,
} from '../dto/product-relation.dto';

const RELATION_ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN', 'ORGANIZATION_MANAGER'] as const;

/**
 * A product's suggestions: accessories, similar items, replacements (Phase 3).
 *
 * Every route addresses edges whose SOURCE is this product. The mirror
 * direction lives under the other product's own path, which is what keeps the
 * two statements independently orderable.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('products/:productId/relations')
export class ProductRelationsController {
  constructor(private readonly service: ProductRelationsService) {}

  @Get()
  async list(@Req() req: any, @Param('productId') productId: string) {
    return { data: await this.service.list(req.scope, productId) };
  }

  @Roles(...RELATION_ADMIN_ROLES)
  @Post()
  async create(@Req() req: any, @Param('productId') productId: string, @Body() dto: CreateProductRelationDto) {
    return { data: await this.service.create(req.scope, productId, dto) };
  }

  @Roles(...RELATION_ADMIN_ROLES)
  @Patch(':relationId')
  async update(
    @Req() req: any,
    @Param('productId') productId: string,
    @Param('relationId') relationId: string,
    @Body() dto: UpdateProductRelationDto,
  ) {
    return { data: await this.service.update(req.scope, productId, relationId, dto) };
  }

  @Roles(...RELATION_ADMIN_ROLES)
  @Delete(':relationId')
  async remove(
    @Req() req: any,
    @Param('productId') productId: string,
    @Param('relationId') relationId: string,
    @Body() dto: DeleteProductRelationDto,
  ) {
    return { data: await this.service.remove(req.scope, productId, relationId, dto ?? {}) };
  }
}
