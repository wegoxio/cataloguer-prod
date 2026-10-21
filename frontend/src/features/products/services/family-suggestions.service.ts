import { apiFetch } from '../../../lib/api-client';

/**
 * Why a suggested family could not be created right now.
 *
 * A CLOSED VOCABULARY decided by the backend, from the same rules the creation
 * enforces. The interface translates a code; it never parses an exception
 * message and never re-derives the rule for itself.
 */
export type SuggestionBlockedReason =
  | 'MIXED_PUBLICATION_STATUS'
  | 'MEMBER_WITHOUT_STORE'
  | 'SPECIFICATION_CONFLICT'
  | 'DUPLICATE_LABEL'
  | 'TOO_FEW_MEMBERS';

export interface SuggestionMember {
  id: string;
  name: string;
  label: string;
  price?: number;
  /** Present since PR D; absent from an older backend. */
  status?: string;
  hasStore?: boolean;
  hasSpecificationConflict?: boolean;
}

export interface FamilySuggestion {
  name: string;
  members: SuggestionMember[];
  /**
   * ADVISORY. The catalogue can move between reading this and pressing the
   * button, so `POST /products/families` re-checks everything inside its
   * transaction and that answer is the authoritative one.
   *
   * Optional so a dashboard served against an older backend still renders;
   * absent reads as READY, which is exactly how it behaved before.
   */
  readiness?: 'READY' | 'BLOCKED';
  blockedReasons?: SuggestionBlockedReason[];
}

export interface SuggestionListing {
  suggestions: FamilySuggestion[];
  /** Only READY suggestions may be described as waiting to be grouped. */
  readyCount: number;
  blockedCount: number;
}

/** A suggestion with no verdict is treated as ready, as it always was. */
export const isSuggestionReady = (suggestion: FamilySuggestion): boolean =>
  (suggestion.readiness ?? 'READY') === 'READY';

/** Family-suggestion endpoints, so the page never carries raw paths. */
export const familySuggestionsService = {
  async list(token: string): Promise<SuggestionListing> {
    const response = await apiFetch('/products/family-suggestions', { method: 'GET', token });
    const suggestions: FamilySuggestion[] = response?.data ?? [];
    // The counts are siblings of `data`, not a replacement for it: an older
    // client reads `data` and ignores them. Derived here when absent, so this
    // service answers one shape whatever the backend sent.
    return {
      suggestions,
      readyCount: response?.readyCount ?? suggestions.filter(isSuggestionReady).length,
      blockedCount: response?.blockedCount ?? suggestions.filter((s) => !isSuggestionReady(s)).length,
    };
  },

  async createGroup(token: string, suggestion: FamilySuggestion): Promise<void> {
    await apiFetch('/products/families', {
      method: 'POST',
      token,
      body: JSON.stringify({
        name: suggestion.name,
        members: suggestion.members.map((member) => ({ id: member.id, label: member.label })),
      }),
    });
  },

  /** "No" is remembered: this parent name is never suggested again. */
  async dismiss(token: string, name: string): Promise<void> {
    await apiFetch('/products/family-suggestions/dismiss', {
      method: 'POST',
      token,
      body: JSON.stringify({ name }),
    });
  },
};
