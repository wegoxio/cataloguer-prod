import { randomUUID } from 'crypto';

/**
 * The Stripe event ledger — three tables, plain documented SQL (#248, PR B).
 *
 *  - `stripe_events`: the VERIFIED event, once. Identity columns are
 *    immutable; only the attempt counter, the last-received time and the
 *    authorised `requires_action` resolution summary ever change.
 *  - `stripe_event_processings`: one row per run of the transition function
 *    that reached a result (the webhook's own processing, and every owner
 *    reapply). Written inside the transaction that produced the result, so
 *    the parent row always exists.
 *  - `stripe_webhook_deliveries`: one row per VERIFIED delivery whose fate is
 *    known — processed, duplicate or failed. Written in its own transaction
 *    after the event transaction ended, and deliberately without a foreign
 *    key: a failed delivery's event row was rolled back with it. Rejected
 *    (unsigned, forged) requests never reach this table (PRB-D1): they are
 *    logged and nothing else.
 *
 * The claim is `INSERT … ON CONFLICT DO NOTHING RETURNING`: a returned row
 * means this delivery owns the event; no row means a COMMITTED row already
 * exists. PostgreSQL makes a concurrent first delivery wait on the
 * uncommitted conflicting row until it commits (then this insert conflicts)
 * or aborts (then this insert succeeds). Nothing here inspects `xmax`, and no
 * uniqueness violation is part of the normal path: the partial unique index
 * on applied (type, object) is a backstop behind an explicit SELECT guard.
 */
export type EventDisposition = 'applied' | 'ignored' | 'requires_action';
export type ProcessingTrigger = 'webhook' | 'reapply' | 'settlement';
export type ProcessingBasis = 'event_payload' | 'stripe_retrieve';
export type ProcessingResult = 'applied' | 'ignored' | 'requires_action' | 'no_change';
export type DeliveryOutcome = 'processed' | 'duplicate' | 'failed';

export interface SqlExecutor {
  execute: (sql: string, params?: unknown[]) => Promise<any>;
}

export interface EventIdentity {
  eventId: string;
  eventType: string;
  eventCreatedAt: Date;
  livemode: boolean;
  apiVersion: string | null;
  stripeIdempotencyKey: string | null;
  objectType: string;
  objectId: string;
  subscriptionId: string | null;
  organizationId: string | null;
}

export interface ExistingEvent {
  eventId: string;
  eventType: string;
  objectType: string;
  objectId: string;
  subscriptionId: string | null;
  organizationId: string | null;
  disposition: EventDisposition;
  reasonCode: string;
  attemptCount: number;
  resolvedAt: Date | null;
}

const EXISTING_COLUMNS = `event_id as "eventId", event_type as "eventType", object_type as "objectType", object_id as "objectId",
  subscription_id as "subscriptionId", organization_id as "organizationId", disposition, reason_code as "reasonCode",
  attempt_count as "attemptCount", resolved_at as "resolvedAt"`;

/** Autocommit: the fast path. A committed row means the event is settled. */
export async function findExistingEvent(db: SqlExecutor, eventId: string): Promise<ExistingEvent | null> {
  const rows: ExistingEvent[] = await db.execute(`select ${EXISTING_COLUMNS} from stripe_events where event_id = ?`, [
    eventId,
  ]);
  return rows[0] ?? null;
}

/** Autocommit: the only mutation a duplicate delivery may make to the event row. */
export async function recordRedelivery(db: SqlExecutor, eventId: string): Promise<ExistingEvent | null> {
  const rows: ExistingEvent[] = await db.execute(
    `update stripe_events set attempt_count = attempt_count + 1, last_received_at = now()
      where event_id = ? returning ${EXISTING_COLUMNS}`,
    [eventId],
  );
  return rows[0] ?? null;
}

/**
 * Inside the event transaction. Returns the claim token when this transaction
 * owns the event, or null when a committed row already existed. The
 * placeholder disposition is overwritten by `finalizeEvent` before commit;
 * a rolled-back transaction leaves no row at all.
 */
export async function claimEvent(tx: SqlExecutor, identity: EventIdentity, requestId: string): Promise<string | null> {
  const token = randomUUID();
  const rows: { event_id: string }[] = await tx.execute(
    `insert into stripe_events (
       event_id, event_type, event_created_at, livemode, api_version, stripe_idempotency_key,
       object_type, object_id, subscription_id, organization_id, claim_token,
       first_request_id, first_seen_at, attempt_count, last_received_at,
       disposition, reason_code, disposed_at
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::uuid, ?::uuid, ?, now(), 1, now(), 'ignored', 'pending', now())
     on conflict (event_id) do nothing
     returning event_id`,
    [
      identity.eventId,
      identity.eventType,
      identity.eventCreatedAt,
      identity.livemode,
      identity.apiVersion,
      identity.stripeIdempotencyKey,
      identity.objectType,
      identity.objectId,
      identity.subscriptionId,
      identity.organizationId,
      token,
      requestId,
    ],
  );
  return rows.length === 1 ? token : null;
}

/** Inside the event transaction, last statement before commit. */
export async function finalizeEvent(
  tx: SqlExecutor,
  input: {
    eventId: string;
    claimToken: string;
    disposition: EventDisposition;
    reasonCode: string;
    organizationId: string | null;
  },
): Promise<void> {
  const rows: { event_id: string }[] = await tx.execute(
    `update stripe_events
        set disposition = ?, reason_code = ?, organization_id = ?::uuid, disposed_at = now()
      where event_id = ? and claim_token = ?::uuid
      returning event_id`,
    [input.disposition, input.reasonCode, input.organizationId, input.eventId, input.claimToken],
  );
  if (rows.length !== 1) throw new Error('stripe_events finalisation did not match the claimed row');
}

/** Inside the reapply transaction: the event row, locked. */
export async function lockEventForReapply(tx: SqlExecutor, eventId: string): Promise<ExistingEvent | null> {
  const rows: ExistingEvent[] = await tx.execute(
    `select ${EXISTING_COLUMNS} from stripe_events where event_id = ? for update`,
    [eventId],
  );
  return rows[0] ?? null;
}

/** Inside the reapply transaction: the only authorised move of a disposition. */
export async function resolveEvent(
  tx: SqlExecutor,
  input: {
    eventId: string;
    disposition: EventDisposition;
    reasonCode: string;
    resolvedByUserId: string;
    resolutionCode: string;
  },
): Promise<void> {
  const rows: { event_id: string }[] = await tx.execute(
    `update stripe_events
        set disposition = ?, reason_code = ?, disposed_at = now(),
            resolved_at = now(), resolved_by_user_id = ?::uuid, resolution_code = ?
      where event_id = ? and disposition = 'requires_action' and resolved_at is null
      returning event_id`,
    [input.disposition, input.reasonCode, input.resolvedByUserId, input.resolutionCode, input.eventId],
  );
  if (rows.length !== 1) throw new Error('stripe_events resolution did not match an open requires_action row');
}

export interface ProcessingRow {
  eventId: string;
  trigger: ProcessingTrigger;
  basis: ProcessingBasis;
  actorUserId: string | null;
  requestId: string;
  startedAt: Date;
  result: ProcessingResult;
  reasonCode: string;
  retrievedSubscriptionStatus: string | null;
  retrievedAt: Date | null;
  effect: string;
  paymentId: string | null;
  auditLogId: string | null;
  localStateBefore: Record<string, unknown>;
  localStateAfter: Record<string, unknown>;
}

/** Inside the transaction that produced the result. */
export async function insertProcessing(tx: SqlExecutor, row: ProcessingRow): Promise<void> {
  await tx.execute(
    `insert into stripe_event_processings (
       event_id, trigger, basis, actor_user_id, request_id, started_at, finished_at,
       result, reason_code, retrieved_subscription_status, retrieved_at, effect,
       payment_id, audit_log_id, local_state_before, local_state_after
     ) values (?, ?, ?, ?::uuid, ?, ?, now(), ?, ?, ?, ?, ?, ?::uuid, ?::uuid, ?::jsonb, ?::jsonb)`,
    [
      row.eventId,
      row.trigger,
      row.basis,
      row.actorUserId,
      row.requestId,
      row.startedAt,
      row.result,
      row.reasonCode,
      row.retrievedSubscriptionStatus,
      row.retrievedAt,
      row.effect,
      row.paymentId,
      row.auditLogId,
      JSON.stringify(row.localStateBefore),
      JSON.stringify(row.localStateAfter),
    ],
  );
}

export interface DeliveryRow {
  requestId: string;
  receivedAt: Date;
  durationMs: number;
  outcome: DeliveryOutcome;
  eventId: string;
  eventType: string;
  livemode: boolean;
  errorName: string | null;
  sqlState: string | null;
}

/** Autocommit, after the event transaction ended. Verified identifiers only. */
export async function insertDelivery(db: SqlExecutor, row: DeliveryRow): Promise<void> {
  await db.execute(
    `insert into stripe_webhook_deliveries (
       request_id, received_at, duration_ms, outcome, event_id, event_type, livemode, error_name, sql_state
     ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.requestId,
      row.receivedAt,
      row.durationMs,
      row.outcome,
      row.eventId,
      row.eventType,
      row.livemode,
      row.errorName,
      row.sqlState,
    ],
  );
}

/** Inside the transaction, under the object lock: the explicit guard behind the partial unique index. */
export async function objectAlreadyApplied(tx: SqlExecutor, eventType: string, objectId: string): Promise<boolean> {
  const rows: { one: number }[] = await tx.execute(
    `select 1 as one from stripe_events where event_type = ? and object_id = ? and disposition = 'applied' limit 1`,
    [eventType, objectId],
  );
  return rows.length > 0;
}

/** Inside the transaction, under the object lock: the guard for the payments constraints. */
export async function invoiceAlreadyRecorded(tx: SqlExecutor, invoiceId: string): Promise<boolean> {
  const rows: { one: number }[] = await tx.execute(
    `select 1 as one from payments where stripe_invoice_id = ? limit 1`,
    [invoiceId],
  );
  return rows.length > 0;
}

/** Transaction-scoped advisory locks; released at commit or rollback. */
export async function lockObject(tx: SqlExecutor, objectType: string, objectId: string): Promise<void> {
  await tx.execute(`select pg_advisory_xact_lock(hashtextextended(?, 0))`, [`stripe-object:${objectType}:${objectId}`]);
}
