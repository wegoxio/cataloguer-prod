import { Issue, issue } from '../issues/issue-taxonomy';

/**
 * What an import says about stock, and what may be done with it.
 *
 * Phase 5 made the inventory ledger the single owner of what is in stock, and
 * the writer census permits exactly one construct to touch the legacy cache
 * columns. So an import may not write stock. What it CAN do — and what a
 * customer arriving with a spreadsheet actually needs — is *propose* an
 * inventory movement that a person approves and that the authorised posting
 * surface then applies.
 *
 * This module is the parse-and-classify half. It reads what the file said,
 * checks it adds up, and decides which kind of proposal it is. It posts
 * nothing, writes nothing, and knows nothing about the ledger's internals.
 *
 * The rule underneath every refusal here: **a quantity nobody can account for
 * must not become a ledger entry.** The ledger is the record of what is actually
 * there; feeding it a number that does not reconcile makes every later question
 * about that product unanswerable.
 */

export type PhysicalCondition = 'GOOD' | 'DAMAGED';

/** One shop's share of a product's stock, as the file states it. */
export interface StoreAllocation {
  storeId: string;
  quantity: number;
  /** Which bucket the units are in. Stated, never assumed. */
  condition: PhysicalCondition;
}

/** What one row said about one product's stock. */
export interface ParsedInventoryIntent {
  sourceRow: number;
  productId: string;
  /**
   * The organization-wide total the file declared, when it declared one.
   *
   * `undefined` means the file said nothing — different from `0`, which is a
   * decision that the product has none.
   */
  organizationTotal?: number;
  /**
   * How many of the organization total are DAMAGED.
   *
   * A subset of `organizationTotal`, never an addition to it. A file saying "we
   * hold 40, of which 6 are damaged" holds forty things: reading it as 46 would
   * inflate the ledger, and treating the 6 as sellable would put broken goods
   * on a shelf. Both are wrong in ways nobody would notice until a customer
   * received one.
   *
   * `undefined` means the file said nothing about damage — different from `0`,
   * which is somebody confirming none of it is.
   */
  organizationDamaged?: number;
  /** Per-shop allocations, when the file broke the total down. */
  allocations?: StoreAllocation[];
  /**
   * Where units with no named shop belong.
   *
   * Required whenever a total exceeds what the allocations account for: units
   * have to be somewhere, and "somewhere" is a custody decision rather than a
   * default.
   */
  defaultLocationId?: string | null;
}

export type ProposalKind =
  /** Bringing the ledger into line with what the customer says they hold. */
  | 'OPENING_ADJUSTMENT'
  /** Goods arriving against a supplier order, with its own evidence. */
  | 'RECEIPT';

export type DiscrepancyClass = 'MATCHED' | 'PRODUCT_ONLY' | 'ALLOCATION_ONLY' | 'DIVERGENT' | 'NOTHING_STATED';

export interface InventoryProposal {
  sourceRow: number;
  productId: string;
  kind: ProposalKind;
  /** How the declared total and the allocations related. Recorded, not hidden. */
  discrepancy: DiscrepancyClass;
  /** The total this proposal would move, always positive. */
  totalQuantity: number;
  /** Where each unit lands. Every unit is accounted for by construction. */
  placements: { locationId: string; condition: PhysicalCondition; quantity: number }[];
  /** A zero-total decision, carried rather than dropped. See `isZeroDecision`. */
  zeroDecision: boolean;
}

export interface ProposalRefusal {
  sourceRow: number;
  productId: string;
  issue: Issue;
}

export interface ClassifyResult {
  proposals: InventoryProposal[];
  refusals: ProposalRefusal[];
}

/** What the caller may write to, already narrowed by tenant scope. */
export interface InventoryContext {
  /** Stores this import is permitted to affect. */
  allowedStoreIds: Set<string>;
  /** `storeId` → its canonical custody location. */
  storeLocationIds: Map<string, string>;
  /**
   * Whether the organization is inside a declared cutover freeze.
   *
   * The posting surface refuses OPENING_BALANCE outside one and refuses
   * everything else inside one, so an import can only ever post while
   * unfrozen — and must say so plainly rather than failing at the ledger.
   */
  frozen: boolean;
  /**
   * Whether the organization has its one default warehouse.
   *
   * The posting surface requires exactly one and refuses otherwise. Checking it
   * here turns a BadRequestException thrown from deep inside posting — which
   * would fail a whole batch with an operator-facing sentence — into a row-level
   * refusal the person can act on.
   */
  hasDefaultWarehouse: boolean;
}

/**
 * Classify what a set of parsed intents may become.
 *
 * Deliberately total: every intent produces either a proposal or a refusal
 * carrying the sentence that explains it. Nothing is dropped, because a
 * silently discarded stock intent is a customer believing their inventory was
 * imported.
 */
export function classifyInventoryIntents(
  intents: ParsedInventoryIntent[],
  context: InventoryContext,
  kind: ProposalKind = 'OPENING_ADJUSTMENT',
): ClassifyResult {
  const proposals: InventoryProposal[] = [];
  const refusals: ProposalRefusal[] = [];

  for (const intent of intents) {
    const refusal = refuse(intent, context);
    if (refusal) {
      refusals.push({ sourceRow: intent.sourceRow, productId: intent.productId, issue: refusal });
      continue;
    }

    const discrepancy = classifyDiscrepancy(intent);
    if (discrepancy === 'NOTHING_STATED') continue; // the file said nothing about stock

    const placements = buildPlacements(intent, context);
    const totalQuantity = placements.reduce((sum, p) => sum + p.quantity, 0);

    proposals.push({
      sourceRow: intent.sourceRow,
      productId: intent.productId,
      kind,
      discrepancy,
      totalQuantity,
      placements,
      zeroDecision: isZeroDecision(intent),
    });
  }

  return { proposals, refusals };
}

/**
 * How the declared total and the allocations relate.
 *
 * The same vocabulary the P5-B2 opening reconciliation uses, deliberately: an
 * operator who has read one should not have to learn a second set of words for
 * the same four situations.
 */
export function classifyDiscrepancy(intent: ParsedInventoryIntent): DiscrepancyClass {
  const hasTotal = intent.organizationTotal !== undefined;
  const allocations = intent.allocations ?? [];
  const hasAllocations = allocations.length > 0;

  if (!hasTotal && !hasAllocations) return 'NOTHING_STATED';
  if (!hasAllocations) return 'PRODUCT_ONLY';
  if (!hasTotal) return 'ALLOCATION_ONLY';

  const allocated = allocations.reduce((sum, a) => sum + a.quantity, 0);
  return allocated === intent.organizationTotal ? 'MATCHED' : 'DIVERGENT';
}

/**
 * A declared zero is a DECISION, not an absence.
 *
 * "This product has none" is a statement the customer made, and dropping it
 * because the number happens to be zero would leave a stale cache and an
 * unanswered question. It produces no ledger movement — a ledger entry may not
 * carry a zero delta — but the decision is carried through the plan so the
 * report can say it was honoured.
 */
export function isZeroDecision(intent: ParsedInventoryIntent): boolean {
  const allocations = intent.allocations ?? [];
  const total = intent.organizationTotal;
  if (total === 0 && allocations.every((a) => a.quantity === 0)) return true;
  return total === undefined && allocations.length > 0 && allocations.every((a) => a.quantity === 0);
}

/**
 * Why an intent cannot become a proposal.
 *
 * Every one of these is a case where posting would put a number in the ledger
 * that nobody could later account for.
 */
function refuse(intent: ParsedInventoryIntent, context: InventoryContext): Issue | null {
  const anchor = { row: intent.sourceRow };
  const allocations = intent.allocations ?? [];

  if (!context.hasDefaultWarehouse) {
    return issue('PLAN_EXCEEDS_LIMIT', 'This company has no main warehouse, so stock cannot be imported yet.', {
      anchor,
      guidance: 'Set up your inventory locations first, then import again.',
    });
  }

  if (context.frozen) {
    // The freeze exists precisely because no ordinary caller should be posting.
    return issue(
      'PLAN_EXCEEDS_LIMIT',
      'This company is in an inventory cutover window, so stock cannot be imported right now.',
      { anchor, guidance: 'Wait until the cutover finishes, then import again.' },
    );
  }

  for (const allocation of allocations) {
    if (!context.allowedStoreIds.has(allocation.storeId)) {
      // Indistinguishable from a shop that does not exist.
      return issue('STORE_NOT_PERMITTED', 'One of the shops in this row is not available to you.', {
        anchor,
        guidance: 'Choose a shop you have access to, or remove its column from the mapping.',
      });
    }
    if (!context.storeLocationIds.has(allocation.storeId)) {
      return issue('STORE_NOT_PERMITTED', 'One of the shops in this row has no stock location set up.', {
        anchor,
        guidance: 'Set the shop up for inventory before importing stock into it.',
      });
    }
  }

  if (allocations.some((a) => a.quantity < 0)) {
    return issue('VALUE_OUT_OF_RANGE', 'A shop in this row has a negative quantity.', {
      anchor,
      guidance: 'Stock cannot be below zero. Correct the value, or leave it blank.',
    });
  }
  if (intent.organizationDamaged !== undefined && intent.organizationDamaged < 0) {
    return issue('VALUE_OUT_OF_RANGE', 'This row has a negative damaged quantity.', {
      anchor,
      guidance: 'Use zero rather than a negative number.',
    });
  }

  // Damaged units are a SUBSET of the total, so more damaged than total is a
  // contradiction with no defensible reading. Silently clamping it would either
  // invent stock or lose the damage.
  if (
    intent.organizationDamaged !== undefined &&
    intent.organizationTotal !== undefined &&
    intent.organizationDamaged > intent.organizationTotal
  ) {
    return issue(
      'VALUE_OUT_OF_RANGE',
      `This row says ${intent.organizationDamaged} are damaged but that the company holds only ${intent.organizationTotal}.`,
      {
        anchor,
        guidance: 'Damaged units are part of the total, not extra. Correct one of the two numbers.',
      },
    );
  }

  // Shops cannot hold more damage than the company says exists.
  if (intent.organizationDamaged !== undefined) {
    const allocatedDamaged = allocations
      .filter((a) => a.condition === 'DAMAGED')
      .reduce((sum, a) => sum + a.quantity, 0);
    if (allocatedDamaged > intent.organizationDamaged) {
      return issue(
        'VALUE_OUT_OF_RANGE',
        `The shops in this row account for ${allocatedDamaged} damaged units, but the company total says ${intent.organizationDamaged}.`,
        {
          anchor,
          guidance: 'Correct the damaged total, or the damaged quantities in the shops.',
        },
      );
    }
  }

  if (intent.organizationTotal !== undefined && intent.organizationTotal < 0) {
    return issue('VALUE_OUT_OF_RANGE', 'This row has a negative total.', {
      anchor,
      guidance: 'Stock cannot be below zero.',
    });
  }

  // Reconciliation is about whether every unit is ACCOUNTED FOR, not about
  // whether the two numbers happen to be equal. A total of 20 with 12 in shops
  // and a named destination for the other 8 reconciles perfectly, and is the
  // ordinary shape of a warehouse-plus-shops catalogue.
  const total = intent.organizationTotal;
  if (total !== undefined) {
    const allocated = allocations.reduce((sum, a) => sum + a.quantity, 0);

    if (allocated > total) {
      // A contradiction with no defensible resolution. A silent max, min or sum
      // is exactly what the P5-B2 owner decision forbids, so a person states
      // the answer.
      return issue(
        'VALUE_OUT_OF_RANGE',
        `This row says the company holds ${total} but the shops already account for ${allocated}.`,
        {
          anchor,
          guidance: 'Correct the total, or correct the shop quantities so they do not exceed it.',
        },
      );
    }

    if (allocated < total && !intent.defaultLocationId) {
      // The remaining units have nowhere to be. Custody is a decision, and
      // defaulting it would put stock in a location nobody named.
      const remainder = total - allocated;
      return issue(
        'VALUE_OUT_OF_RANGE',
        allocations.length === 0
          ? 'This row gives a total but does not say where the stock is held.'
          : `This row leaves ${remainder} unit(s) unaccounted for: the shops hold ${allocated} of ${total}.`,
        {
          anchor,
          guidance: 'Choose a destination for stock that is not broken down by shop.',
        },
      );
    }
  }

  return null;
}

/**
 * Where each unit lands.
 *
 * Built so every unit is accounted for by construction: allocations place
 * themselves, and whatever a declared total leaves over goes to the stated
 * default location. There is no path here that invents a placement.
 */
function buildPlacements(
  intent: ParsedInventoryIntent,
  context: InventoryContext,
): { locationId: string; condition: PhysicalCondition; quantity: number }[] {
  const placements: { locationId: string; condition: PhysicalCondition; quantity: number }[] = [];

  for (const allocation of intent.allocations ?? []) {
    if (allocation.quantity <= 0) continue; // a zero placement is not a movement
    placements.push({
      locationId: context.storeLocationIds.get(allocation.storeId)!,
      condition: allocation.condition,
      quantity: allocation.quantity,
    });
  }

  const allocated = (intent.allocations ?? []).reduce((sum, a) => sum + a.quantity, 0);
  const total = intent.organizationTotal;
  if (total === undefined || total <= allocated || !intent.defaultLocationId) return placements;

  const remainder = total - allocated;

  // The remainder is split by CONDITION before it is placed. Damage the shops
  // did not account for is still damage, and a remainder posted wholly as GOOD
  // is the precise failure this split exists to prevent: six broken units
  // quietly becoming six sellable ones in the warehouse.
  const allocatedDamaged = (intent.allocations ?? [])
    .filter((a) => a.condition === 'DAMAGED')
    .reduce((sum, a) => sum + a.quantity, 0);
  const remainderDamaged =
    intent.organizationDamaged === undefined ? 0 : Math.max(0, intent.organizationDamaged - allocatedDamaged);

  if (remainderDamaged > 0) {
    placements.push({
      locationId: intent.defaultLocationId,
      condition: 'DAMAGED',
      quantity: Math.min(remainderDamaged, remainder),
    });
  }

  const remainderGood = remainder - Math.min(remainderDamaged, remainder);
  if (remainderGood > 0) {
    placements.push({
      locationId: intent.defaultLocationId,
      // Unstated condition is GOOD. Damage is always declared: nobody records
      // it by omission, and assuming DAMAGED would make every ordinary import
      // non-sellable.
      condition: 'GOOD',
      quantity: remainderGood,
    });
  }

  return placements;
}

/**
 * A stable idempotency key for one proposal.
 *
 * Bound to the execution and the source row, so a resumed or retried run
 * replays the posting rather than doubling it — the posting surface returns the
 * original transaction for a repeated key.
 */
export function proposalIdempotencyKey(executionId: string, sourceRow: number, productId: string): string {
  return `import:${executionId}:${sourceRow}:${productId}`;
}

/** A one-line summary for the approval artifact, in the approver's words. */
export function describeProposal(proposal: InventoryProposal): string {
  if (proposal.zeroDecision) {
    return `Record that this product holds nothing.`;
  }
  const where = proposal.placements.length === 1 ? 'in one location' : `across ${proposal.placements.length} locations`;
  const verb = proposal.kind === 'RECEIPT' ? 'Receive' : 'Adjust the ledger by';
  return `${verb} ${proposal.totalQuantity} unit${proposal.totalQuantity === 1 ? '' : 's'} ${where}.`;
}
