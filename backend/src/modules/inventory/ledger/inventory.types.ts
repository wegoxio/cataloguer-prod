/**
 * P5-B1 — the vocabulary of the inventory ledger (ADR 013).
 *
 * Everything here is data, not behaviour: the posting mechanism reads these
 * tables to decide what a command is allowed to do. Keeping the rules in one
 * place is deliberate — the same union feeds the entity CHECK constraints, the
 * posting assertions and the proof suites, so a new transaction type cannot be
 * introduced in one of the three and forgotten in the others.
 */

export const PHYSICAL_CONDITIONS = ['GOOD', 'DAMAGED'] as const;
export type PhysicalCondition = (typeof PHYSICAL_CONDITIONS)[number];

/**
 * The operational dimension. It is ORTHOGONAL to condition (Decision 1):
 * DAMAGED + AVAILABLE is a legal, sellable cell, and sellability is derived
 * from the pair plus an explicit audited reclassification — it is never a
 * stored dimension of its own.
 */
export const OPERATIONAL_STATES = [
  'AVAILABLE',
  'RESERVED',
  'TRANSFER_COMMITTED',
  'IN_TRANSIT',
  'NON_SELLABLE',
] as const;
export type OperationalState = (typeof OPERATIONAL_STATES)[number];

/** Only AVAILABLE is sellable. IN_TRANSIT is owned but not sellable (owner decision 1). */
export const SELLABLE_STATES: readonly OperationalState[] = ['AVAILABLE'];

export const TRANSIT_DIRECTIONS = ['DISPATCH', 'RETURN'] as const;
export type TransitDirection = (typeof TRANSIT_DIRECTIONS)[number];

export const LOCATION_KINDS = ['WAREHOUSE', 'STORE'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/**
 * The immutable code of a store's canonical custody location (owner decision 3).
 * Derived from the store's UUID, never from its slug: a slug is a mutable human
 * label, and custody identity that can be renamed is not identity.
 */
export const storeLocationCode = (storeId: string): string => `STORE:${storeId}`;

export const TRANSACTION_TYPES = [
  // total-preserving, in place
  'RESERVE',
  'RELEASE',
  'ALLOCATE',
  'TRANSFER_COMMIT',
  'TRANSFER_DISPATCH',
  'TRANSFER_RECEIVE',
  'TRANSFER_RETURN',
  'SELLABILITY_RECLASSIFY',
  // total-preserving, but the QUANTITY MOVES BETWEEN PRODUCTS
  'FAMILY_STOCK_DISTRIBUTION',
  'PRODUCT_STOCK_REASSIGNMENT',
  // total-changing
  'OPENING_BALANCE',
  'RECEIPT',
  'SALE_ISSUE',
  'SALE_RETURN',
  'ADJUSTMENT',
] as const;
export type InventoryTransactionType = (typeof TRANSACTION_TYPES)[number];

/**
 * How a type conserves quantity.
 *
 * - IN_PLACE      — every product's own entries net to zero; the quantity moves
 *                   between cells of the SAME product.
 * - CROSS_PRODUCT — the quantity legitimately moves BETWEEN products, so
 *                   per-product nets are non-zero by design. Each product still
 *                   carries its own signed intent line, and the transaction must
 *                   additionally net to zero. Organization-wide net-zero is an
 *                   ADDITIONAL assertion here, never the only one.
 * - NET_CHANGE    — the organization's owned total legitimately changes; every
 *                   product declares its own signed amount.
 */
export type ConservationMode = 'IN_PLACE' | 'CROSS_PRODUCT' | 'NET_CHANGE';

/** Extra columns, beyond the product, at which an IN_PLACE type must conserve. */
export type ConservationGrain = 'location' | 'physicalCondition';

/**
 * How a CROSS_PRODUCT type chooses its legal products (R12).
 *
 * - FAMILY  — the constrained case: the source is exactly the named family root
 *             and every destination is a legitimate child of that root.
 * - GENERAL — the generalized case: source and destination are any two distinct
 *             products of the acting organization; no family relationship is
 *             required or implied.
 */
export type CrossProductRule = 'FAMILY' | 'GENERAL';

export interface TransactionTypeRule {
  readonly mode: ConservationMode;
  /**
   * Additional grain columns for IN_PLACE conservation.
   *
   * These form ONE COMPOSITE KEY together with the product — they are not
   * checked one at a time. Checking them separately proves only the row and
   * column marginals of the movement matrix, and a 2x2 cross-swap satisfies
   * both marginals while moving quantity between forbidden cells: take 5 from
   * (L1, GOOD) and (L2, DAMAGED), give 5 to (L1, DAMAGED) and (L2, GOOD), and
   * every location nets zero and every condition nets zero while five units
   * changed both their location and their condition.
   */
  readonly grain: readonly ConservationGrain[];
  /** Intent signs this type admits. */
  readonly signs: readonly (-1 | 0 | 1)[];
  /** CROSS_PRODUCT types must name the scope their products are checked against. */
  readonly requiresScopeProduct?: boolean;
  readonly crossProductRule?: CrossProductRule;
  readonly exactIntentLines?: number;
  readonly minIntentLines?: number;
}

export const TRANSACTION_TYPE_RULES: Readonly<Record<InventoryTransactionType, TransactionTypeRule>> = {
  // A reservation moves units between states of one product at one location and
  // one condition; nothing may cross a location or a condition boundary.
  RESERVE: { mode: 'IN_PLACE', grain: ['location', 'physicalCondition'], signs: [0] },
  RELEASE: { mode: 'IN_PLACE', grain: ['location', 'physicalCondition'], signs: [0] },
  // Allocation and transfers change WHERE the units are; condition is preserved.
  ALLOCATE: { mode: 'IN_PLACE', grain: ['physicalCondition'], signs: [0] },
  TRANSFER_COMMIT: { mode: 'IN_PLACE', grain: ['physicalCondition'], signs: [0] },
  TRANSFER_DISPATCH: { mode: 'IN_PLACE', grain: ['physicalCondition'], signs: [0] },
  TRANSFER_RECEIVE: { mode: 'IN_PLACE', grain: ['physicalCondition'], signs: [0] },
  TRANSFER_RETURN: { mode: 'IN_PLACE', grain: ['physicalCondition'], signs: [0] },
  // Reclassification changes condition and/or state in place; the location holds.
  SELLABILITY_RECLASSIFY: { mode: 'IN_PLACE', grain: ['location'], signs: [0] },
  // The two product-changing types. Both carry explicit per-product signed
  // intent: a negative source line and one or more positive destination lines.
  FAMILY_STOCK_DISTRIBUTION: {
    mode: 'CROSS_PRODUCT',
    grain: [],
    signs: [-1, 1],
    requiresScopeProduct: true,
    crossProductRule: 'FAMILY',
    minIntentLines: 2,
  },
  PRODUCT_STOCK_REASSIGNMENT: {
    mode: 'CROSS_PRODUCT',
    grain: [],
    signs: [-1, 1],
    requiresScopeProduct: true,
    crossProductRule: 'GENERAL',
    exactIntentLines: 2,
  },
  OPENING_BALANCE: { mode: 'NET_CHANGE', grain: [], signs: [1] },
  RECEIPT: { mode: 'NET_CHANGE', grain: [], signs: [1] },
  SALE_RETURN: { mode: 'NET_CHANGE', grain: [], signs: [1] },
  SALE_ISSUE: { mode: 'NET_CHANGE', grain: [], signs: [-1] },
  ADJUSTMENT: { mode: 'NET_CHANGE', grain: [], signs: [-1, 1] },
};

/** One immutable declared intent: "this product moves this many units, this way". */
export interface InventoryIntentLine {
  productId: string;
  /** Always POSITIVE. The direction lives in `intentSign` (ADR 013 §1). */
  declaredAmount: number;
  /** 0 = in-place movement of `declaredAmount` units; ±1 = net change. */
  intentSign: -1 | 0 | 1;
}

/** One signed ledger line. `quantityDelta` is never zero. */
export interface InventoryMovementLine {
  productId: string;
  /** Null only for IN_TRANSIT, which is owned but present at no location. */
  locationId: string | null;
  physicalCondition: PhysicalCondition;
  operationalState: OperationalState;
  transferId?: string | null;
  transitDirection?: TransitDirection | null;
  quantityDelta: number;
}

/**
 * Who posted a command.
 *
 * This is part of the command's IDENTITY, not decoration. Without it, actor B
 * could submit actor A's idempotency key with an otherwise identical command
 * and receive A's transaction back as a successful replay — silently
 * attributing B's action to A. The stable half (kind plus user id, or kind plus
 * system origin) therefore enters the fingerprint.
 *
 * Email does NOT: it is a mutable snapshot for readability, and a user changing
 * their address must not turn a replay into a conflict.
 */
export type InventoryPrincipal =
  | { kind: 'USER'; userId: string; email?: string | null }
  | { kind: 'SYSTEM'; origin: string };

export interface InventoryCommand {
  organizationId: string;
  type: InventoryTransactionType;
  idempotencyKey: string;
  /** Required: every posting is attributable (see InventoryPrincipal). */
  principal: InventoryPrincipal;
  intents: InventoryIntentLine[];
  movements: InventoryMovementLine[];
  /** Family root / reassignment scope for CROSS_PRODUCT types. */
  scopeProductId?: string | null;
  /** Affected-resource branch for the P5-A1 audit context. */
  auditStoreId?: string | null;
  salesOrderId?: string | null;
  transferId?: string | null;
}

export interface PostedTransaction {
  transactionId: string;
  organizationId: string;
  type: InventoryTransactionType;
  commandFingerprint: string;
  /** True when an identical command had already been posted under this key. */
  replayed: boolean;
}

/** Transaction-local flag the projection guard requires (see the migration). */
export const POSTING_GUARD_SETTING = 'cataloguer.posting';
