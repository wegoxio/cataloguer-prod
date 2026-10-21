import { NotFoundException } from '@nestjs/common';
import { ProductsService } from '../../catalogue/products.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { stockDouble } from '../../../../../test/inventory-stock-support';

/** Minimal stand-in for MikroORM's Collection. */
function collection(initial: any[] = []) {
  let items = [...initial];
  return {
    getItems: () => items,
    set: (next: any[]) => {
      items = [...next];
    },
    add: (x: any) => {
      items.push(x);
    },
    init: async () => undefined,
    isInitialized: () => true,
  };
}

/**
 * P0-05 acceptance criteria at the service layer: identity — slug and SKU —
 * lives inside one organization, and another client's catalogue is invisible.
 */
describe('catalogue identity is per organization (P0-05)', () => {
  let service: ProductsService;
  let productRepo: any;
  let categoriesService: any;

  const acmeActor = { id: 'u1', email: 'a@acme.com' };
  /**
   * P5-A3: the company is the caller's RESOLVED organization, passed
   * explicitly. It was derived inside the service from `actor.store` via
   * `organizationIdOfActor` — a tenant lookup off a user binding, which is
   * exactly what A3 removes. The invariant these cases prove is unchanged.
   */
  const ACME_ORG = 'org-acme';

  beforeEach(() => {
    productRepo = {
      // create() re-reads the product by id at the end; identity checks get null
      findOne: jest
        .fn()
        .mockImplementation((where: any) =>
          where?.id ? { id: where.id, name: 'Silla', stores: collection(), categories: collection() } : null,
        ),
      find: jest.fn().mockResolvedValue([]),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
      create: jest.fn((data: any) => ({ id: 'p-new', ...data, stores: collection(), categories: collection() })),
      getEntityManager: jest.fn(),
    };
    // The creation transaction: entity work goes through this manager, and
    // Product creation is routed to productRepo.create so the identity
    // assertions below keep reading the one mock.
    const tem = {
      create: jest.fn((entity: any, data: any) =>
        (entity?.name ?? String(entity)) === 'Product' ? productRepo.create(data) : { ...data },
      ),
      getReference: jest.fn((_entity: any, id: string) => ({ id })),
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      persist: jest.fn(),
      remove: jest.fn(),
      flush: jest.fn(),
      persistAndFlush: jest.fn(),
    };
    productRepo.getEntityManager.mockReturnValue({
      persistAndFlush: jest.fn(),
      flush: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue({ id: 'store-acme', organization: { id: 'org-acme' } }),
      transactional: jest.fn(async (cb: any) => cb(tem)),
    });
    categoriesService = { findById: jest.fn(), findAssignableCategory: jest.fn() };
    service = new ProductsService(
      productRepo,
      { findOne: jest.fn().mockResolvedValue(null), find: jest.fn().mockResolvedValue([]) } as any,
      categoriesService,
      { recordAuditEntry: jest.fn() } as any,
      {
        learnFromAcceptedGroup: jest.fn(),
        learnedWordsFor: jest.fn().mockResolvedValue([]),
        dismissedSignaturesFor: jest.fn().mockResolvedValue([]),
      } as any,
      new PublicationGuardService(),
      { writeCreationValues: jest.fn() } as any,
      stockDouble() as any,
    );
  });

  it('checks SKU collisions only inside the actor organization', async () => {
    await service.create({ name: 'Silla', sku: 'CH-01' } as any, acmeActor, null, ACME_ORG);

    expect(productRepo.findOne).toHaveBeenCalledWith({ sku: 'CH-01', organization: 'org-acme' });
  });

  it('checks slug collisions only inside the actor organization', async () => {
    await service.create({ name: 'Silla Nordica' } as any, acmeActor, null, ACME_ORG);

    expect(productRepo.findOne).toHaveBeenCalledWith({ slug: 'silla-nordica', organization: 'org-acme' });
  });

  it("stamps the new product with the actor's organization", async () => {
    await service.create({ name: 'Silla' } as any, acmeActor, null, ACME_ORG);

    expect(productRepo.create).toHaveBeenCalledWith(expect.objectContaining({ organization: 'org-acme' }));
  });

  it('refuses a category belonging to another organization as if it did not exist', async () => {
    categoriesService.findAssignableCategory.mockRejectedValue(
      new NotFoundException('Category with ID cat-rival not found'),
    );

    await expect(
      service.create({ name: 'Silla', categoryId: 'cat-rival' } as any, acmeActor, null, ACME_ORG),
    ).rejects.toThrow(NotFoundException);
  });

  it('refuses to create a product with no organization at all', async () => {
    productRepo.getEntityManager().findOne.mockResolvedValue(null);

    await expect(service.create({ name: 'Silla' } as any)).rejects.toThrow(/must belong to an organization/);
  });

  it('falls back to a safe sort field when sortBy is not on the whitelist', async () => {
    await service.findAll({ organizationId: 'org-acme', sortBy: 'passwordHash; drop table products' } as any);

    const options = productRepo.findAndCount.mock.calls[0][1];
    expect(options.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('scopes the list to the organization when the filter carries one', async () => {
    await service.findAll({ organizationId: 'org-acme' } as any);

    const where = productRepo.findAndCount.mock.calls[0][0];
    expect(where.$and).toContainEqual({ organization: 'org-acme' });
  });
});
