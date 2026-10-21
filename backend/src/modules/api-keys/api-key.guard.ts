import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApiKeysService } from './api-keys.service';
import { API_KEY_CAPABILITY_METADATA, ApiKeyCapability } from './api-key-capabilities';
import { clientRequestIdOf, requestIdOf } from '../../common/observability/request-id';

/**
 * Protects the Catalogue API (ADR 005). Authenticates with an API key only:
 *  - `X-Api-Key: ck_...`  — consumer websites/integrations
 *
 * The admin Bearer path was removed in #175 (P2-12): it let an unscoped admin
 * JWT read the catalogue across every tenant, and the panel now reads its live
 * counts through the authenticated, tenant-scoped `/catalogue/live-counts`
 * route instead. `/public` accepts nothing but an API key.
 *
 * Phase 6 adds AUTHORIZATION on top of authentication. Every route on the
 * public controller declares the one capability it requires via
 * `@RequireApiCapability(...)`; the guard reads that metadata and compares it
 * against the verified key's grant. The two failure modes are deliberately
 * distinct so integrators can tell them apart:
 *
 *   401 — the key itself is bad (missing, unknown, revoked). Unchanged.
 *   403 — the key is real and alive, but was not granted this capability.
 *
 * A route that carries NO capability metadata fails closed with a 403: an
 * unclassified route is a programming error, and the safe answer to a
 * programming error in an authorization layer is "no". A structural test
 * enumerates the controller to keep that branch theoretical.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(
    private readonly apiKeysService: ApiKeysService,
    private readonly reflector: Reflector,
  ) {}

  /*
    Every rejection is LOGGED, attributably, before it is thrown.

    Until this line existed a credential-scanning campaign against /public was
    invisible: the guard threw, Nest answered 401, and nothing anywhere
    recorded that it had happened — no request id existed to record it
    against. The record carries what an operator needs to correlate and
    nothing an attacker could use: the request id (echoed to the caller as
    X-Request-Id), the route, the reason, and the key's DISPLAY PREFIX — the
    first ten characters, which the admin panel already shows as the key's
    public name. Never the key, never the header, never a hash of the whole
    secret.
  */
  private reject(request: unknown, reason: string, keyPrefix: string | null, error: Error): never {
    const req = request as { method?: string; originalUrl?: string; url?: string };
    // The PATH only. A query string is where a misused credential would sit
    // (`?api_key=…` from a confused integrator), and a log line must never be
    // the place it ends up.
    const path = String(req.originalUrl ?? req.url ?? '').split('?')[0];
    this.logger.warn(
      JSON.stringify({
        event: 'api_key_rejected',
        requestId: requestIdOf(request),
        clientRequestId: clientRequestIdOf(request),
        method: req.method,
        path,
        reason,
        keyPrefix,
      }),
    );
    throw error;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const apiKey = request.headers['x-api-key'];
    if (typeof apiKey === 'string' && apiKey.length > 0) {
      // The display prefix is the key's designed non-secret identifier — the
      // same ten characters the service persists for the admin panel's list.
      // Only when the value has a key's SHAPE: an integrator who pastes a
      // password or a bearer token into this header must not have its first
      // ten characters written to a log.
      const keyPrefix = /^ck_[A-Za-z0-9_-]{7}/.test(apiKey) ? apiKey.slice(0, 10) : 'malformed';
      const verified = await this.apiKeysService.verify(apiKey);
      if (verified) {
        const required = this.reflector.getAllAndOverride<ApiKeyCapability | undefined>(API_KEY_CAPABILITY_METADATA, [
          context.getHandler(),
          context.getClass(),
        ]);
        if (!required) {
          this.reject(
            request,
            'route_declares_no_capability',
            keyPrefix,
            new ForbiddenException('This endpoint is not available to API keys'),
          );
        }
        if (!verified.capabilities.includes(required)) {
          this.reject(
            request,
            `capability_missing:${required}`,
            keyPrefix,
            new ForbiddenException(`This API key does not have the ${required} capability`),
          );
        }
        // Scopes the catalogue to the key's branch AND its client (P0-10):
        // every public query pins both, so one client's key can never read
        // another's rows even if ids leak.
        request.catalogueStoreId = verified.storeId;
        request.catalogueOrganizationId = verified.organizationId;
        return true;
      }
      this.reject(request, 'invalid_or_revoked', keyPrefix, new UnauthorizedException('Invalid or revoked API key'));
    }

    this.reject(request, 'missing_credential', null, new UnauthorizedException('API key required (X-Api-Key header)'));
  }
}
