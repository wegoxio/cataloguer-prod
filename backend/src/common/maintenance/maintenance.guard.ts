import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { MAINTENANCE_RESPONSE, refusesRequest } from './maintenance';

/**
 * P5-X1 — refuses mutating HTTP requests while the revision is in maintenance.
 *
 * Registered FIRST among the global guards, before throttling and before
 * authentication: during a cutover window the answer is the same for every
 * caller, so the cheapest possible refusal is the right one, and no
 * authenticated path can slip past a guard that has not run yet.
 *
 * It reads `process.env` on every request rather than caching the mode at
 * construction time. A deployed container has an immutable environment, so this
 * costs a property lookup and buys the ability to prove the behaviour in a test
 * without rebuilding a module.
 *
 * The cutover job is structurally outside this guard: it boots an application
 * CONTEXT, so no HTTP adapter and no guard chain exists in that process.
 */
@Injectable()
export class MaintenanceGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<{ method?: string; originalUrl?: string; url?: string }>();
    const method = request?.method ?? '';
    const path = request?.originalUrl ?? request?.url ?? '';
    if (refusesRequest(process.env, method, path)) {
      throw new HttpException(MAINTENANCE_RESPONSE, HttpStatus.SERVICE_UNAVAILABLE);
    }
    return true;
  }
}
