import { canActOnAllowedStore, effectiveStoreId } from './permissions';
import type { SessionScope } from './permissions';

/**
 * WHICH BRANCH A NEW INVOICE OR A MANUAL SALE IS FOR (#295 G1 acceptance).
 *
 * Both forms used to decide with `!locked && selectable.length > 1`: the picker
 * appeared only for two or more branches, and the request carried whatever the
 * picker held. A company-wide actor with exactly ONE live branch therefore saw
 * no picker, selected nothing, and the server answered "A target storeId is
 * required for this operation". This is the one decision both forms now share.
 *
 *   locked    a branch-bound actor: its own branch, nothing to choose
 *   loading   the branch list has not arrived: nothing may be submitted yet
 *   none      zero eligible branches: a truthful blocked state, no request
 *   single    exactly one eligible branch: it is the target, chosen for you
 *   choose    several eligible branches: an explicit choice is required
 *
 * Eligible means live (neither archived nor removed) AND inside the resolved
 * scope. A selection that is still eligible is preserved (an order-prefilled
 * branch, an edit, a previous choice); one that stopped being eligible — the
 * list reloaded and the branch was archived, removed or left the scope — is
 * dropped, and the form is blocked until a valid branch is chosen. The server
 * stays authoritative: it re-validates whatever is sent.
 */
export type BranchTargetState = 'locked' | 'loading' | 'none' | 'single' | 'choose';

export interface BranchLike {
  id: string;
  name: string;
  archivedAt?: string | null;
  removedAt?: string | null;
}

export interface BranchTarget<T extends BranchLike = BranchLike> {
  state: BranchTargetState;
  /** The branch the request will name, or null when nothing may be submitted. */
  storeId: string | null;
  /** The branches offered for an explicit choice (live and in scope). */
  options: T[];
  /** Show the branch picker (only when there is a real choice to make). */
  showPicker: boolean;
  /** The branch that was resolved without a choice, for a read-only label. */
  resolvedName: string | null;
  /** A selection was held that is no longer eligible: it is dropped and an explicit choice is required. */
  invalidated: boolean;
}

export function resolveBranchTarget<T extends BranchLike>(input: {
  scope: SessionScope | null | undefined;
  legacyStoreId?: string | null;
  stores: T[];
  loaded: boolean;
  selected?: string | null;
}): BranchTarget<T> {
  const { scope, legacyStoreId, stores, loaded } = input;
  const selected = typeof input.selected === 'string' && input.selected.length > 0 ? input.selected : null;
  const locked = effectiveStoreId(scope ?? null, legacyStoreId ?? null);
  if (locked) {
    const own = stores.find((store) => store.id === locked);
    return { state: 'locked', storeId: locked, options: [], showPicker: false, resolvedName: own?.name ?? null, invalidated: false };
  }
  if (!loaded) {
    return { state: 'loading', storeId: null, options: [], showPicker: false, resolvedName: null, invalidated: false };
  }
  const options = stores.filter(
    (store) => !store.archivedAt && !store.removedAt && canActOnAllowedStore(scope ?? null, store.id),
  );
  if (options.length === 0) {
    return { state: 'none', storeId: null, options, showPicker: false, resolvedName: null, invalidated: selected !== null };
  }
  const invalidated = selected !== null && !options.some((store) => store.id === selected);
  // A selection that stopped being eligible is never silently replaced — not
  // even by the only remaining branch, which would re-home an order-prefilled
  // invoice to a different branch. The actor chooses again.
  if (invalidated) {
    return { state: 'choose', storeId: null, options, showPicker: true, resolvedName: null, invalidated: true };
  }
  if (options.length === 1) {
    return { state: 'single', storeId: options[0].id, options, showPicker: false, resolvedName: options[0].name, invalidated: false };
  }
  return { state: 'choose', storeId: selected, options, showPicker: true, resolvedName: null, invalidated: false };
}
