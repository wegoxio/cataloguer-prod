import * as Sentry from '@sentry/nextjs';
import { coordinateRefresh, type CoordinatedRefreshResult } from './auth-tab-coordinator';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001/api/v1';

export interface FetchOptions extends RequestInit {
  token?: string;
}

export interface ApiEnvelope<T> {
  data: T;
  message?: string;
}

export interface ApiPage<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export class ApiError<TBody = unknown> extends Error {
  readonly status: number;
  readonly body: TBody | null;

  constructor(message: string, status: number, body: TBody | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export const isApiError = (error: unknown): error is ApiError => error instanceof ApiError;

// The AuthProvider registers a callback so a background refresh updates
// the session state without the user noticing.
let onTokenRefreshed: ((token: string) => void) | null = null;
export function registerTokenRefreshHandler(handler: (token: string) => void) {
  onTokenRefreshed = handler;
}

/**
 * The missing half of the refresh contract: what happens when the refresh
 * itself is REFUSED.
 *
 * A background 401 whose refresh came back 401/403 means the server judged the
 * session dead — revoked, expired, reused, or the user deactivated. Before
 * this hook existed that outcome was silently discarded: the request threw a
 * toast string, and the dashboard kept rendering the dead session's tenant
 * data indefinitely. Only REFUSAL fires this; a network failure resolves null
 * without firing, because a flaky connection is not a revoked session and must
 * not log anyone out.
 */
let onSessionLost: (() => void) | null = null;
let sessionGeneration = 0;
export function registerSessionLostHandler(handler: () => void) {
  onSessionLost = handler;
}

/** Makes every refresh already in flight observationally stale. */
export function advanceSessionGeneration(): void {
  sessionGeneration += 1;
}

// Single-flight: EVERY refresh in the tab shares one request. The refresh
// cookie ROTATES on use, so two concurrent POSTs are not merely wasteful —
// whichever lands second presents the already-rotated cookie, is answered
// 401, and logs a live session out. AuthProvider used to post its own
// refresh beside this one, and on a page load the pair raced exactly that
// way (surfaced by the Phase 8 browser matrix as an intermittent logout).
export type SessionRefreshResult = CoordinatedRefreshResult;

let refreshPromise: Promise<SessionRefreshResult> | null = null;

export function resetApiClientSessionForTests(): void {
  refreshPromise = null;
  sessionGeneration += 1;
  onTokenRefreshed = null;
  onSessionLost = null;
}

/**
 * The refresh, with the REASON it failed when it did. A refusal (401/403) is
 * the session being over; a network failure is the network. Callers that
 * clear session state must clear only on the former.
 */
export async function requestSessionRefreshResult(): Promise<SessionRefreshResult> {
  if (!refreshPromise) {
    const generation = sessionGeneration;
    // keepalive: a navigation that lands MID-ROTATION must not abort the
    // request after the server has already rotated the cookie — aborted
    // there, the fresh cookie is never stored and the next restore presents
    // a dead one, logging a live session out. With keepalive the response
    // (and its Set-Cookie) completes even while the page unloads.
    refreshPromise = coordinateRefresh(() => fetch(`${API_URL}/auth/refresh`, { method: 'POST', credentials: 'include', keepalive: true })
      .then(async (res): Promise<SessionRefreshResult> => {
        if (!res.ok) {
          // The server REFUSED the refresh credential: the session is over,
          // and everyone holding rendered session state needs to know now.
          if (res.status === 401 || res.status === 403) {
            return { ok: false, reason: 'refused' };
          }
          return { ok: false, reason: 'network' };
        }
        const json = await res.json().catch(() => null);
        const accessToken = json?.data?.accessToken ?? null;
        if (!accessToken) return { ok: false, reason: 'network' };
        return { ok: true, accessToken, user: json?.data?.user ?? null };
      })
      .catch((): SessionRefreshResult => ({ ok: false, reason: 'network' })))
      .then((result) => {
        if (generation !== sessionGeneration) return result;
        if (result.ok) onTokenRefreshed?.(result.accessToken);
        else if (result.reason === 'refused') onSessionLost?.();
        return result;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }
  return refreshPromise;
}

/** The session, or null — for callers that only need to know whether one exists. */
export async function requestSessionRefresh(): Promise<{ accessToken: string; user: unknown } | null> {
  const result = await requestSessionRefreshResult();
  return result.ok ? { accessToken: result.accessToken, user: result.user } : null;
}
async function refreshAccessToken(): Promise<string | null> {
  return (await requestSessionRefresh())?.accessToken ?? null;
}

const TECHNICAL = /fetch|network|cors|ECONN|socket|Internal server|Unexpected token|JSON/i;

const endpointName = (endpoint: string) => endpoint.split('?')[0];

function reportTransportFailure(endpoint: string, status: number, cause?: unknown): void {
  Sentry.captureException(cause instanceof Error ? cause : new Error(`API request failed (${status || 'network'})`), {
    tags: { layer: 'http', endpoint: endpointName(endpoint), status: String(status || 0) },
  });
}

function fallbackMessage(status: number): string {
  const es = window.localStorage?.getItem('wegox-lang') !== 'en';
  const map: Record<number, [string, string]> = {
    0: ['No hay conexión — revisa tu internet e inténtalo de nuevo.', 'No connection — check your internet and try again.'],
    400: ['Algo en los datos no es válido. Revísalos e inténtalo de nuevo.', 'Something in the data is not valid. Check it and try again.'],
    401: ['Tu sesión expiró — inicia sesión de nuevo.', 'Your session expired — sign in again.'],
    403: ['No tienes permiso para hacer esto.', 'You do not have permission to do this.'],
    404: ['No encontramos lo que buscas.', 'We could not find what you were looking for.'],
    409: ['Eso entra en conflicto con algo que ya existe.', 'That conflicts with something that already exists.'],
    429: ['Demasiados intentos — espera un momento y vuelve a intentarlo.', 'Too many attempts — wait a moment and try again.'],
    500: ['Algo salió mal de nuestro lado. Inténtalo de nuevo en unos minutos.', 'Something went wrong on our side. Try again in a few minutes.'],
  };
  const entry = map[status] ?? map[status >= 500 ? 500 : 400];
  return es ? entry[0] : entry[1];
}

/**
 * Does this endpoint carry the "Manage company" tenant context?
 *
 * AUTH IS EXCLUDED — EXCEPT `/auth/me` (corrected in P5-W5). The SESSION must
 * always stay the owner's own, so login, refresh, logout and every other
 * `/auth` route never carry a managed context. But `/auth/me` is not a session
 * operation: it is the call that ASKS what scope this request has, and it is
 * the only source of the resolved TenantScope the whole panel derives authority
 * from.
 *
 * Excluding it made "Manage company" structurally impossible to CONFIRM:
 * `/auth/me` answered with the owner's unscoped scope no matter what, so
 * `isPlatformManagingOrganization(scope)` was permanently false, and the
 * sidebar — which requires exactly that to admit catalogue work — hid every
 * catalogue module from the owner while the banner said it was managing a
 * company. The panel could not derive authority from the resolved scope,
 * because the resolved scope never described the mode it was in.
 *
 * The server still decides: `TenantScopeService` validates the header against
 * the actor's real authority and ignores it entirely for a tenant user, so a
 * stale or tampered value is refused, never trusted. This widens what the panel
 * ASKS, never what it is granted.
 *
 * Exported so the rule is testable on its own rather than only through a
 * mocked `fetch`.
 */
export function carriesTenantContext(endpoint: string): boolean {
  if (!endpoint.startsWith('/auth')) return true;
  // Exactly `/auth/me`, and `/auth/me?...` — never a route that merely starts
  // with those characters, such as a future `/auth/members`.
  return endpoint === '/auth/me' || endpoint.startsWith('/auth/me?');
}

/**
 * FormData must NOT carry an explicit Content-Type: the browser sets
 * `multipart/form-data` together with the boundary it generates, and naming the
 * type ourselves strips that boundary and makes the body unparseable. This is
 * why uploads used to bypass this client entirely (#179/#201) — and bypassing
 * it cost them token refresh, tenant headers and the shared error vocabulary.
 */
const isFormData = (body: unknown): boolean =>
  typeof FormData !== 'undefined' && body instanceof FormData;

async function doFetch(endpoint: string, token: string | undefined, options: RequestInit) {
  const headers: Record<string, string> = {};
  if (!isFormData(options.body)) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // "Manage company" mode (platform owner): scope every call to the managed
  // company. See `carriesTenantContext` for which endpoints do, and why.
  if (typeof window !== 'undefined' && carriesTenantContext(endpoint)) {
    try {
      // P0-11: the tenant context names the organization first; the store is
      // an optional narrowing inside it. Both are validated server-side.
      const managed = window.localStorage.getItem('wegox-managed-tenant');
      if (managed) {
        const tenant = JSON.parse(managed) as { organizationId: string; storeId?: string | null };
        headers['X-Managed-Organization'] = tenant.organizationId;
        if (tenant.storeId) headers['X-Managed-Store'] = tenant.storeId;
      }
    } catch {
      // corrupted state: behave as not managing
    }
  }
  return fetch(`${API_URL}${endpoint}`, {
    credentials: 'include', // Required to transmit httpOnly cookies (refreshToken)
    ...options,
    headers: { ...headers, ...(options.headers as Record<string, string> | undefined) },
  });
}

/**
 * THE request path (#179/#201). Every authenticated call to our own API goes
 * through here — JSON, multipart upload and binary download alike — so all
 * three inherit the same behaviour: the bearer token, the managed-tenant
 * headers, ONE shared token refresh with a transparent retry, and one error
 * vocabulary the user can actually read.
 *
 * Before this, uploads and CSV downloads used raw `fetch` with hand-attached
 * headers: an expired token failed them outright instead of refreshing, and
 * each site invented its own error text. The response KIND is the only thing
 * that varies, so it is the only thing the caller chooses.
 */
async function apiRequest(
  endpoint: string,
  options: FetchOptions & { responseType?: 'json' | 'blob' } = {},
): Promise<any> {
  const { token, responseType = 'json', ...rest } = options;

  let response: Response;
  try {
    response = await doFetch(endpoint, token, rest);
  } catch (cause) {
    reportTransportFailure(endpoint, 0, cause);
    throw new Error(fallbackMessage(0));
  }

  // Expired access token: refresh once (shared) and retry transparently.
  // A FormData body is a stream that a retry would consume twice, so the
  // caller's body is reused as-is — FormData is replayable, a ReadableStream
  // would not be, and we never send one.
  if (response.status === 401 && token && !endpoint.startsWith('/auth/')) {
    const freshToken = await refreshAccessToken();
    if (freshToken) {
      try {
        response = await doFetch(endpoint, freshToken, rest);
      } catch (cause) {
        reportTransportFailure(endpoint, 0, cause);
        throw new Error(fallbackMessage(0));
      }
    }
  }

  if (!response.ok) {
    // An error is ALWAYS read as JSON, whatever the caller asked for: a failed
    // download answers with a message, not with the file it could not send.
    const errorBody = await response.json().catch(() => null);
    const serverMessage = errorBody?.message;
    const message =
      typeof serverMessage === 'string' && serverMessage && !TECHNICAL.test(serverMessage) && response.status < 500
        ? serverMessage
        : fallbackMessage(response.status);
    const error = new ApiError(Array.isArray(serverMessage) ? serverMessage[0] : message, response.status, errorBody);
    if (response.status >= 500) reportTransportFailure(endpoint, response.status, error);
    /**
     * THE BODY TRAVELS WITH THE ERROR (#292).
     *
     * A message alone is enough for a toast, and for years that was all any
     * caller wanted. A refused removal is different: the server answers 409
     * with a LIST of blockers, and re-asking for them would show a second,
     * later reading of state — possibly a different one — instead of the
     * reasons this request was actually refused.
     *
     * Attached rather than thrown as a subclass, so nothing that reads
     * `error.message` today notices any change.
     */
    throw error;
  }

  if (responseType === 'blob') return response.blob();
  return response.json().catch(() => null);
}

export async function apiFetch<T = any>(endpoint: string, options: FetchOptions = {}): Promise<T> {
  return apiRequest(endpoint, options) as Promise<T>;
}

/**
 * A multipart upload (CSV import, supplier order file). The caller builds the
 * FormData; everything else is identical to any other authenticated call.
 */
export async function apiUpload<T = any>(endpoint: string, form: FormData, options: FetchOptions = {}): Promise<T> {
  return apiRequest(endpoint, { ...options, method: options.method ?? 'POST', body: form }) as Promise<T>;
}

/**
 * A binary download (CSV export). Returns the Blob; the caller decides what to
 * do with it. Failures arrive as the same readable errors as everything else
 * instead of a saved file containing an error page.
 */
export async function apiDownload(endpoint: string, options: FetchOptions = {}): Promise<Blob> {
  return apiRequest(endpoint, { ...options, responseType: 'blob' });
}

/** Saves a downloaded Blob under `filename`, cleaning up the object URL. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.URL.revokeObjectURL(url);
}
