import {
  BadRequestException,
  ConflictException,
  Controller,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { assertUnscopedPlatformOwner } from '../../auth/tenancy/tenant-assertions';
import { requestIdOf } from '../../../common/observability/request-id';
import { StripeService } from './stripe.service';

const EVENT_ID = /^evt_[A-Za-z0-9_]{8,120}$/;

/**
 * Owner-only resolution of a `requires_action` Stripe event (#248, PR B).
 *
 * A resend from the Stripe dashboard is the SAME event id and lands as a
 * duplicate, so it cannot resolve anything. Reapply re-fetches the object from
 * Stripe (no payload is stored), recomputes the transition from the current
 * local state under the same locks the webhook takes, and moves the
 * disposition exactly once. Platform authority is required: a SUPER_ADMIN
 * working inside a managed company holds organization authority, not this.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('billing/stripe-events')
export class StripeEventsController {
  constructor(private readonly stripeService: StripeService) {}

  @Post(':eventId/reapply')
  async reapply(@Req() req: any, @Param('eventId') eventId: string) {
    assertUnscopedPlatformOwner(req.scope);
    if (!EVENT_ID.test(eventId)) throw new BadRequestException('Not a Stripe event id');
    const actor = { id: String(req.user?.id ?? ''), email: req.user?.email ?? null };
    if (!actor.id) throw new BadRequestException('Reapply needs an acting user');
    const outcome = await this.stripeService.reapplyEvent(eventId, actor, requestIdOf(req));
    if (outcome.kind === 'not_found') throw new NotFoundException('No such Stripe event in the ledger');
    if (outcome.kind === 'already_resolved') throw new ConflictException('This event is not an open requires_action');
    if (outcome.kind === 'no_change') {
      throw new ConflictException(`The event still requires action: ${outcome.reason}`);
    }
    return { data: { eventId, result: outcome.result, reason: outcome.reason } };
  }
}
