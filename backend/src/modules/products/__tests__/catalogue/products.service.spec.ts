import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ProductsService } from '../../catalogue/products.service';
import { FamilyLearningService } from '../../families/family-learning.service';
import { Product } from '../../entities/product.entity';
import { Category } from '../../../categories/entities/category.entity';
import { CategoriesService } from '../../../categories/categories.service';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ProductStatus } from '../../catalogue/product-status.enum';
import { AuditLogService } from '../../../audit-log/audit-log.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { ProductFieldsService } from '../../fields/product-fields.service';
import { InventoryStockService } from '../../../inventory/ledger/inventory-stock.service';
import { stockDouble } from '../../../../../test/inventory-stock-support';

/** P5-A3: the company is the caller's RESOLVED organization, passed in. */
const ORG = 'org-1';

/** Minimal stand-in for MikroORM's Collection of category folders. */
function folders(initial: any[] = []) {
  let items = [...initial];
  return {
    getItems: () => items,
    set: (next: any[]) => {
      items = [...next];
    },
    add: (c: any) => {
      items.push(c);
    },
    removeAll: () => {
      items = [];
    },
    init: async () => undefined,
    isInitialized: () => true,
  };
}

describe('ProductsService', () => {
  let service: ProductsService;
  let mockProductRepo: any;
  let mockCategoryRepo: any;
  let mockCategoriesService: any;
  let mockTem: any;

  beforeEach(async () => {
    mockProductRepo = {
      findOne: jest.fn(),
      find: jest.fn(),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      // A store-bound actor still lands its product in its own store, so the
      // created product needs its collections (P0-05)
      create: jest.fn((data) => ({ id: 'new-product-id', ...data, stores: folders(), categories: folders() })),
      getEntityManager: jest.fn(),
    };

    // The transaction create/update now run in (B4a3). Entity-keyed calls are
    // routed back to the per-repository mocks so each test keeps configuring
    // the one mock it always did.
    mockTem = {
      findOne: jest.fn((entity: any, where: any, opts?: any) => {
        // The editor reads the product from the database ahead of its load, to
        // refresh in place an entity the request already holds; the result of
        // that read is not used. This double holds no identity map, so there
        // is nothing to refresh and nothing to hand back.
        if (opts?.refresh) return Promise.resolve(null);
        const name = typeof entity === 'function' ? entity.name : String(entity);
        if (name === 'Product') return mockProductRepo.findOne(where, opts);
        return null;
      }),
      find: jest.fn().mockResolvedValue([]),
      // The card guards ask how many children a product has before any
      // sellable-only field is written. These doubles describe ordinary
      // standalone products, so the honest answer is zero.
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((entity: any, data: any) =>
        (typeof entity === 'function' ? entity.name : String(entity)) === 'Product'
          ? mockProductRepo.create(data)
          : { ...data },
      ),
      getReference: jest.fn((_entity: any, id: string) => ({ id })),
      persist: jest.fn(),
      remove: jest.fn(),
      flush: jest.fn(),
      persistAndFlush: jest.fn(),
    };
    mockProductRepo.getEntityManager.mockReturnValue({
      persistAndFlush: jest.fn(),
      flush: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      // P0-05: create() resolves the actor's organization through its store
      findOne: jest.fn().mockResolvedValue({ id: 'store-1', organization: { id: 'org-1' } }),
      transactional: jest.fn(async (cb: any) => cb(mockTem)),
    });

    mockCategoryRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
    };

    mockCategoriesService = {
      findAssignableCategory: jest.fn(),
      findById: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: InventoryStockService, useValue: stockDouble() },
        ProductsService,
        {
          provide: getRepositoryToken(Product),
          useValue: mockProductRepo,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: mockCategoryRepo,
        },
        {
          provide: CategoriesService,
          useValue: mockCategoriesService,
        },
        {
          provide: FamilyLearningService,
          useValue: {
            learnedWordsFor: jest.fn().mockResolvedValue([]),
            dismissedSignaturesFor: jest.fn().mockResolvedValue([]),
            learnFromAcceptedGroup: jest.fn(),
          },
        },
        {
          provide: AuditLogService,
          useValue: {
            recordAuditEntry: jest.fn(),
          },
        },
        PublicationGuardService,
        {
          provide: ProductFieldsService,
          useValue: {
            writeCreationValues: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<ProductsService>(ProductsService);
  });

  describe('create', () => {
    it('auto-suffixes the slug when the name collides (slugs are system-owned)', async () => {
      mockProductRepo.findOne.mockImplementation((where: any) => {
        if (where.slug === 'red-t-shirt') return { id: '1', slug: 'red-t-shirt' };
        if (where.id) return { id: where.id, slug: 'red-t-shirt-2', name: 'Red T-Shirt' };
        return null;
      });

      await service.create({ name: 'Red T-Shirt' } as any, { id: 'u1', email: 'a@b.c' }, null, ORG);
      expect(mockProductRepo.create).toHaveBeenCalledWith(expect.objectContaining({ slug: 'red-t-shirt-2' }));
    });

    it('should throw ConflictException if SKU is already in use', async () => {
      mockProductRepo.findOne.mockImplementation((where: any) => {
        if (where.slug === 'red-tshirt') return null;
        if (where.sku === 'TSHIRT-RED') return { id: '2', sku: 'TSHIRT-RED' };
        return null;
      });

      await expect(
        service.create(
          { name: 'Red T-Shirt', slug: 'red-tshirt', sku: 'TSHIRT-RED' } as any,
          { id: 'u1', email: 'a@b.c' },
          null,
          ORG,
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('should throw BadRequestException if category is archived', async () => {
      mockProductRepo.findOne.mockResolvedValue(null);
      mockCategoriesService.findAssignableCategory.mockResolvedValueOnce({
        id: 'cat-id',
        name: 'Apparel',
        archivedAt: new Date(),
      });

      await expect(
        service.create(
          { name: 'Red T-Shirt', slug: 'red-tshirt', categoryId: 'cat-id' } as any,
          { id: 'u1', email: 'a@b.c' },
          null,
          ORG,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should create product successfully', async () => {
      mockProductRepo.findOne.mockImplementation((where: any) => {
        if (where.id === 'new-product-id') {
          return { id: 'new-product-id', name: 'Red T-Shirt', slug: 'red-tshirt', status: ProductStatus.DRAFT };
        }
        return null;
      });

      const result = await service.create(
        { name: 'Red T-Shirt', slug: 'red-tshirt' } as any,
        { id: 'u1', email: 'a@b.c' },
        null,
        ORG,
      );
      expect(result.id).toBe('new-product-id');
      expect(mockProductRepo.create).toHaveBeenCalled();
    });

    it('should throw BadRequestException if price is negative', async () => {
      await expect(
        service.create(
          { name: 'Red T-Shirt', slug: 'red-tshirt', price: -5 } as any,
          { id: 'u1', email: 'a@b.c' },
          null,
          ORG,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if salePrice is negative', async () => {
      await expect(
        service.create(
          { name: 'Red T-Shirt', slug: 'red-tshirt', salePrice: -1 } as any,
          { id: 'u1', email: 'a@b.c' },
          null,
          ORG,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if cost is negative', async () => {
      await expect(
        service.create(
          { name: 'Red T-Shirt', slug: 'red-tshirt', cost: -2 } as any,
          { id: 'u1', email: 'a@b.c' },
          null,
          ORG,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if stockQuantity is negative', async () => {
      await expect(
        service.create(
          { name: 'Red T-Shirt', slug: 'red-tshirt', stockQuantity: -10 } as any,
          { id: 'u1', email: 'a@b.c' },
          null,
          ORG,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if salePrice exceeds price', async () => {
      await expect(
        service.create({ name: 'Red T-Shirt', slug: 'red-tshirt', price: 10, salePrice: 15 }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('update', () => {
    it('should throw BadRequestException if product is already archived', async () => {
      mockProductRepo.findOne.mockResolvedValueOnce({
        id: 'prod-id',
        status: ProductStatus.ARCHIVED,
        archivedAt: new Date(),
        categories: folders(),
      });

      await expect(service.update('prod-id', { name: 'New Name' }, 'org-1')).rejects.toThrow(BadRequestException);
    });

    it('ignores slug edits on update (slugs are stable identifiers)', async () => {
      mockProductRepo.findOne.mockImplementation((where: any) => {
        if (where.id === 'prod-id')
          return {
            id: 'prod-id',
            slug: 'old-slug',
            status: ProductStatus.DRAFT,
            archivedAt: null,
            categories: folders(),
          };
        return null;
      });

      const product = await service.update('prod-id', { slug: 'colliding-slug' } as any, 'org-1');
      expect((product as any).slug).toBe('old-slug');
    });

    it('should throw BadRequestException if assigned category is archived', async () => {
      mockProductRepo.findOne.mockResolvedValueOnce({
        id: 'prod-id',
        slug: 'prod-slug',
        status: ProductStatus.DRAFT,
        archivedAt: null,
        categories: folders(),
      });
      mockCategoriesService.findAssignableCategory.mockResolvedValueOnce({
        id: 'archived-cat-id',
        archivedAt: new Date(),
      });

      await expect(service.update('prod-id', { categoryId: 'archived-cat-id' }, 'org-1')).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException if updated price is negative', async () => {
      mockProductRepo.findOne.mockResolvedValueOnce({
        id: 'prod-id',
        price: 10,
        status: ProductStatus.DRAFT,
        archivedAt: null,
        categories: folders(),
      });

      await expect(service.update('prod-id', { price: -2 }, 'org-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if updated salePrice exceeds price', async () => {
      mockProductRepo.findOne.mockResolvedValueOnce({
        id: 'prod-id',
        price: 10,
        salePrice: null,
        status: ProductStatus.DRAFT,
        archivedAt: null,
        categories: folders(),
      });

      await expect(service.update('prod-id', { salePrice: 12 }, 'org-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('archive', () => {
    it('should mark product status as ARCHIVED and populate archivedAt', async () => {
      const prod = { id: 'prod-id', status: ProductStatus.DRAFT, archivedAt: null };
      mockProductRepo.findOne.mockResolvedValueOnce(prod);

      const result = await service.archive('prod-id', 'org-1');
      expect(result.status).toBe(ProductStatus.ARCHIVED);
      expect(result.archivedAt).toBeInstanceOf(Date);
    });
  });

  describe('findAll', () => {
    it.each([
      ['parent', { children: { $some: {} } }],
      ['child', { parent: { $ne: null } }],
      ['standalone', { parent: null, children: { $none: {} } }],
    ] as const)('filters by family role %s (P0-15)', async (family, clause) => {
      mockProductRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll({ organizationId: 'org-1', family });

      const [where] = mockProductRepo.findAndCount.mock.calls.at(-1);
      expect(where.$and).toEqual(expect.arrayContaining([clause]));
    });

    // Phase 4 (C15): no organization ⇒ refusal, never an unscoped query. The
    // old behavior returned every company's products to a store-less actor.
    it('refuses a listing with no organization in scope', async () => {
      await expect(service.findAll({})).rejects.toThrow(ForbiddenException);
      await expect(service.findAll({ search: 'T-Shirt' })).rejects.toThrow(ForbiddenException);
      expect(mockProductRepo.findAndCount).not.toHaveBeenCalled();
    });

    it('should query products with archivedAt: null and other filters and return paginated structure', async () => {
      mockProductRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      const result = await service.findAll({
        organizationId: 'org-1',
        status: ProductStatus.PUBLISHED,
        trackInventory: true,
      });

      expect(result.items).toEqual([]);
      expect(result.total).toBe(0);
      expect(mockProductRepo.findAndCount).toHaveBeenCalledWith(
        {
          $and: [
            { organization: 'org-1' },
            { archivedAt: null },
            { status: ProductStatus.PUBLISHED },
            { trackInventory: true },
          ],
        },
        {
          populate: ['categories', 'images', 'stores', 'branchLinks', 'parent', 'children'],
          limit: 25,
          offset: 0,
          orderBy: { createdAt: 'desc' },
        },
      );
    });

    it('should enforce limit max 100', async () => {
      mockProductRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll({ organizationId: 'org-1', limit: 120 });
      expect(mockProductRepo.findAndCount).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ limit: 100 }),
      );
    });

    it('should support minPrice, maxPrice, and hasSalePrice filters', async () => {
      mockProductRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll({ organizationId: 'org-1', minPrice: 10, maxPrice: 50, hasSalePrice: true });
      expect(mockProductRepo.findAndCount).toHaveBeenCalledWith(
        {
          $and: [
            { organization: 'org-1' },
            { archivedAt: null },
            { price: { $gte: 10 } },
            { price: { $lte: 50 } },
            { salePrice: { $ne: null } },
          ],
        },
        expect.any(Object),
      );
    });

    it('should support hasImages filter', async () => {
      mockProductRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      // #177: membership is a relational subquery, never an in-memory id list.
      await service.findAll({ organizationId: 'org-1', hasImages: true });
      expect(mockProductRepo.findAndCount).toHaveBeenCalledWith(
        {
          $and: [
            { organization: 'org-1' },
            { archivedAt: null },
            {
              $or: [
                { images: { $some: { archivedAt: null } } },
                { children: { $some: { archivedAt: null, images: { $some: { archivedAt: null } } } } },
              ],
            },
          ],
        },
        expect.any(Object),
      );
      // and the entity manager was never asked to load image rows
      expect(mockProductRepo.getEntityManager().find).not.toHaveBeenCalled();
    });

    it('should support hasCategory filter', async () => {
      mockProductRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll({ organizationId: 'org-1', hasCategory: false });
      expect(mockProductRepo.findAndCount).toHaveBeenCalledWith(
        {
          $and: [{ organization: 'org-1' }, { archivedAt: null }, { categories: null }],
        },
        expect.any(Object),
      );
    });

    it('should support sorting and pagination options', async () => {
      mockProductRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll({ organizationId: 'org-1', page: 3, limit: 10, sortBy: 'price', sortDirection: 'asc' });
      expect(mockProductRepo.findAndCount).toHaveBeenCalledWith(
        {
          $and: [{ organization: 'org-1' }, { archivedAt: null }],
        },
        {
          populate: ['categories', 'images', 'stores', 'branchLinks', 'parent', 'children'],
          limit: 10,
          offset: 20,
          orderBy: { price: 'asc' },
        },
      );
    });

    it('should resolve subqueries when search query is provided', async () => {
      mockCategoryRepo.find.mockResolvedValueOnce([{ id: 'cat-1' }]);
      mockProductRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll({ organizationId: 'org-1', search: 'T-Shirt' });

      // The category-name subquery is tenant-scoped too — matching another
      // company's category names must not widen the product search.
      expect(mockCategoryRepo.find).toHaveBeenCalledWith({
        name: { $ilike: '%T-Shirt%' },
        archivedAt: null,
        organization: 'org-1',
      });
      expect(mockProductRepo.findAndCount).toHaveBeenCalledWith(
        {
          $and: [
            { organization: 'org-1' },
            { archivedAt: null },
            {
              $or: [
                { name: { $ilike: '%T-Shirt%' } },
                { slug: { $ilike: '%T-Shirt%' } },
                { sku: { $ilike: '%T-Shirt%' } },
                { children: { $some: { sku: { $ilike: '%T-Shirt%' }, archivedAt: null } } },
                // P5-W1: the SUPPLIER's reference is searched alongside our
                // own identity, never instead of it — both clauses above are
                // untouched and both clauses below are additions.
                { manufacturerCode: { $ilike: '%T-Shirt%' } },
                { children: { $some: { manufacturerCode: { $ilike: '%T-Shirt%' }, archivedAt: null } } },
                { categories: { $in: ['cat-1'] } },
              ],
            },
          ],
        },
        expect.any(Object),
      );
    });

    it('should resolve hasChildren: true as products with live children', async () => {
      mockProductRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll({ organizationId: 'org-1', hasChildren: true });

      expect(mockProductRepo.findAndCount).toHaveBeenCalledWith(
        {
          $and: [{ organization: 'org-1' }, { archivedAt: null }, { children: { $some: { archivedAt: null } } }],
        },
        expect.any(Object),
      );
    });

    it('should resolve hasChildren: false as products without live children', async () => {
      mockProductRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll({ organizationId: 'org-1', hasChildren: false });

      expect(mockProductRepo.findAndCount).toHaveBeenCalledWith(
        {
          $and: [{ organization: 'org-1' }, { archivedAt: null }, { children: { $none: { archivedAt: null } } }],
        },
        expect.any(Object),
      );
    });
  });

  describe('restore', () => {
    it('should remove archivedAt from product and set status to DRAFT', async () => {
      const prod = {
        id: 'prod-1',
        name: 'Product 1',
        status: ProductStatus.ARCHIVED,
        archivedAt: new Date(),
        categories: folders(),
      };
      mockProductRepo.findOne.mockResolvedValueOnce(prod);

      const result = await service.restore('prod-1', 'org-1');
      expect(result.archivedAt).toBeUndefined();
      expect(result.status).toBe(ProductStatus.DRAFT);
    });

    it('should throw BadRequestException if category is archived', async () => {
      const prod = {
        id: 'prod-1',
        name: 'Product 1',
        status: ProductStatus.ARCHIVED,
        archivedAt: new Date(),
        categories: folders([{ id: 'cat-id' }]),
      };
      mockProductRepo.findOne.mockResolvedValueOnce(prod);
      mockCategoryRepo.findOne.mockResolvedValueOnce({ id: 'cat-id', archivedAt: new Date() });

      await expect(service.restore('prod-1', 'org-1')).rejects.toThrow(BadRequestException);
    });
  });

  describe('Milestone 16 hardening', () => {
    it('should throw BadRequestException if trying to set status to ARCHIVED directly (on create)', async () => {
      mockProductRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.create(
          { name: 'Product', slug: 'prod', status: ProductStatus.ARCHIVED } as any,
          { id: 'u1', email: 'a@b.c' },
          null,
          ORG,
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if trying to set status to ARCHIVED directly (on update)', async () => {
      mockProductRepo.findOne.mockResolvedValueOnce({
        id: 'prod-id',
        status: ProductStatus.DRAFT,
        archivedAt: null,
        categories: folders(),
      });

      await expect(service.update('prod-id', { status: ProductStatus.ARCHIVED }, 'org-1')).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
