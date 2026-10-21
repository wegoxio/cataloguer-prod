import { EntityManager } from '@mikro-orm/postgresql';
import { InventoryPostingService } from '../src/modules/inventory/ledger/inventory-posting.service';
import { InventoryStockService } from '../src/modules/inventory/ledger/inventory-stock.service';
import { InventoryReservationService } from '../src/modules/inventory/reservations/inventory-reservation.service';
import { InventoryReservation } from '../src/modules/inventory/entities/inventory-reservation.entity';
import { InventoryTransferService } from '../src/modules/inventory/transfers/inventory-transfer.service';
import { InventoryTransfer } from '../src/modules/inventory/entities/inventory-transfer.entity';
import { InventoryTransaction } from '../src/modules/inventory/entities/inventory-transaction.entity';
import { InventoryPrincipal, storeLocationCode } from '../src/modules/inventory/ledger/inventory.types';
import { defaultWarehouseCode } from '../src/modules/inventory/opening/inventory-opening.types';

export const SYSTEM_PRINCIPAL: InventoryPrincipal = { kind: 'SYSTEM', origin: 'test-harness' };

export const realStock = (em: EntityManager): InventoryStockService => {
  const posting: any = Object.create(InventoryPostingService.prototype);
  posting.transactionRepository = em.getRepository(InventoryTransaction);
  const stock: any = Object.create(InventoryStockService.prototype);
  stock.posting = posting;
  return stock as InventoryStockService;
};

export const realReservations = (em: EntityManager): InventoryReservationService => {
  const posting: any = Object.create(InventoryPostingService.prototype);
  posting.transactionRepository = em.getRepository(InventoryTransaction);
  const stock: any = Object.create(InventoryStockService.prototype);
  stock.posting = posting;
  const reservations: any = Object.create(InventoryReservationService.prototype);
  reservations.reservationRepository = em.getRepository(InventoryReservation);
  reservations.posting = posting;
  reservations.stock = stock;
  return reservations as InventoryReservationService;
};

export const realTransfers = (em: EntityManager): InventoryTransferService => {
  const posting: any = Object.create(InventoryPostingService.prototype);
  posting.transactionRepository = em.getRepository(InventoryTransaction);
  const transfers: any = Object.create(InventoryTransferService.prototype);
  transfers.transferRepository = em.getRepository(InventoryTransfer);
  transfers.posting = posting;
  return transfers as InventoryTransferService;
};

export interface ReservationDouble {
  reservePhysical: jest.Mock;
  releasePhysical: jest.Mock;
  fulfilPhysical: jest.Mock;
  createBackorder: jest.Mock;
  cancelBackorder: jest.Mock;
  allocateBackorders: jest.Mock;
  enforcesStockAvailability: jest.Mock;
}

export const reservationDouble = (options: { enforces?: boolean } = {}): ReservationDouble => ({
  reservePhysical: jest.fn().mockResolvedValue({ reservationId: 'r-1', transactionId: 't-1' }),
  releasePhysical: jest.fn().mockResolvedValue(undefined),
  fulfilPhysical: jest.fn().mockResolvedValue(undefined),
  createBackorder: jest.fn().mockResolvedValue('bo-1'),
  cancelBackorder: jest.fn().mockResolvedValue(undefined),
  allocateBackorders: jest.fn().mockResolvedValue({ allocated: 0, backordersTouched: 0 }),
  enforcesStockAvailability: jest.fn().mockResolvedValue(options.enforces ?? true),
});

export interface StockDouble {
  issueForSale: jest.Mock;
  restoreFromCancellation: jest.Mock;
  setProductQuantity: jest.Mock;
  setBranchQuantity: jest.Mock;
}

export const stockDouble = (options: { available?: boolean } = {}): StockDouble => ({
  issueForSale: jest.fn().mockResolvedValue(options.available ?? true),
  restoreFromCancellation: jest.fn().mockResolvedValue(undefined),
  setProductQuantity: jest.fn().mockResolvedValue({ posted: true, delta: 0 }),
  setBranchQuantity: jest.fn().mockResolvedValue({ posted: true, delta: 0 }),
});

export async function prepareLedger(
  em: EntityManager,
  params: { organizationId: string; storeId?: string | null; productId?: string | null; quantity?: number },
): Promise<{ warehouseId: string; storeLocationId: string | null }> {
  const existingWarehouse: { id: string }[] = await em.execute(
    `select id from inventory_locations where organization_id = ? and is_default and kind = 'WAREHOUSE'`,
    [params.organizationId],
  );
  const warehouseId = existingWarehouse[0]?.id ?? (
    await em.execute(
      `insert into inventory_locations (organization_id, kind, code, name, store_id, is_default, created_at, updated_at)
       values (?, 'WAREHOUSE', ?, 'Main warehouse', null, true, now(), now()) returning id`,
      [params.organizationId, defaultWarehouseCode(params.organizationId)],
    )
  )[0].id;

  let storeLocationId: string | null = null;
  if (params.storeId) {
    const existing: { id: string }[] = await em.execute(
      `select id from inventory_locations where organization_id = ? and store_id = ?::uuid and kind = 'STORE'`,
      [params.organizationId, params.storeId],
    );
    storeLocationId = existing[0]?.id ?? (
      await em.execute(
        `insert into inventory_locations (organization_id, kind, code, name, store_id, is_default, created_at, updated_at)
         values (?, 'STORE', ?, 'Branch custody', ?::uuid, false, now(), now()) returning id`,
        [params.organizationId, storeLocationCode(params.storeId), params.storeId],
      )
    )[0].id;
  }

  if (params.productId && params.quantity && params.quantity > 0) {
    const stock = realStock(em);
    await em.execute('update organizations set inventory_cutover_frozen_at = now() where id = ?', [params.organizationId]);
    try {
      await em.transactional(async (tem) =>
        (stock as any).postSimple(tem as EntityManager, {
          organizationId: params.organizationId,
          type: 'OPENING_BALANCE',
          idempotencyKey: `harness-open:${params.productId}:${storeLocationId ?? warehouseId}:${params.quantity}`,
          principal: SYSTEM_PRINCIPAL,
          productId: params.productId,
          locationId: storeLocationId ?? warehouseId,
          quantity: params.quantity,
          sign: 1,
        }),
      );
    } finally {
      await em.execute('update organizations set inventory_cutover_frozen_at = null where id = ?', [params.organizationId]);
    }
  }
  return { warehouseId, storeLocationId };
}
