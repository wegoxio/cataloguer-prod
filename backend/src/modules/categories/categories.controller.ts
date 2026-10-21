import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
  Query,
  Req,
  ForbiddenException,
  Delete,
} from '@nestjs/common';
import { IsInt, IsString, Max, Min } from 'class-validator';
import { isOrganizationAdministrator } from '../auth/tenancy/tenant-scope';
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { EntityManager } from '@mikro-orm/postgresql';
import { assertCategoryInOrganization } from '../auth/tenancy/tenant-assertions';
import { MAX_IMAGE_BYTES, StorageService } from '../storage/storage.service';

class CategoryImageUploadDto {
  @IsString() extension!: string;
  @IsInt() @Min(1) @Max(MAX_IMAGE_BYTES) size!: number;
}

class SetCategoryImageDto {
  @IsString() objectKey!: string;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('categories')
export class CategoriesController {
  constructor(
    private readonly categoriesService: CategoriesService,
    private readonly em: EntityManager,
    private readonly storageService: StorageService,
  ) {}

  /**
   * A REFUSED REMOVAL IS A 409, and the audit still survives — see the identical
   * note in `products.controller.ts`. The service's transaction, carrying the
   * blocked audit row, has committed before this runs.
   */

  @Get()
  async findAll(
    @Req() req: any,
    @Query('search') search?: string,
    @Query('includeArchived') includeArchived?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDirection') sortDirection?: 'asc' | 'desc',
  ) {
    // PHASE 4: the catalogue is organization-wide. The tenant boundary is the
    // company from the resolved scope — never `req.user.store`, which was the
    // defect: it hid sibling branches' categories and every organization-level
    // one, and left a store-less actor unscoped across all companies.
    return this.categoriesService.findAll({
      organizationScopeId: req.scope?.organizationId ?? null,
      search,
      includeArchived: includeArchived === 'true',
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      sortBy,
      sortDirection,
    });
  }

  // The controller assertion and the service's own scoping are two INDEPENDENT
  // boundaries (Phase 4). Keeping both is deliberate: PATCH :id shipped without
  // the assertion, and a service that trusts its caller turned that omission
  // into a cross-company write. Either layer alone now refuses.
  @Get(':id')
  async findById(@Req() req: any, @Param('id') id: string) {
    await assertCategoryInOrganization(this.em, req.scope, id);
    const category = await this.categoriesService.findById(req.scope, id);
    return { data: category };
  }

  // Creating and updating stay open to branch admins — the shared warehouse is
  // meant to be filled from any store. Only removal is restricted.
  @Roles('SUPER_ADMIN', 'ADMIN', 'ORGANIZATION_MANAGER')
  @Post()
  async create(@Req() req: any, @Body() createCategoryDto: CreateCategoryDto) {
    const category = await this.categoriesService.create(req.scope, createCategoryDto, req.user);
    return { data: category };
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'ORGANIZATION_MANAGER')
  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() updateCategoryDto: UpdateCategoryDto) {
    await assertCategoryInOrganization(this.em, req.scope, id);
    const category = await this.categoriesService.update(req.scope, id, updateCategoryDto, req.user);
    return { data: category };
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'ORGANIZATION_MANAGER')
  @Post(':id/image/upload-url')
  async createImageUploadUrl(@Req() req: any, @Param('id') id: string, @Body() body: CategoryImageUploadDto) {
    await assertCategoryInOrganization(this.em, req.scope, id);
    return { data: await this.storageService.createCategoryUploadTicket(id, body.extension, body.size) };
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'ORGANIZATION_MANAGER')
  @Patch(':id/image')
  async setImage(@Req() req: any, @Param('id') id: string, @Body() body: SetCategoryImageDto) {
    await assertCategoryInOrganization(this.em, req.scope, id);
    const imageUrl = await this.storageService.categoryPublicUrl(id, body.objectKey);
    return { data: await this.categoriesService.setImage(req.scope, id, body.objectKey, imageUrl, req.user) };
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'ORGANIZATION_MANAGER')
  @Delete(':id/image')
  async clearImage(@Req() req: any, @Param('id') id: string) {
    await assertCategoryInOrganization(this.em, req.scope, id);
    return { data: await this.categoriesService.setImage(req.scope, id, null, null, req.user) };
  }

  // PHASE 4: archive, restore and permanent delete are ORGANIZATION
  // ADMINISTRATOR acts. A category is shared by every store in the company, so
  // a branch admin removing one would take it away from its siblings. The role
  // list alone is not the boundary — `ADMIN` is a branch-level role — so the
  // scope-and-role predicate is applied here as well as in the service.
  private assertOrganizationAdministrator(req: any, action: string): void {
    if (!isOrganizationAdministrator(req.scope)) {
      throw new ForbiddenException(
        `Only an organization administrator may ${action} a category — it is shared by every store in the company`,
      );
    }
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'ORGANIZATION_MANAGER')
  @Patch(':id/archive')
  async archive(@Req() req: any, @Param('id') id: string) {
    this.assertOrganizationAdministrator(req, 'archive');
    await assertCategoryInOrganization(this.em, req.scope, id);
    const category = await this.categoriesService.archive(req.scope, id, req.user);
    return { data: category };
  }

  @Roles('SUPER_ADMIN', 'ADMIN', 'ORGANIZATION_MANAGER')
  @Patch(':id/restore')
  async restore(@Req() req: any, @Param('id') id: string) {
    this.assertOrganizationAdministrator(req, 'restore');
    await assertCategoryInOrganization(this.em, req.scope, id);
    const category = await this.categoriesService.restore(req.scope, id, req.user);
    return { data: category };
  }
}
