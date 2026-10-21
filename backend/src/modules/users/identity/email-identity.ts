import { raw } from '@mikro-orm/core';

/**
 * ONE DEFINITION OF "THE SAME EMAIL IDENTITY", FOR EVERY PATH THAT ASKS (#291).
 *
 * The question "is this address already taken?" was previously answered in
 * three different alphabets at once: the unique index compared raw bytes, the
 * migration's guards compared `lower(email)`, and the application compared
 * whatever the caller happened to type. Three answers to one question is not a
 * rule, it is a race — `Person@Example.com` and `person@example.com` could
 * become two live identities that every guard believed were one.
 *
 * So the rule is stated once, here, and everything else defers to it:
 *
 *   TWO LIVE USERS MAY NOT HOLD THE SAME ADDRESS, CASE-INSENSITIVELY.
 *
 * Enforced by `users_email_active_unique` — `unique (lower(email)) where
 * removed_at is null` — and mirrored by every application lookup and every
 * write, which canonicalise through the functions below. The migration's
 * preflight and rollback guards compare `lower(email)` for the same reason.
 *
 * WHY CASE-INSENSITIVE AND NOT RAW. The local part of an address is
 * case-sensitive by RFC 5321, but no mail provider anyone signs up with treats
 * it that way, and a login form does not either. Permitting two accounts that
 * differ only in capitalisation would make "who is this person" undecidable
 * exactly where it matters most: password reset, invitation acceptance and
 * removal all resolve a person BY ADDRESS.
 *
 * WHAT IS NOT NORMALISED: nothing beyond case and surrounding whitespace. No
 * dot-stripping, no `+tag` removal, no provider-specific folding — those are
 * guesses about someone else's mail server, and a wrong guess merges two
 * genuinely different people into one identity.
 */

/** The stored and compared form of an address. */
export const canonicalEmail = (email: string): string => email.trim().toLowerCase();

/** Do these two addresses name the same identity under the rule above? */
export const sameEmailIdentity = (a: string, b: string): boolean => canonicalEmail(a) === canonicalEmail(b);

/**
 * The SQL fragment naming the canonical form of the column, for the handful of
 * places that must compare inside the database rather than in TypeScript.
 *
 * A constant so the expression in a lookup cannot drift from the expression the
 * unique index is built on — if they ever disagreed, the lookup would miss a
 * row the index considers a duplicate, which is precisely the failure this
 * whole file exists to make impossible.
 */
export const CANONICAL_EMAIL_SQL = 'lower(email)';

/**
 * The same expression, as an ORM query KEY.
 *
 * `em.findOne(User, { [canonicalEmailKey()]: canonicalEmail(input) })` compares
 * exactly what `users_email_active_unique` is built on, so a lookup can never
 * miss a row the index would call a duplicate. It is a FUNCTION, not a
 * constant, because a raw fragment is consumed the first time it is used —
 * every call site needs its own.
 *
 * The callback form receives the query's alias, so the expression stays correct
 * if the lookup ever grows a join.
 */
export const canonicalEmailKey = () => raw((alias: string) => `lower(${alias}.email)`);
