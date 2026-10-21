import { ConfigService } from '@nestjs/config';
import { ConflictException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import Stripe = require('stripe');
import { randomUUID } from 'crypto';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { Store } from '../../../stores/entities/store.entity';
import { AuditLog } from '../../../audit-log/entities/audit-log.entity';
import { AuditLogService } from '../../../audit-log/audit-log.service';
import { StripeService } from '../../stripe/stripe.service';
import { markAttemptOpen, settleAttempt } from '../../stripe/checkout-attempts';

/**
 * #248, PR C — durable checkout attempts, on real PostgreSQL with a fake
 * Stripe that records every call, its parameters and its idempotency key.
 *
 * What is proven here and nowhere else: one attempt per operation and one
 * Stripe session per attempt; the same URL for concurrent callers (D-9); a
 * request that died is finished by the next one under the same key; a
 * completed session whose webhook never arrived is settled from Stripe's
 * event list THROUGH the ledger, so the later webhook is a duplicate; the
 * portal rule (D-5); customer adoption and the customer key; a live
 * subscription the ledger never saw is refused, not doubled; tenant isolation
 * of every attempt row; and the records never carry the hosted URL.
 */
const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;
const WEBHOOK_SECRET = 'whsec_test_offline_signature_helper_only';

d('#248 PR C — checkout attempts', () => {
  jest.setTimeout(300_000);
  let pg: DisposablePg;
  let em: EntityManager;
  let service: StripeService;
  const stripeLib = new Stripe('sk_test_offline_signature_helper_only');
  const actor = { id: randomUUID(), email: 'SECRET-EMAIL@example.test' };

  // ── the fake Stripe ──────────────────────────────────────────────────────
  type Session = {
    id: string;
    object: 'checkout.session';
    status: 'open' | 'complete' | 'expired';
    payment_status: 'unpaid' | 'paid';
    mode: 'subscription';
    url: string | null;
    customer: string;
    subscription: string | null;
    expires_at: number;
    metadata: Record<string, string>;
  };
  const sessions = new Map<string, Session>();
  const sessionsByKey = new Map<string, string>();
  const subscriptionsByCustomer = new Map<
    string,
    { id: string; status: string; organizationId: string; lookupKey: string }[]
  >();
  const events: Stripe.Event[] = [];
  const calls = {
    sessionsCreate: [] as { params: any; key: string | undefined }[],
    customersCreate: [] as string[],
    expire: [] as string[],
  };
  let searchResults: { id: string; metadata: Record<string, string> }[] = [];
  let failNextCreate: Record<string, unknown> | null = null;
  let failNextRetrieve: Record<string, unknown> | null = null;
  const customerUpdates: { id: string; email?: string }[] = [];
  let onCreate: (() => Promise<void>) | null = null;
  let sessionSeq = 0;
  const stripeErr = (over: Record<string, unknown>) => Object.assign(new Error('SECRET-DRIVER-MESSAGE'), over);

  const fakeStripe = {
    webhooks: stripeLib.webhooks,
    prices: { list: async (p: { lookup_keys: string[] }) => ({ data: [{ id: `price_${p.lookup_keys[0]}` }] }) },
    customers: {
      search: async () => ({ data: searchResults }),
      create: async (p: { email?: string }, o: { idempotencyKey?: string }) => {
        calls.customersCreate.push(o.idempotencyKey ?? '');
        if (p.email) throw new Error('the idempotent payload must not carry the actor email');
        return { id: `cus_created_${calls.customersCreate.length}` };
      },
      update: async (id: string, p: { email?: string }) => {
        customerUpdates.push({ id, ...p });
        return { id };
      },
    },
    subscriptions: {
      list: async (p: { customer: string }) => ({ data: subscriptionsByCustomer.get(p.customer) ?? [] }),
      retrieve: async (id: string) => {
        for (const [customer, subs] of subscriptionsByCustomer) {
          const s = subs.find((x) => x.id === id);
          if (s)
            return {
              id,
              object: 'subscription',
              status: s.status,
              customer,
              metadata: { organizationId: s.organizationId },
              items: { data: [{ price: { lookup_key: s.lookupKey } }] },
            };
        }
        throw stripeErr({ code: 'resource_missing', statusCode: 404 });
      },
    },
    checkout: {
      sessions: {
        create: async (params: any, o: { idempotencyKey?: string }) => {
          if (onCreate) await onCreate();
          if (failNextCreate) {
            const f = failNextCreate;
            failNextCreate = null;
            throw stripeErr(f);
          }
          calls.sessionsCreate.push({ params, key: o.idempotencyKey });
          const key = o.idempotencyKey ?? '';
          const existing = sessionsByKey.get(key);
          if (existing) return sessions.get(existing);
          const id = `cs_test_${++sessionSeq}`;
          const session: Session = {
            id,
            object: 'checkout.session',
            status: 'open',
            payment_status: 'unpaid',
            mode: 'subscription',
            url: `https://checkout.stripe.test/c/pay/${id}#SECRET-SESSION-URL`,
            customer: params.customer,
            subscription: null,
            expires_at: Math.floor(Date.now() / 1000) + 24 * 3600,
            metadata: params.metadata,
          };
          sessions.set(id, session);
          sessionsByKey.set(key, id);
          return session;
        },
        retrieve: async (id: string) => {
          if (failNextRetrieve) {
            const f = failNextRetrieve;
            failNextRetrieve = null;
            throw stripeErr(f);
          }
          return sessions.get(id) ?? Promise.reject(stripeErr({ code: 'resource_missing', statusCode: 404 }));
        },
        expire: async (id: string) => {
          calls.expire.push(id);
          const s = sessions.get(id);
          if (s) s.status = 'expired';
          return s;
        },
      },
    },
    events: {
      list: (p: { type: string }) => ({
        async *[Symbol.asyncIterator]() {
          for (const e of events) if (e.type === p.type) yield e;
        },
      }),
    },
    invoices: { retrieve: async () => Promise.reject(new Error('no invoice')) },
  };

  /** Stripe's side of "the customer paid": the session completes and a live subscription exists. */
  const completeAtStripe = (sessionId: string, subId: string, organizationId: string, lookupKey = 'crecimiento') => {
    const s = sessions.get(sessionId) as Session;
    s.status = 'complete';
    s.payment_status = 'paid';
    s.subscription = subId;
    const list = subscriptionsByCustomer.get(s.customer) ?? [];
    list.push({ id: subId, status: 'active', organizationId, lookupKey });
    subscriptionsByCustomer.set(s.customer, list);
    const event = {
      id: `evt_${sessionId}_completed`,
      object: 'event',
      type: 'checkout.session.completed',
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: { object: { ...s, customer_email: 'SECRET-EMAIL@example.test' } },
    } as unknown as Stripe.Event;
    events.push(event);
    return event;
  };
  const sign = (payload: string) => stripeLib.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });
  const deliver = (event: unknown, requestId = randomUUID()) => {
    const body = JSON.stringify(event);
    return service.handleWebhook(Buffer.from(body), sign(body), { requestId });
  };
  const expiredEvent = (sessionId: string, id = `evt_${sessionId}_expired`) => {
    const s = sessions.get(sessionId) as Session;
    return {
      id,
      object: 'event',
      type: 'checkout.session.expired',
      livemode: false,
      created: Math.floor(Date.now() / 1000),
      data: { object: { ...s, status: 'expired', customer_email: 'SECRET-EMAIL@example.test' } },
    };
  };

  // ── database fixtures and readers ────────────────────────────────────────
  let orgSeq = 0;
  const mkOrg = async (
    o: { customer?: string | null; current?: string | null; stores?: number; plan?: string } = {},
  ) => {
    orgSeq++;
    const [row]: { id: string }[] = await em.execute(
      `insert into organizations (name, slug, plan, billing_status, stripe_customer_id, stripe_subscription_id, created_at, updated_at)
       values (?, ?, ?, 'ACTIVE', ?, ?, now(), now()) returning id`,
      [
        `Attempt Co ${orgSeq}`,
        `attempt-co-${orgSeq}`,
        o.plan ?? 'BASICO',
        o.customer === undefined ? `cus_att_${orgSeq}` : o.customer,
        o.current ?? null,
      ],
    );
    for (let i = 0; i < (o.stores ?? 1); i++) {
      await em.execute(
        `insert into stores (name, slug, organization_id, created_at, updated_at) values (?, ?, ?::uuid, now(), now())`,
        [`Store ${orgSeq}-${i}`, `att-store-${orgSeq}-${i}`, row.id],
      );
    }
    return row.id;
  };
  const attempts = async (orgId: string): Promise<any[]> =>
    em.execute(
      `select id, status, plan, stripe_idempotency_key as key, request_params as params, stripe_customer_id as customer,
              stripe_session_id as session, session_url as url, completed_event_id as event, settle_note as note,
              failure_code as failure, created_by_user_id as "user"
         from billing_checkout_attempts where organization_id = ?::uuid order by created_at`,
      [orgId],
    );
  const orgRow = async (id: string) => {
    const [row]: any[] = await em.execute(
      `select plan, billing_status as status, stripe_customer_id as customer, stripe_subscription_id as current from organizations where id = ?::uuid`,
      [id],
    );
    return row;
  };
  const eventRow = async (eventId: string) => {
    const [row]: any[] = await em.execute(
      `select disposition, reason_code as reason, attempt_count as attempts, organization_id as org from stripe_events where event_id = ?`,
      [eventId],
    );
    return row ?? null;
  };
  const processings = async (eventId: string): Promise<any[]> =>
    em.execute(
      `select trigger, basis, result, reason_code as reason, effect, actor_user_id as actor from stripe_event_processings where event_id = ? order by started_at`,
      [eventId],
    );
  const checkout = (orgId: string, plan = 'CRECIMIENTO', requestId = randomUUID()) =>
    service.createCheckout(orgId, plan, actor, { requestId });
  const failure = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as any;
    }
    throw new Error('expected a failure');
  };

  // ── log capture ──────────────────────────────────────────────────────────
  let logs: string[];
  let warns: string[];
  const records = (kind: string) =>
    [...logs, ...warns]
      .map((l) => l.match(/\{"event":"stripe_[^\n]*\}/)?.[0])
      .filter((x): x is string => !!x)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((r) => r.event === kind);
  const SENTINELS = ['SECRET-SESSION-URL', 'SECRET-EMAIL', 'SECRET-DRIVER-MESSAGE', 'checkout.stripe.test', 'v1='];
  const nothingLeaked = async (...errors: unknown[]) => {
    for (const line of [...logs, ...warns]) for (const s of SENTINELS) expect(line).not.toContain(s);
    for (const e of errors)
      for (const s of SENTINELS) expect(JSON.stringify((e as any)?.getResponse?.() ?? String(e))).not.toContain(s);
    const [row]: { n: string }[] = await em.execute(
      `select count(*)::text as n from (
         select reason_code as t from stripe_events union all select coalesce(resolution_code, '') from stripe_events
         union all select reason_code from stripe_event_processings union all select local_state_after::text from stripe_event_processings
         union all select coalesce(settle_note, '') from billing_checkout_attempts union all select coalesce(failure_code, '') from billing_checkout_attempts
         union all select request_params::text from billing_checkout_attempts
       ) x where t like '%SECRET-%' or t like '%v1=%'`,
    );
    expect(Number(row.n)).toBe(0);
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    const serviceEm = pg.orm.em.fork() as EntityManager;
    const config = {
      get: (key: string) =>
        key === 'STRIPE_WEBHOOK_SECRET'
          ? WEBHOOK_SECRET
          : key === 'STRIPE_SECRET_KEY'
            ? 'sk_test_offline_signature_helper_only'
            : key === 'FRONTEND_URL'
              ? 'https://catalog.example.test/'
              : undefined,
    };
    service = new StripeService(
      config as unknown as ConfigService,
      serviceEm.getRepository(Store) as never,
      new AuditLogService(serviceEm.getRepository(AuditLog) as never),
    );
    (service as any).stripe = fakeStripe;
    StripeService.checkoutTiming = { staleCreatingMs: 400, joinWaitMs: 1_500, joinPollMs: 50 };
  }, 300_000);

  afterAll(async () => {
    await pg?.close();
  });

  beforeEach(() => {
    logs = [];
    warns = [];
    calls.sessionsCreate = [];
    calls.customersCreate = [];
    calls.expire = [];
    searchResults = [];
    failNextCreate = null;
    failNextRetrieve = null;
    onCreate = null;
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => {
      warns.push(String(m));
    });
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown, ...rest: unknown[]) => {
      warns.push([m, ...rest].map(String).join(' '));
    });
  });
  afterEach(() => jest.restoreAllMocks());

  describe('one attempt, one session, one key', () => {
    it('a first checkout records an open attempt, one Stripe session under the attempt key, and returns its URL', async () => {
      const org = await mkOrg();
      const url = await checkout(org);
      const rows = await attempts(org);
      expect(rows).toHaveLength(1);
      const [a] = rows;
      expect(a.status).toBe('open');
      expect(a.key).toBe(`checkout:${a.id}`);
      expect(a.params.metadata).toEqual({ organizationId: org, plan: 'CRECIMIENTO', attemptId: a.id });
      expect(a.params.metadata.storeId).toBeUndefined();
      expect(a.params.subscription_data.metadata).toEqual({ organizationId: org, plan: 'CRECIMIENTO' });
      expect(a.params.success_url).toBe('https://catalog.example.test/dashboard/billing?paid=1');
      expect(a.session).toBe(calls.sessionsCreate[0] && sessions.get(a.session)?.id);
      expect(a.url).toBe(url);
      expect(a.user).toBe(actor.id);
      expect(calls.sessionsCreate).toHaveLength(1);
      expect(calls.sessionsCreate[0].key).toBe(a.key);
      const [rec] = records('stripe_checkout_attempt');
      expect(rec).toMatchObject({
        organizationId: org,
        attemptId: a.id,
        sessionId: a.session,
        outcome: 'created',
        reason: null,
      });
      expect(Object.keys(rec)).not.toContain('url');
      await nothingLeaked();
    });

    it('D-9: two concurrent first checkouts produce ONE attempt and the SAME URL; Stripe is called once', async () => {
      const org = await mkOrg();
      onCreate = () => new Promise((resolve) => setTimeout(resolve, 300));
      const [a, b] = await Promise.all([checkout(org), checkout(org)]);
      expect(a).toBe(b);
      expect(await attempts(org)).toHaveLength(1);
      expect(calls.sessionsCreate).toHaveLength(1);
      expect(
        records('stripe_checkout_attempt')
          .map((r) => r.outcome)
          .sort(),
      ).toEqual(['created', 'joined']);
      await nothingLeaked();
    });

    it('a later checkout while the session is still open REUSES it: same URL, no new session', async () => {
      const org = await mkOrg();
      const first = await checkout(org);
      const again = await checkout(org);
      expect(again).toBe(first);
      expect(await attempts(org)).toHaveLength(1);
      expect(calls.sessionsCreate).toHaveLength(1);
      expect(records('stripe_checkout_attempt').map((r) => r.outcome)).toEqual(['created', 'reused']);
    });

    it('an expired session is replaced: the old attempt is expired with its reason, a new one is created', async () => {
      const org = await mkOrg();
      const first = await checkout(org);
      const [a] = await attempts(org);
      (sessions.get(a.session) as Session).status = 'expired';
      const second = await checkout(org);
      expect(second).not.toBe(first);
      const rows = await attempts(org);
      expect(rows.map((r) => r.status)).toEqual(['expired', 'open']);
      expect(rows[0].note).toBe('expired');
      expect(calls.sessionsCreate).toHaveLength(2);
      expect(calls.sessionsCreate[1].key).toBe(rows[1].key);
      expect(rows[1].key).not.toBe(rows[0].key);
    });

    it('a different plan expires the open session AT STRIPE and replaces it', async () => {
      const org = await mkOrg();
      await checkout(org, 'CRECIMIENTO');
      const [a] = await attempts(org);
      await checkout(org, 'MULTIMARCA');
      expect(calls.expire).toEqual([a.session]);
      const rows = await attempts(org);
      expect(rows.map((r) => [r.status, r.plan])).toEqual([
        ['expired', 'CRECIMIENTO'],
        ['open', 'MULTIMARCA'],
      ]);
      expect(rows[0].note).toBe('replaced_plan_change');
    });

    it('plan capacity is validated under the lock before any attempt exists', async () => {
      const org = await mkOrg({ stores: 2, plan: 'CRECIMIENTO' });
      const error = await failure(checkout(org, 'BASICO'));
      expect(error.getStatus()).toBe(400);
      expect(error.message).toContain('does not fit');
      expect(await attempts(org)).toHaveLength(0);
      expect(calls.sessionsCreate).toHaveLength(0);
    });
  });

  describe('a request that died is finished by the next one', () => {
    it('a stale `creating` attempt is re-issued under the SAME key and Stripe returns the SAME session', async () => {
      const org = await mkOrg();
      // The first request reached Stripe and died before recording the answer.
      failNextCreate = { type: 'StripeConnectionError' };
      const error = await failure(checkout(org));
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      let rows = await attempts(org);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('creating');
      expect(rows[0].session).toBeNull();
      expect(records('stripe_checkout_attempt').map((r) => r.outcome)).toEqual(['unavailable']);
      // Stripe did create it under our key; pretend so by issuing it now.
      const key = rows[0].key;
      const created = await fakeStripe.checkout.sessions.create(rows[0].params, { idempotencyKey: key });
      calls.sessionsCreate = [];
      await new Promise((resolve) => setTimeout(resolve, StripeService.checkoutTiming.staleCreatingMs + 50));
      const url = await checkout(org);
      expect(url).toBe(created!.url);
      rows = await attempts(org);
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('open');
      expect(rows[0].session).toBe(created!.id);
      expect(calls.sessionsCreate).toEqual([{ params: rows[0].params, key }]);
      expect(records('stripe_checkout_attempt').map((r) => r.outcome)).toEqual(['unavailable', 'reissued']);
      await nothingLeaked(error);
    });

    it('a young `creating` attempt is JOINED; when it never opens, the caller gets a 503 and the row is untouched', async () => {
      const org = await mkOrg();
      failNextCreate = { type: 'StripeConnectionError' };
      await failure(checkout(org));
      const [before] = await attempts(org);
      const error = await failure(checkout(org));
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const [after] = await attempts(org);
      expect(after).toEqual(before);
      expect(calls.sessionsCreate).toHaveLength(0);
      expect(records('stripe_checkout_attempt').map((r) => [r.outcome, r.reason])).toEqual([
        ['unavailable', 'StripeConnectionError'],
        ['unavailable', 'checkout_in_progress'],
      ]);
    });

    it('a DEFINITE Stripe refusal marks the attempt failed with its class; the next request starts a new attempt', async () => {
      const org = await mkOrg();
      failNextCreate = { type: 'StripeInvalidRequestError', statusCode: 400 };
      const error = await failure(checkout(org));
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      let rows = await attempts(org);
      expect(rows.map((r) => [r.status, r.failure])).toEqual([['failed', 'StripeInvalidRequestError']]);
      await checkout(org);
      rows = await attempts(org);
      expect(rows.map((r) => r.status)).toEqual(['failed', 'open']);
      expect(rows[1].key).not.toBe(rows[0].key);
      await nothingLeaked(error);
    });
  });

  describe('completion without a webhook (settlement)', () => {
    it("a completed session is settled from Stripe's event list THROUGH the ledger; the answer is the portal; the later webhook is a duplicate", async () => {
      const org = await mkOrg();
      await checkout(org);
      const [a] = await attempts(org);
      const event = completeAtStripe(a.session, 'sub_settled_1', org);

      const error = await failure(checkout(org));
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ reason: 'portal' });

      expect(await orgRow(org)).toMatchObject({ plan: 'CRECIMIENTO', status: 'ACTIVE', current: 'sub_settled_1' });
      expect(await eventRow(event.id)).toMatchObject({ disposition: 'applied', reason: 'activated', attempts: 1, org });
      expect(await processings(event.id)).toEqual([
        expect.objectContaining({
          trigger: 'settlement',
          basis: 'stripe_retrieve',
          result: 'applied',
          effect: 'activated',
          actor: actor.id,
        }),
      ]);
      const rows = await attempts(org);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'completed', event: event.id });
      expect(calls.sessionsCreate).toHaveLength(1);
      expect(records('stripe_checkout_attempt').map((r) => [r.outcome, r.reason])).toEqual([
        ['created', null],
        ['settled_completed', 'activated'],
        ['refused', 'portal'],
      ]);

      // Stripe's delivery arrives after all: a duplicate, nothing applied twice.
      await deliver(event);
      expect(await eventRow(event.id)).toMatchObject({ attempts: 2 });
      expect(await processings(event.id)).toHaveLength(1);
      expect(records('stripe_webhook').map((r) => r.disposition)).toEqual(['duplicate']);
      await nothingLeaked(error);
    });

    it('a completed session whose event Stripe no longer lists is completed with a note and refused as requires_action', async () => {
      const org = await mkOrg();
      await checkout(org);
      const [a] = await attempts(org);
      completeAtStripe(a.session, 'sub_lost_1', org);
      events.pop(); // Stripe kept the session, not the event
      const error = await failure(checkout(org));
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ reason: 'completed_session_event_not_found' });
      expect(await attempts(org)).toEqual([
        expect.objectContaining({ status: 'completed', event: null, note: 'event_not_found' }),
      ]);
      expect(await orgRow(org)).toMatchObject({ current: null });
      expect(records('stripe_checkout_requires_action')).toEqual([
        expect.objectContaining({ organizationId: org, attemptId: a.id, reason: 'completed_session_event_not_found' }),
      ]);
    });

    it('the settlement actor is a recorded fact: it survives the user row being gone (it was never a foreign key)', async () => {
      const org = await mkOrg();
      await checkout(org);
      const [a] = await attempts(org);
      const event = completeAtStripe(a.session, 'sub_settled_2', org);
      await failure(checkout(org));
      const [{ n }]: { n: string }[] = await em.execute(`select count(*)::text as n from users where id = ?::uuid`, [
        actor.id,
      ]);
      expect(Number(n)).toBe(0);
      expect(await processings(event.id)).toEqual([
        expect.objectContaining({ trigger: 'settlement', actor: actor.id }),
      ]);
      expect((await attempts(org))[0].user).toBe(actor.id);
    });
  });

  describe('the webhook and the attempt', () => {
    it('checkout.session.completed marks the attempt completed with the event id inside the event transaction', async () => {
      const org = await mkOrg();
      await checkout(org);
      const [a] = await attempts(org);
      const event = completeAtStripe(a.session, 'sub_hook_1', org);
      await deliver(event);
      expect(await attempts(org)).toEqual([
        expect.objectContaining({ status: 'completed', event: event.id, note: 'activated', url: null }),
      ]);
      expect(await orgRow(org)).toMatchObject({ current: 'sub_hook_1', status: 'ACTIVE' });
      expect(await processings(event.id)).toEqual([expect.objectContaining({ trigger: 'webhook', actor: null })]);
      const error = await failure(checkout(org));
      expect(error.getResponse()).toMatchObject({ reason: 'portal' });
      expect(calls.sessionsCreate).toHaveLength(1);
    });

    it('checkout.session.expired expires the attempt, is ledger-recorded, and a resend is a duplicate', async () => {
      const org = await mkOrg();
      await checkout(org);
      const [a] = await attempts(org);
      const event = expiredEvent(a.session);
      await deliver(event);
      expect(await attempts(org)).toEqual([expect.objectContaining({ status: 'expired', note: 'session_expired' })]);
      expect(await eventRow(event.id)).toMatchObject({
        disposition: 'ignored',
        reason: 'session_expired',
        attempts: 1,
        org,
      });
      await deliver(event);
      expect(await eventRow(event.id)).toMatchObject({ attempts: 2 });
      expect(await processings(event.id)).toHaveLength(1);
      expect(records('stripe_webhook').map((r) => r.disposition)).toEqual(['ignored', 'duplicate']);
      // The next checkout starts fresh.
      await checkout(org);
      expect((await attempts(org)).map((r) => r.status)).toEqual(['expired', 'open']);
      await nothingLeaked();
    });

    it('an expired event for a session we never issued changes nothing and is foreign', async () => {
      const before = (await em.execute(`select count(*)::int as n from billing_checkout_attempts`))[0].n;
      const event = {
        id: 'evt_foreign_expired_1',
        object: 'event',
        type: 'checkout.session.expired',
        livemode: false,
        created: 1756700000,
        data: {
          object: { id: 'cs_foreign_1', object: 'checkout.session', status: 'expired', mode: 'payment', metadata: {} },
        },
      };
      await deliver(event);
      expect(await eventRow(event.id)).toMatchObject({ disposition: 'ignored', reason: 'foreign' });
      expect((await em.execute(`select count(*)::int as n from billing_checkout_attempts`))[0].n).toBe(before);
    });
  });

  describe('the customer and the portal rule', () => {
    it('D-5: a company with a subscription is refused with 409 and the portal; no attempt, no Stripe call', async () => {
      const org = await mkOrg({ current: 'sub_existing' });
      const error = await failure(checkout(org));
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ statusCode: 409, reason: 'portal' });
      expect(await attempts(org)).toHaveLength(0);
      expect(calls.sessionsCreate).toHaveLength(0);
      expect(calls.customersCreate).toHaveLength(0);
    });

    it('a customer created earlier whose write was lost is ADOPTED by search; none → created under the customer key', async () => {
      const orphaned = await mkOrg({ customer: null });
      searchResults = [{ id: 'cus_orphan_1', metadata: { organizationId: orphaned } }];
      await checkout(orphaned);
      expect((await orgRow(orphaned)).customer).toBe('cus_orphan_1');
      expect(calls.customersCreate).toHaveLength(0);
      expect((await attempts(orphaned))[0].customer).toBe('cus_orphan_1');

      const fresh = await mkOrg({ customer: null });
      searchResults = [];
      await checkout(fresh);
      expect(calls.customersCreate).toEqual([`customer:${fresh}`]);
      expect((await orgRow(fresh)).customer).toBe('cus_created_1');
      expect(customerUpdates).toEqual([{ id: 'cus_created_1', email: actor.email }]);
    });

    it('two customers claiming one company is a question for a person: 409 requires_action; the attempt fails truthfully, with no customer and no session', async () => {
      const org = await mkOrg({ customer: null });
      searchResults = [
        { id: 'cus_dup_a', metadata: { organizationId: org } },
        { id: 'cus_dup_b', metadata: { organizationId: org } },
      ];
      const error = await failure(checkout(org));
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ reason: 'ambiguous_customer' });
      expect((await orgRow(org)).customer).toBeNull();
      // #318: the attempt is committed at the gate BEFORE the customer is
      // resolved, so the ambiguity is recorded on it, and it ends failed.
      const rows = await attempts(org);
      expect(rows.map((r) => [r.status, r.failure, r.customer, r.params, r.session])).toEqual([
        ['failed', 'ambiguous_customer', null, null, null],
      ]);
      expect(calls.sessionsCreate).toEqual([]);
      expect(calls.customersCreate).toEqual([]);
      expect(records('stripe_checkout_requires_action')).toEqual([
        expect.objectContaining({ organizationId: org, attemptId: rows[0].id, reason: 'ambiguous_customer' }),
      ]);
    });

    it('a live subscription the ledger never saw is refused (requires_action), never doubled; two live are named as such', async () => {
      const org = await mkOrg();
      const customer = (await orgRow(org)).customer;
      subscriptionsByCustomer.set(customer, [
        { id: 'sub_unseen_1', status: 'active', organizationId: org, lookupKey: 'crecimiento' },
      ]);
      const error = await failure(checkout(org));
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ reason: 'subscription_unreconciled' });
      expect(await attempts(org)).toEqual([expect.objectContaining({ status: 'failed', failure: 'unreconciled' })]);
      expect(calls.sessionsCreate).toHaveLength(0);
      expect(await orgRow(org)).toMatchObject({ current: null });

      subscriptionsByCustomer
        .get(customer)!
        .push({ id: 'sub_unseen_2', status: 'trialing', organizationId: org, lookupKey: 'basico' });
      const again = await failure(checkout(org));
      expect(again.getResponse()).toMatchObject({ reason: 'multiple_live_subscriptions' });
      expect(records('stripe_checkout_requires_action').map((r) => r.reason)).toEqual([
        'subscription_unreconciled',
        'multiple_live_subscriptions',
      ]);
      // A cancelled one does not count.
      subscriptionsByCustomer.set(customer, [
        { id: 'sub_old', status: 'canceled', organizationId: org, lookupKey: 'basico' },
      ]);
      await checkout(org);
      expect((await attempts(org)).map((r) => r.status)).toEqual(['failed', 'failed', 'open']);
    });
  });

  describe('tenant isolation', () => {
    it('attempts, joins and settlements never cross companies', async () => {
      const a = await mkOrg();
      const b = await mkOrg();
      const urlA = await checkout(a);
      const urlB = await checkout(b);
      expect(urlA).not.toBe(urlB);
      const [rowA] = await attempts(a);
      const [rowB] = await attempts(b);
      expect(rowA.session).not.toBe(rowB.session);
      // B cannot settle A's attempt, by id or by session.
      expect(await settleAttempt(em, b, rowA.id, { status: 'expired', settleNote: 'stolen' })).toBe(false);
      expect((await attempts(a))[0]).toEqual(rowA);
      // A's completion leaves B's open attempt alone.
      const event = completeAtStripe(rowA.session, 'sub_iso_a', a);
      await deliver(event);
      expect((await attempts(b))[0]).toEqual(rowB);
      expect(await orgRow(b)).toMatchObject({ current: null });
    });
  });

  describe('review round: the findings, each pinned', () => {
    it("two managers, two plans at once: the joiner never receives the other plan's page", async () => {
      const org = await mkOrg();
      onCreate = () => new Promise((resolve) => setTimeout(resolve, 300));
      const [a, b] = await Promise.all([checkout(org, 'CRECIMIENTO'), checkout(org, 'MULTIMARCA')]);
      expect(a).not.toBe(b);
      const rows = await attempts(org);
      expect(rows.map((r) => [r.status, r.plan, r.note])).toEqual([
        ['expired', 'CRECIMIENTO', 'replaced_plan_change'],
        ['open', 'MULTIMARCA', null],
      ]);
      expect(calls.expire).toEqual([rows[0].session]);
      expect(sessions.get(rows[1].session)?.metadata.plan).toBe('MULTIMARCA');
    });

    it('a 409 idempotency conflict (key in use) is an UNKNOWN outcome: the attempt stays creating; a 400 one is definite', async () => {
      const org = await mkOrg();
      failNextCreate = { type: 'StripeIdempotencyError', statusCode: 409 };
      expect(await failure(checkout(org))).toBeInstanceOf(ServiceUnavailableException);
      expect((await attempts(org)).map((r) => r.status)).toEqual(['creating']);
      await new Promise((resolve) => setTimeout(resolve, StripeService.checkoutTiming.staleCreatingMs + 50));
      failNextCreate = { type: 'StripeIdempotencyError', statusCode: 400 };
      expect(await failure(checkout(org))).toBeInstanceOf(ServiceUnavailableException);
      expect((await attempts(org)).map((r) => [r.status, r.failure])).toEqual([['failed', 'StripeIdempotencyError']]);
    });

    it('a stale re-issue runs the live-subscription guard too', async () => {
      const org = await mkOrg();
      failNextCreate = { type: 'StripeConnectionError' };
      await failure(checkout(org));
      subscriptionsByCustomer.set((await orgRow(org)).customer, [
        { id: 'sub_late_seen', status: 'active', organizationId: org, lookupKey: 'crecimiento' },
      ]);
      await new Promise((resolve) => setTimeout(resolve, StripeService.checkoutTiming.staleCreatingMs + 50));
      const error = await failure(checkout(org));
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({ reason: 'subscription_unreconciled' });
      expect((await attempts(org)).map((r) => [r.status, r.failure])).toEqual([['failed', 'unreconciled']]);
      expect(calls.sessionsCreate).toHaveLength(0);
    });

    it('two concurrent requests on one stale attempt: one re-issues, the other joins; one Stripe call, one URL', async () => {
      const org = await mkOrg();
      failNextCreate = { type: 'StripeConnectionError' };
      await failure(checkout(org));
      await new Promise((resolve) => setTimeout(resolve, StripeService.checkoutTiming.staleCreatingMs + 50));
      calls.sessionsCreate = [];
      logs = [];
      onCreate = () => new Promise((resolve) => setTimeout(resolve, 300));
      const [a, b] = await Promise.all([checkout(org), checkout(org)]);
      expect(a).toBe(b);
      expect(calls.sessionsCreate).toHaveLength(1);
      expect((await attempts(org)).map((r) => r.status)).toEqual(['open']);
      expect(
        records('stripe_checkout_attempt')
          .map((r) => r.outcome)
          .sort(),
      ).toEqual(['joined', 'reissued']);
    });

    it('a Stripe outage while settling is a recorded 503 that leaks nothing and moves no row', async () => {
      const org = await mkOrg();
      await checkout(org);
      const [before] = await attempts(org);
      failNextRetrieve = { type: 'StripeConnectionError' };
      const error = await failure(checkout(org));
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.getResponse()).toMatchObject({ message: expect.stringContaining('temporarily unavailable') });
      expect((await attempts(org))[0]).toEqual(before);
      expect(records('stripe_checkout_attempt').map((r) => [r.outcome, r.reason])).toEqual([
        ['created', null],
        ['unavailable', 'StripeConnectionError'],
      ]);
      await nothingLeaked(error);
    });

    it('the row moved while Stripe was answering: no URL is handed out, the session is closed at Stripe', async () => {
      const org = await mkOrg();
      // The attempt is settled by someone else while `sessions.create` is
      // still in flight. `failed` is the only terminal state a `creating` row
      // can reach — `session_shape_check` requires a session id for the
      // others — and it is the state the definite-refusal path writes.
      onCreate = async () => {
        const [row] = await attempts(org);
        await settleAttempt(em, org, row.id, { status: 'failed', failureCode: 'moved_underneath' });
      };
      const error = await failure(checkout(org));
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const rows = await attempts(org);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: 'failed', failure: 'moved_underneath', session: null });
      // The session Stripe created is not left payable behind our back.
      const created = calls.sessionsCreate[0];
      expect(created).toBeDefined();
      const orphan = [...sessions.values()].find((x) => x.metadata.attemptId === rows[0].id);
      expect(orphan?.status).toBe('expired');
      expect(calls.expire).toEqual([orphan?.id]);
      expect(records('stripe_checkout_attempt').map((r) => [r.outcome, r.reason])).toEqual([
        ['unavailable', 'attempt_moved'],
      ]);
      await nothingLeaked(error);
    });

    it('a concurrent request that opened the SAME session is answered with its URL, not a failure', async () => {
      const org = await mkOrg();
      let hijacked: string | null = null;
      onCreate = async () => {
        // Another request wins the row and records the very session this call
        // is about to receive (same key ⇒ same session). The hook is cleared
        // first: the create below must not re-enter it.
        onCreate = null;
        const [row] = await attempts(org);
        const session = await fakeStripe.checkout.sessions.create(row.params, { idempotencyKey: row.key });
        hijacked = session!.url;
        await markAttemptOpen(em, org, row.id, { id: session!.id, url: session!.url as string, expiresAt: null });
      };
      const url = await checkout(org);
      expect(url).toBe(hijacked);
      expect((await attempts(org)).map((r) => r.status)).toEqual(['open']);
      expect(records('stripe_checkout_attempt').map((r) => r.outcome)).toEqual(['joined']);
    });

    it('an unresolved completion leaves exactly one record for the request', async () => {
      const org = await mkOrg();
      await checkout(org);
      const [a] = await attempts(org);
      completeAtStripe(a.session, 'sub_one_record', org);
      events.pop();
      logs = [];
      await failure(checkout(org));
      expect(records('stripe_checkout_attempt').map((r) => [r.outcome, r.reason])).toEqual([
        ['refused', 'completed_session_event_not_found'],
      ]);
    });
  });

  describe('down() refuses on a populated table', () => {
    it('refuses while attempts exist, and leaves the table and constraints in place', async () => {
      await mkOrg().then(checkout);
      // #318's migration is newer, so its down() runs first. With an attempt
      // recorded before a customer existed, it refuses and nothing is reversed.
      const unfrozenOrg = await mkOrg({ customer: null });
      await em.execute(
        `insert into billing_checkout_attempts (organization_id, plan, status, stripe_idempotency_key)
         values (?::uuid, 'CRECIMIENTO', 'creating', ?)`,
        [unfrozenOrg, `checkout:fixture-${unfrozenOrg}`],
      );
      await expect(pg.orm.migrator.down({ to: 'Migration20260903120000' })).rejects.toThrow(
        /recorded before a customer existed/,
      );
      const frozenCheck = async () =>
        Number(
          (
            await em.execute(
              `select count(*)::int as n from pg_constraint where conname = 'billing_checkout_attempts_request_frozen_check'`,
            )
          )[0].n,
        );
      expect(await frozenCheck()).toBe(1);
      // Without such rows (test fixtures only), #318's down() completes and PR C's
      // own guard is what refuses on a populated table.
      await em.execute(
        `delete from billing_checkout_attempts where stripe_customer_id is null or request_params is null`,
      );
      await expect(pg.orm.migrator.down({ to: 'Migration20260903120000' })).rejects.toThrow(/refused/);
      const [{ n }]: { n: string }[] = await em.execute(
        `select count(*)::text as n from pg_constraint where conname = 'stripe_event_processings_trigger_check'
           and pg_get_constraintdef(oid) like '%settlement%'`,
      );
      expect(Number(n)).toBe(1);
      expect((await em.execute(`select to_regclass('billing_checkout_attempts') as t`))[0].t).toBe(
        'billing_checkout_attempts',
      );
      // And the chain re-applies cleanly: #318's check is back.
      await pg.orm.migrator.up();
      expect(await frozenCheck()).toBe(1);
    });
  });
});
