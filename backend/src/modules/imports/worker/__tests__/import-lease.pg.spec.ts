import * as fs from 'fs';
import * as path from 'path';
import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { ImportLeaseService } from '../import-lease.service';

// `pg` ships no bundled types and @types/pg is not a dependency; it is used here
// only to open a SECOND connection, to show what other workers can see.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require('pg');

/**
 * Leases against real PostgreSQL, because the whole point is that the DATABASE
 * decides the winner. An in-memory test would prove nothing about the race the
 * conditional UPDATE exists to settle.
 */
const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

d('import leases (real PostgreSQL)', () => {
  let pg: DisposablePg;
  let em: EntityManager;
  let leases: ImportLeaseService;
  let orgId: string;
  let planId: string;
  let executionId: string;

  const exec = (sql: string, params: unknown[] = []) => em.getConnection().execute(sql, params);

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    leases = new ImportLeaseService(em);

    orgId = (
      await exec(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), 'Lease Co', 'lease-co-${Date.now()}', now(), now()) returning id`,
      )
    )[0].id;
    const sourceId = (
      await exec(
        `insert into import_sources
           (organization_id, object_key, original_file_name, size_bytes, content_hash, detected_format, parser_version)
         values (?, ?, 'x.csv', 10, repeat('a',64), 'CSV_OR_TEXT', 'p9-1') returning id`,
        [orgId, `imports/${orgId}/lease.csv`],
      )
    )[0].id;
    planId = (
      await exec(
        `insert into import_plans
           (organization_id, source_id, import_type, plan_hash, source_hash, analyzer_version,
            mapping, decisions, target_assumptions, summary)
         values (?, ?, 'PRODUCTS', repeat('d',64), repeat('b',64), 'p9-1',
                 '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb) returning id`,
        [orgId, sourceId],
      )
    )[0].id;
    executionId = (
      await exec(
        `insert into import_executions (organization_id, plan_id, execution_identity, status)
         values (?, ?, 'lease-exec', 'RUNNING') returning id`,
        [orgId, planId],
      )
    )[0].id;
  }, 300_000);

  afterAll(async () => {
    await pg?.close();
  });

  beforeEach(async () => {
    await exec(
      `update import_executions set lease_owner=null, lease_expires_at=null, heartbeat_at=null, status='RUNNING' where id=?`,
      [executionId],
    );
  });

  it('lets a free lease be acquired', async () => {
    expect(await leases.acquire('import_executions', executionId, 'worker-a')).toBe(true);
  });

  it('REFUSES a second worker while the lease is live', async () => {
    expect(await leases.acquire('import_executions', executionId, 'worker-a')).toBe(true);
    expect(await leases.acquire('import_executions', executionId, 'worker-b')).toBe(false);
  });

  it('lets a second worker take over once the lease has expired', async () => {
    await leases.acquire('import_executions', executionId, 'worker-a');
    // Expire it in the database's own clock — a worker's clock is not trusted.
    await exec(`update import_executions set lease_expires_at = now() - interval '1 second' where id=?`, [executionId]);
    expect(await leases.acquire('import_executions', executionId, 'worker-b')).toBe(true);

    const row = (await exec(`select lease_owner from import_executions where id=?`, [executionId]))[0];
    expect(row.lease_owner).toBe('worker-b');
  });

  it('extends a lease the holder still owns', async () => {
    await leases.acquire('import_executions', executionId, 'worker-a', 2000);
    const first = (await exec(`select lease_expires_at from import_executions where id=?`, [executionId]))[0]
      .lease_expires_at;
    expect(await leases.heartbeat('import_executions', executionId, 'worker-a', 60_000)).toBe(true);
    const second = (await exec(`select lease_expires_at from import_executions where id=?`, [executionId]))[0]
      .lease_expires_at;
    expect(new Date(second).getTime()).toBeGreaterThan(new Date(first).getTime());
  });

  it('tells a worker that LOST its lease, so it can stop instead of colliding', async () => {
    await leases.acquire('import_executions', executionId, 'worker-a');
    await exec(`update import_executions set lease_owner='worker-b' where id=?`, [executionId]);
    expect(await leases.heartbeat('import_executions', executionId, 'worker-a')).toBe(false);
  });

  it('releases voluntarily so the next worker need not wait out the expiry', async () => {
    await leases.acquire('import_executions', executionId, 'worker-a');
    await leases.release('import_executions', executionId, 'worker-a');
    expect(await leases.acquire('import_executions', executionId, 'worker-b')).toBe(true);
  });

  it('does not let a non-owner release someone else’s lease', async () => {
    await leases.acquire('import_executions', executionId, 'worker-a');
    await leases.release('import_executions', executionId, 'worker-b');
    expect(await leases.acquire('import_executions', executionId, 'worker-c')).toBe(false);
  });

  it('reaps work whose owner vanished, instead of leaving it RUNNING forever', async () => {
    await leases.acquire('import_executions', executionId, 'worker-a');
    await exec(`update import_executions set lease_expires_at = now() - interval '5 minutes' where id=?`, [
      executionId,
    ]);

    const reaped = await leases.reapAbandoned('import_executions');
    expect(reaped).toBeGreaterThanOrEqual(1);

    const row = (
      await exec(`select status, failure_reason, lease_owner from import_executions where id=?`, [executionId])
    )[0];
    // The legacy importer's failure mode was a run stuck at RUNNING with no
    // reconciliation. An abandoned execution now says so, and says it is resumable.
    expect(row.status).toBe('ABANDONED');
    expect(row.failure_reason).toMatch(/resume/i);
    expect(row.lease_owner).toBeNull();
  });

  it('never reaps a lease that is still live', async () => {
    await leases.acquire('import_executions', executionId, 'worker-a', 60_000);
    await leases.reapAbandoned('import_executions');
    const row = (await exec(`select status from import_executions where id=?`, [executionId]))[0];
    expect(row.status).toBe('RUNNING');
  });

  describe('withLease', () => {
    it('runs the work and releases afterwards', async () => {
      const result = await leases.withLease('import_executions', executionId, 'worker-a', async () => 'done');
      expect(result).toBe('done');
      const row = (await exec(`select lease_owner from import_executions where id=?`, [executionId]))[0];
      expect(row.lease_owner).toBeNull();
    });

    it('returns null without running when the lease cannot be taken', async () => {
      await leases.acquire('import_executions', executionId, 'holder');
      let ran = false;
      const result = await leases.withLease('import_executions', executionId, 'worker-a', async () => {
        ran = true;
        return 'x';
      });
      expect(result).toBeNull();
      expect(ran).toBe(false);
    });

    it('releases even when the work throws', async () => {
      await expect(
        leases.withLease('import_executions', executionId, 'worker-a', async () => {
          throw new Error('batch failed');
        }),
      ).rejects.toThrow('batch failed');
      const row = (await exec(`select lease_owner from import_executions where id=?`, [executionId]))[0];
      expect(row.lease_owner).toBeNull();
    });

    it('lets the worker beat between batches and keeps the lease alive', async () => {
      const beats: boolean[] = [];
      await leases.withLease('import_executions', executionId, 'worker-a', async (beat) => {
        for (let batch = 0; batch < 3; batch++) beats.push(await beat());
        return null;
      });
      expect(beats).toEqual([true, true, true]);
    });

    it('tells the worker its lease was lost, so it can stop instead of writing on', async () => {
      const observed: boolean[] = [];
      await leases.withLease('import_executions', executionId, 'worker-a', async (beat) => {
        observed.push(await beat());
        // Another worker takes over mid-run.
        await exec(`update import_executions set lease_owner='worker-b' where id=?`, [executionId]);
        observed.push(await beat());
        // Once lost, it stays lost — no accidental re-acquisition mid-batch.
        observed.push(await beat());
        return null;
      });
      expect(observed).toEqual([true, false, false]);
    });
  });

  describe('why a beat must happen OUTSIDE a transaction', () => {
    it('proves a beat inside an open transaction is invisible until it commits', async () => {
      // The design says heartbeats happen between units, never mid-transaction.
      // That rule only earns its place if the alternative is genuinely broken,
      // so this demonstrates the breakage rather than asserting it.
      //
      // A worker holding a long transaction and beating inside it would see
      // heartbeat() return true and believe the lease was renewed — while every
      // other connection, including the reaper, still saw the OLD expiry.
      await leases.acquire('import_executions', executionId, 'worker-a', 1000);

      const before = (await exec(`select lease_expires_at from import_executions where id=?`, [executionId]))[0]
        .lease_expires_at;

      const conn = pg.orm.em.getConnection();
      await conn.execute('begin');
      try {
        await conn.execute(
          `update import_executions
              set lease_expires_at = now() + interval '600 seconds', heartbeat_at = now()
            where id = ? and lease_owner = ?`,
          [executionId, 'worker-a'],
        );

        // A SEPARATE connection — what any other worker or the reaper sees.
        const observerUrl = new URL(process.env.TEST_DATABASE_URL as string);
        observerUrl.pathname = `/${pg.dbName}`;
        const observer = new Client({ connectionString: observerUrl.toString() });
        await observer.connect();
        try {
          const seen = await observer.query('select lease_expires_at from import_executions where id=$1', [
            executionId,
          ]);
          // Unchanged: the renewal is locked inside the uncommitted transaction.
          expect(new Date(seen.rows[0].lease_expires_at).getTime()).toBe(new Date(before).getTime());
        } finally {
          await observer.end();
        }
      } finally {
        await conn.execute('rollback');
      }

      // And after a rollback the renewal is gone entirely — a worker that beat
      // this way, then hit an error, would have renewed nothing at all.
      const after = (await exec(`select lease_expires_at from import_executions where id=?`, [executionId]))[0]
        .lease_expires_at;
      expect(new Date(after).getTime()).toBe(new Date(before).getTime());
    });
  });

  it('schedules nothing itself — the P5-X1 census forbids machinery maintenance mode cannot refuse', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'import-lease.service.ts'), 'utf8');
    expect(source).not.toMatch(/setInterval\(/);
    expect(source).not.toMatch(/@Cron\(|@Interval\(|@Timeout\(/);
  });
});
