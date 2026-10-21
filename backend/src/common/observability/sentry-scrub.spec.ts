import { scrubSentryEvent } from './sentry-scrub';

describe('what may never leave for Sentry', () => {
  const event = () => ({
    request: {
      cookies: { refresh_token: 'SECRET-COOKIE' },
      data: { password: 'SECRET-BODY' },
      query_string: 'api_key=ck_SECRET-IN-QUERY',
      url: 'https://api.example.test/api/v1/public/products?api_key=ck_SECRET-IN-QUERY',
      headers: {
        authorization: 'Bearer SECRET-JWT',
        'x-api-key': 'ck_SECRET-API-KEY',
        'X-API-KEY': 'ck_SECRET-UPPER',
        'Proxy-Authorization': 'Basic SECRET-PROXY',
        cookie: 'refresh_token=SECRET',
        'stripe-signature': 't=1756700000,v1=SECRET-STRIPE-SIG',
        'Stripe-Signature': 't=1756700000,v1=SECRET-STRIPE-SIG-CASED',
        'user-agent': 'kept',
      } as Record<string, unknown>,
    },
  });

  it('strips cookies, body data, authorization AND the API key header', () => {
    // The x-api-key deletion is the regression this file exists for: the
    // previous inline scrubber missed it, so a 500 on /public would have
    // shipped a customer plaintext key to a third party.
    const scrubbed = scrubSentryEvent(event());
    expect(scrubbed.request?.cookies).toBeUndefined();
    expect(scrubbed.request?.data).toBeUndefined();
    expect(scrubbed.request?.headers?.authorization).toBeUndefined();
    expect(scrubbed.request?.headers?.['x-api-key']).toBeUndefined();
    expect(scrubbed.request?.headers?.cookie).toBeUndefined();
  });

  it('strips the Stripe webhook signature header, whatever its casing', () => {
    // A 500 inside the webhook handler would otherwise ship the signature
    // (and, through `data`, the signed body) to Sentry with the event.
    const scrubbed = scrubSentryEvent(event());
    expect(scrubbed.request?.headers?.['stripe-signature']).toBeUndefined();
    expect(scrubbed.request?.headers?.['Stripe-Signature']).toBeUndefined();
  });

  it('drops the query string and truncates the URL at ?, keeping the path', () => {
    const scrubbed = scrubSentryEvent(event());
    expect(scrubbed.request?.query_string).toBeUndefined();
    expect(scrubbed.request?.url).toBe('https://api.example.test/api/v1/public/products');
  });

  it('keeps non-credential headers, so events stay diagnosable', () => {
    expect(scrubSentryEvent(event()).request?.headers?.['user-agent']).toBe('kept');
  });

  it('leaves no credential material anywhere in the serialized event', () => {
    const s = JSON.stringify(scrubSentryEvent(event()));
    for (const secret of [
      'SECRET-COOKIE',
      'SECRET-BODY',
      'SECRET-JWT',
      'SECRET-API-KEY',
      'SECRET-IN-QUERY',
      'SECRET-UPPER',
      'SECRET-PROXY',
      'SECRET-STRIPE-SIG',
    ]) {
      expect(s).not.toContain(secret);
    }
  });

  it('tolerates events with no request at all', () => {
    expect(() => scrubSentryEvent({} as never)).not.toThrow();
  });
});
