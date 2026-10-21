import { NotFoundException } from '@nestjs/common';
import { ProductsService } from '../../catalogue/products.service';
import { PublicationGuardService } from '../../publication/publication-guard.service';
import { SalesService } from '../../../sales/sales.service';
import { stockDouble, reservationDouble } from '../../../../../test/inventory-stock-support';
import { productFamilyLock } from '../../families/advisory-lock.util';

/**
 * P0-06 acceptance criteria: what one branch does to a product — its price,
 * its stock, its visibility — never touches another branch.
 */
describe('branch isolation (P0-06)', () => {
  describe('assignment respects the tenant boundary', () => {
    const build = (emOverrides: Record<string, any> = {}) => {
      const em: any = {
        findOne: jest.fn().mockResolvedValue(null),
        find: jest.fn().mockResolvedValue([]),
        create: jest.fn((_: any, data: any) => data),
        persist: jest.fn(),
        flush: jest.fn(),
        removeAndFlush: jest.fn(),
        // The card guards ask how many children a product has before any
        // sellable-only field is written. These doubles describe ordinary
        // standalone products, so the honest answer is zero.
        count: jest.fn().mockResolvedValue(0),
        ...emOverrides,
      };
      // assignToStore runs in its own transaction now (B4a3); the same
      // object serves as root and transactional manager.
      em.transactional = jest.fn(async (cb: any) => cb(em));
      const productRepo: any = {
        findOne: jest.fn().mockResolvedValue({ id: 'p1', name: 'Silla', organization: { id: 'org-acme' } }),
        getEntityManager: () => em,
      };
      const service = new ProductsService(
        productRepo,
        {} as any,
        {} as any,
        { recordAuditEntry: jest.fn() } as any,
        {
          learnFromAcceptedGroup: jest.fn(),
          learnedWordsFor: jest.fn().mockResolvedValue([]),
          dismissedSignaturesFor: jest.fn().mockResolvedValue([]),
        } as any,
        new PublicationGuardService(),
        {} as any,
        stockDouble() as any,
      );
      return { service, em };
    };

    it('refuses a store of another organization as if it did not exist', async () => {
      const { service } = build({
        findOne: jest.fn(async (entity: any) => {
          const name = entity?.name ?? String(entity);
          if (name === 'Product') return { id: 'p1', name: 'Silla', organization: { id: 'org-acme' } };
          if (name === 'Store') return { id: 'store-rival', organization: { id: 'org-rival' } };
          return null;
        }),
      });

      await expect(service.assignToStore('p1', 'store-rival', {})).rejects.toThrow(NotFoundException);
    });

    it('creates the link with defaults for a same-organization store', async () => {
      const store = { id: 'store-acme', name: 'Acme Centro', organization: { id: 'org-acme' } };
      const locks: { ns: number; key: number }[] = [];
      const em: any = {
        // Entity-keyed: the guarded assignment reads product, store and the
        // (absent) existing link through the transactional manager.
        findOne: jest.fn(async (entity: any) => {
          const name = entity?.name ?? String(entity);
          if (name === 'Product') return { id: 'p1', name: 'Silla', organization: { id: 'org-acme' } };
          if (name === 'Store') return store;
          return null;
        }),
        create: jest.fn((_: any, data: any) => data),
        persist: jest.fn(),
        flush: jest.fn(),
        // A standalone product: no children, so the card guard lets the
        // assignment through.
        count: jest.fn().mockResolvedValue(0),
        // The card reconciliation asks where the product sits in its family
        // as the DATABASE has it. This one is a standalone: no parent.
        find: jest.fn(async () => [{ id: 'p1', parent: null }]),
        // The assignment decides under the product's family lock, taken with
        // `pg_advisory_xact_lock` on the transaction's own connection.
        execute: jest.fn(async (sql: string, params: number[] = []) => {
          if (/pg_advisory_xact_lock/.test(sql)) locks.push({ ns: params[0], key: params[1] });
          return [];
        }),
      };
      em.transactional = jest.fn(async (cb: any) => cb(em));
      // build() wraps em fns individually; rebuild with our em directly
      const productRepo: any = {
        findOne: jest.fn().mockResolvedValue({ id: 'p1', name: 'Silla', organization: { id: 'org-acme' } }),
        getEntityManager: () => em,
      };
      const stock = stockDouble();
      const svc = new ProductsService(
        productRepo,
        {} as any,
        {} as any,
        {
          recordAuditEntry: jest.fn(),
        } as any,
        {
          learnFromAcceptedGroup: jest.fn(),
          learnedWordsFor: jest.fn().mockResolvedValue([]),
          dismissedSignaturesFor: jest.fn().mockResolvedValue([]),
        } as any,
        new PublicationGuardService(),
        {} as any,
        stock as any,
      );

      const link: any = await svc.assignToStore('p1', 'store-acme', { stockQuantity: 7, trackInventory: true });

      expect(em.create).toHaveBeenCalled();
      // P5-B3: the branch quantity is a movement at that branch's custody
      // location; the service states the target and the ledger moves it.
      expect(stock.setBranchQuantity).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ storeId: 'store-acme', productId: 'p1', targetQuantity: 7 }),
      );
      expect(link.trackInventory).toBe(true);
      // Nothing is published, so only the family key is held.
      expect(locks).toEqual([productFamilyLock('p1')]);
    });
  });

  describe('checkout prices and deducts from the branch link', () => {
    const product = {
      id: 'p1',
      name: 'Silla',
      price: 100,
      salePrice: null,
      trackInventory: false,
      stockQuantity: 0,
      categories: { isInitialized: () => false, getItems: () => [] },
    };
    // Same product, two branches with their own price and stock
    const linkA = {
      id: 'link-a',
      product: { id: 'p1' },
      store: { id: 'store-a' },
      price: 80,
      salePrice: null,
      stockQuantity: 5,
      trackInventory: true,
    };
    const linkB = {
      id: 'link-b',
      product: { id: 'p1' },
      store: { id: 'store-b' },
      price: 120,
      salePrice: null,
      stockQuantity: 9,
      trackInventory: true,
    };

    const buildSales = () => {
      const execute = jest.fn().mockResolvedValue({ affectedRows: 1 });
      // Like PostgreSQL: the order's database-generated id exists only after
      // the flush — never earlier (same contract as the oversell harness).
      const persisted: any[] = [];
      const tem: any = {
        create: jest.fn((_: any, data: any) => data),
        persist: jest.fn((entity: any) => {
          persisted.push(entity);
        }),
        flush: jest.fn(async () => {
          for (const entity of persisted) {
            if (entity.orderNumber !== undefined && entity.id === undefined) entity.id = 'db-generated-uuid';
          }
        }),
        execute,
      };
      const em: any = {
        find: jest.fn(async (entity: any, where: any) =>
          String(entity).includes('StoreProduct') || where?.store ? [where.store === 'store-a' ? linkA : linkB] : [],
        ),
        findOne: jest.fn(async () => ({ id: 'store-a', organization: { id: 'org-1' } })),
        transactional: jest.fn(async (fn: any) => fn(tem)),
      };
      const orderRepo: any = {
        getEntityManager: () => em,
        findOne: jest.fn().mockResolvedValue(null),
      };
      const productRepo: any = { find: jest.fn().mockResolvedValue([product]) };
      const stock = stockDouble();
      const service = new SalesService(
        orderRepo,
        productRepo,
        { recordAuditEntry: jest.fn() } as any,
        {
          compute: jest.fn().mockResolvedValue({ discountUsd: 0, codeText: null, code: null }),
        } as any,
        stock as any,
        reservationDouble() as any,
      );
      return { service, execute, stock };
    };

    it("uses THIS branch's price, not the base and not the sibling's", async () => {
      const { service } = buildSales();

      const cartA = await service.priceCart('store-a', [{ productId: 'p1', quantity: 1 } as any]);
      const cartB = await service.priceCart('store-b', [{ productId: 'p1', quantity: 1 } as any]);

      expect(cartA.total).toBe(80);
      expect(cartB.total).toBe(120);
    });

    it("draws stock from THIS branch's custody only (#160, P5-B3)", async () => {
      const { service, stock } = buildSales();

      const order = await service.createFromWebsite('store-a', [{ productId: 'p1', quantity: 2 } as any], 'key-1');

      // Exactly one draw, aimed at store-a — never the sibling, never an
      // organization-wide total. The branch is named explicitly, so a mistake
      // here cannot silently fall back to another branch's custody.
      expect(stock.issueForSale).toHaveBeenCalledTimes(1);
      expect(stock.issueForSale).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ storeId: 'store-a', productId: 'p1', quantity: 2 }),
      );
      // The fresh-creation response carries the id the flush minted.
      expect(order.id).toBe('db-generated-uuid');
    });
  });
});
