import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { Category } from '../categories/entities/category.entity';
import { Product } from '../products/entities/product.entity';
import { ProductImage } from '../product-images/entities/product-image.entity';
import { ProductStatus } from '../products/catalogue/product-status.enum';

export interface MetricsResponse {
  categories: {
    total: number;
    active: number;
    archived: number;
  };
  products: {
    total: number;
    draft: number;
    published: number;
    archived: number;
  };
  images: {
    total: number;
    active: number;
    archived: number;
  };
}

@Injectable()
export class DashboardMetricsService {
  constructor(
    @InjectRepository(Category)
    private readonly categoryRepository: EntityRepository<Category>,
    @InjectRepository(Product)
    private readonly productRepository: EntityRepository<Product>,
    @InjectRepository(ProductImage)
    private readonly imageRepository: EntityRepository<ProductImage>,
  ) {}

  /**
   * Organization-wide catalogue counts (P5-A2 family 7, option A).
   *
   * DEFENCE IN DEPTH. `organizationId?: string` made an unfiltered query
   * expressible — `organizationId ? {…} : {}` counted EVERY tenant's rows
   * whenever the caller had no company. The parameter is now non-nullable at
   * compile time AND revalidated here at runtime, so no caller — present or
   * future, controller or otherwise — can reach a cross-tenant count. The
   * controller's role gate is not the only thing standing in the way.
   *
   * These metrics are organization-wide BY CONSTRUCTION and are not branch
   * filterable: a category belongs to the company (its `store` is provenance,
   * never a boundary), a product image has no store dimension at all, and a
   * draft product usually carries no branch link. Narrowed actors and ADMIN
   * are therefore refused the route rather than served a redefined number;
   * their branch figures come from Reports, which is store-shaped.
   */
  async getMetrics(organizationId: string): Promise<MetricsResponse> {
    if (typeof organizationId !== 'string' || organizationId.length === 0) {
      throw new ForbiddenException(
        'Metrics require an organization context; a platform administrator must supply X-Managed-Organization',
      );
    }
    // #292: every count below runs through the default lifecycle filter, so
    // the dashboard reports the LIVE catalogue — the same set the Items and
    // Categories pages show. That is the whole point of a summary: a total the
    // operator cannot reconcile against the list it summarises is worse than
    // no total. Removed records are counted by the recovery view instead.
    //
    // `viaProduct` reaches Product through a nested condition, so the image
    // counts inherit the same boundary; `dashboard-metrics.pg.spec.ts` proves
    // that rather than assuming it, because a filter that silently stops
    // applying across a join is exactly the failure ADR 019 was written for.
    const org = { organization: organizationId };
    const viaProduct = { product: { organization: organizationId } };
    const [
      categoryTotal,
      categoryActive,
      categoryArchived,
      productTotal,
      productDraft,
      productPublished,
      productArchived,
      imageTotal,
      imageActive,
      imageArchived,
    ] = await Promise.all([
      this.categoryRepository.count({ ...org }),
      this.categoryRepository.count({ ...org, archivedAt: null }),
      this.categoryRepository.count({ ...org, archivedAt: { $ne: null } }),
      this.productRepository.count({ ...org }),
      this.productRepository.count({ ...org, status: ProductStatus.DRAFT, archivedAt: null }),
      this.productRepository.count({ ...org, status: ProductStatus.PUBLISHED, archivedAt: null }),
      this.productRepository.count({ ...org, archivedAt: { $ne: null } }),
      this.imageRepository.count({ ...viaProduct }),
      this.imageRepository.count({ ...viaProduct, archivedAt: null }),
      this.imageRepository.count({ ...viaProduct, archivedAt: { $ne: null } }),
    ]);

    return {
      categories: {
        total: categoryTotal,
        active: categoryActive,
        archived: categoryArchived,
      },
      products: {
        total: productTotal,
        draft: productDraft,
        published: productPublished,
        archived: productArchived,
      },
      images: {
        total: imageTotal,
        active: imageActive,
        archived: imageArchived,
      },
    };
  }
}
