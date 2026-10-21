import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { ExportsService } from '../exports.service';
import { Category } from '../../categories/entities/category.entity';
import { Product } from '../../products/entities/product.entity';
import { ProductStatus } from '../../products/catalogue/product-status.enum';

/** P5-A2 canonical family 7: the company is a REQUIRED argument now. */
const ORG = 'org-export';

describe('ExportsService', () => {
  let service: ExportsService;
  let mockCategoryRepo: any;
  let mockProductRepo: any;

  beforeEach(async () => {
    mockCategoryRepo = {
      find: jest.fn(),
    };

    mockProductRepo = {
      find: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExportsService,
        {
          provide: getRepositoryToken(Category),
          useValue: mockCategoryRepo,
        },
        {
          provide: getRepositoryToken(Product),
          useValue: mockProductRepo,
        },
      ],
    }).compile();

    service = module.get<ExportsService>(ExportsService);
  });

  describe('exportCategories', () => {
    it('should generate categories CSV correctly', async () => {
      const mockCategories = [
        {
          name: 'Shirts',
          slug: 'shirts',
          description: 'Category for shirts',
          parentCategory: null,
        },
        {
          name: 'T-Shirts',
          slug: 't-shirts',
          description: 'Category for t-shirts',
          parentCategory: { slug: 'shirts' },
        },
      ];
      mockCategoryRepo.find.mockResolvedValueOnce(mockCategories);

      const csv = await service.exportCategories(ORG);
      expect(csv).toContain('name,slug,description,parentSlug');
      expect(csv).toContain('Shirts,shirts,Category for shirts,');
      expect(csv).toContain('T-Shirts,t-shirts,Category for t-shirts,shirts');
    });
  });

  describe('exportProducts', () => {
    it('should generate products CSV correctly', async () => {
      const mockProducts = [
        {
          name: 'Premium T-Shirt',
          slug: 'premium-t-shirt',
          description: 'A great t-shirt',
          sku: 'TSH-PRM',
          price: 25.99,
          salePrice: 19.99,
          cost: 10.0,
          stockQuantity: 50,
          trackInventory: true,
          status: ProductStatus.PUBLISHED,
          categories: { getItems: () => [{ slug: 't-shirts' }] },
        },
      ];
      mockProductRepo.find.mockResolvedValueOnce(mockProducts);

      const csv = await service.exportProducts(ORG);
      expect(csv).toContain(
        'name,slug,description,sku,price,salePrice,cost,stockQuantity,trackInventory,status,categorySlug',
      );
      expect(csv).toContain(
        'Premium T-Shirt,premium-t-shirt,A great t-shirt,TSH-PRM,25.99,19.99,10,50,true,PUBLISHED,t-shirts',
      );
    });
  });

  /**
   * P5-A2 canonical family 7 — the tenant boundary.
   *
   * `exportCategories(undefined)` used to mean "no filter", so an unscoped
   * platform session downloaded every company's catalogue in one CSV. The
   * argument is required and the filter unconditional; the controller refuses
   * a caller with no company before reaching here.
   */
  describe('the organization filter is unconditional', () => {
    it('always scopes the category query to one company', async () => {
      mockCategoryRepo.find.mockResolvedValueOnce([]);
      await service.exportCategories(ORG);
      expect(mockCategoryRepo.find).toHaveBeenCalledWith({ organization: ORG }, expect.anything());
    });

    it('always scopes the product query to one company', async () => {
      mockProductRepo.find.mockResolvedValueOnce([]);
      await service.exportProducts(ORG);
      expect(mockProductRepo.find).toHaveBeenCalledWith({ organization: ORG }, expect.anything());
    });
  });
});
