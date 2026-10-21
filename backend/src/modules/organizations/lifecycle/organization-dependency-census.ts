/**
 * THE ORGANIZATION-OWNED DEPENDENCY CENSUS (#289 P1, feeding #294).
 *
 * Every table that carries an `organization_id` column is listed here with a
 * stated disposition for the organization MERGE. The list is not advisory: a
 * PostgreSQL test reads the live schema and fails when a table carrying the
 * column is missing from this map, or when this map names a table the schema
 * no longer has. Adding an organization-tagged table therefore forces a
 * decision about what a merge does with its rows — which is the failure mode
 * #289 found: fourteen tables added after the merge was written, none of them
 * moved, all of them silently left on the archived source.
 *
 * DISPOSITIONS
 *
 *   MOVED   — the merge retags the rows to the target. The set is checked
 *             against the merge service's own SQL, so the two cannot drift.
 *   UNMOVED — the merge does NOT move these rows, and has no correct way to:
 *             the retag design for them is the open half of #289. Until it
 *             lands, a source that owns rows matching `refuseWhen` REFUSES the
 *             merge, because leaving them behind is exactly the hazard. The
 *             predicate is the "live/operational" surface for the table; for
 *             most Phase 5 tables that is every row, because stock custody,
 *             ledger history, receiving history and import provenance split
 *             across two companies are the hazard whether or not the row is
 *             still open. Where a table has terminal states that are pure
 *             history, the predicate says so.
 *   TRAIL   — a record OF what happened rather than a thing the company owns:
 *             never moved, never a reason to refuse. Audit rows must stay
 *             attributed to the organization they were written about, and a
 *             webhook ledger row is proof of an event, not company state.
 *
 * `refuseWhen` is a SQL predicate over the alias `t`. The predicates are
 * executed against the live schema by the census test, so a column rename
 * breaks the gate rather than the merge.
 *
 * Tables owned through a STORE only (api_keys, invoices, payments, discount
 * codes, integration requests, store content and pop-ups, product images,
 * refresh tokens) carry no `organization_id` and are outside this census on
 * purpose: they move with their store, whose retag the merge already performs.
 */
export type MergeDisposition =
  | { kind: 'MOVED'; note: string }
  | {
      kind: 'UNMOVED';
      refuseWhen: string;
      /**
       * #277 P2 — THE SETTLEMENT WHITELIST, for a row with a lifecycle of its
       * own (the runner's execution and analysis rows). Under an ARCHIVED
       * company the only update still accepted takes a QUEUED/RUNNING row to a
       * terminal status while changing nothing but these columns and clearing
       * its lease. Checked inside the guard function against the columns that
       * actually changed — the trigger fires for every update, a merged
       * destination is refused before the whitelist is consulted, and a
       * reassignment is never part of it. Null for every other class.
       */
      settlement: Settlement | null;
      note: string;
    }
  | { kind: 'TRAIL'; note: string };

const ANY_ROW = 'true';

const moved = (note: string): MergeDisposition => ({ kind: 'MOVED', note });
const unmoved = (
  note: string,
  refuseWhen: string = ANY_ROW,
  settlement: Settlement | null = null,
): MergeDisposition => ({
  kind: 'UNMOVED',
  refuseWhen,
  settlement,
  note,
});

/**
 * A SETTLEMENT: the one shape of update a row with a lifecycle of its own may
 * still take under an inactive company — from an in-flight status to a
 * terminal one, changing nothing but the listed columns, never a
 * reassignment. `underMerged` records the table's own decision about a MERGED
 * company; `leaseCleared` requires both lease columns to end null.
 */
export interface Settlement {
  from: readonly string[];
  to: readonly string[];
  columns: readonly string[];
  underMerged: boolean;
  leaseCleared: boolean;
}
/** The runner ending a job. Never under a merged company: the merge refuses to leave provenance behind. */
export const RUN_SETTLEMENT: Settlement = Object.freeze({
  from: ['QUEUED', 'RUNNING'],
  to: ['FAILED', 'ABANDONED', 'CANCELLED', 'COMPLETED'],
  columns: ['status', 'failure_reason', 'finished_at', 'updated_at', 'lease_owner', 'lease_expires_at'],
  underMerged: false,
  leaseCleared: true,
});
/**
 * Stripe settling a checkout (#248): exactly what `settleAttempt` writes.
 * PERMITTED UNDER A MERGED COMPANY — P1's explicit exception, pinned by its
 * guard suite: an attempt open before the merge is history being written
 * down. Never a reassignment, a change to the request, the plan or the
 * customer, or an edit of an attempt already settled.
 */
export const CHECKOUT_SETTLEMENT: Settlement = Object.freeze({
  from: ['creating', 'open'],
  to: ['completed', 'expired', 'failed'],
  columns: [
    'status',
    'settled_at',
    'updated_at',
    'session_url',
    'completed_event_id',
    'settle_note',
    'failure_code',
    'stripe_session_id',
  ],
  underMerged: true,
  leaseCleared: false,
});
/** The trigger arguments a settlement is handed to the guard function as. */
export function settlementArguments(s: Settlement): string[] {
  return [
    'settlement',
    s.from.join(','),
    s.to.join(','),
    s.columns.join(','),
    `${s.underMerged ? 'M' : ''}${s.leaseCleared ? 'L' : ''}`,
  ];
}
const trail = (note: string): MergeDisposition => ({ kind: 'TRAIL', note });

export const ORGANIZATION_DEPENDENCIES: Readonly<Record<string, MergeDisposition>> = Object.freeze({
  // ── moved by the merge, every row, lifecycle state included (see the service) ──
  stores: moved('the branches; a removed branch travels too, or it could never be restored'),
  users: moved('the people; a removed identity travels too, for the same reason'),
  products: moved('the catalogue'),
  categories: moved('the catalogue tree'),
  store_products: moved('branch membership and prices; inventories are never mixed'),
  sales_orders: moved('commercial history'),

  // ── inventory custody and ledger (Phase 5) — split custody is the hazard itself ──
  inventory_locations: unmoved(
    'the default WAREHOUSE would be orphaned; STORE custody cascades with the store but the warehouse does not',
  ),
  inventory_transactions: unmoved('ledger history'),
  inventory_entries: unmoved('ledger history'),
  inventory_balances: unmoved('current stock custody'),
  inventory_transit_balances: unmoved('stock in transit'),
  inventory_reservations: unmoved('reserved stock'),
  inventory_backorders: unmoved('open and historical backorders'),
  inventory_backorder_allocations: unmoved('backorder allocations'),
  inventory_transfers: unmoved("custody moving between the company's own locations"),
  inventory_transfer_lines: unmoved('transfer lines'),
  inventory_transaction_intents: unmoved('pending ledger commands'),
  inventory_opening_reconciliations: unmoved('opening balance history'),
  inventory_opening_reconciliation_allocations: unmoved('opening balance allocations'),

  // ── receiving (Phase 5 D3) ──

  // ── import provenance (Phase 9) ──
  import_sources: unmoved('uploaded files and their provenance'),
  import_analyses: unmoved('analysis results', ANY_ROW, RUN_SETTLEMENT),
  import_plans: unmoved('compiled plans'),
  import_approvals: unmoved('approval proofs'),
  import_executions: unmoved('execution history', ANY_ROW, RUN_SETTLEMENT),
  import_row_results: unmoved('per-row outcomes'),
  import_mapping_templates: unmoved('saved mappings'),
  import_external_identities: unmoved('external identifier bindings'),
  imported_historical_sales: unmoved('imported sales history'),

  // ── catalogue metadata written since the merge (Phases 2–4, ADR 013) ──
  product_field_definitions: unmoved('specification registry'),
  product_field_values: unmoved('specification values'),
  store_field_settings: unmoved('per-branch field settings'),
  product_relations: unmoved('product relations'),
  family_vocabulary: unmoved('family vocabulary'),
  dismissed_suggestions: unmoved('dismissed grouping suggestions'),
  // ADR 030. Classified exactly like the library files they organise: a file
  // is not moved by a merge, so neither is a collection that references it —
  // the composite keys pin a membership to its file's company.
  product_categories: unmoved('product ↔ category membership, organization-tagged for tenancy'),
  product_translations: unmoved('localized catalogue copy (ADR 013)'),
  category_translations: unmoved('localized category copy (ADR 013)'),

  // ── billing (#248) — only an attempt still in flight is operational ──
  billing_checkout_attempts: unmoved(
    'a checkout still creating or open would complete against the wrong company; settled attempts are history',
    "t.status in ('creating', 'open')",
    CHECKOUT_SETTLEMENT,
  ),

  // ── trails ──
  audit_logs: trail('attribution stays where it was written; the merge audits both sides itself'),
  stripe_events: trail('webhook ledger: proof of an event, not company state'),
});

/** The tables the merge retags, sorted — checked against the service's SQL by the census test. */
export const MERGE_MOVES: readonly string[] = Object.freeze(
  Object.entries(ORGANIZATION_DEPENDENCIES)
    .filter(([, d]) => d.kind === 'MOVED')
    .map(([t]) => t)
    .sort(),
);

export interface UnmovedClass {
  table: string;
  refuseWhen: string;
  settlement: Settlement | null;
  note: string;
}

/** The classes whose rows on a source refuse the merge, sorted by table. */
export function unmovedClasses(): UnmovedClass[] {
  return Object.entries(ORGANIZATION_DEPENDENCIES)
    .filter((e): e is [string, Extract<MergeDisposition, { kind: 'UNMOVED' }>] => e[1].kind === 'UNMOVED')
    .map(([table, d]) => ({ table, refuseWhen: d.refuseWhen, settlement: d.settlement, note: d.note }))
    .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));
}

export interface CensusReport {
  /** Live tables carrying organization_id with no disposition here. */
  unclassified: string[];
  /** Dispositions here for tables the live schema does not have. */
  stale: string[];
}

/**
 * Compares the live set of organization-tagged tables with this map. Pure, so
 * the failure modes can be proved without a database as well as with one.
 */
export function auditOrganizationDependencyCensus(liveTables: Iterable<string>): CensusReport {
  const live = new Set(liveTables);
  const classified = new Set(Object.keys(ORGANIZATION_DEPENDENCIES));
  return {
    unclassified: [...live].filter((t) => !classified.has(t)).sort(),
    stale: [...classified].filter((t) => !live.has(t)).sort(),
  };
}

/** Throws with the full report when the census is not clean. */
export function assertCensusClean(report: CensusReport): void {
  if (report.unclassified.length === 0 && report.stale.length === 0) return;
  const lines: string[] = [];
  if (report.unclassified.length) {
    lines.push(
      `organization-tagged table(s) with no merge disposition: ${report.unclassified.join(', ')} — decide MOVED, UNMOVED or TRAIL in organization-dependency-census.ts`,
    );
  }
  if (report.stale.length)
    lines.push(`disposition(s) for table(s) the schema no longer has: ${report.stale.join(', ')}`);
  throw new Error(lines.join('\n'));
}

// ── the database guards that hold the organization lifecycle (#289 P1, #277 P2) ──
//
// "A merge cannot succeed while the source owns an unmoved dependency, and
// leaves no moved row behind" is a promise about CONCURRENT writers too, and
// neither an application-level count nor a pre-lock of existing rows can keep
// it alone: a writer that commits an unmoved row after the merge counted would
// be left behind, and a row that did not exist when the merge locked the
// existing ones cannot have been locked — the organization foreign key only
// makes its insert WAIT for the organization row, and the source still exists
// after the merge. So every MOVED and every UNMOVED class carries two BEFORE
// triggers, generated from the census.
//
// P2 (#277) EVOLVED THE SAME GUARD: "an archived organization is operationally
// inactive" is the same kind of promise, broken the same way. The P1 function
// locked the organization row but read only the merge record, so a writer
// waiting in it resumed after an archive committed, saw "not merged", and
// wrote into the archived company; and its UPDATE trigger fired only when a
// row changed company, so an ordinary update of an existing row never entered
// the guard at all. The locking read now returns BOTH `merged_into_organization_id`
// and `archived_at`, a merged destination refuses with `WGR02` as before, an
// archived one with `WGR03`, and the UPDATE trigger fires for EVERY update
// that leaves the row operational, not only for reassignment.
//
//   INSERT — UNMOVED: fires when the new row matches the class predicate.
//            MOVED: fires for every row, because the merge retags every
//            lifecycle state and a row landing after the retag is left behind.
//            Locks the row's organization FOR SHARE, reads the merge record
//            and the archive stamp in that same locking query, and refuses if
//            either is set.
//   UPDATE — unconditional classes: fires for every row. Conditional classes:
//            fires when the row still matches the predicate AFTER the update —
//            a checkout attempt that settles (leaves the predicate) is history
//            being written down and is allowed on a merged or archived company,
//            exactly the terminal behaviour P1 approved. A reassignment locks
//            every organization involved (ascending) and judges the
//            DESTINATION: rows leaving a merged or archived company are not
//            refused, because that is the direction the merge's own retag and
//            the later #289 retag design take.
//   TRAIL  — no guard, explicitly: a record OF what happened may be written
//            about a merged or archived company. The guard test asserts the
//            absence.
//
// `FOR SHARE` on the organization row is what makes the two orders come out
// right: the merge and the archive hold that row `FOR UPDATE` from before they
// count until they commit. A writer that got there first holds its share until
// it commits, so the lifecycle change waits, then counts the committed row,
// then refuses (or, for the archive, refuses because a live branch now
// exists). A lifecycle change that got there first makes the writer wait, and
// the writer then reads the committed record and refuses. `FOR KEY SHARE`
// would not conflict with the lifecycle change's lock at all, and a plain read
// would answer from a snapshot.
//
// The migrations that create the triggers carry a FROZEN copy of these lists,
// because a migration must not change its meaning when this file does. The
// guard test compares the live trigger set and each trigger's recorded
// predicate against what this module generates NOW, so a census change without
// a matching migration fails the gate.

export const MERGED_ORGANIZATION_SQLSTATE = 'WGR02';
/** #277 P2 — raised when the destination organization is archived. */
export const ARCHIVED_ORGANIZATION_SQLSTATE = 'WGR03';
/** #294 P3: the guard refuses an operational dependency on a REMOVED company with this SQLSTATE. */
export const REMOVED_ORGANIZATION_SQLSTATE = 'WGR04';
/** The function P1 installed; `Migration20260913140000` replaces it and `down` restores it. */
export const P1_MERGED_GUARD_FUNCTION = 'wegox_refuse_dependency_on_merged_org';
/** The evolved guard function (P2). */
export const ORGANIZATION_GUARD_FUNCTION = 'wegox_refuse_dependency_on_inactive_org';
/** Short on purpose: the longest guarded table name is 44 bytes and the limit is 63. Historical prefix, kept across P2. */
export const ORGANIZATION_GUARD_PREFIX = 'wegox_mo_';

export interface OrganizationGuard {
  table: string;
  /** The trigger base name; `_ins` and `_upd` are appended. */
  name: string;
  refuseWhen: string;
  /** The settlement handed to the function as trigger arguments; null for every other class. */
  settlement: Settlement | null;
  /** Always null since P2: every insert of every class enters the guard; `refuseWhen` is the merge's count rule only. */
  insertWhen: null;
  /** Always null since P2: every update of every class enters the guard. */
  updateWhen: null;
}

/** Rewrites a census predicate (over alias `t`) onto a trigger row alias. */
export function predicateOver(refuseWhen: string, alias: 'new' | 'old'): string {
  return refuseWhen.replace(/\bt\./g, `${alias}.`);
}

export function organizationGuardFor(
  table: string,
  refuseWhen: string,
  settlement: Settlement | null = null,
): OrganizationGuard {
  const name = `${ORGANIZATION_GUARD_PREFIX}${table}`;
  if (Buffer.byteLength(`${name}_ins`, 'utf8') > 63) {
    throw new Error(`guard name "${name}_ins" exceeds PostgreSQL's 63-byte identifier limit`);
  }
  return {
    table,
    name,
    refuseWhen,
    settlement,
    insertWhen: null,
    updateWhen: null,
  };
}

/** The tables that carry NO guard, by explicit disposition. */
export function trailClasses(): string[] {
  return Object.entries(ORGANIZATION_DEPENDENCIES)
    .filter(([, d]) => d.kind === 'TRAIL')
    .map(([t]) => t)
    .sort();
}

/**
 * One guard per MOVED and per UNMOVED class, generated from the census as it
 * is now, sorted by table. MOVED classes guard every row (`true`).
 */
export function organizationGuards(): OrganizationGuard[] {
  const moved = MERGE_MOVES.map((table) => organizationGuardFor(table, 'true'));
  const unmoved = unmovedClasses().map((c) => organizationGuardFor(c.table, c.refuseWhen, c.settlement));
  return [...moved, ...unmoved].sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));
}

// ── the INDIRECT census: tables that carry no organization_id (#277 P2) ──────
//
// The organization census above covers every table tagged with an
// `organization_id`. The rest of the schema is owned through a parent — a
// store, a product, an order, an import execution — or belongs to no tenant at
// all. "Archived is operationally inactive" has to answer for those too, so
// every live table WITHOUT the column is listed here with one of four
// dispositions, and the census test fails when a table is missing or stale:
//
//   THROUGH    — operational state reached through a parent row that IS
//                organization-tagged. Guarded by `wegox_io_<table>_ins/_upd`,
//                which locks the PARENT row(s) FOR SHARE first (ascending when
//                a row changes parent), derives the organization only from the
//                rows so locked, locks that organization FOR SHARE and refuses
//                exactly as the direct guard does. The parent lock is what
//                stops a concurrent parent reassignment from being judged on
//                the company the parent used to belong to. Included rather
//                than trusted to authentication because a background writer
//                (the import runner writes product images and supplier order
//                items; the execution store writes checkpoints) has no session
//                to revoke.
//   CREDENTIAL — a session or token of a person. Archive REVOKES these itself
//                (refresh sessions, unused reset and invitation tokens) and
//                restoration reissues one, so the archive and restore
//                transactions must be able to write them; a guard here would
//                refuse the very statement that makes the company inactive.
//                They are never company state, and no archived member can
//                mint one: sign-in, refresh, reset and redemption all refuse.
//   LEDGER     — proof of an event, not company state: the Stripe delivery and
//                processing ledgers, and the payment row the billing webhook
//                writes for a subscription invoice. Billing continues
//                unchanged on an archived company by owner decision (#277 D6),
//                so its payment history must remain recordable.
//   PLATFORM   — no tenant at all: the migration ledger, roles, the singleton
//                settings row, and the organizations table itself, whose row is
//                the lifecycle record the guards read.
//
// The archived-STORE enforcement that already exists (Slice D triggers on
// removed stores; the tenant-scope, session-binding and API-key refusals for
// archived stores) is what makes a THROUGH guard reachable only by a
// background writer in practice: an organization cannot be archived while it
// has a live branch, a platform administrator cannot enter an archived branch
// through `X-Managed-Store`, a member bound to one cannot hold a session, and
// its API keys stop authenticating. The guard closes the door those rules do
// not reach: a job that holds no session at all.
export type IndirectDisposition =
  | { kind: 'THROUGH'; parent: string; column: string; note: string }
  | { kind: 'CREDENTIAL'; note: string }
  | { kind: 'LEDGER'; note: string }
  | { kind: 'PLATFORM'; note: string };

const through = (parent: string, column: string, note: string): IndirectDisposition => ({
  kind: 'THROUGH',
  parent,
  column,
  note,
});
const credential = (note: string): IndirectDisposition => ({ kind: 'CREDENTIAL', note });
const ledger = (note: string): IndirectDisposition => ({ kind: 'LEDGER', note });
const platform = (note: string): IndirectDisposition => ({ kind: 'PLATFORM', note });

export const INDIRECT_DEPENDENCIES: Readonly<Record<string, IndirectDisposition>> = Object.freeze({
  // ── owned through a store ──
  api_keys: through('stores', 'store_id', 'a branch credential; issued and revoked from the panel'),
  discount_codes: through('stores', 'store_id', 'commercial rules of a branch'),
  // ── owned through a product or an order ──
  product_images: through('products', 'product_id', 'catalogue media; ALSO written by the import runner'),
  sales_order_items: through('sales_orders', 'order_id', 'lines of a sale'),
  // ── owned through an import execution ──
  import_checkpoints: through('import_executions', 'execution_id', 'batch provenance written by the runner'),
  // ── credentials ──
  refresh_tokens: credential('sessions; revoked by the archive itself'),
  password_reset_tokens: credential('reset and invitation tokens; invalidated by the archive, reissued by restoration'),
  // ── ledgers ──
  payments: ledger('the payment row the billing webhook writes for a subscription invoice (D6: billing unchanged)'),
  stripe_event_processings: ledger('webhook processing ledger'),
  stripe_webhook_deliveries: ledger('webhook delivery ledger'),
  // ── platform ──
  organizations: platform('the lifecycle record itself'),
  roles: platform('the role catalogue'),
  settings: platform('the singleton platform settings row'),
  mikro_orm_migrations: platform('the migration ledger'),
});

export const INDIRECT_GUARD_FUNCTION = 'wegox_refuse_indirect_dependency_on_inactive_org';
export const INDIRECT_GUARD_PREFIX = 'wegox_io_';

export interface IndirectGuard {
  table: string;
  name: string;
  parent: string;
  column: string;
}

/** One guard per THROUGH class, sorted by table. */
export function indirectGuards(): IndirectGuard[] {
  return Object.entries(INDIRECT_DEPENDENCIES)
    .filter((e): e is [string, Extract<IndirectDisposition, { kind: 'THROUGH' }>] => e[1].kind === 'THROUGH')
    .map(([table, d]) => {
      const name = `${INDIRECT_GUARD_PREFIX}${table}`;
      if (Buffer.byteLength(`${name}_ins`, 'utf8') > 63) {
        throw new Error(`guard name "${name}_ins" exceeds PostgreSQL's 63-byte identifier limit`);
      }
      return { table, name, parent: d.parent, column: d.column };
    })
    .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));
}

/** The tables without a guard of either kind, by explicit disposition, sorted. */
export function unguardedIndirectClasses(): string[] {
  return Object.entries(INDIRECT_DEPENDENCIES)
    .filter(([, d]) => d.kind !== 'THROUGH')
    .map(([t]) => t)
    .sort();
}

/**
 * Compares the live set of tables WITHOUT an organization_id column with the
 * indirect census. Pure, like `auditOrganizationDependencyCensus`.
 */
export function auditIndirectCensus(liveTablesWithoutOrganizationId: Iterable<string>): CensusReport {
  const live = new Set(liveTablesWithoutOrganizationId);
  const classified = new Set(Object.keys(INDIRECT_DEPENDENCIES));
  return {
    unclassified: [...live].filter((t) => !classified.has(t)).sort(),
    stale: [...classified].filter((t) => !live.has(t)).sort(),
  };
}
