/**
 * P5-B2 — the vocabulary of the opening epoch.
 *
 * The epoch is the point of no return (ADR 013 §10): after the first posted
 * opening transaction the system stays frozen until cutover completes or the
 * verified backup is restored. Everything here therefore fails closed.
 */

export type DiscrepancyClass = 'MATCHED' | 'PRODUCT_ONLY' | 'ALLOCATION_ONLY' | 'DIVERGENT';

/**
 * The immutable legacy bytes a reconciliation decision was made against.
 * Canonically ordered so the fingerprint cannot move for cosmetic reasons.
 */
export interface LegacySnapshot {
  productId: string;
  productQuantity: number;
  trackInventory: boolean;
  stores: { storeId: string; quantity: number; trackInventory: boolean }[];
}

export interface OpeningAllocationInput {
  destinationLocationId: string;
  approvedQuantity: number;
}

export interface OpeningApprovalInput {
  organizationId: string;
  productId: string;
  approvedOrgTotal: number;
  allocations: OpeningAllocationInput[];
  discrepancyReason?: string | null;
  approvedByUserId: string;
}

/**
 * The immutable code of an organization's default warehouse.
 *
 * Derived from the organization's uuid for the same reason store codes are
 * derived from the store's (owner decision 3): custody identity that can be
 * renamed is not identity. The human label lives in `name`.
 */
export const defaultWarehouseCode = (organizationId: string): string => `WAREHOUSE:${organizationId}`;

/** One fail-closed reason the opening epoch refused to run. */
export interface OpeningBlocker {
  code: string;
  detail: string;
}
