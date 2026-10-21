import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UnauthorizedException } from '@nestjs/common';
import { createHash } from 'crypto';
import * as argon2 from 'argon2';
import { AuthService } from '../../auth.service';
import { RefreshToken } from '../../entities/refresh-token.entity';
import { PasswordResetToken } from '../../entities/password-reset-token.entity';
import { MailService } from '../../../mail/mail.service';
import { UsersService } from '../../../users/users.service';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

describe('AuthService', () => {
  let service: AuthService;
  let mockRepo: any;
  let mockEm: any;
  let mockJwt: any;
  let mockUsers: any;
  let mockResetRepo: any;
  let mockMail: any;

  // #156: the shared fixture carries VALID bindings — an unbound ADMIN can no
  // longer authenticate at all, which its own tests below assert.
  const user: any = {
    id: 'user-1',
    email: 'a@b.com',
    role: { name: 'ADMIN' },
    organization: { id: 'org-1' },
    store: { id: 'store-1', archivedAt: null, organization: { id: 'org-1' } },
    deletedAt: null,
    // #291: the account has never had its sessions ended, so it sits at the
    // initial generation. Tests that need a moved-on account override it.
    authGeneration: 1,
  };

  beforeEach(async () => {
    mockEm = {
      persistAndFlush: jest.fn(),
      flush: jest.fn(),
      nativeDelete: jest.fn(),
      // #291: `revokeAllForUser` ends BOTH halves of a session — the refresh
      // rows and every outstanding access token — in ONE transaction under the
      // user row lock, so both writes and the lock come through here.
      nativeUpdate: jest.fn(),
      // #277 P2: the reset issuance re-reads the company's lifecycle under
      // lock; an ACTIVE company answers here, every other statement (locks,
      // generation reads) keeps the previous shape.
      execute: jest.fn(async (sql: string) =>
        String(sql).includes('merged_into_organization_id')
          ? [{ organizationId: 'org-1', archivedAt: null, mergedIntoOrganizationId: null, removedAt: null }]
          : [{ auth_generation: 1 }],
      ),
      create: jest.fn((_entity: unknown, data: unknown) => data),
      persist: jest.fn(),
      getReference: jest.fn((_entity: unknown, id: string) => ({ id })),
      // #277 P2: issuance RELOADS the member under the row lock; the mock
      // answers with the same user the repository knows.
      // the cleared-fork reload reads through the same mock
      fork: jest.fn(function (this: unknown) {
        return this;
      }),
      findOne: jest.fn(async () => user),
      transactional: jest.fn(async (cb: (tem: unknown) => Promise<unknown>) => cb(mockEm)),
    };
    mockRepo = {
      findOne: jest.fn(),
      create: jest.fn((data) => data),
      nativeUpdate: jest.fn(),
      nativeDelete: jest.fn(),
      getEntityManager: jest.fn().mockReturnValue(mockEm),
    };
    mockJwt = {
      signAsync: jest.fn().mockResolvedValue('signed-token'),
      verifyAsync: jest.fn(),
    };
    mockUsers = {
      findByEmail: jest.fn(),
      findById: jest.fn(),
    };
    mockResetRepo = {
      findOne: jest.fn(),
      create: jest.fn((data) => data),
      getEntityManager: jest.fn().mockReturnValue(mockEm),
    };
    mockMail = {
      send: jest.fn().mockResolvedValue(true),
      // Every real mail goes through the branded template; a mock without it
      // fails the reset path (same root cause fixed in users.service.spec)
      // Mirrors the real renderer closely enough for link assertions
      renderTemplate: jest.fn(
        (_name: string, heading: string, vars: Record<string, string>) =>
          `<html>${heading}${Object.values(vars).join(' ')}</html>`,
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: mockUsers },
        { provide: JwtService, useValue: mockJwt },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('secret') } },
        { provide: getRepositoryToken(RefreshToken), useValue: mockRepo },
        { provide: getRepositoryToken(PasswordResetToken), useValue: mockResetRepo },
        { provide: MailService, useValue: mockMail },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  describe('validateUser', () => {
    it('returns the user for valid credentials', async () => {
      const passwordHash = await argon2.hash('correct-password');
      mockUsers.findByEmail.mockResolvedValue({ ...user, passwordHash });

      const result = await service.validateUser('a@b.com', 'correct-password');
      expect(result.email).toBe('a@b.com');
    });

    it('rejects an unknown email', async () => {
      mockUsers.findByEmail.mockResolvedValue(null);
      await expect(service.validateUser('x@y.com', 'pass')).rejects.toThrow(UnauthorizedException);
    });

    it('rejects a wrong password', async () => {
      const passwordHash = await argon2.hash('correct-password');
      mockUsers.findByEmail.mockResolvedValue({ ...user, passwordHash });

      await expect(service.validateUser('a@b.com', 'wrong')).rejects.toThrow(UnauthorizedException);
    });

    // #156 fail closed: correct password, corrupt persisted bindings → no tokens
    it('rejects an unbound tenant user even with the correct password', async () => {
      const passwordHash = await argon2.hash('correct-password');
      mockUsers.findByEmail.mockResolvedValue({ ...user, passwordHash, organization: null, store: null });

      await expect(service.validateUser('a@b.com', 'correct-password')).rejects.toThrow(/not configured correctly/);
    });

    it('rejects a user bound to an archived store', async () => {
      const passwordHash = await argon2.hash('correct-password');
      mockUsers.findByEmail.mockResolvedValue({
        ...user,
        passwordHash,
        store: { id: 'store-1', archivedAt: new Date(), organization: { id: 'org-1' } },
      });

      await expect(service.validateUser('a@b.com', 'correct-password')).rejects.toThrow(/not configured correctly/);
    });

    it('still admits an unbound SUPER_ADMIN (#194 permits it)', async () => {
      const passwordHash = await argon2.hash('correct-password');
      mockUsers.findByEmail.mockResolvedValue({
        id: 'owner-1',
        email: 'a@b.com',
        role: { name: 'SUPER_ADMIN' },
        organization: null,
        store: null,
        deletedAt: null,
        passwordHash,
      });

      await expect(service.validateUser('a@b.com', 'correct-password')).resolves.toBeDefined();
    });

    it('admits a canonical store-less ORGANIZATION_MANAGER', async () => {
      const passwordHash = await argon2.hash('correct-password');
      mockUsers.findByEmail.mockResolvedValue({
        id: 'om-1',
        email: 'a@b.com',
        role: { name: 'ORGANIZATION_MANAGER' },
        organization: { id: 'org-1' },
        store: null,
        deletedAt: null,
        passwordHash,
      });

      await expect(service.validateUser('a@b.com', 'correct-password')).resolves.toBeDefined();
    });
  });

  describe('issueRefreshToken', () => {
    it('cleans up expired tokens for the user', async () => {
      await service.issueRefreshToken(user);
      expect(mockEm.nativeDelete).toHaveBeenCalledWith(expect.anything(), {
        user: 'user-1',
        expiresAt: { $lt: expect.any(Date) },
      });
    });

    it('persists a hashed record and returns a token CARRYING THE GENERATION', async () => {
      const { token, id, generation } = await service.issueRefreshToken(user);

      expect(token).toBe('signed-token');
      expect(generation).toBe(1);
      // The number rides in the refresh token as well as the access token: a
      // row that somehow outlives its revocation is still refused on the claim.
      expect(mockJwt.signAsync).toHaveBeenCalledWith(
        { sub: 'user-1', jti: id, gen: 1 },
        expect.objectContaining({ expiresIn: '7d' }),
      );
      expect(mockEm.persistAndFlush).toHaveBeenCalledWith(
        expect.objectContaining({ id, tokenHash: sha256('signed-token') }),
      );
    });

    /**
     * ASSERTED AS STATEMENTS, because the effect is masked.
     *
     * Dropping `lockUsers` does not make this path stop blocking: inserting a
     * `refresh_tokens` row takes a FK lock on the same user row, which
     * conflicts with a held `FOR UPDATE` all by itself. So a test that only
     * watches for blocking cannot tell the two apart — mutation testing said
     * exactly that, and it is the same lesson the removal's row lock taught.
     *
     * What the explicit lock uniquely buys is ORDER: the generation is read
     * INSIDE the locked section, so it cannot change between the read and the
     * decision. That is what these assertions pin.
     */
    it('TAKES THE USER ROW LOCK, and reads the generation only once it holds it', async () => {
      await service.issueRefreshToken(user);
      const statements = mockEm.execute.mock.calls.map((call: unknown[]) => String(call[0]));
      const locked = statements.findIndex((sql: string) => /for update/i.test(sql));
      const read = statements.findIndex((sql: string) => /select auth_generation/i.test(sql));
      expect(locked).toBeGreaterThanOrEqual(0);
      expect(read).toBeGreaterThanOrEqual(0);
      expect(locked).toBeLessThan(read);
    });

    it('REFUSES when the account moved on between authorisation and this write', async () => {
      // The race the lock exists for: a removal committed while this request
      // was in flight. Issuing here would leave an unrevoked refresh row that
      // no sweep will ever reach.
      mockEm.execute.mockImplementation(async (sql: string) =>
        /auth_generation/.test(sql) ? [{ auth_generation: 2 }] : [],
      );
      await expect(service.issueRefreshToken(user)).rejects.toThrow('Your session has ended');
      expect(mockEm.persistAndFlush).not.toHaveBeenCalled();
    });
  });

  describe('validateRefreshToken', () => {
    const storedRow = () => ({
      id: 'jti-1',
      user,
      tokenHash: sha256('signed-token'),
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });

    it('returns the stored record AND the generation it validated under', async () => {
      // The generation travels with the row because the rotation that follows
      // is checked against the number this request was authorised under.
      mockJwt.verifyAsync.mockResolvedValue({ sub: 'user-1', jti: 'jti-1', gen: 1 });
      mockRepo.findOne.mockResolvedValue(storedRow());

      const result = await service.validateRefreshToken('signed-token');
      expect(result.stored.id).toBe('jti-1');
      expect(result.generation).toBe(1);
    });

    it('refuses a refresh token from an OLDER generation', async () => {
      // The removal (or a password change, or a reset) moved the account on.
      // The row may not even be revoked yet — this refuses on the claim alone.
      mockJwt.verifyAsync.mockResolvedValue({ sub: 'user-1', jti: 'jti-1', gen: 1 });
      mockRepo.findOne.mockResolvedValue({
        ...storedRow(),
        user: { ...user, authGeneration: 2 },
      });
      await expect(service.validateRefreshToken('signed-token')).rejects.toThrow('Your session has ended');
    });

    it('and does NOT treat a stale generation as theft', async () => {
      // Firing the reuse response here would let anyone holding an old token
      // advance the victim's generation at will and end their live session.
      mockJwt.verifyAsync.mockResolvedValue({ sub: 'user-1', jti: 'jti-1', gen: 1 });
      mockRepo.findOne.mockResolvedValue({
        ...storedRow(),
        user: { ...user, authGeneration: 2 },
      });
      await expect(service.validateRefreshToken('signed-token')).rejects.toThrow('Your session has ended');
      expect(mockEm.nativeUpdate).not.toHaveBeenCalled();
      expect(mockRepo.nativeUpdate).not.toHaveBeenCalled();
    });

    it('accepts a CLAIMLESS token only while the account is at its first generation', async () => {
      // The seven-day deployment compatibility rule: refusing every legacy
      // refresh token would sign out the whole platform, so one is honoured
      // while nothing has yet happened that was supposed to end its sessions.
      mockJwt.verifyAsync.mockResolvedValue({ sub: 'user-1', jti: 'jti-1' });
      mockRepo.findOne.mockResolvedValue(storedRow());
      await expect(service.validateRefreshToken('signed-token')).resolves.toMatchObject({ generation: 1 });
    });

    it('and refuses a CLAIMLESS token once anything has advanced the generation', async () => {
      // Which is exactly the population the rule exists to protect: a person
      // removed by this revision sits at 2, and their week-old refresh cookie
      // must not outlive the removal.
      mockJwt.verifyAsync.mockResolvedValue({ sub: 'user-1', jti: 'jti-1' });
      mockRepo.findOne.mockResolvedValue({
        ...storedRow(),
        user: { ...user, authGeneration: 2 },
      });
      await expect(service.validateRefreshToken('signed-token')).rejects.toThrow('Your session has ended');
    });

    it('rejects a token with an invalid signature', async () => {
      mockJwt.verifyAsync.mockRejectedValue(new Error('bad signature'));
      await expect(service.validateRefreshToken('tampered')).rejects.toThrow('Invalid or expired refresh token');
    });

    it('rejects a token whose hash does not match the stored record', async () => {
      mockJwt.verifyAsync.mockResolvedValue({ sub: 'user-1', jti: 'jti-1' });
      mockRepo.findOne.mockResolvedValue({ ...storedRow(), tokenHash: sha256('other-token') });

      await expect(service.validateRefreshToken('signed-token')).rejects.toThrow('Invalid or expired refresh token');
    });

    it('rejects an expired record', async () => {
      mockJwt.verifyAsync.mockResolvedValue({ sub: 'user-1', jti: 'jti-1' });
      mockRepo.findOne.mockResolvedValue({
        ...storedRow(),
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(service.validateRefreshToken('signed-token')).rejects.toThrow('Invalid or expired refresh token');
    });

    // #156: renewal re-validates bindings — a session cannot outlive them
    it('rejects renewal for a user whose bindings were corrupted mid-session', async () => {
      mockJwt.verifyAsync.mockResolvedValue({ sub: 'user-1', jti: 'jti-1' });
      mockRepo.findOne.mockResolvedValue({
        ...storedRow(),
        user: { ...user, organization: null, store: null },
      });

      await expect(service.validateRefreshToken('signed-token')).rejects.toThrow(/not configured correctly/);
    });

    it('revokes every session on reuse of a rotated token', async () => {
      mockJwt.verifyAsync.mockResolvedValue({ sub: 'user-1', jti: 'jti-1' });
      mockRepo.findOne.mockResolvedValue({ ...storedRow(), revokedAt: new Date() });

      await expect(service.validateRefreshToken('signed-token')).rejects.toThrow('Refresh token reuse detected');
      // BOTH writes, through the transactional manager: the rows and the
      // generation now happen in one transaction under the user row lock, so
      // no rotation can slip between them.
      expect(mockEm.nativeUpdate).toHaveBeenCalledWith(
        expect.anything(),
        { user: 'user-1', revokedAt: null },
        { revokedAt: expect.any(Date) },
      );
      // #291: theft response ends the ACCESS tokens too. Revoking the rows
      // alone would have left the thief's current token working for up to
      // fifteen more minutes — which is the whole window an attacker needs.
      expect(mockEm.nativeUpdate).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'user-1' },
        { authGeneration: expect.anything() },
      );
    });
  });

  describe('verifyMfaChallenge (#156)', () => {
    it('rejects when the freshly loaded user has corrupt bindings — before any token', async () => {
      // Challenge was issued while the user was valid; bindings then changed.
      mockJwt.verifyAsync.mockResolvedValue({ sub: 'user-1', purpose: 'mfa' });
      mockUsers.findById.mockResolvedValue({
        ...user,
        mfaEnabledAt: new Date(),
        organization: null,
        store: null,
      });

      await expect(service.verifyMfaChallenge('challenge-token', '123456')).rejects.toThrow(/not configured correctly/);
      // The rejection happens before the MFA code is even consumed
      expect(mockEm.flush).not.toHaveBeenCalled();
    });
  });

  describe('rotateRefreshToken', () => {
    it('revokes the old record and links it to the replacement', async () => {
      const stored: any = {
        id: 'jti-old',
        user,
        tokenHash: sha256('old'),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      };

      const rotated = await service.rotateRefreshToken({ stored, generation: 1 });

      expect(rotated.token).toBe('signed-token');
      expect(rotated.generation).toBe(1);
      expect(stored.revokedAt).toBeInstanceOf(Date);
      expect(stored.replacedById).toBeDefined();
      expect(mockEm.flush).toHaveBeenCalled();
    });

    it('mints the replacement against the VALIDATED generation, not the loaded entity', async () => {
      /**
       * THE ENTITY IS THE WRONG SOURCE, and this fixture is built so that only
       * the right one refuses.
       *
       * `stored.user` is a managed entity that anything in the same manager may
       * have refreshed — the row here already carries the NEW generation. Reading
       * it would compare the row against itself and the post-lock check would be
       * vacuous, exactly the way deciding authority from a populated relation was.
       * The number this request was AUTHORISED under is the one that matters.
       */
      const stored: any = {
        id: 'jti-old',
        user: { ...user, authGeneration: 5 },
        tokenHash: sha256('old'),
        expiresAt: new Date(Date.now() + 60_000),
        revokedAt: null,
      };
      mockEm.execute.mockImplementation(async (sql: string) =>
        /auth_generation/.test(sql) ? [{ auth_generation: 5 }] : [],
      );

      await expect(service.rotateRefreshToken({ stored, generation: 1 })).rejects.toThrow('Your session has ended');
      // The presented token is left standing: nothing was issued, so nothing
      // was rotated, and the request simply fails.
      expect(stored.revokedAt).toBeNull();
    });
  });

  describe('changePassword', () => {
    it('rejects a wrong current password', async () => {
      const passwordHash = await argon2.hash('current-pass');
      mockUsers.findById.mockResolvedValue({ ...user, passwordHash });

      await expect(service.changePassword('user-1', 'wrong', 'new-password-1')).rejects.toThrow(
        'Current password is incorrect',
      );
      expect(mockRepo.nativeUpdate).not.toHaveBeenCalled();
    });

    it('stores the new hash and revokes every session', async () => {
      const passwordHash = await argon2.hash('current-pass');
      const stored: any = { ...user, passwordHash };
      mockUsers.findById.mockResolvedValue(stored);

      await service.changePassword('user-1', 'current-pass', 'new-password-1');

      await expect(argon2.verify(stored.passwordHash, 'new-password-1')).resolves.toBe(true);
      expect(mockEm.nativeUpdate).toHaveBeenCalledWith(
        expect.anything(),
        { user: 'user-1', revokedAt: null },
        { revokedAt: expect.any(Date) },
      );
      // …and BOTH writes happened behind the user row lock. Same masking as
      // `issueRefreshToken`: the UPDATE on `users` takes that row's lock by
      // itself, so only the statement proves the explicit lock is there — and
      // the explicit one is what stops a rotation slipping between the sweep
      // and the advance.
      expect(mockEm.execute.mock.calls.map((call: unknown[]) => String(call[0]))).toContainEqual(
        expect.stringMatching(/for update/i),
      );
      // "Revokes every session" has to mean it. Before #291 someone who
      // changed their password because they thought it was compromised kept
      // the compromised access token alive for another fifteen minutes.
      expect(mockEm.nativeUpdate).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'user-1' },
        { authGeneration: expect.anything() },
      );
    });
  });

  describe('password reset', () => {
    it('stays silent for unknown emails (no enumeration, no send)', async () => {
      mockUsers.findByEmail.mockResolvedValue(null);
      await service.requestPasswordReset('ghost@x.com');
      expect(mockMail.send).not.toHaveBeenCalled();
      expect(mockEm.persist).not.toHaveBeenCalled();
    });

    it('stores a hashed token and emails a link containing the raw token', async () => {
      mockUsers.findByEmail.mockResolvedValue(user);
      await service.requestPasswordReset('a@b.com');

      // #277 P2: issued inside a transaction, under org-access and the member
      // row, after the lifecycle re-read — so `persist` + `flush`, and the
      // statements before the write are the locks and the locked read.
      const statements = mockEm.execute.mock.calls.map((call: unknown[]) => String(call[0]));
      const params = mockEm.execute.mock.calls.map((call: unknown[]) => JSON.stringify(call[1] ?? []));
      expect(params.some((p: string) => p.includes('org-access:org-1'))).toBe(true);
      expect(
        statements.some((sql: string) => sql.includes('merged_into_organization_id') && sql.includes('for share')),
      ).toBe(true);
      const persisted = mockEm.persist.mock.calls[0][0];
      const [to, , html] = mockMail.send.mock.calls[0];
      expect(to).toBe('a@b.com');
      const rawToken = html.match(/token=([A-Za-z0-9_-]+)/)[1];
      expect(persisted.tokenHash).toBe(sha256(rawToken));
      expect(persisted.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('resets the password and revokes all sessions with a valid token', async () => {
      const stored: any = {
        tokenHash: sha256('good'),
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        user: { ...user, passwordHash: 'old' },
      };
      mockResetRepo.findOne.mockResolvedValue(stored);

      await service.resetPasswordWithToken('good', 'brand-new-pass1');

      await expect(argon2.verify(stored.user.passwordHash, 'brand-new-pass1')).resolves.toBe(true);
      expect(stored.usedAt).toBeInstanceOf(Date);
      expect(mockEm.nativeUpdate).toHaveBeenCalled();
      // Same reason as the password change: a reset is usually a response to
      // a suspected compromise, so it must end the tokens already issued.
      expect(mockEm.nativeUpdate).toHaveBeenCalledWith(
        expect.anything(),
        { id: 'user-1' },
        { authGeneration: expect.anything() },
      );
    });

    it('rejects used and expired tokens', async () => {
      mockResetRepo.findOne.mockResolvedValue({
        tokenHash: sha256('used'),
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        user,
      });
      await expect(service.resetPasswordWithToken('used', 'whatever-pass1')).rejects.toThrow(
        'Invalid or expired reset link',
      );

      mockResetRepo.findOne.mockResolvedValue({
        tokenHash: sha256('old'),
        usedAt: null,
        expiresAt: new Date(Date.now() - 1000),
        user,
      });
      await expect(service.resetPasswordWithToken('old', 'whatever-pass1')).rejects.toThrow(
        'Invalid or expired reset link',
      );

      mockResetRepo.findOne.mockResolvedValue(null);
      await expect(service.resetPasswordWithToken('missing', 'whatever-pass1')).rejects.toThrow(
        'Invalid or expired reset link',
      );
    });
  });

  describe('revokeRefreshToken', () => {
    it('marks the stored record as revoked on logout', async () => {
      mockJwt.verifyAsync.mockResolvedValue({ jti: 'jti-1' });
      const stored: any = { id: 'jti-1', tokenHash: sha256('signed-token'), revokedAt: null };
      mockRepo.findOne.mockResolvedValue(stored);

      await service.revokeRefreshToken('signed-token');

      expect(stored.revokedAt).toBeInstanceOf(Date);
      expect(mockEm.flush).toHaveBeenCalled();
    });

    it('never throws for an invalid token', async () => {
      mockJwt.verifyAsync.mockRejectedValue(new Error('expired'));
      await expect(service.revokeRefreshToken('garbage')).resolves.toBeUndefined();
    });
  });
});
