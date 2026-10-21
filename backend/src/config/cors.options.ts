/**
 * CORS policy for the API (#175 / P2-12).
 *
 * Two regimes, selected per-request by path:
 *
 *  - Open paths — the read-only Catalogue API (`/api/v1/public/...`) — must work from ANY client
 *    website. They authenticate with an `X-Api-Key`, never cookies, so the
 *    reflected origin carries NO credentials and a fixed, minimal header
 *    allowlist. `Authorization` and the `X-Managed-*` panel headers are
 *    deliberately absent: the panel does not talk to `/public` anymore.
 *
 *  - Everything else is the admin panel: locked to our own configured origins
 *    with credentials (the httpOnly refresh cookie), reflecting requested
 *    headers as before.
 *
 * The open-path test is an explicit boundary, not a bare prefix: `/publicX`
 * is NOT public and falls through to the panel regime.
 */

/** Request headers accepted on the open Catalogue API CORS regime. */
export const PUBLIC_ALLOWED_HEADERS = ['Content-Type', 'X-Api-Key', 'Idempotency-Key', 'X-Request-Id'];
/** Response headers a browser integrator may read on the open regime: the correlation id, so an error can be quoted. */
export const PUBLIC_EXPOSED_HEADERS = ['X-Request-Id'];

export interface CorsDelegateOptions {
  origin: boolean | string[];
  credentials: boolean;
  allowedHeaders?: string[];
  exposedHeaders?: string[];
}

/**
 * True only for the Catalogue API. The path is compared
 * exactly (query string and fragment stripped) so `/api/v1/publicX` — which is
 * not a public route — uses the panel regime.
 */
export function isOpenPath(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0];
  return path === '/api/v1/public' || path.startsWith('/api/v1/public/');
}

/** The per-request CORS options the `enableCors` delegate returns. */
export function corsOptionsFor(url: string, panelOrigins: string[]): CorsDelegateOptions {
  if (isOpenPath(url)) {
    return {
      origin: true,
      credentials: false,
      allowedHeaders: PUBLIC_ALLOWED_HEADERS,
      exposedHeaders: PUBLIC_EXPOSED_HEADERS,
    };
  }
  return { origin: panelOrigins, credentials: true };
}
