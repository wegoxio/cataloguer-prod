/**
 * What may never leave for Sentry.
 *
 * Extracted from main.ts so it can be TESTED — the previous inline version
 * deleted `authorization` but not `x-api-key`, which meant any genuine 500 on
 * a `/public` route would have shipped a customer's plaintext API key to a
 * third-party service, contradicting ADR 005's "the key is never logged".
 * Cookies carry the refresh token, `data` carries request bodies (passwords on
 * /auth/login), so both go wholesale.
 *
 * `stripe-signature` is an HMAC over the webhook body under the endpoint's
 * signing secret. It is not reusable by itself, but it is signing material
 * and it names the timestamp/body pair it covers; a third party has no
 * business holding it.
 */
interface SentryRequestLike {
  request?: {
    cookies?: unknown;
    data?: unknown;
    query_string?: unknown;
    url?: string;
    headers?: Record<string, unknown>;
  };
}

const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'stripe-signature',
]);

export function scrubSentryEvent<T extends SentryRequestLike>(event: T): T {
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;
    // A query string is where a misused credential would sit. The URL keeps
    // its path (diagnosable) and loses everything after `?`.
    delete event.request.query_string;
    if (typeof event.request.url === 'string') event.request.url = event.request.url.split('?')[0];
    if (event.request.headers) {
      // By lowercase NAME, whatever casing arrived: a fixed-literal delete
      // would keep `X-API-Key` or `Proxy-Authorization` alive.
      for (const key of Object.keys(event.request.headers)) {
        if (CREDENTIAL_HEADERS.has(key.toLowerCase())) delete event.request.headers[key];
      }
    }
  }
  return event;
}
