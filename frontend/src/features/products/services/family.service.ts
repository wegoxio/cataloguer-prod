import { apiFetch } from '../../../lib/api-client';

/**
 * THE ONE REFUSAL WORTH ASKING AGAIN.
 *
 * `withLockRetry` (backend, `publication-guard.service.ts`) gives an attachment
 * three attempts; when every one was widened or refused its row locks by a
 * concurrent write, it answers 409 with this sentence. Nothing was written,
 * and the same request may well succeed a moment later. The backend attaches
 * NO code to it — the sentence is the contract — so it is told apart from the
 * other 409s by the sentence and by the absence of a code: the lifecycle
 * refusals (`LifecycleConstraintFilter`: a removed record, a merged or
 * archived company) and the specification conflict
 * (`FIELD_APPLICABILITY_CONFLICT`) all carry `body.code`, and asking again
 * changes nothing for any of them.
 */
export const LOCK_RETRY_EXHAUSTED = 'Store membership kept changing while this was being applied';

export function isLockRetryExhaustion(err: unknown): boolean {
  const failure = err as { status?: unknown; message?: unknown; body?: { code?: unknown } | null } | null;
  return (
    failure?.status === 409 &&
    !failure?.body?.code &&
    typeof failure?.message === 'string' &&
    failure.message.startsWith(LOCK_RETRY_EXHAUSTED)
  );
}

export interface FamilyMember {
  id: string;
  name: string;
  label: string | null;
}

/**
 * Family management endpoints (the id is always the parent product), so
 * components never carry raw paths or untyped payloads.
 */
export const familyService = {
  /**
   * Create a NEW parent and attach every member, atomically.
   *
   * The same endpoint the suggestion flow uses. Manual grouping does not need
   * its own contract — it needs the same one, reached deliberately.
   */
  async createFamily(
    token: string,
    name: string,
    // `name` is present only for a child the reader actually renamed; the
    // endpoint reads its absence as "leave this item's name alone".
    members: { id: string; label: string; name?: string }[],
    /**
     * What the CARD says about itself (PR C). Omitted by the grouping journey,
     * which names a card over items that already exist and has nothing else to
     * say about it; supplied by Add Item, where a person is writing the card.
     */
    descriptive: { description?: string; metaTitle?: string; metaDescription?: string } = {},
  ): Promise<{ id: string; name: string; members: number }> {
    const response = await apiFetch('/products/families', {
      method: 'POST',
      token,
      // Only the fields that were actually given: the endpoint now refuses
      // unknown properties, and an explicit `undefined` is not sent by
      // `JSON.stringify` anyway.
      body: JSON.stringify({ name, members, ...descriptive }),
    });
    return response?.data ?? response;
  },

  /**
   * Ask whether a grouping would be accepted, without writing.
   *
   * ADVISORY: the catalogue can move between this answer and the confirmation,
   * so `createFamily` re-checks inside its transaction and that answer is the
   * authoritative one. Returns the problem's message, or null.
   */
  async validateFamily(
    token: string,
    name: string,
    members: { id: string; label: string; name?: string }[],
  ): Promise<string | null> {
    const response = await apiFetch('/products/families/validate', {
      method: 'POST',
      token,
      body: JSON.stringify({ name, members }),
    });
    const verdict = response?.data ?? response;
    return verdict?.ok ? null : (verdict?.problem?.message ?? null);
  },

  async addMember(token: string, parentId: string, productId: string, label: string): Promise<FamilyMember> {
    const response = await apiFetch(`/products/${parentId}/family/members`, {
      method: 'POST',
      token,
      body: JSON.stringify({ productId, label }),
    });
    return response?.data?.member;
  },

  async renameMember(token: string, parentId: string, memberId: string, label: string): Promise<FamilyMember> {
    const response = await apiFetch(`/products/${parentId}/family/members/${memberId}`, {
      method: 'PATCH',
      token,
      body: JSON.stringify({ label }),
    });
    return response?.data?.member;
  },

  async removeMember(token: string, parentId: string, memberId: string): Promise<void> {
    await apiFetch(`/products/${parentId}/family/members/${memberId}`, { method: 'DELETE', token });
  },

  async dissolve(token: string, parentId: string): Promise<number> {
    const response = await apiFetch(`/products/${parentId}/family`, { method: 'DELETE', token });
    return response?.data?.released ?? 0;
  },
};
