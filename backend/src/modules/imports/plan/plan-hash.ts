import { createHash } from 'crypto';

/**
 * The hash a person's approval is bound to.
 *
 * An approval means "I read this and it is correct". For that to survive being
 * stored and replayed later, the hash has to cover everything the reviewer
 * actually relied on — not just the rows, but the source bytes, the parser that
 * read them, the ranges chosen, the mappings, the transformations, the manual
 * decisions and the target state assumed. Leave any of those out and a plan can
 * change underneath an approval while still hashing the same, which is the one
 * failure this whole mechanism exists to prevent.
 *
 * Canonicalization matters as much as coverage. JSON.stringify emits object keys
 * in insertion order, so two identical plans built by different code paths would
 * hash differently and a re-derivation would look like tampering. Keys are
 * sorted recursively and every scalar is compared as text — the same rule the
 * immutable container specifications use, and for the same reason: a fingerprint that
 * cannot match its own round trip is worse than none.
 *
 * ## Every field is required, and that is load-bearing
 *
 * This function was correct and its caller was not. `createPlan` passed an
 * object shaped `{ sourceHash, importType, mapping, relationships, storeId,
 * acknowledged }` and wrote `as never` to make it compile. Two of those names
 * are read by nothing here, and six of the names that ARE read arrived
 * `undefined` and canonicalised to `null`. The hash covered four things —
 * source bytes, import type, store and mapping — for months.
 *
 * What that cost: two plans differing only in their relationship decisions
 * hashed identically, so the second silently resolved to the first through
 * `import_plans_org_plan_hash_unique`. A person who changed the stock
 * destination and re-prepared got the OLD plan, with the OLD destination, under
 * a screen reading "These exact decisions were already prepared."
 *
 * So: no optional fields, no `unknown` where a shape is known, and
 * `assertComplete` refuses an `undefined` at runtime. A caller that cannot say
 * what one of these is must not be hashing a plan. The type is the first line
 * and the assertion is the second, because a cast defeats the first — as one
 * did.
 */

/**
 * The manual decisions a plan records, exactly as they are stored.
 *
 * Typed rather than `unknown` because these are the fields that were missing.
 * `relationships` is the custody, listing and category answers; `acknowledged`
 * is the warning codes somebody accepted. Both are things a reviewer relied on,
 * and neither was in the hash.
 */
export interface PlanDecisions {
  relationships: Record<string, unknown>;
  /** Sorted, so the same set of acknowledgements cannot hash two ways. */
  acknowledged: string[];
}

export interface PlanInputs {
  organizationId: string;
  storeId: string | null;
  importType: string;
  salesInventoryMode: string | null;
  /** SHA-256 of the uploaded bytes. */
  sourceHash: string;
  parserVersion: string;
  analyzerVersion: string;
  /** Selected sheets/tables/ranges. */
  selection: Record<string, unknown>;
  /** Column→field mapping and declarative transformations. */
  mapping: Record<string, unknown>;
  /** The manual decisions, and their provenance. */
  decisions: PlanDecisions;
  /** What the plan assumed about existing records. */
  targetAssumptions: Record<string, unknown>;
  /**
   * The proposed mutation set, where one exists yet.
   *
   * Explicitly nullable, and null at plan creation: the mutation set is
   * compiled by the runner from the source bytes, the mapping and the
   * decisions, all three of which this hash already covers. Nullable is
   * different from absent — absent is what the broken call site was.
   */
  mutations: Record<string, unknown> | unknown[] | null;
}

/** Fields for which `undefined` is never a legitimate answer. */
const REQUIRED_KEYS: (keyof PlanInputs)[] = [
  'organizationId',
  'storeId',
  'importType',
  'salesInventoryMode',
  'sourceHash',
  'parserVersion',
  'analyzerVersion',
  'selection',
  'mapping',
  'decisions',
  'targetAssumptions',
  'mutations',
];

/**
 * Refuse to hash an incomplete plan.
 *
 * `null` passes — `storeId`, `salesInventoryMode` and `mutations` are honestly
 * null much of the time. `undefined` does not: it means the caller never
 * supplied the field, and canonicalisation would turn that silence into the
 * same `null` a deliberate answer produces. Throwing is right because there is
 * no safe fallback — a hash computed over a field nobody supplied is a hash
 * that attests to less than it claims.
 */
function assertComplete(inputs: PlanInputs): void {
  const missing = REQUIRED_KEYS.filter((key) => inputs[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Cannot hash a plan without ${missing.join(', ')}. Every input a reviewer relies on must be given.`,
    );
  }
}

/** Recursively sort keys and stringify scalars, so equal plans hash equally. */
export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.keys(source)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize(source[key]);
        return acc;
      }, {});
  }
  // Numbers and booleans become text so 1 and "1" cannot hash differently after
  // a round trip through JSON columns, which is where these plans live.
  return String(value);
}

export function hashPlan(inputs: PlanInputs): string {
  assertComplete(inputs);
  const canonical = canonicalize({
    organizationId: inputs.organizationId,
    storeId: inputs.storeId,
    importType: inputs.importType,
    salesInventoryMode: inputs.salesInventoryMode,
    sourceHash: inputs.sourceHash,
    parserVersion: inputs.parserVersion,
    analyzerVersion: inputs.analyzerVersion,
    selection: inputs.selection,
    mapping: inputs.mapping,
    decisions: inputs.decisions,
    targetAssumptions: inputs.targetAssumptions,
    mutations: inputs.mutations,
  });
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Digest of one execution batch's intended mutations.
 *
 * Recorded on the checkpoint so a resumed worker can prove the batch already
 * committed is the same work the current plan describes, rather than assuming
 * batch 7 means the same thing it did an hour ago.
 */
export function hashBatch(planHash: string, batchIndex: number, mutations: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ planHash, batchIndex, mutations })))
    .digest('hex');
}

/**
 * Fingerprint of a source's shape, for detecting template drift.
 *
 * Only the ordered header names and their inferred types — deliberately not the
 * values, because the same monthly export legitimately carries different data
 * every month and re-confirming a template each time would train people to
 * click through the one screen that is supposed to catch a real change.
 */
export function fingerprintSourceShape(headers: string[], types: string[]): string {
  const shape = headers.map((h, i) => ({
    header: (h || '').trim().toLowerCase(),
    type: types[i] ?? 'UNKNOWN',
  }));
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(shape)))
    .digest('hex');
}

export interface ShapeDrift {
  drifted: boolean;
  added: string[];
  removed: string[];
  reordered: boolean;
  retyped: { header: string; was: string; now: string }[];
}

/**
 * Say WHAT changed, not merely that something did.
 *
 * A template that refuses to apply without explaining why is a dead end; the
 * editor needs to show which columns appeared, vanished, moved or changed type
 * so the person can decide whether the template is still meaningful.
 */
export function describeShapeDrift(
  templateHeaders: string[],
  templateTypes: string[],
  sourceHeaders: string[],
  sourceTypes: string[],
): ShapeDrift {
  const norm = (h: string) => (h || '').trim().toLowerCase();
  const was = templateHeaders.map(norm);
  const now = sourceHeaders.map(norm);

  const added = now.filter((h) => h && !was.includes(h));
  const removed = was.filter((h) => h && !now.includes(h));

  const common = was.filter((h) => h && now.includes(h));
  const reordered = common.some((h) => was.indexOf(h) !== now.indexOf(h));

  const retyped: ShapeDrift['retyped'] = [];
  for (const header of common) {
    const before = templateTypes[was.indexOf(header)] ?? 'UNKNOWN';
    const after = sourceTypes[now.indexOf(header)] ?? 'UNKNOWN';
    if (before !== after) retyped.push({ header, was: before, now: after });
  }

  return {
    drifted: added.length > 0 || removed.length > 0 || reordered || retyped.length > 0,
    added,
    removed,
    reordered,
    retyped,
  };
}
