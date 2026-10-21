import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { BulkOperationsService } from '../bulk-operations.service';
import { Product } from '../../products/entities/product.entity';
import { Category } from '../../categories/entities/category.entity';
import { ProductStatus } from '../../products/catalogue/product-status.enum';
import { ProductsService } from '../../products/catalogue/products.service';
import { PublicationGuardService } from '../../products/publication/publication-guard.service';
import { BadRequestException } from '@nestjs/common';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { InventoryStockService } from '../../inventory/ledger/inventory-stock.service';
import { stockDouble } from '../../../../test/inventory-stock-support';

/**
 * P5-A2 canonical family 7: the organization is a REQUIRED argument now.
 * These behavioural cases previously passed `undefined`, which is exactly
 * the unfiltered shape the family removed; the mocks match on `where.id`,
 * so naming a company changes nothing they assert.
 */
const ORG = 'org-bulk';

/** Minimal stand-in for MikroORM's Collection: only what bulkCategory touches. */
function folders(initial: any[] = []) {
  let items = [...initial];
  return {
    getItems: () => items,
    set: (next: any[]) => {
      items = [...next];
    },
    init: async () => undefined,
  };
}

describe('BulkOperationsService', () => {
  let service: BulkOperationsService;
  const stock = stockDouble();
  let mockProductRepo: any;
  let mockCategoryRepo: any;
  let mockProductsService: any;

  beforeEach(async () => {
    // The transactional manager bulkStatus/bulkStores now run in (B4a3);
    // Product reads route back to mockProductRepo so each test keeps
    // configuring the one mock it always did.
    const mockTem = {
      findOne: jest.fn((entity: any, where: any) =>
        (typeof entity === 'function' ? entity.name : String(entity)) === 'Product'
          ? mockProductRepo.findOne(where)
          : null,
      ),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn((_entity: any, data: any) => ({ ...data })),
      persist: jest.fn(),
      remove: jest.fn(),
      flush: jest.fn(),
      execute: jest.fn(async () => []),
    };
    const mockEM = {
      flush: jest.fn().mockResolvedValue(null),
      transactional: jest.fn(async (cb: any) => cb(mockTem)),
      // The card guards ask how many children a product has before writing a
      // sellable-only field. These doubles describe ordinary standalone items,
      // so the honest answer is zero.
      count: jest.fn().mockResolvedValue(0),
    };

    mockProductRepo = {
      findOne: jest.fn(),
      getEntityManager: jest.fn().mockReturnValue(mockEM),
    };

    mockCategoryRepo = {
      findOne: jest.fn(),
    };

    mockProductsService = {
      archive: jest.fn(),
      restore: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BulkOperationsService,
        { provide: InventoryStockService, useValue: stock },
        {
          provide: getRepositoryToken(Product),
          useValue: mockProductRepo,
        },
        {
          provide: getRepositoryToken(Category),
          useValue: mockCategoryRepo,
        },
        {
          provide: ProductsService,
          useValue: mockProductsService,
        },
        {
          provide: AuditLogService,
          useValue: {
            recordAuditEntry: jest.fn(),
          },
        },
        PublicationGuardService,
      ],
    }).compile();

    service = module.get<BulkOperationsService>(BulkOperationsService);
  });

  describe('bulkArchive', () => {
    it('should successfully archive products and handle partial failures', async () => {
      const ids = ['p1', 'p2', 'p3'];

      mockProductRepo.findOne.mockImplementation((where: any) => {
        if (where.id === 'p1') return { id: 'p1', status: ProductStatus.DRAFT, archivedAt: null };
        if (where.id === 'p2') return { id: 'p2', status: ProductStatus.ARCHIVED, archivedAt: new Date() };
        if (where.id === 'p3') return null; // not found
      });

      mockProductsService.archive.mockResolvedValueOnce({});

      const result = await service.bulkArchive(ORG, ids);

      expect(result.successCount).toBe(1);
      expect(result.failedCount).toBe(2);
      expect(result.successes).toEqual(['p1']);
      expect(result.failures[0]).toEqual({ id: 'p2', message: 'Product is already archived' });
      expect(result.failures[1]).toEqual({ id: 'p3', message: 'Product with ID p3 not found' });
    });
  });

  describe('bulkRestore', () => {
    it('should successfully restore products and handle failures', async () => {
      const ids = ['p1', 'p2'];

      mockProductRepo.findOne.mockImplementation((where: any) => {
        if (where.id === 'p1') return { id: 'p1', status: ProductStatus.ARCHIVED, archivedAt: new Date() };
        if (where.id === 'p2') return { id: 'p2', status: ProductStatus.DRAFT, archivedAt: null }; // not archived
      });

      mockProductsService.restore.mockResolvedValueOnce({});

      const result = await service.bulkRestore(ORG, ids);

      expect(result.successCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(result.successes).toEqual(['p1']);
      expect(result.failures[0]).toEqual({ id: 'p2', message: 'Product is not archived' });
    });
  });

  describe('bulkStatus', () => {
    it('should update status for non-archived products and reject ARCHIVED status', async () => {
      await expect(service.bulkStatus(ORG, ['p1'], ProductStatus.ARCHIVED)).rejects.toThrow(BadRequestException);

      const ids = ['p1', 'p2'];
      const prod1 = { id: 'p1', status: ProductStatus.DRAFT, archivedAt: null };
      const prod2 = { id: 'p2', status: ProductStatus.ARCHIVED, archivedAt: new Date() };

      mockProductRepo.findOne.mockImplementation((where: any) => {
        if (where.id === 'p1') return prod1;
        if (where.id === 'p2') return prod2;
      });

      const result = await service.bulkStatus(ORG, ids, ProductStatus.PUBLISHED);

      expect(result.successCount).toBe(1);
      expect(result.failedCount).toBe(1);
      expect(prod1.status).toBe(ProductStatus.PUBLISHED);
      expect(prod1.archivedAt).toBeNull(); // remains null
      expect(result.failures[0]).toEqual({ id: 'p2', message: 'Cannot modify status of an archived product' });
    });
  });

  describe('bulkCategory', () => {
    it('should assign valid category, clear category if null, and reject archived category or product', async () => {
      const ids = ['p1', 'p2', 'p3'];
      const prod1 = { id: 'p1', categories: folders([{ id: 'c-old' }]), status: ProductStatus.DRAFT, archivedAt: null };
      const prod2 = { id: 'p2', categories: folders(), status: ProductStatus.ARCHIVED, archivedAt: new Date() };
      const prod3 = { id: 'p3', categories: folders(), status: ProductStatus.DRAFT, archivedAt: null };

      mockProductRepo.findOne.mockImplementation((where: any) => {
        if (where.id === 'p1') return prod1;
        if (where.id === 'p2') return prod2;
        if (where.id === 'p3') return prod3;
      });

      const mockCat = { id: 'c-new', name: 'Shoes', archivedAt: null };
      mockCategoryRepo.findOne.mockResolvedValue(mockCat);

      const result = await service.bulkCategory('org-1', ids, 'c-new');

      expect(result.successCount).toBe(2);
      expect(result.failedCount).toBe(1);
      expect(prod1.categories.getItems()).toEqual([mockCat]);
      expect(prod3.categories.getItems()).toEqual([mockCat]);
      expect(result.failures[0]).toEqual({ id: 'p2', message: 'Cannot modify category of an archived product' });
    });

    it('should clear category assignment when categoryId is null', async () => {
      const prod = { id: 'p1', categories: folders([{ id: 'c-old' }]), status: ProductStatus.DRAFT, archivedAt: null };
      mockProductRepo.findOne.mockResolvedValue(prod);

      const result = await service.bulkCategory('org-1', ['p1'], null);

      expect(result.successCount).toBe(1);
      expect(prod.categories.getItems()).toEqual([]);
    });

    it('should fail if category is archived', async () => {
      const prod = { id: 'p1', categories: folders(), status: ProductStatus.DRAFT, archivedAt: null };
      mockProductRepo.findOne.mockResolvedValue(prod);

      const mockCat = { id: 'c-new', name: 'Shoes', archivedAt: new Date() }; // archived
      mockCategoryRepo.findOne.mockResolvedValue(mockCat);

      const result = await service.bulkCategory('org-1', ['p1'], 'c-new');

      expect(result.successCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(result.failures[0].message).toBe('Cannot assign an archived category');
    });
  });

  describe('bulkInventory', () => {
    it('sets the quantity through the ledger and still flips the commercial flag', async () => {
      const prod = { id: 'p1', stockQuantity: 5, trackInventory: false, status: ProductStatus.DRAFT, archivedAt: null };
      mockProductRepo.findOne.mockResolvedValue(prod);

      const result = await service.bulkInventory(ORG, ['p1'], 10, true);

      expect(result.successCount).toBe(1);
      // P5-B3: the target is expressed as a command; the posting mechanism
      // refreshes the compatibility column, so the service no longer sets it.
      expect(stock.setProductQuantity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ organizationId: ORG, productId: 'p1', targetQuantity: 10, origin: 'bulk-inventory' }),
      );
      expect(prod.trackInventory).toBe(true);
    });

    it('should fail if stockQuantity is negative', async () => {
      const result = await service.bulkInventory(ORG, ['p1'], -5);
      expect(result.successCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(result.failures[0].message).toBe('Stock quantity cannot be negative');
    });
  });

  describe('bulkPricing', () => {
    it('should update price, salePrice, cost and fallback to database values for omitted fields', async () => {
      const prod = { id: 'p1', price: 100, salePrice: 80, cost: 40, status: ProductStatus.DRAFT, archivedAt: null };
      mockProductRepo.findOne.mockResolvedValue(prod);

      const result = await service.bulkPricing(ORG, ['p1'], 120, 90, undefined); // cost omitted

      expect(result.successCount).toBe(1);
      expect(prod.price).toBe(120);
      expect(prod.salePrice).toBe(90);
      expect(prod.cost).toBe(40); // preserved
    });

    it('should fail if salePrice exceeds regular price', async () => {
      const prod = { id: 'p1', price: 100, salePrice: 80, cost: 40, status: ProductStatus.DRAFT, archivedAt: null };
      mockProductRepo.findOne.mockResolvedValue(prod);

      const result = await service.bulkPricing(ORG, ['p1'], 100, 110); // salePrice (110) > price (100)

      expect(result.successCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(result.failures[0].message).toBe('Sale price cannot exceed the regular price');
    });

    it('should fail if any value is negative', async () => {
      const result = await service.bulkPricing(ORG, ['p1'], -10);
      expect(result.successCount).toBe(0);
      expect(result.failedCount).toBe(1);
      expect(result.failures[0].message).toBe('Price cannot be negative');
    });
  });
});
