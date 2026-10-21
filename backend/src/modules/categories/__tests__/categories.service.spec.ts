import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { EntityManager } from '@mikro-orm/postgresql';
import { CategoriesService } from '../categories.service';
import { Category } from '../entities/category.entity';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { TenantScope } from '../../auth/tenancy/tenant-scope';

/**
 * Every by-id method resolves under a scope now (Phase 4), so the tests carry
 * a real one rather than relying on the service trusting its caller.
 */
const SCOPE: TenantScope = {
  platform: false,
  organizationId: 'org-1',
  storeId: null,
  allowedStoreIds: [],
  role: 'ORGANIZATION_MANAGER',
};

describe('CategoriesService', () => {
  let service: CategoriesService;
  let mockRepo: any;
  let mockEm: any;

  beforeEach(async () => {
    mockRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      create: jest.fn(),
      getEntityManager: jest.fn().mockReturnValue({
        persistAndFlush: jest.fn(),
        flush: jest.fn(),
        findOne: jest.fn(),
      }),
    };

    mockEm = { findOne: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CategoriesService,
        {
          provide: getRepositoryToken(Category),
          useValue: mockRepo,
        },
        {
          provide: EntityManager,
          useValue: mockEm,
        },
        {
          provide: AuditLogService,
          useValue: {
            recordAuditEntry: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CategoriesService>(CategoriesService);
  });

  describe('create', () => {
    it('auto-suffixes the slug when the name collides (slugs are system-owned)', async () => {
      mockRepo.findOne.mockImplementation((where: any) => {
        if (where.slug === 'clothing') return { id: '1', slug: 'clothing' };
        if (where.id) return { id: where.id, slug: 'clothing-2', name: 'Clothing' };
        return null;
      });
      mockRepo.create.mockImplementation((data: any) => ({ id: 'new-cat', ...data }));

      await service.create(SCOPE, { name: 'Clothing' });
      expect(mockRepo.create).toHaveBeenCalledWith(expect.objectContaining({ slug: 'clothing-2' }));
    });

    it('should throw BadRequestException if parent category is archived', async () => {
      mockRepo.findOne.mockImplementation((where: any) => {
        if (where.slug === 'shirts') return null;
        if (where.id === 'parent-id') return { id: 'parent-id', archivedAt: new Date() };
        return null;
      });

      await expect(
        service.create(SCOPE, { name: 'Shirts', slug: 'shirts', parentCategoryId: 'parent-id' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if parent category is not found', async () => {
      mockRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);

      await expect(
        service.create(SCOPE, { name: 'Shirts', slug: 'shirts', parentCategoryId: 'non-existent' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('create resolves its company from the scope (Phase 4)', () => {
    it('refuses when no company is in context rather than writing a tenant-less row', async () => {
      // `organizationIdOfActor` derives the company from the actor's STORE, so
      // it returns null for every store-less actor. The column is NOT NULL, so
      // the old code turned an ordinary create into a 500 at the database.
      const noOrg = { ...SCOPE, organizationId: null };
      await expect(service.create(noOrg, { name: 'Orphan' })).rejects.toThrow(BadRequestException);
      expect(mockRepo.create).not.toHaveBeenCalled();
    });

    it("uses the scope's company for a store-less actor, which previously failed", async () => {
      mockRepo.findOne.mockResolvedValue(null);
      mockRepo.create.mockImplementation((data: any) => ({ id: 'new-cat', ...data }));

      await service.create(SCOPE, { name: 'Sillas' });

      expect(mockRepo.create).toHaveBeenCalledWith(expect.objectContaining({ organization: 'org-1' }));
    });

    it('scopes the slug-collision probe to that company too', async () => {
      mockRepo.findOne.mockResolvedValue(null);
      mockRepo.create.mockImplementation((data: any) => ({ id: 'new-cat', ...data }));

      await service.create(SCOPE, { name: 'Mesas' });

      // A slug is unique per company; probing globally would invent suffixes
      // to dodge another company's rows.
      expect(mockRepo.findOne).toHaveBeenCalledWith(expect.objectContaining({ organization: 'org-1' }));
    });
  });

  describe('update', () => {
    it('should throw BadRequestException if a category tries to parent itself', async () => {
      mockRepo.findOne.mockResolvedValueOnce({ id: 'cat-id', slug: 'clothing' });

      await expect(service.update(SCOPE, 'cat-id', { parentCategoryId: 'cat-id' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if updated parent category is archived', async () => {
      mockRepo.findOne.mockImplementation((where: any) => {
        if (where.id === 'cat-id') return { id: 'cat-id', slug: 'clothing' };
        if (where.id === 'parent-id') return { id: 'parent-id', archivedAt: new Date() };
        return null;
      });

      await expect(service.update(SCOPE, 'cat-id', { parentCategoryId: 'parent-id' })).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if proposed parent is a descendant (indirect circular reference)', async () => {
      const categoryA = { id: 'cat-a', name: 'A', parentCategory: null };
      const categoryB = { id: 'cat-b', name: 'B', parentCategory: categoryA };
      const categoryC = { id: 'cat-c', name: 'C', parentCategory: categoryB };

      mockRepo.findOne.mockImplementation((where: any) => {
        if (where.id === 'cat-a') return categoryA;
        if (where.id === 'cat-c') return categoryC;
        return null;
      });
      mockRepo.populate = jest.fn().mockResolvedValue({});
      mockRepo.getEntityManager.mockReturnValue({
        persistAndFlush: jest.fn(),
        flush: jest.fn(),
        populate: jest.fn().mockResolvedValue({}),
      });

      await expect(service.update(SCOPE, 'cat-a', { parentCategoryId: 'cat-c' })).rejects.toThrow(
        new BadRequestException(
          'Circular reference detected: category cannot be parented under any of its descendants',
        ),
      );
    });
  });
  describe('findAll', () => {
    it('should query categories with archivedAt: null and search term if provided', async () => {
      mockRepo.findAndCount.mockResolvedValueOnce([[{ id: '1', name: 'Shirts' }], 1]);

      const result = await service.findAll({ organizationScopeId: 'org-1', search: 'shirt' });
      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        {
          $and: [
            { organization: 'org-1' },
            { archivedAt: null },
            {
              $or: [{ name: { $ilike: '%shirt%' } }, { slug: { $ilike: '%shirt%' } }],
            },
          ],
        },
        {
          populate: ['parentCategory'],
          limit: 25,
          offset: 0,
          orderBy: { createdAt: 'desc' },
        },
      );
    });

    it('refuses a listing with no organization in scope (Phase 4: fail closed, never global)', async () => {
      await expect(service.findAll()).rejects.toThrow(ForbiddenException);
      await expect(service.findAll({ search: 'shirt' })).rejects.toThrow(ForbiddenException);
      expect(mockRepo.findAndCount).not.toHaveBeenCalled();
    });

    it('should query active categories without search term if empty', async () => {
      mockRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll({ organizationScopeId: 'org-1' });
      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        {
          $and: [{ organization: 'org-1' }, { archivedAt: null }],
        },
        {
          populate: ['parentCategory'],
          limit: 25,
          offset: 0,
          orderBy: { createdAt: 'desc' },
        },
      );
    });

    it('should query active + archived categories if includeArchived is true', async () => {
      mockRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll({ organizationScopeId: 'org-1', search: 'shirt', includeArchived: true });
      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        {
          $and: [
            { organization: 'org-1' },
            {
              $or: [{ name: { $ilike: '%shirt%' } }, { slug: { $ilike: '%shirt%' } }],
            },
          ],
        },
        {
          populate: ['parentCategory'],
          limit: 25,
          offset: 0,
          orderBy: { createdAt: 'desc' },
        },
      );
    });

    it('should support pagination and sorting options', async () => {
      mockRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll({ organizationScopeId: 'org-1', page: 2, limit: 10, sortBy: 'name', sortDirection: 'asc' });
      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        {
          $and: [{ organization: 'org-1' }, { archivedAt: null }],
        },
        {
          populate: ['parentCategory'],
          limit: 10,
          offset: 10,
          orderBy: { name: 'asc' },
        },
      );
    });
  });

  describe('restore', () => {
    it('should remove archivedAt from category', async () => {
      const cat = { id: 'cat-1', name: 'Apparel', archivedAt: new Date() };
      mockRepo.findOne.mockResolvedValueOnce(cat);

      const result = await service.restore(SCOPE, 'cat-1');
      expect(result.archivedAt).toBeUndefined();
    });

    it('should throw BadRequestException if parent category is archived', async () => {
      const cat = { id: 'cat-1', name: 'Shirts', archivedAt: new Date(), parentCategory: { id: 'parent-id' } };
      mockRepo.findOne.mockImplementation((where: any) => {
        if (where.id === 'cat-1') return cat;
        if (where.id === 'parent-id') return { id: 'parent-id', archivedAt: new Date() };
        return null;
      });

      await expect(service.restore(SCOPE, 'cat-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('the service is its own tenant boundary (Phase 4)', () => {
    // PATCH :id shipped without the controller's tenant assertion, and the
    // service resolved by id alone — so a store admin who knew an id could
    // rename another company's category. Both layers refuse independently now,
    // and these tests exercise the SERVICE half without any controller.
    const FOREIGN = 'cat-of-another-company';

    beforeEach(() => {
      // Nothing resolves when the query is scoped to the caller's company.
      mockRepo.findOne.mockResolvedValue(null);
    });

    it('scopes the lookup by organization rather than trusting the caller', async () => {
      await expect(service.findById(SCOPE, FOREIGN)).rejects.toThrow(NotFoundException);
      expect(mockRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ id: FOREIGN, organization: 'org-1' }),
        expect.anything(),
      );
    });

    it.each([
      ['update', () => service.update(SCOPE, FOREIGN, { name: 'Renamed' })],
      ['archive', () => service.archive(SCOPE, FOREIGN)],
      ['restore', () => service.restore(SCOPE, FOREIGN)],
      // #292 retired `hardDelete`; recoverable removal lives in
      // `CategoryRemovalService` and is proved by its own suites.
    ])('%s refuses a category of another company', async (_name, call) => {
      await expect(call()).rejects.toThrow(NotFoundException);
    });

    // Phase 4: removal is an ORGANIZATION ADMINISTRATOR act. A branch admin
    // archiving a shared category would take it away from every sibling store,
    // so the role-and-scope predicate refuses BEFORE any row is even resolved.
    describe.each([
      ['a store-bound ADMIN', { ...SCOPE, role: 'ADMIN', storeId: 'store-1', allowedStoreIds: ['store-1'] }],
      [
        'a store-bound STORE_ADMIN',
        { ...SCOPE, role: 'STORE_ADMIN', storeId: 'store-1', allowedStoreIds: ['store-1'] },
      ],
      ['a SUPER_ADMIN narrowed to one store', { ...SCOPE, platform: true, role: 'SUPER_ADMIN', storeId: 'store-1' }],
      [
        'an unscoped SUPER_ADMIN (no managed organization)',
        {
          platform: true,
          organizationId: null,
          storeId: null,
          allowedStoreIds: [],
          role: 'SUPER_ADMIN',
        } as TenantScope,
      ],
    ])('%s may not remove categories', (_who, scope) => {
      it.each([
        ['archive', () => service.archive(scope as TenantScope, 'cat-1')],
        ['restore', () => service.restore(scope as TenantScope, 'cat-1')],
      ])('%s -> 403', async (_name, call) => {
        await expect(call()).rejects.toThrow(ForbiddenException);
        // Refused before resolution: the repository is never consulted.
        expect(mockRepo.findOne).not.toHaveBeenCalled();
      });
    });

    it('a SUPER_ADMIN acting inside one company (X-Managed-Organization) MAY remove', async () => {
      const managed: TenantScope = {
        platform: true,
        organizationId: 'org-1',
        storeId: null,
        allowedStoreIds: [],
        role: 'SUPER_ADMIN',
      };
      const category: any = { id: 'cat-1', name: 'C', archivedAt: null };
      mockRepo.findOne.mockResolvedValueOnce(category);
      const result = await service.archive(managed, 'cat-1');
      expect(result.archivedAt).toBeInstanceOf(Date);
    });

    it('the permanent delete is GONE from the service surface (#292)', () => {
      // Not merely unreachable from the route: the implementation itself was
      // deleted, so nothing can call it back into existence.
      expect((service as unknown as Record<string, unknown>).hardDelete).toBeUndefined();
      expect((CategoriesService.prototype as unknown as Record<string, unknown>).hardDelete).toBeUndefined();
    });

    it('refuses outright when the caller carries no company at all', async () => {
      // Phase 4: a missing company is a MALFORMED request (403 naming the
      // header), no longer a hidden-resource 404 — and for the unscoped
      // platform owner it is a refusal where global reach used to be.
      const noOrg = { ...SCOPE, organizationId: null };
      await expect(service.update(noOrg, 'any-id', { name: 'X' })).rejects.toThrow(ForbiddenException);
      // It must not fall back to an unscoped query.
      expect(mockRepo.findOne).not.toHaveBeenCalled();
    });
  });

  describe('identity claims do not belong here', () => {
    it('silently ignores the retired variant-group fields on update', async () => {
      // Families live on Product.parent now; a category can no longer be
      // turned into a card. Old payloads must not crash, just do nothing.
      const category: any = { id: 'grp', name: 'Lounge Chair', slug: 'lounge-chair' };
      mockRepo.findOne.mockResolvedValue(category);

      await service.update(SCOPE, 'grp', { isVariantGroup: true, mainProductId: 'p-green' } as any);

      expect((category as any).isVariantGroup).toBeUndefined();
      expect((category as any).mainProduct).toBeUndefined();
    });
  });
});
