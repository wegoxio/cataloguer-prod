import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from '@mikro-orm/postgresql';
import Stripe = require('stripe');
import * as http from 'http';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { insertMinimalUser } from '../../../../../test/billing-fixtures';
import { requestIdMiddleware } from '../../../../common/observability/request-id';
import { StripeWebhookController } from '../../stripe/stripe-webhook.controller';
import { StripeService } from '../../stripe/stripe.service';
import { Store } from '../../../stores/entities/store.entity';
import { AuditLogService } from '../../../audit-log/audit-log.service';
import { AuditLog } from '../../../audit-log/entities/audit-log.entity';

// Same untyped import the harness uses: `pg` ships no types here, and the side
// connection only needs `connect`, `query` and `end`.
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports
const { Client } = require('pg');

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * The Stripe webhook over the WIRE, with real signatures, the real ledger and
 * the real database (#248, PR B).
 *
 * Signatures are DETERMINISTIC fixtures computed by Stripe's own
 * `generateTestHeaderString`. Stripe itself is a fake with a mutable view of
 * subscriptions, so every row of the transition table can be reached without
 * an account, a network call or a charge. Nothing here is a characterization
 * of a hazard any more: every test states behaviour that must hold.
 */
d('Stripe webhook wire contract (real signatures, real PostgreSQL, real ledger)', () => {
  jest.setTimeout(300_000);

  const WEBHOOK_SECRET = 'whsec_test_deterministic_fixture_secret';
  let pg: DisposablePg;
  let em: EntityManager;
  let app: INestApplication;
  let baseUrl: string;
  let service: StripeService;
  let side: {
    connect: () => Promise<void>;
    query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
    end: () => Promise<void>;
  };
  const stripeLib = new Stripe('sk_test_offline_signature_helper_only');

  // ── the fake Stripe ──────────────────────────────────────────────────────
  type SubState =
    | { status: string; customer: string; organizationId: string | null; lookupKey: string | null }
    | 'missing'
    | 'unavailable';
  const subscriptions = new Map<string, SubState>();
  const sessionsById = new Map<string, Record<string, unknown>>();
  const invoicesById = new Map<string, Record<string, unknown>>();
  let retrieveCalls = 0;
  let onRetrieve: ((id: string) => Promise<void>) | null = null;
  const fakeStripe = {
    webhooks: stripeLib.webhooks,
    subscriptions: {
      retrieve: async (id: string) => {
        retrieveCalls++;
        if (onRetrieve) await onRetrieve(id);
        const s = subscriptions.get(id);
        if (!s || s === 'missing')
          throw Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 });
        if (s === 'unavailable')
          throw Object.assign(new Error('Stripe unavailable SECRET-DRIVER-MESSAGE'), { statusCode: 503 });
        return {
          id,
          object: 'subscription',
          status: s.status,
          customer: s.customer,
          metadata: s.organizationId ? { organizationId: s.organizationId } : {},
          items: { data: [{ price: { lookup_key: s.lookupKey } }] },
        };
      },
    },
    checkout: {
      sessions: { retrieve: async (id: string) => sessionsById.get(id) ?? Promise.reject(new Error('no session')) },
    },
    invoices: { retrieve: async (id: string) => invoicesById.get(id) ?? Promise.reject(new Error('no invoice')) },
  };

  const sign = (payload: string): string =>
    stripeLib.webhooks.generateTestHeaderString({ payload, secret: WEBHOOK_SECRET });

  const post = (
    body: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> =>
    new Promise((resolve, reject) => {
      const req = http.request(
        `${baseUrl}/api/v1/billing/webhook`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            let json: unknown = null;
            try {
              json = data ? JSON.parse(data) : null;
            } catch {
              json = { raw: data };
            }
            resolve({ status: res.statusCode ?? 0, json, headers: res.headers });
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  const send = (body: string) => post(body, { 'stripe-signature': sign(body) });
  // Typed loosely on purpose: this file must still COMPILE against the
  // pre-ledger service so its failures can be shown, not just its absence.
  const reapply = (eventId: string, actor: { id: string; email: string | null }, requestId: string): Promise<any> =>
    (service as any).reapplyEvent(eventId, actor, requestId);

  // ── event builders (register the objects the fake can retrieve) ──────────
  const checkoutEvent = (p: {
    id: string;
    session: string;
    sub: string | null;
    org: string | null;
    plan: string | null;
    customer?: string | null;
    status?: string;
    paymentStatus?: string;
    mode?: string;
    created?: number;
  }) => {
    const object = {
      id: p.session,
      object: 'checkout.session',
      mode: p.mode ?? 'subscription',
      status: p.status ?? 'complete',
      payment_status: p.paymentStatus ?? 'paid',
      customer: p.customer ?? null,
      subscription: p.sub,
      customer_email: 'SECRET-EMAIL@example.test',
      metadata: {
        ...(p.org ? { organizationId: p.org } : {}),
        ...(p.plan ? { plan: p.plan } : {}),
        note: 'SECRET-METADATA',
      },
    };
    sessionsById.set(p.session, object);
    return JSON.stringify({
      id: p.id,
      type: 'checkout.session.completed',
      livemode: false,
      created: p.created ?? 1756700000,
      data: { object },
    });
  };
  const paidEvent = (p: {
    id: string;
    invoice: string;
    customer: string | null;
    sub: string | null;
    org?: string | null;
    created?: number;
  }) => {
    const object = {
      id: p.invoice,
      object: 'invoice',
      customer: p.customer,
      amount_paid: 3000,
      number: 'INV-0001',
      hosted_invoice_url: 'https://example.test/SECRET-INVOICE-URL',
      customer_email: 'SECRET-EMAIL@example.test',
      created: 1756700000,
      parent: p.sub
        ? {
            type: 'subscription_details',
            subscription_details: { subscription: p.sub, metadata: p.org ? { organizationId: p.org } : {} },
          }
        : null,
    };
    invoicesById.set(p.invoice, object);
    return JSON.stringify({
      id: p.id,
      type: 'invoice.paid',
      livemode: false,
      created: p.created ?? 1756700000,
      data: { object },
    });
  };
  const deletedEvent = (p: {
    id: string;
    sub: string;
    org?: string | null;
    customer?: string | null;
    created?: number;
  }) =>
    JSON.stringify({
      id: p.id,
      type: 'customer.subscription.deleted',
      livemode: false,
      created: p.created ?? 1756700000,
      data: {
        object: {
          id: p.sub,
          object: 'subscription',
          status: 'canceled',
          customer: p.customer ?? null,
          metadata: p.org ? { organizationId: p.org } : {},
        },
      },
    });

  // ── database fixtures and readers ────────────────────────────────────────
  let orgSeq = 0;
  const mkOrg = async (
    o: {
      name?: string;
      customer?: string | null;
      current?: string | null;
      previous?: string | null;
      status?: string;
      plan?: string;
      stores?: number;
    } = {},
  ): Promise<string> => {
    orgSeq++;
    const [row]: { id: string }[] = await em.execute(
      `insert into organizations (name, slug, plan, billing_status, stripe_customer_id, stripe_subscription_id, stripe_previous_subscription_id, created_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, now(), now()) returning id`,
      [
        o.name ?? `Wire Co ${orgSeq}`,
        `wire-co-${orgSeq}`,
        o.plan ?? 'BASICO',
        o.status ?? 'ACTIVE',
        o.customer ?? `cus_wire_${orgSeq}`,
        o.current ?? null,
        o.previous ?? null,
      ],
    );
    for (let i = 0; i < (o.stores ?? 1); i++) {
      await em.execute(
        `insert into stores (name, slug, organization_id, created_at, updated_at) values (?, ?, ?::uuid, now(), now())`,
        [`Store ${orgSeq}-${i}`, `store-${orgSeq}-${i}`, row.id],
      );
    }
    return row.id;
  };
  const customerOf = async (orgId: string): Promise<string> => {
    const [row]: { c: string }[] = await em.execute(
      `select stripe_customer_id as c from organizations where id = ?::uuid`,
      [orgId],
    );
    return row.c;
  };
  const orgRow = async (id: string) => {
    const [row]: { plan: string; status: string; current: string | null; previous: string | null }[] = await em.execute(
      `select plan, billing_status as status, stripe_subscription_id as current, stripe_previous_subscription_id as previous from organizations where id = ?::uuid`,
      [id],
    );
    return row;
  };
  const eventRow = async (eventId: string) => {
    const rows: any[] = await em.execute(
      `select disposition, reason_code as reason, attempt_count as attempts, organization_id as org, resolved_at as resolved from stripe_events where event_id = ?`,
      [eventId],
    );
    return rows[0] ?? null;
  };
  const deliveries = async (
    eventId: string,
  ): Promise<{ outcome: string; error_name: string | null; sql_state: string | null }[]> =>
    em.execute(
      `select outcome, error_name, sql_state from stripe_webhook_deliveries where event_id = ? order by received_at`,
      [eventId],
    );
  const processings = async (eventId: string): Promise<any[]> =>
    em.execute(
      `select trigger, basis, result, reason_code as reason, effect, actor_user_id as actor, payment_id, audit_log_id from stripe_event_processings where event_id = ? order by started_at`,
      [eventId],
    );
  const paymentsFor = async (invoiceId: string): Promise<number> => {
    const [row]: { n: string }[] = await em.execute(
      `select count(*)::text as n from payments where stripe_invoice_id = ?`,
      [invoiceId],
    );
    return Number(row.n);
  };
  const auditFor = async (orgId: string): Promise<{ actor: string | null; message: string }[]> =>
    em.execute(`select actor_email as actor, message from audit_logs where entity_id = ?::uuid order by created_at`, [
      orgId,
    ]);
  const ledgerCount = async (): Promise<{ events: number; deliveries: number; processings: number }> => {
    const [row]: any[] = await em.execute(
      `select (select count(*) from stripe_events)::int as events, (select count(*) from stripe_webhook_deliveries)::int as deliveries, (select count(*) from stripe_event_processings)::int as processings`,
    );
    return row;
  };

  // ── log capture ──────────────────────────────────────────────────────────
  let logs: string[];
  let warns: string[];
  const records = () =>
    [...logs, ...warns]
      .map((l) => l.match(/\{"event":"stripe_[^\n]*\}/)?.[0])
      .filter((x): x is string => !!x)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const recordFor = (eventId: string, kind = 'stripe_webhook') =>
    records().filter((r) => r.event === kind && r.eventId === eventId);
  const SENTINELS = ['SECRET-INVOICE-URL', 'SECRET-EMAIL', 'SECRET-METADATA', 'SECRET-DRIVER-MESSAGE', 'v1='];
  const nothingLeaked = async () => {
    for (const line of [...logs, ...warns]) for (const s of SENTINELS) expect(line).not.toContain(s);
    const [row]: { n: string }[] = await em.execute(
      `select count(*)::text as n from (
         select event_id::text as t from stripe_events union all select reason_code from stripe_events union all select resolution_code from stripe_events
         union all select reason_code from stripe_event_processings union all select local_state_before::text from stripe_event_processings union all select local_state_after::text from stripe_event_processings
         union all select error_name from stripe_webhook_deliveries union all select sql_state from stripe_webhook_deliveries
       ) x where t like '%SECRET-%' or t like '%v1=%'`,
    );
    expect(Number(row.n)).toBe(0);
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    const u = new URL(process.env.TEST_DATABASE_URL as string);
    u.pathname = `/${pg.dbName}`;
    side = new Client({ connectionString: u.toString() });
    await side.connect();

    const serviceEm = pg.orm.em.fork() as EntityManager;
    const config = {
      get: (key: string) =>
        key === 'STRIPE_WEBHOOK_SECRET'
          ? WEBHOOK_SECRET
          : key === 'STRIPE_SECRET_KEY'
            ? 'sk_test_offline_signature_helper_only'
            : undefined,
    };
    service = new StripeService(
      config as unknown as ConfigService,
      serviceEm.getRepository(Store) as never,
      new AuditLogService(serviceEm.getRepository(AuditLog) as never),
    );
    (service as any).stripe = fakeStripe;

    const moduleRef = await Test.createTestingModule({
      controllers: [StripeWebhookController],
      providers: [{ provide: StripeService, useValue: service }],
    }).compile();
    app = moduleRef.createNestApplication({ rawBody: true });
    app.use(requestIdMiddleware);
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api/v1');
    await app.init();
    await app.listen(0);
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await side?.end();
    await pg?.close();
  });

  beforeEach(() => {
    logs = [];
    warns = [];
    retrieveCalls = 0;
    onRetrieve = null;
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => {
      warns.push(String(m));
    });
    // Nest's default exception handler logs unknown errors at ERROR level with
    // their message; the sentinel scan must cover that channel too.
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown, ...rest: unknown[]) => {
      warns.push([m, ...rest].map(String).join(' '));
    });
  });
  afterEach(() => jest.restoreAllMocks());

  describe('the signature boundary writes NOTHING (PRB-D1)', () => {
    it('unsigned, forged and tampered deliveries are 400s with a rejected record and no ledger or delivery row', async () => {
      const before = await ledgerCount();
      const body = paidEvent({ id: 'evt_rej_1', invoice: 'in_rej_1', customer: 'cus_none', sub: 'sub_none' });
      expect((await post(body)).status).toBe(400);
      expect((await post(body, { 'stripe-signature': 't=1756700000,v1=' + 'deadbeef'.repeat(8) })).status).toBe(400);
      expect(
        (
          await post(paidEvent({ id: 'evt_rej_2', invoice: 'in_rej_2', customer: 'cus_none', sub: null }), {
            'stripe-signature': sign(body),
          })
        ).status,
      ).toBe(400);
      expect(await ledgerCount()).toEqual(before);
      expect(records().map((r) => r.event)).toEqual([
        'stripe_webhook_rejected',
        'stripe_webhook_rejected',
        'stripe_webhook_rejected',
      ]);
      await nothingLeaked();
    });

    it('an unhandled type is 201, logged with its event id, and leaves no row', async () => {
      const before = await ledgerCount();
      const body = JSON.stringify({
        id: 'evt_pf_1',
        type: 'invoice.payment_failed',
        livemode: false,
        data: { object: { id: 'in_pf_1' } },
      });
      expect((await send(body)).status).toBe(201);
      expect(await ledgerCount()).toEqual(before);
      expect(recordFor('evt_pf_1')[0]).toMatchObject({ disposition: 'unhandled', reason: 'acknowledged' });
    });
  });

  describe('checkout.session.completed', () => {
    it('activates: plan, ACTIVE, C := S, one audit row, applied ledger row, processed delivery — with the echoed request id', async () => {
      const org = await mkOrg({ status: 'PENDING_FIRST_PAYMENT' });
      subscriptions.set('sub_act_1', {
        status: 'active',
        customer: await customerOf(org),
        organizationId: org,
        lookupKey: 'crecimiento',
      });
      const res = await send(
        checkoutEvent({ id: 'evt_act_1', session: 'cs_act_1', sub: 'sub_act_1', org, plan: 'CRECIMIENTO' }),
      );
      expect(res.status).toBe(201);
      expect(await orgRow(org)).toEqual({
        plan: 'CRECIMIENTO',
        status: 'ACTIVE',
        current: 'sub_act_1',
        previous: null,
      });
      expect(await eventRow('evt_act_1')).toMatchObject({
        disposition: 'applied',
        reason: 'activated',
        attempts: 1,
        org,
      });
      expect(await deliveries('evt_act_1')).toEqual([{ outcome: 'processed', error_name: null, sql_state: null }]);
      const [p] = await processings('evt_act_1');
      expect(p).toMatchObject({
        trigger: 'webhook',
        basis: 'event_payload',
        result: 'applied',
        reason: 'activated',
        effect: 'activated',
        actor: null,
      });
      expect(p.audit_log_id).not.toBeNull();
      expect(await auditFor(org)).toEqual([
        { actor: 'stripe', message: expect.stringContaining('Stripe checkout completed: plan CRECIMIENTO') },
      ]);
      const record = recordFor('evt_act_1')[0];
      expect(record).toMatchObject({ disposition: 'applied', reason: 'activated', organizationId: org });
      expect(record.requestId).toBe(res.headers['x-request-id']);
      expect(retrieveCalls).toBe(1);
      await nothingLeaked();
    });

    it('the same event id delivered again is a duplicate: no Stripe call, no re-evaluation, attempt_count 2, one audit row', async () => {
      const org = await mkOrg();
      subscriptions.set('sub_dup_1', {
        status: 'active',
        customer: await customerOf(org),
        organizationId: org,
        lookupKey: 'basico',
      });
      const body = checkoutEvent({ id: 'evt_dup_1', session: 'cs_dup_1', sub: 'sub_dup_1', org, plan: 'BASICO' });
      expect((await send(body)).status).toBe(201);
      retrieveCalls = 0;
      subscriptions.set('sub_dup_1', 'unavailable'); // Stripe down: a settled event must not care
      expect((await send(body)).status).toBe(201);
      expect(retrieveCalls).toBe(0);
      expect(await eventRow('evt_dup_1')).toMatchObject({ disposition: 'applied', attempts: 2 });
      expect((await deliveries('evt_dup_1')).map((x) => x.outcome)).toEqual(['processed', 'duplicate']);
      expect(await auditFor(org)).toHaveLength(1);
      expect(recordFor('evt_dup_1')[1]).toMatchObject({ disposition: 'duplicate', reason: 'activated' });
    });

    it('the same event id delivered three times CONCURRENTLY applies once', async () => {
      const org = await mkOrg();
      subscriptions.set('sub_con_1', {
        status: 'active',
        customer: await customerOf(org),
        organizationId: org,
        lookupKey: 'basico',
      });
      const body = checkoutEvent({ id: 'evt_con_1', session: 'cs_con_1', sub: 'sub_con_1', org, plan: 'BASICO' });
      const results = await Promise.all([send(body), send(body), send(body)]);
      for (const r of results) expect(r.status).toBe(201);
      expect(await eventRow('evt_con_1')).toMatchObject({ disposition: 'applied', attempts: 3 });
      const outcomes = (await deliveries('evt_con_1')).map((x) => x.outcome).sort();
      expect(outcomes).toEqual(['duplicate', 'duplicate', 'processed']);
      expect(await processings('evt_con_1')).toHaveLength(1);
      expect(await auditFor(org)).toHaveLength(1);
    });

    it('a settled event whose RE-EVALUATION would need Stripe is still answered from the ledger while Stripe is down', async () => {
      // The fast path is load-bearing here: the organization's state has not
      // moved (C is still null), so without it the redelivery would retrieve
      // the subscription again — and Stripe is unavailable.
      const org = await mkOrg();
      subscriptions.set('sub_fp_1', {
        status: 'canceled',
        customer: await customerOf(org),
        organizationId: org,
        lookupKey: 'basico',
      });
      const body = checkoutEvent({ id: 'evt_fp_1', session: 'cs_fp_1', sub: 'sub_fp_1', org, plan: 'BASICO' });
      expect((await send(body)).status).toBe(201);
      expect(await eventRow('evt_fp_1')).toMatchObject({
        disposition: 'ignored',
        reason: 'stale_checkout',
        attempts: 1,
      });
      expect(retrieveCalls).toBe(1);
      subscriptions.set('sub_fp_1', 'unavailable');
      retrieveCalls = 0;
      expect((await send(body)).status).toBe(201);
      expect(retrieveCalls).toBe(0);
      expect(await eventRow('evt_fp_1')).toMatchObject({
        disposition: 'ignored',
        reason: 'stale_checkout',
        attempts: 2,
      });
      expect((await deliveries('evt_fp_1')).map((x) => x.outcome)).toEqual(['processed', 'duplicate']);
      expect(recordFor('evt_fp_1')[1]).toMatchObject({ disposition: 'duplicate', reason: 'stale_checkout' });
    });

    it('a DIFFERENT event id for the same session is not re-applied', async () => {
      const org = await mkOrg();
      subscriptions.set('sub_two_1', {
        status: 'active',
        customer: await customerOf(org),
        organizationId: org,
        lookupKey: 'basico',
      });
      expect(
        (await send(checkoutEvent({ id: 'evt_two_a', session: 'cs_two_1', sub: 'sub_two_1', org, plan: 'BASICO' })))
          .status,
      ).toBe(201);
      expect(
        (await send(checkoutEvent({ id: 'evt_two_b', session: 'cs_two_1', sub: 'sub_two_1', org, plan: 'BASICO' })))
          .status,
      ).toBe(201);
      expect(await eventRow('evt_two_b')).toMatchObject({ disposition: 'ignored', reason: 'already_applied' });
      expect(await auditFor(org)).toHaveLength(1);
    });

    it('a stale checkout replayed after cancellation does not un-suspend: former by id, dead by Stripe', async () => {
      const org = await mkOrg({ status: 'SUSPENDED', previous: 'sub_old_1' });
      const customer = await customerOf(org);
      expect(
        (await send(checkoutEvent({ id: 'evt_stale_a', session: 'cs_stale_a', sub: 'sub_old_1', org, plan: 'BASICO' })))
          .status,
      ).toBe(201);
      expect(await eventRow('evt_stale_a')).toMatchObject({ disposition: 'ignored', reason: 'former_subscription' });
      subscriptions.set('sub_dead_1', { status: 'canceled', customer, organizationId: org, lookupKey: 'basico' });
      expect(
        (
          await send(
            checkoutEvent({ id: 'evt_stale_b', session: 'cs_stale_b', sub: 'sub_dead_1', org, plan: 'BASICO' }),
          )
        ).status,
      ).toBe(201);
      expect(await eventRow('evt_stale_b')).toMatchObject({ disposition: 'ignored', reason: 'stale_checkout' });
      expect(await orgRow(org)).toMatchObject({ status: 'SUSPENDED', current: null });
    });

    it('ownership mismatch and no_payment_required are requires_action with no effect and a warn record', async () => {
      const org = await mkOrg();
      subscriptions.set('sub_mis_1', {
        status: 'active',
        customer: 'cus_somebody_else',
        organizationId: org,
        lookupKey: 'basico',
      });
      expect(
        (await send(checkoutEvent({ id: 'evt_mis_1', session: 'cs_mis_1', sub: 'sub_mis_1', org, plan: 'BASICO' })))
          .status,
      ).toBe(201);
      expect(await eventRow('evt_mis_1')).toMatchObject({
        disposition: 'requires_action',
        reason: 'organization_mismatch',
      });
      expect(
        (
          await send(
            checkoutEvent({
              id: 'evt_npr_1',
              session: 'cs_npr_1',
              sub: 'sub_x',
              org,
              plan: 'BASICO',
              paymentStatus: 'no_payment_required',
            }),
          )
        ).status,
      ).toBe(201);
      expect(await eventRow('evt_npr_1')).toMatchObject({
        disposition: 'requires_action',
        reason: 'unexpected_no_payment',
      });
      expect(await orgRow(org)).toMatchObject({ status: 'ACTIVE', current: null, plan: 'BASICO' });
      expect(recordFor('evt_mis_1', 'stripe_webhook_requires_action')[0]).toMatchObject({
        organizationId: org,
        reason: 'organization_mismatch',
      });
    });
  });

  describe('failures leave the effect either wholly committed or wholly absent', () => {
    it('a rollback inside phase one leaves no event row, one failed delivery row with class and SQLSTATE, and a clean retry applies once', async () => {
      const org = await mkOrg({ name: 'ROLLBACK-ME Co' });
      subscriptions.set('sub_rb_1', {
        status: 'active',
        customer: await customerOf(org),
        organizationId: org,
        lookupKey: 'basico',
      });
      await em.execute(
        `create or replace function test_audit_marker() returns trigger language plpgsql as $$
           begin if new.message like '%ROLLBACK-ME%' then raise exception 'forced audit failure SECRET-DRIVER-MESSAGE'; end if; return new; end $$;
         create trigger test_audit_marker before insert on audit_logs for each row execute function test_audit_marker();`,
      );
      const body = checkoutEvent({ id: 'evt_rb_1', session: 'cs_rb_1', sub: 'sub_rb_1', org, plan: 'BASICO' });
      try {
        expect((await send(body)).status).toBe(500);
        expect(await eventRow('evt_rb_1')).toBeNull();
        expect(await processings('evt_rb_1')).toHaveLength(0);
        expect(await deliveries('evt_rb_1')).toEqual([
          { outcome: 'failed', error_name: expect.any(String), sql_state: 'P0001' },
        ]);
        expect(await orgRow(org)).toMatchObject({ status: 'ACTIVE', current: null });
        expect(recordFor('evt_rb_1', 'stripe_webhook_failed')[0]).toMatchObject({ sqlState: 'P0001' });
      } finally {
        await em.execute(`drop trigger if exists test_audit_marker on audit_logs`);
      }
      expect((await send(body)).status).toBe(201);
      expect(await eventRow('evt_rb_1')).toMatchObject({ disposition: 'applied', attempts: 1 });
      expect((await deliveries('evt_rb_1')).map((x) => x.outcome)).toEqual(['failed', 'processed']);
      expect(await auditFor(org)).toHaveLength(1);
      await nothingLeaked();
    });

    it('a commit followed by a delivery-record failure keeps the effect, answers 500 once, and the retry is a duplicate', async () => {
      const org = await mkOrg();
      subscriptions.set('sub_p2_1', {
        status: 'active',
        customer: await customerOf(org),
        organizationId: org,
        lookupKey: 'basico',
      });
      await em.execute(
        `create or replace function test_delivery_marker() returns trigger language plpgsql as $$
           begin if new.event_id = 'evt_p2_1' and new.outcome = 'processed' then raise exception 'delivery store down'; end if; return new; end $$;
         create trigger test_delivery_marker before insert on stripe_webhook_deliveries for each row execute function test_delivery_marker();`,
      );
      const body = checkoutEvent({ id: 'evt_p2_1', session: 'cs_p2_1', sub: 'sub_p2_1', org, plan: 'BASICO' });
      try {
        expect((await send(body)).status).toBe(500);
        expect(await orgRow(org)).toMatchObject({ status: 'ACTIVE', current: 'sub_p2_1' });
        expect(await eventRow('evt_p2_1')).toMatchObject({ disposition: 'applied', attempts: 1 });
        expect(await deliveries('evt_p2_1')).toHaveLength(0);
        expect(recordFor('evt_p2_1', 'stripe_webhook_delivery_record_failed')[0]).toMatchObject({
          disposition: 'applied',
          sqlState: 'P0001',
        });
        retrieveCalls = 0;
        expect((await send(body)).status).toBe(201);
        expect(retrieveCalls).toBe(0);
        expect(await eventRow('evt_p2_1')).toMatchObject({ disposition: 'applied', attempts: 2 });
        expect((await deliveries('evt_p2_1')).map((x) => x.outcome)).toEqual(['duplicate']);
        expect(await auditFor(org)).toHaveLength(1);
      } finally {
        await em.execute(`drop trigger if exists test_delivery_marker on stripe_webhook_deliveries`);
      }
    });
  });

  describe('invoice.paid', () => {
    it('S = C but Stripe says canceled (deletion delayed): payment recorded, status NOT restored; the late deletion then suspends', async () => {
      const org = await mkOrg({ status: 'SUSPENDED', current: 'sub_cur_1' });
      const customer = await customerOf(org);
      subscriptions.set('sub_cur_1', { status: 'canceled', customer, organizationId: org, lookupKey: 'basico' });
      expect(
        (await send(paidEvent({ id: 'evt_late_1', invoice: 'in_late_1', customer, sub: 'sub_cur_1' }))).status,
      ).toBe(201);
      expect(await eventRow('evt_late_1')).toMatchObject({
        disposition: 'applied',
        reason: 'payment_recorded_not_live',
      });
      expect(await paymentsFor('in_late_1')).toBe(1);
      expect(await orgRow(org)).toMatchObject({ status: 'SUSPENDED', current: 'sub_cur_1' });
      expect((await send(deletedEvent({ id: 'evt_del_1', sub: 'sub_cur_1', org }))).status).toBe(201);
      expect(await eventRow('evt_del_1')).toMatchObject({ disposition: 'applied', reason: 'suspended' });
      expect(await orgRow(org)).toEqual({ plan: 'BASICO', status: 'SUSPENDED', current: null, previous: 'sub_cur_1' });
    });

    it('S = C and Stripe says live: restored to ACTIVE with a payment row and an audit row', async () => {
      const org = await mkOrg({ status: 'SUSPENDED', current: 'sub_cur_2' });
      const customer = await customerOf(org);
      subscriptions.set('sub_cur_2', { status: 'active', customer, organizationId: org, lookupKey: 'basico' });
      expect(
        (await send(paidEvent({ id: 'evt_rest_1', invoice: 'in_rest_1', customer, sub: 'sub_cur_2' }))).status,
      ).toBe(201);
      expect(await eventRow('evt_rest_1')).toMatchObject({ disposition: 'applied', reason: 'restored' });
      expect(await orgRow(org)).toMatchObject({ status: 'ACTIVE', current: 'sub_cur_2' });
      expect(await paymentsFor('in_rest_1')).toBe(1);
      expect(await auditFor(org)).toHaveLength(1);
    });

    it('equal-second deletion then invoice: the late final invoice is recorded against the FORMER subscription and never reactivates', async () => {
      const org = await mkOrg({ current: 'sub_eq_1' });
      const customer = await customerOf(org);
      const ts = 1756800000;
      expect((await send(deletedEvent({ id: 'evt_eq_del', sub: 'sub_eq_1', org, created: ts }))).status).toBe(201);
      retrieveCalls = 0;
      expect(
        (await send(paidEvent({ id: 'evt_eq_paid', invoice: 'in_eq_1', customer, sub: 'sub_eq_1', created: ts })))
          .status,
      ).toBe(201);
      expect(retrieveCalls).toBe(0);
      expect(await eventRow('evt_eq_paid')).toMatchObject({
        disposition: 'applied',
        reason: 'payment_recorded_former',
      });
      expect(await paymentsFor('in_eq_1')).toBe(1);
      expect(await orgRow(org)).toEqual({ plan: 'BASICO', status: 'SUSPENDED', current: null, previous: 'sub_eq_1' });
    });

    it('a redelivery of the same invoice under a NEW event id is not recorded twice (explicit guard, no constraint error)', async () => {
      const org = await mkOrg({ current: 'sub_re_1' });
      const customer = await customerOf(org);
      subscriptions.set('sub_re_1', { status: 'active', customer, organizationId: org, lookupKey: 'basico' });
      expect((await send(paidEvent({ id: 'evt_re_a', invoice: 'in_re_1', customer, sub: 'sub_re_1' }))).status).toBe(
        201,
      );
      expect((await send(paidEvent({ id: 'evt_re_b', invoice: 'in_re_1', customer, sub: 'sub_re_1' }))).status).toBe(
        201,
      );
      expect(await eventRow('evt_re_b')).toMatchObject({ disposition: 'ignored', reason: 'object_already_applied' });
      expect(await paymentsFor('in_re_1')).toBe(1);
      expect(recordFor('evt_re_b', 'stripe_webhook_failed')).toHaveLength(0);
    });

    it('invoice-first adoption: unknown S, live and ours, plan from the price, same capacity rule; the later checkout is already applied', async () => {
      const org = await mkOrg({ status: 'PENDING_FIRST_PAYMENT' });
      const customer = await customerOf(org);
      subscriptions.set('sub_adopt_1', { status: 'active', customer, organizationId: org, lookupKey: 'crecimiento' });
      expect(
        (await send(paidEvent({ id: 'evt_adopt_1', invoice: 'in_adopt_1', customer, sub: 'sub_adopt_1', org }))).status,
      ).toBe(201);
      expect(await eventRow('evt_adopt_1')).toMatchObject({ disposition: 'applied', reason: 'adopted' });
      expect(await orgRow(org)).toEqual({
        plan: 'CRECIMIENTO',
        status: 'ACTIVE',
        current: 'sub_adopt_1',
        previous: null,
      });
      expect(await paymentsFor('in_adopt_1')).toBe(1);
      expect(
        (
          await send(
            checkoutEvent({ id: 'evt_adopt_cs', session: 'cs_adopt_1', sub: 'sub_adopt_1', org, plan: 'CRECIMIENTO' }),
          )
        ).status,
      ).toBe(201);
      expect(await eventRow('evt_adopt_cs')).toMatchObject({ disposition: 'ignored', reason: 'already_applied' });
      expect(await auditFor(org)).toHaveLength(1);
    });

    it('adoption refused by plan capacity is requires_action: no payment row, no activation, 200', async () => {
      const org = await mkOrg({ status: 'PENDING_FIRST_PAYMENT', stores: 2 });
      const customer = await customerOf(org);
      subscriptions.set('sub_cap_1', { status: 'active', customer, organizationId: org, lookupKey: 'basico' }); // BASICO allows 1 website
      expect(
        (await send(paidEvent({ id: 'evt_cap_1', invoice: 'in_cap_1', customer, sub: 'sub_cap_1', org }))).status,
      ).toBe(201);
      expect(await eventRow('evt_cap_1')).toMatchObject({
        disposition: 'requires_action',
        reason: 'plan_change_refused',
      });
      expect(await paymentsFor('in_cap_1')).toBe(0);
      expect(await orgRow(org)).toMatchObject({ status: 'PENDING_FIRST_PAYMENT', current: null });
    });

    it('an organization with no store: requires_action/no_store, 200, nothing written', async () => {
      const org = await mkOrg({ current: 'sub_ns_1', stores: 0 });
      const customer = await customerOf(org);
      subscriptions.set('sub_ns_1', { status: 'active', customer, organizationId: org, lookupKey: 'basico' });
      expect((await send(paidEvent({ id: 'evt_ns_1', invoice: 'in_ns_1', customer, sub: 'sub_ns_1' }))).status).toBe(
        201,
      );
      expect(await eventRow('evt_ns_1')).toMatchObject({ disposition: 'requires_action', reason: 'no_store' });
      expect(await paymentsFor('in_ns_1')).toBe(0);
    });
  });

  describe('the shared account (PRB-D5)', () => {
    it('a payment-link session and a manual invoice are foreign: ledger row, no effect, no requires_action record', async () => {
      const before = await ledgerCount();
      expect(
        (
          await send(
            checkoutEvent({ id: 'evt_for_1', session: 'cs_for_1', sub: null, org: null, plan: null, mode: 'payment' }),
          )
        ).status,
      ).toBe(201);
      expect(
        (await send(paidEvent({ id: 'evt_for_2', invoice: 'in_for_2', customer: 'cus_unrelated', sub: null }))).status,
      ).toBe(201);
      expect(await eventRow('evt_for_1')).toMatchObject({ disposition: 'ignored', reason: 'foreign', org: null });
      expect(await eventRow('evt_for_2')).toMatchObject({ disposition: 'ignored', reason: 'foreign', org: null });
      expect((await ledgerCount()).events).toBe(before.events + 2);
      expect(records().filter((r) => r.event === 'stripe_webhook_requires_action')).toHaveLength(0);
      expect(retrieveCalls).toBe(0);
    });
  });

  describe('customer.subscription.deleted', () => {
    it('a deletion for another subscription than the current one is superseded; C null with matching metadata is report-only (PRB-D8)', async () => {
      const org = await mkOrg({ current: 'sub_keep_1' });
      expect((await send(deletedEvent({ id: 'evt_sup_1', sub: 'sub_gone_1', org }))).status).toBe(201);
      expect(await eventRow('evt_sup_1')).toMatchObject({ disposition: 'ignored', reason: 'superseded' });
      expect(await orgRow(org)).toMatchObject({ status: 'ACTIVE', current: 'sub_keep_1' });
      const org2 = await mkOrg();
      expect((await send(deletedEvent({ id: 'evt_meta_1', sub: 'sub_meta_1', org: org2 }))).status).toBe(201);
      expect(await eventRow('evt_meta_1')).toMatchObject({ disposition: 'ignored', reason: 'no_local_subscription' });
      expect(await orgRow(org2)).toMatchObject({ status: 'ACTIVE', current: null });
    });
  });

  describe('the retrieval boundary', () => {
    it('Stripe is asked with NO open transaction and NO advisory lock held by this application', async () => {
      const org = await mkOrg();
      subscriptions.set('sub_bnd_1', {
        status: 'active',
        customer: await customerOf(org),
        organizationId: org,
        lookupKey: 'basico',
      });
      const seen: { openTx: number; advisory: number }[] = [];
      onRetrieve = async () => {
        const tx = await side.query(
          `select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and xact_start is not null`,
        );
        const adv = await side.query(
          `select count(*)::int as n from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())`,
        );
        seen.push({ openTx: tx.rows[0].n, advisory: adv.rows[0].n });
      };
      expect(
        (await send(checkoutEvent({ id: 'evt_bnd_1', session: 'cs_bnd_1', sub: 'sub_bnd_1', org, plan: 'BASICO' })))
          .status,
      ).toBe(201);
      expect(seen).toEqual([{ openTx: 0, advisory: 0 }]);
      expect(await eventRow('evt_bnd_1')).toMatchObject({ disposition: 'applied' });
    });

    it('a concurrent commit between retrieval and the transaction is detected: the claim rolls back and the event is recomputed', async () => {
      const org = await mkOrg();
      subscriptions.set('sub_chg_1', {
        status: 'active',
        customer: await customerOf(org),
        organizationId: org,
        lookupKey: 'basico',
      });
      onRetrieve = async () => {
        await side.query(`update organizations set stripe_subscription_id = 'sub_chg_1' where id = $1`, [org]);
      };
      expect(
        (await send(checkoutEvent({ id: 'evt_chg_1', session: 'cs_chg_1', sub: 'sub_chg_1', org, plan: 'BASICO' })))
          .status,
      ).toBe(201);
      expect(await eventRow('evt_chg_1')).toMatchObject({
        disposition: 'ignored',
        reason: 'already_applied',
        attempts: 1,
      });
      expect(await auditFor(org)).toHaveLength(0);
      expect(await processings('evt_chg_1')).toHaveLength(1);
    });
  });

  describe('requires_action and owner reapply', () => {
    it('plan refused at checkout is durable; two concurrent reapplies after the owner frees capacity produce ONE effect', async () => {
      const org = await mkOrg({ status: 'PENDING_FIRST_PAYMENT', stores: 2 });
      const customer = await customerOf(org);
      subscriptions.set('sub_ra_1', { status: 'active', customer, organizationId: org, lookupKey: 'basico' });
      expect(
        (await send(checkoutEvent({ id: 'evt_ra_1', session: 'cs_ra_1', sub: 'sub_ra_1', org, plan: 'BASICO' })))
          .status,
      ).toBe(201);
      expect(await eventRow('evt_ra_1')).toMatchObject({
        disposition: 'requires_action',
        reason: 'plan_change_refused',
        resolved: null,
      });
      expect(await orgRow(org)).toMatchObject({ status: 'PENDING_FIRST_PAYMENT', current: null });
      expect(recordFor('evt_ra_1', 'stripe_webhook_requires_action')).toHaveLength(1);

      const userId = await insertMinimalUser(em);
      // Still refused: the owner has not acted yet — recorded as a no_change attempt, disposition unchanged.
      const still = await reapply('evt_ra_1', { id: userId, email: 'owner@example.test' }, 'req-reapply-0');
      expect(still).toEqual({ kind: 'no_change', reason: 'plan_change_refused' });
      expect(await eventRow('evt_ra_1')).toMatchObject({ disposition: 'requires_action', resolved: null });

      await em.execute(`update stores set archived_at = now() where organization_id = ?::uuid and slug like '%-1'`, [
        org,
      ]);
      const [a, b] = await Promise.all([
        reapply('evt_ra_1', { id: userId, email: 'owner@example.test' }, 'req-reapply-1'),
        reapply('evt_ra_1', { id: userId, email: 'owner@example.test' }, 'req-reapply-2'),
      ]);
      const kinds = [a.kind, b.kind].sort();
      expect(kinds).toEqual(['already_resolved', 'resolved']);
      expect(await orgRow(org)).toEqual({ plan: 'BASICO', status: 'ACTIVE', current: 'sub_ra_1', previous: null });
      const row = await eventRow('evt_ra_1');
      expect(row).toMatchObject({ disposition: 'applied', reason: 'activated' });
      expect(row.resolved).not.toBeNull();
      const p = await processings('evt_ra_1');
      expect(p.map((x) => [x.trigger, x.result, x.effect])).toEqual([
        ['webhook', 'requires_action', 'none'],
        ['reapply', 'no_change', 'none'],
        ['reapply', 'applied', 'activated'],
      ]);
      expect(p[2].actor).toBe(userId);
      const audit = await auditFor(org);
      expect(audit).toHaveLength(1);
      expect(audit[0].actor).toBe('owner@example.test');
      expect(records().filter((r) => r.event === 'stripe_event_reapplied')).toHaveLength(3);
      // A third reapply after resolution changes nothing.
      expect(await reapply('evt_ra_1', { id: userId, email: 'owner@example.test' }, 'req-reapply-3')).toEqual({
        kind: 'already_resolved',
      });
      expect(await reapply('evt_never_seen', { id: userId, email: 'owner@example.test' }, 'req-reapply-4')).toEqual({
        kind: 'not_found',
      });
    });

    it('reapply asks Stripe before its transaction, never inside it', async () => {
      const org = await mkOrg({ current: 'sub_rb2', stores: 0 });
      const customer = await customerOf(org);
      subscriptions.set('sub_rb2', { status: 'active', customer, organizationId: org, lookupKey: 'basico' });
      expect((await send(paidEvent({ id: 'evt_rb2', invoice: 'in_rb2', customer, sub: 'sub_rb2' }))).status).toBe(201);
      expect(await eventRow('evt_rb2')).toMatchObject({ disposition: 'requires_action', reason: 'no_store' });
      await em.execute(
        `insert into stores (name, slug, organization_id, created_at, updated_at) values ('Late Store', 'late-store-rb2', ?::uuid, now(), now())`,
        [org],
      );
      const seen: number[] = [];
      onRetrieve = async () => {
        const tx = await side.query(
          `select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and xact_start is not null`,
        );
        seen.push(tx.rows[0].n);
      };
      const userId = await insertMinimalUser(em);
      const out = await reapply('evt_rb2', { id: userId, email: 'owner@example.test' }, 'req-reapply-rb2');
      expect(out).toEqual({ kind: 'resolved', result: 'applied', reason: 'restored' });
      expect(seen).toEqual([0]);
      expect(await paymentsFor('in_rb2')).toBe(1);
      expect(await orgRow(org)).toMatchObject({ status: 'ACTIVE', current: 'sub_rb2' });
    });
  });

  describe('manual writers stay distinguishable', () => {
    it('an owner status change carries a user actor; Stripe transitions carry "stripe" and a processing row', async () => {
      const org = await mkOrg({ current: 'sub_man_1' });
      await em.execute(`update organizations set billing_status = 'SUSPENDED' where id = ?::uuid`, [org]);
      await em.execute(
        `insert into audit_logs (actor_user_id, actor_email, organization_id, entity_type, entity_id, action, changes, message, created_at)
         values (null, 'owner@example.test', ?::uuid, 'ORGANIZATION', ?::uuid, 'UPDATE', '{}', 'manual correction', now())`,
        [org, org],
      );
      expect((await send(deletedEvent({ id: 'evt_man_1', sub: 'sub_man_1', org }))).status).toBe(201);
      const audit = await auditFor(org);
      expect(audit.map((a) => a.actor)).toEqual(['owner@example.test', 'stripe']);
      const [p] = await processings('evt_man_1');
      expect(p.audit_log_id).not.toBeNull();
      const [linked]: { actor_email: string }[] = await em.execute(
        `select actor_email from audit_logs where id = ?::uuid`,
        [p.audit_log_id],
      );
      expect(linked.actor_email).toBe('stripe');
    });
  });

  describe('price mapping and ownership never fail open', () => {
    it('a subscription on a missing, unknown or different price never activates', async () => {
      const org = await mkOrg({ status: 'PENDING_FIRST_PAYMENT' });
      const customer = await customerOf(org);
      subscriptions.set('sub_px_none', { status: 'active', customer, organizationId: org, lookupKey: null });
      subscriptions.set('sub_px_unknown', {
        status: 'active',
        customer,
        organizationId: org,
        lookupKey: 'gold_legacy',
      });
      subscriptions.set('sub_px_other', { status: 'active', customer, organizationId: org, lookupKey: 'basico' });
      expect(
        (
          await send(
            checkoutEvent({ id: 'evt_px_1', session: 'cs_px_1', sub: 'sub_px_none', org, plan: 'CRECIMIENTO' }),
          )
        ).status,
      ).toBe(201);
      expect(await eventRow('evt_px_1')).toMatchObject({ disposition: 'requires_action', reason: 'price_unmapped' });
      expect(
        (
          await send(
            checkoutEvent({ id: 'evt_px_2', session: 'cs_px_2', sub: 'sub_px_unknown', org, plan: 'CRECIMIENTO' }),
          )
        ).status,
      ).toBe(201);
      expect(await eventRow('evt_px_2')).toMatchObject({ disposition: 'requires_action', reason: 'price_unmapped' });
      expect(
        (
          await send(
            checkoutEvent({ id: 'evt_px_3', session: 'cs_px_3', sub: 'sub_px_other', org, plan: 'CRECIMIENTO' }),
          )
        ).status,
      ).toBe(201);
      expect(await eventRow('evt_px_3')).toMatchObject({ disposition: 'requires_action', reason: 'plan_mismatch' });
      expect(await orgRow(org)).toEqual({
        plan: 'BASICO',
        status: 'PENDING_FIRST_PAYMENT',
        current: null,
        previous: null,
      });
      expect(await auditFor(org)).toHaveLength(0);
    });

    it('missing ownership evidence on the Stripe subscription is requires_action, not access', async () => {
      const org = await mkOrg({ status: 'SUSPENDED', current: 'sub_own_1' });
      const customer = await customerOf(org);
      subscriptions.set('sub_own_1', { status: 'active', customer, organizationId: null, lookupKey: 'basico' });
      expect((await send(paidEvent({ id: 'evt_own_1', invoice: 'in_own_1', customer, sub: 'sub_own_1' }))).status).toBe(
        201,
      );
      expect(await eventRow('evt_own_1')).toMatchObject({
        disposition: 'requires_action',
        reason: 'ownership_unverified',
      });
      expect(await paymentsFor('in_own_1')).toBe(0);
      subscriptions.set('sub_own_2', { status: 'active', customer: '', organizationId: org, lookupKey: 'basico' });
      expect(
        (await send(checkoutEvent({ id: 'evt_own_2', session: 'cs_own_2', sub: 'sub_own_2', org, plan: 'BASICO' })))
          .status,
      ).toBe(201);
      expect(await eventRow('evt_own_2')).toMatchObject({
        disposition: 'requires_action',
        reason: 'ownership_unverified',
      });
      expect(await orgRow(org)).toMatchObject({ status: 'SUSPENDED', current: 'sub_own_1' });
    });
  });

  describe('review-round findings, pinned', () => {
    it('a NON-UUID organization id in the metadata is a decision (unknown_organization), not a failure loop, and its value never reaches a log', async () => {
      const body = JSON.stringify({
        id: 'evt_badorg_1',
        type: 'checkout.session.completed',
        livemode: false,
        created: 1756700000,
        data: {
          object: {
            id: 'cs_badorg_1',
            object: 'checkout.session',
            mode: 'subscription',
            status: 'complete',
            payment_status: 'paid',
            subscription: 'sub_badorg_1',
            metadata: { organizationId: 'SECRET-METADATA-acme', plan: 'BASICO' },
          },
        },
      });
      expect((await send(body)).status).toBe(201);
      expect(await eventRow('evt_badorg_1')).toMatchObject({
        disposition: 'requires_action',
        reason: 'unknown_organization',
      });
      expect((await deliveries('evt_badorg_1')).map((x) => x.outcome)).toEqual(['processed']);
      expect(retrieveCalls).toBe(0);
      await nothingLeaked();
    });

    it('a handler failure answers an OPAQUE 500: no driver message in the response body or in any log level', async () => {
      const org = await mkOrg({ name: 'ROLLBACK-ME Opaque Co' });
      subscriptions.set('sub_op_1', {
        status: 'active',
        customer: await customerOf(org),
        organizationId: org,
        lookupKey: 'basico',
      });
      await em.execute(
        `create or replace function test_audit_marker() returns trigger language plpgsql as $$
           begin if new.message like '%ROLLBACK-ME%' then raise exception 'forced audit failure SECRET-DRIVER-MESSAGE'; end if; return new; end $$;
         create trigger test_audit_marker before insert on audit_logs for each row execute function test_audit_marker();`,
      );
      try {
        const res = await send(
          checkoutEvent({ id: 'evt_op_1', session: 'cs_op_1', sub: 'sub_op_1', org, plan: 'BASICO' }),
        );
        expect(res.status).toBe(500);
        expect(res.json).toEqual({
          message: 'Stripe webhook processing failed',
          error: 'Internal Server Error',
          statusCode: 500,
        });
        await nothingLeaked();
      } finally {
        await em.execute(`drop trigger if exists test_audit_marker on audit_logs`);
      }
    });

    it('an invoice APPLIED in the ledger is not applied again under a new event id even after its payment row was deleted', async () => {
      const org = await mkOrg({ current: 'sub_del_1' });
      const customer = await customerOf(org);
      subscriptions.set('sub_del_1', { status: 'active', customer, organizationId: org, lookupKey: 'basico' });
      expect((await send(paidEvent({ id: 'evt_del_a', invoice: 'in_del_1', customer, sub: 'sub_del_1' }))).status).toBe(
        201,
      );
      expect(await eventRow('evt_del_a')).toMatchObject({ disposition: 'applied' });
      await em.execute(`delete from payments where stripe_invoice_id = 'in_del_1'`);
      expect((await send(paidEvent({ id: 'evt_del_b', invoice: 'in_del_1', customer, sub: 'sub_del_1' }))).status).toBe(
        201,
      );
      expect(await eventRow('evt_del_b')).toMatchObject({ disposition: 'ignored', reason: 'object_already_applied' });
      expect((await deliveries('evt_del_b')).map((x) => x.outcome)).toEqual(['processed']);
      expect(await paymentsFor('in_del_1')).toBe(0);
    });

    it('reapply on an event whose recorded company is archived stays OPEN as organization_unavailable, never "foreign"', async () => {
      const org = await mkOrg({ current: 'sub_arch_1', stores: 0 });
      const customer = await customerOf(org);
      subscriptions.set('sub_arch_1', { status: 'active', customer, organizationId: org, lookupKey: 'basico' });
      expect(
        (await send(paidEvent({ id: 'evt_arch_1', invoice: 'in_arch_1', customer, sub: 'sub_arch_1' }))).status,
      ).toBe(201);
      expect(await eventRow('evt_arch_1')).toMatchObject({ disposition: 'requires_action', reason: 'no_store', org });
      await em.execute(`update organizations set archived_at = now() where id = ?::uuid`, [org]);
      const userId = await insertMinimalUser(em);
      expect(await reapply('evt_arch_1', { id: userId, email: 'owner@example.test' }, 'req-arch-1')).toEqual({
        kind: 'no_change',
        reason: 'organization_unavailable',
      });
      expect(await eventRow('evt_arch_1')).toMatchObject({
        disposition: 'requires_action',
        reason: 'no_store',
        resolved: null,
      });
      expect((await processings('evt_arch_1')).map((p) => [p.trigger, p.result, p.reason])).toEqual([
        ['webhook', 'requires_action', 'no_store'],
        ['reapply', 'no_change', 'organization_unavailable'],
      ]);
    });
  });

  describe('reapply keeps the event on its recorded identity', () => {
    it('metadata changed in Stripe to another company cannot redirect the event; the attempt is recorded and refused', async () => {
      const org = await mkOrg({ status: 'PENDING_FIRST_PAYMENT', stores: 2 });
      const other = await mkOrg();
      const customer = await customerOf(org);
      subscriptions.set('sub_id_1', { status: 'active', customer, organizationId: org, lookupKey: 'basico' });
      expect(
        (await send(checkoutEvent({ id: 'evt_id_1', session: 'cs_id_1', sub: 'sub_id_1', org, plan: 'BASICO' })))
          .status,
      ).toBe(201);
      expect(await eventRow('evt_id_1')).toMatchObject({
        disposition: 'requires_action',
        reason: 'plan_change_refused',
        org,
      });
      // The owner frees capacity; meanwhile the session's metadata in Stripe now names ANOTHER company.
      await em.execute(`update stores set archived_at = now() where organization_id = ?::uuid and slug like '%-1'`, [
        org,
      ]);
      const session = sessionsById.get('cs_id_1') as Record<string, any>;
      sessionsById.set('cs_id_1', { ...session, metadata: { ...session.metadata, organizationId: other } });
      const userId = await insertMinimalUser(em);
      expect(await reapply('evt_id_1', { id: userId, email: 'owner@example.test' }, 'req-id-1')).toEqual({
        kind: 'no_change',
        reason: 'identity_changed',
      });
      expect(await eventRow('evt_id_1')).toMatchObject({ disposition: 'requires_action', org, resolved: null });
      expect(await orgRow(other)).toMatchObject({ status: 'ACTIVE', current: null, plan: 'BASICO' });
      expect(await orgRow(org)).toMatchObject({ status: 'PENDING_FIRST_PAYMENT', current: null });
      expect((await processings('evt_id_1')).map((p) => [p.trigger, p.result, p.reason])).toEqual([
        ['webhook', 'requires_action', 'plan_change_refused'],
        ['reapply', 'no_change', 'identity_changed'],
      ]);
      // A session now naming a different subscription is refused the same way.
      sessionsById.set('cs_id_1', { ...session, subscription: 'sub_swapped' });
      expect(await reapply('evt_id_1', { id: userId, email: 'owner@example.test' }, 'req-id-2')).toEqual({
        kind: 'no_change',
        reason: 'identity_changed',
      });
      // With the recorded identity intact, the reapply resolves against the RECORDED organization.
      sessionsById.set('cs_id_1', session);
      expect(await reapply('evt_id_1', { id: userId, email: 'owner@example.test' }, 'req-id-3')).toEqual({
        kind: 'resolved',
        result: 'applied',
        reason: 'activated',
      });
      expect(await orgRow(org)).toMatchObject({ status: 'ACTIVE', current: 'sub_id_1' });
      expect(await orgRow(other)).toMatchObject({ status: 'ACTIVE', current: null });
    });
  });
});
