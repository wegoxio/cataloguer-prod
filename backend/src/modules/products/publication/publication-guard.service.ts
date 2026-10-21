import { ConflictException, Injectable } from '@nestjs/common';
import { FlushMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { Product } from '../entities/product.entity';
import { ProductStatus } from '../catalogue/product-status.enum';
import { ProductFieldDefinition } from '../entities/product-field-definition.entity';
import { ProductFieldValue } from '../entities/product-field-value.entity';
import { StoreFieldSetting } from '../entities/store-field-setting.entity';
import { StoreProduct } from '../entities/store-product.entity';
import { Store } from '../../stores/entities/store.entity';
import { diffStoreMembership, newlyExposedStoreIds, storeIdOf, StoreMembershipDiff } from '../shared/store-membership.util';
import { AdvisoryLockKey, productFamilyLock, sortLockKeys, storePublicationLock } from '../families/advisory-lock.util';
import { assertNotAFamilyCard } from '../families/family-membership';

/** A product's company id, or null when it carries none. */
const organizationIdOf = (product: Product): string | null => {
  const organization = product.organization as unknown as { id?: string } | string | null | undefined;
  if (!organization) return null;
  return (typeof organization === 'string' ? organization : (organization.id ?? null)) || null;
};

/** A product's parent id, or null when it is standalone or a parent itself. */
const parentIdOf = (product: Product): string | null => {
  const parent = product.parent as unknown as { id?: string } | string | null | undefined;
  if (!parent) return null;
  return (typeof parent === 'string' ? parent : (parent.id ?? null)) || null;
};

/**
 * Thrown when phase two re-derives a lock key that phase one did not hold.
 *
 * The guard NEVER retries. Acquiring the extra key here would break the total
 * ordering that makes deadlock impossible, and retrying inside a transaction
 * that is about to be rolled back is not a retry at all. Only the owner of the
 * transaction can respond, by starting a fresh one.
 */
export class LockSetWidenedError extends Error {
  constructor(readonly missing: AdvisoryLockKey[]) {
    super(`lock set widened by ${missing.length} key(s) after acquisition`);
    this.name = 'LockSetWidenedError';
  }
}

/** PostgreSQL's answer to `NOWAIT` (and to `lock_timeout`): the row or key is held by somebody else. */
export const LOCK_NOT_AVAILABLE = '55P03';

export const isLockNotAvailable = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;

/**
 * Thrown by a writer that asked for a row lock with `NOWAIT` and was refused.
 *
 * The transaction that asked is aborted by then, so, as with a widening, only
 * its owner can respond, by starting a fresh one. `rows` says which rows were
 * busy, for the owner to wait on — holding nothing — before it tries again.
 */
export class RowLockUnavailableError extends Error {
  constructor(readonly rows: { table: 'products' | 'store_products'; ids: string[] }) {
    super(`row lock not available on ${rows.table}`);
    this.name = 'RowLockUnavailableError';
  }
}

export interface PublicationRefusal {
  message: string;
  /** The FIRST blocking store by ascending id. Others may also block. */
  storeId: string;
  /** Normalized-key ascending, capped at MAX_MISSING_FIELD_KEYS. */
  missingFieldKeys: string[];
  /** The true total for this store, which may exceed the list length. */
  missingFieldCount: number;
  truncated: boolean;
}

/** The mirror-image refusal, from the store's side (B4a3): making a field
 * required while products the store currently shows leave it unanswered. */
export interface RequirementRefusal {
  message: string;
  storeId: string;
  /** Ascending product ids, capped at MAX_MISSING_PRODUCT_IDS. */
  missingProductIds: string[];
  /** The true total, which may exceed the list length. */
  missingProductCount: number;
  truncated: boolean;
}

/** Refusal for clearing a value that branches currently DEMAND (B4a3). */
export interface ValueDeletionRefusal {
  message: string;
  /** Ascending store ids demanding the field, capped at MAX_BLOCKING_STORE_IDS. */
  blockingStoreIds: string[];
  /** The true total, which may exceed the list length. */
  blockingStoreCount: number;
  /**
   * Phase 2: the shown products that would lose their EFFECTIVE answer —
   * the product itself and/or children relying on the inherited value.
   * Ascending, capped like the store list; the counts are complete.
   */
  affectedProductIds: string[];
  affectedProductCount: number;
  truncated: boolean;
}

/**
 * A family-shape transition's lock demand (B4a3): the roots it touches, and
 * the stores its final shape newly exposes the product to (empty for a pure
 * attach). Derive callbacks may carry extra fields — `withFamilyShapeLocks`
 * returns the under-lock derivation whole, so callers decide from state read
 * while the locks were held.
 */
export interface FamilyShapeExposure {
  familyRootIds: string[];
  validationStoreIds: string[];
}

/** How a caller describes the exposure of a membership-shaped operation. */
export interface MembershipExposureOptions {
  /** The full requested store set; omit when membership is not being edited. */
  storeIds?: string[];
  /**
   * True when the PRODUCT is moving into published state in this operation:
   * validation then covers every pivot published in the final state, not only
   * newly created ones. The caller must have applied the status change to the
   * entity BEFORE deriving, so the guard sees the product as it will be.
   */
  publishingAll: boolean;
  /**
   * The keys `lockMembershipEdit` already took for this same operation.
   *
   * A writer that has to write BEFORE it can validate — the editor posts stock
   * and applies scalar changes first, so that validation sees the product as it
   * will be — takes its keys up front, and hands them back here. The guard then
   * acquires nothing: it re-derives, and refuses if what it would need now is
   * more than what is held. Acquiring here instead would take a key after rows
   * had been written, which is the order the import runner's keys are taken
   * against.
   */
  held?: AdvisoryLockKey[];
}

@Injectable()
export class PublicationGuardService {
  static readonly MAX_MISSING_FIELD_KEYS = 10;
  static readonly MAX_MISSING_PRODUCT_IDS = 10;
  static readonly MAX_BLOCKING_STORE_IDS = 10;

  /** Three TOTAL transactions, not one attempt plus three retries. */
  static readonly MAX_LOCK_ATTEMPTS = 3;

  /**
   * Runs an operation, restarting it whole if the lock set widened.
   *
   * Each attempt must be a complete, fresh transaction with a fresh entity
   * graph: a widening means the state the decision rested on moved, and the
   * previous attempt's Unit of Work is discarded with its rollback.
   *
   * The catch sits OUT here, never inside the transactional callback. By the
   * time this sees the error the rollback has completed — catching it inside
   * would leave already-staged rows in a doomed transaction and retry against
   * an entity graph that no longer means anything.
   *
   * Two things retry: a widening, and a row lock asked for with `NOWAIT` and
   * refused (`RowLockUnavailableError`), which is a writer's way of never
   * waiting for a second row while it holds a first. Every other error — a
   * refusal, a validation failure, a constraint violation, a deadlock — escapes
   * immediately, because retrying it would only produce the same answer more
   * slowly.
   */
  async withLockRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= PublicationGuardService.MAX_LOCK_ATTEMPTS; attempt++) {
      try {
        return await operation();
      } catch (err) {
        if (!(err instanceof LockSetWidenedError) && !(err instanceof RowLockUnavailableError)) throw err;
        if (attempt === PublicationGuardService.MAX_LOCK_ATTEMPTS) {
          throw new ConflictException('Store membership kept changing while this was being applied. Please try again.');
        }
      }
    }
    /* istanbul ignore next — the loop either returns or throws */
    throw new ConflictException('Store membership kept changing while this was being applied.');
  }

  /**
   * The B4a3 exposure protocol, over ANY exposure derivation:
   *
   *   derive → acquire → rederive → assert-not-widened → validate
   *
   * `derive` is called twice on purpose. The first call exists only to NAME
   * the locks; the second, made while they are held, is the one that is
   * validated — and returned, so the caller acts on state read under the
   * locks, never on the discovery read. If the second call derives a lock the
   * first did not take, the state the decision rested on moved between the
   * reads — LockSetWidenedError escapes, and only the owner of the transaction
   * may respond, by starting a fresh one.
   */
  async withValidatedExposure<T extends { validationStoreIds: string[] }>(
    tem: EntityManager,
    product: Product,
    derive: () => Promise<T>,
  ): Promise<T> {
    const discovered = await derive();
    const held = await this.acquire(tem, this.exposureLockKeys(product, discovered.validationStoreIds));

    const fresh = await derive();
    this.assertNotWidened(held, this.exposureLockKeys(product, fresh.validationStoreIds));
    await this.assertPublishable(tem, product, fresh.validationStoreIds);
    return fresh;
  }

  /**
   * The one guarded publication step for membership-shaped writers — create,
   * update, bulk assignment, imports (B4a3):
   *
   *   discover → acquire → rederive → validate → apply
   *
   * It answers a single question — which stores will NEWLY expose this product
   * to customers once this operation commits? — and validates exactly those:
   *
   *   - a membership edit exposes the pivots it creates, so `storeIds` alone
   *     validates the created set (retained pivots keep whatever publication
   *     and validity they had; removed pivots are leaving);
   *   - a product moving INTO published state exposes every pivot published in
   *     the FINAL post-operation membership — retained published pivots
   *     included, because the status flip is what turns them live
   *     (`publishingAll`).
   *
   * `stores.set()` is deliberately not used for the membership half. Its
   * contract does not guarantee that a pivot whose store appears in both the
   * old and new set keeps its row — and therefore its branch price, stock,
   * lead time and publication — and it cannot populate the pivot's own
   * organization at all. Membership is computed as an explicit diff and
   * applied row by row instead.
   *
   * Pivots are persisted strictly AFTER validation succeeds: a published pivot
   * must never exist, even uncommitted, for a product the guard would refuse.
   */
  async applyGuardedPublication(
    tem: EntityManager,
    product: Product,
    organizationId: string,
    opts: MembershipExposureOptions,
  ): Promise<void> {
    // A MEMBERSHIP EDIT ALWAYS HOLDS ITS FAMILY KEY, whether or not it exposes
    // anything. `withValidatedExposure` takes no key at all for an edit that
    // creates no pivot, which left a removal free to run beside a family-shape
    // transition of the same product — and to decide from a shape that
    // transition was about to change. A publication with no membership edit
    // exposes what it always did and keeps the protocol it always had, unless
    // its caller took the keys up front.
    const derive = () => this.membershipExposure(tem, product, organizationId, opts);
    const fresh =
      opts.storeIds !== undefined || opts.held
        ? await this.withMembershipLocks(tem, product, derive, opts.held)
        : await this.withValidatedExposure(tem, product, derive);

    if (fresh.diff) {
      for (const link of fresh.diff.removed) tem.remove(link);
      for (const draft of fresh.diff.created) tem.persist(tem.create(StoreProduct, draft as any));
      // A CHILD's membership just changed, so its parent's derived membership
      // is now stale. Reconciling here rather than at each call site is what
      // makes the invariant hold for every writer — create, update, bulk
      // assignment and both import paths reach the pivots only through this
      // method.
      if (fresh.diff.removed.length > 0 || fresh.diff.created.length > 0) {
        await this.reconcileParentStores(tem, product, organizationId);
      }
    }
  }

  /**
   * A parent's stores are DERIVED: exactly the union of its current children's.
   *
   * The parent is not sold; its pivots exist so its card can be found in the
   * stores that actually carry something buyable. That union was computed once,
   * when the family was created, and never again — so a child attached with a
   * new store left the card unreachable there (children never list separately,
   * so nothing represented it), and a child leaving left the card advertised in
   * a store with nothing behind it.
   *
   * Recomputed in the CALLER'S transaction, so the shape change and the derived
   * membership commit or roll back together.
   *
   * It routes through `applyGuardedPublication`, the one pivot writer, rather
   * than writing rows itself: that keeps the locking, validation and
   * retained-pivot guarantees identical to every other membership edit — in
   * particular, a store that deliberately unpublished the card keeps that
   * decision, because a retained pivot is never written to.
   *
   * Terminates in one step: a parent has no parent (the membership guard
   * refuses a three-level hierarchy), so the nested call reconciles nothing.
   */
  async reconcileParentStores(tem: EntityManager, child: Product, organizationId: string | null): Promise<void> {
    // The entity's parent is the row's parent by the time this runs: every
    // caller reaches it under keys that were refused if the two disagreed.
    await this.reconcileStoresOfParent(tem, parentIdOf(child), organizationId);
  }

  /**
   * The same reconciliation addressed by parent id, for the shape transitions
   * that reach it from the other side — attach, release — where the child's
   * own `parent` is either not yet or no longer the answer.
   */
  async reconcileStoresOfParent(
    tem: EntityManager,
    parentId: string | null,
    organizationId: string | null,
    held?: AdvisoryLockKey[],
  ): Promise<void> {
    if (!parentId) return;

    // The diff above is still pending in the unit of work, and the reads below
    // use `refresh` to see the database as it stands. Without this flush they
    // would compute the union from the PRE-EDIT rows and undo the very change
    // that triggered them.
    await tem.flush();

    const parent = await tem.findOne(Product, { id: parentId });
    if (!parent) return;

    // The company is resolved from the PARENT when the caller could not name
    // one. It is never assumed: store resolution filters by organization, so a
    // null company would resolve zero stores and read as "belongs nowhere" —
    // which would strip every pivot the card has. Refusing to act is the only
    // safe direction for a company that cannot be established.
    const company = organizationId ?? organizationIdOf(parent);
    if (!company) return;

    // The union is READ under the family lock, not before it.
    //
    // Reading it unprotected and locking only inside `applyGuardedPublication`
    // left a window with teeth: two batches each moving a different child of
    // one card interleaved so that the second saw the first's PARENT pivot but
    // not the child pivot that justified it, and removed a store the card had
    // legitimately just gained. Proven against real PostgreSQL by
    // `existing-child-store-import.pg.spec.ts` before this was fixed.
    //
    // `withFamilyShapeLocks` is the codebase's protocol for exactly this:
    // derive to NAME the locks, acquire them in the one canonical order,
    // derive again to DECIDE, and refuse if the second derivation needs a key
    // the first did not take.
    //
    // The store keys named are the stores the card will GAIN, never the whole
    // union. That is what keeps the ordering safe when this runs nested inside
    // a child's own guarded write: the card can only gain a store some child
    // just gained, and those store keys are already held by that operation, so
    // no store lock (namespace 1) is ever taken while a family lock
    // (namespace 2) is held.
    //
    // "Already held by that operation" is a DEMAND ON THE CALLER, not something
    // this method can check — `assertNotWidened` compares this method's own two
    // derivations, never the outer transaction's held set. A caller holding a
    // family key while this runs must already hold a store key for every store
    // named here, or it takes namespace 1 after namespace 2 and deadlocks
    // against a writer taking them the other way round. `storesToGain` is what
    // such a caller names its keys from. It is NOT the code below: this method
    // derives with its own reads, and `storesToGain` applies the same rule in
    // a read of its own — every branch a child of the card is in, less the
    // branches the card is in. For a card in the catalogue the two answer
    // alike. For a card REMOVED from it, it depends on who is asking. A
    // transaction that has not loaded the card finds no parent in the lookup
    // above and returns, while `storesToGain` still names the branches of a
    // child pointing at it: more keys than are needed. A transaction that
    // holds the card LOADED from before it was removed is handed that same
    // entity by the lookup — the removed filter is not applied to an entity
    // the identity map already holds loaded — and this method runs on the
    // removed card. An attachment beside the removal of its card is such a
    // caller (#337).
    //
    // That is not a guarantee this method can give. The rows can change between
    // a caller naming its keys and this method deriving them. Every writer
    // behind the API that gives a product a branch or takes one away holds that
    // product's family key while it does, so none of them can do it beside a
    // caller holding the same key; a writer that holds no family key — the
    // import runner, for a product that is and stays a standalone — still can.
    // Drift landing before a caller's second derivation widens its key set and
    // the attempt restarts correctly; drift after it does not.
    //
    // A CALLER THAT SAYS WHAT IT HOLDS is held to it. An import batch takes
    // every key before its first write and hands them over (`held`): nothing is
    // acquired here, the derivation runs once, and a store the card would gain
    // that the batch does not hold is refused as a widened key set — the batch
    // rolls back and names it next time — rather than taken after a family key
    // and after rows.
    const derive = async () => {
      const siblings = await tem.find(Product, { parent: parentId }, { refresh: true });
      const links = siblings.length
        ? await tem.find(
            StoreProduct,
            { product: { $in: siblings.map((sibling) => sibling.id) } },
            { populate: ['store'] as never, refresh: true },
          )
        : [];
      // EVERY attached store, not only the published ones — the same rule
      // `createFamily` already used when it computed the union from
      // `product.stores`. A child whose store link is hidden today may be
      // published tomorrow without touching the family.
      const union = Array.from(new Set(links.map(storeIdOf)));
      const held = await tem.find(StoreProduct, { product: parentId }, { populate: ['store'] as never, refresh: true });
      const already = new Set(held.map(storeIdOf));
      return {
        familyRootIds: [parentId],
        validationStoreIds: union.filter((storeId) => !already.has(storeId)),
        union,
        childCount: siblings.length,
      };
    };
    // Told what is held, this derives once and acquires nothing. What it
    // derives is checked against those keys by the pivot step below, which is
    // handed the same ones: a store the card would gain that is not among them
    // is refused there, before any pivot exists.
    const fresh = held ? await derive() : await this.withFamilyShapeLocks(tem, derive);

    // NO CHILDREN LEFT — leave the stores alone.
    //
    // A parent that loses its last child becomes a standalone, sellable
    // product; `dissolve` has always retained it that way, WITH its stores,
    // and `removeMember` reaches the same end state by another route. Deriving
    // an empty union here would strip the pivots of a product that is now
    // ordinary and buyable, and would make the two routes disagree.
    //
    // OWNER DECISION (compatibility, PR #259): this behaviour is preserved.
    // Once a former parent is childless its assignments are ordinary
    // standalone-product assignments, not a derived family union, and nothing
    // archives, deletes or strips it automatically. An explicit "archive
    // former parent" action may exist one day; it is not this change.
    if (fresh.childCount === 0) return;

    // The keys this reconciliation holds are the keys the pivot step needs — the
    // card's own, and a store for each pivot it is about to create — so they
    // are handed on rather than derived and asked for a second time.
    await this.applyGuardedPublication(tem, parent, company, {
      storeIds: fresh.union,
      publishingAll: false,
      held: held ?? sortLockKeys(this.familyShapeLockKeys(fresh)),
    });
    // The primitive settles its OWN writes. ORM callers flush again right
    // after, which is harmless; the import applier holds no entity graph and
    // would otherwise leave the card's new pivots pending in a unit of work
    // nothing ever flushes — the reconciliation would silently do nothing.
    await tem.flush();
  }

  /**
   * The stores a membership-shaped operation newly exposes, as they stand
   * RIGHT NOW, plus the membership diff that exposure was derived from (null
   * when membership is not being edited). Everything is re-read on each call —
   * that is the point: calling it once names the locks, calling it again under
   * them decides.
   */
  private async membershipExposure(
    tem: EntityManager,
    product: Product,
    organizationId: string,
    opts: MembershipExposureOptions,
  ): Promise<{ diff: StoreMembershipDiff | null; validationStoreIds: string[] }> {
    if (opts.storeIds !== undefined) {
      const diff = await this.membershipDiff(tem, product, opts.storeIds, organizationId);
      // ONE definition of "newly exposed", shared with the plan-based importer,
      // which writes its own pivot rows and so cannot use the writer below.
      // Created pivots are born published and had no link before; retained ones
      // keep whatever publication they had. `publishingAll` is exactly "the
      // product was not published before and is now".
      const before = new Map<string, boolean>(diff.retained.map((link) => [storeIdOf(link), link.published]));
      const after = new Map<string, boolean>(before);
      for (const draft of diff.created) after.set(draft.store.id, true);
      return {
        diff,
        validationStoreIds: newlyExposedStoreIds({
          publishedBefore: !opts.publishingAll,
          publishedAfter: true,
          before,
          after,
        }),
      };
    }
    // Membership untouched: only a product-level publication can expose
    // anything, and what it exposes is the pivots already published.
    const existing = await tem.find(
      StoreProduct,
      { product: product.id },
      { populate: ['store'] as never, refresh: true },
    );
    const published = opts.publishingAll ? existing.filter((link) => link.published).map(storeIdOf) : [];
    return { diff: null, validationStoreIds: published };
  }

  /**
   * Membership as it stands RIGHT NOW: resolved stores against existing
   * pivots. `refresh` is load-bearing on the pivot read — the rederivation
   * pass must see the published flags as the database has them, not as the
   * identity map remembers them from the discovery pass.
   */
  private async membershipDiff(
    tem: EntityManager,
    product: Product,
    storeIds: string[],
    organizationId: string,
  ): Promise<StoreMembershipDiff> {
    const wanted = Array.from(new Set(storeIds));
    const stores = wanted.length ? await tem.find(Store, { id: { $in: wanted }, organization: organizationId }) : [];
    const existing = await tem.find(
      StoreProduct,
      { product: product.id },
      { populate: ['store'] as never, refresh: true },
    );
    return diffStoreMembership({ product, organizationId, existing, requestedStores: stores });
  }

  /**
   * WHERE A PRODUCT SITS IN ITS FAMILY, AS THE DATABASE HAS IT NOW.
   *
   * The entity a writer opened its transaction with remembers the parent it
   * was loaded with. An attachment that commits afterwards changes the row and
   * not the entity, so a key named from the entity is the key of a family the
   * product has already left.
   *
   * Read WITHOUT the identity map on purpose. A refreshing read would overwrite
   * the managed entity, and the editor calls the guard with its scalar changes
   * still pending on it. The detached read runs on the same transaction and
   * leaves the entity exactly as the caller has it.
   *
   * A product this transaction has persisted but not flushed has no row yet.
   * It is where its entity says it is; nothing else can have moved it.
   */
  async familyPositionOf(
    tem: EntityManager,
    product: Product,
  ): Promise<{ rootId: string; parentId: string | null; recorded: boolean }> {
    const rows = await tem.find(
      Product,
      { id: product.id },
      { fields: ['id', 'parent'] as never, disableIdentityMap: true },
    );
    const parentId = rows.length > 0 ? parentIdOf(rows[0]) : parentIdOf(product);
    return { rootId: parentId ?? product.id, parentId, recorded: rows.length > 0 };
  }

  /**
   * The parent this entity was LOADED with — not the one it has now.
   *
   * They differ when the caller has given the product a new parent and not yet
   * flushed it, which is a decision and not a discrepancy. What the row is
   * compared against has to be what the row WAS when this transaction read it,
   * or a writer moving a product between families would be told, every time,
   * that somebody else had moved it.
   *
   * An entity with no record of the parent it was loaded with — one this
   * transaction created, a reference, one read without that column — has
   * nothing to be compared against. The answer is `undefined`, and the caller
   * does not compare: reporting such an entity as stale would restart it
   * against the same missing record until the attempts ran out.
   */
  private loadedParentIdOf(product: Product): string | null | undefined {
    const snapshot = (product as unknown as { __helper?: { __originalEntityData?: Record<string, unknown> } }).__helper
      ?.__originalEntityData;
    if (!snapshot || !('parent' in snapshot) || snapshot.parent === undefined) return undefined;
    const loaded = snapshot.parent as { id?: string } | string | null;
    if (!loaded) return null;
    return (typeof loaded === 'string' ? loaded : (loaded.id ?? null)) || null;
  }

  /**
   * The exposure protocol for a MEMBERSHIP EDIT — adding branches, removing
   * them, or replacing the set:
   *
   *   derive → acquire → rederive → assert-not-widened → validate
   *
   * It differs from `withValidatedExposure` in the two ways the promotion
   * races turned on.
   *
   * THE FAMILY KEY IS ALWAYS HELD. A removal exposes nothing, so it used to
   * take no key, and ran beside an attachment that was promoting the same
   * product to a card: whichever order they committed in, the card could end
   * without a branch its new child was published in, and the child off the
   * website there.
   *
   * THE KEY IS NAMED FROM THE ROW AS WELL AS THE ENTITY. Both roots are locked
   * when they differ. A writer that waited behind an attachment derives the
   * card's root on its second pass, holds only the root it loaded, and is
   * restarted by the widening check against a fresh entity graph — the one
   * response that re-makes every decision the stale entity fed.
   */
  async withMembershipLocks<T extends { validationStoreIds: string[] }>(
    tem: EntityManager,
    product: Product,
    derive: () => Promise<T>,
    alreadyHeld?: AdvisoryLockKey[],
  ): Promise<T> {
    const held = alreadyHeld ?? (await this.acquire(tem, await this.membershipKeys(tem, product, await derive())));

    const fresh = await derive();
    this.assertNotWidened(held, await this.membershipKeys(tem, product, fresh));
    await this.assertPublishable(tem, product, fresh.validationStoreIds);
    return fresh;
  }

  /**
   * The keys of a membership edit or a publication, taken BEFORE ITS FIRST
   * WRITE and without validating anything.
   *
   *   derive → acquire → rederive → assert-not-widened
   *
   * Validation is the caller's later call to `applyGuardedPublication`, which
   * is handed these keys back (`held`) and acquires nothing more. The two are
   * apart because some writers must write before they can validate, and a key
   * taken after a row has been written is taken in the opposite order to a
   * transaction that holds the key and then reaches for the row. Measured: the
   * editor posted stock — an UPDATE of the product row — and then asked for
   * its family key, and deadlocked with an import batch holding that key.
   */
  async lockMembershipEdit(
    tem: EntityManager,
    product: Product,
    organizationId: string,
    opts: MembershipExposureOptions,
  ): Promise<AdvisoryLockKey[]> {
    const derive = () => this.membershipExposure(tem, product, organizationId, opts);
    const held = await this.acquire(tem, await this.membershipKeys(tem, product, await derive()));
    this.assertNotWidened(held, await this.membershipKeys(tem, product, await derive()));
    return held;
  }

  /**
   * The keys of a membership edit: the product's family root, and every store
   * the operation newly exposes.
   *
   * A ROW THAT NO LONGER SAYS WHAT THE ENTITY WAS LOADED WITH ENDS THE ATTEMPT.
   * Somebody attached or released the product after this transaction read it.
   * Everything the caller has decided since — whether the product is a card,
   * which parent answers a required field for it — was decided about a family
   * it is no longer in, and locking the right key now would not un-decide any
   * of it. Only a fresh entity graph does, so this is reported as a widened
   * key set whether it is noticed on the first derivation or the second.
   *
   * A parent the CALLER changed and has not flushed is not that: the row still
   * says what was loaded. Both roots are then locked — the family the product
   * is leaving and the one it is joining.
   *
   * AND, FOR A CHILD, EVERY STORE ITS CARD WOULD GAIN. The edit is followed by
   * the card's reconciliation, in this transaction and under the family key
   * taken here, and the reconciliation takes a store key for each branch the
   * card gains. Those are normally the branches this edit gives the child,
   * which are already among the keys — but a card that is ALREADY missing a
   * branch one of its children is in gains that one too, whatever the edit
   * was. Left to the reconciliation, its key is taken after the family key and
   * after the edit's own rows are written; a writer taking the two the right
   * way round then holds the store and waits for the family while this holds
   * the family and waits for the store. Reproduced against real PostgreSQL,
   * for a removal, an edit and a bulk assignment alike.
   *
   * Named by `storesToGainForCards`, which applies the rule the reconciliation
   * applies — every branch a child of the card is in, less the branches the
   * card is in — with the branches this edit newly exposes the child in stated,
   * because it does not have them yet. The reconciliation then asks for keys
   * already held.
   *
   * READ WITHOUT TOUCHING THE CALLER'S ENTITIES. The child is its own card's
   * child, so a read of the card's children through the caller's identity map
   * is a read of the very product being edited: it would flush what the caller
   * has pending on it — a row written before any key is held — and then
   * refresh it. `storesToGainForCards` reads detached and does not flush.
   *
   * BOTH CARDS, when the caller has given the product a new parent and not
   * yet written it. The row's card loses a child and may gain nothing; the
   * entity's card is the one the reconciliation will run on, and gains every
   * branch the product is already in as well as the ones this edit adds.
   */
  private async membershipKeys(
    tem: EntityManager,
    product: Product,
    exposure: { validationStoreIds: string[] },
  ): Promise<AdvisoryLockKey[]> {
    const position = await this.familyPositionOf(tem, product);
    const loaded = this.loadedParentIdOf(product);
    if (position.recorded && loaded !== undefined && position.parentId !== loaded) {
      throw new LockSetWidenedError([productFamilyLock(position.rootId)]);
    }
    const roots = Array.from(new Set([PublicationGuardService.familyRootIdOf(product), position.rootId]));
    const stores = new Set(exposure.validationStoreIds);
    if (position.parentId) {
      for (const storeId of await this.storesToGain(tem, position.parentId, exposure.validationStoreIds)) {
        stores.add(storeId);
      }
    }
    const intended = parentIdOf(product);
    if (intended && intended !== position.parentId) {
      const already = await tem.find(
        StoreProduct,
        { product: product.id },
        { fields: ['store'] as never, disableIdentityMap: true, flushMode: FlushMode.COMMIT },
      );
      const bringing = [...exposure.validationStoreIds, ...already.map(storeIdOf)];
      for (const storeId of await this.storesToGain(tem, intended, bringing)) stores.add(storeId);
    }
    return [...roots.map(productFamilyLock), ...Array.from(stores).map(storePublicationLock)];
  }

  /**
   * Every key in ONE statement, in the canonical order.
   *
   * `acquire` issues a statement per key, which is a round trip per key. That
   * is nothing for the handful an editor takes and a great deal for an import
   * batch naming every card it will touch: at the round trip the batch budget
   * models, two hundred keys are eight seconds of a thirty-second window.
   *
   * THE ORDER IS THE STATEMENT'S OWN `ORDER BY`, namespace then key — the same
   * order `sortLockKeys` gives `acquire`. A volatile expression in the select
   * list is evaluated after a top-level ORDER BY that does not depend on it, so
   * the lock calls run over the sorted rows. The order the keys are HANDED in
   * plays no part: `import-lock-order.pg.spec.ts` hands them over backwards,
   * holds the middle one from another transaction, and finds the first held
   * and the third not yet asked for.
   */
  async acquireTogether(tem: EntityManager, keys: AdvisoryLockKey[]): Promise<AdvisoryLockKey[]> {
    const unique = sortLockKeys(keys);
    if (unique.length === 0) return unique;
    const given = keys.filter((key, index) => keys.findIndex((k) => k.ns === key.ns && k.key === key.key) === index);
    await tem.execute(
      `select pg_advisory_xact_lock(u.ns, u.key)
         from unnest(?::int4[], ?::int4[]) as u(ns, key)
        order by u.ns, u.key`,
      [`{${given.map((k) => k.ns).join(',')}}`, `{${given.map((k) => k.key).join(',')}}`],
    );
    return unique;
  }

  /**
   * Refuses a card, from a child count the caller's family key keeps still.
   *
   * Every writer that may not touch a card already asks this when it loads the
   * product. That answer is only as old as the load: a product with no
   * children then can have one by the time the write happens, and the write
   * then strips a branch from what is now a card. Asked again here, after the
   * key is held, the answer cannot change until this transaction ends.
   */
  async refuseACard(tem: EntityManager, product: Product, what: string): Promise<void> {
    assertNotAFamilyCard(
      { id: product.id, name: product.name, childCount: await tem.count(Product, { parent: product.id }) },
      what,
    );
  }

  /**
   * Only exposure needs serializing. Each store the operation newly exposes is
   * locked along with the family root, because validation reads that store's
   * requirements and the product's family shape. An operation exposing nothing
   * — retentions, removals, unpublished edits — reads none of that state and
   * takes no locks at all; if the rederived exposure GROWS, the widening check
   * refuses before anything is validated against it.
   */
  private exposureLockKeys(product: Product, validationStoreIds: string[]): AdvisoryLockKey[] {
    if (validationStoreIds.length === 0) return [];
    return [
      productFamilyLock(PublicationGuardService.familyRootIdOf(product)),
      ...validationStoreIds.map(storePublicationLock),
    ];
  }

  /**
   * The stores a card would GAIN if its children were reconciled right now, by
   * the rule `reconcileStoresOfParent` applies: every branch a child of the
   * card is in, less the branches the card is in.
   *
   * It exists so a caller that will hold a family key while that reconciliation
   * runs nested inside it can name those namespace-1 keys UP FRONT and take
   * them in the canonical order, before the family key rather than after it.
   *
   * TWO IMPLEMENTATIONS OF ONE RULE, not one definition read by both. The
   * reconciliation derives with its own reads; this is a separate read. What
   * keeps a caller safe is that this never names FEWER stores than the
   * reconciliation will ask for — see `storesToGainForCards` for the one state
   * in which it names more.
   *
   * `alsoGaining` is for the caller that is about to give the card a child it
   * does not have yet: at the moment the keys must be named, that child is not
   * a child, so its branches cannot be read from the family and the caller
   * states them.
   *
   * Takes no locks and decides nothing. It is a naming read; the protocol's
   * second derivation, made under the keys, is what decides.
   */
  async storesToGain(tem: EntityManager, parentId: string, alsoGaining: string[] = []): Promise<string[]> {
    const gained = (await this.storesToGainForCards(tem, [parentId], alsoGaining)).get(parentId) ?? [];
    return gained;
  }

  /**
   * `storesToGain` for any number of cards, in ONE read.
   *
   * Every pivot of each card and of each of its children, with the child's
   * parent alongside it, in a single statement: a card gains the branches its
   * children are in, less the branches it is in itself. An import batch names
   * the keys of every card it will reconcile before it writes anything, and a
   * batch can touch fifty.
   *
   * DETACHED, AND WITHOUT FLUSHING. It is a naming read, made before the
   * caller has taken a key, and it may not do what a read through the caller's
   * identity map does: flush whatever is pending — a row written before any
   * key is held — and refresh entities the caller is in the middle of
   * editing. `disableIdentityMap` reads on the caller's transaction, so it sees
   * what that transaction has already written, and hands back entities nobody
   * else holds.
   *
   * WHAT IT LEAVES OUT. It goes through the ORM, so a child or a branch that
   * has been removed from the catalogue is left out by the same default filter
   * that left it out of the three reads this replaces; an archived child
   * counts, as it did. `publication-guard-gains.pg.spec.ts` compares it with
   * those three reads case by case.
   *
   * ONE STATE IN WHICH IT ANSWERS DIFFERENTLY: a card that has itself been
   * removed while a child in the catalogue still points at it. The three reads
   * loaded each child with its parent, the filter hid the removed parent, and
   * the child was counted for no card: they answered nothing. This read never
   * loads the parent, so it answers with the child's branches. The same spec
   * states both answers.
   *
   * WHAT PRODUCES THAT STATE. Removal decides under the family key of the
   * product it removes, and of its card when it has one: a product with a
   * child in its organization that has not been removed is refused, and a
   * child has its parent cleared by the statement that removes it. Attachment
   * loads its card and its member before it asks for a key, and once it holds
   * its keys it does not check that either is still in the catalogue: its
   * derivation reads them through the removed filter, a removed one is simply
   * absent from what it names, and nothing refuses on that absence. A removal
   * committing beside an attachment can therefore leave a removed product in
   * a family, whether or not the attachment held that product's key when it
   * wrote; in other runs the attachment is refused or fails (#337).
   *
   * WHAT THE EXTRA STORE KEYS ARE WORTH depends on the caller. A
   * reconciliation asked for from a transaction that has not loaded the card
   * finds no parent and returns, and they go unused; from one that holds the
   * card loaded from before it was removed, the reconciliation runs.
   *
   * `alsoGaining` is given to every card. A caller that means it for one card
   * asks about one card.
   */
  async storesToGainForCards(
    tem: EntityManager,
    parentIds: string[],
    alsoGaining: string[] = [],
  ): Promise<Map<string, string[]>> {
    const cards = Array.from(new Set(parentIds));
    if (cards.length === 0) return new Map();
    const gained = new Map<string, Set<string>>(cards.map((card) => [card, new Set(alsoGaining)]));

    const links = await tem.find(
      StoreProduct,
      { $or: [{ product: { $in: cards } }, { product: { parent: { $in: cards } } }] },
      {
        populate: ['product'] as never,
        fields: ['store', 'product.parent'] as never,
        disableIdentityMap: true,
        flushMode: FlushMode.COMMIT,
      },
    );
    const held: [string, string][] = [];
    for (const link of links) {
      const owner = link.product as unknown as Product;
      const storeId = storeIdOf(link);
      const card = parentIdOf(owner);
      if (card && gained.has(card)) gained.get(card)?.add(storeId);
      if (gained.has(owner.id)) held.push([owner.id, storeId]);
    }
    // After the union, so a branch a card is in is never reported as gained
    // however the rows happened to be ordered.
    for (const [card, storeId] of held) gained.get(card)?.delete(storeId);

    return new Map(Array.from(gained.entries()).map(([card, stores]) => [card, Array.from(stores)]));
  }

  /** The root that names a product's family lock: its parent if it is a version, else itself. */
  static familyRootIdOf(product: Product): string {
    const parent = product.parent as unknown as { id?: string } | string | null | undefined;
    return (typeof parent === 'string' ? parent : parent?.id) ?? product.id;
  }

  /**
   * Serializes a family-shape transition (B4a3): derive → acquire → rederive →
   * assert-not-widened, over the family roots the transition touches — the
   * destination and every member's pre-transition root — plus the stores its
   * FINAL shape would newly expose the product to.
   *
   * `derive` is called twice on purpose, exactly as in the membership
   * protocol: the first call names the locks, the second — made while they are
   * held — decides, and is returned so the caller acts on state read under the
   * locks. If the second call derives a key the first did not take, the shape
   * moved between the reads — LockSetWidenedError escapes, and only the owner
   * of the transaction may respond, by starting a fresh one.
   *
   * VALIDATION IS DELIBERATELY NOT RUN HERE. Sellability is decided by the
   * family shape as this transaction will COMMIT it, so the caller applies the
   * transition, flushes, and only then validates the returned
   * `validationStoreIds` with `assertPublishable` — a refusal rolls the whole
   * transition back. A pure attach passes an empty validation set: it can only
   * take sellability away, never grant it.
   *
   * Callers that go on to create pivots in the same transaction (group
   * creation) must include those target stores in `validationStoreIds` HERE:
   * the pivot step re-acquires its keys, and re-acquisition is only
   * order-safe for keys this transaction already holds.
   */
  async withFamilyShapeLocks<T extends FamilyShapeExposure>(tem: EntityManager, derive: () => Promise<T>): Promise<T> {
    const discovered = await derive();
    const held = await this.acquire(tem, this.familyShapeLockKeys(discovered));

    const fresh = await derive();
    this.assertNotWidened(held, this.familyShapeLockKeys(fresh));
    return fresh;
  }

  private familyShapeLockKeys(exposure: FamilyShapeExposure): AdvisoryLockKey[] {
    return [...exposure.familyRootIds.map(productFamilyLock), ...exposure.validationStoreIds.map(storePublicationLock)];
  }

  /**
   * The stores a product holds a pivot in that the company has REMOVED.
   *
   * No ORM read sees them — the removed filter on `Store` reaches through the
   * pivot — so no writer names their keys from its ordinary derivation. A
   * writer that changes a product's place in a family names them as well
   * (#342): a restoration of one of these stores holds its publication key
   * while it works out which cards have a child there, and the two must not
   * run side by side. See `StoreRemovalService.restore`.
   */
  async removedStoreIdsOf(tem: EntityManager, productId: string): Promise<string[]> {
    const rows = (await tem.execute(
      `select sp.store_id
         from store_products sp
         join stores s on s.id = sp.store_id
        where sp.product_id = ?
          and s.removed_at is not null
        order by sp.store_id`,
      [productId],
    )) as { store_id: string }[];
    return rows.map((row) => row.store_id);
  }

  /**
   * The keys `withFamilyShapeLocks` holds for an exposure it returned — for a
   * caller that goes on to hand them to `reconcileStoresOfParent`, so that
   * the reconciliation acquires nothing and refuses what it would need
   * beyond them. What was ACQUIRED was named from the first derivation and
   * may be wider; this names the second's, which the first is checked to
   * contain, so a caller can only ever say less than it holds.
   */
  familyShapeKeysOf(exposure: FamilyShapeExposure): AdvisoryLockKey[] {
    return sortLockKeys(this.familyShapeLockKeys(exposure));
  }

  /**
   * Stores whose customers currently see this product through a published
   * pivot — the exposure a shape transition turns live when it makes the
   * product sellable. `refresh` for the same reason as everywhere else: the
   * rederivation pass must see the database, not the identity map.
   */
  async publishedStoreIds(tem: EntityManager, productId: string): Promise<string[]> {
    const links = await tem.find(StoreProduct, { product: productId }, { populate: ['store'] as never, refresh: true });
    return links.filter((link) => link.published).map(storeIdOf);
  }

  /**
   * Serializes a store-side requirement change against every publication in
   * that store (B4a3): requirement writers and publication writers both hold
   * this ONE key, so each side decides against settled state. A single fixed
   * key cannot widen, so there is nothing to rederive — reads the caller
   * performs after this call are the authoritative state.
   */
  async lockStoreRequirements(tem: EntityManager, storeId: string): Promise<void> {
    await this.acquire(tem, [storePublicationLock(storeId)]);
  }

  /**
   * Serializes and rules on DELETING a product's answer for one field (B4a3):
   *
   *   derive → acquire → rederive → assert-not-widened → refuse or allow
   *
   * The lock set is the family root plus EVERY store the product is currently
   * exposed in — a published pivot on a shape isSellableShape accepts —
   * INDEPENDENT of the definition's setting there. That independence is
   * load-bearing: requirement activation holds only the store key, so
   * deletion must already hold that same key even where nothing is demanded
   * YET — otherwise an activation beginning after deletion's second derive
   * could commit alongside it and leave a required, shown product without a
   * value. Locking every exposed store supplies the necessary intersection;
   * the extra serialization is the price of the invariant.
   *
   * Which of those stores DEMAND the field is decided only after the locks
   * are held, from a fresh settings read — and any demanding store refuses
   * the deletion outright, with a bounded, deterministic payload. Product
   * shape and pivots are re-read fresh across the two derives; an exposed
   * set that widens escapes as LockSetWidenedError for the owner's
   * withLockRetry to restart.
   *
   * A draft, archived, card or nowhere-published product locks no store and
   * consults none: nothing it answers reaches a customer, and the transition
   * that would change that performs its own validation under these same keys.
   */
  async assertValueDeletable(tem: EntityManager, product: Product, definition: ProductFieldDefinition): Promise<void> {
    // Phase 2: deleting a PARENT's value also strips the INHERITED answer
    // from every child that lacks a direct one — wherever applicability lets
    // children display the family fact (PARENT or BOTH). The affected set is
    // therefore the product itself (when shown) plus those children (when
    // shown), and the lock set covers the family root and every store any of
    // them is exposed in. The COMPLETE affected set is evaluated; only the
    // refusal report is bounded.
    const derive = async (): Promise<{
      rootId: string;
      exposedStoreIds: string[];
      exposedByProduct: Map<string, string[]>;
    }> => {
      const empty = new Map<string, string[]>();
      const current = await tem.findOne(Product, { id: product.id }, { refresh: true });
      if (!current) {
        return {
          rootId: PublicationGuardService.familyRootIdOf(product),
          exposedStoreIds: [],
          exposedByProduct: empty,
        };
      }
      const rootId = PublicationGuardService.familyRootIdOf(current);
      const exposedByProduct = new Map<string, string[]>();

      if (await this.isSellableShape(tem, current)) {
        const own = await this.publishedStoreIds(tem, current.id);
        if (own.length > 0) exposedByProduct.set(current.id, own.sort());
      }

      if (definition.applicability !== 'CHILD') {
        const children = await tem.find(Product, { parent: current.id }, { refresh: true });
        if (children.length > 0) {
          // Children with a DIRECT value keep their answer; only the rest
          // relied on the inherited one.
          const direct = await tem.find(ProductFieldValue, {
            product: { $in: children.map((child) => child.id) },
            definition: definition.id,
          });
          const answeredDirectly = new Set(
            direct.map((value: any) => (typeof value.product === 'string' ? value.product : value.product?.id)),
          );
          for (const child of children) {
            if (answeredDirectly.has(child.id)) continue;
            if (!(await this.isSellableShape(tem, child))) continue;
            const exposed = await this.publishedStoreIds(tem, child.id);
            if (exposed.length > 0) exposedByProduct.set(child.id, exposed.sort());
          }
        }
      }

      const allStores = Array.from(new Set(Array.from(exposedByProduct.values()).flat())).sort();
      return { rootId, exposedStoreIds: allStores, exposedByProduct };
    };
    const keysOf = (d: { rootId: string; exposedStoreIds: string[] }): AdvisoryLockKey[] => [
      productFamilyLock(d.rootId),
      ...d.exposedStoreIds.map(storePublicationLock),
    ];

    const discovered = await derive();
    const held = await this.acquire(tem, keysOf(discovered));
    const fresh = await derive();
    this.assertNotWidened(held, keysOf(fresh));

    if (fresh.exposedStoreIds.length === 0) return;
    // Only now — with every exposed store's key held — does the definition's
    // setting get to speak: no activation can slip in beside this read.
    const demanding = await tem.find(
      StoreFieldSetting,
      { store: { $in: fresh.exposedStoreIds }, definition: definition.id, active: true, required: true },
      { refresh: true },
    );
    const demandingStores = new Set(
      demanding.map((setting) => ((setting.store as any)?.id ?? (setting.store as any)) as string),
    );
    if (demandingStores.size === 0) return;

    const blocking = new Set<string>();
    const affected = new Set<string>();
    for (const [productId, stores] of fresh.exposedByProduct) {
      const hit = stores.filter((storeId) => demandingStores.has(storeId));
      if (hit.length === 0) continue;
      affected.add(productId);
      for (const storeId of hit) blocking.add(storeId);
    }
    if (blocking.size === 0) return;

    const blockingSorted = Array.from(blocking).sort();
    const affectedSorted = Array.from(affected).sort();
    const cappedStores = blockingSorted.slice(0, PublicationGuardService.MAX_BLOCKING_STORE_IDS);
    const cappedProducts = affectedSorted.slice(0, PublicationGuardService.MAX_BLOCKING_STORE_IDS);
    const refusal: ValueDeletionRefusal = {
      message:
        'This value cannot be removed while a branch requires it of a shown product — directly or through inheritance.',
      blockingStoreIds: cappedStores,
      blockingStoreCount: blockingSorted.length,
      affectedProductIds: cappedProducts,
      affectedProductCount: affectedSorted.length,
      truncated: blockingSorted.length > cappedStores.length || affectedSorted.length > cappedProducts.length,
    };
    throw new ConflictException(refusal);
  }

  /**
   * Refuses making a field required in a store while any product the store
   * CURRENTLY SHOWS does not answer it — assertPublishable's mirror image,
   * taken from the store's side.
   *
   * "Shows" is publication's own canonical predicate: a published pivot on a
   * product that isSellableShape accepts (PUBLISHED, unarchived, no
   * versions). A card, a draft, or an unpublished pivot answers to nobody,
   * and requiring a field of it would refuse something no customer can see.
   *
   * The refusal is bounded exactly like the publication refusal: a count and
   * a capped, ascending list of product ids — never the whole catalogue.
   */
  async assertRequirableInStore(tem: EntityManager, storeId: string, definitionId: string): Promise<void> {
    const links = await tem.find(
      StoreProduct,
      { store: storeId, published: true },
      { populate: ['product'] as never, refresh: true },
    );
    const shown: Product[] = [];
    for (const link of links) {
      const product = link.product as unknown as Product;
      if (await this.isSellableShape(tem, product)) shown.push(product);
    }
    if (shown.length === 0) return;

    // Phase 2: "answers" means the EFFECTIVE answer — a version whose family
    // model carries the value is answered, wherever applicability lets the
    // version display it (PARENT or BOTH).
    const definition = await tem.findOne(ProductFieldDefinition, { id: definitionId }, { refresh: true });
    const inheritable = definition ? definition.applicability !== 'CHILD' : false;
    const parentIdOf = (product: Product): string | null => {
      const parent = product.parent as unknown as { id?: string } | string | null | undefined;
      return (typeof parent === 'string' ? parent : parent?.id) ?? null;
    };
    const lookupIds = new Set<string>(shown.map((product) => product.id));
    if (inheritable) {
      for (const product of shown) {
        const parentId = parentIdOf(product);
        if (parentId) lookupIds.add(parentId);
      }
    }
    const values = await tem.find(ProductFieldValue, {
      product: { $in: Array.from(lookupIds) },
      definition: definitionId,
    });
    const answered = new Set(
      values.map((value: any) => (typeof value.product === 'string' ? value.product : value.product?.id)),
    );
    const missing = shown
      .filter((product) => {
        if (answered.has(product.id)) return false;
        if (inheritable) {
          const parentId = parentIdOf(product);
          if (parentId && answered.has(parentId)) return false;
        }
        return true;
      })
      .map((product) => product.id)
      .sort();
    if (missing.length === 0) return;

    const capped = missing.slice(0, PublicationGuardService.MAX_MISSING_PRODUCT_IDS);
    const refusal: RequirementRefusal = {
      message: 'This field cannot be required in that branch until every product it currently shows answers it.',
      storeId,
      missingProductIds: capped,
      missingProductCount: missing.length,
      truncated: missing.length > capped.length,
    };
    throw new ConflictException(refusal);
  }

  /**
   * Refuses a family ATTACH that would turn existing direct values illegal
   * (Phase 2): a joining member may not hold values for PARENT-only
   * definitions or for BOTH definitions whose override policy forbids child
   * rows, and a product becoming (or already being) a model may not hold
   * values for CHILD-only definitions. Standalone products are legal under
   * every applicability, so this fires only at the transition that changes
   * what the products ARE. The COMPLETE row set is evaluated; the report is
   * bounded to ten definition keys per side.
   */
  async assertMembersAttachable(tem: EntityManager, memberIds: string[], parentId: string | null): Promise<void> {
    const memberOffending: { key: string; n: number }[] = memberIds.length
      ? ((await tem.execute(
          `select d.key, count(*)::int as n from product_field_values v
             join product_field_definitions d on d.id = v.definition_id
            where v.product_id in (${memberIds.map(() => '?').join(',')})
              and (d.applicability = 'PARENT'
                   or (d.applicability = 'BOTH' and not d.child_override_allowed))
            group by d.key order by d.key`,
          memberIds,
        )) as { key: string; n: number }[])
      : [];
    const parentOffending: { key: string; n: number }[] = parentId
      ? ((await tem.execute(
          `select d.key, count(*)::int as n from product_field_values v
             join product_field_definitions d on d.id = v.definition_id
            where v.product_id = ? and d.applicability = 'CHILD'
            group by d.key order by d.key`,
          [parentId],
        )) as { key: string; n: number }[])
      : [];
    if (memberOffending.length === 0 && parentOffending.length === 0) return;

    const cap = PublicationGuardService.MAX_MISSING_FIELD_KEYS;
    throw new ConflictException({
      code: 'FIELD_APPLICABILITY_CONFLICT',
      message:
        'This family change would make existing specification values illegal. ' +
        'Move or remove the offending values first.',
      memberDefinitionKeys: memberOffending.slice(0, cap).map((row) => row.key),
      memberDefinitionCount: memberOffending.length,
      parentDefinitionKeys: parentOffending.slice(0, cap).map((row) => row.key),
      parentDefinitionCount: parentOffending.length,
      truncated: memberOffending.length > cap || parentOffending.length > cap,
    });
  }

  /**
   * Acquires every key in the ONE canonical order, inside the caller's
   * transaction. Returns what it holds, for phase two to compare against.
   *
   * The `::int4` casts are load-bearing. PostgreSQL has both
   * `pg_advisory_xact_lock(bigint)` and `pg_advisory_xact_lock(int4, int4)`,
   * and they are DIFFERENT lock spaces — an unqualified numeric parameter could
   * resolve to the one-argument form, at which point transactions ordering
   * themselves by (ns, key) tuples would not be serializing against each other
   * at all.
   */
  async acquire(tem: EntityManager, keys: AdvisoryLockKey[]): Promise<AdvisoryLockKey[]> {
    const ordered = sortLockKeys(keys);
    for (const { ns, key } of ordered) {
      // em.execute, NEVER getConnection().execute: only the former runs on
      // the TRANSACTION's connection. On a pool connection the statement
      // autocommits, so the "transaction-scoped" lock releases the instant it
      // is granted and serializes nothing — proven against real PostgreSQL by
      // publication-invariant.pg.spec.ts before this line was fixed.
      await tem.execute('select pg_advisory_xact_lock(?::int4, ?::int4)', [ns, key]);
    }
    return ordered;
  }

  /**
   * Phase two: the re-derived set may be equal or NARROWER than what is held —
   * a store that dropped out simply leaves a lock we no longer need. It may
   * not be WIDER: a key we do not hold is a race we cannot see.
   */
  assertNotWidened(held: AdvisoryLockKey[], rederived: AdvisoryLockKey[]): void {
    const heldSet = new Set(held.map((k) => `${k.ns}:${k.key}`));
    const missing = sortLockKeys(rederived).filter((k) => !heldSet.has(`${k.ns}:${k.key}`));
    if (missing.length > 0) throw new LockSetWidenedError(missing);
  }

  /**
   * Whether this product is the kind of thing a required field can block.
   *
   * A family card is exempt: it is never sold, so demanding a value of it would
   * refuse publication of something that cannot be bought. Archived and
   * non-PUBLISHED products are exempt for the same reason — nothing reaches a
   * customer.
   *
   * "Card" counts ARCHIVED children too, matching the checkout guard in
   * sales.service, which filters children by parent alone. Archiving the last
   * active child therefore does not make a card sellable; only detaching or
   * hard-deleting every child does.
   */
  async isSellableShape(tem: EntityManager, product: Product): Promise<boolean> {
    if (product.status !== ProductStatus.PUBLISHED) return false;
    if (product.archivedAt) return false;
    const childCount = await tem.count(Product, { parent: product.id });
    return childCount === 0;
  }

  /**
   * Refuses if this product would be published in a store demanding a field it
   * does not answer.
   *
   * Validates EXACTLY the stores it is given — callers pass only pivots
   * transitioning into published state. A pivot that is already unpublished, or
   * already published and unchanged, is not this operation's concern.
   */
  async assertPublishable(tem: EntityManager, product: Product, storeIds: string[]): Promise<void> {
    const refusal = await this.publicationRefusalFor(tem, product, storeIds);
    if (refusal) throw new ConflictException(refusal);
  }

  /**
   * THE SAME QUESTION, ANSWERED WITHOUT THROWING (#292).
   *
   * `assertPublishable` is the right shape for a write that must abort. A
   * REMOVAL is not: its refusals are gathered into a blocker list and returned
   * from a transaction that has to COMMIT, because the blocked-removal audit
   * row lives in it. Throwing there would roll the record of the refusal back
   * along with the refusal itself.
   *
   * So the decision lives here, once, and `assertPublishable` is a thin throw
   * over it. Two callers, one rule — the alternative was a second copy that
   * would answer differently the first time either was edited.
   */
  async publicationRefusalFor(
    tem: EntityManager,
    product: Product,
    storeIds: string[],
  ): Promise<PublicationRefusal | null> {
    const stores = Array.from(new Set(storeIds));
    if (stores.length === 0) return null;
    if (!(await this.isSellableShape(tem, product))) return null;

    const settings = await tem.find(
      StoreFieldSetting,
      { store: { $in: stores }, active: true, required: true },
      { populate: ['definition'] as never },
    );
    if (settings.length === 0) return null;

    // Phase 2: the answered set is EFFECTIVE — a version is answered by its
    // family model's value wherever applicability lets it display one.
    const parentRef = product.parent as unknown as { id?: string } | string | null | undefined;
    const parentId = (typeof parentRef === 'string' ? parentRef : parentRef?.id) ?? null;
    const values = await tem.find(ProductFieldValue, {
      product: { $in: parentId ? [product.id, parentId] : [product.id] },
    });
    const answered = new Set<string>();
    const answeredByParent = new Set<string>();
    for (const value of values as any[]) {
      const owner = typeof value.product === 'string' ? value.product : value.product?.id;
      const definitionId = typeof value.definition === 'string' ? value.definition : value.definition?.id;
      if (owner === product.id) answered.add(definitionId);
      else if (parentId && owner === parentId) answeredByParent.add(definitionId);
    }
    if (parentId && answeredByParent.size > 0) {
      const inherited = await tem.find(ProductFieldDefinition, {
        id: { $in: Array.from(answeredByParent) },
        applicability: { $ne: 'CHILD' },
      });
      for (const definition of inherited) answered.add(definition.id);
    }

    // Ascending store id, so the reported blocker is deterministic.
    const byStore = new Map<string, { key: string; definitionId: string }[]>();
    for (const setting of settings) {
      const definition: any = setting.definition;
      // NOTE an archived definition is NOT skipped. `archiveDefinition`
      // refuses while any store setting is active, so active+required+archived
      // cannot arise through the API — it means direct SQL or a defect. Such a
      // requirement is unsatisfiable, since the field no longer accepts values,
      // and ignoring it would let a product publish while the database says a
      // branch demands something of it. Refusing surfaces the corruption
      // instead of publishing around it.
      const definitionId = typeof definition === 'string' ? definition : definition?.id;
      if (answered.has(definitionId)) continue;
      const storeId = (setting.store as any)?.id ?? (setting.store as any);
      const list = byStore.get(storeId) ?? [];
      list.push({ key: definition?.key ?? definitionId, definitionId });
      byStore.set(storeId, list);
    }

    const blocking = Array.from(byStore.keys()).sort();
    if (blocking.length === 0) return null;

    const storeId = blocking[0];
    const missing = (byStore.get(storeId) ?? []).map((m) => m.key).sort();
    const capped = missing.slice(0, PublicationGuardService.MAX_MISSING_FIELD_KEYS);
    return {
      message: 'This product cannot be published in that branch until it answers the fields the branch requires.',
      storeId,
      missingFieldKeys: capped,
      missingFieldCount: missing.length,
      truncated: missing.length > capped.length,
    };
  }
}
