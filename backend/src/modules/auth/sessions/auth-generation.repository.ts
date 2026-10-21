import { raw } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { User } from '../../users/entities/user.entity';

/**
 * ADVANCING THE AUTHENTICATION GENERATION — the one write, in one place (#291).
 *
 * Every caller that ends someone's sessions goes through here, so there is a
 * single expression to read, a single expression to review, and a single
 * expression a mutation can attack.
 *
 * COMPUTED BY THE DATABASE, NEVER BY US. `auth_generation + 1` is evaluated
 * inside the writing transaction against the row's current value under whatever
 * lock the caller holds. The alternative — read the number, add one in
 * TypeScript, write it back — loses one of two concurrent revocations, and the
 * revocation it loses is silent: both callers report success and one person's
 * tokens survive. There is no path here that assigns a literal, and none
 * anywhere that assigns a lower value.
 */
export function nextAuthGeneration() {
  return raw('auth_generation + 1');
}

/**
 * Advances one user's generation through the caller's entity manager, so it
 * joins the caller's transaction rather than opening one of its own.
 *
 * An ORDINARY ORM WRITE, which means the removal filter applies to it: a
 * removed identity is not reachable here. That is correct rather than a gap —
 * removal advances the generation itself, inside the transaction that hides the
 * row, and a removed account has no sessions left to end.
 *
 * Returns the number of rows advanced, so a caller that needs to can tell the
 * difference between "ended" and "there was nobody there".
 */
export async function advanceAuthGeneration(em: EntityManager, userId: string): Promise<number> {
  return em.nativeUpdate(User, { id: userId }, { authGeneration: nextAuthGeneration() } as never);
}

/**
 * THE ROW'S GENERATION AS IT IS RIGHT NOW, in either lifecycle state.
 *
 * Read as raw SQL rather than through the ORM precisely because the removal
 * filter must NOT apply: a caller asking "has this account moved on?" needs the
 * answer for a removed account most of all — that is the case where the answer
 * is yes and something is about to be refused. A filtered read would return
 * "no such user" and a caller could mistake that for "nothing changed".
 *
 * Meaningful only under the row lock the writers take; see `lockUsers`.
 */
export async function currentAuthGeneration(em: EntityManager, userId: string): Promise<number | null> {
  const rows = await em.execute<{ auth_generation: number | string }[]>(
    `select auth_generation from users
      where id = ?::uuid /* removed_at: the generation is read in either state, by design */`,
    [userId],
  );
  const value = rows[0]?.auth_generation;
  return value === undefined || value === null ? null : Number(value);
}
