import { IsIn } from 'class-validator';
import { tenantOfferedPlans } from '../../stores/plans';

/**
 * Stripe checkout body (#173): the plan to subscribe to, constrained to the
 * plans a tenant may choose. Plan Gratis is not one of them; the service
 * refuses non-card plans such as Corporativo on its own.
 */
export class CheckoutDto {
  @IsIn(tenantOfferedPlans().map((plan) => plan.key))
  plan!: string;
}
