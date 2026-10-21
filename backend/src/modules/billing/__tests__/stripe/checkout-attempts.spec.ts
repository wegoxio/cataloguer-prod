import { classifyStripeFailure } from '../../stripe/stripe.service';
import { stripeCheckoutAttempt, stripeCheckoutRequiresAction } from '../../stripe/stripe-webhook-record';

/**
 * The two pieces of PR C that need no database: how a Stripe failure is
 * classified (definite refusal vs. unknown outcome — the difference between
 * ending an attempt and re-issuing it), and the shape of the checkout records.
 */
describe('classifyStripeFailure (#248 PR C)', () => {
  const err = (over: Record<string, unknown>) => Object.assign(new Error('SECRET-DRIVER-MESSAGE'), over);

  it('a connection error, a 5xx and a rate limit are UNKNOWN outcomes: the attempt stays creating', () => {
    expect(classifyStripeFailure(err({ type: 'StripeConnectionError' }))).toEqual({
      code: 'StripeConnectionError',
      definite: false,
    });
    expect(classifyStripeFailure(err({ type: 'StripeAPIError', statusCode: 502 }))).toMatchObject({ definite: false });
    expect(classifyStripeFailure(err({ type: 'StripeRateLimitError', statusCode: 429 }))).toMatchObject({
      definite: false,
    });
    expect(classifyStripeFailure(new TypeError('fetch failed'))).toEqual({ code: 'unknown', definite: false });
  });

  it('an invalid request, an idempotency conflict, a card, auth or permission error are DEFINITE: the attempt fails', () => {
    for (const type of [
      'StripeInvalidRequestError',
      'StripeCardError',
      'StripeAuthenticationError',
      'StripePermissionError',
    ]) {
      expect(classifyStripeFailure(err({ type, statusCode: 400 }))).toEqual({ code: type, definite: true });
    }
    expect(classifyStripeFailure(err({ code: 'resource_missing', statusCode: 404 }))).toEqual({
      code: 'resource_missing',
      definite: true,
    });
  });

  it('an idempotency conflict is definite only when the params differ (400); a key in use (409) is unknown', () => {
    expect(classifyStripeFailure(err({ type: 'StripeIdempotencyError', statusCode: 400 }))).toEqual({
      code: 'StripeIdempotencyError',
      definite: true,
    });
    expect(classifyStripeFailure(err({ type: 'StripeIdempotencyError', statusCode: 409 }))).toEqual({
      code: 'StripeIdempotencyError',
      definite: false,
    });
  });

  it('never carries the message', () => {
    for (const over of [{ type: 'StripeConnectionError' }, { type: 'StripeInvalidRequestError' }, {}]) {
      expect(JSON.stringify(classifyStripeFailure(err(over)))).not.toContain('SECRET');
    }
  });
});

describe('checkout records (#248 PR C)', () => {
  it('stripe_checkout_attempt carries identifiers and the outcome only', () => {
    const line = stripeCheckoutAttempt({
      requestId: 'req-1',
      organizationId: 'org-1',
      attemptId: 'att-1',
      sessionId: 'cs_test_1',
      outcome: 'created',
      reason: null,
      durationMs: 12,
    });
    expect(JSON.parse(line)).toEqual({
      event: 'stripe_checkout_attempt',
      requestId: 'req-1',
      organizationId: 'org-1',
      attemptId: 'att-1',
      sessionId: 'cs_test_1',
      outcome: 'created',
      reason: null,
      durationMs: 12,
    });
    expect(Object.keys(JSON.parse(line))).not.toContain('url');
  });

  it('stripe_checkout_requires_action names the company, the attempt and the reason', () => {
    expect(
      JSON.parse(
        stripeCheckoutRequiresAction({
          requestId: 'req-2',
          organizationId: 'org-1',
          attemptId: null,
          reason: 'ambiguous_customer',
        }),
      ),
    ).toEqual({
      event: 'stripe_checkout_requires_action',
      requestId: 'req-2',
      organizationId: 'org-1',
      attemptId: null,
      reason: 'ambiguous_customer',
    });
  });
});
