import { BadRequestException } from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { SalesService } from '../sales.service';
import { stockDouble, reservationDouble } from '../../../../test/inventory-stock-support';

/**
 * #160: the public checkout must be transactional and atomic.
 *
 * P5-B3 moved WHERE that atomicity lives, not whether it holds. The conditional
 * decrement used to be one statement in this service; the same guarantee is now
 * the ledger's `CHECK (quantity >= 0)` under the row lock, and
 * `oversell-concurrency.pg.spec.ts` proves it against real PostgreSQL with 20
 * concurrent buyers.
 *
 * What this suite proves is the SERVICE's half of the contract, which is
 * unchanged: it asks for the units inside the transaction, it refuses the whole
 * order when the answer is no, it records exactly what was taken, and it never
 * touches stock for an untracked link.
 */
describe('public checkout cannot oversell (#160)', () => {
  const product = {
    id: 'p1',
    name: 'Silla',
    price: 100,
    salePrice: null,
    trackInventory: false,
    stockQuantity: 0,
    categories: { isInitialized: () => false, getItems: () => [] },
  };
  const trackedLink = {
    id: 'link-1',
    product: { id: 'p1' },
    store: { id: 'store-a' },
    price: 80,
    salePrice: null,
    stockQuantity: 1,
    trackInventory: true,
  };

  const build = (overrides?: { available?: boolean; link?: any }) => {
    const execute = jest.fn().mockResolvedValue({ affectedRows: 1 });
    const stock = stockDouble({ available: overrides?.available ?? true });
    const persisted: any[] = [];
    const tem: any = {
      create: jest.fn((_: any, data: any) => data),
      persist: jest.fn((entity: any) => {
        persisted.push(entity);
      }),
      // Like PostgreSQL: the id exists only after the flush. The service must
      // therefore flush inside the transaction before reading order.id.
      flush: jest.fn(async () => {
        for (const entity of persisted) {
          if (entity.orderNumber !== undefined && entity.id === undefined) entity.id = 'db-generated-uuid';
        }
      }),
      execute,
    };
    const em: any = {
      find: jest.fn(async () => [overrides?.link ?? trackedLink]),
      // The branch's company, read once before the transaction opens.
      findOne: jest.fn(async () => ({ id: 'store-a', organization: { id: 'org-1' } })),
      transactional: jest.fn(async (fn: any) => fn(tem)),
    };
    const orderRepo: any = {
      getEntityManager: () => em,
      findOne: jest.fn().mockResolvedValue(null),
    };
    const productRepo: any = { find: jest.fn().mockResolvedValue([product]) };
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
    return { service, execute, tem, em, orderRepo, stock };
  };

  it('takes stock through the ledger, inside the checkout transaction', async () => {
    const { service, em, tem, stock } = build();

    const result = await service.createFromWebsite('store-a', [{ productId: 'p1', quantity: 1 } as any]);

    expect(em.transactional).toHaveBeenCalled();
    // The transaction manager the callback received — so the sale, the ledger
    // posting and the compatibility caches commit or roll back together.
    expect(stock.issueForSale).toHaveBeenCalledWith(
      tem,
      expect.objectContaining({ organizationId: 'org-1', storeId: 'store-a', productId: 'p1', quantity: 1 }),
    );
    // The order line records exactly what was taken — never less than sold
    const line = tem.create.mock.calls.find((c: any) => c[1].stockDeducted !== undefined)?.[1];
    expect(line.quantity).toBe(1);
    expect(line.stockDeducted).toBe(1);
    expect(result.orderNumber).toBeDefined();
  });

  it('returns the PERSISTED order id on fresh creation — flushed inside the transaction, after all writes', async () => {
    const { service, tem } = build();

    const result = await service.createFromWebsite('store-a', [{ productId: 'p1', quantity: 1 } as any]);

    // The database generates the id at flush time; a response built before
    // the flush would carry undefined (caught by the real-PostgreSQL run).
    expect(result.id).toBe('db-generated-uuid');
    expect(tem.flush).toHaveBeenCalledTimes(1);
    // Ordering: every write is staged before the flush that mints the id.
    const flushOrder = tem.flush.mock.invocationCallOrder[0];
    for (const persistCall of tem.persist.mock.invocationCallOrder) {
      expect(persistCall).toBeLessThan(flushOrder);
    }
    for (const createCall of tem.create.mock.invocationCallOrder) {
      expect(createCall).toBeLessThan(flushOrder);
    }
  });

  it('rejects the whole order when the last unit was just taken (lost race)', async () => {
    // The ledger refused the draw: the cell would have gone negative.
    const { service, tem } = build({ available: false });

    await expect(service.createFromWebsite('store-a', [{ productId: 'p1', quantity: 1 } as any])).rejects.toThrow(
      /Not enough stock/,
    );
    // The error escapes the transactional callback BEFORE the flush, so the
    // database rolls back everything and no id was ever minted.
    expect(tem.flush).not.toHaveBeenCalled();
  });

  it('rejects a quantity above the available stock instead of partially selling', async () => {
    // The original defect deducted min(stock, qty)=1 while selling 5. The draw
    // is for the WHOLE quantity, so a short branch sells nothing at all.
    const { service, stock } = build({ available: false });

    await expect(service.createFromWebsite('store-a', [{ productId: 'p1', quantity: 5 } as any])).rejects.toThrow(
      /Not enough stock/,
    );
    expect(stock.issueForSale).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ quantity: 5 }));
  });

  it('sells untracked items without touching stock', async () => {
    // ADR 013 §7: the per-link flag is still the sole committed gate.
    const untracked = { ...trackedLink, trackInventory: false };
    const { service, tem, stock } = build({ link: untracked });

    await service.createFromWebsite('store-a', [{ productId: 'p1', quantity: 3 } as any]);

    expect(stock.issueForSale).not.toHaveBeenCalled();
    const line = tem.create.mock.calls.find((c: any) => c[1].stockDeducted !== undefined)?.[1];
    expect(line.stockDeducted).toBe(0);
  });

  it('returns the winner order when two same-key retries race past the lookup', async () => {
    const { service, em, orderRepo } = build();
    em.transactional.mockRejectedValue(new UniqueConstraintViolationException(new Error('duplicate key')));
    orderRepo.findOne
      .mockResolvedValueOnce(null) // pre-transaction lookup
      .mockResolvedValueOnce({ orderNumber: 'AAA111', totalUsd: '80.00', id: 'o1' });

    const result = await service.createFromWebsite(
      'store-a',
      [{ productId: 'p1', quantity: 1 } as any],
      'C',
      'T',
      'key-1',
    );

    expect(result.orderNumber).toBe('AAA111');
  });

  it('propagates a real failure instead of masking it as idempotency', async () => {
    const { service, em } = build();
    em.transactional.mockRejectedValue(new BadRequestException('boom'));

    await expect(
      service.createFromWebsite('store-a', [{ productId: 'p1', quantity: 1 } as any], 'C', 'T', 'key-1'),
    ).rejects.toThrow('boom');
  });
});
