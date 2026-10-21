/**
 * What a webhook delivery leaves in the log, and nothing else.
 *
 * Until PR A the handler wrote `Stripe webhook handled: <type>` for every
 * accepted delivery — including deliveries it had silently dropped and types
 * it does not handle. There was no event id, and "handled" did not mean
 * anything had happened.
 *
 * Every record here is a fixed set of IDENTIFIERS and LABELS. The allow-list
 * is the whole point: no payload, no metadata values, no customer email, no
 * hosted invoice URL, no signature header, no error message text. The
 * disposition says what the handler actually did — `applied` only when a
 * business write was committed, `ignored` when the delivery was accepted and
 * deliberately not acted on, `requires_action` when a paid customer's
 * entitlement is unresolved and durably recorded for the owner, `duplicate`
 * when the event was already settled, `unhandled` when the type has no
 * handler.
 */
export type WebhookDisposition = 'applied' | 'ignored' | 'requires_action' | 'duplicate' | 'unhandled';

export interface WebhookOutcome {
  disposition: WebhookDisposition;
  /** A short label from a fixed vocabulary — never free text from the event. */
  reason: string;
  /** Our organization id when the event resolved to one, else null. */
  organizationId?: string | null;
}

interface EventLike {
  id?: unknown;
  type?: unknown;
  livemode?: unknown;
  data?: { object?: unknown };
}

/** The Stripe object id the event speaks about (`cs_…`, `in_…`, `sub_…`), if any. */
export function stripeObjectId(event: EventLike): string | null {
  const id = (event.data?.object as { id?: unknown } | undefined)?.id;
  return typeof id === 'string' ? id : null;
}

export function stripeWebhookRecord(input: {
  requestId: string;
  event: EventLike;
  objectId: string | null;
  outcome: WebhookOutcome;
  durationMs: number;
}): string {
  const { event, outcome } = input;
  return JSON.stringify({
    event: 'stripe_webhook',
    requestId: input.requestId,
    eventId: typeof event.id === 'string' ? event.id : null,
    eventType: typeof event.type === 'string' ? event.type : null,
    livemode: typeof event.livemode === 'boolean' ? event.livemode : null,
    objectId: input.objectId,
    organizationId: outcome.organizationId ?? null,
    disposition: outcome.disposition,
    reason: outcome.reason,
    durationMs: input.durationMs,
  });
}

export type WebhookRejection = 'missing_signature_or_body' | 'not_configured' | 'invalid_signature';

/** A delivery refused at the door: no event was parsed, so there is no event id to give. */
export function stripeWebhookRejected(requestId: string, reason: WebhookRejection): string {
  return JSON.stringify({ event: 'stripe_webhook_rejected', requestId, reason });
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The error class and SQLSTATE, never the message: driver messages quote the offending values. */
export function errorClassification(error: unknown): { errorName: string; sqlState: string | null } {
  const err = error as {
    constructor?: { name?: string };
    code?: unknown;
    driverError?: { code?: unknown };
  } | null;
  const code = err?.code ?? err?.driverError?.code;
  return {
    errorName: err?.constructor?.name ?? 'Error',
    sqlState: typeof code === 'string' && SQLSTATE.test(code) ? code : null,
  };
}

/**
 * A handler that threw. The class name and SQLSTATE are enough to tell a
 * transient database failure from a code defect; the message is not logged
 * because driver messages quote the offending values.
 */
export function stripeWebhookFailed(input: {
  requestId: string;
  event: EventLike;
  objectId: string | null;
  error: unknown;
}): string {
  return JSON.stringify({
    event: 'stripe_webhook_failed',
    requestId: input.requestId,
    eventId: typeof input.event.id === 'string' ? input.event.id : null,
    eventType: typeof input.event.type === 'string' ? input.event.type : null,
    objectId: input.objectId,
    ...errorClassification(input.error),
  });
}

/**
 * The event transaction COMMITTED, then the delivery record could not be
 * written. The effect stands and must never be repeated; the retry Stripe
 * sends takes the duplicate fast path. This record is what keeps the missing
 * delivery row observable.
 */
export function stripeWebhookDeliveryRecordFailed(input: {
  requestId: string;
  event: EventLike;
  outcome: WebhookOutcome;
  error: unknown;
}): string {
  return JSON.stringify({
    event: 'stripe_webhook_delivery_record_failed',
    requestId: input.requestId,
    eventId: typeof input.event.id === 'string' ? input.event.id : null,
    eventType: typeof input.event.type === 'string' ? input.event.type : null,
    disposition: input.outcome.disposition,
    reason: input.outcome.reason,
    ...errorClassification(input.error),
  });
}

/** A paid customer's entitlement is unresolved: the alert-worthy record. */
export function stripeWebhookRequiresAction(input: {
  requestId: string;
  eventId: string;
  eventType: string;
  objectId: string | null;
  organizationId: string | null;
  reason: string;
}): string {
  return JSON.stringify({ event: 'stripe_webhook_requires_action', ...input });
}

/** An owner reapply that threw: class and SQLSTATE only, then an opaque 500. */
export function stripeEventReapplyFailed(input: {
  requestId: string;
  eventId: string;
  actorUserId: string;
  error: unknown;
}): string {
  return JSON.stringify({
    event: 'stripe_event_reapply_failed',
    requestId: input.requestId,
    eventId: input.eventId,
    actorUserId: input.actorUserId,
    ...errorClassification(input.error),
  });
}

/** An owner reapply, whatever it concluded. */
export function stripeEventReapplied(input: {
  requestId: string;
  eventId: string;
  eventType: string;
  actorUserId: string;
  result: string;
  reason: string;
}): string {
  return JSON.stringify({ event: 'stripe_event_reapplied', ...input });
}

// ── checkout attempts (#248, PR C) ──────────────────────────────────────────

export type CheckoutAttemptOutcome =
  | 'created'
  | 'reused'
  | 'reissued'
  | 'joined'
  | 'settled_completed'
  | 'settled_expired'
  | 'refused'
  | 'failed'
  | 'unavailable';

/**
 * One record per `POST /billing/checkout`. Identifiers only: the attempt id,
 * the company, the Stripe session id when one exists. Never the session URL
 * (it is the credential to the hosted page), never a customer email.
 */
export function stripeCheckoutAttempt(input: {
  requestId: string;
  organizationId: string;
  attemptId: string | null;
  sessionId: string | null;
  outcome: CheckoutAttemptOutcome;
  reason: string | null;
  durationMs: number;
}): string {
  return JSON.stringify({ event: 'stripe_checkout_attempt', ...input });
}

/**
 * Warn-level and alert-worthy: a paying company's checkout could not proceed
 * and the reason needs a person (an ambiguous customer, a live subscription
 * the ledger never saw, a completed session whose event Stripe no longer
 * lists). Separate from `stripe_webhook_requires_action` because no Stripe
 * event exists to carry it.
 */
export function stripeCheckoutRequiresAction(input: {
  requestId: string;
  organizationId: string;
  attemptId: string | null;
  reason: string;
}): string {
  return JSON.stringify({ event: 'stripe_checkout_requires_action', ...input });
}

/**
 * One record per reconciliation report run (#248, PR D). Counts and bounds
 * only: the report's own rows are returned to the caller, never logged, so a
 * finding cannot reach a log line by this route.
 */
export function stripeReconcileRecord(input: {
  requestId: string;
  outcome: 'ok' | 'stripe_unavailable' | 'database_unavailable';
  reason: string | null;
  organizationsScanned: number;
  subscriptionsScanned: number;
  stripePagesRead: number;
  findings: number;
  durationMs: number;
  /** Whether the run covered everything. A capped run must never read as clean. */
  coverageComplete?: boolean;
}): string {
  return JSON.stringify({ event: 'stripe_reconcile_report', ...input });
}
