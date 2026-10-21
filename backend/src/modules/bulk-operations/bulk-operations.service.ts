import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { FlushMode } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityManager, EntityRepository } from '@mikro-orm/postgresql';
import { Product } from '../products/entities/product.entity';
import { StoreProduct } from '../products/entities/store-product.entity';
import { Store } from '../stores/entities/store.entity';
import { assertNotAFamilyCard } from '../products/families/family-membership';
import { Category } from '../categories/entities/category.entity';
import { ProductStatus } from '../products/catalogue/product-status.enum';
import { ProductsService } from '../products/catalogue/products.service';
import { PublicationGuardService } from '../products/publication/publication-guard.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EntityType, Action } from '../audit-log/entities/audit-log.entity';
import { TenantScope } from '../auth/tenancy/tenant-scope';
import { requireOrganizationScope, resolveStoresInScope } from '../auth/tenancy/tenant-assertions';
import { InventoryStockService } from '../inventory/ledger/inventory-stock.service';

export interface BulkResult {
  successCount: number;
  failedCount: number;
  successes: string[];
  failures: { id: string; message: string }[];
}

/**
 * What happened to ONE product in a bulk per-website publication (ADR 029).
 *
 *   UPDATED         the branch flag was flipped to the requested state
 *   UNCHANGED       it already held the requested state: no write, no audit
 *   SKIPPED_PARENT  a family card, which is never published on its own —
 *                   nothing written to it or to its children
 *   FAILED          a genuine problem: foreign or missing product, archived
 *                   product, not a member of that website, or a publication
 *                   guard refusal
 *
 * A card in the selection is EXPECTED — "select all matching" includes them —
 * so it is reported as a skip, not an error, and never counted as a failure.
 */
export type BranchPublicationOutcome = 'UPDATED' | 'UNCHANGED' | 'SKIPPED_PARENT' | 'FAILED';

export interface BranchPublicationItemOutcome {
  id: string;
  outcome: BranchPublicationOutcome;
  /** FAILED: the refusal; SKIPPED_PARENT: the fixed explanation. */
  message?: string;
  /**
   * UPDATED / UNCHANGED only. The branch flag is one of two facts that make
   * a product visible; a global Draft stays off the website until it is
   * published globally, and the dashboard says so. Informational — the status
   * is never written by this operation.
   */
  globalStatus?: 'DRAFT' | 'PUBLISHED';
}

export interface BulkBranchPublicationResult {
  storeId: string;
  published: boolean;
  updatedCount: number;
  unchangedCount: number;
  skippedParentCount: number;
  failedCount: number;
  /** One entry per requested id, in request order. */
  outcomes: BranchPublicationItemOutcome[];
}

/**
 * Raised inside a product's transaction when it turns out to be a family
 * card. Not an HttpException on purpose: the batch loop turns it into a
 * SKIPPED_PARENT outcome, and `withLockRetry` lets it escape untouched
 * because it is not a widening.
 */
class SkippedParentCard extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkippedParentCard';
  }
}

@Injectable()
export class BulkOperationsService {
  constructor(
    @InjectRepository(Product)
    private readonly productRepository: EntityRepository<Product>,
    @InjectRepository(Category)
    private readonly categoryRepository: EntityRepository<Category>,
    private readonly productsService: ProductsService,
    private readonly auditLogService: AuditLogService,
    private readonly publicationGuard: PublicationGuardService,
    private readonly stock: InventoryStockService,
  ) {}

  async bulkArchive(organizationId: string, ids: string[], actor?: { id: string; email: string }): Promise<BulkResult> {
    let successCount = 0;
    let failedCount = 0;
    const successes: string[] = [];
    const failures: { id: string; message: string }[] = [];

    for (const id of ids) {
      try {
        const product = await this.productRepository.findOne({
          id,
          organization: organizationId,
        });
        if (!product) {
          throw new NotFoundException(`Product with ID ${id} not found`);
        }
        if (product.status === ProductStatus.ARCHIVED || product.archivedAt !== null) {
          throw new BadRequestException('Product is already archived');
        }

        await this.productsService.archive(id, organizationId, actor, Action.BULK_ARCHIVE);
        successes.push(id);
        successCount++;
      } catch (err: any) {
        failedCount++;
        failures.push({ id, message: err.message || 'Archive failed' });
      }
    }

    return { successCount, failedCount, successes, failures };
  }

  async bulkRestore(organizationId: string, ids: string[], actor?: { id: string; email: string }): Promise<BulkResult> {
    let successCount = 0;
    let failedCount = 0;
    const successes: string[] = [];
    const failures: { id: string; message: string }[] = [];

    for (const id of ids) {
      try {
        const product = await this.productRepository.findOne({
          id,
          organization: organizationId,
        });
        if (!product) {
          throw new NotFoundException(`Product with ID ${id} not found`);
        }
        if (product.archivedAt === null || product.archivedAt === undefined) {
          throw new BadRequestException('Product is not archived');
        }

        await this.productsService.restore(id, organizationId, actor, Action.BULK_RESTORE);
        successes.push(id);
        successCount++;
      } catch (err: any) {
        failedCount++;
        failures.push({ id, message: err.message || 'Restore failed' });
      }
    }

    return { successCount, failedCount, successes, failures };
  }

  async bulkStatus(
    organizationId: string,
    ids: string[],
    status: ProductStatus,
    actor?: { id: string; email: string },
  ): Promise<BulkResult> {
    if (status === ProductStatus.ARCHIVED) {
      throw new BadRequestException('Status ARCHIVED is forbidden in this operation');
    }

    let successCount = 0;
    let failedCount = 0;
    const successes: string[] = [];
    const failures: { id: string; message: string }[] = [];

    const em = this.productRepository.getEntityManager();
    for (const id of ids) {
      try {
        // One fresh retryable transaction per product (B4a3): a refusal or a
        // widening rolls this product back whole and leaves the rest of the
        // batch untouched.
        const { product, beforeStatus } = await this.publicationGuard.withLockRetry(() =>
          em.transactional(async (tem) => {
            const product = await tem.findOne(Product, {
              id,
              organization: organizationId,
            });
            if (!product) {
              throw new NotFoundException(`Product with ID ${id} not found`);
            }
            if (product.archivedAt !== null || product.status === ProductStatus.ARCHIVED) {
              throw new BadRequestException('Cannot modify status of an archived product');
            }

            // Status first, so the guard validates the product as it will be.
            const beforeStatus = product.status;
            product.status = status;

            // Moving INTO published state turns every already-published pivot
            // live, so that is the exposure this transition validates.
            if (status === ProductStatus.PUBLISHED && beforeStatus !== ProductStatus.PUBLISHED) {
              const productOrgId = (product as any).organization?.id ?? (product as any).organization;
              await this.publicationGuard.applyGuardedPublication(tem, product, productOrgId, {
                publishingAll: true,
              });
            }
            await tem.flush();
            return { product, beforeStatus };
          }),
        );

        if (actor) {
          await this.auditLogService.recordAuditEntry(
            actor.id,
            actor.email,
            EntityType.PRODUCT,
            product.id,
            Action.BULK_STATUS,
            { status: { before: beforeStatus, after: product.status } },
            `Bulk updated status to ${product.status} for product "${product.name}"`,
            { organizationId: (product as any).organization?.id ?? (product as any).organization ?? null },
          );
        }

        successes.push(id);
        successCount++;
      } catch (err: any) {
        failedCount++;
        failures.push({ id, message: err.message || 'Status update failed' });
      }
    }

    return { successCount, failedCount, successes, failures };
  }

  /**
   * Bulk store-visibility assignment (ADR 007 P7.2): replaces each product's store set.
   *
   * Takes the whole TenantScope, not just an organization id. The id alone was
   * only ever used to filter which PRODUCTS could be touched; the target stores
   * were resolved by a bare existence lookup, so a request could name another
   * company's branch and have this write the pivot rows that put one company's
   * products on another's storefront.
   */
  async bulkStores(
    scope: TenantScope | undefined,
    ids: string[],
    storeIds: string[],
    actor?: { id: string; email: string },
  ): Promise<BulkResult> {
    const em = this.productRepository.getEntityManager();
    const organizationId = requireOrganizationScope(scope);

    // Replacement, not addition: whatever is not named here is detached from
    // every branch. That is a company-wide effect, so a branch-scoped actor is
    // refused the operation itself — restricting it to their own store would
    // still let them strip the products from every sibling branch.
    if (scope?.storeId != null) {
      throw new ForbiddenException(
        'Replacing store membership is a company-wide operation. Use the single-store assignment endpoints instead.',
      );
    }

    // Resolved under the caller's authority and de-duplicated first, so a
    // repeated id cannot skew the comparison. Throws a uniform not-found for
    // foreign, unauthorized and nonexistent ids alike — before any product is
    // loaded, any pivot is created, and any flush happens.
    const stores = await resolveStoresInScope(em, scope, storeIds);

    let successCount = 0;
    let failedCount = 0;
    const successes: string[] = [];
    const failures: { id: string; message: string }[] = [];

    for (const id of ids) {
      try {
        // One fresh retryable transaction per product (B4a3). Membership goes
        // through the guarded diff, never `stores.set()`: retained pivots keep
        // their branch state and publication untouched, new pivots are
        // published pivots and validate before they exist, and a refusal rolls
        // this product back whole while the rest of the batch continues.
        const { product, before } = await this.publicationGuard.withLockRetry(() =>
          em.transactional(async (tem) => {
            // Read from the database on every attempt: the transaction shares
            // the request's identity map, and a product it already holds would
            // otherwise be handed back as it was first read. A read of its
            // own, which refreshes the managed entity in place — and without
            // flushing first, so nothing an abandoned attempt left on that
            // entity is written before this attempt holds its keys.
            await tem.findOne(Product, { id }, { refresh: true, flushMode: FlushMode.COMMIT });
            const product = await tem.findOne(
              Product,
              { id, organization: organizationId },
              { populate: ['stores'] as never },
            );
            if (!product) {
              throw new NotFoundException(`Product with ID ${id} not found`);
            }
            // A card's shops are the union of its children's, reconciled on
            // every child move. Replacing them here would be undone silently.
            assertNotAFamilyCard(
              { id: product.id, name: product.name, childCount: await tem.count(Product, { parent: product.id }) },
              'its shops are worked out from its child products',
            );
            if (product.archivedAt !== null) {
              throw new BadRequestException('Cannot modify stores of an archived product');
            }

            const before = product.stores.getItems().map((store) => store.slug);
            // The pivot pairs the PRODUCT's company with the store; a store
            // resolved under the caller's scope but foreign to this product's
            // organization simply does not resolve for it.
            const productOrgId = (product as any).organization?.id ?? (product as any).organization;
            // Keys first, then the card question again under them: the count
            // above is as old as the read it came from, and a product promoted
            // to a card in the meantime is refused rather than stripped of a
            // branch its new child is published in.
            const membership = { storeIds: stores.map((store) => store.id), publishingAll: false };
            const held = await this.publicationGuard.lockMembershipEdit(tem, product, productOrgId, membership);
            await this.publicationGuard.refuseACard(tem, product, 'its shops are worked out from its child products');
            await this.publicationGuard.applyGuardedPublication(tem, product, productOrgId, { ...membership, held });
            await tem.flush();
            return { product, before };
          }),
        );

        if (actor) {
          await this.auditLogService.recordAuditEntry(
            actor.id,
            actor.email,
            EntityType.PRODUCT,
            product.id,
            Action.BULK_STORES,
            { stores: { before, after: stores.map((store) => store.slug) } },
            `Bulk updated store visibility for product "${product.name}"`,
            { organizationId: (product as any).organization?.id ?? (product as any).organization ?? null },
          );
        }

        successes.push(id);
        successCount++;
      } catch (err: any) {
        failedCount++;
        failures.push({ id, message: err.message || 'Store assignment failed' });
      }
    }

    return { successCount, failedCount, successes, failures };
  }

  /**
   * Publish or hide many products on ONE website (ADR 029).
   *
   * A write to `store_products.published` and to nothing else. Membership is
   * never created or removed here — a product that is not on the website is
   * reported, not added — and a card is never written: its presence on a
   * website is derived from its children, so it is SKIPPED with that
   * explanation rather than failed.
   *
   * Per product, one fresh retryable transaction (B4a3):
   *
   *   1. product loaded inside the caller's company; archived → FAILED;
   *   2. the website re-checked against the PRODUCT's company, unarchived;
   *   3. under the FAMILY-ROOT advisory lock (both directions — a hide must
   *      not race a concurrent grouping and land on a product that has just
   *      become a card), the child count and the pivot are read; publishing a
   *      hidden pivot additionally names the store-publication lock, so the
   *      keys are `[family root, store]` in the guard's canonical order;
   *   4. card → SKIPPED_PARENT; no pivot → FAILED; already in the requested
   *      state → UNCHANGED (nothing flushed);
   *   5. publishing runs the existing publication guard over exactly that
   *      store (`assertPublishable`), the same rule the single-store route and
   *      the importers apply — a refusal is this product's FAILED;
   *   6. `published` is assigned and flushed. Price, sale price, cost, stock,
   *      inventory tracking and lead time are not read for writing at all.
   *
   * The audit row (PUBLISH / UNPUBLISH, `branchPublished` before→after, with
   * the store in its context) is written after the commit, only for UPDATED.
   */
  async bulkBranchPublication(
    scope: TenantScope | undefined,
    ids: string[],
    storeId: string,
    published: boolean,
    actor?: { id: string; email: string },
  ): Promise<BulkBranchPublicationResult> {
    const em = this.productRepository.getEntityManager();
    const organizationId = requireOrganizationScope(scope);

    // The target website, resolved under the caller's authority before any
    // product is read: foreign, unauthorized and nonexistent ids all answer the
    // same not-found, and nothing has been written yet.
    const [target] = await resolveStoresInScope(em, scope, [storeId]);
    // A caller NARROWED to one branch (X-Managed-Store, or a store-carrying
    // session) may publish or hide only there. `allowedStoreIds` still names
    // every sibling for an organization-level actor, so the narrowing has to be
    // enforced here — with the same not-found, so siblings stay unenumerable.
    if (scope?.storeId != null && scope.storeId !== storeId) {
      throw new NotFoundException(`Store with ID ${storeId} not found`);
    }
    // An archived website is not a publication target. The whole request is
    // refused up front, like a foreign one, rather than answering 200 with one
    // failure per product.
    if (target.archivedAt) {
      throw new NotFoundException(`Store with ID ${storeId} not found`);
    }

    const notInBranch = 'This product is not on that website; add it there first (it is added hidden).';
    const outcomes: BranchPublicationItemOutcome[] = [];
    let updatedCount = 0;
    let unchangedCount = 0;
    let skippedParentCount = 0;
    let failedCount = 0;

    for (const id of ids) {
      try {
        const result = await this.publicationGuard.withLockRetry(() =>
          em.transactional(async (tem) => {
            const product = await tem.findOne(Product, { id, organization: organizationId });
            if (!product) {
              throw new NotFoundException(`Product with ID ${id} not found`);
            }
            if (product.archivedAt !== null || product.status === ProductStatus.ARCHIVED) {
              throw new BadRequestException('Cannot change website publication of an archived product');
            }

            const store = await tem.findOne(
              Store,
              { id: storeId, archivedAt: null },
              { populate: ['organization'] as never },
            );
            const productOrgId = (product as any).organization?.id ?? (product as any).organization ?? null;
            const storeOrgId = (store as any)?.organization?.id ?? (store as any)?.organization ?? null;
            if (!store || (productOrgId && storeOrgId && productOrgId !== storeOrgId)) {
              throw new NotFoundException(`Store with ID ${storeId} not found`);
            }

            // derive → acquire → rederive → assert-not-widened, with the
            // family root ALWAYS in the lock set. Everything the decision rests
            // on is re-read INSIDE the derivation — the product itself (its
            // parent names the family root), its child count and the pivot —
            // so the second derivation, made while the locks are held, is the
            // authoritative one. A grouping that completes between the two
            // reads is either seen (childCount > 0 → skipped, or a different
            // root → widening → fresh transaction) or serialized behind this
            // transaction. The product loaded above is only the entry ticket.
            const fresh = await this.publicationGuard.withFamilyShapeLocks(tem, async () => {
              const current = await tem.findOne(Product, { id: product.id }, { refresh: true });
              if (!current) throw new NotFoundException(`Product with ID ${id} not found`);
              const childCount = await tem.count(Product, { parent: current.id });
              const link = await tem.findOne(StoreProduct, { store: storeId, product: current.id }, { refresh: true });
              const exposes = published && childCount === 0 && !!link && !link.published;
              return {
                familyRootIds: [PublicationGuardService.familyRootIdOf(current)],
                validationStoreIds: exposes ? [storeId] : [],
                current,
                childCount,
                link,
              };
            });

            const current = fresh.current;
            if (fresh.childCount > 0) {
              try {
                assertNotAFamilyCard(
                  { id: current.id, name: current.name, childCount: fresh.childCount },
                  'its website publication is set on its child products',
                );
              } catch (err: any) {
                throw new SkippedParentCard(err.message);
              }
            }
            if (!fresh.link) {
              throw new BadRequestException(notInBranch);
            }

            const globalStatus: 'DRAFT' | 'PUBLISHED' =
              current.status === ProductStatus.PUBLISHED ? 'PUBLISHED' : 'DRAFT';
            if (fresh.link.published === published) {
              return { outcome: 'UNCHANGED' as const, product: current, store, globalStatus };
            }

            // The existing guard, over exactly the store this transition
            // exposes. Hiding validates nothing — nothing new is shown.
            await this.publicationGuard.assertPublishable(tem, current, fresh.validationStoreIds);

            // The ONE column this operation writes.
            fresh.link.published = published;
            await tem.flush();
            return { outcome: 'UPDATED' as const, product: current, store, globalStatus };
          }),
        );

        if (result.outcome === 'UPDATED') {
          updatedCount++;
          if (actor) {
            await this.auditLogService.recordAuditEntry(
              actor.id,
              actor.email,
              EntityType.PRODUCT,
              result.product.id,
              published ? Action.PUBLISH : Action.UNPUBLISH,
              { branchPublished: { before: !published, after: published } },
              published
                ? `Bulk published "${result.product.name}" on website "${result.store.name}"`
                : `Bulk hid "${result.product.name}" on website "${result.store.name}"`,
              {
                organizationId:
                  (result.product as any).organization?.id ?? (result.product as any).organization ?? null,
                storeId: result.store.id,
              },
            );
          }
        } else {
          unchangedCount++;
        }
        outcomes.push({ id, outcome: result.outcome, globalStatus: result.globalStatus });
      } catch (err: any) {
        if (err instanceof SkippedParentCard) {
          skippedParentCount++;
          outcomes.push({ id, outcome: 'SKIPPED_PARENT', message: err.message });
        } else {
          failedCount++;
          outcomes.push({ id, outcome: 'FAILED', message: err.message || 'Website publication failed' });
        }
      }
    }

    return { storeId, published, updatedCount, unchangedCount, skippedParentCount, failedCount, outcomes };
  }

  async bulkCategory(
    organizationId: string,
    ids: string[],
    categoryId: string | null,
    actor?: { id: string; email: string },
  ): Promise<BulkResult> {
    let category: Category | null = null;
    let categoryError: string | null = null;

    if (categoryId !== null && categoryId !== undefined && categoryId !== '') {
      category = await this.categoryRepository.findOne({
        id: categoryId,
        organization: organizationId,
      });
      if (!category) {
        categoryError = `Category with ID ${categoryId} not found`;
      } else if (category.archivedAt) {
        categoryError = 'Cannot assign an archived category';
      }
    }

    let successCount = 0;
    let failedCount = 0;
    const successes: string[] = [];
    const failures: { id: string; message: string }[] = [];

    for (const id of ids) {
      try {
        const product = await this.productRepository.findOne({
          id,
          organization: organizationId,
        });
        if (!product) {
          throw new NotFoundException(`Product with ID ${id} not found`);
        }
        if (product.archivedAt !== null || product.status === ProductStatus.ARCHIVED) {
          throw new BadRequestException('Cannot modify category of an archived product');
        }
        if (categoryError) {
          throw new BadRequestException(categoryError);
        }

        const beforeCategoryId = product.categories.getItems()[0]?.id ?? null;
        product.categories.set(category ? [category] : []);
        await this.productRepository.getEntityManager().flush();

        if (actor) {
          await this.auditLogService.recordAuditEntry(
            actor.id,
            actor.email,
            EntityType.PRODUCT,
            product.id,
            Action.BULK_CATEGORY,
            { categoryId: { before: beforeCategoryId, after: categoryId } },
            `Bulk assigned category for product "${product.name}"`,
            { organizationId },
          );
        }

        successes.push(id);
        successCount++;
      } catch (err: any) {
        failedCount++;
        failures.push({ id, message: err.message || 'Category assignment failed' });
      }
    }

    return { successCount, failedCount, successes, failures };
  }

  async bulkInventory(
    organizationId: string,
    ids: string[],
    stockQuantity: number,
    trackInventory?: boolean,
    actor?: { id: string; email: string },
  ): Promise<BulkResult> {
    let successCount = 0;
    let failedCount = 0;
    const successes: string[] = [];
    const failures: { id: string; message: string }[] = [];

    for (const id of ids) {
      try {
        if (stockQuantity < 0) {
          throw new BadRequestException('Stock quantity cannot be negative');
        }
        const product = await this.productRepository.findOne({
          id,
          organization: organizationId,
        });
        if (!product) {
          throw new NotFoundException(`Product with ID ${id} not found`);
        }
        if (product.archivedAt !== null || product.status === ProductStatus.ARCHIVED) {
          throw new BadRequestException('Cannot modify inventory of an archived product');
        }
        // A card in a bulk selection is SKIPPED, not fatal: the other rows are
        // ordinary products and there is no reason they should not be applied.
        // The row is reported so nobody is left thinking it was.
        assertNotAFamilyCard(
          {
            id: product.id,
            name: product.name,
            childCount: await this.productRepository.getEntityManager().count(Product, { parent: product.id }),
          },
          'it cannot hold stock or track inventory',
        );

        const before = {
          stockQuantity: product.stockQuantity,
          trackInventory: product.trackInventory,
        };

        // P5-B3: "set this product to N" is an ADJUSTMENT of the difference.
        // The ledger records movements, not assignments, so setting 4 to 7 is
        // three units arriving and the ledger says so. Setting a value the
        // product already holds moves nothing and posts nothing.
        const em = this.productRepository.getEntityManager() as EntityManager;
        await em.transactional(async (tem) => {
          await this.stock.setProductQuantity(tem as EntityManager, {
            organizationId,
            productId: product.id,
            targetQuantity: stockQuantity,
            origin: 'bulk-inventory',
            actor: actor ?? null,
          });
          if (trackInventory !== undefined) {
            product.trackInventory = trackInventory;
          }
          await tem.flush();
        });

        if (actor) {
          const changes: Record<string, any> = {};
          if (before.stockQuantity !== stockQuantity) {
            changes.stockQuantity = { before: before.stockQuantity, after: stockQuantity };
          }
          if (before.trackInventory !== product.trackInventory) {
            changes.trackInventory = { before: before.trackInventory, after: product.trackInventory };
          }
          await this.auditLogService.recordAuditEntry(
            actor.id,
            actor.email,
            EntityType.PRODUCT,
            product.id,
            Action.BULK_INVENTORY,
            changes,
            `Bulk updated inventory for product "${product.name}"`,
            { organizationId: (product as any).organization?.id ?? (product as any).organization ?? null },
          );
        }

        successes.push(id);
        successCount++;
      } catch (err: any) {
        failedCount++;
        failures.push({ id, message: err.message || 'Inventory update failed' });
      }
    }

    return { successCount, failedCount, successes, failures };
  }

  async bulkPricing(
    organizationId: string,
    ids: string[],
    price?: number,
    salePrice?: number | null,
    cost?: number | null,
    actor?: { id: string; email: string },
  ): Promise<BulkResult> {
    let successCount = 0;
    let failedCount = 0;
    const successes: string[] = [];
    const failures: { id: string; message: string }[] = [];

    for (const id of ids) {
      try {
        if (price !== undefined && price < 0) {
          throw new BadRequestException('Price cannot be negative');
        }
        if (salePrice !== undefined && salePrice !== null && salePrice < 0) {
          throw new BadRequestException('Sale price cannot be negative');
        }
        if (cost !== undefined && cost !== null && cost < 0) {
          throw new BadRequestException('Cost cannot be negative');
        }

        const product = await this.productRepository.findOne({
          id,
          organization: organizationId,
        });
        if (!product) {
          throw new NotFoundException(`Product with ID ${id} not found`);
        }
        if (product.archivedAt !== null || product.status === ProductStatus.ARCHIVED) {
          throw new BadRequestException('Cannot modify pricing of an archived product');
        }
        // A card takes a `price` — it is the sorting figure that places the
        // family in listings and price filters, and is never charged. It takes
        // neither a sale price nor a cost: nobody buys it and nobody buys it in.
        if (salePrice !== undefined || cost !== undefined) {
          assertNotAFamilyCard(
            {
              id: product.id,
              name: product.name,
              childCount: await this.productRepository.getEntityManager().count(Product, { parent: product.id }),
            },
            'it is never sold at a sale price and never bought at a cost',
          );
        }

        const before = {
          price: product.price,
          salePrice: product.salePrice ?? null,
          cost: product.cost ?? null,
        };

        const newPrice = price !== undefined ? price : product.price;
        const newSalePrice = salePrice !== undefined ? salePrice : (product.salePrice ?? null);

        if (newSalePrice !== null && Number(newSalePrice) > Number(newPrice)) {
          throw new BadRequestException('Sale price cannot exceed the regular price');
        }

        if (price !== undefined) product.price = price;
        if (salePrice !== undefined) product.salePrice = salePrice ?? undefined;
        if (cost !== undefined) product.cost = cost ?? undefined;

        await this.productRepository.getEntityManager().flush();

        if (actor) {
          const changes: Record<string, any> = {};
          if (before.price !== product.price) {
            changes.price = { before: before.price, after: product.price };
          }
          const currentSalePrice = product.salePrice ?? null;
          if (before.salePrice !== currentSalePrice) {
            changes.salePrice = { before: before.salePrice, after: currentSalePrice };
          }
          const currentCost = product.cost ?? null;
          if (before.cost !== currentCost) {
            changes.cost = { before: before.cost, after: currentCost };
          }
          await this.auditLogService.recordAuditEntry(
            actor.id,
            actor.email,
            EntityType.PRODUCT,
            product.id,
            Action.BULK_PRICING,
            changes,
            `Bulk updated pricing for product "${product.name}"`,
            { organizationId: (product as any).organization?.id ?? (product as any).organization ?? null },
          );
        }

        successes.push(id);
        successCount++;
      } catch (err: any) {
        failedCount++;
        failures.push({ id, message: err.message || 'Pricing update failed' });
      }
    }

    return { successCount, failedCount, successes, failures };
  }
}
