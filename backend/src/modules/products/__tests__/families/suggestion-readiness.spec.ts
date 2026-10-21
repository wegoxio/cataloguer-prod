import { blockedReasonsFor, SUGGESTION_BLOCKED_REASONS, type SuggestionMemberFacts } from '../../families/suggestion-readiness';

/**
 * The RULE, on its own.
 *
 * The PostgreSQL suite proves the facts are gathered correctly and that the
 * verdict agrees with what `createFamily` actually does. This one pins the
 * rule itself, including the two reasons the name heuristic cannot currently
 * produce — `confidentGroups` enforces a minimum member count and unique
 * labels of its own — so the vocabulary stays complete if that ever changes.
 */
const ok = (over: Partial<SuggestionMemberFacts> = {}): SuggestionMemberFacts => ({
  id: 'a',
  status: 'PUBLISHED',
  hasStore: true,
  hasSpecificationConflict: false,
  label: 'Roja',
  ...over,
});

const pair = (...over: Partial<SuggestionMemberFacts>[]) =>
  over.map((o, i) => ok({ id: `m${i}`, label: `L${i}`, ...o }));

describe('why a suggested family could not be created', () => {
  it('says nothing at all when nothing would refuse it', () => {
    expect(blockedReasonsFor(pair({}, {}))).toEqual([]);
  });

  it('MIXED_PUBLICATION_STATUS when they are not all published or all draft', () => {
    expect(blockedReasonsFor(pair({ status: 'PUBLISHED' }, { status: 'DRAFT' }))).toEqual(['MIXED_PUBLICATION_STATUS']);
    // All-draft is a family that can be created; it is only a MIX that refuses.
    expect(blockedReasonsFor(pair({ status: 'DRAFT' }, { status: 'DRAFT' }))).toEqual([]);
  });

  it('MEMBER_WITHOUT_STORE when one belongs to no shop', () => {
    expect(blockedReasonsFor(pair({}, { hasStore: false }))).toEqual(['MEMBER_WITHOUT_STORE']);
  });

  it('SPECIFICATION_CONFLICT when one holds a value a child may not hold', () => {
    expect(blockedReasonsFor(pair({}, { hasSpecificationConflict: true }))).toEqual(['SPECIFICATION_CONFLICT']);
  });

  describe('DUPLICATE_LABEL', () => {
    it('refuses two members that would show the same option', () => {
      expect(blockedReasonsFor(pair({ label: 'Verde' }, { label: 'Verde' }))).toEqual(['DUPLICATE_LABEL']);
    });

    /** The same comparison `assertLabelFree` makes: a selector cannot tell
     * "Verde" from " verde ". */
    it('compares them trimmed and case-folded', () => {
      expect(blockedReasonsFor(pair({ label: 'Verde' }, { label: ' verde ' }))).toEqual(['DUPLICATE_LABEL']);
    });

    it('refuses an empty label, which shows as nothing at all', () => {
      expect(blockedReasonsFor(pair({ label: 'Verde' }, { label: '  ' }))).toEqual(['DUPLICATE_LABEL']);
    });
  });

  it('TOO_FEW_MEMBERS when there is no family to make', () => {
    expect(blockedReasonsFor(pair({}))).toEqual(['TOO_FEW_MEMBERS']);
    expect(blockedReasonsFor([])).toEqual(['TOO_FEW_MEMBERS']);
  });

  describe('more than one thing wrong', () => {
    it('reports every reason, not the first it found', () => {
      const reasons = blockedReasonsFor(
        pair({ status: 'DRAFT', label: 'Verde' }, { hasStore: false, hasSpecificationConflict: true, label: 'Verde' }),
      );
      expect(reasons).toEqual([
        'MIXED_PUBLICATION_STATUS',
        'MEMBER_WITHOUT_STORE',
        'SPECIFICATION_CONFLICT',
        'DUPLICATE_LABEL',
      ]);
    });

    /**
     * Ordered by the vocabulary rather than by discovery, so the same group
     * always reports the same list and a reader comparing two screens sees the
     * same thing twice.
     */
    it('orders them the same way whatever order the members arrive in', () => {
      const members = pair({ hasStore: false }, { status: 'DRAFT' });
      expect(blockedReasonsFor(members)).toEqual(blockedReasonsFor([...members].reverse()));
    });

    it('never reports a reason twice', () => {
      const reasons = blockedReasonsFor(pair({ hasStore: false }, { hasStore: false }, { hasStore: false }));
      expect(reasons).toEqual(['MEMBER_WITHOUT_STORE']);
    });
  });

  it('says nothing outside the closed vocabulary', () => {
    const everything = blockedReasonsFor([ok({ id: 'only', label: '', hasStore: false, status: 'DRAFT' })]);
    for (const reason of everything) expect(SUGGESTION_BLOCKED_REASONS).toContain(reason);
    expect(SUGGESTION_BLOCKED_REASONS).toHaveLength(5);
  });
});
