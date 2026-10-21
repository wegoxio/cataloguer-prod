import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { ProductFieldsService } from './product-fields.service';
import { CuratedFieldRegistryService } from './curated-field-registry.service';
import {
  CreateProductFieldDto,
  UpdateProductFieldDto,
  UpsertProductFieldValueDto,
  UpsertStoreFieldSettingDto,
} from '../dto/product-field.dto';

/**
 * ORGANIZATION_MANAGER joins every field-administration route (Phase 2,
 * approved): it is the tenant role with company-wide reach, and the value
 * and curated operations already demand company-wide authority at the
 * service layer — a role gate that excluded it made those operations
 * platform-owner-only in practice. The service-level authority checks stay
 * exactly as they are; the role list only stops excluding the one tenant
 * role that can satisfy them.
 */
const FIELD_ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN', 'ORGANIZATION_MANAGER'] as const;

/**
 * The company's field vocabulary (B4a2).
 *
 * Every route reads its tenant from the resolved TenantScope — never from a
 * body, a query parameter or a role string. An actor with no company in
 * context gets 400 ("which company?"), while anything belonging to another
 * company answers 404, indistinguishable from a row that does not exist.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('product-fields')
export class ProductFieldsController {
  constructor(
    private readonly service: ProductFieldsService,
    private readonly curated: CuratedFieldRegistryService,
  ) {}

  @Get()
  async list(@Req() req: any, @Query('includeArchived') includeArchived?: string) {
    return { data: await this.service.listDefinitions(req.scope, includeArchived === 'true') };
  }

  /** The curated registry with this company's activation state. */
  @Get('curated')
  async listCurated(@Req() req: any) {
    return { data: await this.curated.list(req.scope) };
  }

  @Roles(...FIELD_ADMIN_ROLES)
  @Post('curated/:key/activate')
  async activateCurated(@Req() req: any, @Param('key') key: string) {
    return { data: await this.curated.activate(req.scope, key) };
  }

  /** Adopts a compatible existing CUSTOM field as the curated entry. */
  @Roles(...FIELD_ADMIN_ROLES)
  @Post('curated/:key/adopt')
  async adoptCurated(@Req() req: any, @Param('key') key: string) {
    return { data: await this.curated.adopt(req.scope, key) };
  }

  @Roles(...FIELD_ADMIN_ROLES)
  @Post()
  async create(@Req() req: any, @Body() dto: CreateProductFieldDto) {
    return { data: await this.service.createDefinition(req.scope, dto) };
  }

  /** `key`, `type` and `source` are absent from the DTO — sending any is a 400. */
  @Roles(...FIELD_ADMIN_ROLES)
  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateProductFieldDto) {
    return { data: await this.service.updateDefinition(req.scope, id, dto) };
  }

  @Roles(...FIELD_ADMIN_ROLES)
  @Patch(':id/archive')
  async archive(@Req() req: any, @Param('id') id: string) {
    return { data: await this.service.archiveDefinition(req.scope, id) };
  }

  @Roles(...FIELD_ADMIN_ROLES)
  @Patch(':id/restore')
  async restore(@Req() req: any, @Param('id') id: string) {
    return { data: await this.service.restoreDefinition(req.scope, id) };
  }
}

/** Which of the company's fields ONE branch uses, and how. */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('stores/:storeId/product-fields')
export class StoreFieldSettingsController {
  constructor(private readonly service: ProductFieldsService) {}

  @Get()
  async list(@Req() req: any, @Param('storeId') storeId: string) {
    return { data: await this.service.listStoreSettings(req.scope, storeId) };
  }

  @Roles(...FIELD_ADMIN_ROLES)
  @Put(':definitionId')
  async upsert(
    @Req() req: any,
    @Param('storeId') storeId: string,
    @Param('definitionId') definitionId: string,
    @Body() dto: UpsertStoreFieldSettingDto,
  ) {
    return { data: await this.service.upsertStoreSetting(req.scope, storeId, definitionId, dto) };
  }
}

/**
 * What ONE product answers.
 *
 * Values are product-owned, so every branch showing the product reads the same
 * row. Writing therefore requires company-wide scope; a branch actor may read
 * but not change what a sibling branch sees. Deletion carries the same
 * authority plus the B4a3 publication invariant: a value some branch
 * currently demands of a shown product cannot be removed.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('products/:productId/fields')
export class ProductFieldValuesController {
  constructor(private readonly service: ProductFieldsService) {}

  @Get()
  async list(@Req() req: any, @Param('productId') productId: string) {
    return { data: await this.service.listValues(req.scope, productId) };
  }

  /**
   * The EFFECTIVE answers: direct values completed by inherited family
   * values, each labeled with its source. Direct and effective stay two
   * distinct read surfaces on purpose — the UI must be able to say
   * "inherited from the parent product", not merely display a number.
   */
  @Get('effective')
  async listEffective(@Req() req: any, @Param('productId') productId: string) {
    return { data: await this.service.listEffectiveValues(req.scope, productId) };
  }

  @Roles(...FIELD_ADMIN_ROLES)
  @Put(':definitionId')
  async upsert(
    @Req() req: any,
    @Param('productId') productId: string,
    @Param('definitionId') definitionId: string,
    @Body() dto: UpsertProductFieldValueDto,
  ) {
    return { data: await this.service.upsertValue(req.scope, productId, definitionId, dto) };
  }

  @Roles(...FIELD_ADMIN_ROLES)
  @Delete(':definitionId')
  async remove(@Req() req: any, @Param('productId') productId: string, @Param('definitionId') definitionId: string) {
    await this.service.deleteValue(req.scope, productId, definitionId);
    return { data: { removed: true } };
  }
}
