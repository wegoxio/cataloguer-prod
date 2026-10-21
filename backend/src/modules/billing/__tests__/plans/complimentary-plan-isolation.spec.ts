import { ArgumentMetadata, BadRequestException, ValidationPipe } from '@nestjs/common';
import { PLANS, isComplimentaryPlan } from '../../../stores/plans';
import { PLAN_BY_LOOKUP_KEY } from '../../stripe/stripe-webhook-transition';
import { PLAN_LOOKUP } from '../../stripe/stripe.service';
import { CheckoutDto } from '../../dto/checkout.dto';

/**
 * STRIPE NEVER SEES PLAN GRATIS.
 *
 * Both directions of the price mapping are checked: a plan key that could be
 * sent to Stripe, and a Stripe price that could be mapped back onto a company.
 * Neither may name a complimentary plan, and every card plan must carry a real
 * price, so a zero-priced plan cannot become "purchasable" by being added to a map.
 */
const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
const meta = (metatype: any): ArgumentMetadata => ({ type: 'body', metatype, data: '' });

describe('complimentary plan isolation from Stripe', () => {
  it('no plan key sent to Stripe is complimentary, and each has a positive catalogue price', () => {
    for (const planKey of Object.keys(PLAN_LOOKUP)) {
      expect(isComplimentaryPlan(planKey)).toBe(false);
      expect(PLANS[planKey].priceUsd).toBeGreaterThan(0);
    }
    expect(PLAN_LOOKUP).not.toHaveProperty('GRATIS');
  });

  it('no Stripe price maps back onto a complimentary plan', () => {
    for (const planKey of Object.values(PLAN_BY_LOOKUP_KEY)) {
      expect(isComplimentaryPlan(planKey)).toBe(false);
    }
    expect(Object.values(PLAN_BY_LOOKUP_KEY)).not.toContain('GRATIS');
  });

  it('the two directions agree exactly', () => {
    for (const [planKey, lookupKey] of Object.entries(PLAN_LOOKUP)) {
      expect(PLAN_BY_LOOKUP_KEY[lookupKey]).toBe(planKey);
    }
    expect(Object.keys(PLAN_BY_LOOKUP_KEY).length).toBe(Object.keys(PLAN_LOOKUP).length);
  });

  it('the checkout body refuses Plan Gratis at validation, before any service code runs', async () => {
    await expect(pipe.transform({ plan: 'GRATIS' }, meta(CheckoutDto))).rejects.toBeInstanceOf(BadRequestException);
  });
});
