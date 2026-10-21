import { Product } from '../entities/product.entity';
import { Store } from '../../stores/entities/store.entity';
import { StoreProduct } from '../entities/store-product.entity';

/**
 * Whole-set store membership replacement, as a three-way diff (B4a3).
 *
 * `Collection.set()` cannot be used for this. It is not possible to prove from
 * its contract that a pivot whose store appears in both the old and the new set
 * keeps its row — and therefore its branch price, stock, lead time and
 * publication — rather than being deleted and reinserted with defaults. Those
 * are a branch's own commercial decisions; a membership edit must not touch
 * them.
 *
 * So membership is computed here, explicitly, and the caller acts on the
 * result:
 *
 *   removed   the pivot row is deleted
 *   retained  NOTHING is written — the row is not in the update set at all
 *   created   a complete new pivot, published, with no commercial values
 *
 * "Retained is untouched" is guaranteed by construction rather than by copying
 * fields forward: a retained pivot is returned as the very same object, and the
 * caller never assigns to it. In particular a branch that deliberately
 * unpublished a product does not have it republished merely because its store
 * id appears in the request again.
 *
 * Pure and deterministic: no EntityManager, no I/O, and every output array is
 * ordered by store id, so the same inputs in any order produce identical
 * output.
 */

export interface NewPivotDraft {
  organization: string;
  store: Store;
  product: Product;
  /** Stated, never inherited from the column default, which becomes false. */
  published: true;
  /**
   * No stock. P5-B3 removed the explicit zero: a new pivot is born with the
   * column's own default, because the ledger is the only thing that may set a
   * quantity, and a draft that names one would be a second opinion.
   */
  trackInventory: false;
  /** Absence, never zero: a branch that has not priced it has not priced it. */
  price: null;
  salePrice: null;
  cost: null;
  leadTimeDays: null;
}

export interface StoreMembershipDiff {
  removed: StoreProduct[];
  retained: StoreProduct[];
  created: NewPivotDraft[];
  /**
   * Exactly the stores whose pivots are transitioning INTO published state —
   * the created set. Retained pivots keep whatever publication they had, so
   * revalidating them could fail a replacement over a store whose state it
   * never changed. Removed pivots are leaving, so they cannot violate
   * anything. For a PURE membership edit this is the only list required-field
   * validation may see; an edit that also moves the PRODUCT into published
   * state widens validation to every pivot published in the final state,
   * retained ones included (see applyGuardedPublication in products.service).
   */
  publishingStoreIds: string[];
}

/**
 * Which stores a write NEWLY EXPOSES a product to.
 *
 * Publication is two facts, not one: the product's own status and each store
 * link's `published` flag. A customer sees the product in a store only when
 * BOTH are true, so a write exposes a store when it makes the pair true where
 * it was not.
 *
 * Three cases, and they are the whole rule:
 *
 *   - the product does not end PUBLISHED — nothing is exposed anywhere, whatever
 *     the links say, because a draft reaches nobody;
 *   - the product was already PUBLISHED — only links turning published are new;
 *   - the product BECOMES published — every link published in the final state
 *     goes live at once, including ones nobody touched. This is the case that
 *     is easy to miss: the write names no store at all, and yet exposes them.
 *
 * Pure and total: no EntityManager, no I/O, deterministic order. It exists so
 * the guarded ORM writer and the plan-based importer — which writes its own
 * rows and cannot use that writer — decide exposure from ONE definition rather
 * than two that drift.
 */
export interface PublicationSnapshot {
  /** Was the PRODUCT published before this write? */
  publishedBefore: boolean;
  /** Is it published after it? */
  publishedAfter: boolean;
  /** storeId → link published flag, before the write. Absent = no link. */
  before: Map<string, boolean>;
  /** storeId → link published flag, after it. */
  after: Map<string, boolean>;
}

export function newlyExposedStoreIds(snapshot: PublicationSnapshot): string[] {
  if (!snapshot.publishedAfter) return [];
  const exposed: string[] = [];
  for (const [storeId, published] of snapshot.after) {
    if (!published) continue;
    // A link that was already live under an already-published product is not
    // newly exposed; anything else is.
    if (snapshot.publishedBefore && snapshot.before.get(storeId) === true) continue;
    exposed.push(storeId);
  }
  return exposed.sort();
}

export const storeIdOf = (link: StoreProduct): string => {
  const store = link.store as unknown as Store | string;
  return typeof store === 'string' ? store : store.id;
};

export function diffStoreMembership(input: {
  product: Product;
  organizationId: string;
  existing: StoreProduct[];
  /** Already resolved under the caller's authority; order is irrelevant. */
  requestedStores: Store[];
}): StoreMembershipDiff {
  const { product, organizationId, existing, requestedStores } = input;

  // De-duplicate FIRST. A store id repeated in the request must not mint two
  // pivots, and must not make a resolved set look short.
  const wantedById = new Map<string, Store>();
  for (const store of requestedStores) wantedById.set(store.id, store);

  const existingByStore = new Map<string, StoreProduct>();
  for (const link of existing) existingByStore.set(storeIdOf(link), link);

  const removed: StoreProduct[] = [];
  const retained: StoreProduct[] = [];
  for (const [storeId, link] of existingByStore) {
    if (wantedById.has(storeId)) retained.push(link);
    else removed.push(link);
  }

  const created: NewPivotDraft[] = [];
  for (const [storeId, store] of wantedById) {
    if (existingByStore.has(storeId)) continue;
    created.push({
      organization: organizationId,
      store,
      product,
      published: true,
      trackInventory: false,
      price: null,
      salePrice: null,
      cost: null,
      leadTimeDays: null,
    });
  }

  const byStoreId = (a: StoreProduct, b: StoreProduct) => storeIdOf(a).localeCompare(storeIdOf(b));
  removed.sort(byStoreId);
  retained.sort(byStoreId);
  created.sort((a, b) => a.store.id.localeCompare(b.store.id));

  return {
    removed,
    retained,
    created,
    publishingStoreIds: created.map((c) => c.store.id),
  };
}
