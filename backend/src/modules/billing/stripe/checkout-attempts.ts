import type { SqlExecutor } from './stripe-event-ledger';

/**
 * The durable checkout attempt (#248, PR C). Plain SQL like the ledger: the
 * rows are an operational record, not domain entities, and every statement
 * names the organization so a row can never be read or moved across tenants.
 *
 * States: `creating` → `open` → `completed` | `expired`; `creating` → `failed`.
 * `settleAttempt` moves ONLY rows that are still `creating`/`open` and reports
 * whether it moved one, so two settlements of the same attempt (a webhook and a
 * retrieval, say) record it once and the second is a no-op by construction.
 */
export type AttemptStatus = 'creating' | 'open' | 'completed' | 'expired' | 'failed';

export interface CheckoutAttempt {
  id: string;
  organizationId: string;
  plan: string;
  status: AttemptStatus;
  stripeIdempotencyKey: string;
  /** Null until recorded once, after the attempt committed and before the session is requested (#318). */
  requestParams: Record<string, unknown> | null;
  /** Null until the customer is resolved, which happens only after the attempt committed (#318). */
  stripeCustomerId: string | null;
  stripeSessionId: string | null;
  sessionUrl: string | null;
  sessionExpiresAt: Date | null;
  completedEventId: string | null;
  settleNote: string | null;
  failureCode: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  /** Last movement: the re-issue claim bumps it, so joiners see a young row. */
  updatedAt: Date;
}

const COLUMNS = `id, organization_id, plan, status, stripe_idempotency_key, request_params, stripe_customer_id,
  stripe_session_id, session_url, session_expires_at, completed_event_id, settle_note, failure_code,
  created_by_user_id, created_at, updated_at`;

function mapRow(row: any): CheckoutAttempt {
  return {
    id: row.id,
    organizationId: row.organization_id,
    plan: row.plan,
    status: row.status,
    stripeIdempotencyKey: row.stripe_idempotency_key,
    requestParams:
      row.request_params === null || row.request_params === undefined
        ? null
        : typeof row.request_params === 'string'
          ? JSON.parse(row.request_params)
          : row.request_params,
    stripeCustomerId: row.stripe_customer_id ?? null,
    stripeSessionId: row.stripe_session_id ?? null,
    sessionUrl: row.session_url ?? null,
    sessionExpiresAt: row.session_expires_at ? new Date(row.session_expires_at) : null,
    completedEventId: row.completed_event_id ?? null,
    settleNote: row.settle_note ?? null,
    failureCode: row.failure_code ?? null,
    createdByUserId: row.created_by_user_id ?? null,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/** The organization's attempt that is still `creating` or `open`, if any (at most one exists). */
export async function findOpenAttempt(db: SqlExecutor, organizationId: string): Promise<CheckoutAttempt | null> {
  const rows = await db.execute(
    `select ${COLUMNS} from billing_checkout_attempts
       where organization_id = ?::uuid and status in ('creating', 'open')
       order by created_at desc limit 1`,
    [organizationId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function findAttemptById(
  db: SqlExecutor,
  organizationId: string,
  attemptId: string,
): Promise<CheckoutAttempt | null> {
  const rows = await db.execute(
    `select ${COLUMNS} from billing_checkout_attempts where organization_id = ?::uuid and id = ?::uuid`,
    [organizationId, attemptId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/** The attempt a Stripe session belongs to — for the webhook, which knows the session, not the company. */
export async function findAttemptBySession(db: SqlExecutor, sessionId: string): Promise<CheckoutAttempt | null> {
  const rows = await db.execute(`select ${COLUMNS} from billing_checkout_attempts where stripe_session_id = ?`, [
    sessionId,
  ]);
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Inside the organization's transaction, under its lock (#318). The attempt is
 * recorded BEFORE any side-effecting Stripe call, so it carries no customer and
 * no request yet: committing it is how checkout wins against a concurrent Plan
 * Gratis assignment. The key is derived from the id, so a re-issue is the same
 * request by construction.
 */
export async function insertCreatingAttempt(
  tx: SqlExecutor,
  input: { organizationId: string; plan: string; createdByUserId: string | null },
): Promise<CheckoutAttempt> {
  const [{ id }]: { id: string }[] = await tx.execute(`select gen_random_uuid() as id`);
  const rows = await tx.execute(
    `insert into billing_checkout_attempts (
       id, organization_id, plan, status, stripe_idempotency_key, request_params, stripe_customer_id, created_by_user_id
     ) values (?::uuid, ?::uuid, ?, 'creating', ?, null, null, ?::uuid)
     returning ${COLUMNS}`,
    [id, input.organizationId, input.plan, `checkout:${id}`, input.createdByUserId],
  );
  return mapRow(rows[0]);
}

/**
 * Records the attempt's customer and exact session request ONCE, with no lock
 * held and no transaction open across Stripe. Only a still-`creating` attempt
 * whose request is not yet recorded moves, so a concurrent re-issuer cannot
 * overwrite it; the loser reads back and uses the recorded request.
 */
export async function freezeAttemptRequest(
  db: SqlExecutor,
  organizationId: string,
  attemptId: string,
  stripeCustomerId: string,
  requestParams: Record<string, unknown>,
): Promise<CheckoutAttempt | null> {
  const rows = await db.execute(
    `update billing_checkout_attempts
       set stripe_customer_id = ?, request_params = ?::jsonb, updated_at = now()
       where organization_id = ?::uuid and id = ?::uuid and status = 'creating' and request_params is null
       returning ${COLUMNS}`,
    [stripeCustomerId, JSON.stringify(requestParams), organizationId, attemptId],
  );
  if (rows[0]) return mapRow(rows[0]);
  return findAttemptById(db, organizationId, attemptId);
}

/**
 * Under the organization's lock: claims the re-issue of a stale `creating`
 * attempt by bumping `updated_at`, so concurrent callers see a young row and
 * JOIN instead of re-issuing the same key at the same time.
 */
export async function claimReissue(tx: SqlExecutor, organizationId: string, attemptId: string): Promise<boolean> {
  const rows = await tx.execute(
    `update billing_checkout_attempts set updated_at = now()
       where organization_id = ?::uuid and id = ?::uuid and status = 'creating' returning id`,
    [organizationId, attemptId],
  );
  return rows.length === 1;
}

/** `creating` → `open`, once Stripe has answered. Only a `creating` row moves. */
export async function markAttemptOpen(
  db: SqlExecutor,
  organizationId: string,
  attemptId: string,
  session: { id: string; url: string; expiresAt: Date | null },
): Promise<boolean> {
  const rows = await db.execute(
    `update billing_checkout_attempts
       set status = 'open', stripe_session_id = ?, session_url = ?, session_expires_at = ?, updated_at = now()
       where organization_id = ?::uuid and id = ?::uuid and status = 'creating'
       returning id`,
    [session.id, session.url, session.expiresAt, organizationId, attemptId],
  );
  return rows.length === 1;
}

export type Settlement =
  | { status: 'completed'; completedEventId: string | null; settleNote: string | null }
  | { status: 'expired'; settleNote: string | null }
  | { status: 'failed'; failureCode: string };

/**
 * Moves a still-open attempt to its terminal state. Returns false when the row
 * was already terminal (or is not this organization's), which is how a second
 * settlement stays a no-op. `completed` may also carry the session id when the
 * attempt never recorded one (a request that died before `markAttemptOpen`).
 * The hosted URL is cleared: it existed only to be handed to a joining caller.
 */
export async function settleAttempt(
  db: SqlExecutor,
  organizationId: string,
  attemptId: string,
  settlement: Settlement,
  sessionId: string | null = null,
): Promise<boolean> {
  const rows = await db.execute(
    `update billing_checkout_attempts
       set status = ?, settled_at = now(), updated_at = now(), session_url = null,
           completed_event_id = ?, settle_note = ?, failure_code = ?,
           stripe_session_id = coalesce(stripe_session_id, ?)
       where organization_id = ?::uuid and id = ?::uuid and status in ('creating', 'open')
       returning id`,
    [
      settlement.status,
      settlement.status === 'completed' ? settlement.completedEventId : null,
      settlement.status === 'failed' ? null : settlement.settleNote,
      settlement.status === 'failed' ? settlement.failureCode : null,
      sessionId,
      organizationId,
      attemptId,
    ],
  );
  return rows.length === 1;
}
