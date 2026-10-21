import { EntityManager } from '@mikro-orm/postgresql';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { insertMinimalUser } from '../../../../../test/billing-fixtures';
import {
  claimEvent,
  EventIdentity,
  findExistingEvent,
  finalizeEvent,
  insertDelivery,
  insertProcessing,
  lockEventForReapply,
  recordRedelivery,
  resolveEvent,
} from '../../stripe/stripe-event-ledger';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * The ledger's SQL, proven against PostgreSQL rather than described (#248, PR B).
 *
 * The claim is INSERT … ON CONFLICT DO NOTHING RETURNING. What matters is not
 * the statement but what PostgreSQL does with two of them at once: the second
 * WAITS on the first's uncommitted row, then either conflicts (first
 * committed) or succeeds (first rolled back). Nothing inspects xmax; no
 * uniqueness error is caught anywhere.
 */
d('Stripe event ledger SQL (real PostgreSQL)', () => {
  jest.setTimeout(120_000);
  let pg: DisposablePg;
  let em: EntityManager;

  const identity = (eventId: string, over: Partial<EventIdentity> = {}): EventIdentity => ({
    eventId,
    eventType: 'invoice.paid',
    eventCreatedAt: new Date('2026-09-01T00:00:00Z'),
    livemode: false,
    apiVersion: '2025-08-27.basil',
    stripeIdempotencyKey: null,
    objectType: 'invoice',
    objectId: `in_${eventId}`,
    subscriptionId: 'sub_1',
    organizationId: null,
    ...over,
  });

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const settledWithin = async <T>(p: Promise<T>, ms: number): Promise<'settled' | 'pending'> => {
    const marker = Symbol('pending');
    const r = await Promise.race([
      p.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      sleep(ms).then(() => marker),
    ]);
    return r === marker ? 'pending' : 'settled';
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
  }, 120_000);

  afterAll(async () => {
    await pg?.close();
  });

  it('the three tables and their constraints exist under the documented names', async () => {
    const rows: { conname: string; conrelid: string }[] = await em.execute(
      `select conname, conrelid::regclass::text as conrelid from pg_constraint
        where conrelid in ('stripe_events'::regclass, 'stripe_event_processings'::regclass, 'stripe_webhook_deliveries'::regclass)
        order by conname`,
    );
    const names = rows.map((r) => r.conname);
    for (const expected of [
      'stripe_events_pkey',
      'stripe_events_disposition_check',
      'stripe_events_object_type_check',
      'stripe_events_attempt_count_check',
      'stripe_events_resolution_shape_check',
      'stripe_event_processings_event_id_foreign',
      'stripe_event_processings_trigger_check',
      'stripe_event_processings_basis_check',
      'stripe_event_processings_result_check',
      'stripe_event_processings_effect_check',
      'stripe_event_processings_actor_shape_check',
      'stripe_webhook_deliveries_request_id_unique',
      'stripe_webhook_deliveries_outcome_check',
      'stripe_webhook_deliveries_error_shape_check',
    ]) {
      expect(names).toContain(expected);
    }
    const idx: { indexname: string }[] = await em.execute(
      `select indexname from pg_indexes where tablename = 'stripe_events' and indexname = 'stripe_events_applied_object_unique'`,
    );
    expect(idx).toHaveLength(1);
    const fk: { conname: string }[] = await em.execute(
      `select conname from pg_constraint where conrelid = 'stripe_webhook_deliveries'::regclass and contype = 'f'`,
    );
    // No foreign key: a failed delivery's event row was rolled back with it.
    expect(fk).toHaveLength(0);
  });

  it('a first claim returns a token; a second claim of the same id returns null and leaves the row untouched', async () => {
    const token = await em.fork().transactional(async (tem) => claimEvent(tem, identity('evt_a'), 'req-a1'));
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    const again = await em.fork().transactional(async (tem) => claimEvent(tem, identity('evt_a'), 'req-a2'));
    expect(again).toBeNull();
    const row = await findExistingEvent(em, 'evt_a');
    expect(row).toMatchObject({ eventId: 'evt_a', attemptCount: 1, disposition: 'ignored', reasonCode: 'pending' });
  });

  it('a duplicate delivery may change only attempt_count and last_received_at', async () => {
    const bumped = await recordRedelivery(em, 'evt_a');
    expect(bumped).toMatchObject({ eventId: 'evt_a', attemptCount: 2, disposition: 'ignored', reasonCode: 'pending' });
    expect(await recordRedelivery(em, 'evt_never')).toBeNull();
  });

  it('CONCURRENT first deliveries: the second claim waits on the first, then loses when the first commits', async () => {
    let releaseFirst: () => void = () => undefined;
    const gateFirst = new Promise<void>((r) => (releaseFirst = r));
    let firstToken: string | null = null;
    const first = em.fork().transactional(async (tem) => {
      firstToken = await claimEvent(tem, identity('evt_race'), 'req-r1');
      await gateFirst;
      await finalizeEvent(tem, {
        eventId: 'evt_race',
        claimToken: firstToken as string,
        disposition: 'applied',
        reasonCode: 'restored',
        organizationId: null,
      });
    });
    await sleep(100);
    expect(firstToken).not.toBeNull();
    const second = em.fork().transactional(async (tem) => claimEvent(tem, identity('evt_race'), 'req-r2'));
    expect(await settledWithin(second, 400)).toBe('pending'); // blocked on the uncommitted row
    releaseFirst();
    await first;
    expect(await second).toBeNull();
    expect(await findExistingEvent(em, 'evt_race')).toMatchObject({
      disposition: 'applied',
      reasonCode: 'restored',
      attemptCount: 1,
    });
  });

  it('CONCURRENT first deliveries: when the first ROLLS BACK, the second claim succeeds', async () => {
    let releaseFirst: () => void = () => undefined;
    const gateFirst = new Promise<void>((r) => (releaseFirst = r));
    const first = em
      .fork()
      .transactional(async (tem) => {
        await claimEvent(tem, identity('evt_rollback'), 'req-b1');
        await gateFirst;
        throw new Error('forced rollback');
      })
      .catch((e: Error) => e.message);
    await sleep(100);
    const second = em.fork().transactional(async (tem) => claimEvent(tem, identity('evt_rollback'), 'req-b2'));
    expect(await settledWithin(second, 400)).toBe('pending');
    releaseFirst();
    expect(await first).toBe('forced rollback');
    expect(await second).toMatch(/^[0-9a-f-]{36}$/);
    expect(await findExistingEvent(em, 'evt_rollback')).toMatchObject({ attemptCount: 1, reasonCode: 'pending' });
  });

  it('finalisation requires the claim token; a foreign token changes nothing and throws', async () => {
    await expect(
      em.fork().transactional(async (tem) =>
        finalizeEvent(tem, {
          eventId: 'evt_a',
          claimToken: '00000000-0000-4000-8000-000000000000',
          disposition: 'applied',
          reasonCode: 'x',
          organizationId: null,
        }),
      ),
    ).rejects.toThrow('did not match the claimed row');
    expect(await findExistingEvent(em, 'evt_a')).toMatchObject({ disposition: 'ignored', reasonCode: 'pending' });
  });

  it('a requires_action row resolves exactly once; a second resolution throws and changes nothing', async () => {
    const token = await em.fork().transactional(async (tem) => {
      const t = await claimEvent(tem, identity('evt_ra'), 'req-ra');
      await finalizeEvent(tem, {
        eventId: 'evt_ra',
        claimToken: t as string,
        disposition: 'requires_action',
        reasonCode: 'no_store',
        organizationId: null,
      });
      return t;
    });
    expect(token).not.toBeNull();
    const userId = await insertMinimalUser(em);
    await em.fork().transactional(async (tem) => {
      const locked = await lockEventForReapply(tem, 'evt_ra');
      expect(locked).toMatchObject({ disposition: 'requires_action', resolvedAt: null });
      await resolveEvent(tem, {
        eventId: 'evt_ra',
        disposition: 'applied',
        reasonCode: 'restored',
        resolvedByUserId: userId,
        resolutionCode: 'restored',
      });
    });
    await expect(
      em.fork().transactional(async (tem) =>
        resolveEvent(tem, {
          eventId: 'evt_ra',
          disposition: 'ignored',
          reasonCode: 'x',
          resolvedByUserId: userId,
          resolutionCode: 'x',
        }),
      ),
    ).rejects.toThrow('did not match an open requires_action row');
    const row = await findExistingEvent(em, 'evt_ra');
    expect(row).toMatchObject({ disposition: 'applied', reasonCode: 'restored' });
    expect(row?.resolvedAt).not.toBeNull();
  });

  it('a processing row cannot reference an event that does not exist, and a delivery row can', async () => {
    await expect(
      insertProcessing(em, {
        eventId: 'evt_ghost',
        trigger: 'webhook',
        basis: 'event_payload',
        actorUserId: null,
        requestId: 'req-g',
        startedAt: new Date(),
        result: 'ignored',
        reasonCode: 'x',
        retrievedSubscriptionStatus: null,
        retrievedAt: null,
        effect: 'none',
        paymentId: null,
        auditLogId: null,
        localStateBefore: {},
        localStateAfter: {},
      }),
    ).rejects.toMatchObject({ code: '23503' });
    await insertDelivery(em, {
      requestId: 'req-ghost-delivery',
      receivedAt: new Date(),
      durationMs: 1,
      outcome: 'failed',
      eventId: 'evt_ghost',
      eventType: 'invoice.paid',
      livemode: false,
      errorName: 'Error',
      sqlState: 'P0001',
    });
    const rows: { n: string }[] = await em.execute(
      `select count(*)::text as n from stripe_webhook_deliveries where event_id = 'evt_ghost'`,
    );
    expect(Number(rows[0].n)).toBe(1);
  });

  it('the check constraints refuse an undocumented trigger, basis, result, effect, outcome or error shape', async () => {
    const bad = (sql: string) => expect(em.execute(sql)).rejects.toMatchObject({ code: '23514' });
    await bad(`insert into stripe_events (event_id, event_type, event_created_at, livemode, object_type, object_id, claim_token, first_request_id, disposition, reason_code)
               values ('evt_bad1', 'x', now(), false, 'invoice', 'in_x', gen_random_uuid(), 'r', 'settled', 'x')`);
    await bad(`insert into stripe_events (event_id, event_type, event_created_at, livemode, object_type, object_id, claim_token, first_request_id, disposition, reason_code)
               values ('evt_bad2', 'x', now(), false, 'charge', 'ch_x', gen_random_uuid(), 'r', 'applied', 'x')`);
    await bad(`insert into stripe_event_processings (event_id, trigger, basis, request_id, started_at, result, reason_code, effect, local_state_before, local_state_after)
               values ('evt_a', 'cron', 'event_payload', 'r', now(), 'applied', 'x', 'none', '{}', '{}')`);
    await bad(`insert into stripe_event_processings (event_id, trigger, basis, request_id, started_at, result, reason_code, effect, local_state_before, local_state_after)
               values ('evt_a', 'reapply', 'stripe_retrieve', 'r', now(), 'applied', 'x', 'none', '{}', '{}')`); // reapply without an actor
    await bad(`insert into stripe_webhook_deliveries (request_id, received_at, duration_ms, outcome, event_id, event_type, livemode, error_name)
               values ('req-bad', now(), 1, 'processed', 'evt_a', 'x', false, 'Error')`); // error fields on a non-failed row
  });

  it('user identities are recorded facts: deleting the user keeps the reapply and the resolution attributed to them', async () => {
    const fks: { conname: string }[] = await em.execute(
      `select conname from pg_constraint where contype = 'f' and confrelid = 'users'::regclass
        and conrelid in ('stripe_events'::regclass, 'stripe_event_processings'::regclass)`,
    );
    expect(fks).toHaveLength(0);
    const seed = await insertMinimalUser(em); // guarantees a role exists to copy
    const [user]: { id: string }[] = await em.execute(
      `insert into users (email, password_hash, role_id, created_at, updated_at)
       values ('deleted-owner-${Date.now()}@example.test', 'x', (select role_id from users where id = ?::uuid), now(), now()) returning id`,
      [seed],
    );
    await em.fork().transactional(async (tem) => {
      const t = await claimEvent(tem, identity('evt_userdel'), 'req-ud');
      await finalizeEvent(tem, {
        eventId: 'evt_userdel',
        claimToken: t as string,
        disposition: 'requires_action',
        reasonCode: 'no_store',
        organizationId: null,
      });
      await insertProcessing(tem, {
        eventId: 'evt_userdel',
        trigger: 'reapply',
        basis: 'stripe_retrieve',
        actorUserId: user.id,
        requestId: 'req-ud-reapply',
        startedAt: new Date(),
        result: 'applied',
        reasonCode: 'restored',
        retrievedSubscriptionStatus: 'active',
        retrievedAt: new Date(),
        effect: 'restored',
        paymentId: null,
        auditLogId: null,
        localStateBefore: {},
        localStateAfter: {},
      });
      await resolveEvent(tem, {
        eventId: 'evt_userdel',
        disposition: 'applied',
        reasonCode: 'restored',
        resolvedByUserId: user.id,
        resolutionCode: 'restored',
      });
    });
    await em.execute(`delete from users where id = ?::uuid`, [user.id]);
    const [ev]: { resolved_by_user_id: string; resolution_code: string }[] = await em.execute(
      `select resolved_by_user_id, resolution_code from stripe_events where event_id = 'evt_userdel'`,
    );
    expect(ev).toEqual({ resolved_by_user_id: user.id, resolution_code: 'restored' });
    const [pr]: { actor_user_id: string; trigger: string }[] = await em.execute(
      `select actor_user_id, trigger from stripe_event_processings where event_id = 'evt_userdel'`,
    );
    expect(pr).toEqual({ actor_user_id: user.id, trigger: 'reapply' });
  });

  it('down() refuses on a populated ledger and leaves every table, row and column intact', async () => {
    const shape = async () => {
      const [row]: any[] = await em.execute(
        `select (select count(*) from stripe_events)::int as events,
                (select count(*) from stripe_event_processings)::int as processings,
                (select count(*) from stripe_webhook_deliveries)::int as deliveries,
                (select count(*) from information_schema.columns where table_name = 'organizations' and column_name = 'stripe_previous_subscription_id')::int as column_present,
                (select count(*) from mikro_orm_migrations where name = 'Migration20260903120000')::int as ledger_entry`,
      );
      return row;
    };
    const before = await shape();
    expect(before.events).toBeGreaterThan(0);
    expect(before).toMatchObject({ column_present: 1, ledger_entry: 1 });
    await expect(pg.orm.getMigrator().down({ to: 'Migration20260903120000' })).rejects.toThrow(/down refused/);
    expect(await shape()).toEqual(before);
  });

  it('down() also refuses when only previous-subscription state would be lost', async () => {
    // Prove the second guard independently: a database with an empty ledger
    // but a company that remembers a former subscription.
    const scratch = await withDisposablePg({});
    try {
      const sem = scratch.orm.em.fork() as EntityManager;
      await sem.execute(
        `insert into organizations (name, slug, stripe_previous_subscription_id, created_at, updated_at)
         values ('Former Sub Co', 'former-sub-co', 'sub_former', now(), now())`,
      );
      await expect(scratch.orm.getMigrator().down({ to: 'Migration20260903120000' })).rejects.toThrow(/down refused/);
      const [row]: { n: number }[] = await sem.execute(
        `select count(*)::int as n from information_schema.tables where table_name in ('stripe_events', 'stripe_event_processings', 'stripe_webhook_deliveries')`,
      );
      expect(row.n).toBe(3);
      // And with the state cleared, the empty-schema reversal is allowed.
      await sem.execute(`update organizations set stripe_previous_subscription_id = null`);
      await scratch.orm.getMigrator().down({ to: 'Migration20260903120000' });
      const [after]: { n: number }[] = await sem.execute(
        `select count(*)::int as n from information_schema.tables where table_name in ('stripe_events', 'stripe_event_processings', 'stripe_webhook_deliveries')`,
      );
      expect(after.n).toBe(0);
    } finally {
      await scratch.close();
    }
  });
});
