import { BadRequestException, Controller, Headers, Logger, Post, Req } from '@nestjs/common';
import { requestIdOf } from '../../../common/observability/request-id';
import { StripeService } from './stripe.service';
import { stripeWebhookRejected } from './stripe-webhook-record';

/** Public endpoint: authenticity comes from Stripe's signature, not JWT. */
@Controller('billing')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);

  constructor(private readonly stripeService: StripeService) {}

  @Post('webhook')
  async webhook(@Req() req: any, @Headers('stripe-signature') signature: string) {
    const requestId = requestIdOf(req);
    if (!signature || !req.rawBody) {
      this.logger.warn(stripeWebhookRejected(requestId, 'missing_signature_or_body'));
      throw new BadRequestException('Missing signature or body');
    }
    await this.stripeService.handleWebhook(req.rawBody, signature, { requestId });
    return { received: true };
  }
}
