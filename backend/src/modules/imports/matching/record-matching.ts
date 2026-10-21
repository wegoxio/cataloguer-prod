/**
 * Deciding whether an imported row is a NEW record or an existing one.
 *
 * This is the decision that quietly does the most damage when it is wrong: a
 * bad match overwrites a real product, a missed match duplicates the catalogue.
 * So the rule here is that a match must be EXPLAINABLE — every decision carries
 * the evidence that produced it — and that ambiguity is never resolved by
 * picking one.
 *
 * The priority order is not arbitrary. It runs from identifiers that a system
 * assigned and can be trusted to be stable, down to identifiers a human typed
 * and may have reused:
 *
 *  1. PRIOR_SOURCE_IDENTITY — this row already produced a record in an earlier
 *     import of the same document lineage. The strongest possible evidence, and
 *     the only one available for the real WooCommerce export, whose 841 rows
 *     carry no SKU at all.
 *  2. INTERNAL_SKU — ours, unique per organization, case-sensitive.
 *  3. MANUFACTURER_CODE — the SUPPLIER's code. Deliberately not unique, so it
 *     matches only when it resolves to exactly one product.
 *  4. NORMALIZED_IDENTITY — name and category agreeing exactly. A proposal
 *     only; never applied automatically.
 *  5. USER_SELECTED — a person chose. Always available, always wins.
 */

export type MatchProvenance =
  | 'PRIOR_SOURCE_IDENTITY'
  | 'INTERNAL_SKU'
  | 'MANUFACTURER_CODE'
  | 'NORMALIZED_IDENTITY'
  | 'USER_SELECTED';

export type MatchDecision = 'CREATE' | 'UPDATE' | 'SKIP' | 'UNRESOLVED';

export interface CandidateRecord {
  id: string;
  sku: string | null;
  manufacturerCode: string | null;
  name: string;
  categoryKey: string | null;
}

export interface RowIdentity {
  /** Identifier the source system assigned, e.g. a WooCommerce post id. */
  externalId?: string | null;
  sku?: string | null;
  manufacturerCode?: string | null;
  name?: string | null;
  categoryKey?: string | null;
}

export interface MatchLookups {
  /**
   * `(sourceSystem, externalId)` → record id, from previous imports.
   *
   * Only VALID mappings: one whose target has been deleted, or belongs to
   * another company, or is not a product, is not returned here.
   */
  byPriorSourceIdentity(externalId: string): string | null;
  /**
   * A mapping EXISTS for this identifier but its target is no longer a live
   * product of this company.
   *
   * Distinguished from "no mapping" because the two must be answered
   * differently: no mapping falls through to the SKU, a broken one must not.
   * Optional so an existing double is still a valid `MatchLookups`; absent
   * reads as "nothing is known to be broken".
   */
  priorSourceIdentityInvalid?(externalId: string): boolean;
  /** Exact, case-sensitive, organization-scoped. */
  bySku(sku: string): CandidateRecord | null;
  /**
   * All products carrying this manufacturer code. Returning the LIST rather than
   * a record is deliberate: the code is not unique, and the caller must be able
   * to see that two products claim it.
   */
  byManufacturerCode(code: string): CandidateRecord[];
  /** Products whose normalized name (and category, if given) match exactly. */
  byNormalizedIdentity(name: string, categoryKey: string | null): CandidateRecord[];
}

export interface MatchResult {
  decision: MatchDecision;
  targetId: string | null;
  provenance: MatchProvenance | null;
  confidence: number;
  reasons: string[];
  /** Present when the row could be several records and a person must choose. */
  ambiguousCandidates?: { id: string; name: string; sku: string | null }[];
}

/** Trim, collapse whitespace, casefold. Never used to compare SKUs. */
export function normalizeIdentityText(value: string): string {
  return (value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Match one row.
 *
 * `userSelection` short-circuits everything: a person who has looked at the row
 * outranks every heuristic, and recording their choice as USER_SELECTED keeps
 * that visible in the report afterwards.
 */
export function matchRow(
  identity: RowIdentity,
  lookups: MatchLookups,
  options: { userSelection?: string | null; sourceSystem?: string } = {},
): MatchResult {
  const reasons: string[] = [];

  if (options.userSelection) {
    return {
      decision: 'UPDATE',
      targetId: options.userSelection,
      provenance: 'USER_SELECTED',
      confidence: 1,
      reasons: ['a person chose this record for this row'],
    };
  }

  // 1. PRIOR SOURCE IDENTITY, AND IT OUTRANKS EVERYTHING BELOW IT.
  //
  // The identifier is the file's external id when it has one, and otherwise
  // the SKU — the same value the applier records, so what is looked up here is
  // exactly what was written there.
  //
  // Consulting it FIRST is the whole point. A family card gives its SKU up at
  // commit, which frees that string for any other product to take; if the SKU
  // were tried first, a later product reusing it would capture a re-import of
  // the file that has always meant the card, and the run would silently
  // rewrite an unrelated item. The recorded mapping is what the identifier has
  // been agreed to mean in this catalogue, so it wins.
  const external = (identity.externalId ?? '').toString().trim();
  const skuValue = (identity.sku ?? '').toString().trim();
  const recordedKey = external || skuValue;
  if (recordedKey) {
    // A mapping that names something no longer live is NOT the same as no
    // mapping. Falling through to the SKU here would create or modify a
    // different record on the strength of a broken pointer.
    if (lookups.priorSourceIdentityInvalid?.(recordedKey)) {
      return {
        decision: 'UNRESOLVED',
        targetId: null,
        provenance: null,
        confidence: 0,
        reasons: [
          ...reasons,
          `an earlier import recorded "${recordedKey}" against a record that no longer exists in this company`,
        ],
      };
    }
    const priorId = lookups.byPriorSourceIdentity(recordedKey);
    if (priorId) {
      // THE ROW DISAGREEING WITH ITSELF is a different matter. When the file
      // carries BOTH an external id and a separate SKU, and the SKU names a
      // different live product, the two columns are pointing at two records —
      // nobody can say which the row means, and choosing either silently is
      // how an import rewrites the wrong one.
      if (external && skuValue && skuValue !== external) {
        const bySkuCandidate = lookups.bySku(skuValue);
        if (bySkuCandidate && bySkuCandidate.id !== priorId) {
          return {
            decision: 'UNRESOLVED',
            targetId: null,
            provenance: null,
            confidence: 0,
            reasons: [
              ...reasons,
              `this row's identifier "${external}" and its SKU "${skuValue}" name two different products`,
            ],
            ambiguousCandidates: [
              { id: priorId, name: `recorded as "${external}"`, sku: null },
              { id: bySkuCandidate.id, name: bySkuCandidate.name, sku: bySkuCandidate.sku },
            ],
          };
        }
      }
      return {
        decision: 'UPDATE',
        targetId: priorId,
        provenance: 'PRIOR_SOURCE_IDENTITY',
        confidence: 1,
        reasons: [`row ${recordedKey} of this source produced this record in an earlier import`],
      };
    }
    reasons.push(`no earlier import of this source produced a record for ${recordedKey}`);
  }

  // 2. Internal SKU — exact and case-sensitive, because that is how the unique
  //    index behaves; matching case-insensitively here would propose an update
  //    the database would then refuse as a duplicate.
  const sku = (identity.sku ?? '').toString().trim();
  if (sku) {
    const bySku = lookups.bySku(sku);
    if (bySku) {
      return {
        decision: 'UPDATE',
        targetId: bySku.id,
        provenance: 'INTERNAL_SKU',
        confidence: 1,
        reasons: [...reasons, `SKU "${sku}" already exists in this company`],
      };
    }
    reasons.push(`SKU "${sku}" is not in use yet`);
  }

  // 3. Manufacturer code — never unique by design, so it matches only when it
  //    resolves to exactly one product. Two products sharing a supplier code is
  //    a normal, legitimate state, and the row cannot choose between them.
  const code = (identity.manufacturerCode ?? '').toString().trim();
  if (code) {
    const candidates = lookups.byManufacturerCode(code);
    if (candidates.length === 1) {
      return {
        decision: 'UPDATE',
        targetId: candidates[0].id,
        provenance: 'MANUFACTURER_CODE',
        confidence: 0.9,
        reasons: [...reasons, `manufacturer code "${code}" belongs to exactly one product`],
      };
    }
    if (candidates.length > 1) {
      return {
        decision: 'UNRESOLVED',
        targetId: null,
        provenance: null,
        confidence: 0,
        reasons: [
          ...reasons,
          `manufacturer code "${code}" is used by ${candidates.length} products, so it cannot identify one`,
        ],
        ambiguousCandidates: candidates.map((c) => ({ id: c.id, name: c.name, sku: c.sku })),
      };
    }
    reasons.push(`manufacturer code "${code}" is not in use yet`);
  }

  // 4. Normalized identity — a PROPOSAL. Names repeat legitimately (the real
  //    export has six duplicate names), so this never updates on its own.
  const name = (identity.name ?? '').toString().trim();
  if (name) {
    const candidates = lookups.byNormalizedIdentity(normalizeIdentityText(name), identity.categoryKey ?? null);
    if (candidates.length === 1) {
      return {
        decision: 'UNRESOLVED',
        targetId: null,
        provenance: 'NORMALIZED_IDENTITY',
        confidence: 0.5,
        reasons: [
          ...reasons,
          `an existing product has the same name${identity.categoryKey ? ' and category' : ''} — confirm whether this is the same product`,
        ],
        ambiguousCandidates: candidates.map((c) => ({ id: c.id, name: c.name, sku: c.sku })),
      };
    }
    if (candidates.length > 1) {
      return {
        decision: 'UNRESOLVED',
        targetId: null,
        provenance: null,
        confidence: 0,
        reasons: [...reasons, `${candidates.length} existing products share this name, so it cannot identify one`],
        ambiguousCandidates: candidates.map((c) => ({ id: c.id, name: c.name, sku: c.sku })),
      };
    }
  }

  // Nothing matched. Creating is the honest outcome, and the reasons say what
  // was tried so the mapper can see it was not merely a guess.
  if (!external && !sku && !code && !name) {
    return {
      decision: 'UNRESOLVED',
      targetId: null,
      provenance: null,
      confidence: 0,
      reasons: ['the row carries nothing that could identify a product'],
    };
  }

  return {
    decision: 'CREATE',
    targetId: null,
    provenance: null,
    confidence: 0.8,
    reasons: [...reasons, 'nothing existing matches, so this row would create a new product'],
  };
}

/**
 * Duplicates WITHIN one import, which the database cannot catch until it is too
 * late.
 *
 * Two rows carrying the same SKU would have the second silently overwrite the
 * first — or fail halfway through a batch, leaving the import partly applied.
 * Finding them before execution turns a runtime failure into a decision.
 */
export interface InternalDuplicate {
  key: string;
  field: 'sku' | 'externalId' | 'manufacturerCode';
  rows: number[];
}

export function findInternalDuplicates(rows: { rowNumber: number; identity: RowIdentity }[]): InternalDuplicate[] {
  const duplicates: InternalDuplicate[] = [];

  // Manufacturer code is deliberately NOT checked here: repeating it across
  // rows is legitimate, and flagging it would bury the real duplicates.
  for (const field of ['sku', 'externalId'] as const) {
    const seen = new Map<string, number[]>();
    for (const { rowNumber, identity } of rows) {
      const raw = (identity[field] ?? '').toString().trim();
      if (!raw) continue;
      const list = seen.get(raw) ?? [];
      list.push(rowNumber);
      seen.set(raw, list);
    }
    for (const [key, list] of seen) {
      if (list.length > 1) duplicates.push({ key, field, rows: list });
    }
  }

  return duplicates.sort((a, b) => a.rows[0] - b.rows[0]);
}
