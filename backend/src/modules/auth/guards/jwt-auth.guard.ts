import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { UsersService } from '../../users/users.service';
import { userBindingError } from '../../users/authorization/role-levels';
import { assertMemberOrganizationActive } from '../../organizations/lifecycle/organization-archived';
import { TenantScopeService } from '../tenancy/tenant-scope.service';
import { effectiveBillingStatus } from '../../stores/plans';
import { tokenGenerationIsCurrent } from '../sessions/session-generation';

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwtService: JwtService,
    private readonly usersService: UsersService,
    private readonly configService: ConfigService,
    private readonly tenantScopeService: TenantScopeService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid token format');
    }

    const token = authHeader.split(' ')[1];
    let user;
    let payload: Record<string, unknown>;
    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
      });
      user = await this.usersService.findById(payload.sub as string);
    } catch (err) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    /**
     * #291 THE SESSION BOUNDARY A SIGNATURE CANNOT EXPRESS.
     *
     * Reloading the user is not enough, and that is precisely what this guard
     * used to do. A removed identity is invisible to `findById`, so the token
     * fails here while the removal stands — but a restoration inside the
     * fifteen-minute window made the row visible again and the old token, still
     * unexpired and still correctly signed, went straight back to working. The
     * person who was removed had their access returned to them by the act of
     * being restored, before anyone chose to give it back.
     *
     * So the token must also agree with the account about WHICH session it
     * belongs to. `tokenGenerationIsCurrent` is that agreement, and it refuses a
     * token carrying no generation at all — the explicit rule for tokens minted
     * before the claim existed, and the reason a deployment costs one silent
     * refresh rather than reviving anything. The comparison lives in
     * `session-generation.ts`; there is nothing to weaken here.
     */
    if (!tokenGenerationIsCurrent(payload, user.authGeneration)) {
      throw new UnauthorizedException('Your session has ended — sign in again');
    }

    // #156 fail closed, per request: a user whose persisted bindings violate
    // the role model (or point at an archived store) is refused here even if
    // its 15-minute access token was minted before the corruption. Tokens are
    // also denied at login/refresh; this is the second layer, so a corrupted
    // row can never fall back to the legacy "no store = global" behavior.
    if (userBindingError(user)) {
      throw new ForbiddenException('Your account access is not configured correctly — contact your administrator');
    }
    // #277 P2: archive advances every member's generation, so a token minted
    // before it is already refused above. This is the live rule for the case
    // the generation cannot express: a request arriving between the archive
    // commit and the next token check reads the company's state now.
    // #294: the company's lifecycle is read from the member's STORED binding
    // with a statement that sees every state — archived, merged, removed. The
    // populated `user.organization` is filtered and resolves to null for a
    // removed company, and null must not read as "active".
    await assertMemberOrganizationActive(this.usersService.entityManager(), user.id);
    request.user = user;

    // P0-03: the explicit authorization context, resolved BEFORE any
    // authorization decision below depends on it.
    //
    // P5-A3 moved this ahead of the billing gate. It reads only `user` and the
    // request headers — both already available — so there is no cycle: token
    // verification, the user load and the #156 binding check all still precede
    // it, and no request that previously succeeded can now fail. The only
    // ordering effect is that a request which is BOTH scope-invalid and
    // billing-blocked now reports the scope error; it was going to be refused
    // by this same call a few lines later either way.
    request.scope = await this.tenantScopeService.resolve(user, request.headers ?? {});

    // Billing gate: while a company hasn't paid (or its subscription died)
    // the panel is read-only, except Billing/auth so they can pay their way
    // out. Their public website is never affected, only this admin panel.
    // P0-09: billing belongs to the client; the branch just points at it.
    // Role-based (#156): the platform owner is exempt even when carrying
    // bindings; every tenant role — the store-less ORGANIZATION_MANAGER
    // included — is gated by its own validated organization.
    //
    // P5-A3: WHICH company is gated now comes from the RESOLVED SCOPE, not
    // from `user.organization ?? user.store?.organization`. The billing status
    // itself is still read from the already-populated `user.organization`,
    // which costs no extra query — but only when its id matches the scope's,
    // so a future divergence fails closed instead of gating the wrong company.
    //
    // Behaviour is unchanged for every reachable case: `roleBindingError`
    // refuses any non-SUPER_ADMIN whose `organizationId` is absent, so a tenant
    // role always has `user.organization`, and `TenantScopeService` derives
    // `scope.organizationId` from that same field. The old
    // `user.store?.organization` fallback was therefore dead code — and it was
    // an authority read off a user binding, which is what A3 removes.
    if (user.role?.name !== 'SUPER_ADMIN') {
      const scopedOrganizationId: string | null = request.scope?.organizationId ?? null;
      if (!scopedOrganizationId) {
        throw new ForbiddenException('Your account has no organization context — contact your administrator');
      }
      const userOrganizationId = user.organization?.id ?? null;
      if (userOrganizationId !== scopedOrganizationId) {
        throw new ForbiddenException('Your account access is not configured correctly — contact your administrator');
      }
      // Plan Gratis is never read-only for payment, whatever the stored status says.
      const billingStatus = effectiveBillingStatus(user.organization);
      if (billingStatus !== 'ACTIVE' && !READ_METHODS.includes(request.method)) {
        const url: string = request.url ?? '';
        if (!url.includes('/billing') && !url.includes('/auth')) {
          throw new ForbiddenException(
            billingStatus === 'SUSPENDED'
              ? 'Your subscription is paused, so the panel is read-only — reactivate it from Billing'
              : 'Your panel is read-only until the first payment — activate it from Billing',
          );
        }
      }
    }

    return true;
  }
}
