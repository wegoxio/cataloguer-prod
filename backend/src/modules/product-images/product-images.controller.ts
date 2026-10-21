import { Controller, Get, Post, Patch, Body, Param, UseGuards, Query, Req } from '@nestjs/common';
import { ProductImagesService } from './product-images.service';
import { StorageService, MAX_IMAGE_BYTES } from '../storage/storage.service';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

class CreateUploadUrlDto {
  @IsString()
  @IsOptional()
  extension?: string;

  @IsInt()
  @Min(1)
  @Max(MAX_IMAGE_BYTES)
  size!: number;
}
import { CreateProductImageDto } from './dto/create-product-image.dto';
import { UpdateProductImageDto } from './dto/update-product-image.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { EntityManager } from '@mikro-orm/postgresql';
import { assertProductInOrganization } from '../auth/tenancy/tenant-assertions';
import { productImageAuthorityOf } from '../auth/authorization/product-image-authority';

/**
 * P5-A2 family 4 (D-4.5). A product photo is catalogue information, so it
 * follows the same authority as the product it belongs to: ADR 014's full
 * catalogue grant reaches ORGANIZATION_MANAGER here too.
 *
 * Narrowing does not bind: `assertProductInOrganization` scopes every route to
 * the product's COMPANY, and a photo is not a store-reassignment operation.
 */
const PRODUCT_PHOTO_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN'] as const;

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('products/:productId/images')
export class ProductImagesController {
  constructor(
    private readonly productImagesService: ProductImagesService,
    private readonly storageService: StorageService,
    private readonly em: EntityManager,
  ) {}

  @Get()
  async findAllForProduct(
    @Req() req: any,
    @Param('productId') productId: string,
    @Query('includeArchived') includeArchived?: string,
  ) {
    await assertProductInOrganization(this.em, req.scope, productId);
    const images = await this.productImagesService.findAllForProduct(productId, includeArchived === 'true');
    return { data: images };
  }

  @Get(':id')
  async findById(@Req() req: any, @Param('productId') productId: string, @Param('id') id: string) {
    await assertProductInOrganization(this.em, req.scope, productId);
    const image = await this.productImagesService.findById(productId, id);
    return { data: image };
  }

  // Mints a short-lived presigned PUT (size + type signed in) so the browser
  // uploads the optimized image straight to object storage (ADR 006).
  @Roles(...PRODUCT_PHOTO_ROLES)
  @Post('upload-url')
  async createUploadUrl(@Req() req: any, @Param('productId') productId: string, @Body() body: CreateUploadUrlDto) {
    await assertProductInOrganization(this.em, req.scope, productId);
    const ticket = await this.storageService.createUploadTicket(productId, body.extension, body.size);
    return { data: ticket };
  }

  @Roles(...PRODUCT_PHOTO_ROLES)
  @Post()
  async create(
    @Req() req: any,
    @Param('productId') productId: string,
    @Body() createProductImageDto: CreateProductImageDto,
  ) {
    await assertProductInOrganization(this.em, req.scope, productId);
    const image = await this.productImagesService.create(
      productId,
      createProductImageDto,
      req.user,
      productImageAuthorityOf(req.scope),
    );
    return { data: image };
  }

  @Roles(...PRODUCT_PHOTO_ROLES)
  @Patch(':id')
  async update(
    @Req() req: any,
    @Param('productId') productId: string,
    @Param('id') id: string,
    @Body() updateProductImageDto: UpdateProductImageDto,
  ) {
    await assertProductInOrganization(this.em, req.scope, productId);
    const image = await this.productImagesService.update(productId, id, updateProductImageDto, req.user);
    return { data: image };
  }

  @Roles(...PRODUCT_PHOTO_ROLES)
  @Patch(':id/archive')
  async archive(@Req() req: any, @Param('productId') productId: string, @Param('id') id: string) {
    await assertProductInOrganization(this.em, req.scope, productId);
    const image = await this.productImagesService.archive(productId, id, req.user);
    return { data: image };
  }

  @Roles(...PRODUCT_PHOTO_ROLES)
  @Patch(':id/restore')
  async restore(@Req() req: any, @Param('productId') productId: string, @Param('id') id: string) {
    await assertProductInOrganization(this.em, req.scope, productId);
    const image = await this.productImagesService.restore(productId, id, req.user);
    return { data: image };
  }

  @Roles(...PRODUCT_PHOTO_ROLES)
  @Patch(':id/make-primary')
  async makePrimary(@Req() req: any, @Param('productId') productId: string, @Param('id') id: string) {
    await assertProductInOrganization(this.em, req.scope, productId);
    const image = await this.productImagesService.makePrimary(productId, id, req.user);
    return { data: image };
  }
}
