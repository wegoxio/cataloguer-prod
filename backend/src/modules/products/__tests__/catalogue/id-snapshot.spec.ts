import { PRODUCT_ID_SNAPSHOT_CAP, ProductQueryService } from '../../catalogue/product-query.service';
import { ProductsController } from '../../catalogue/products.controller';

/**
 * THE SNAPSHOT THAT "SELECT EVERYTHING THAT MATCHES" IS BUILT ON.
 *
 * The list can only offer a cross-page selection honestly if the answer says
 * how many products match, not how many ids happened to fit. The old answer
 * reported the returned list's own length as `total`, so a filter matching
 * more than the cap was indistinguishable from one matching exactly the cap,
 * and a bulk action would then have run on an arbitrary part of it.
 */
describe('product id snapshot', () => {
  const service = (rows: { id: string }[], total: number) => {
    const s = Object.create(ProductQueryService.prototype) as any;
    s.buildProductWhere = jest.fn().mockResolvedValue({ organization: 'org-1' });
    s.productRepository = { findAndCount: jest.fn().mockResolvedValue([rows, total]) };
    return s;
  };
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p-${i + 1}` }));

  it('returns every id, the real total, and truncated false below the cap', async () => {
    const s = service(rows(3), 3);
    await expect(s.findMatchingIdSnapshot()).resolves.toEqual({
      ids: ['p-1', 'p-2', 'p-3'],
      total: 3,
      truncated: false,
    });
  });

  it('reports the REAL total and truncated true when more match than fit', async () => {
    // The database holds 25_000 matches; the query returns the capped page.
    const s = service(rows(PRODUCT_ID_SNAPSHOT_CAP), 25_000);
    const snapshot = await s.findMatchingIdSnapshot();
    expect(snapshot.ids).toHaveLength(PRODUCT_ID_SNAPSHOT_CAP);
    // The count is the number of matches, not the length of the answer.
    expect(snapshot.total).toBe(25_000);
    expect(snapshot.truncated).toBe(true);
  });

  it('counts without the cap so a full answer at the ceiling is not called truncated', async () => {
    const s = service(rows(PRODUCT_ID_SNAPSHOT_CAP), PRODUCT_ID_SNAPSHOT_CAP);
    const snapshot = await s.findMatchingIdSnapshot();
    // Exactly the cap is a complete answer, not a truncated one.
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.total).toBe(PRODUCT_ID_SNAPSHOT_CAP);
  });

  it('asks the database for ids only, bounded by the cap', async () => {
    const s = service(rows(2), 2);
    await s.findMatchingIdSnapshot();
    expect(s.productRepository.findAndCount).toHaveBeenCalledWith(
      { organization: 'org-1' },
      { fields: ['id'], limit: PRODUCT_ID_SNAPSHOT_CAP },
    );
  });

  it('honours an explicit cap, so a caller can ask for less', async () => {
    const s = service(rows(2), 9);
    await s.findMatchingIdSnapshot({ organizationId: 'org-1' }, 2);
    expect(s.productRepository.findAndCount).toHaveBeenCalledWith(expect.anything(), {
      fields: ['id'],
      limit: 2,
    });
  });

  it('keeps findMatchingIds returning just the ids for its existing callers', async () => {
    const s = service(rows(2), 2);
    await expect(s.findMatchingIds()).resolves.toEqual(['p-1', 'p-2']);
  });

  it('passes the filters through to the where clause unchanged', async () => {
    const s = service(rows(1), 1);
    const filters = { organizationId: 'org-1', search: 'lamp', storeFilterId: 'store-a' };
    await s.findMatchingIdSnapshot(filters);
    expect(s.buildProductWhere).toHaveBeenCalledWith(filters);
  });
});

/**
 * FILTER PARITY. The list route and the ids route must select the same set,
 * or "select everything that matches" would reach products the list never
 * showed. They share one translation from query string to filters; this pins
 * that every filter the Items list sends survives it.
 */
describe('list and ids share one filter translation', () => {
  const toFilters = (q: Record<string, any>) => {
    const c = Object.create(ProductsController.prototype) as any;
    return c.toFilters({ scope: { organizationId: 'org-1' } }, q);
  };

  it('maps every filter the Items list can send', () => {
    expect(
      toFilters({
        search: 'lamp',
        status: 'PUBLISHED',
        categoryId: 'cat-1',
        trackInventory: 'true',
        hasChildren: 'true',
        family: 'child',
        storeId: 'store-a',
        branchPublished: 'false',
        includeArchived: 'true',
        minPrice: '10.5',
        maxPrice: '99',
        hasSalePrice: 'true',
        hasImages: 'false',
        hasCategory: 'true',
        sellable: 'true',
        complete: 'false',
      }),
    ).toMatchObject({
      organizationId: 'org-1',
      search: 'lamp',
      status: 'PUBLISHED',
      categoryId: 'cat-1',
      trackInventory: true,
      hasChildren: true,
      family: 'child',
      storeFilterId: 'store-a',
      branchPublished: false,
      includeArchived: true,
      minPrice: 10.5,
      maxPrice: 99,
      hasSalePrice: true,
      hasImages: false,
      hasCategory: true,
      sellable: true,
      complete: false,
    });
  });

  it('carries the tenant from the request scope, never from the query', () => {
    const c = Object.create(ProductsController.prototype) as any;
    const filters = c.toFilters({ scope: { organizationId: 'org-1' } }, { organizationId: 'org-2' });
    expect(filters.organizationId).toBe('org-1');
  });

  it('drops the low-stock flag into its own filter rather than trackInventory', () => {
    expect(toFilters({ lowStock: 'true' })).toMatchObject({ lowStock: true });
  });

  it('ignores a family value that is not one of the known spellings', () => {
    expect(toFilters({ family: 'nonsense' }).family).toBeUndefined();
  });
});
