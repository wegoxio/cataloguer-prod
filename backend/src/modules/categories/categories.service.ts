import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { Category, MAX_CATEGORY_DEPTH } from './entities/category.entity';
import { TenantScope, isOrganizationAdministrator } from '../auth/tenancy/tenant-scope';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { Actor } from '../audit-log/types/actor.type';
import { EntityType, Action } from '../audit-log/entities/audit-log.entity';

@Injectable()
export class CategoriesService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: EntityRepository<Category>,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * Resolve a category UNDER the caller's authority (Phase 4).
   *
   * Every by-id mutation goes through here, so the controller's tenant
   * assertion is no longer the only boundary: a route that forgets it — as
   * PATCH /categories/:id did — still cannot reach another company's row.
   * A foreign category answers exactly like one that does not exist.
   *
   * PHASE 4 (corrected): the unscoped platform owner NO LONGER has global
   * reach here. Reading or writing one company's category is a tenant
   * operation, so a platform administrator must name the company through
   * `X-Managed-Organization`; without it the request is malformed, not
   * privileged. Genuine platform administration — listing organizations,
   * creating one, creating its first administrator — is unaffected, because
   * none of those are category operations.
   */
  private async resolveCategory(scope: TenantScope | undefined, id: string, populate = true): Promise<Category> {
    const where: Record<string, unknown> = { id };
    if (!scope?.organizationId) {
      throw new ForbiddenException(
        'This operation requires an organization context; a platform administrator must supply X-Managed-Organization',
      );
    }
    where.organization = scope.organizationId;
    const category = await this.categoryRepository.findOne(
      where as never,
      populate ? { populate: ['parentCategory'] } : undefined,
    );
    if (!category) throw new NotFoundException(`Category with ID ${id} not found`);
    return category;
  }

  /** The organization a category belongs to, however the relation is loaded. */
  private organizationIdOf(category: Category): string | null {
    return (category as any).organization?.id ?? (category as any).organization ?? null;
  }

  /** The branch a category belongs to; null means organization-global. */
  private storeIdOf(entity: { store?: unknown }): string | null {
    return (entity as any).store?.id ?? (entity as any).store ?? null;
  }

  /**
   * A category may only reference a picture its own scope can see.
   *
   * ORGANIZATION: enforced by the composite foreign key too; checked here so
   * the caller gets an answer rather than a constraint violation.
   * BRANCH: an organization-global category may use only an organization-global
   * asset — a single branch's file must not back a company-wide category — and
   * a branch category may use its own or an organization-global one, never a
   * sibling branch's. The database trigger enforces the same rule.
   * TYPE: a category displays a picture, so a non-IMAGE asset is refused.
   */
  /**
   * A parent must be reachable from the child's own branch (Phase 4).
   *
   * Organization equality is not enough: two branches of one company are still
   * separate catalogues. An organization-global category may only sit under an
   * organization-global parent; a branch category may sit under its own branch
   * or under an organization-global one. The database trigger enforces this
   * independently.
   */
  private assertBranchCompatibleParent(childStoreId: string | null, parent: Category): void {
    const parentStoreId = this.storeIdOf(parent);
    if (parentStoreId !== null && parentStoreId !== childStoreId) {
      throw new BadRequestException({
        code: 'CATEGORY_PARENT_WRONG_BRANCH',
        reason: 'That parent belongs to another branch. Choose a company-wide category or one of this branch.',
      });
    }
  }

  /**
   * PHASE 4 (corrected): the catalogue is ORGANIZATION-WIDE.
   *
   * Categories belong to the company, not to a branch. Every store of an
   * organization shares one warehouse, so the listing is scoped by
   * organization and by NOTHING else — a category created from branch A is
   * visible to branch B of the same company by design. `store` records where a
   * category originated; it is not a visibility boundary.
   *
   * This replaces `{ store: storeScopeId }`, which was an equality match and so
   * hid BOTH sibling branches' categories AND every organization-level
   * (`store IS NULL`) category — the shared warehouse existed in the schema and
   * was unreachable from the panel.
   *
   * An organization is REQUIRED. Listing categories is a tenant-specific read,
   * so a platform owner must name the company through `X-Managed-Organization`
   * rather than receiving every company's rows in one page; the previous
   * behaviour returned all organizations' categories to a store-less actor.
   * Genuine platform administration (listing organizations, creating one, or
   * creating its first organization admin) is unaffected — those are not
   * category reads.
   */
  async findAll(options?: {
    organizationScopeId?: string | null;
    search?: string;
    includeArchived?: boolean;
    page?: number;
    limit?: number;
    sortBy?: string;
    sortDirection?: 'asc' | 'desc';
  }): Promise<{ items: Category[]; total: number; page: number; limit: number; totalPages: number }> {
    const andClauses: any[] = [];
    if (!options?.organizationScopeId) {
      throw new ForbiddenException(
        'Listing categories requires an organization context; a platform administrator must supply X-Managed-Organization',
      );
    }
    andClauses.push({ organization: options.organizationScopeId });
    const includeArchived = options?.includeArchived ?? false;
    if (!includeArchived) {
      andClauses.push({ archivedAt: null });
    }

    if (options?.search) {
      andClauses.push({
        $or: [{ name: { $ilike: `%${options.search}%` } }, { slug: { $ilike: `%${options.search}%` } }],
      });
    }

    const where = andClauses.length > 0 ? { $and: andClauses } : {};

    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.min(100, Math.max(1, options?.limit ?? 25));
    const offset = (page - 1) * limit;

    const sortBy = options?.sortBy || 'createdAt';
    const sortDirection = options?.sortDirection || 'desc';

    const [items, total] = await this.categoryRepository.findAndCount(where, {
      populate: ['parentCategory'],
      limit,
      offset,
      orderBy: { [sortBy]: sortDirection },
    });

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findById(scope: TenantScope | undefined, id: string): Promise<Category> {
    return this.resolveCategory(scope, id);
  }

  /**
   * Resolve a category for an INTERNAL assignment flow whose caller has already
   * established the owning organization itself (product writes).
   *
   * Deliberately NOT scope-based. Manufacturing a `TenantScope` to satisfy a
   * signature would feed invented role and branch values into an authorization
   * decision; instead the caller passes the two facts it genuinely holds, and
   * both are enforced here against real data.
   *
   * COMPANY RULE (Phase 4, corrected): products and categories both belong to
   * the ORGANIZATION, so any category of the company may be assigned to any of
   * its products — a sibling branch's included. The only boundary is the
   * company: a foreign organization's category answers as not found.
   *
   * `actorStoreId` is retained in the signature because callers legitimately
   * hold it and it is recorded for provenance, but it deliberately does NOT
   * narrow the result. Refusing a sibling branch's category here was the
   * membership half of the store-as-boundary defect.
   */
  async findAssignableCategory(
    organizationId: string | null,
    _actorStoreId: string | null,
    id: string,
  ): Promise<Category> {
    const category = await this.categoryRepository.findOne({ id }, { populate: ['parentCategory'] });
    if (!category) throw new NotFoundException(`Category with ID ${id} not found`);

    const categoryOrganizationId = this.organizationIdOf(category);
    if (organizationId && categoryOrganizationId && categoryOrganizationId !== organizationId) {
      throw new NotFoundException(`Category with ID ${id} not found`);
    }

    return category;
  }

  async restore(scope: TenantScope | undefined, id: string, actor?: { id: string; email: string }): Promise<Category> {
    this.assertMayRemoveCategories(scope, 'restore');
    const category = await this.resolveCategory(scope, id);
    if (!category.archivedAt) {
      return category;
    }

    if (category.parentCategory) {
      const parent = await this.categoryRepository.findOne({ id: category.parentCategory.id });
      if (parent && parent.archivedAt) {
        throw new BadRequestException('Cannot restore category because its parent category is archived');
      }
    }

    const beforeArchivedAt = category.archivedAt;
    category.archivedAt = undefined;
    await this.categoryRepository.getEntityManager().flush();

    if (actor) {
      await this.auditLogService.recordAuditEntry(
        actor.id,
        actor.email,
        EntityType.CATEGORY,
        category.id,
        Action.RESTORE,
        { archivedAt: { before: beforeArchivedAt, after: null } },
        `Restored category "${category.name}"`,
        { organizationId: (category.organization as any)?.id ?? (category.organization as any) ?? null },
      );
    }

    return category;
  }

  async create(scope: TenantScope | undefined, dto: CreateCategoryDto, actor?: Actor): Promise<Category> {
    // P5-A3: one place derives the acting branch, from the resolved scope.
    const narrowedStoreId = typeof scope?.storeId === 'string' && scope.storeId.length > 0 ? scope.storeId : null;
    // P0-05: a category belongs to a client; its slug is unique within it.
    //
    // Phase 4 made the SCOPE answer first; P5-A3 made it the ONLY answer. The
    // fallback was `organizationIdOfActor(em, actor)`, which derived the
    // company from `actor.store` — a user binding, and null for every
    // store-less actor including a platform admin working inside a company.
    // The scope already knows the company, so the fallback was both dead and
    // an actor-derived tenant lookup; it is gone, and its absence fails closed
    // on the next line.
    const organizationId = scope?.organizationId ?? null;
    if (!organizationId) {
      throw new BadRequestException(
        'Organization context required: choose a company before creating one of its categories',
      );
    }
    const { slugify } = await import('../imports/preview/woocommerce-mapper');
    let autoSlug = slugify(dto.name || '');
    let slugSuffix = 2;
    // Cap the search: beyond 50 collisions fall back to a time suffix
    while (
      autoSlug &&
      slugSuffix <= 50 &&
      (await this.categoryRepository.findOne({
        slug: autoSlug,
        organization: organizationId,
      }))
    ) {
      autoSlug = `${slugify(dto.name)}-${slugSuffix++}`;
    }
    if (slugSuffix > 50) {
      autoSlug = `${slugify(dto.name)}-${Date.now().toString(36)}`;
    }

    let parentCategory: Category | undefined;
    if (dto.parentCategoryId) {
      const parent = await this.categoryRepository.findOne({ id: dto.parentCategoryId });
      if (!parent) {
        throw new BadRequestException('Parent category not found');
      }
      if (parent.archivedAt) {
        throw new BadRequestException('Cannot select an archived category as parent');
      }
      // P0-05: a parent belonging to another organization does not exist here
      const parentOrgId = (parent as any).organization?.id ?? (parent as any).organization ?? null;
      if (parentOrgId && organizationId && parentOrgId !== organizationId) {
        throw new BadRequestException('Parent category not found');
      }
      // A branch category may sit under its own branch or under a
      // company-wide one, never under a sibling branch's (Phase 4).
      // P5-A3: the acting branch is the caller's RESOLVED narrowing, not the
      // person's permanent binding. This decision REFUSES a request, so it may
      // never be sourced from a user field.
      this.assertBranchCompatibleParent(narrowedStoreId, parent);
      parentCategory = parent;
    }

    const category = this.categoryRepository.create({
      organization: organizationId as any,
      // Provenance: the branch this category was created from, which is the
      // caller's resolved narrowing — never the person's own binding.
      store: narrowedStoreId ? (narrowedStoreId as any) : undefined,
      name: dto.name,
      slug: autoSlug,
      description: dto.description,
      metaTitle: dto.metaTitle,
      metaDescription: dto.metaDescription,
      parentCategory,
      kind: dto.kind ?? null,
      publicLabel: dto.publicLabel?.trim() || null,
      sortOrder: dto.sortOrder ?? 0,
      showInNavigation: dto.showInNavigation ?? true,
    });

    await this.categoryRepository.getEntityManager().persistAndFlush(category);
    const result = (await this.categoryRepository.findOne(
      { id: category.id },
      { populate: ['parentCategory'] },
    )) as any;

    if (actor && result) {
      await this.auditLogService.recordAuditEntry(
        actor.id,
        actor.email,
        EntityType.CATEGORY,
        result.id,
        Action.CREATE,
        null,
        `Created category "${result.name}"`,
        { organizationId: (result.organization as any)?.id ?? (result.organization as any) ?? null },
      );
    }

    return result;
  }

  async update(
    scope: TenantScope | undefined,
    id: string,
    dto: UpdateCategoryDto,
    actor?: { id: string; email: string },
  ): Promise<Category> {
    const category = await this.resolveCategory(scope, id);

    const before = {
      name: category.name,
      slug: category.slug,
      description: category.description ?? null,
      metaTitle: category.metaTitle ?? null,
      metaDescription: category.metaDescription ?? null,
      parentCategoryId: category.parentCategory?.id ?? null,
      kind: category.kind ?? null,
      publicLabel: category.publicLabel ?? null,
      sortOrder: category.sortOrder,
      showInNavigation: category.showInNavigation,
    };

    // Slug edits ignored: system-owned

    if (dto.name !== undefined) {
      category.name = dto.name;
    }

    if (dto.description !== undefined) {
      category.description = dto.description;
    }

    if (dto.metaTitle !== undefined) {
      category.metaTitle = dto.metaTitle;
    }

    if (dto.metaDescription !== undefined) {
      category.metaDescription = dto.metaDescription;
    }

    if (dto.parentCategoryId !== undefined) {
      if (dto.parentCategoryId === null) {
        category.parentCategory = undefined;
      } else {
        if (dto.parentCategoryId === id) {
          throw new BadRequestException('A category cannot parent itself');
        }
        const parentCategory = await this.categoryRepository.findOne({ id: dto.parentCategoryId });
        if (!parentCategory) {
          throw new BadRequestException('Parent category not found');
        }
        if (parentCategory.archivedAt) {
          throw new BadRequestException('Cannot select an archived category as parent');
        }
        // P0-05: a parent belonging to another organization does not exist here
        const ownOrgId = (category as any).organization?.id ?? (category as any).organization ?? null;
        const parentOrgId = (parentCategory as any).organization?.id ?? (parentCategory as any).organization ?? null;
        if (ownOrgId && parentOrgId && ownOrgId !== parentOrgId) {
          throw new BadRequestException('Parent category not found');
        }

        // Two branches of one company are separate catalogues (Phase 4).
        this.assertBranchCompatibleParent(this.storeIdOf(category), parentCategory);

        // The ancestor walk is BOUNDED. It used to be open-ended, so a cycle
        // already in the data — or a chain longer than the runtime supports —
        // would have spun forever instead of answering.
        let tempParent: Category | undefined = parentCategory;
        let depth = 0;
        while (tempParent) {
          if (tempParent.id === id) {
            throw new BadRequestException(
              'Circular reference detected: category cannot be parented under any of its descendants',
            );
          }
          if (++depth > MAX_CATEGORY_DEPTH) {
            throw new BadRequestException(
              `Category hierarchy is deeper than ${MAX_CATEGORY_DEPTH} levels; it cannot be walked safely`,
            );
          }
          await this.categoryRepository.populate(tempParent, ['parentCategory']);
          tempParent = tempParent.parentCategory as Category | undefined;
        }

        category.parentCategory = parentCategory;
      }
    }

    if (dto.kind !== undefined) {
      category.kind = dto.kind;
    }
    if (dto.publicLabel !== undefined) {
      category.publicLabel = dto.publicLabel === null ? null : dto.publicLabel.trim() || null;
    }
    if (dto.sortOrder !== undefined) {
      category.sortOrder = dto.sortOrder;
    }
    if (dto.showInNavigation !== undefined) {
      category.showInNavigation = dto.showInNavigation;
    }
    await this.categoryRepository.getEntityManager().flush();

    if (actor) {
      const changes: Record<string, any> = {};
      if (before.name !== category.name) {
        changes.name = { before: before.name, after: category.name };
      }
      if (before.slug !== category.slug) {
        changes.slug = { before: before.slug, after: category.slug };
      }
      const newDesc = category.description ?? null;
      if (before.description !== newDesc) {
        changes.description = { before: before.description, after: newDesc };
      }
      const newMetaTitle = category.metaTitle ?? null;
      if (before.metaTitle !== newMetaTitle) {
        changes.metaTitle = { before: before.metaTitle, after: newMetaTitle };
      }
      const newMetaDescription = category.metaDescription ?? null;
      if (before.metaDescription !== newMetaDescription) {
        changes.metaDescription = { before: before.metaDescription, after: newMetaDescription };
      }
      const newParentCatId = category.parentCategory?.id ?? null;
      if (before.parentCategoryId !== newParentCatId) {
        changes.parentCategoryId = { before: before.parentCategoryId, after: newParentCatId };
      }
      const newKind = category.kind ?? null;
      if (before.kind !== newKind) {
        changes.kind = { before: before.kind, after: newKind };
      }
      const newPublicLabel = category.publicLabel ?? null;
      if (before.publicLabel !== newPublicLabel) {
        changes.publicLabel = { before: before.publicLabel, after: newPublicLabel };
      }
      if (before.sortOrder !== category.sortOrder) {
        changes.sortOrder = { before: before.sortOrder, after: category.sortOrder };
      }
      if (before.showInNavigation !== category.showInNavigation) {
        changes.showInNavigation = { before: before.showInNavigation, after: category.showInNavigation };
      }
      if (Object.keys(changes).length > 0) {
        await this.auditLogService.recordAuditEntry(
          actor.id,
          actor.email,
          EntityType.CATEGORY,
          category.id,
          Action.UPDATE,
          changes,
          `Updated category "${category.name}"${dto.source === 'builder' ? ' via Builder' : ''}`,
          { organizationId: (category.organization as any)?.id ?? (category.organization as any) ?? null },
        );
      }
    }

    return category;
  }

  /**
   * PHASE 4: removing a category is an ORGANIZATION ADMINISTRATOR act.
   *
   * The catalogue is shared company-wide, so a branch admin archiving a
   * category would silently remove it from every sibling branch that relies on
   * it. Creating, reading, updating and using categories stay open to branch
   * admins; archive, restore and permanent delete do not.
   *
   * Enforced here AND in the controller on purpose — two independent
   * boundaries, the same reason `PATCH /categories/:id` shipping without its
   * assertion did not become a cross-company write.
   */
  private assertMayRemoveCategories(scope: TenantScope | undefined, action: string): void {
    if (!isOrganizationAdministrator(scope)) {
      throw new ForbiddenException(
        `Only an organization administrator may ${action} a category — it is shared by every store in the company`,
      );
    }
  }

  async archive(scope: TenantScope | undefined, id: string, actor?: { id: string; email: string }): Promise<Category> {
    this.assertMayRemoveCategories(scope, 'archive');
    const category = await this.resolveCategory(scope, id, false);
    const beforeArchivedAt = category.archivedAt ?? null;
    category.archivedAt = new Date();
    await this.categoryRepository.getEntityManager().flush();

    if (actor) {
      await this.auditLogService.recordAuditEntry(
        actor.id,
        actor.email,
        EntityType.CATEGORY,
        category.id,
        Action.ARCHIVE,
        { archivedAt: { before: beforeArchivedAt, after: category.archivedAt } },
        `Archived category "${category.name}"`,
        { organizationId: (category.organization as any)?.id ?? (category.organization as any) ?? null },
      );
    }

    return category;
  }
}
