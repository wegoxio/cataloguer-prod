import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { DashboardMetricsService } from '../dashboard-metrics.service';
import { Category } from '../../categories/entities/category.entity';
import { Product } from '../../products/entities/product.entity';
import { ProductImage } from '../../product-images/entities/product-image.entity';
import { ProductStatus } from '../../products/catalogue/product-status.enum';

describe('DashboardMetricsService', () => {
  let service: DashboardMetricsService;
  let mockCategoryRepo: any;
  let mockProductRepo: any;
  let mockImageRepo: any;

  beforeEach(async () => {
    mockCategoryRepo = {
      // Family 7: a "total" is now `{ organization }` alone — the empty-where
      // shape the old mock keyed on can no longer be produced by the service.
      count: jest.fn().mockImplementation(async (where) => {
        if (Object.keys(where).length === 1 && where.organization) return 10;
        if (where.archivedAt === null) return 8;
        return 2;
      }),
    };

    mockProductRepo = {
      count: jest.fn().mockImplementation(async (where) => {
        if (Object.keys(where).length === 1 && where.organization) return 20;
        if (where.status === ProductStatus.DRAFT && where.archivedAt === null) return 5;
        if (where.status === ProductStatus.PUBLISHED && where.archivedAt === null) return 12;
        if (where.archivedAt && where.archivedAt.$ne === null) return 3;
        return 0;
      }),
    };

    mockImageRepo = {
      count: jest.fn().mockImplementation(async (where) => {
        if (Object.keys(where).length === 1 && where.product) return 30;
        if (where.archivedAt === null) return 25;
        return 5;
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DashboardMetricsService,
        {
          provide: getRepositoryToken(Category),
          useValue: mockCategoryRepo,
        },
        {
          provide: getRepositoryToken(Product),
          useValue: mockProductRepo,
        },
        {
          provide: getRepositoryToken(ProductImage),
          useValue: mockImageRepo,
        },
      ],
    }).compile();

    service = module.get<DashboardMetricsService>(DashboardMetricsService);
  });

  it('should return correct counts for all categories, products, and images', async () => {
    // P5-A2 family 7: the organization is required — the unfiltered call shape
    // no longer exists.
    const metrics = await service.getMetrics('org-1');

    expect(metrics).toEqual({
      categories: {
        total: 10,
        active: 8,
        archived: 2,
      },
      products: {
        total: 20,
        draft: 5,
        published: 12,
        archived: 3,
      },
      images: {
        total: 30,
        active: 25,
        archived: 5,
      },
    });

    // Family 7: EVERY query now carries the organization — the `{}` shape these
    // assertions used to pin is exactly the cross-tenant read that was removed.
    const org = { organization: 'org-1' };
    expect(mockCategoryRepo.count).toHaveBeenCalledWith(org);
    expect(mockCategoryRepo.count).toHaveBeenCalledWith({ ...org, archivedAt: null });
    expect(mockCategoryRepo.count).toHaveBeenCalledWith({ ...org, archivedAt: { $ne: null } });

    expect(mockProductRepo.count).toHaveBeenCalledWith(org);
    expect(mockProductRepo.count).toHaveBeenCalledWith({ ...org, status: ProductStatus.DRAFT, archivedAt: null });
    expect(mockProductRepo.count).toHaveBeenCalledWith({ ...org, status: ProductStatus.PUBLISHED, archivedAt: null });
    expect(mockProductRepo.count).toHaveBeenCalledWith({ ...org, archivedAt: { $ne: null } });

    const viaProduct = { product: { organization: 'org-1' } };
    expect(mockImageRepo.count).toHaveBeenCalledWith(viaProduct);
    expect(mockImageRepo.count).toHaveBeenCalledWith({ ...viaProduct, archivedAt: null });
    expect(mockImageRepo.count).toHaveBeenCalledWith({ ...viaProduct, archivedAt: { $ne: null } });
  });
});

/**
 * P5-A2 family 7 — defence in depth at the SERVICE boundary. The controller's
 * role gate is not the only thing standing between a caller and every tenant's
 * rows: the service refuses an absent organization itself, and issues no query
 * when it does.
 */
describe('DashboardMetricsService requires an organization (family 7)', () => {
  const build = () => {
    const categoryRepository = { count: jest.fn().mockResolvedValue(0) };
    const productRepository = { count: jest.fn().mockResolvedValue(0) };
    const imageRepository = { count: jest.fn().mockResolvedValue(0) };
    const service = new DashboardMetricsService(
      categoryRepository as any,
      productRepository as any,
      imageRepository as any,
    );
    return { service, categoryRepository, productRepository, imageRepository };
  };

  it.each([
    ['an empty string', ''],
    ['undefined', undefined],
    ['null', null],
  ])('refuses %s and issues NO repository query', async (_label, organizationId) => {
    const { service, categoryRepository, productRepository, imageRepository } = build();
    await expect(service.getMetrics(organizationId as any)).rejects.toThrow(ForbiddenException);
    expect(categoryRepository.count).not.toHaveBeenCalled();
    expect(productRepository.count).not.toHaveBeenCalled();
    expect(imageRepository.count).not.toHaveBeenCalled();
  });

  it('pins every query to the organization when one is present', async () => {
    const { service, categoryRepository, productRepository, imageRepository } = build();
    await service.getMetrics('org-1');
    for (const call of categoryRepository.count.mock.calls) {
      expect(call[0]).toMatchObject({ organization: 'org-1' });
    }
    for (const call of productRepository.count.mock.calls) {
      expect(call[0]).toMatchObject({ organization: 'org-1' });
    }
    for (const call of imageRepository.count.mock.calls) {
      expect(call[0]).toMatchObject({ product: { organization: 'org-1' } });
    }
  });
});
