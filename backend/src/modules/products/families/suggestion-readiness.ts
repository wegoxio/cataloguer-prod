/**
 * Whether a suggested family could actually be created right now.
 *
 * A suggestion is a NAME-SHAPED guess: `confidentGroups` reads the catalogue's
 * product names and proposes items that look like one product in several
 * options. It knows nothing about publication status, shops, or specification
 * values — and every one of those can refuse the creation it proposes. Before
 * this, the only way to find out was to press the button and read a red toast.
 *
 * So readiness is computed HERE, from the same conditions
 * `assertFamilyCreatable` enforces, and reported as stable CODES. The interface
 * translates a code; it never parses an exception message, and it never decides
 * a business rule for itself.
 *
 * ADVISORY, and deliberately so. It is read without writing anything, and the
 * catalogue can move between reading it and pressing the button — so the final
 * answer is still the creation's own transaction, which repeats every check
 * under its locks. READY here means "nothing known would refuse this", never
 * "this will succeed".
 */

/** The closed vocabulary. Anything not in this list is not a reason. */
export type SuggestionBlockedReason =
  /** The members are not all published or all draft. */
  | 'MIXED_PUBLICATION_STATUS'
  /** At least one member belongs to no shop, so it cannot become a child. */
  | 'MEMBER_WITHOUT_STORE'
  /** A member holds a specification value that a child may not hold. */
  | 'SPECIFICATION_CONFLICT'
  /** Two members would show the same option in the selector. */
  | 'DUPLICATE_LABEL'
  /** Fewer than two members survive, so there is no family to make. */
  | 'TOO_FEW_MEMBERS';

export const SUGGESTION_BLOCKED_REASONS: readonly SuggestionBlockedReason[] = [
  'MIXED_PUBLICATION_STATUS',
  'MEMBER_WITHOUT_STORE',
  'SPECIFICATION_CONFLICT',
  'DUPLICATE_LABEL',
  'TOO_FEW_MEMBERS',
] as const;

export interface SuggestionMemberFacts {
  id: string;
  status: string;
  /** Belongs to at least one shop. `assertEligibleAsChild` requires it. */
  hasStore: boolean;
  /** Holds a value a child may not hold (PARENT-only, or BOTH with no override). */
  hasSpecificationConflict: boolean;
  label: string;
}

/**
 * Every reason this group could not be created, in the closed vocabulary.
 *
 * Ordered deterministically by the vocabulary itself rather than by discovery,
 * so the same group always reports the same list and a reader comparing two
 * screens sees the same thing twice.
 */
export function blockedReasonsFor(members: SuggestionMemberFacts[]): SuggestionBlockedReason[] {
  const found = new Set<SuggestionBlockedReason>();

  if (members.length < 2) found.add('TOO_FEW_MEMBERS');
  if (new Set(members.map((m) => m.status)).size > 1) found.add('MIXED_PUBLICATION_STATUS');
  if (members.some((m) => !m.hasStore)) found.add('MEMBER_WITHOUT_STORE');
  if (members.some((m) => m.hasSpecificationConflict)) found.add('SPECIFICATION_CONFLICT');

  // The same comparison `assertLabelFree` makes: trimmed and case-folded,
  // because a selector cannot tell "Verde" from "verde".
  const labels = members.map((m) => (m.label ?? '').trim().toLowerCase());
  if (labels.some((l) => l === '') || new Set(labels).size !== labels.length) found.add('DUPLICATE_LABEL');

  return SUGGESTION_BLOCKED_REASONS.filter((reason) => found.has(reason));
}
