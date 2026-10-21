import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * One identifier per request, minted at the door.
 *
 * Until this existed the backend had no request identity at all — a rejected
 * API key produced no log line, and a log line could not have been correlated
 * with anything if it had. Every rejection record the guards now write carries
 * this id, and the response echoes it, so an integrator quoting the header
 * from their error and an operator reading Cloud Logging are talking about the
 * same request.
 *
 * An inbound `X-Request-Id` is kept when it is shaped like an identifier, so a
 * caller's own correlation id threads through — as a SEPARATE field. It is
 * DATA, not authority: bounded length and charset, because a header that ends
 * up in log queries must not be able to carry log-injection payloads or a
 * novel's worth of text.
 */
const INBOUND_ID = /^[A-Za-z0-9_.-]{8,128}$/;

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  // ALWAYS minted here. A caller's own id is carried beside it, never in its
  // place: an "attributable" record whose id the attacker chose — or copied
  // from a legitimate integrator's error — would attribute nothing.
  const minted = randomUUID();
  const inbound = req.headers['x-request-id'];
  const client = typeof inbound === 'string' && INBOUND_ID.test(inbound) ? inbound : null;
  const r = req as Request & { requestId: string; clientRequestId: string | null };
  r.requestId = minted;
  r.clientRequestId = client;
  res.setHeader('X-Request-Id', minted);
  next();
}

/** The server-minted id, for guards and interceptors. */
export function requestIdOf(req: unknown): string {
  return (req as { requestId?: string })?.requestId ?? 'unknown';
}

/** The caller's own correlation id, if it sent a well-formed one. */
export function clientRequestIdOf(req: unknown): string | null {
  return (req as { clientRequestId?: string | null })?.clientRequestId ?? null;
}
