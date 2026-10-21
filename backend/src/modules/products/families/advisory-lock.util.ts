/**
 * Advisory lock keys for the publication invariant (B4a3).
 *
 * The invariant concerns ABSENT rows — a missing ProductFieldValue — so row
 * locks cannot serialize it: two transactions each validate against a state the
 * other is about to invalidate. Advisory locks are the only thing that can.
 *
 * THE TUPLE SORTED IS THE TUPLE LOCKED. PostgreSQL's one-argument
 * `pg_advisory_xact_lock(bigint)` and two-argument `pg_advisory_xact_lock(int4,
 * int4)` are DIFFERENT lock spaces, so ordering by one while locking the other
 * is not an ordering at all. Everything here is the two-int form, and the sort
 * key is exactly `(namespace, key)`.
 *
 * The key is computed in application code rather than by a database function so
 * the full ordering is known BEFORE the first lock is taken — which is what
 * makes deadlock-freedom provable rather than hoped for.
 *
 * Collisions are possible: two ids can hash to one int32. The consequence is
 * that two unrelated entities serialize against each other — wasted
 * concurrency, never a missed lock. Correctness does not depend on the hash
 * being injective.
 */

/** Namespaces are disjoint so a store id and a product id can never collide. */
export const LOCK_NS_STORE_PUBLICATION = 1;
export const LOCK_NS_PRODUCT_FAMILY = 2;
// Namespace 3 is reserved; keep it
// unassigned so an old in-flight process can never alias a new lock space.

export interface AdvisoryLockKey {
  ns: number;
  key: number;
}

/**
 * FNV-1a over the UTF-8 bytes, folded to a signed int32.
 *
 * Pinned deliberately: `Math.imul` for the 32-bit multiply (plain `*` loses
 * precision above 2^53 and would make the key depend on how the engine rounds),
 * and `| 0` for the signed conversion PostgreSQL's int4 expects. Fixed vectors
 * in the spec guard this against drifting with an implementation detail.
 */
export function fnv1a32(input: string): number {
  const bytes = new TextEncoder().encode(input);
  let hash = 2166136261;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 16777619);
  }
  return hash | 0;
}

export const storePublicationLock = (storeId: string): AdvisoryLockKey => ({
  ns: LOCK_NS_STORE_PUBLICATION,
  key: fnv1a32(storeId),
});

/**
 * Locks a whole family by its ROOT product id.
 *
 * A child's root is its parent; a standalone product with no parent is its own
 * root. That second case matters: without it a childless product would take no
 * family lock, and two operations that each turn it into (or out of) a family
 * would not serialize — which is precisely the shape-transition race this
 * namespace exists to close.
 */
export const productFamilyLock = (rootProductId: string): AdvisoryLockKey => ({
  ns: LOCK_NS_PRODUCT_FAMILY,
  key: fnv1a32(rootProductId),
});

/**
 * De-duplicates and returns the keys in the ONE order every caller must use.
 *
 * A total order over all participants is what prevents deadlock; any caller
 * acquiring in a different order reintroduces it, which is why acquisition
 * lives behind this function rather than at call sites.
 */
export function sortLockKeys(keys: AdvisoryLockKey[]): AdvisoryLockKey[] {
  const unique = new Map<string, AdvisoryLockKey>();
  for (const k of keys) unique.set(`${k.ns}:${k.key}`, k);
  return Array.from(unique.values()).sort((a, b) => (a.ns !== b.ns ? a.ns - b.ns : a.key - b.key));
}
