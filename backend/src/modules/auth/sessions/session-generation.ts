/**
 * THE AUTHENTICATION GENERATION, STATED ONCE FOR THE SIGNER AND THE GUARD (#291).
 *
 * A refresh token is a row: revoking it is a write, and the next renewal fails.
 * An access token is not a row. It is a signed sentence the server never kept a
 * copy of, and for its fifteen minutes it is checked against nothing but its
 * own signature and expiry. Everything built on "we revoked their sessions"
 * therefore had a fifteen-minute hole in it — removal, password change, reset,
 * email change and theft detection alike — and for removal the hole was worse
 * than a delay: restoring someone inside the window did not merely fail to stop
 * their old token, it handed the token back its meaning.
 *
 * So every access token carries the generation its subject had when it was
 * minted, and every authenticated request compares that number with the
 * subject's CURRENT generation. Advancing the number is what ends a session,
 * and nothing lowers it.
 *
 * THE COMPATIBILITY RULE FOR TOKENS THAT PREDATE THE CLAIM IS: REFUSE THEM.
 *
 * A token minted by the previous revision carries no `gen`, and there is no
 * honest way to compare it — "assume generation 1" would revive exactly the
 * tokens this exists to kill, because a person removed by the new revision has
 * generation 2 while their pre-deployment token would claim 1 and be accepted
 * for the rest of its life if `undefined` were treated as "not stale". The
 * refusal costs one silent refresh: the browser still holds its refresh cookie,
 * which is untouched by the deployment, so the next call renews and the person
 * sees nothing. That is the entire migration cost, and it is paid once.
 *
 * The same rule incidentally closes a second hole. The MFA challenge token is
 * signed with the access secret and carries a `sub`, so before this it would
 * have passed the guard as if it were an access token — half a login accepted
 * as a whole one. It carries no `gen`, so now it does not.
 */

/** The claim carrying the generation. Short, because it rides on every request. */
export const AUTH_GENERATION_CLAIM = 'gen';

/** The generation every row starts at, matching the column default. */
export const INITIAL_AUTH_GENERATION = 1;

/** What a verified access token says about its subject's generation. */
export interface GenerationClaims {
  [AUTH_GENERATION_CLAIM]?: unknown;
}

/**
 * IS THIS TOKEN STILL SPEAKING FOR THIS ACCOUNT?
 *
 * The single comparison the whole boundary rests on. Both sides must be real
 * integers and they must be equal — not "at least", not "unless missing".
 * A token from a LATER generation than the row is refused too: it cannot
 * legitimately exist, and treating it as good would mean trusting a claim over
 * the record it describes.
 */
export function tokenGenerationIsCurrent(claims: GenerationClaims | null | undefined, current: unknown): boolean {
  const claimed = claims?.[AUTH_GENERATION_CLAIM];
  if (!Number.isInteger(claimed) || !Number.isInteger(current)) return false;
  return claimed === current;
}

/** The generation to stamp into a token being minted for this row. */
export function authGenerationOf(user: { authGeneration?: number | null } | null | undefined): number {
  const value = user?.authGeneration;
  return Number.isInteger(value) ? (value as number) : INITIAL_AUTH_GENERATION;
}
