import { BadRequestException, GoneException } from '@nestjs/common';
import { SalesService } from '../sales.service';
import { ProductStatus } from '../../products/catalogue/product-status.enum';
import { stockDouble, reservationDouble } from '../../../../test/inventory-stock-support';

/**
 * B2: a family parent is a card, not an item.
 *
 * The parent describes the model and may stay visible in the catalogue, but it
 * holds no stock of its own — an order against it would deduct nothing and
 * promise something that does not physically exist. Standalone items and
 * versions (children) stay sellable exactly as before.
 */

const STORE = '00000000-0000-4000-8000-0000000000a1';
const PARENT = '00000000-0000-4000-8000-00000000pa01'.replace(/[^0-9a-f-]/g, '0');
const CHILD = '00000000-0000-4000-8000-0000000000c1';
const ALONE = '00000000-0000-4000-8000-0000000000f1';

const productRow = (id: string) => ({
  id,
  name: 'item-' + id.slice(-4),
  price: '10.00',
  salePrice: null,
  status: ProductStatus.PUBLISHED,
  archivedAt: null,
  categories: { getItems: () => [], isInitialized: () => true },
});

const linkRow = (productId: string, over: Record<string, any> = {}) => ({
  product: { id: productId },
  store: { id: STORE },
  price: null,
  salePrice: null,
  stockQuantity: 5,
  trackInventory: true,
  published: true,
  ...over,
});

/**
 * Builds a SalesService whose EntityManager answers the two queries priceCart
 * makes: child rows (to detect parents) and StoreProduct links. Only the data
 * layer is mocked — every authorization and pricing decision runs the real
 * code.
 */
function serviceWith(products: any[], childrenOf: Record<string, string[]>, links: any[]) {
  const em = {
    find: jest.fn(async (entity: any, where: any) => {
      const name = entity?.name ?? String(entity);
      if (name === 'Product') {
        // the parent-detection query: children whose parent is in the set
        const wanted: string[] = where?.parent?.$in ?? [];
        return wanted.flatMap((pid) => (childrenOf[pid] ?? []).map((cid) => ({ id: cid, parent: { id: pid } })));
      }
      if (name === 'StoreProduct') return links;
      return [];
    }),
  };
  const productRepository = {
    find: jest.fn(async () => products),
    getEntityManager: () => em,
  };
  const service = new SalesService(
    { getEntityManager: () => em } as any,
    productRepository as any,
    { recordAuditEntry: jest.fn() } as any,
    { compute: jest.fn() } as any,
    stockDouble() as any,
    reservationDouble() as any,
  );
  return { service, em, productRepository };
}

describe('priceCart — family parents are never sellable (B2)', () => {
  it('rejects a family parent with the same message as an unavailable product', async () => {
    const { service } = serviceWith([productRow(PARENT)], { [PARENT]: [CHILD] }, [linkRow(PARENT)]);
    await expect(service.priceCart(STORE, [{ productId: PARENT, quantity: 1 }])).rejects.toThrow(BadRequestException);
    const parentMessage = await service
      .priceCart(STORE, [{ productId: PARENT, quantity: 1 }])
      .catch((e: Error) => e.message);

    // An id that does not exist in this store produces the identical message,
    // so a card cannot be told apart from something that is simply not sold.
    const { service: empty } = serviceWith([], {}, []);
    const missingMessage = await empty
      .priceCart(STORE, [{ productId: PARENT, quantity: 1 }])
      .catch((e: Error) => e.message);
    expect(parentMessage).toBe(missingMessage);
  });

  it('refuses any cart carrying a legacy variantId with 410 LEGACY_VARIANTS_REMOVED, even alongside a sellable productId (B4c)', async () => {
    const { service, em } = serviceWith([productRow(CHILD)], { [PARENT]: [CHILD] }, [linkRow(CHILD)]);
    const err = await service
      .priceCart(STORE, [
        { productId: CHILD, quantity: 1 },
        { productId: PARENT, variantId: CHILD, quantity: 1 },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoneException);
    const refusal = (err as GoneException).getResponse() as any;
    expect(refusal.code).toBe('LEGACY_VARIANTS_REMOVED');
    expect(refusal.variantIds).toEqual([CHILD]);
    expect(refusal.truncated).toBe(false);
    // The tombstone fires before any data is touched — there is nothing left
    // to translate the id against.
    expect(em.find).not.toHaveBeenCalled();
  });

  it('bounds the 410 tombstone payload to ten ids', async () => {
    const { service } = serviceWith([], {}, []);
    const items = Array.from({ length: 12 }, (_, i) => ({
      productId: PARENT,
      variantId: `00000000-0000-4000-8000-0000000000${i.toString(16).padStart(2, '0')}`,
      quantity: 1,
    }));
    const err = await service.priceCart(STORE, items).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoneException);
    const refusal = (err as GoneException).getResponse() as any;
    expect(refusal.code).toBe('LEGACY_VARIANTS_REMOVED');
    expect(refusal.variantIds).toHaveLength(10);
    expect(refusal.truncated).toBe(true);
  });

  it('rejects a parent that a storefront tries to buy alongside a valid item', async () => {
    const { service } = serviceWith([productRow(PARENT), productRow(CHILD)], { [PARENT]: [CHILD] }, [
      linkRow(PARENT),
      linkRow(CHILD),
    ]);
    await expect(
      service.priceCart(STORE, [
        { productId: CHILD, quantity: 1 },
        { productId: PARENT, quantity: 1 },
      ]),
    ).rejects.toThrow(BadRequestException);
  });

  it('prices a CHILD from its own branch link', async () => {
    const { service } = serviceWith(
      [productRow(CHILD)],
      { [PARENT]: [CHILD] }, // CHILD is a version, and has no children of its own
      [linkRow(CHILD, { price: '7.50' })],
    );
    const { lines, total } = await service.priceCart(STORE, [{ productId: CHILD, quantity: 2 }]);
    expect(lines).toHaveLength(1);
    expect(lines[0].product.id).toBe(CHILD);
    expect(total).toBe(15);
  });

  it('leaves STANDALONE products behaving exactly as before', async () => {
    const { service } = serviceWith([productRow(ALONE)], {}, [linkRow(ALONE)]);
    const { lines, total } = await service.priceCart(STORE, [{ productId: ALONE, quantity: 3 }]);
    expect(lines).toHaveLength(1);
    expect(lines[0].product.id).toBe(ALONE);
    expect(lines[0].link?.trackInventory).toBe(true);
    expect(total).toBe(30);
  });

  it('does not run the parent-detection query when the cart resolves to nothing', async () => {
    const { service, em } = serviceWith([], {}, []);
    await expect(service.priceCart(STORE, [{ productId: ALONE, quantity: 1 }])).rejects.toThrow(BadRequestException);
    const productQueries = em.find.mock.calls.filter((c: any[]) => (c[0]?.name ?? '') === 'Product');
    expect(productQueries).toHaveLength(0);
  });
});
