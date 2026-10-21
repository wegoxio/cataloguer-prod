import { Entity, ManyToOne, PrimaryKey, Property } from '@mikro-orm/core';
import { Role } from './role.entity';
import { Store } from '../../stores/entities/store.entity';
import { Organization } from '../../organizations/entities/organization.entity';

/**
 * A PERSON'S ACCESS TO THE PRODUCT, AND — FROM #291 — A REMOVABLE ONE.
 *
 * `@Filter(removedFilterDef)` is the whole boundary: it is default-on, so every
 * ordinary `find`, `findOne`, `count`, `findAndCount`, populate and
 * `nativeUpdate`/`nativeDelete` excludes removed identities without a caller
 * writing a predicate. Login, invitations, password reset, email change, team
 * listings, seat counts and selectors are all ordinary reads, and all of them
 * stop seeing a removed user the moment this decorator exists.
 *
 * `deletedAt` (deactivate) is unchanged and still the tenant-reversible state.
 * `removedAt` is the stronger state layered above it: a removed user is absent
 * from the tenant entirely and only an unscoped Superadmin can bring them back.
 */
@Entity({ tableName: 'users' })
export class User {
  @PrimaryKey({ type: 'uuid', defaultRaw: 'gen_random_uuid()' })
  id!: string;

  /**
   * UNIQUE AMONG LIVE IDENTITIES, CASE-INSENSITIVELY — AND ONLY IN THE DATABASE.
   *
   * The plain unique constraint is replaced by `unique (lower(email)) where
   * removed_at is null`, which does two things the old one could not: it frees
   * an address for a new active account once the identity holding it is
   * removed, and it refuses `Person@Example.com` beside `person@example.com`.
   * `email-identity.ts` states that rule once; every lookup and every write
   * canonicalises through it, and the migration's guards compare the same
   * expression.
   *
   * NEITHER HALF IS DECLARED HERE, deliberately. `unique: true` would ask the
   * schema generator to put the total raw constraint back, and `@Index()` would
   * ask it for a plain `users_email_index` that does not exist — the real index
   * is over an EXPRESSION, which this mapping cannot spell. Uniqueness and its
   * supporting index are the migration's, and the entity says so rather than
   * approximating them.
   */
  @Property()
  email!: string;

  // Null until the invited user sets their password via the onboarding link
  @Property({ hidden: true, nullable: true })
  passwordHash?: string | null;

  @Property({ nullable: true })
  firstName?: string;

  @Property({ nullable: true })
  lastName?: string;

  @Property({ nullable: true })
  company?: string;

  @ManyToOne(() => Role)
  role!: Role;

  // Optional store scoping: a bound user only sees/manages this store's
  // catalog in the admin. Null = unscoped (owner/staff see everything).
  /**
   * The company this user belongs to (P0-04). Only a real SUPER_ADMIN may
   * have none — for every other role a missing organization means the user
   * behaves as if global, which is the hole this closes.
   */
  @ManyToOne(() => Organization, { nullable: true })
  organization?: Organization | null;

  /**
   * The branch this user is pinned to. Only meaningful for branch-level roles;
   * an ORGANIZATION_MANAGER spans its company's branches and leaves this null.
   */
  @ManyToOne(() => Store, { nullable: true })
  store?: Store | null;

  // When the user accepted the Terms of Service (welcome flow checkbox)
  @Property({ nullable: true })
  termsAcceptedAt?: Date;

  // Two-factor auth: pending secret while enrolling, AES-encrypted
  // active secret once enabled, hashed one-time recovery codes
  @Property({ hidden: true, nullable: true })
  mfaPendingSecret?: string;

  @Property({ nullable: true })
  mfaPendingExpiresAt?: Date;

  @Property({ hidden: true, nullable: true, type: 'text' })
  mfaSecretEnc?: string;

  @Property({ nullable: true })
  mfaEnabledAt?: Date;

  @Property({ hidden: true, nullable: true, type: 'json' })
  mfaRecoveryCodes?: string[];

  // Brute-force protection: counted on failure, cleared on success
  @Property({ default: 0 })
  failedLoginAttempts?: number;

  @Property({ nullable: true })
  lockedUntil?: Date;

  // Pending login-email change: applied only when the confirmation link
  // sent to the NEW address is clicked (AuthService.confirmEmailChange)
  @Property({ nullable: true })
  pendingEmail?: string;

  @Property({ hidden: true, nullable: true })
  emailChangeTokenHash?: string;

  @Property({ nullable: true })
  emailChangeExpiresAt?: Date;

  @Property()
  createdAt?: Date = new Date();

  @Property({ onUpdate: () => new Date() })
  updatedAt?: Date = new Date();

  @Property({ nullable: true })
  deletedAt?: Date;

  /** Internal lifecycle marker; no recovery surface is exposed. */
  @Property({ type: 'timestamptz', nullable: true })
  removedAt?: Date | null;

  /**
   * THE POINT EVERY OUTSTANDING ACCESS TOKEN IS MEASURED AGAINST.
   *
   * A refresh token is a row, so revoking it is a write. An access token is not
   * — it is a signed statement the server never stored, valid for its fifteen
   * minutes against nothing but its own signature. So "we revoked their
   * sessions" was, for those fifteen minutes, false: a removed person's tab
   * kept working, and restoring them inside the window handed their old token
   * back its meaning.
   *
   * This integer closes that. It is stamped into every access token at issue
   * and compared on every authenticated request; advancing it makes every token
   * minted before the advance permanently unusable, whatever happens to the
   * account afterwards. Removal advances it in the same transaction that hides
   * the row, and restoration DOES NOT ROLL IT BACK — that is the whole point,
   * and there is no code path anywhere that lowers it.
   *
   * MONOTONIC BY CONSTRUCTION: every write is `auth_generation + 1` computed by
   * the database inside the writing transaction, never a value read, held and
   * put back — two concurrent revocations must both count.
   */
  @Property({ type: 'int', default: 1 })
  authGeneration?: number;

  // ── the removal lifecycle (#291, columns defined by Slice A) ──────────────
  //
  // Written only by the removal/restoration service, under the organization
  // access lock, the user row lock and the lifecycle lock. Nothing else in the
  // codebase sets them.



  /** The remover's email AS RECORDED AT THE TIME. Never rewritten. */


  /**
   * WHAT REMOVAL RELEASED, so restoration can re-check it — and NOTHING ELSE.
   *
   * An address another account may now hold; a relation explicitly detached.
   * Facts a restoration has to revalidate against today's world.
   *
   * NO CREDENTIAL MATERIAL EVER REACHES THIS COLUMN. It briefly did: removal
   * cleared the MFA columns and parked the secret and the recovery codes here
   * so restoration could put them back. That is a SUSPENSION, not a revocation
   * — the authenticator seed and every unused recovery code stayed valid and
   * came back the moment someone was restored, and they had by then survived in
   * a JSON column for however long the removal lasted. Removal now destroys
   * them, restoration leaves two-factor authentication off, and the person
   * enrols again. A census test reads this column and fails on anything that
   * looks like a secret.
   *
   * Never returned to a tenant, never written to the audit trail.
   */
}
