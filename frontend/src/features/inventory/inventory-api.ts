'use client';

import { apiFetch } from '../../lib/api-client';

/**
 * The operational inventory contract (Phase 8).
 *
 * Deliberately a small set of NAMED COMMANDS rather than a generic writer: the
 * backend exposes no ledger-posting route, and this mirror keeps the panel
 * honest about what it can actually ask for.
 */

export interface StoreAllocation {
  storeId: string;
  storeName: string;
  held: number;
}

export interface ProductStock {
  productId: string;
  /** Everything the company owns, wherever it sits — including in transit. */
  organizationTotal: number;
  /** What can be sold right now. Derived, never edited (ADR 013 decision 15). */
  sellable: number;
  warehouseRemainder: number;
  perStore: StoreAllocation[];
  reserved: number;
  transferCommitted: number;
  inTransit: number;
  nonSellable: number;
}

export interface InventoryLocation {
  id: string;
  kind: 'WAREHOUSE' | 'STORE' | string;
  name: string;
  storeId: string | null;
  isDefault: boolean;
}

export interface StockMovement {
  id: string;
  type: string;
  postedAt: string;
  idempotencyKey: string;
  actorEmail: string | null;
  actorKind: string;
  quantityDelta: number;
  operationalState: string;
  physicalCondition: string;
  locationName: string | null;
  storeId: string | null;
}

export interface ReconciliationFinding {
  invariant: string;
  detail: string;
}

const token = (accessToken: string) => ({ token: accessToken });

export const fetchProductStock = (accessToken: string, productId: string): Promise<ProductStock> =>
  apiFetch(`/inventory/products/${productId}`, token(accessToken)).then((r) => r.data);

export const fetchLocations = (accessToken: string): Promise<InventoryLocation[]> =>
  apiFetch('/inventory/locations', token(accessToken)).then((r) => r.data ?? []);

export const fetchStockHistory = (accessToken: string, productId: string): Promise<StockMovement[]> =>
  apiFetch(`/inventory/products/${productId}/history`, token(accessToken)).then((r) => r.data ?? []);

export const fetchReconciliation = (
  accessToken: string,
): Promise<{ findings: ReconciliationFinding[]; healthy: boolean }> =>
  apiFetch('/inventory/reconciliation', token(accessToken)).then((r) => r.data);

/**
 * A recount states what is ON THE SHELF, so re-submitting it converges instead
 * of accumulating — which is why it needs no idempotency key and why a branch
 * administrator is trusted with it for its own branch.
 */
export const postRecount = (
  accessToken: string,
  body: { productId: string; locationId: string; countedQuantity: number; reason: string },
) => apiFetch('/inventory/recount', { ...token(accessToken), method: 'POST', body: JSON.stringify(body) });

/**
 * The delta commands carry a key the CALLER generates once per intent, so a
 * double-click or a retried request is settled as a replay by the ledger
 * rather than applied twice.
 */
function withIdempotency(accessToken: string, key: string) {
  return { token: accessToken, headers: { 'Idempotency-Key': key } as Record<string, string> };
}

export const postReclassify = (
  accessToken: string,
  key: string,
  body: {
    productId: string;
    locationId: string;
    quantity: number;
    from: { physicalCondition: string; operationalState: string };
    to: { physicalCondition: string; operationalState: string };
    reason: string;
  },
) =>
  apiFetch('/inventory/reclassify', {
    ...withIdempotency(accessToken, key),
    method: 'POST',
    body: JSON.stringify(body),
  });

export const postReassign = (
  accessToken: string,
  key: string,
  body: {
    sourceProductId: string;
    destinationProductId: string;
    locationId: string;
    quantity: number;
    reason: string;
  },
) =>
  apiFetch('/inventory/reassign', {
    ...withIdempotency(accessToken, key),
    method: 'POST',
    body: JSON.stringify(body),
  });

export const postDistribute = (
  accessToken: string,
  key: string,
  body: {
    rootProductId: string;
    locationId: string;
    allocations: { productId: string; quantity: number }[];
    reason: string;
  },
) =>
  apiFetch('/inventory/distribute', {
    ...withIdempotency(accessToken, key),
    method: 'POST',
    body: JSON.stringify(body),
  });

export interface TransferRow {
  id: string;
  status: string;
  reference: string | null;
  createdAt: string;
  sourceName: string;
  destinationName: string;
}

export const fetchTransfers = (accessToken: string, status?: string): Promise<TransferRow[]> =>
  apiFetch(`/inventory/transfers${status ? `?status=${encodeURIComponent(status)}` : ''}`, token(accessToken)).then(
    (r) => r.data ?? [],
  );

export const createTransfer = (
  accessToken: string,
  body: {
    sourceLocationId: string;
    destinationLocationId: string;
    lines: { productId: string; quantity: number }[];
    reference?: string;
  },
) => apiFetch('/inventory/transfers', { ...token(accessToken), method: 'POST', body: JSON.stringify(body) });

/**
 * The lifecycle steps. Each refuses to run twice — dispatching an
 * already-dispatched transfer is a refusal, not a second movement — which is
 * what makes the buttons safe to press again after a lost response.
 */
export const advanceTransfer = (
  accessToken: string,
  transferId: string,
  step: 'commit' | 'dispatch' | 'receive' | 'start-return' | 'complete-return' | 'cancel',
  quantities?: Record<string, number>,
) =>
  apiFetch(`/inventory/transfers/${transferId}/${step}`, {
    ...token(accessToken),
    method: 'POST',
    body: JSON.stringify(quantities ? { quantities } : {}),
  });

/** A fresh key per intent; the same intent retried keeps its key. */
export const newIdempotencyKey = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `idem-${Date.now()}-${Math.random()}`;
