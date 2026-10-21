import { UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { RolesGuard } from '../roles.guard';
import { Reflector } from '@nestjs/core';

/**
 * Authority is CURRENT — read from the database on every request, never from
 * the token's claims.
 *
 * The access token is minted carrying `role` and `storeId` (auth.service.ts),
 * but the guard consumes only `sub` and reloads the user. That invariant is
 * what makes a mid-session downgrade or deactivation take effect on the very
 * next request even though the token has up to fifteen minutes left — and it
 * was load-bearing but unasserted: nothing failed if someone "optimised" the
 * guard to trust `payload.role`.
 *
 * THE OTHER HALF OF THE CONTRACT CHANGED IN #291, and the change is the point.
 *
 * This file used to pin the opposite: that revoking refresh tokens did NOT
 * invalidate outstanding access tokens, which lived to their own `exp`, so
 * every revocation surface bounded a fifteen-minute WINDOW rather than an
 * instant. That was true, deliberate and documented — and for removal it was
 * indefensible, because restoring someone inside the window handed their old
 * token back its meaning.
 *
 * So the token now also carries the account's authentication generation, and
 * the guard compares it. The tests below pin the new contract: a token from a
 * previous generation is refused for the rest of its life, and a token with no
 * generation at all — one minted before the claim existed — is refused too.
 */
const buildGuard = (payload: Record<string, unknown>) => {
  const jwtService = { verifyAsync: jest.fn().mockResolvedValue(payload) };
  // #294: the guard reads the member's company lifecycle from the stored
  // binding through the users service's entity manager; here that read
  // answers "an active company" so these suites keep testing what they test.
  const memberCompanyRead = {
    execute: jest.fn(async () => [
      { organizationId: 'org-1', archivedAt: null, mergedIntoOrganizationId: null, removedAt: null },
    ]),
  };
  const usersService = { findById: jest.fn(), findManagedStore: jest.fn(), entityManager: () => memberCompanyRead };
  const configService = { get: jest.fn().mockReturnValue('secret') };
  const tenantScopeService = {
    resolve: jest.fn().mockImplementation(async (user: { role?: { name?: string }; store?: { id?: string } }) => ({
      platform: false,
      organizationId: 'org-1',
      storeId: user.store?.id ?? null,
      allowedStoreIds: user.store?.id ? [user.store.id] : [],
      role: user.role?.name,
    })),
  };
  const guard = new JwtAuthGuard(
    jwtService as never,
    usersService as never,
    configService as never,
    tenantScopeService as never,
  );
  return { guard, usersService, tenantScopeService };
};

const requestFor = () => ({ method: 'GET', url: '/api/v1/users', headers: { authorization: 'Bearer token' } });
const contextFor = (request: Record<string, unknown>) =>
  ({ switchToHttp: () => ({ getRequest: () => request }) }) as never;

const dbUser = (role: string, authGeneration = 1) => ({
  id: 'user-1',
  email: 'someone@example.test',
  role: { name: role },
  organization: { id: 'org-1', billingStatus: 'ACTIVE' },
  store: { id: 'store-1', archivedAt: null, organization: { id: 'org-1', billingStatus: 'ACTIVE' } },
  authGeneration,
});

describe('per-request authority comes from the database, not the token', () => {
  it('a deactivated user is refused on the next request, valid token or not', async () => {
    // Deactivation soft-deletes; findById filters deletedAt — the guard sees
    // null and answers 401. This was implemented and completely untested.
    const { guard, usersService } = buildGuard({ sub: 'user-1', role: 'ORGANIZATION_MANAGER', gen: 1 });
    usersService.findById.mockResolvedValue(null);
    await expect(guard.canActivate(contextFor(requestFor()))).rejects.toThrow(UnauthorizedException);
    expect(usersService.findById).toHaveBeenCalledWith('user-1');
  });

  it('a role downgraded between two requests governs the SECOND request, same unexpired token', async () => {
    // ADMIN -> VIEWER: both store-bound roles, so the #156 binding matrix is
    // satisfied on both sides and only the AUTHORITY changes.
    const { guard, usersService } = buildGuard({ sub: 'user-1', role: 'ADMIN', storeId: 'store-1', gen: 1 });

    usersService.findById.mockResolvedValue(dbUser('ADMIN'));
    const first = requestFor() as Record<string, any>;
    await expect(guard.canActivate(contextFor(first))).resolves.toBe(true);
    expect(first.scope.role).toBe('ADMIN');

    // The downgrade happens in the DB; the token still CLAIMS the old role.
    usersService.findById.mockResolvedValue(dbUser('VIEWER'));
    const second = requestFor() as Record<string, any>;
    await expect(guard.canActivate(contextFor(second))).resolves.toBe(true);
    expect(second.scope.role).toBe('VIEWER');
    expect(second.user.role.name).toBe('VIEWER');
  });

  it('the stale claims in the token are inert: RolesGuard reads the reloaded user', async () => {
    const reflector = { getAllAndOverride: jest.fn().mockReturnValue(['ORGANIZATION_MANAGER', 'ADMIN']) };
    const roles = new RolesGuard(reflector as unknown as Reflector);
    const ctx = (roleName: string) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ user: dbUser(roleName) }) }),
        getHandler: () => ({}),
        getClass: () => ({}),
      }) as never;
    expect(roles.canActivate(ctx('ADMIN'))).toBe(true);
    // After the downgrade the SAME route refuses — no claim can override it.
    expect(() => roles.canActivate(ctx('VIEWER'))).toThrow('Access denied: insufficient permissions');
  });

  it('an unexpired access token from a PREVIOUS generation is refused (#291)', async () => {
    // The token is perfectly valid: correct signature, minutes left, and the
    // account exists and is live. It is refused because the account has moved
    // on — every revocation surface advances the generation, and nothing in
    // the request path has to consult a denylist to find that out.
    const { guard, usersService } = buildGuard({ sub: 'user-1', gen: 1 });
    usersService.findById.mockResolvedValue(dbUser('ADMIN', 2));
    await expect(guard.canActivate(contextFor(requestFor()))).rejects.toThrow(UnauthorizedException);
  });

  it('and it stays refused after the account is restored — the number never goes back', async () => {
    // Restoration makes the row visible again. It does NOT lower the
    // generation, so the token that was minted before the removal is dead for
    // the rest of its life rather than reanimated by the rescue.
    const { guard, usersService } = buildGuard({ sub: 'user-1', gen: 1 });
    usersService.findById.mockResolvedValue(dbUser('ADMIN', 2));
    await expect(guard.canActivate(contextFor(requestFor()))).rejects.toThrow(UnauthorizedException);
    // A token minted AFTER the restoration carries the current number and works.
    const fresh = buildGuard({ sub: 'user-1', gen: 2 });
    fresh.usersService.findById.mockResolvedValue(dbUser('ADMIN', 2));
    await expect(fresh.guard.canActivate(contextFor(requestFor()))).resolves.toBe(true);
  });

  it('a token carrying NO generation is refused — the rule for tokens older than the claim', async () => {
    // The explicit compatibility decision. "Assume generation 1" would revive
    // exactly the tokens this exists to kill: someone removed by this revision
    // sits at 2, and their pre-deployment token would claim 1 and be accepted
    // for the rest of its life. The refusal costs one silent refresh.
    const { guard, usersService } = buildGuard({ sub: 'user-1' });
    usersService.findById.mockResolvedValue(dbUser('ADMIN', 1));
    await expect(guard.canActivate(contextFor(requestFor()))).rejects.toThrow(UnauthorizedException);
  });

  it('and a non-integer generation claim is refused rather than coerced', async () => {
    // `'1'` and `1` are not the same claim. Comparing them loosely would let a
    // forged-but-signed shape through on a technicality.
    const { guard, usersService } = buildGuard({ sub: 'user-1', gen: '1' });
    usersService.findById.mockResolvedValue(dbUser('ADMIN', 1));
    await expect(guard.canActivate(contextFor(requestFor()))).rejects.toThrow(UnauthorizedException);
  });

  it('the MFA challenge token cannot be spent as an access token', async () => {
    // Signed with the access secret and carrying a `sub`, so before #291 it
    // passed this guard: half a login accepted as a whole one. It carries no
    // generation, so the same rule that retires pre-deployment tokens closes
    // this too.
    const { guard, usersService } = buildGuard({ sub: 'user-1', purpose: 'mfa' });
    usersService.findById.mockResolvedValue(dbUser('ADMIN', 1));
    await expect(guard.canActivate(contextFor(requestFor()))).rejects.toThrow(UnauthorizedException);
  });
});
