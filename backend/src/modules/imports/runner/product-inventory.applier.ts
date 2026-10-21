import { Injectable } from '@nestjs/common';
import { ApplyContext, RowApplication, UnitApplier } from '../execution/import-executor';
import { PlannedUnit } from '../execution/batch-planner';
import { RowOutcome } from '../entities/import-row-result.entity';
import { ProductsApplier, ProductMutation } from '../appliers/products.applier';
import { InventoryProposalApplier } from '../appliers/inventory-proposal.applier';
import { InventoryContext, ParsedInventoryIntent, classifyInventoryIntents } from '../inventory/inventory-proposal';
import { ProductRowPlan, allRowPlans } from './plan-compiler';
import type { CategoryProvenance } from './product-relationships.applier';
import type { EffectState, RowEffects } from '../execution/import-executor';
import { ProductRelationshipsApplier } from './product-relationships.applier';
import { LockSetWidenedError, PublicationGuardService } from '../../products/publication/publication-guard.service';
import { newlyExposedStoreIds } from '../../products/shared/store-membership.util';
import { AdvisoryLockKey, productFamilyLock, storePublicationLock } from '../../products/families/advisory-lock.util';
import { Product } from '../../products/entities/product.entity';
import { txExecute } from '../execution/tx';
import { EntityManager } from '@mikro-orm/postgresql';

/**
 * A product row and its stock, written as one thing.
 *
 * These are two appliers because they write through two authorities — the
 * catalogue and the inventory ledger — and that separation is worth keeping.
 * But they are one DECISION: somebody imported a row that said "we have forty
 * of these", and a run that created the product and then failed to record the
 * forty would leave a catalogue entry that quietly claims nothing is in stock.
 *
 * So the order here is deliberate and is the whole point of the class:
 *
 *  1. **Classify the stock first, before anything is written.** Every refusal
 *     the classifier can produce — an allocation exceeding its total, units
 *     with nowhere to live, a shop outside the caller's reach, a frozen
 *     organization — is computable from the intent and the context alone. A row
 *     whose stock cannot be accepted is therefore refused with nothing written,
 *     rather than half-written and then rolled back.
 *  2. **Write the product**, which yields the id a new product did not have.
 *  3. **Post the stock** under that id, inside the same batch transaction, so
 *     the catalogue row and the ledger entry commit together.
 *
 * One source row still produces exactly ONE outcome. The stock posting's result
 * is folded into the product row's, never appended beside it — `import_row_-
 * results_execution_row_unique` would reject the second, and more importantly a
 * report with two verdicts for one line is a report nobody can act on.
 */

export interface ProductInventoryContext {
  /** Shops this import may affect, already narrowed to the caller's authority. */
  allowedStoreIds: Set<string>;
  storeLocationIds: Map<string, string>;
  frozen: boolean;
  hasDefaultWarehouse: boolean;
  /**
   * The approved custody destination, resolved once per execution.
   *
   * Read-only and immutable for the run: it comes from the plan the approval
   * attests to, and the runner has already revalidated that it exists, belongs
   * to this company, and is reachable from the plan's shop. Carried here purely
   * so each row can REPORT where its stock went, by name.
   */
  destination?: { id: string; name: string; kind: string; storeId: string | null } | null;
  /**
   * Shop names, for reporting only.
   *
   * Nothing routes on this map — authority is still `allowedStoreIds`. It
   * exists so a row can say it was listed in "Store B" rather than in a UUID
   * the reader cannot check.
   */
  storeNames?: Map<string, string>;
}

/**
 * How long a batch may wait for its keys, in milliseconds.
 *
 * Ten seconds. A batch is sized to half a sixty-second lease and no heartbeat
 * can run inside it, so a wait is paid for out of the other half. Three
 * attempts at ten seconds each is the whole of that half and no more.
 */
export const BATCH_LOCK_TIMEOUT_MS = 10_000;

@Injectable()
export class ProductInventoryApplier implements UnitApplier {
  /** How long `prepareBatch` waits for its keys. A field so a test can wait less than ten seconds. */
  lockTimeoutMs = BATCH_LOCK_TIMEOUT_MS;

  constructor(
    private readonly products: ProductsApplier,
    private readonly inventory: InventoryProposalApplier,
    private readonly inventoryContext: () => ProductInventoryContext,
    private readonly relationships: ProductRelationshipsApplier,
    private readonly publicationGuard: PublicationGuardService,
  ) {}

  /**
   * THE BATCH'S KEYS, BEFORE ITS FIRST WRITE.
   *
   *   derive → acquire → rederive → assert-not-widened
   *
   * the same protocol every other writer follows, over the whole batch rather
   * than one unit. Store keys first, then the family key of every CARD the
   * batch will reconcile, all in one statement.
   *
   * WHICH FAMILY KEYS, AND WHICH NOT. A card is named when the batch targets
   * one of its children, targets the card itself, or promotes an existing
   * product by giving it children. A product that is, and stays, a standalone
   * is NOT named: the batch reconciles no card for it, so it never asks for
   * that key and cannot be waited on for it. That keeps the number of keys a
   * batch holds what it was — a card's key used to be taken when the card was
   * reconciled, and is now taken at the start — and keeps an editor saving an
   * ordinary product from waiting on a key for the length of a batch.
   *
   * It used to go the other way: a unit's rows were written, and its card's
   * key was asked for afterwards. Every writer that takes the key and then
   * writes the row met that in the opposite order, and PostgreSQL ended one of
   * the two.
   *
   * THE WAIT IS BOUNDED. No heartbeat can run inside a batch, so time spent
   * waiting here is time the lease does not see. The lock timeout is set for
   * this phase alone and put back before the first unit runs.
   */
  async prepareBatch(units: PlannedUnit[], context: ApplyContext): Promise<void> {
    const plans = units.flatMap((unit) => unit.mutations as ProductRowPlan[]);
    if (plans.length === 0) return;
    const em = context.em as EntityManager;

    const derive = async (): Promise<{ stores: string[]; cards: string[] }> => {
      const cards = await this.cardsToReconcile(plans, context);
      const stores = new Set(await this.candidateStores(plans, context));
      if (cards.length > 0) {
        // A card whose children are already in a branch it is not in gains that
        // branch the moment it is reconciled, whatever this batch names. Asked
        // of every card at once, in one read.
        const bound = em.fork({ clear: true });
        bound.setTransactionContext(em.getTransactionContext());
        for (const gained of (await this.publicationGuard.storesToGainForCards(bound, cards)).values()) {
          for (const storeId of gained) stores.add(storeId);
        }
      }
      return { stores: Array.from(stores).sort(), cards };
    };
    const keysOf = (named: { stores: string[]; cards: string[] }): AdvisoryLockKey[] => [
      ...named.stores.map((storeId) => storePublicationLock(storeId)),
      ...named.cards.map((cardId) => productFamilyLock(cardId)),
    ];

    const discovered = await derive();
    await txExecute(em, `set local lock_timeout = ${Math.max(1, Math.trunc(this.lockTimeoutMs))}`);
    const held = await this.publicationGuard.acquireTogether(em, keysOf(discovered));
    await txExecute(em, 'set local lock_timeout to default');

    const fresh = await derive();
    this.publicationGuard.assertNotWidened(held, keysOf(fresh));
    context.batchLocks = {
      stores: new Set(discovered.stores),
      cards: new Set(discovered.cards),
      created: new Set(),
      keys: held,
    };
  }

  /**
   * The cards this batch will reconcile, read from the database as it stands.
   *
   * The same two shapes `ProductsApplier.cardsOf` resolves after the writes —
   * a targeted child's parent, and a targeted product that is itself a card —
   * plus the one the writes will create: an existing product a family row is
   * about to give children to. Read from the rows rather than inferred from
   * the plan, which was compiled at approval time and may be days old.
   */
  private async cardsToReconcile(plans: ProductRowPlan[], context: ApplyContext): Promise<string[]> {
    const targets = new Set<string>();
    const promoted = new Set<string>();
    for (const plan of plans) {
      const family = (plan.children?.length ?? 0) > 0 || (plan.product.children?.length ?? 0) > 0;
      if (family && plan.product.targetId) promoted.add(plan.product.targetId);
      for (const target of allRowPlans(plan)) {
        if (target.product.targetId) targets.add(target.product.targetId);
      }
    }
    if (targets.size === 0) return [];
    const ids = Array.from(targets);
    const placeholders = ids.map(() => '?').join(', ');
    const rows = await txExecute<{ card_id: string }[]>(
      context.em,
      `select distinct p.parent_id as card_id
         from products p
        where p.id in (${placeholders}) and p.parent_id is not null and p.removed_at is null
        union
       select distinct p.id as card_id
         from products p
        where p.id in (${placeholders}) and p.removed_at is null
          and exists (select 1 from products c where c.parent_id = p.id)`,
      [...ids, ...ids],
    );
    const live = promoted.size
      ? await txExecute<{ id: string }[]>(
          context.em,
          `select p.id from products p
            where p.id in (${Array.from(promoted)
              .map(() => '?')
              .join(', ')}) and p.removed_at is null`,
          Array.from(promoted),
        )
      : [];
    return Array.from(new Set([...rows.map((row) => row.card_id), ...live.map((row) => row.id)])).sort();
  }

  async apply(unit: PlannedUnit, context: ApplyContext): Promise<RowApplication[]> {
    const plans = unit.mutations as ProductRowPlan[];

    // Stock is classified against a PLACEHOLDER product id, because at this
    // point a new product has none. Nothing in the refusal rules depends on
    // which product it is — they are about quantities, shops and custody — and
    // the real id is substituted before anything is posted.
    const productContext: ProductInventoryContext = this.inventoryContext();
    const inventoryContext: InventoryContext = productContext;
    const intents: ParsedInventoryIntent[] = plans
      .filter((plan) => plan.inventory)
      .map((plan) => ({
        sourceRow: plan.product.sourceRow,
        productId: PENDING_PRODUCT_ID,
        ...plan.inventory!,
      }));

    const classified = classifyInventoryIntents(intents, inventoryContext);
    const refusedRows = new Map(classified.refusals.map((r) => [r.sourceRow, r.issue.message]));

    const writable = plans.filter((plan) => !refusedRows.has(plan.product.sourceRow));
    const results: RowApplication[] = [];

    // A refused row is refused whole. Its product is not written, so there is
    // nothing to undo — which is what lets this stay inside one transaction
    // without partial state.
    for (const plan of plans) {
      const refusal = refusedRows.get(plan.product.sourceRow);
      if (refusal) {
        results.push({
          sourceRow: plan.product.sourceRow,
          outcome: RowOutcome.BLOCKED,
          reason: refusal,
        });
      }
    }

    if (writable.length === 0) return results;

    // PUBLICATION, PHASE 1 — before anything is written.
    //
    // The stores this unit could newly expose are locked FIRST, and the
    // pre-write publication state is read under those locks. Locking first is
    // what makes the check meaningful against a concurrent
    // `ProductFieldsService` call making a field required: that path takes the
    // same `storePublicationLock`, so one of the two waits for the other.
    //
    // IN A PREPARED BATCH these keys are already held: `prepareBatch` took them
    // for every unit before the first one wrote anything, and the family keys
    // after them. What is left to do here is notice a store this unit needs
    // that the batch did NOT take — the product's status moved since — and
    // refuse, because taking it now would be a store key after a family key
    // and after rows. The executor starts the batch again with it named.
    //
    // A unit applied on its own, with no batch prepared, takes them here as it
    // always did.
    const candidateStores = await this.candidateStores(writable, context);
    if (context.batchLocks) {
      const missing = candidateStores.filter((storeId) => !context.batchLocks?.stores.has(storeId));
      if (missing.length > 0) throw new LockSetWidenedError(missing.map((storeId) => storePublicationLock(storeId)));
    } else if (candidateStores.length > 0) {
      await this.publicationGuard.acquire(
        context.em,
        candidateStores.map((storeId) => storePublicationLock(storeId)),
      );
    }
    const targeted = writable.flatMap((plan) =>
      allRowPlans(plan)
        .map((target) => target.product.targetId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    );
    const before = await this.publicationStateOf(targeted, context);

    const productResults = await this.products.apply(
      { ...unit, mutations: writable.map((plan) => plan.product) },
      context,
    );

    const idByRow = new Map<number, string>();
    for (const result of productResults) {
      if (result.targetId) idByRow.set(result.sourceRow, result.targetId);
    }

    // Categories, specifications, files, links and translations, in the same
    // transaction as the product they belong to. A product that exists without
    // the specification its row gave it is a half-imported row, and the report
    // would call it a success.
    const notesByRow = new Map<number, string[]>();
    const categoriesByRow = new Map<number, CategoryProvenance>();
    for (const plan of writable) {
      for (const target of allRowPlans(plan)) {
        const sourceRow = target.product.sourceRow;
        const productId = idByRow.get(sourceRow);
        if (!productId || !target.relationships) continue;
        const outcome = await this.relationships.apply(productId, sourceRow, target.relationships, context);
        if (outcome.notes.length > 0) notesByRow.set(sourceRow, outcome.notes);
        categoriesByRow.set(sourceRow, outcome.categories);
      }
    }

    // PUBLICATION, PHASE 2 — after every write this unit makes, and before any
    // ledger movement.
    //
    // It runs HERE, not inside `ProductsApplier`, because
    // `ProductRelationshipsApplier` above writes `product_field_values`: a row
    // that supplies the very field its target store requires answers it only
    // once that loop has run. Checking earlier would refuse a legal import. It
    // runs BEFORE the inventory posting below so a refusal never does ledger
    // work — and when it throws, the batch transaction takes every write of
    // this unit with it, the card reconciliation included.
    await this.assertUnitPublishable(Array.from(idByRow.values()), before, candidateStores, context);

    const postable = classified.proposals
      .map((proposal) => ({ ...proposal, productId: idByRow.get(proposal.sourceRow) ?? '' }))
      // A proposal whose product was not written has nothing to attach to. This
      // happens when the product itself failed, and that row's outcome already
      // says so.
      .filter((proposal) => proposal.productId !== '');

    const stockByRow =
      postable.length === 0
        ? new Map<number, RowApplication>()
        : new Map((await this.inventory.apply({ ...unit, mutations: postable }, context)).map((r) => [r.sourceRow, r]));

    // The approved plan, indexed by the row it describes. Read-only: it is what
    // the approval attests to, and nothing here may edit it.
    const planByRow = new Map<number, ProductRowPlan>();
    for (const plan of plans) {
      for (const target of allRowPlans(plan)) planByRow.set(target.product.sourceRow, target);
    }

    for (const result of productResults) {
      const stock = stockByRow.get(result.sourceRow);
      const merged = stock ? merge(result, stock) : result;
      const described = withNotes(merged, notesByRow.get(result.sourceRow) ?? []);
      results.push({
        ...described,
        effects: buildEffects({
          product: result,
          stock,
          categories: categoriesByRow.get(result.sourceRow),
          plan: planByRow.get(result.sourceRow),
          destination: productContext.destination ?? null,
          storeNames: productContext.storeNames,
        }),
      });
    }

    return results;
  }

  /**
   * Every store this unit could newly expose a product to.
   *
   * Two sources, and both are needed:
   *
   *   - a store the plan names in `storeValues` — it may create or publish a
   *     link there;
   *   - for a row flipping a product INTO published, every store where that
   *     product already has a published link. Those links go live because the
   *     STATUS changed, and the plan never mentions them.
   *
   * Read from the database rather than assumed from the plan: a plan is
   * compiled at approval time and the product's status may have moved since.
   */
  private async candidateStores(plans: ProductRowPlan[], context: ApplyContext): Promise<string[]> {
    const stores = new Set<string>();
    const publishing: string[] = [];
    for (const plan of plans) {
      for (const target of allRowPlans(plan)) {
        for (const store of target.product.storeValues ?? []) stores.add(store.storeId);
        if (target.product.fields.published === true && target.product.targetId) {
          publishing.push(target.product.targetId);
        }
      }
    }
    if (publishing.length > 0) {
      const rows = await txExecute<{ store_id: string }[]>(
        context.em,
        // #292: only a live item can be published by this unit, so only a
        // live item's branches need locking.
        `select distinct sp.store_id
           from store_products sp
           join products p on p.id = sp.product_id
          where sp.product_id in (${publishing.map(() => '?').join(', ')})
            and sp.published = true
            and p.status <> 'PUBLISHED'
            and p.removed_at is null`,
        publishing,
      );
      for (const r of rows) stores.add(r.store_id);
    }
    return Array.from(stores).sort();
  }

  /**
   * Publication state as it stands: the product's own status and each link's
   * published flag, for the products given.
   *
   * Called once before the unit's writes and once after, so the difference can
   * say which stores the unit actually exposed.
   */
  private async publicationStateOf(
    productIds: string[],
    context: ApplyContext,
  ): Promise<Map<string, { published: boolean; links: Map<string, boolean> }>> {
    const state = new Map<string, { published: boolean; links: Map<string, boolean> }>();
    if (productIds.length === 0) return state;
    const ids = Array.from(new Set(productIds));
    const placeholders = ids.map(() => '?').join(', ');

    const products = await txExecute<{ id: string; status: string }[]>(
      context.em,
      // #292: the before/after snapshots read exactly the rows this applier
      // is able to write. A removed item is absent from both, so no exposure
      // difference is ever computed from a record the unit cannot touch.
      `select id, status from products where id in (${placeholders}) and removed_at is null`,
      ids,
    );
    for (const p of products) state.set(p.id, { published: p.status === 'PUBLISHED', links: new Map() });

    const links = await txExecute<{ product_id: string; store_id: string; published: boolean }[]>(
      context.em,
      `select product_id, store_id, published from store_products where product_id in (${placeholders})`,
      ids,
    );
    for (const l of links) state.get(l.product_id)?.links.set(l.store_id, l.published);
    return state;
  }

  /**
   * Refuse the unit if any product it wrote is now published in a store whose
   * required fields it does not answer.
   *
   * The RULE is not restated here: `PublicationGuardService.assertPublishable`
   * is the one implementation, the same one the dashboard and the generic
   * importer use, and it decides for itself that a family card is exempt and
   * that a child may be answered by its parent. This method's only job is to
   * hand it the right products and the right stores.
   *
   * The guard is an ORM service and this path writes rows with SQL, so it is
   * given a fork bound to the batch transaction — the pattern PR #259
   * established. The fork starts empty, so its reads see the rows just written
   * rather than a stale identity map.
   *
   * A store that turns up newly exposed without having been locked is a race
   * this transaction cannot see, so `assertNotWidened` refuses.
   *
   * WHAT THAT COSTS, stated accurately: there is NO automatic retry on this
   * path. `withLockRetry` wraps the generic importer, not the plan-based
   * runner. `ImportExecutor` catches the throw, reports every row of the batch
   * as FAILED carrying `ROLLED_BACK_EFFECTS`, finishes the execution as FAILED
   * and stops; the lease reaper only revives QUEUED and RUNNING rows, so FAILED
   * is terminal and re-running is an operator action. That is fail-closed and
   * correct — nothing invalid is published — but it is not self-healing, and
   * claiming otherwise would misdescribe what an operator will see.
   */
  private async assertUnitPublishable(
    productIds: string[],
    before: Map<string, { published: boolean; links: Map<string, boolean> }>,
    lockedStores: string[],
    context: ApplyContext,
  ): Promise<void> {
    if (productIds.length === 0) return;
    const after = await this.publicationStateOf(productIds, context);

    const exposedByProduct = new Map<string, string[]>();
    for (const productId of new Set(productIds)) {
      const now = after.get(productId);
      if (!now) continue;
      const was = before.get(productId);
      const exposed = newlyExposedStoreIds({
        publishedBefore: was?.published ?? false,
        publishedAfter: now.published,
        before: was?.links ?? new Map<string, boolean>(),
        after: now.links,
      });
      if (exposed.length > 0) exposedByProduct.set(productId, exposed);
    }
    if (exposedByProduct.size === 0) return;

    const held = new Set(lockedStores);
    const widened = Array.from(new Set(Array.from(exposedByProduct.values()).flat())).filter((s) => !held.has(s));
    this.publicationGuard.assertNotWidened(
      lockedStores.map((storeId) => storePublicationLock(storeId)),
      widened.map((storeId) => storePublicationLock(storeId)),
    );

    const bound = (context.em as EntityManager).fork({ clear: true });
    bound.setTransactionContext((context.em as EntityManager).getTransactionContext());
    // Ascending product id, so a unit with two offending rows always names the
    // same one and the failure a reader sees is reproducible.
    for (const productId of Array.from(exposedByProduct.keys()).sort()) {
      const product = await bound.findOne(Product, { id: productId });
      if (!product) continue;
      await this.publicationGuard.assertPublishable(bound, product, exposedByProduct.get(productId) ?? []);
    }
  }
}

/**
 * Say what could not be attached, on the row it belongs to.
 *
 * A category that does not exist or a specification whose definition has been
 * archived does not fail the row — the product is imported and correct. But it
 * is not the whole of what the file asked for, and a line reading only
 * "created" would let somebody believe the datasheet is attached when it is
 * not.
 */
function withNotes(result: RowApplication, notes: string[]): RowApplication {
  if (notes.length === 0) return result;
  const reasons = [result.reason, ...notes].filter((r): r is string => Boolean(r));
  return { ...result, reason: reasons.join(' ') };
}

/**
 * The id stood in for while the product does not exist yet.
 *
 * A syntactically valid UUID so nothing downstream has to special-case it, and
 * one that cannot collide with a real row. It never reaches the database: the
 * real id replaces it before a single proposal is posted.
 */
const PENDING_PRODUCT_ID = '00000000-0000-4000-8000-000000000000';

/**
 * One row, one verdict.
 *
 * The product's outcome leads, because it is what the person was importing. The
 * stock's reason is appended so the line still says what happened to the forty
 * units — and a stock failure DOWNGRADES the row, since "updated" beside a
 * silently dropped quantity is the reassuring half-truth this whole design is
 * built to avoid.
 */
function merge(product: RowApplication, stock: RowApplication): RowApplication {
  const failed = stock.outcome === RowOutcome.FAILED || stock.outcome === RowOutcome.BLOCKED;
  const reasons = [product.reason, stock.reason].filter((r): r is string => Boolean(r));

  return {
    ...product,
    outcome: failed ? stock.outcome : product.outcome,
    ...(reasons.length > 0 ? { reason: reasons.join(' ') } : {}),
  };
}

/** The narrow view of a mutation the compiler produces, re-exported for callers. */
export type { ProductMutation };

/**
 * What this row did, thing by thing.
 *
 * Derived from what HAPPENED — the product's outcome, the stock application's
 * outcome, the resolver's category provenance — never from what was asked for.
 * Anything the row did not do says so explicitly, so a silence can never be
 * read as a success. That is the whole point: a row once reported CREATED while
 * listing the product in no shop and filing it under no category.
 *
 * Called inside the batch transaction, and the result is persisted with the row
 * result in that same transaction. An effect therefore cannot be recorded by a
 * transaction that did not also commit the thing it describes; a rollback takes
 * the record with it.
 */
function buildEffects(input: {
  product: RowApplication;
  stock: RowApplication | undefined;
  categories: CategoryProvenance | undefined;
  plan: ProductRowPlan | undefined;
  destination: { name: string; kind: string } | null;
  storeNames: Map<string, string> | undefined;
}): RowEffects {
  const { product, stock, categories, plan, destination, storeNames } = input;

  const productBlocked = product.outcome === RowOutcome.BLOCKED || product.outcome === RowOutcome.FAILED;
  const productState: EffectState = productBlocked
    ? 'BLOCKED'
    : product.outcome === RowOutcome.CREATED
      ? 'CREATED'
      : product.outcome === RowOutcome.UPDATED
        ? 'UPDATED'
        : 'UNCHANGED';

  const effects: RowEffects = {
    product: { state: productState, sku: plan?.product.fields?.sku ?? null },
  };

  // Categories. `created` and `reused` come from the resolver, the only place
  // that can tell a path it made from one that was already there.
  if (productBlocked) {
    // Nothing this row attempted survived, so nothing may claim to have.
    effects.categories = { state: 'ROLLED_BACK' };
  } else if (
    !categories ||
    (categories.created.length === 0 && categories.reused.length === 0 && categories.blocked.length === 0)
  ) {
    effects.categories = { state: 'NOT_REQUESTED' };
  } else {
    const touched = categories.created.length + categories.reused.length;
    effects.categories = {
      state: touched === 0 ? 'BLOCKED' : categories.created.length ? 'CREATED' : 'EXISTING',
      ...(categories.created.length ? { created: categories.created } : {}),
      ...(categories.reused.length ? { reused: categories.reused } : {}),
      ...(categories.associated.length ? { associated: categories.associated } : {}),
      ...(categories.blocked.length ? { blocked: categories.blocked } : {}),
    };
  }

  // The shop listing. `storeValues` is what the approved plan asked for; an
  // import never publishes, and the type makes that a constant.
  //
  // Named, because "listed in a shop" is not a fact anybody can act on. The
  // original failure listed products in NO shop while reporting success, and
  // the correction is only useful if the reader can see WHICH shop and check it
  // against the one they meant.
  const listings = plan?.product.storeValues ?? [];
  const names = listings
    .map((listing) => storeNames?.get(listing.storeId))
    .filter((name): name is string => Boolean(name));
  effects.storeAssociation = listings.length
    ? {
        state: productBlocked ? 'ROLLED_BACK' : 'CREATED',
        storeName: names.length ? names.join(', ') : null,
        published: false,
      }
    : { state: 'NOT_REQUESTED', published: false };

  // Inventory. A zero quantity is a deliberate, reportable non-event; a row the
  // file said nothing about is NOT_REQUESTED. The two are different answers.
  const declared = plan?.inventory?.organizationTotal;
  if (productBlocked) {
    effects.inventory = { state: 'ROLLED_BACK' };
  } else if (declared === undefined) {
    effects.inventory = { state: 'NOT_REQUESTED' };
  } else if (stock && (stock.outcome === RowOutcome.FAILED || stock.outcome === RowOutcome.BLOCKED)) {
    effects.inventory = { state: 'BLOCKED', quantity: declared };
  } else if (declared === 0) {
    effects.inventory = { state: 'ZERO_NO_MOVEMENT', quantity: 0 };
  } else {
    effects.inventory = {
      state: 'CREATED',
      locationName: destination?.name ?? null,
      locationKind: destination?.kind ?? null,
      quantity: declared,
    };
  }

  return effects;
}
