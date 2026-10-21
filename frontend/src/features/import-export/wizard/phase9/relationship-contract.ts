import type { RelationshipDecisions } from './relationships-step';

/**
 * Which relationship decisions an import type may collect at all.
 *
 * The wizard used to decide this from the mapped COLUMNS alone, with no
 * reference to the import type. A historical-sales import scoped to a shop was
 * therefore asked "Should these products be listed in this shop?" — a question
 * about a catalogue, put to a file recording things already sold — and the
 * answer was written into the plan and into its hash, where the compiler then
 * ignored it. It was inert, but nobody could tell that from the screen, and a
 * decision recorded in a hash is a decision somebody is attesting to.
 *
 * So the contract is stated once, here, and read by both halves that used to
 * disagree: the questions that get RENDERED, and the readiness that decides
 * when the plan may be built. Two places deriving the same rule is how they
 * came apart in the first place.
 *
 * The store SCOPE is deliberately not in this table. Historical sales must name
 * a shop, but that is `plan.storeId` — the scope the import runs under, refused
 * by the server when absent — not a relationship decision about listing things
 * in it. The two were easy to confuse precisely because the same shop appears
 * in both.
 */

/** Every relationship decision the wizard can collect. */
export type RelationshipKind = 'inventory' | 'stores' | 'categories';

/**
 * What each import type may be asked.
 *
 * Products is the only type with a catalogue to arrange. The other three write
 * records — categories, supplier orders, historical sales — and none of them
 * lists a product in a shop, files it under a category or puts stock anywhere.
 */
export const RELATIONSHIP_CONTRACT: Record<string, readonly RelationshipKind[]> = {
  PRODUCTS: ['inventory', 'stores', 'categories'],
  CATEGORIES: [],
  HISTORICAL_STORE_SALES: [],
};

/**
 * Whether this import type may be asked for this decision.
 *
 * Unknown types collect nothing. A type nobody has taught this table about is
 * one whose relationship semantics nobody has decided, and asking anyway is how
 * the leak happened.
 */
export function mayCollect(importType: string, kind: RelationshipKind): boolean {
  return (RELATIONSHIP_CONTRACT[importType] ?? []).includes(kind);
}

/**
 * The decisions this type is allowed to carry, and nothing else.
 *
 * Applied before a plan is built and to anything restored from browser storage.
 * Storage is the harder case: a mapping saved while the file was being imported
 * as products, then reopened as historical sales, would otherwise carry the old
 * `stores` and `categories` answers straight back into the new plan's hash —
 * silently, since the questions that produced them are no longer on screen.
 *
 * Keys are dropped rather than blanked. An absent decision and an empty one are
 * different facts: `{ stores: { storeIds: [] } }` says somebody chose to list
 * this nowhere, which is a claim this import type cannot make.
 */
export function normalizeRelationships(importType: string, decisions: RelationshipDecisions): RelationshipDecisions {
  const allowed = RELATIONSHIP_CONTRACT[importType] ?? [];
  const clean: RelationshipDecisions = { ...decisions };
  for (const kind of ['inventory', 'stores', 'categories'] as const) {
    if (!allowed.includes(kind)) delete clean[kind];
  }
  return clean;
}

/** Whether normalising would change anything — used to avoid pointless rewrites. */
export function hasIrrelevantRelationships(importType: string, decisions: RelationshipDecisions): boolean {
  const allowed = RELATIONSHIP_CONTRACT[importType] ?? [];
  return (['inventory', 'stores', 'categories'] as const).some(
    (kind) => !allowed.includes(kind) && decisions[kind] !== undefined,
  );
}
