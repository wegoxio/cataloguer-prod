import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { UsersService } from '../users/users.service';
import { User } from '../users/entities/user.entity';
import { userBindingError } from '../users/authorization/role-levels';
import {
  assertMemberOrganizationActive,
  organizationIdOfMember,
  organizationIsInactive,
  readMemberOrganizationLifecycle,
} from '../organizations/lifecycle/organization-archived';
import { reloadMemberInTransaction, withMemberLockedForIssuance } from '../users/access/credential-issuance';
import { RefreshToken } from './entities/refresh-token.entity';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import { MailService } from '../mail/mail.service';
import * as argon2 from 'argon2';
import { decryptSecret, encryptSecret, generateSecret, otpauthUrl, verifyTotp } from './mfa/totp';
import { EntityManager } from '@mikro-orm/postgresql';
import { canonicalEmail, sameEmailIdentity } from '../users/identity/email-identity';
import { lockOrganizationAccess, lockUsers } from '../users/access/access-locks';
import {
  AUTH_GENERATION_CLAIM,
  authGenerationOf,
  GenerationClaims,
  INITIAL_AUTH_GENERATION,
} from './sessions/session-generation';
import { advanceAuthGeneration, currentAuthGeneration, nextAuthGeneration } from './sessions/auth-generation.repository';

/**
 * A refresh token that passed validation, WITH the generation it passed under.
 *
 * The number travels with the row because the rotation that follows must be
 * checked against the generation this request was authorised under — not
 * against whatever the account says by the time the replacement is written.
 * Those differ exactly when it matters.
 */
export interface ValidatedRefreshToken {
  stored: RefreshToken;
  generation: number;
}

const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches JWT expiry

@Injectable()
export class AuthService {
  constructor(
    private readonly usersService: UsersService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    @InjectRepository(RefreshToken)
    private readonly refreshTokenRepository: EntityRepository<RefreshToken>,
    @InjectRepository(PasswordResetToken)
    private readonly resetTokenRepository: EntityRepository<PasswordResetToken>,
    private readonly mailService: MailService,
  ) {}

  async validateUser(email: string, pass: string): Promise<User> {
    const user = await this.usersService.findByEmail(email);
    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new UnauthorizedException('Too many failed attempts — try again in a few minutes');
    }

    if (!user.passwordHash) {
      throw new UnauthorizedException('Your account is not set up yet — use the invitation link from your email');
    }

    const isMatch = await argon2.verify(user.passwordHash, pass);
    const em = this.refreshTokenRepository.getEntityManager();
    if (!isMatch) {
      // 5 strikes lock the account for 15 minutes
      user.failedLoginAttempts = (user.failedLoginAttempts ?? 0) + 1;
      if (user.failedLoginAttempts >= 5) {
        user.lockedUntil = new Date(Date.now() + 15 * 60 * 1000);
        user.failedLoginAttempts = 0;
      }
      await em.flush();
      throw new UnauthorizedException('Invalid email or password');
    }

    if ((user.failedLoginAttempts ?? 0) > 0 || user.lockedUntil) {
      user.failedLoginAttempts = 0;
      user.lockedUntil = undefined;
      await em.flush();
    }

    // #156 fail closed: an invalid persisted binding must not receive tokens.
    // Deliberately AFTER credential verification, so an attacker without the
    // password learns nothing about any account's configuration.
    await this.assertBindingsAllowSession(user);

    return user;
  }

  /**
   * The authentication-time half of the #156 invariant: users whose persisted
   * role/organization/store bindings are invalid (or point at an archived
   * store) cannot obtain or renew a session. The reason is evaluated by the
   * shared pure rules and never leaked to the caller.
   */
  private async assertBindingsAllowSession(user: User): Promise<void> {
    if (userBindingError(user)) {
      throw new UnauthorizedException('Your account access is not configured correctly — contact your administrator');
    }
    // #294: the company's lifecycle is read from the member's STORED binding,
    // never from the populated relation — a removed company is filtered out of
    // that relation and a null there must not read as "no company to refuse".
    await assertMemberOrganizationActive(this.refreshTokenRepository.getEntityManager() as EntityManager, user.id);
  }

  async generateAccessToken(user: User, generation: number = authGenerationOf(user)): Promise<string> {
    // storeId rides in the token so read-only guards can scope without a DB hit
    //
    // `gen` is the revocation point (#291): the generation this account had at
    // the instant the token was minted. `JwtAuthGuard` compares it with the
    // row's current value on every request, so advancing the row's generation
    // — which removal, password change, reset, email change and theft
    // detection all do — kills every token already in the wild rather than
    // waiting fifteen minutes for them to expire on their own.
    const payload = {
      email: user.email,
      sub: user.id,
      role: user.role.name,
      storeId: user.store?.id ?? null,
      [AUTH_GENERATION_CLAIM]: generation,
    };
    return this.jwtService.signAsync(payload, {
      secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      expiresIn: '15m',
    });
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * ISSUES A REFRESH TOKEN, BOUND TO THE GENERATION IT WAS AUTHORISED UNDER.
   *
   * The caller has already decided this person may have a session — by
   * checking a password, or by validating the refresh token being rotated —
   * and that decision was made against a generation. This re-reads the
   * generation UNDER THE USER ROW LOCK and refuses if it has moved since.
   *
   * WITHOUT THAT, TWO WRITERS PRODUCE A LIVE TOKEN OUT OF A REMOVED ACCOUNT.
   * The ordering is not exotic: a refresh (or a login) validates while the
   * person is live; a removal then takes the lock, revokes every refresh row it
   * can see and advances the generation; the first request resumes and inserts
   * its replacement row AFTER the revocation statement ran. The row is
   * unrevoked and belongs to nobody's revocation sweep. Its access token is
   * stale and refused — but restore the account and that refresh row is a
   * working key to a current-generation session.
   *
   * Taking the same lock the removal takes makes the two orderings the only
   * ones possible, and both are safe: rotate-then-remove leaves a replacement
   * the removal revokes on its way past, and remove-then-rotate finds the
   * generation moved and issues nothing at all.
   *
   * The generation also rides IN the token, so a row that somehow outlives its
   * revocation is still refused by `validateRefreshToken`. Two independent
   * reasons, because one of them is a lock and locks are only as good as the
   * next person who remembers to take them.
   */
  async issueRefreshToken(
    user: User,
    meta?: { ip?: string; userAgent?: string },
    expectedGeneration: number = authGenerationOf(user),
  ): Promise<{ token: string; id: string; generation: number }> {
    const em = this.refreshTokenRepository.getEntityManager() as EntityManager;
    return em.transactional(async (tem) => {
      await lockUsers(tem, [user.id]);
      const generation = await currentAuthGeneration(tem, user.id);
      if (generation === null || generation !== expectedGeneration) {
        // The account moved on between the authorisation and this write. It may
        // have been removed, or had its password changed, or been signed out
        // everywhere; from here they are the same event, and all of them mean
        // "the permission this token would have been issued under is gone".
        throw new UnauthorizedException('Your session has ended — sign in again');
      }

      // Opportunistic cleanup: expired rows (revoked or not) are dead weight
      await tem.nativeDelete(RefreshToken, { user: user.id, expiresAt: { $lt: new Date() } });

      const id = randomUUID();
      const token = await this.jwtService.signAsync(
        { sub: user.id, jti: id, [AUTH_GENERATION_CLAIM]: generation },
        {
          secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
          expiresIn: '7d',
        },
      );

      const entry = tem.create(RefreshToken, {
        id,
        user: tem.getReference(User, user.id),
        tokenHash: this.hashToken(token),
        ip: meta?.ip?.slice(0, 60),
        userAgent: meta?.userAgent?.slice(0, 250),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        createdAt: new Date(),
      } as never);
      await tem.persistAndFlush(entry);

      return { token, id, generation };
    });
  }

  /**
   * Validates a presented refresh token against both its signature and
   * its server-side record. Presenting a revoked (already rotated)
   * token is treated as theft: every active session of that user is
   * revoked.
   */
  async validateRefreshToken(token: string): Promise<ValidatedRefreshToken> {
    let payload: { sub: string; jti?: string } & GenerationClaims;
    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch (err) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    const stored = payload.jti
      ? await this.refreshTokenRepository.findOne(
          { id: payload.jti },
          { populate: ['user.role', 'user.store', 'user.store.organization', 'user.organization'] as never },
        )
      : null;

    if (!stored || stored.tokenHash !== this.hashToken(token) || stored.user.deletedAt) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    /**
     * THE GENERATION IS CHECKED BEFORE THE REUSE RESPONSE, and the order is a
     * decision rather than an accident.
     *
     * A token from an older generation is not evidence of theft — it is simply
     * dead, and every account that has ever changed its password has some. If
     * that fired the theft response, anyone holding an old token could advance
     * the victim's generation at will and sign them out of their live session
     * over and over. So a stale generation is refused quietly, and only a token
     * of the CURRENT generation being replayed after revocation is treated as
     * reuse.
     */
    const generation = this.refreshGenerationOf(payload, stored.user);

    if (stored.revokedAt) {
      await this.revokeAllForUser(stored.user.id);
      throw new UnauthorizedException('Refresh token reuse detected');
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }

    // #156: a session must not outlive its bindings — renewal re-validates
    // them, so corrupting a user mid-session cuts the refresh chain.
    await this.assertBindingsAllowSession(stored.user);

    return { stored, generation };
  }

  /**
   * WHICH GENERATION THIS REFRESH TOKEN SPEAKS FOR, or a refusal.
   *
   * A token minted by this revision carries the number and must match exactly.
   *
   * THE COMPATIBILITY RULE FOR TOKENS MINTED BEFORE THE CLAIM EXISTED is
   * narrower than the one for access tokens, because a refresh token lives for
   * seven days rather than fifteen minutes and refusing every one of them would
   * sign out the entire platform on deployment. So a claimless token is
   * accepted ONLY while the account is still at its initial generation — which
   * is to say, only while nothing has happened that was supposed to end its
   * sessions. The moment anything advances the generation, every claimless
   * token for that account is dead, which is exactly the population the
   * deployment is there to protect. Its replacement carries the number
   * explicitly, so each account pays this at most once.
   */
  private refreshGenerationOf(claims: GenerationClaims, user: User): number {
    const claimed = claims?.[AUTH_GENERATION_CLAIM];
    const current = authGenerationOf(user);
    if (Number.isInteger(claimed)) {
      if (claimed !== current) {
        throw new UnauthorizedException('Your session has ended — sign in again');
      }
      return current;
    }
    if (current !== INITIAL_AUTH_GENERATION) {
      throw new UnauthorizedException('Your session has ended — sign in again');
    }
    return current;
  }

  /**
   * Issues a replacement token and revokes the presented one (manual
   * 5.3: new refresh token on every renewal).
   *
   * The replacement is minted against the generation this request VALIDATED,
   * not against whatever the row says by the time the write happens — see
   * `issueRefreshToken`, which re-reads under the lock and refuses if the two
   * disagree. Passing the validated number is what makes that comparison mean
   * anything: re-reading it here would compare the row against itself.
   */
  async rotateRefreshToken(
    validated: ValidatedRefreshToken,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<{ token: string; generation: number }> {
    const { stored, generation } = validated;
    const issued = await this.issueRefreshToken(
      stored.user,
      meta ?? { ip: stored.ip, userAgent: stored.userAgent },
      generation,
    );

    stored.revokedAt = new Date();
    stored.replacedById = issued.id;
    await this.refreshTokenRepository.getEntityManager().flush();

    return { token: issued.token, generation: issued.generation };
  }

  /**
   * Best-effort revocation for logout: never throws, the cookie is
   * cleared regardless.
   */
  async revokeRefreshToken(token: string): Promise<void> {
    try {
      const payload = await this.jwtService.verifyAsync<{ jti?: string }>(token, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
      if (!payload.jti) return;

      const stored = await this.refreshTokenRepository.findOne({ id: payload.jti });
      if (stored && !stored.revokedAt && stored.tokenHash === this.hashToken(token)) {
        stored.revokedAt = new Date();
        await this.refreshTokenRepository.getEntityManager().flush();
      }
    } catch (err) {
      // Invalid/expired token on logout is not an error
    }
  }

  /**
   * Self-service password change: verifies the current password, stores
   * the new hash and revokes every session (the frontend re-logs in
   * silently with the new credentials).
   */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.usersService.findById(userId);
    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('User not found');
    }
    const isMatch = await argon2.verify(user.passwordHash, currentPassword);
    if (!isMatch) {
      throw new UnauthorizedException('Current password is incorrect');
    }
    user.passwordHash = await argon2.hash(newPassword);
    await this.refreshTokenRepository.getEntityManager().flush();
    await this.revokeAllForUser(user.id);
  }

  /**
   * Emails a single-use reset link. Deliberately silent about whether the
   * email exists (no user enumeration); the endpoint always answers the
   * same. Token: 256-bit random, SHA-256 stored, 45-minute expiry.
   */
  /**
   * A RESET TOKEN IS ISSUED UNDER THE CANONICAL LOCKS (#277 P2).
   *
   * The first version checked `organizationIsArchived` on the loaded user and
   * then wrote the token from an unlocked entity manager. Against a
   * concurrent archive that check answered from the past: the archive locked
   * the company, revoked every unused token it could see, committed — and the
   * new token landed afterwards, unrevoked, on a member of an archived company,
   * redeemable the day the company was restored. Issuance now takes
   * `org-access` (the archive's first lock), re-reads the company's lifecycle
   * `FOR SHARE` (the row the archive holds `FOR UPDATE`), locks the member row,
   * and only then writes — inside one transaction, so whichever side wins no
   * token outlives the archive. The caller learns nothing either way, exactly
   * as for an unknown address.
   */
  async requestPasswordReset(email: string): Promise<void> {
    // THE ADDRESS THAT WAS ASKED FOR, normalised, is what the link may go to.
    const requested = canonicalEmail(email);
    const user = await this.usersService.findByEmail(email);
    if (!user) return;

    const em = this.resetTokenRepository.getEntityManager() as EntityManager;
    // The loaded user is a HINT. The member and their company are re-derived
    // under the canonical locks, with a restart if the membership moved while
    // this request waited (`credential-issuance.ts`); a member who is gone or
    // whose company is inactive yields null — and the caller learns nothing.
    // The member must STILL OWN the requested address once locked: an address
    // changed or reassigned while this request waited gets no link, silently.
    const issued = await withMemberLockedForIssuance(em, user, async (tem, { user: current }) => {
      if (canonicalEmail(current.email) !== requested) return null;
      await tem.nativeDelete(PasswordResetToken, { user: current.id, usedAt: null });
      const raw = randomBytes(32).toString('base64url');
      tem.persist(
        tem.create(PasswordResetToken, {
          user: tem.getReference(User, current.id),
          tokenHash: this.hashToken(raw),
          expiresAt: new Date(Date.now() + 45 * 60 * 1000),
          createdAt: new Date(),
        } as never),
      );
      await tem.flush();
      return { raw, to: current.email };
    });
    if (!issued) return;

    const base = (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/+$/, '');
    const link = `${base}/reset-password?token=${issued.raw}`;
    // Sent to the address OF RECORD under the lock — which the check above
    // guarantees is the address that was asked for.
    await this.mailService.send(
      issued.to,
      'Reset your Catalog password',
      this.mailService.renderTemplate('reset-password-email', 'Reset your password', {
        email: issued.to,
        link,
      }),
    );
  }

  /** Consumes a reset token: sets the new password and revokes every session. */
  async resetPasswordWithToken(token: string, newPassword: string, acceptTerms?: boolean): Promise<void> {
    const stored = await this.resetTokenRepository.findOne(
      { tokenHash: this.hashToken(token) },
      { populate: ['user', 'user.organization'] as never },
    );
    if (!stored || stored.usedAt || stored.expiresAt.getTime() <= Date.now() || stored.user.deletedAt) {
      throw new UnauthorizedException('Invalid or expired reset link');
    }
    // #277 P2: archive marks every unused token used, but a token issued
    // before a later archive must not slip through either — the company's
    // state is read now, not when the link was made.
    // #294: judged from the stored binding, in every lifecycle state.
    const memberCompany = await readMemberOrganizationLifecycle(
      this.resetTokenRepository.getEntityManager() as EntityManager,
      stored.user.id,
    );
    if (!memberCompany.member || (memberCompany.organizationId && organizationIsInactive(memberCompany.organization))) {
      throw new UnauthorizedException('Invalid or expired reset link');
    }

    stored.user.passwordHash = await argon2.hash(newPassword);
    if (acceptTerms) {
      stored.user.termsAcceptedAt = new Date();
    }
    stored.usedAt = new Date();
    await this.resetTokenRepository.getEntityManager().flush();
    await this.revokeAllForUser(stored.user.id);
  }

  /** Active sessions (non-revoked, unexpired refresh tokens) for the sessions UI. */
  async listSessions(userId: string) {
    const rows = await this.refreshTokenRepository.find(
      { user: userId, revokedAt: null, expiresAt: { $gt: new Date() } },
      { orderBy: { createdAt: 'DESC' as any } },
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      ip: r.ip ?? null,
      userAgent: r.userAgent ?? null,
    }));
  }

  async revokeSession(userId: string, sessionId: string): Promise<void> {
    await this.refreshTokenRepository.nativeUpdate(
      { id: sessionId, user: userId, revokedAt: null },
      { revokedAt: new Date() },
    );
  }

  // ---------- Two-factor authentication (TOTP) ----------

  private async requirePassword(userId: string, password: string): Promise<User> {
    const user = await this.usersService.findById(userId);
    if (!user || !user.passwordHash || !(await argon2.verify(user.passwordHash, password))) {
      throw new UnauthorizedException('Wrong password');
    }
    return user;
  }

  /** Step 1 of enrollment: a pending secret the authenticator app scans. */
  async setupMfa(userId: string, currentPassword: string) {
    const user = await this.requirePassword(userId, currentPassword);
    if (user.mfaEnabledAt) {
      throw new BadRequestException('Two-factor authentication is already enabled');
    }
    const secret = generateSecret();
    user.mfaPendingSecret = secret;
    user.mfaPendingExpiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await this.refreshTokenRepository.getEntityManager().flush();
    return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
  }

  /** Step 2: the first valid code activates MFA and mints recovery codes. */
  async enableMfa(userId: string, code: string): Promise<string[]> {
    const user = await this.usersService.findById(userId);
    if (!user?.mfaPendingSecret || !user.mfaPendingExpiresAt || user.mfaPendingExpiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Start the setup again — the pending code expired');
    }
    if (!verifyTotp(user.mfaPendingSecret, code)) {
      throw new UnauthorizedException('That code is not valid — check your authenticator app');
    }
    const recoveryCodes = Array.from({ length: 8 }, () => randomBytes(5).toString('hex'));
    user.mfaSecretEnc = encryptSecret(user.mfaPendingSecret);
    user.mfaEnabledAt = new Date();
    user.mfaRecoveryCodes = recoveryCodes.map((recoveryCode) => this.hashToken(recoveryCode));
    user.mfaPendingSecret = undefined;
    user.mfaPendingExpiresAt = undefined;
    await this.refreshTokenRepository.getEntityManager().flush();
    return recoveryCodes;
  }

  /** Accepts a TOTP code or consumes a recovery code. */
  private consumeMfaProof(user: User, code: string): boolean {
    if (user.mfaSecretEnc && verifyTotp(decryptSecret(user.mfaSecretEnc), code)) {
      return true;
    }
    const normalized = code.trim().toLowerCase();
    const hash = this.hashToken(normalized);
    const index = (user.mfaRecoveryCodes ?? []).indexOf(hash);
    if (index >= 0) {
      user.mfaRecoveryCodes = user.mfaRecoveryCodes!.filter((_, i) => i !== index);
      return true;
    }
    return false;
  }

  async disableMfa(userId: string, currentPassword: string, code: string): Promise<void> {
    const user = await this.requirePassword(userId, currentPassword);
    if (!user.mfaEnabledAt) {
      throw new BadRequestException('Two-factor authentication is not enabled');
    }
    if (!this.consumeMfaProof(user, code)) {
      throw new UnauthorizedException('That code is not valid');
    }
    user.mfaSecretEnc = undefined;
    user.mfaEnabledAt = undefined;
    user.mfaRecoveryCodes = undefined;
    await this.refreshTokenRepository.getEntityManager().flush();
  }

  /** Half-logged-in state between password and code. */
  async issueMfaChallenge(user: User): Promise<string> {
    return this.jwtService.signAsync(
      { sub: user.id, purpose: 'mfa' },
      { secret: this.configService.get<string>('JWT_ACCESS_SECRET'), expiresIn: '5m' },
    );
  }

  async verifyMfaChallenge(challengeToken: string, code: string): Promise<User> {
    let payload: { sub: string; purpose?: string };
    try {
      payload = await this.jwtService.verifyAsync(challengeToken, {
        secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('The sign-in expired — enter your password again');
    }
    if (payload.purpose !== 'mfa') {
      throw new UnauthorizedException('The sign-in expired — enter your password again');
    }
    const user = await this.usersService.findById(payload.sub);
    if (!user || !user.mfaEnabledAt) {
      throw new UnauthorizedException('The sign-in expired — enter your password again');
    }
    // #156: bindings may have changed between challenge and verification —
    // this fresh load is re-validated BEFORE the code is consumed and any
    // session token can be issued.
    await this.assertBindingsAllowSession(user);
    if (!this.consumeMfaProof(user, code)) {
      throw new UnauthorizedException('That code is not valid — check your authenticator app');
    }
    await this.refreshTokenRepository.getEntityManager().flush();
    return user;
  }

  /**
   * ENDS EVERY SESSION — both halves of what a session actually is.
   *
   * The refresh rows stop the renewals; advancing the generation stops the
   * access tokens already issued, which the rows never could. Callers that used
   * to say "sessions were revoked" and mean only the first half were telling
   * their users something that was not true for another fifteen minutes.
   *
   * Ordinary ORM writes, so both obey the removal filter: a removed identity's
   * sessions were already ended by the removal transaction itself, which
   * advances the generation there under the row and lifecycle locks.
   */
  async revokeAllForUser(userId: string): Promise<void> {
    const em = this.refreshTokenRepository.getEntityManager() as EntityManager;
    await em.transactional(async (tem) => {
      // ONE TRANSACTION, UNDER THE SAME ROW LOCK EVERY OTHER WRITER TAKES.
      //
      // The two writes were separate statements outside any transaction, which
      // left two orderings nobody had thought about: a failure between them
      // revoked the rows without advancing the number (so a request already in
      // flight could still mint a replacement under the old generation), and a
      // rotation running between them could insert a row after the sweep and
      // before the advance. Serialising on `lockUsers` — lock 2 in the order
      // `access-locks.ts` documents — makes both impossible, and makes this
      // agree with the removal path, which has always done both writes inside
      // its own transaction under the same lock.
      await lockUsers(tem, [userId]);
      await tem.nativeUpdate(RefreshToken, { user: userId, revokedAt: null }, { revokedAt: new Date() } as never);
      await advanceAuthGeneration(tem, userId);
    });
  }

  /**
   * Starts a login-email change: verifies the password, then emails a
   * confirmation link to the NEW address. Nothing changes until that link
   * is clicked, so a typo or a stolen open session can't move the account.
   */
  async requestEmailChange(userId: string, newEmail: string, currentPassword: string): Promise<void> {
    const user = await this.usersService.findById(userId);
    if (!user || !user.passwordHash || !(await argon2.verify(user.passwordHash, currentPassword))) {
      throw new UnauthorizedException('Wrong password');
    }

    // One identity rule (#291): canonicalised here, compared case-insensitively
    // everywhere, and checked against the same expression the unique index uses.
    const email = canonicalEmail(newEmail);
    if (sameEmailIdentity(email, user.email)) {
      throw new BadRequestException('That is already your email');
    }
    // Deactivated accounts count. They still hold the address as far as the
    // unique index is concerned, so `findByEmail` — which skips them so nobody
    // deactivated can sign in — would have promised an address the insert
    // could not deliver.
    if (await this.usersService.findLiveIdentityByEmail(email)) {
      throw new BadRequestException('That email is already in use by another account');
    }

    const token = randomBytes(32).toString('base64url');
    user.pendingEmail = email;
    user.emailChangeTokenHash = this.hashToken(token);
    user.emailChangeExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await this.refreshTokenRepository.getEntityManager().flush();

    const base = (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/+$/, '');
    const link = `${base}/confirm-email?token=${token}`;
    await this.mailService.send(
      email,
      'Confirm your new Catalog email',
      this.mailService.renderTemplate('confirm-email-change', 'Confirm your new email', {
        currentEmail: user.email,
        newEmail: email,
        link,
      }),
    );
  }

  /**
   * Consumes an email-change token: swaps the login email, warns the OLD
   * address (theft tripwire) and signs every session out.
   */
  /**
   * ONE TRANSACTION, UNDER THE CANONICAL LOCKS (#277 P2). The first version
   * flushed the new address, revoked the sessions in a second transaction and
   * ended the recovery links in a third: a failure after the first left the
   * address changed with the old sessions alive and the old links usable.
   * Now the swap, the generation advance, the refresh-token revocation, the
   * invalidation of every unused reset and invitation link and the clearing
   * of the change token commit together or not at all — the token row is
   * read again under the row lock, so a link consumed or replaced while this
   * request waited is refused. Only the notice to the old address happens
   * after commit.
   */
  async confirmEmailChange(token: string): Promise<string> {
    const em = this.refreshTokenRepository.getEntityManager() as EntityManager;
    const tokenHash = this.hashToken(token);
    // The hint: which row, and which company to lock.
    const hint = await em.findOne(
      User,
      { emailChangeTokenHash: tokenHash },
      { populate: ['organization', 'store'] as never },
    );
    if (!hint) throw new UnauthorizedException('Invalid or expired confirmation link');

    const swapped = await em.transactional(async (tem) => {
      const organizationId = organizationIdOfMember(hint as never);
      if (organizationId) await lockOrganizationAccess(tem, organizationId);
      await lockUsers(tem, [hint.id]);
      const user = await reloadMemberInTransaction(tem, hint.id);
      if (
        !user ||
        user.emailChangeTokenHash !== tokenHash ||
        !user.pendingEmail ||
        !user.emailChangeExpiresAt ||
        user.emailChangeExpiresAt.getTime() <= Date.now() ||
        user.deletedAt
      ) {
        throw new UnauthorizedException('Invalid or expired confirmation link');
      }
      // Re-checked at CONFIRMATION, not only at request: the address may have
      // been taken in the twenty-four hours the link is valid for. Same
      // case-insensitive question as the index will ask.
      if (await this.usersService.findLiveIdentityByEmail(user.pendingEmail)) {
        throw new BadRequestException('That email is already in use by another account');
      }
      const oldEmail = user.email;
      const newEmail = user.pendingEmail;
      // The swap, the change token cleared, and the generation advanced — ONE
      // statement on the row this transaction holds.
      await tem.nativeUpdate(User, { id: user.id }, {
        email: newEmail,
        pendingEmail: null,
        emailChangeTokenHash: null,
        emailChangeExpiresAt: null,
        authGeneration: nextAuthGeneration(),
      } as never);
      await tem.nativeUpdate(RefreshToken, { user: user.id, revokedAt: null }, { revokedAt: new Date() } as never);
      // A recovery or invitation link is addressed to the OLD address. It was
      // minted for an identity that address no longer names, so it ends here,
      // with the sessions — a fresh request goes to the new address.
      await tem.nativeDelete(PasswordResetToken, { user: user.id, usedAt: null });
      return { oldEmail, newEmail };
    });
    const oldEmail = swapped.oldEmail;
    const user = { email: swapped.newEmail };

    await this.mailService.send(
      oldEmail,
      'Your Catalog sign-in email was changed',
      this.mailService.renderTemplate('email-changed-notice', 'Sign-in email changed', {
        oldEmail,
        newEmail: user.email,
      }),
    );

    return user.email;
  }
}
