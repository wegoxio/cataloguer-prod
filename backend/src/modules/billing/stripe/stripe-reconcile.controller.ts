import { BadRequestException, Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { assertUnscopedPlatformOwner } from '../../auth/tenancy/tenant-assertions';
import { requestIdOf } from '../../../common/observability/request-id';
import { RECONCILE_BOUNDS, StripeReconcileService } from './stripe-reconcile.service';

/**
 * The read-only reconciliation report (#248, PR D).
 *
 * Platform authority only, exactly like the reapply endpoint: a SUPER_ADMIN
 * working inside a managed company holds ORGANISATION authority, not this, and
 * is refused with the same 404 an outsider gets. The report spans every
 * company, so there is no tenant-scoped version of it — narrowing it to one
 * organization would be a different feature with a different contract.
 *
 * GET only. This endpoint repairs nothing: it has no POST, no PATCH and no
 * side effect, and the service beneath it reads inside a read-only
 * transaction.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('billing/stripe-reconcile')
export class StripeReconcileController {
  constructor(private readonly reconcile: StripeReconcileService) {}

  @Get()
  async report(@Req() req: any, @Query('limit') limit?: string, @Query('maxStripePages') maxStripePages?: string) {
    assertUnscopedPlatformOwner(req.scope);
    return {
      data: await this.reconcile.report({
        limit: parseBound(limit, 'limit', RECONCILE_BOUNDS.maxLimit),
        maxStripePages: parseBound(maxStripePages, 'maxStripePages', RECONCILE_BOUNDS.maxStripePages),
        requestId: requestIdOf(req),
      }),
    };
  }
}

/**
 * A bound is a small positive integer or absent. Anything else is refused here
 * rather than silently clamped, so a caller who asks for something impossible
 * learns it instead of receiving a differently-shaped report.
 */
function parseBound(raw: string | undefined, name: string, max: number): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  if (!/^[0-9]{1,4}$/.test(raw)) throw new BadRequestException(`${name} must be a positive integer`);
  const value = Number(raw);
  if (value < 1 || value > max) throw new BadRequestException(`${name} must be between 1 and ${max}`);
  return value;
}
