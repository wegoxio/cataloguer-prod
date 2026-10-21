/**
 * Whether the decisions behind a plan have actually changed.
 *
 * The wizard used to retract its plan from a `useEffect` keyed on
 * `[state.mapping, state.acknowledged, relationships]` — three object
 * references. React rebuilds those on ordinary re-renders, so the effect fired
 * when nothing about the import had changed at all, and it fired at moments
 * nobody chose: after an approval, between a request and its answer, during a
 * refetch. Each time it discarded the plan, the approval and the single-use
 * proof.
 *
 * Identity was never the question. The question is whether the bytes a plan
 * hash is computed over are different, and that is a value comparison. This
 * module answers it the same way the server does — by canonicalising and
 * comparing — so a re-render is silent and a real edit is not.
 *
 * Key order is normalised because `{a:1,b:2}` and `{b:2,a:1}` describe the same
 * decisions, and a serialiser that disagreed would reintroduce the same bug in
 * a quieter form.
 */

/** A stable string for any JSON-ish value, independent of key insertion order. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalize);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  // Sorted, so two objects describing the same decisions serialise identically.
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    // `undefined` is absence, and absence is not a decision. Dropping it stops
    // an optional field appearing and disappearing from the identity as the
    // editor initialises.
    if (entry === undefined) continue;
    out[key] = normalize(entry);
  }
  return out;
}

/**
 * The decisions a plan is built from, as one comparable string.
 *
 * Exactly the inputs the server hashes into `plan_hash` — the mapping, the
 * acknowledged findings and the relationship decisions. Anything outside this
 * set is not part of the plan's identity and must not retract it.
 */
export function decisionIdentity(input: {
  mapping: unknown;
  acknowledged: unknown;
  relationships: unknown;
}): string {
  return canonicalize({
    mapping: input.mapping,
    acknowledged: input.acknowledged,
    relationships: input.relationships,
  });
}
