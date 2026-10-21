import { createHash } from 'crypto';
import { InventoryCommand, InventoryIntentLine, InventoryMovementLine } from './inventory.types';

/**
 * P5-B1 — the immutable digest of a posting command.
 *
 * `UNIQUE (organization_id, idempotency_key)` alone is not idempotency: it
 * makes a SECOND, DIFFERENT command under a reused key look like a successful
 * replay of the first. The fingerprint closes that: a replay must present the
 * same content, and a different payload under the same key is a conflict.
 *
 * Canonical form, so that no caller-side formatting can change the digest:
 *
 *  - object keys sorted lexicographically by UTF-16 code unit;
 *  - no insignificant whitespace;
 *  - null/undefined fields OMITTED rather than emitted, so `{a:1}` and
 *    `{a:1,b:null}` are the same command;
 *  - integers only — a non-integer quantity is rejected before hashing, since
 *    float formatting is not stable across runtimes;
 *  - intent and movement lines SORTED by their identity tuple, so the order the
 *    caller happened to build the array in is irrelevant.
 *
 * The movement sort order is reused as the projection lock order by the posting
 * service: one rule serving both the digest and deadlock avoidance.
 */

const assertInteger = (value: number, what: string): number => {
  if (!Number.isInteger(value)) throw new Error(`${what} must be an integer, received ${String(value)}`);
  return value;
};

/** Deterministic JSON: sorted keys, omitted nulls, no whitespace. */
export const canonicalJson = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('canonicalJson refuses non-integer numbers');
    return String(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new Error(`canonicalJson cannot serialise ${typeof value}`);
};

const intentKey = (line: InventoryIntentLine): string => line.productId;

/**
 * The identity tuple of a movement line. Also the lock order — see
 * `InventoryPostingService.applyProjections`.
 */
export const movementKey = (line: InventoryMovementLine): string =>
  [
    line.productId,
    line.locationId ?? '',
    line.physicalCondition,
    line.operationalState,
    line.transferId ?? '',
    line.transitDirection ?? '',
  ].join('|');

export const sortIntents = (lines: InventoryIntentLine[]): InventoryIntentLine[] =>
  [...lines].sort((a, b) => (intentKey(a) < intentKey(b) ? -1 : intentKey(a) > intentKey(b) ? 1 : 0));

export const sortMovements = (lines: InventoryMovementLine[]): InventoryMovementLine[] =>
  [...lines].sort((a, b) => (movementKey(a) < movementKey(b) ? -1 : movementKey(a) > movementKey(b) ? 1 : 0));

/**
 * The stable identity of the posting principal.
 *
 * A user is their id; a system poster is its origin. Email is deliberately
 * absent — it is a mutable display snapshot, and someone changing their address
 * must not turn a legitimate replay into a conflict.
 */
export const principalIdentity = (command: InventoryCommand): Record<string, unknown> =>
  command.principal.kind === 'USER'
    ? { kind: 'USER', userId: command.principal.userId }
    : { kind: 'SYSTEM', origin: command.principal.origin };

/**
 * The canonical payload. It INCLUDES the stable principal identity — who posted
 * a command is part of what the command is, and without it one actor could
 * replay another's key and be handed their transaction. It excludes the
 * idempotency key itself (the key is the lookup, not the content) and the
 * actor's email (mutable, non-authoritative).
 */
export const canonicalCommandPayload = (command: InventoryCommand): Record<string, unknown> => ({
  organizationId: command.organizationId,
  type: command.type,
  principal: principalIdentity(command),
  scopeProductId: command.scopeProductId ?? null,
  auditStoreId: command.auditStoreId ?? null,
  salesOrderId: command.salesOrderId ?? null,
  transferId: command.transferId ?? null,
  intents: sortIntents(command.intents).map((line) => ({
    productId: line.productId,
    declaredAmount: assertInteger(line.declaredAmount, 'declaredAmount'),
    intentSign: assertInteger(line.intentSign, 'intentSign'),
  })),
  movements: sortMovements(command.movements).map((line) => ({
    productId: line.productId,
    locationId: line.locationId ?? null,
    physicalCondition: line.physicalCondition,
    operationalState: line.operationalState,
    transferId: line.transferId ?? null,
    transitDirection: line.transitDirection ?? null,
    quantityDelta: assertInteger(line.quantityDelta, 'quantityDelta'),
  })),
});

/** Lowercase hex SHA-256 of the canonical payload. 64 characters, always. */
export const commandFingerprint = (command: InventoryCommand): string =>
  createHash('sha256')
    .update(canonicalJson(canonicalCommandPayload(command)), 'utf8')
    .digest('hex');
