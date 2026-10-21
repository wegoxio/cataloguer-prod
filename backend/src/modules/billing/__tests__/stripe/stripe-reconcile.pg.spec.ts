import * as http from 'http';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { requestIdMiddleware } from '../../../../common/observability/request-id';
import { StripeReconcileController } from '../../stripe/stripe-reconcile.controller';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { Store } from '../../../stores/entities/store.entity';
import { AuditLog } from '../../../audit-log/entities/audit-log.entity';
import { AuditLogService } from '../../../audit-log/audit-log.service';
import { StripeService } from '../../stripe/stripe.service';
import { RECONCILE_BOUNDS, StripeReconcileService } from '../../stripe/stripe-reconcile.service';

/**
 * The reconciliation report on real PostgreSQL (#248, PR D).
 *
 * What this file proves and nothing else can: the report READS and only reads —
 * the database transaction is read-only so a write is refused by PostgreSQL
 * itself, and the injected Stripe throws on every mutating method, so a call to
 * one would fail the suite rather than pass unnoticed. It also proves the
 * classifications against real rows, the bounds, the redaction, and that a run
 * leaves the ledger, the attempts and every organization exactly as it found
 * them.
 */
const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

d('#248 PR D — the read-only reconciliation report', () => {
  jest.setTimeout(300_000);
  let pg: DisposablePg;
  let em: EntityManager;
  let service: StripeReconcileService;

  // ── a Stripe that REFUSES to be mutated ─────────────────────────────────
  type Sub = { id: string; customer: string | null; status: string; lookupKey: string | null };
  let subscriptions: Sub[] = [];
  let listCalls: { limit?: number; starting_after?: string; status?: string }[] = [];
  let failList: Record<string, unknown> | null = null;
  const forbidden = (name: string) => () => {
    throw new Error(`READ-ONLY VIOLATION: the report called ${name}`);
  };
  const page = (params: { limit?: number; starting_after?: string; status?: string; customer?: string }) => {
    listCalls.push(params);
    if (failList) throw Object.assign(new Error('SECRET-STRIPE-MESSAGE'), failList);
    const limit = params.limit ?? 10;
    // Real Stripe filters by customer; a fake that ignored it would let a
    // targeted lookup "find" other people's subscriptions.
    const pool = params.customer ? subscriptions.filter((s) => s.customer === params.customer) : subscriptions;
    const from = params.starting_after ? pool.findIndex((s) => s.id === params.starting_after) + 1 : 0;
    const slice = pool.slice(from, from + limit);
    return {
      object: 'list',
      has_more: from + limit < pool.length,
      data: slice.map((s) => ({
        id: s.id,
        object: 'subscription',
        customer: s.customer,
        status: s.status,
        // A realistic object carries far more than we read; none of it may surface.
        metadata: { organizationId: 'SECRET-METADATA', note: 'SECRET-METADATA' },
        customer_email: 'SECRET-EMAIL@example.test',
        latest_invoice: { hosted_invoice_url: 'https://example.test/SECRET-INVOICE-URL' },
        items: { data: [{ price: { lookup_key: s.lookupKey, id: 'price_SECRET' } }] },
      })),
    };
  };
  const fakeStripe = {
    subscriptions: {
      list: async (p: never) => page(p),
      create: forbidden('subscriptions.create'),
      update: forbidden('subscriptions.update'),
      cancel: forbidden('subscriptions.cancel'),
      del: forbidden('subscriptions.del'),
    },
    checkout: {
      sessions: {
        create: forbidden('checkout.sessions.create'),
        expire: forbidden('checkout.sessions.expire'),
        retrieve: forbidden('checkout.sessions.retrieve'),
      },
    },
    customers: {
      create: forbidden('customers.create'),
      update: forbidden('customers.update'),
      del: forbidden('customers.del'),
      search: forbidden('customers.search'),
    },
    events: { list: forbidden('events.list'), retrieve: forbidden('events.retrieve') },
    invoices: {
      create: forbidden('invoices.create'),
      pay: forbidden('invoices.pay'),
      retrieve: forbidden('invoices.retrieve'),
    },
    prices: { create: forbidden('prices.create'), list: forbidden('prices.list') },
    webhooks: { constructEvent: forbidden('webhooks.constructEvent') },
  };

  // ── fixtures ────────────────────────────────────────────────────────────
  let seq = 0;
  const mkOrg = async (
    o: { slug?: string; plan?: string; customer?: string | null; sub?: string | null; archived?: boolean } = {},
  ) => {
    seq++;
    const slug = o.slug ?? `rec-co-${seq}`;
    const [row]: { id: string }[] = await em.execute(
      `insert into organizations (name, slug, plan, billing_status, stripe_customer_id, stripe_subscription_id, archived_at, created_at, updated_at)
       values (?, ?, ?, 'ACTIVE', ?, ?, ${o.archived ? 'now()' : 'null'}, now(), now()) returning id`,
      [
        `Rec Co ${seq}`,
        slug,
        o.plan ?? 'BASICO',
        o.customer === undefined ? `cus_rec_${seq}` : o.customer,
        o.sub ?? null,
      ],
    );
    return { id: row.id, slug, customer: o.customer === undefined ? `cus_rec_${seq}` : o.customer };
  };
  const mkEvent = async (o: {
    id: string;
    org: string | null;
    reason: string;
    disposition?: string;
    resolved?: boolean;
    livemode?: boolean;
  }) =>
    em.execute(
      `insert into stripe_events (event_id, event_type, event_created_at, livemode, object_type, object_id, organization_id,
         claim_token, first_request_id, first_seen_at, last_received_at, disposition, reason_code, disposed_at, resolved_at, resolved_by_user_id, resolution_code)
       values (?, 'checkout.session.completed', now(), ${o.livemode === false ? 'false' : 'true'}, 'checkout.session', ?, ?::uuid, gen_random_uuid(), 'req', now(), now(), ?, ?, now(), ${o.resolved ? 'now()' : 'null'}, ${o.resolved ? 'gen_random_uuid()' : 'null'}, ${o.resolved ? "'applied'" : 'null'})`,
      [o.id, `cs_${o.id}`, o.org, o.disposition ?? 'requires_action', o.reason],
    );
  const mkAttempt = async (o: {
    org: string;
    status: string;
    failure?: string | null;
    ageMinutes?: number;
    session?: string | null;
  }) =>
    em.execute(
      `insert into billing_checkout_attempts (organization_id, plan, status, stripe_idempotency_key, request_params, stripe_customer_id,
         failure_code, stripe_session_id, settled_at, created_at, updated_at)
       values (?::uuid, 'BASICO', ?, ?, '{}'::jsonb, 'cus_x', ?, ?, ${o.status === 'failed' ? 'now()' : 'null'},
         now() - (? || ' minutes')::interval, now() - (? || ' minutes')::interval)`,
      [
        o.org,
        o.status,
        `checkout:${randomUUID()}`,
        o.failure ?? null,
        o.session ?? null,
        String(o.ageMinutes ?? 0),
        String(o.ageMinutes ?? 0),
      ],
    );

  let logs: string[];
  let warns: string[];
  const records = () =>
    [...logs, ...warns]
      .map((l) => l.match(/\{"event":"stripe_reconcile_report"[^\n]*\}/)?.[0])
      .filter((x): x is string => !!x)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  const SENTINELS = ['SECRET-METADATA', 'SECRET-EMAIL', 'SECRET-INVOICE-URL', 'SECRET-STRIPE-MESSAGE', 'price_SECRET'];
  const ledgerCounts = async () => {
    const [row]: any[] = await em.execute(
      `select (select count(*) from stripe_events)::int as e, (select count(*) from stripe_event_processings)::int as p,
              (select count(*) from stripe_webhook_deliveries)::int as d, (select count(*) from billing_checkout_attempts)::int as a,
              (select count(*) from organizations)::int as o, (select count(*) from payments)::int as pay`,
    );
    return row;
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    const serviceEm = pg.orm.em.fork() as EntityManager;
    const stripeService = new StripeService(
      { get: () => 'sk_test_offline' } as unknown as ConfigService,
      serviceEm.getRepository(Store) as never,
      new AuditLogService(serviceEm.getRepository(AuditLog) as never),
    );
    (stripeService as never as { stripe: unknown }).stripe = fakeStripe;
    service = new StripeReconcileService(serviceEm.getRepository(Store) as never, stripeService);
  }, 300_000);

  afterAll(async () => {
    await pg?.close();
  });

  beforeEach(() => {
    logs = [];
    warns = [];
    listCalls = [];
    failList = null;
    jest.spyOn(Logger.prototype, 'log').mockImplementation((m: unknown) => {
      logs.push(String(m));
    });
    jest.spyOn(Logger.prototype, 'warn').mockImplementation((m: unknown) => {
      warns.push(String(m));
    });
    jest.spyOn(Logger.prototype, 'error').mockImplementation((m: unknown, ...r: unknown[]) => {
      warns.push([m, ...r].map(String).join(' '));
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const run = (over: Partial<{ limit: number; maxStripePages: number }> = {}) =>
    service.report({ requestId: randomUUID(), ...over });

  it('1. with no Stripe subscriptions there is nothing ACTIONABLE, and Stripe is read exactly once', async () => {
    subscriptions = [];
    const r = await run();
    // The migrations seed a `default` organization that never had a card
    // customer. That is correctly reported at `info`, never as an action — so
    // the meaningful assertion is that nothing needs a person.
    expect(r.findings.filter((f) => f.severity === 'action')).toEqual([]);
    expect(r.counts.organization_without_customer).toBeGreaterThanOrEqual(1);
    expect(r.bounds.stripePagesRead).toBe(1);
    expect(r.bounds.stripeTruncated).toBe(false);
    expect(listCalls[0]).toMatchObject({ status: 'all', limit: RECONCILE_BOUNDS.stripePageSize });
  });

  it('2. it classifies real rows: missing locally, not live, plan mismatch, in sync, foreign', async () => {
    const a = await mkOrg({ slug: 'rec-missing-local' });
    const b = await mkOrg({ slug: 'rec-not-live', sub: 'sub_b' });
    const c = await mkOrg({ slug: 'rec-mismatch', plan: 'BASICO', sub: 'sub_c' });
    const dOrg = await mkOrg({ slug: 'rec-in-sync', plan: 'BASICO', sub: 'sub_d' });
    subscriptions = [
      { id: 'sub_a', customer: a.customer, status: 'active', lookupKey: 'basico' },
      { id: 'sub_b', customer: b.customer, status: 'canceled', lookupKey: 'basico' },
      { id: 'sub_c', customer: c.customer, status: 'active', lookupKey: 'multimarca' },
      { id: 'sub_d', customer: dOrg.customer, status: 'active', lookupKey: 'basico' },
      { id: 'sub_foreign', customer: 'cus_someone_else', status: 'active', lookupKey: null },
    ];
    const r = await run();
    const by = Object.fromEntries(r.findings.map((f) => [f.organizationSlug ?? f.subscriptionId, f.classification]));
    expect(by['rec-missing-local']).toBe('subscription_missing_locally');
    expect(by['rec-not-live']).toBe('subscription_not_live');
    expect(by['rec-mismatch']).toBe('plan_mismatch');
    expect(by['sub_foreign']).toBe('customer_not_ours');
    expect(r.counts.in_sync).toBeGreaterThanOrEqual(1);
    expect(r.findings.find((f) => f.organizationSlug === 'rec-in-sync')).toBeUndefined();
  });

  it('3. an ARCHIVED company Stripe is still charging is an ACTION, not foreign traffic', async () => {
    const archived = await mkOrg({ slug: 'rec-archived-live', archived: true, sub: null });
    const archivedQuiet = await mkOrg({ slug: 'rec-archived-quiet', archived: true, sub: null });
    subscriptions = [{ id: 'sub_arch_live', customer: archived.customer, status: 'active', lookupKey: 'basico' }];
    const r = await run({ limit: 100 });
    const live = r.findings.find((f) => f.organizationSlug === 'rec-archived-live');
    expect(live).toMatchObject({
      classification: 'subscription_for_archived_organization',
      severity: 'action',
      subscriptionId: 'sub_arch_live',
      reasonCode: 'archived_but_still_billed',
    });
    // It must NOT be dismissed as a stranger's subscription.
    expect(
      r.findings.some((f) => f.subscriptionId === 'sub_arch_live' && f.classification === 'customer_not_ours'),
    ).toBe(false);
    // An archived company with nothing live at Stripe raises nothing.
    expect(r.findings.some((f) => f.organizationId === archivedQuiet.id)).toBe(false);
  });

  it('4. open ledger items and attempts become findings; RESOLVED ones do not', async () => {
    const org = await mkOrg({ slug: 'rec-open' });
    await mkEvent({ id: 'evt_open_1', org: org.id, reason: 'plan_change_refused' });
    await mkEvent({
      id: 'evt_resolved_1',
      org: org.id,
      reason: 'plan_change_refused',
      resolved: true,
      disposition: 'applied',
    });
    // The shape the `resolved_at is null` clause exists for: still labelled
    // requires_action but already resolved. Without that clause it would be
    // reported forever as an open action.
    await mkEvent({ id: 'evt_resolved_2', org: org.id, reason: 'plan_change_refused', resolved: true });
    await mkAttempt({ org: org.id, status: 'failed', failure: 'unreconciled' });
    await mkAttempt({
      org: org.id,
      status: 'open',
      ageMinutes: RECONCILE_BOUNDS.stuckOpenAttemptMinutes + 10,
      session: 'cs_stuck',
    });
    // A SECOND company for the fresh attempt: PR C's partial unique index
    // allows only one creating/open attempt per organization, and that
    // invariant is doing its job here.
    const fresh = await mkOrg({ slug: 'rec-open-fresh' });
    await mkAttempt({ org: fresh.id, status: 'open', ageMinutes: 1, session: 'cs_fresh' });
    subscriptions = [];
    const r = await run({ limit: 100 });
    const mine = r.findings.filter((f) => f.organizationId === org.id);
    expect(mine.map((f) => f.classification).sort()).toEqual([
      'attempt_stuck_open',
      'attempt_unreconciled',
      'unresolved_event',
    ]);
    expect(mine.find((f) => f.classification === 'unresolved_event')).toMatchObject({
      eventId: 'evt_open_1',
      reasonCode: 'plan_change_refused',
    });
    expect(r.findings.some((f) => f.eventId === 'evt_resolved_1')).toBe(false);
    expect(r.findings.some((f) => f.eventId === 'evt_resolved_2')).toBe(false);
    // The young attempt on the other company is NOT stuck and must not appear.
    expect(r.findings.some((f) => f.organizationId === fresh.id && f.classification === 'attempt_stuck_open')).toBe(
      false,
    );
  });

  it('4b. a TEST-MODE ledger event is never reported as a production action', async () => {
    const org = await mkOrg({ slug: 'rec-testmode' });

    await mkEvent({ id: 'evt_testmode', org: org.id, reason: 'plan_change_refused', livemode: false });

    subscriptions = [];

    const r = await run({ limit: 200 });

    expect(r.findings.some((f) => f.eventId === 'evt_testmode')).toBe(false);
  });

  it('5a. READ-ONLY: every statement the report issues is a read, and it declares the transaction read-only', async () => {
    // Intercept at the CONNECTION, not the EntityManager: `em.transactional`
    // hands the callback a forked manager, so a wrapper on the outer one would
    // see nothing — which is exactly what a first attempt at this test did.
    const conn = pg.orm.em.getConnection() as unknown as { execute: (...a: unknown[]) => unknown };
    const original = conn.execute.bind(conn);
    const seen: string[] = [];
    conn.execute = (...args: unknown[]) => {
      seen.push(String(args[0]));
      return original(...args);
    };
    try {
      subscriptions = [];
      await service.report({ requestId: randomUUID() });
    } finally {
      conn.execute = original;
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((q) => /set transaction read only/i.test(q))).toBe(true);
    for (const q of seen) {
      // Reads, the two session settings, and transaction control only. An
      // insert, update, delete, truncate, alter, drop or create would be a write.
      expect(q.trim().toLowerCase()).toMatch(
        /^(select|set transaction read only|set local statement_timeout|begin|commit|rollback|savepoint|release)/,
      );
      expect(q).not.toMatch(/\b(insert into|update |delete from|truncate|alter table|drop table|create table)/i);
    }
  });

  it('5. READ-ONLY: a run changes nothing — ledger, attempts, organizations and payments are identical after', async () => {
    const before = await ledgerCounts();
    const beforeOrgs = await em.execute(
      `select id, plan, billing_status, stripe_subscription_id, updated_at, archived_at from organizations order by slug`,
    );
    const beforeEvents = await em.execute(
      `select event_id, disposition, attempt_count, resolved_at from stripe_events order by event_id`,
    );
    const beforeAttempts = await em.execute(
      `select id, status, settle_note, updated_at from billing_checkout_attempts order by created_at`,
    );
    await run({ limit: 200 });
    await run({ limit: 200 });
    expect(await ledgerCounts()).toEqual(before);
    expect(
      await em.execute(
        `select id, plan, billing_status, stripe_subscription_id, updated_at, archived_at from organizations order by slug`,
      ),
    ).toEqual(beforeOrgs);
    expect(
      await em.execute(`select event_id, disposition, attempt_count, resolved_at from stripe_events order by event_id`),
    ).toEqual(beforeEvents);
    expect(
      await em.execute(`select id, status, settle_note, updated_at from billing_checkout_attempts order by created_at`),
    ).toEqual(beforeAttempts);
  });

  it('6. READ-ONLY: the transaction really is read-only, so a write inside it is refused by PostgreSQL', async () => {
    await expect(
      (em as EntityManager).transactional(async (tem) => {
        await tem.execute('set transaction read only');
        await tem.execute(`update organizations set plan = 'MULTIMARCA' where slug = 'rec-open'`);
      }),
    ).rejects.toThrow(/read-only|read only/i);
    const [row]: any[] = await em.execute(`select plan from organizations where slug = 'rec-open'`);
    expect(row.plan).toBe('BASICO');
  });

  it('7. READ-ONLY: no mutating Stripe method is reachable — the fake throws on every one', async () => {
    await run();
    // Prove the guard is real by calling one directly.
    expect(() => (fakeStripe.subscriptions as never as { create: () => void }).create()).toThrow(/READ-ONLY VIOLATION/);
    expect(() => (fakeStripe.checkout.sessions as never as { expire: () => void }).expire()).toThrow(
      /READ-ONLY VIOLATION/,
    );
    expect(() => (fakeStripe.events as never as { list: () => void }).list()).toThrow(/READ-ONLY VIOLATION/);
    // And that the report only ever used subscriptions.list.
    expect(listCalls.length).toBeGreaterThan(0);
  });

  it('8. BOUNDS: Stripe paging stops at maxStripePages and says it truncated', async () => {
    subscriptions = Array.from({ length: 350 }, (_, i) => ({
      id: `sub_page_${i}`,
      customer: `cus_page_${i}`,
      status: 'active',
      lookupKey: 'basico',
    }));
    const r = await run({ maxStripePages: 2, limit: 5 });
    expect(r.bounds.stripePagesRead).toBe(2);
    expect(r.bounds.stripeTruncated).toBe(true);
    expect(r.bounds.stripeSubscriptionsScanned).toBe(2 * RECONCILE_BOUNDS.stripePageSize);
    expect(listCalls.every((c) => c.limit === RECONCILE_BOUNDS.stripePageSize)).toBe(true);
  });

  it('8a. TRUNCATION cannot produce a false in_sync: an unobserved company is `not_checked`', async () => {
    // A company whose customer sorts past the sweep window, with a live
    // subscription only a targeted lookup would reveal.
    const hidden = await mkOrg({ slug: 'rec-hidden' });
    subscriptions = [
      ...Array.from({ length: 250 }, (_, i) => ({
        id: `sub_bulk_${i}`,
        customer: `cus_bulk_${i}`,
        status: 'canceled',
        lookupKey: 'basico',
      })),
      { id: 'sub_hidden', customer: hidden.customer, status: 'active', lookupKey: 'basico' },
    ];
    // With the targeted lookups allowed, the truth is found.
    const found = await run({ maxStripePages: 1, limit: 200 });
    expect(found.bounds.stripeTruncated).toBe(true);
    expect(found.bounds.customerLookups).toBeGreaterThan(0);
    expect(found.findings.find((f) => f.organizationSlug === 'rec-hidden')).toMatchObject({
      classification: 'subscription_missing_locally',
      severity: 'action',
    });
    // And a company the lookups could not reach is never called in sync.
    const previous = (RECONCILE_BOUNDS as unknown as { maxCustomerLookups: number }).maxCustomerLookups;
    (RECONCILE_BOUNDS as unknown as { maxCustomerLookups: number }).maxCustomerLookups = 0;
    try {
      const capped = await run({ maxStripePages: 1, limit: 200 });
      expect(capped.findings.find((f) => f.organizationSlug === 'rec-hidden')).toMatchObject({
        classification: 'not_checked',
        reasonCode: 'report_truncated',
      });
      expect(capped.counts.not_checked).toBeGreaterThan(0);
    } finally {
      (RECONCILE_BOUNDS as unknown as { maxCustomerLookups: number }).maxCustomerLookups = previous;
    }
  });

  it('8b. a reason code that is not token-shaped is replaced, never passed through', async () => {
    const org = await mkOrg({ slug: 'rec-badcode' });
    await em.execute(
      `insert into stripe_events (event_id, event_type, event_created_at, livemode, object_type, object_id, organization_id,
         claim_token, first_request_id, first_seen_at, last_received_at, disposition, reason_code, disposed_at)
       values ('evt_badcode', 'checkout.session.completed', now(), true, 'checkout.session', 'cs_badcode', ?::uuid,
         gen_random_uuid(), 'req', now(), now(), 'requires_action', 'SECRET-EMAIL@example.test', now())`,
      [org.id],
    );
    subscriptions = [];
    const r = await run({ limit: 200 });
    const f = r.findings.find((x) => x.eventId === 'evt_badcode');
    expect(f).toMatchObject({ reasonCode: 'unrecognised_reason_code' });
    expect(JSON.stringify(r)).not.toContain('SECRET-EMAIL');
  });

  it('8c. BOUNDS: every database read the report issues carries a LIMIT', async () => {
    const conn = pg.orm.em.getConnection() as unknown as { execute: (...a: unknown[]) => unknown };

    const original = conn.execute.bind(conn);

    const seen: string[] = [];

    conn.execute = (...args: unknown[]) => {
      seen.push(String(args[0]));

      return original(...args);
    };

    try {
      subscriptions = [];

      await service.report({ requestId: randomUUID() });
    } finally {
      conn.execute = original;
    }

    const selects = seen.filter((q) => /^\s*select/i.test(q));

    expect(selects.length).toBeGreaterThanOrEqual(4);

    // An unbounded scan of a large account is a denial of service on

    // ourselves, so no read here may be unbounded.

    for (const q of selects) expect(q.toLowerCase()).toMatch(/\blimit\b/);
  });

  it('8d. BOUNDS: a failed attempt older than the window is history, not an open action', async () => {
    const org = await mkOrg({ slug: 'rec-old-failure' });

    await mkAttempt({ org: org.id, status: 'failed', failure: 'unreconciled', ageMinutes: 60 * 24 * 400 });

    subscriptions = [];

    const r = await run({ limit: 200 });

    expect(r.findings.some((f) => f.organizationId === org.id && f.classification === 'attempt_unreconciled')).toBe(
      false,
    );
  });

  it('8e. a DATABASE failure is a recorded 503, never a raw driver error', async () => {
    const exploding = new StripeReconcileService(
      {
        getEntityManager: () => ({
          fork: () => ({
            transactional: async () => {
              throw Object.assign(new Error('SECRET-DRIVER-MESSAGE quoting a value'), { code: '42P01' });
            },
          }),
        }),
      } as never,

      { client: () => fakeStripe } as never,
    );

    logs = [];

    warns = [];

    let caught: unknown;

    try {
      await exploding.report({ requestId: randomUUID() });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(ServiceUnavailableException);

    const rec = records().find((x) => x.outcome === 'database_unavailable');

    expect(rec).toBeDefined();

    for (const line of [...logs, ...warns]) expect(line).not.toContain('SECRET-DRIVER-MESSAGE');

    expect(JSON.stringify((caught as { getResponse: () => unknown }).getResponse())).not.toContain('SECRET-DRIVER');
  });

  it('8f. the report runs on a CLEARED fork, so a dirty request-scoped entity cannot reach its transaction', async () => {
    // Load an entity into the parent manager and modify it. An uncleared fork

    // would inherit it and flush the change INSIDE the read-only transaction,

    // which PostgreSQL would refuse — 500ing the report.

    const parent = pg.orm.em.fork() as EntityManager;

    const [anyStore]: { id: string }[] = await parent.execute(`select id from stores limit 1`);
    const store = anyStore ? await parent.findOne(Store, { id: anyStore.id }) : null;

    if (store) (store as unknown as { name: string }).name = `dirty-${randomUUID().slice(0, 8)}`;

    const onParent = new StripeReconcileService(
      { getEntityManager: () => parent } as never,

      { client: () => fakeStripe } as never,
    );

    subscriptions = [];

    await expect(onParent.report({ requestId: randomUUID() })).resolves.toMatchObject({ counts: expect.any(Object) });

    parent.clear();
  });

  it('8g. COVERAGE: a complete run says so, and EVERY cap or gap flips the verdict', async () => {
    // A clean, complete run.

    subscriptions = [];

    const complete = await run({ limit: RECONCILE_BOUNDS.maxLimit, maxStripePages: 20 });

    expect(complete.coverage).toEqual({ complete: true, incompleteReasons: [] });

    // Stripe truncation alone flips it.

    subscriptions = Array.from({ length: 250 }, (_, i) => ({
      id: `sub_cov_${i}`,

      customer: `cus_cov_${i}`,

      status: 'canceled',

      lookupKey: 'basico',
    }));

    const truncated = await run({ maxStripePages: 1, limit: RECONCILE_BOUNDS.maxLimit });

    expect(truncated.coverage.complete).toBe(false);

    expect(truncated.coverage.incompleteReasons).toContain('stripe_sweep_truncated');

    // A findings cap alone flips it.

    const capped = await run({ maxStripePages: 20, limit: 1 });

    if (capped.bounds.findingsTruncated) {
      expect(capped.coverage.complete).toBe(false);

      expect(capped.coverage.incompleteReasons).toContain('findings_truncated');
    }

    // An unobserved company alone flips it, and it is reported even though the

    // findings list may otherwise look empty.

    const hidden = await mkOrg({ slug: 'rec-coverage-hidden' });

    subscriptions = [
      ...Array.from({ length: 250 }, (_, i) => ({
        id: `sub_cov2_${i}`,

        customer: `cus_cov2_${i}`,

        status: 'canceled',

        lookupKey: 'basico',
      })),

      { id: 'sub_cov_hidden', customer: hidden.customer, status: 'canceled', lookupKey: 'basico' },
    ];

    const previous = (RECONCILE_BOUNDS as unknown as { maxCustomerLookups: number }).maxCustomerLookups;

    (RECONCILE_BOUNDS as unknown as { maxCustomerLookups: number }).maxCustomerLookups = 0;

    try {
      const unchecked = await run({ maxStripePages: 1, limit: RECONCILE_BOUNDS.maxLimit });

      expect(unchecked.counts.not_checked).toBeGreaterThan(0);

      expect(unchecked.coverage.complete).toBe(false);

      expect(unchecked.coverage.incompleteReasons).toContain('organizations_not_checked');
    } finally {
      (RECONCILE_BOUNDS as unknown as { maxCustomerLookups: number }).maxCustomerLookups = previous;
    }
  });

  it('8h. COVERAGE: the log record carries the verdict, so a capped run is not clean in the logs either', async () => {
    logs = [];

    subscriptions = Array.from({ length: 250 }, (_, i) => ({
      id: `sub_log_${i}`,

      customer: `cus_log_${i}`,

      status: 'canceled',

      lookupKey: 'basico',
    }));

    await run({ maxStripePages: 1, limit: RECONCILE_BOUNDS.maxLimit });

    expect(records().at(-1)).toMatchObject({ outcome: 'ok', coverageComplete: false });
  });

  it('9. BOUNDS: findings are capped by limit, counts still describe everything, truncation is flagged', async () => {
    // Sets its own fixtures: depending on a previous test's global would make
    // this pass or fail according to run order.
    subscriptions = Array.from({ length: 350 }, (_, i) => ({
      id: `sub_cap_${i}`,
      customer: `cus_cap_${i}`,
      status: 'active',
      lookupKey: 'basico',
    }));
    const r = await run({ maxStripePages: 2, limit: 5 });
    expect(r.findings).toHaveLength(5);
    expect(r.bounds.findingsTruncated).toBe(true);
    expect(r.counts.customer_not_ours).toBeGreaterThan(5);
    const big = await run({ maxStripePages: 2, limit: RECONCILE_BOUNDS.maxLimit });
    expect(big.findings.length).toBeGreaterThan(5);
  });

  it('10. ORDERING is deterministic: actions first, and two identical runs give identical findings', async () => {
    const a = await run({ maxStripePages: 1, limit: 50 });
    const b = await run({ maxStripePages: 1, limit: 50 });
    expect(b.findings).toEqual(a.findings);
    const severities = a.findings.map((f) => f.severity);
    expect(severities.slice().sort((x, y) => (x === y ? 0 : x === 'action' ? -1 : 1))).toEqual(severities);
    expect(a.findings.every((f) => f.severity !== 'none')).toBe(true);
    // The classification order itself is pinned, not merely the severity
    // grouping: a severity-only comparator would pass the assertion above.
    const RANK = [
      'unresolved_event',
      'attempt_unreconciled',
      'subscription_for_archived_organization',
      'subscription_missing_locally',
      'subscription_missing_at_stripe',
      'subscription_not_live',
      'plan_mismatch',
      'attempt_stuck_open',
      'not_checked',
      'customer_not_ours',
      'organization_without_customer',
    ];
    const ranks = a.findings.map((f) => RANK.indexOf(f.classification));
    expect(ranks).toEqual(ranks.slice().sort((x, y) => x - y));
    // And the identifier tie-break is codepoint-stable.
    const keyed = a.findings
      .filter((f) => f.classification === a.findings[0]?.classification)
      .map((f) => `${f.organizationId ?? ''}|${f.subscriptionId ?? ''}|${f.eventId ?? ''}|${f.attemptId ?? ''}`);
    expect(keyed).toEqual(keyed.slice().sort());
  });

  it('11. REDACTION: no sentinel from any Stripe object reaches the report or the logs', async () => {
    subscriptions = [{ id: 'sub_red', customer: 'cus_unknown_red', status: 'active', lookupKey: 'basico' }];
    const r = await run({ limit: 50 });
    const serialised = JSON.stringify(r);
    for (const s of SENTINELS) {
      expect(serialised).not.toContain(s);
      for (const line of [...logs, ...warns]) expect(line).not.toContain(s);
    }
    // The finding shape itself admits nothing free-text.
    for (const f of r.findings) {
      expect(Object.keys(f).sort()).toEqual(
        [
          'attemptId',
          'classification',
          'eventId',
          'localPlan',
          'organizationId',
          'organizationSlug',
          'reasonCode',
          'severity',
          'stripePlan',
          'stripeStatus',
          'subscriptionId',
        ].sort(),
      );
    }
  });

  it('12. OBSERVABILITY: one record per run, counts and bounds only — never a finding', async () => {
    logs = [];
    const r = await run({ limit: 3 });
    const recs = records();
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({
      event: 'stripe_reconcile_report',
      outcome: 'ok',
      reason: null,
      organizationsScanned: r.bounds.organizationsScanned,
      subscriptionsScanned: r.bounds.stripeSubscriptionsScanned,
      stripePagesRead: r.bounds.stripePagesRead,
    });
    const line = JSON.stringify(recs[0]);
    for (const f of r.findings) if (f.subscriptionId) expect(line).not.toContain(f.subscriptionId);
  });

  it('13. a Stripe outage is a 503 with the error CLASS only, and no message escapes', async () => {
    failList = { type: 'StripeConnectionError' };
    let caught: unknown;
    try {
      await run();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((caught as { getResponse: () => unknown }).getResponse())).not.toContain(
      'SECRET-STRIPE-MESSAGE',
    );
    const rec = records().find((r) => r.outcome === 'stripe_unavailable');
    expect(rec).toMatchObject({ reason: 'StripeConnectionError' });
    for (const line of [...logs, ...warns]) expect(line).not.toContain('SECRET-STRIPE-MESSAGE');
  });

  // ── the route over real HTTP ────────────────────────────────────────────
  describe('14-19. the endpoint over real HTTP', () => {
    let app: INestApplication;
    let baseUrl: string;
    // Only the JWT decode is stubbed; the real RolesGuard, the real controller
    // and the real service all run. `scope` is what a decoded token would set.
    let scope: unknown;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [StripeReconcileController],
        providers: [{ provide: StripeReconcileService, useValue: service }],
      })
        .overrideGuard(JwtAuthGuard)
        .useValue({
          canActivate: (ctx: { switchToHttp(): { getRequest(): Record<string, unknown> } }) => {
            const req = ctx.switchToHttp().getRequest();
            if (scope === undefined) return false;
            req.scope = scope;
            // What a decoded token really carries: the RolesGuard reads
            // `user.role.name`, so the stub must supply it or the test would
            // be exercising a guard that can never pass.
            req.user = {
              id: 'user-owner',
              email: 'owner@example.test',
              role: { name: (scope as { role?: string }).role ?? 'VIEWER' },
            };
            return true;
          },
        })
        .compile();
      app = moduleRef.createNestApplication();
      app.use(requestIdMiddleware);
      app.setGlobalPrefix('api/v1');
      await app.init();
      await app.listen(0);
      baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    }, 300_000);
    afterAll(async () => {
      await app?.close();
    });

    const get = (path: string): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        http
          .get(`${baseUrl}${path}`, (res) => {
            let d = '';
            res.on('data', (c) => (d += c));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: d }));
          })
          .on('error', reject);
      });

    it('14. the unscoped platform owner receives the report', async () => {
      scope = { platform: true, role: 'SUPER_ADMIN', organizationId: null, storeId: null };
      const r = await get('/api/v1/billing/stripe-reconcile?limit=5');
      expect(r.status).toBe(200);
      const body = JSON.parse(r.body);
      expect(body.data).toMatchObject({
        generatedAt: expect.any(String),
        coverage: expect.objectContaining({ complete: expect.any(Boolean), incompleteReasons: expect.any(Array) }),
        bounds: expect.objectContaining({ limit: 5 }),
        counts: expect.any(Object),
        findings: expect.any(Array),
      });
      expect(body.data.findings.length).toBeLessThanOrEqual(5);
    });

    it('15. a SUPER_ADMIN INSIDE a managed company gets the same 404 an outsider gets', async () => {
      scope = { platform: true, role: 'SUPER_ADMIN', organizationId: 'org-managed', storeId: null };
      expect((await get('/api/v1/billing/stripe-reconcile')).status).toBe(404);
    });

    it('16. an ORGANIZATION_MANAGER and an ADMIN are both refused by the roles guard', async () => {
      scope = { platform: false, role: 'ORGANIZATION_MANAGER', organizationId: 'org-1', storeId: null };
      expect((await get('/api/v1/billing/stripe-reconcile')).status).toBe(403);
      scope = { platform: false, role: 'ADMIN', organizationId: 'org-1', storeId: null };
      expect((await get('/api/v1/billing/stripe-reconcile')).status).toBe(403);
    });

    it('17. an anonymous request never reaches the controller', async () => {
      scope = undefined;
      expect((await get('/api/v1/billing/stripe-reconcile')).status).toBe(403);
    });

    it('18. an impossible bound is a 400 over the wire, before any work', async () => {
      scope = { platform: true, role: 'SUPER_ADMIN', organizationId: null, storeId: null };
      for (const q of ['limit=0', 'limit=abc', 'limit=99999', 'maxStripePages=0', 'maxStripePages=999']) {
        expect((await get(`/api/v1/billing/stripe-reconcile?${q}`)).status).toBe(400);
      }
    });

    it('19. the wire response carries no sentinel and only the allowed finding keys', async () => {
      scope = { platform: true, role: 'SUPER_ADMIN', organizationId: null, storeId: null };
      subscriptions = [{ id: 'sub_http', customer: 'cus_http_unknown', status: 'active', lookupKey: 'basico' }];
      const r = await get('/api/v1/billing/stripe-reconcile?limit=50');
      expect(r.status).toBe(200);
      for (const sen of SENTINELS) expect(r.body).not.toContain(sen);
      for (const f of JSON.parse(r.body).data.findings) {
        expect(Object.keys(f).sort()).toEqual(
          [
            'attemptId',
            'classification',
            'eventId',
            'localPlan',
            'organizationId',
            'organizationSlug',
            'reasonCode',
            'severity',
            'stripePlan',
            'stripeStatus',
            'subscriptionId',
          ].sort(),
        );
      }
    });
  });
});
