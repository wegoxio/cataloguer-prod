import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { ProductImage } from './entities/product-image.entity';
import { CreateProductImageDto } from './dto/create-product-image.dto';
import { UpdateProductImageDto } from './dto/update-product-image.dto';
import { ProductsService } from '../products/catalogue/products.service';
import { ProductStatus } from '../products/catalogue/product-status.enum';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EntityType, Action } from '../audit-log/entities/audit-log.entity';
import { AuditContext } from '../audit-log/types/audit-context.type';
import { Product } from '../products/entities/product.entity';
import { StorageUrlPolicyService } from '../storage/policy/storage-url-policy.service';
import { ProductImageAuthority } from '../storage/policy/storage-url.policy';

@Injectable()
export class ProductImagesService {
  constructor(
    @InjectRepository(ProductImage)
    private readonly productImageRepository: EntityRepository<ProductImage>,
    private readonly productsService: ProductsService,
    private readonly auditLogService: AuditLogService,
    private readonly storageUrlPolicy: StorageUrlPolicyService,
  ) {}

  async findAllForProduct(productId: string, includeArchived = false): Promise<ProductImage[]> {
    // Verify product exists
    await this.productsService.findByIdAfterTenancyAssertion(productId);

    const where: any = { product: productId };
    if (!includeArchived) {
      where.archivedAt = null;
    }

    return this.productImageRepository.find(where, { orderBy: { sortOrder: 'ASC', createdAt: 'ASC' } });
  }

  /** Affected-resource context: the image's product's organization. */
  private async productContext(productId: string): Promise<AuditContext> {
    const em = this.productImageRepository.getEntityManager();
    const product = await em.findOne(Product, { id: productId });
    return { organizationId: (product?.organization as any)?.id ?? (product?.organization as any) ?? null };
  }

  async findById(productId: string, id: string): Promise<ProductImage> {
    // Verify product exists
    await this.productsService.findByIdAfterTenancyAssertion(productId);

    const image = await this.productImageRepository.findOne({ id, product: productId });
    if (!image) {
      throw new NotFoundException(`Image with ID ${id} for product ${productId} not found`);
    }
    return image;
  }

  async create(
    productId: string,
    dto: CreateProductImageDto,
    actor?: { id: string; email: string },
    /**
     * WHO is attaching, named by the caller (P5-A2's third policy). It used to
     * be `narrowedStoreId: string | null`, and null meant both "the platform
     * owner" and "a manager with no branch selected" — which let the second
     * one reference ANY company's asset bank by URL.
     */
    authority: ProductImageAuthority = { kind: 'organization', allowedStoreIds: [] },
  ): Promise<ProductImage> {
    // Verify product exists and is active
    const product = await this.productsService.findByIdAfterTenancyAssertion(productId);
    if (product.status === ProductStatus.ARCHIVED || product.archivedAt !== null) {
      throw new BadRequestException('Cannot add images to an archived product');
    }

    // #174: the URL must reference this product's own uploads or the acting
    // branch's asset bank — never an external host or another tenant's
    // objects. P5-A3: the branch is the caller's RESOLVED narrowing.
    this.storageUrlPolicy.assertProductImageUrl(dto.url, { productId, authority });

    // The policy above validates the key and the authority; it cannot see that
    // the company archived this library file. A URL is pasteable, so without
    // this an archived file would be one saved link away from being published
    // again. A product's own upload under `products/<productId>/…` has no
    // library row and is unaffected; photos that ALREADY exist are untouched.
    // Check count of active images
    const activeCount = await this.productImageRepository.count({
      product: productId,
      archivedAt: null,
    });

    let isPrimary = dto.isPrimary || false;
    if (activeCount === 0) {
      isPrimary = true; // Auto promote first image to primary
    }

    if (isPrimary) {
      await this.clearPrimaryFlagForProduct(productId);
    }

    const image = this.productImageRepository.create({
      product,
      url: dto.url,
      altText: dto.altText,
      sortOrder: dto.sortOrder || 0,
      isPrimary,
      displayMode: dto.displayMode === 'COVER' ? 'COVER' : 'CONTAIN',
    });

    await this.productImageRepository.getEntityManager().persistAndFlush(image);

    if (actor) {
      await this.auditLogService.recordAuditEntry(
        actor.id,
        actor.email,
        EntityType.PRODUCT_IMAGE,
        image.id,
        Action.CREATE,
        null,
        `Added image to product ID ${productId}`,
        await this.productContext(productId),
      );
    }

    return image;
  }

  async update(
    productId: string,
    id: string,
    dto: UpdateProductImageDto,
    actor?: { id: string; email: string },
  ): Promise<ProductImage> {
    // Verify product exists and is active
    const product = await this.productsService.findByIdAfterTenancyAssertion(productId);
    if (product.status === ProductStatus.ARCHIVED || product.archivedAt !== null) {
      throw new BadRequestException('Cannot modify images of an archived product');
    }

    const image = await this.findById(productId, id);
    if (image.archivedAt) {
      throw new BadRequestException('Cannot modify an archived image');
    }

    const before = {
      altText: image.altText ?? null,
      sortOrder: image.sortOrder,
      isPrimary: image.isPrimary,
    };

    if (dto.altText !== undefined) {
      image.altText = dto.altText;
    }

    if (dto.sortOrder !== undefined) {
      image.sortOrder = dto.sortOrder;
    }

    if (dto.displayMode !== undefined) {
      image.displayMode = dto.displayMode === 'COVER' ? 'COVER' : 'CONTAIN';
    }

    if (dto.isPrimary !== undefined) {
      if (dto.isPrimary && !image.isPrimary) {
        await this.clearPrimaryFlagForProduct(productId);
        image.isPrimary = true;
      } else if (!dto.isPrimary && image.isPrimary) {
        // Demoting primary image: must promote next if exists to maintain the constraint
        const nextImage = await this.productImageRepository.findOne(
          { product: productId, id: { $ne: id }, archivedAt: null },
          { orderBy: { sortOrder: 'ASC', createdAt: 'ASC' } },
        );
        if (nextImage) {
          nextImage.isPrimary = true;
          image.isPrimary = false;
        } else {
          image.isPrimary = true; // Keep primary if it's the only active image
        }
      }
    }

    await this.productImageRepository.getEntityManager().flush();

    if (actor) {
      const changes: Record<string, any> = {};
      const newAlt = image.altText ?? null;
      if (before.altText !== newAlt) changes.altText = { before: before.altText, after: newAlt };
      if (before.sortOrder !== image.sortOrder)
        changes.sortOrder = { before: before.sortOrder, after: image.sortOrder };
      if (before.isPrimary !== image.isPrimary)
        changes.isPrimary = { before: before.isPrimary, after: image.isPrimary };

      if (Object.keys(changes).length > 0) {
        await this.auditLogService.recordAuditEntry(
          actor.id,
          actor.email,
          EntityType.PRODUCT_IMAGE,
          image.id,
          Action.UPDATE,
          changes,
          `Updated image on product ID ${productId}`,
          await this.productContext(productId),
        );
      }
    }

    return image;
  }

  async archive(productId: string, id: string, actor?: { id: string; email: string }): Promise<ProductImage> {
    // Verify product exists
    await this.productsService.findByIdAfterTenancyAssertion(productId);

    const image = await this.findById(productId, id);
    if (image.archivedAt) {
      return image; // Already archived
    }

    const beforeArchivedAt = image.archivedAt ?? null;
    const beforeIsPrimary = image.isPrimary;

    image.archivedAt = new Date();

    if (image.isPrimary) {
      image.isPrimary = false;
      // Promote the next active image to primary
      const nextImage = await this.productImageRepository.findOne(
        { product: productId, id: { $ne: id }, archivedAt: null },
        { orderBy: { sortOrder: 'ASC', createdAt: 'ASC' } },
      );
      if (nextImage) {
        nextImage.isPrimary = true;
      }
    }

    await this.productImageRepository.getEntityManager().flush();

    if (actor) {
      await this.auditLogService.recordAuditEntry(
        actor.id,
        actor.email,
        EntityType.PRODUCT_IMAGE,
        image.id,
        Action.ARCHIVE,
        {
          archivedAt: { before: beforeArchivedAt, after: image.archivedAt },
          isPrimary: { before: beforeIsPrimary, after: image.isPrimary },
        },
        `Archived image on product ID ${productId}`,
        await this.productContext(productId),
      );
    }

    return image;
  }

  async restore(productId: string, id: string, actor?: { id: string; email: string }): Promise<ProductImage> {
    const product = await this.productsService.findByIdAfterTenancyAssertion(productId);
    if (product.status === ProductStatus.ARCHIVED || product.archivedAt !== null) {
      throw new BadRequestException('Cannot restore images of an archived product');
    }

    const image = await this.findById(productId, id);
    if (!image.archivedAt) {
      return image;
    }

    const beforeArchivedAt = image.archivedAt;
    const beforeIsPrimary = image.isPrimary;

    const activePrimaryCount = await this.productImageRepository.count({
      product: productId,
      archivedAt: null,
      isPrimary: true,
    });

    image.archivedAt = undefined;
    if (activePrimaryCount === 0) {
      await this.clearPrimaryFlagForProduct(productId);
      image.isPrimary = true;
    } else {
      image.isPrimary = false;
    }

    await this.productImageRepository.getEntityManager().flush();

    if (actor) {
      await this.auditLogService.recordAuditEntry(
        actor.id,
        actor.email,
        EntityType.PRODUCT_IMAGE,
        image.id,
        Action.RESTORE,
        {
          archivedAt: { before: beforeArchivedAt, after: null },
          isPrimary: { before: beforeIsPrimary, after: image.isPrimary },
        },
        `Restored image on product ID ${productId}`,
        await this.productContext(productId),
      );
    }

    return image;
  }

  async makePrimary(productId: string, id: string, actor?: { id: string; email: string }): Promise<ProductImage> {
    // Verify product exists and is active
    const product = await this.productsService.findByIdAfterTenancyAssertion(productId);
    if (product.status === ProductStatus.ARCHIVED || product.archivedAt !== null) {
      throw new BadRequestException('Cannot modify images of an archived product');
    }

    const image = await this.findById(productId, id);
    if (image.archivedAt) {
      throw new BadRequestException('Cannot make an archived image primary');
    }

    const beforeIsPrimary = image.isPrimary;

    if (!image.isPrimary) {
      await this.clearPrimaryFlagForProduct(productId);
      image.isPrimary = true;
      await this.productImageRepository.getEntityManager().flush();

      if (actor) {
        await this.auditLogService.recordAuditEntry(
          actor.id,
          actor.email,
          EntityType.PRODUCT_IMAGE,
          image.id,
          Action.MAKE_PRIMARY,
          {
            isPrimary: { before: beforeIsPrimary, after: image.isPrimary },
          },
          `Made image primary on product ID ${productId}`,
          await this.productContext(productId),
        );
      }
    }

    return image;
  }

  private async clearPrimaryFlagForProduct(productId: string): Promise<void> {
    const activeImages = await this.productImageRepository.find({
      product: productId,
      archivedAt: null,
    });
    for (const img of activeImages) {
      img.isPrimary = false;
    }
  }
}
