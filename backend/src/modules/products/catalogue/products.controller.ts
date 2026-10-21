import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Param,
  UseGuards,
  Query,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { ProductsService, ProductListFilters } from './products.service';
import { ProductFamilyService } from '../families/product-family.service';
import { CreateProductDto } from '../dto/create-product.dto';
import { CreateFamilyDto } from '../dto/create-family.dto';
import { UpdateProductDto } from '../dto/update-product.dto';
import { BranchAssignmentDto } from '../dto/branch-assignment.dto';
import { AddFamilyMemberDto, UpdateFamilyMemberDto } from '../dto/family-member.dto';
import { DismissSuggestionDto } from '../dto/dismiss-suggestion.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { ProductStatus } from './product-status.enum';
import { EntityManager } from '@mikro-orm/postgresql';
import {
  assertCategoryInOrganization,
  assertProductInOrganization,
  assertStoreInOrganization,
  resolveStoresInScope,
} from '../../auth/tenancy/tenant-assertions';
import { isOrganizationAdministrator } from '../../auth/tenancy/tenant-scope';

/**
 * P5-A2 family 4. ADR 014 gives ORGANIZATION_MANAGER FULL authority over
 * products, families and catalogue information — including product archival —
 * inside its own organization. Every write here read `SUPER_ADMIN | ADMIN` and
 * excluded the very role the contract names, while the sibling catalogue
 * controllers (fields, documents, relations, categories) already admitted it.
 *
 * Only the role list changes: tenancy was migrated earlier, so every mutation
 * still proves the product belongs to the caller's organization through
 * `assertProductInOrganization`, and a narrowed actor is still refused when it
 * tries to re-link stores.
 *
 * P5-A2 CANONICAL FAMILY 7 adds the second half the contract requires:
 * ARCHIVAL PREDICATE NORMALIZATION. Archive, restore and permanent delete are
 * ORGANIZATION ADMINISTRATOR acts — a product is shared by every store in the
 * company, so a branch admin removing one takes it away from its siblings, and
 * a narrowed actor is acting AS a branch. The role list alone cannot express
 * that (`ADMIN` is a branch-level role and narrowing is invisible to it), so
 * the same scope-and-role predicate the categories controller already applies
 * is applied here — `categories.controller.ts:98-124` is the reference.
 */
const CATALOGUE_ADMIN_ROLES = ['SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN'] as const;

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('products')
export class ProductsController {
  constructor(
    private readonly productsService: ProductsService,
    private readonly productFamilyService: ProductFamilyService,
    private readonly em: EntityManager,
  ) {}

  /**
   * A REFUSED REMOVAL IS A 409, and the audit still survives.
   *
   * The service returned rather than threw, so its transaction — carrying the
   * blocked audit row — has already committed by the time this line runs.
   * Throwing here cannot undo it, so the refusal is reported as a refusal.
   */

  /** Every id the request supplies is validated against req.scope (P0-07). */
  private async assertBodyIds(
    req: any,
    dto: { storeIds?: string[]; categoryIds?: string[]; categoryId?: string | null },
  ) {
    // Resolved under the caller's authority, not merely checked for existence:
    // a branch actor naming a sibling branch gets the same not-found as a
    // store that does not exist.
    await resolveStoresInScope(this.em, req.scope, dto.storeIds);
    const categoryIds = dto.categoryIds ?? (dto.categoryId ? [dto.categoryId] : []);
    for (const categoryId of categoryIds) {
      await assertCategoryInOrganization(this.em, req.scope, categoryId);
    }
  }

  @Get()
  async findAll(
    @Req() req: any,
    @Query('search') search?: string,
    @Query('status') status?: ProductStatus,
    @Query('categoryId') categoryId?: string,
    @Query('trackInventory') trackInventory?: string,
    @Query('hasChildren') hasChildren?: string,
    @Query('family') family?: string,
    @Query('includeArchived') includeArchived?: string,
    @Query('minPrice') minPrice?: string,
    @Query('maxPrice') maxPrice?: string,
    @Query('hasSalePrice') hasSalePrice?: string,
    @Query('hasImages') hasImages?: string,
    @Query('hasCategory') hasCategory?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortDirection') sortDirection?: 'asc' | 'desc',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('storeId') storeId?: string,
    @Query('lowStock') lowStock?: string,
    @Query('sellable') sellable?: string,
    /** Omit family parents: they are cards, never line items. */
    @Query('excludeParents') excludeParents?: string,
    @Query('complete') complete?: string,
    /** Published (`true`) or hidden (`false`) ON the `storeId` website (ADR 029). */
    @Query('branchPublished') branchPublished?: string,
  ) {
    if (storeId) await assertStoreInOrganization(this.em, req.scope, storeId);
    return this.productsService.findAll(
      this.toFilters(req, {
        search,
        status,
        categoryId,
        trackInventory,
        hasChildren,
        family,
        includeArchived,
        minPrice,
        maxPrice,
        hasSalePrice,
        hasImages,
        hasCategory,
        sortBy,
        sortDirection,
        page,
        limit,
        storeId,
        lowStock,
        sellable,
        excludeParents,
        complete,
        branchPublished,
      }),
    );
  }

  /**
   * Every product id matching the current filters — powers the list's
   * "select everything that matches" across pages.
   *
   * `total` is how many products match, counted WITHOUT the cap, and
   * `truncated` says the returned list is shorter than that. Both are
   * additive. `total` used to be the returned list's own length, which a
   * client could not tell apart from a complete answer: a filter matching
   * more than the cap looked like a complete selection of exactly the cap,
   * and a bulk action would have run on an arbitrary part of it.
   */
  @Get('ids')
  async findIds(@Req() req: any, @Query() query: Record<string, string>) {
    if (query.storeId) await assertStoreInOrganization(this.em, req.scope, query.storeId);
    return this.productsService.findMatchingIdSnapshot(this.toFilters(req, query));
  }

  /**
   * Items that look like one parent in several children, not yet grouped.
   *
   * `data` STAYS AN ARRAY. The deployed dashboard reads `data.length` for its
   * attention tile and maps `data` for its list; making `data` an object to
   * hold the counts would break both the moment the backend shipped ahead of
   * the frontend, which is the order every rollout here uses. The counts are
   * siblings instead — additive, ignored by a client that does not know them.
   *
   * `readyCount` is what may be described as waiting to be grouped. A BLOCKED
   * suggestion is still useful discovery and is still returned, but counting it
   * as actionable would promise something the create endpoint would refuse.
   */
  @Get('family-suggestions')
  async familySuggestions(@Req() req: any) {
    const suggestions = await this.productsService.findFamilySuggestions(
      req.scope?.organizationId ?? null,
      req.scope?.storeId ?? undefined,
    );
    return {
      data: suggestions,
      readyCount: suggestions.filter((s) => s.readiness === 'READY').length,
      blockedCount: suggestions.filter((s) => s.readiness === 'BLOCKED').length,
    };
  }

  /**
   * "No" is remembered: this family name is never suggested again (phase 2).
   *
   * The SAME authority manual grouping needs, because this is a persistent
   * organization-wide write — and the same resolved scope the list is read
   * under, so a platform owner working inside a client dismisses FOR that
   * client rather than into a bucket the client never reads.
   */
  @Roles(...CATALOGUE_ADMIN_ROLES)
  @Post('family-suggestions/dismiss')
  async dismissFamilySuggestion(@Req() req: any, @Body() dto: DismissSuggestionDto) {
    return {
      data: await this.productsService.dismissFamilySuggestion(
        dto.name,
        req.scope?.organizationId ?? null,
        req.scope?.storeId ?? undefined,
      ),
    };
  }

  /**
   * Files existing products into ONE family: a parent card is created and the
   * named products become its children. The only hierarchy written is
   * `products.parent_id`.
   */
  @Roles(...CATALOGUE_ADMIN_ROLES)
  @Post('families')
  async createFamily(@Req() req: any, @Body() body: CreateFamilyDto) {
    for (const member of body.members ?? []) {
      await assertProductInOrganization(this.em, req.scope, member.id);
    }
    return {
      data: await this.productsService.createFamily(
        body.name,
        body.members,
        req.user,
        req.scope?.storeId ?? null,
        {
          description: body.description,
          metaTitle: body.metaTitle,
          metaDescription: body.metaDescription,
        },
        // The company this creation TEACHES, resolved by the request rather
        // than read off the actor, so a managed owner's lesson lands in the
        // client's vocabulary and not in a null bucket.
        req.scope?.organizationId ?? null,
      ),
    };
  }

  /**
   * Advisory check: would this grouping be accepted?
   *
   * A dedicated route rather than a flag on the mutation, so nothing can create
   * a family by forgetting a query parameter. It writes nothing and its answer
   * can go stale; `POST families` re-checks inside its transaction and that
   * answer is the authoritative one.
   */
  @Roles(...CATALOGUE_ADMIN_ROLES)
  @Post('families/validate')
  async validateFamily(@Req() req: any, @Body() body: CreateFamilyDto) {
    for (const member of body.members ?? []) {
      await assertProductInOrganization(this.em, req.scope, member.id);
    }
    return {
      data: await this.productsService.validateFamilyCreation(body.name, body.members, req.scope?.storeId ?? null),
    };
  }

  // Family management (P0-15): the :id is always the model (parent)
  @Roles(...CATALOGUE_ADMIN_ROLES)
  @Post(':id/family/members')
  async addFamilyMember(@Req() req: any, @Param('id') id: string, @Body() dto: AddFamilyMemberDto) {
    await assertProductInOrganization(this.em, req.scope, id);
    await assertProductInOrganization(this.em, req.scope, dto.productId);
    return { data: await this.productFamilyService.addMember(id, dto, req.user, req.scope) };
  }

  @Roles(...CATALOGUE_ADMIN_ROLES)
  @Patch(':id/family/members/:memberId')
  async updateFamilyMember(
    @Req() req: any,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateFamilyMemberDto,
  ) {
    await assertProductInOrganization(this.em, req.scope, id);
    return { data: await this.productFamilyService.updateMemberLabel(id, memberId, dto, req.user, req.scope) };
  }

  @Roles(...CATALOGUE_ADMIN_ROLES)
  @Delete(':id/family/members/:memberId')
  async removeFamilyMember(@Req() req: any, @Param('id') id: string, @Param('memberId') memberId: string) {
    await assertProductInOrganization(this.em, req.scope, id);
    return { data: await this.productFamilyService.removeMember(id, memberId, req.user, req.scope) };
  }

  @Roles(...CATALOGUE_ADMIN_ROLES)
  @Delete(':id/family')
  async dissolveFamily(@Req() req: any, @Param('id') id: string) {
    await assertProductInOrganization(this.em, req.scope, id);
    return { data: await this.productFamilyService.dissolve(id, req.user, req.scope) };
  }

  // One branch's view of a product (P0-06): assign/update without touching
  // other branches. PUT because it is an upsert on (product, store).
  @Roles(...CATALOGUE_ADMIN_ROLES)
  @Put(':id/stores/:storeId')
  async assignToStore(
    @Req() req: any,
    @Param('id') id: string,
    @Param('storeId') storeId: string,
    @Body() dto: BranchAssignmentDto,
  ) {
    await assertProductInOrganization(this.em, req.scope, id);
    // Resolved under the caller's authority: a sibling branch is not a
    // branch actor's to publish in, and refusing looks like "no such store".
    await resolveStoresInScope(this.em, req.scope, [storeId]);
    return { data: await this.productsService.assignToStore(id, storeId, dto, req.user) };
  }

  @Roles(...CATALOGUE_ADMIN_ROLES)
  @Delete(':id/stores/:storeId')
  async removeFromStore(@Req() req: any, @Param('id') id: string, @Param('storeId') storeId: string) {
    await assertProductInOrganization(this.em, req.scope, id);
    // Detaching from a sibling branch is equally out of reach.
    await resolveStoresInScope(this.em, req.scope, [storeId]);
    await this.productsService.removeFromStore(id, storeId, req.user);
    return { data: { removed: true } };
  }

  // Query strings → typed filters (shared by list + select-all)
  private toFilters(req: any, q: Record<string, any>): ProductListFilters {
    const bool = (v: any) => (v === undefined ? undefined : v === 'true');
    return {
      // Tenant boundary for list filters (P0-05): req.scope is built by the
      // guard since P0-03. Full controller migration to scope is #197.
      organizationId: req.scope?.organizationId ?? undefined,
      // Store-bound users are always walled to their own store; the
      // unscoped owner may narrow to one website (Overview tab counts)
      // PHASE 4: only an EXPLICIT store filter narrows the list. Deriving it
      // from `req.user.store` made the branch a tenant boundary, hiding the
      // company's shared catalogue from its own store admins.
      storeFilterId: q.storeId,
      search: q.search,
      status: q.status,
      categoryId: q.categoryId,
      trackInventory: bool(q.trackInventory),
      lowStock: q.lowStock === 'true',
      // One filter, two spellings, and the SAME rule as the write path: either
      // name alone is honoured, both agreeing is honoured, both disagreeing is
      // refused rather than silently resolved.
      hasChildren: bool(q.hasChildren),
      family: ['parent', 'child', 'standalone'].includes(q.family) ? q.family : undefined,
      includeArchived: q.includeArchived === 'true',
      minPrice: q.minPrice ? parseFloat(q.minPrice) : undefined,
      maxPrice: q.maxPrice ? parseFloat(q.maxPrice) : undefined,
      hasSalePrice: bool(q.hasSalePrice),
      hasImages: bool(q.hasImages),
      hasCategory: bool(q.hasCategory),
      sellable: bool(q.sellable),
      excludeParents: bool(q.excludeParents),
      complete: bool(q.complete),
      branchPublished: bool(q.branchPublished),
      sortBy: q.sortBy,
      sortDirection: q.sortDirection,
      page: q.page ? parseInt(q.page, 10) : undefined,
      limit: q.limit ? parseInt(q.limit, 10) : undefined,
    };
  }

  @Get(':id')
  async findById(@Req() req: any, @Param('id') id: string) {
    await assertProductInOrganization(this.em, req.scope, id);
    const product = await this.productsService.findById(id, req.scope?.organizationId ?? null);
    return { data: product };
  }

  @Roles(...CATALOGUE_ADMIN_ROLES)
  @Post()
  async create(@Req() req: any, @Body() body: CreateProductDto) {
    const createProductDto = body;
    await this.assertBodyIds(req, createProductDto);
    // P5-A2 canonical family 7: a narrowed caller's new product lands in the
    // branch its SCOPE names. `assertBodyIds` has already resolved any
    // explicitly requested branches under the caller's authority, so this only
    // supplies the default the service used to take from `actor.store`.
    const narrowedTo = req.scope?.storeId;
    const dto =
      createProductDto.storeIds === undefined || createProductDto.storeIds.length === 0
        ? { ...createProductDto, storeIds: typeof narrowedTo === 'string' && narrowedTo ? [narrowedTo] : undefined }
        : createProductDto;
    const product = await this.productsService.create(
      dto as CreateProductDto,
      req.user,
      typeof narrowedTo === 'string' && narrowedTo ? narrowedTo : null,
      req.scope?.organizationId ?? null,
    );
    return { data: product };
  }

  @Roles(...CATALOGUE_ADMIN_ROLES)
  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() body: UpdateProductDto) {
    const updateProductDto = body;
    await assertProductInOrganization(this.em, req.scope, id);
    // `storeIds` REPLACES the whole membership set, so a branch actor using it
    // could attach the product to a sibling branch and detach it from every
    // other — a company-wide effect from a branch-scoped actor. The operation
    // is refused outright rather than reinterpreted as a scoped delta, and no
    // store id is examined, so nothing about sibling membership leaks.
    if (updateProductDto.storeIds !== undefined && req.scope?.storeId != null) {
      throw new ForbiddenException(
        'Replacing store membership is a company-wide operation. Use the single-store assignment endpoints instead.',
      );
    }
    await this.assertBodyIds(req, updateProductDto);
    const product = await this.productsService.update(
      id,
      updateProductDto,
      req.scope?.organizationId ?? null,
      req.user,
      req.scope?.storeId ?? null,
    );
    return { data: product };
  }

  @Roles(...CATALOGUE_ADMIN_ROLES)
  @Patch(':id/archive')
  async archive(@Req() req: any, @Param('id') id: string) {
    this.assertOrganizationAdministrator(req, 'archive');
    await assertProductInOrganization(this.em, req.scope, id);
    const product = await this.productsService.archive(id, req.scope?.organizationId ?? null, req.user);
    return { data: product };
  }

  @Roles(...CATALOGUE_ADMIN_ROLES)
  @Patch(':id/restore')
  async restore(@Req() req: any, @Param('id') id: string) {
    this.assertOrganizationAdministrator(req, 'restore');
    await assertProductInOrganization(this.em, req.scope, id);
    const product = await this.productsService.restore(id, req.scope?.organizationId ?? null, req.user);
    return { data: product };
  }

  /**
   * The scope-and-role predicate behind archive, restore and permanent delete
   * (P5-A2 canonical family 7). Identical in shape and wording to the
   * categories controller's, because it is the same rule about the same kind
   * of shared, organization-owned record.
   *
   *   ORGANIZATION_MANAGER, own company, un-narrowed .... yes
   *   SUPER_ADMIN + X-Managed-Organization, un-narrowed . yes
   *   SUPER_ADMIN unscoped .............................. no — names no company
   *   anyone NARROWED to one branch ..................... no — acting as a branch
   *   ADMIN ............................................. no — a branch role
   */
  private assertOrganizationAdministrator(req: any, action: string): void {
    if (!isOrganizationAdministrator(req.scope)) {
      throw new ForbiddenException(
        `Only an organization administrator may ${action} a product — it is shared by every store in the company`,
      );
    }
  }
}
