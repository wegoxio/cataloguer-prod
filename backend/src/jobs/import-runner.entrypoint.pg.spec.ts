import { EntityManager } from '@mikro-orm/postgresql';
import { createHash, randomUUID } from 'crypto';
import { execFile, execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../test/pg-harness';
import { startFakeObjectStore, FakeObjectStore } from '../../test/fake-object-store';
import { ImportApprovalService } from '../modules/imports/plan/import-approval.service';
import { EXIT } from './import-runner.job';
import { testPlanHash } from '../../test/plan-hash-fixture';

/**
 * The job entrypoint, actually run.
 *
 * The unit spec beside this proves what the job DECIDES. It cannot prove the
 * thing an operator most needs to be true: that the committed command boots the
 * application, resolves the real runner, drains the real queue against a real
 * database, and exits with a code their tooling can read.
 *
 * So this spawns it. `node -r ts-node/register src/jobs/import-runner.main.ts`,
 * pointed at a disposable database and a fake object store, with real work
 * waiting — and then checks the DATABASE, not the log, for what happened.
 */

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const BUCKET = 'cataloguer-import-sources-test';
const BACKEND_ROOT = path.join(__dirname, '..', '..');

/**
 * The COMPILED entrypoint, not the source.
 *
 * `node dist/jobs/import-runner.main` is the exact command the Docker job
 * manifest carries, so it is the exact thing worth proving — a test of some
 * other invocation would leave the shipped one unproven.
 *
 * The source runs too. It did not, once: three files imported Express's request
 * types in VALUE position, which `tsc` erases but a transpile-only loader emits
 * as a real `require` for a package pnpm does not expose. They are now explicit
 * `import type`, and `common/deps/declared-dependencies.spec.ts` keeps it that
 * way.
 */
const ENTRYPOINT = path.join(BACKEND_ROOT, 'dist', 'jobs', 'import-runner.main.js');

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  fact: Record<string, unknown> | null;
}

d('import runner entrypoint (real PostgreSQL, real process)', () => {
  jest.setTimeout(600_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let store: FakeObjectStore;
  let databaseUrl: string;
  let approvals: ImportApprovalService;

  let organizationId: string;
  let userId: string;

  const exec = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
    em.getConnection().execute(sql, params) as Promise<T>;

  beforeAll(async () => {
    // Built once, here, so the suite proves the artifact that ships rather than
    // whatever happens to be in `dist/` from an earlier run.
    execFileSync('pnpm', ['run', 'build'], { cwd: BACKEND_ROOT, stdio: 'pipe', timeout: 300_000 });
    if (!existsSync(ENTRYPOINT)) {
      throw new Error(`The build produced no ${ENTRYPOINT}. The job would not be runnable in production.`);
    }

    pg = await withDisposablePg();
    em = pg.orm.em.fork() as EntityManager;
    approvals = new ImportApprovalService(em);
    store = await startFakeObjectStore();

    const maintenance = new URL(process.env.TEST_DATABASE_URL as string);
    maintenance.pathname = `/${pg.dbName}`;
    databaseUrl = maintenance.toString();

    organizationId = (
      await exec<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), 'Job Co', ?, now(), now()) returning id`,
        [`job-co-${randomUUID().slice(0, 8)}`],
      )
    )[0].id;

    userId = (
      await exec<{ id: string }[]>(
        `insert into users (id, email, password_hash, first_name, last_name, organization_id, role_id, created_at, updated_at)
         values (gen_random_uuid(), ?, 'x', 'Ana', 'Ruiz', ?, (select id from roles limit 1), now(), now())
         returning id`,
        [`ana-${randomUUID().slice(0, 8)}@example.test`, organizationId],
      )
    )[0].id;
  });

  afterAll(async () => {
    await store?.close();
    await pg?.close();
  });

  /**
   * Run the committed entrypoint as a real child process.
   *
   * The environment is the one the Docker job supplies: a database, an
   * import bucket, its own credentials, and the explicit privacy affirmation
   * the service refuses to start without.
   */
  const runJob = (args: string[]): Promise<RunResult> =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [ENTRYPOINT, ...args],
        {
          cwd: BACKEND_ROOT,
          env: {
            ...process.env,
            NODE_ENV: 'test',
            DATABASE_URL: databaseUrl,
            IMPORT_SOURCE_BUCKET: BUCKET,
            IMPORT_SOURCE_BUCKET_PRIVATE: 'true',
            IMPORT_SOURCE_ACCESS_KEY_ID: 'test-access-key',
            IMPORT_SOURCE_SECRET_ACCESS_KEY: 'test-secret-key',
            IMPORT_SOURCE_ENDPOINT: store.endpoint,
            STORAGE_REGION: 'auto',
            JWT_ACCESS_SECRET: 'test-access-secret-for-the-job-entrypoint-spec',
            JWT_REFRESH_SECRET: 'test-refresh-secret-for-the-job-entrypoint-spec',
            // The job must never open a port. If it did, this would collide.
            PORT: '0',
          },
          timeout: 240_000,
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
              ? ((error as unknown as { code: number }).code as number)
              : (error ?? null) === null
                ? 0
                : 1;

          const factLine = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line.startsWith('{') && line.includes('"job"'))
            .pop();

          resolve({
            code,
            stdout,
            stderr,
            fact: factLine ? (JSON.parse(factLine) as Record<string, unknown>) : null,
          });
        },
      );
    });

  /** A source whose bytes really are in the fake store, under the real key layout. */
  const registerSource = async (contents: string): Promise<{ id: string; hash: string }> => {
    const objectKey = `imports/${organizationId}/${randomUUID()}.csv`;
    store.put(BUCKET, objectKey, contents);
    const hash = createHash('sha256').update(Buffer.from(contents, 'utf8')).digest('hex');

    const id = (
      await exec<{ id: string }[]>(
        `insert into import_sources
           (organization_id, object_key, original_file_name, size_bytes, content_hash, detected_format, parser_version)
         values (?, ?, 'export.csv', ?, ?, 'CSV_OR_TEXT', 'p9-1') returning id`,
        [organizationId, objectKey, Buffer.byteLength(contents), hash],
      )
    )[0].id;

    return { id, hash };
  };

  const queueAnalysis = async (sourceId: string, sourceHash: string): Promise<string> =>
    (
      await exec<{ id: string }[]>(
        `insert into import_analyses
           (organization_id, source_id, status, source_hash, analyzer_version, execution_identity, started_at)
         values (?, ?, 'QUEUED', ?, 'p9-1', ?, now()) returning id`,
        [organizationId, sourceId, sourceHash, `analysis-${randomUUID()}`],
      )
    )[0].id;

  const queueExecution = async (sourceId: string, sourceHash: string): Promise<string> => {
    const mapping = {
      sheet: 'main',
      headerRow: 1,
      columns: [
        { columnIndex: 0, header: 'sku', field: 'sku', reviewed: true },
        { columnIndex: 1, header: 'nombre', field: 'name', reviewed: true },
      ],
    };
    const planHash = testPlanHash({ sourceHash, mapping });

    const planId = (
      await exec<{ id: string }[]>(
        `insert into import_plans
           (organization_id, source_id, import_type, plan_hash, source_hash, analyzer_version,
            mapping, decisions, target_assumptions, summary, status)
         values (?, ?, 'PRODUCTS', ?, ?, 'p9-1', ?::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'APPROVED')
         returning id`,
        [organizationId, sourceId, planHash, sourceHash, JSON.stringify(mapping)],
      )
    )[0].id;

    await approvals.issue({
      organizationId,
      planId,
      planVersion: 1,
      planHash,
      sourceHash,
      approver: { userId, role: 'ORGANIZATION_MANAGER', storeId: null, email: 'ana@example.test' },
    });

    await exec(
      `update import_executions set status = 'COMPLETED', finished_at = now()
        where organization_id = ? and status in ('QUEUED','RUNNING')`,
      [organizationId],
    );

    return (
      await exec<{ id: string }[]>(
        `insert into import_executions (organization_id, plan_id, execution_identity, status)
         values (?, ?, ?, 'QUEUED') returning id`,
        [organizationId, planId, `exec-${randomUUID()}`],
      )
    )[0].id;
  };

  /* ------------------------------------------------------------------- usage */

  it('refuses arguments it cannot act on, without touching the queue', async () => {
    const run = await runJob(['--mode=everything']);

    expect(run.code).toBe(EXIT.BAD_USAGE);
    expect(run.stderr).toMatch(/analysis, execution or all/i);
    // Nothing was attempted, so there is no fact line to report.
    expect(run.fact).toBeNull();
  });

  /* -------------------------------------------------------------- empty queue */

  it('succeeds and says so when there is nothing waiting', async () => {
    const run = await runJob(['--mode=all']);

    expect(run.code).toBe(EXIT.OK);
    expect(run.fact).toMatchObject({ job: 'import-runner', verdict: 'no work was waiting' });
    // A quiet pass is not a failed one, and must not page anybody.
    expect(run.fact?.analysesFailed).toBe(0);
    expect(run.fact?.executionsFailed).toBe(0);
  });

  /* ---------------------------------------------------------------- analysis */

  it('drains a waiting analysis, reading the file through the real storage path', async () => {
    const csv = 'SKU,Nombre,Precio\nJOB-1,Cojín,15\nJOB-2,Manta,25\n';
    const source = await registerSource(csv);
    const analysisId = await queueAnalysis(source.id, source.hash);

    const run = await runJob(['--mode=analysis', '--max-items=5']);

    expect(run.code).toBe(EXIT.OK);
    expect(run.fact).toMatchObject({ mode: 'ANALYSIS', analysesRun: 1, analysesFailed: 0 });

    // The DATABASE is the proof, not the log line.
    const analysis = (
      await exec<{ status: string; tables: unknown; proposals: unknown }[]>(
        `select status, tables, proposals from import_analyses where id = ?`,
        [analysisId],
      )
    )[0];
    expect(analysis.status).toBe('COMPLETED');
    expect((analysis.tables as { headers: string[] }).headers).toEqual(['SKU', 'Nombre', 'Precio']);

    // And the bytes really travelled over HTTP through the S3 client, rather
    // than a substituted service handing them over in-process.
    expect(store.requests.some((r) => r.method === 'GET')).toBe(true);
  });

  it('does not touch the execution queue when told to drain analyses', async () => {
    const source = await registerSource('sku,nombre\nSCOPE-1,Aparte\n');
    const executionId = await queueExecution(source.id, source.hash);

    const run = await runJob(['--mode=analysis']);

    expect(run.code).toBe(EXIT.OK);
    expect(run.fact).toMatchObject({ executionsRun: 0 });
    // Untouched: a job told to drain analyses must not be the reason an
    // execution's status changed.
    expect(
      (await exec<{ status: string }[]>(`select status from import_executions where id = ?`, [executionId]))[0].status,
    ).toBe('QUEUED');
  });

  /* --------------------------------------------------------------- execution */

  it('drains a waiting execution and writes the catalogue', async () => {
    const csv = 'sku,nombre\nJOB-EXEC-1,Silla de roble\n';
    const source = await registerSource(csv);
    const executionId = await queueExecution(source.id, source.hash);

    const run = await runJob(['--mode=execution', '--max-items=5']);

    expect(run.code).toBe(EXIT.OK);
    expect(run.fact).toMatchObject({ mode: 'EXECUTION', executionsRun: 1, executionsFailed: 0 });

    const execution = (
      await exec<{ status: string; failure_reason: string | null }[]>(
        `select status, failure_reason from import_executions where id = ?`,
        [executionId],
      )
    )[0];
    expect(execution.failure_reason).toBeNull();
    expect(execution.status).toBe('COMPLETED');

    const product = (
      await exec<{ name: string }[]>(`select name from products where organization_id = ? and sku = 'JOB-EXEC-1'`, [
        organizationId,
      ])
    )[0];
    expect(product.name).toBe('Silla de roble');

    // THIS plan's approval was spent by the run, so it cannot be spent again.
    // Scoped to the plan rather than the company: other plans in this suite
    // legitimately hold approvals they never used, and counting those would
    // make the assertion depend on the order the tests happen to run in.
    const approvalsForPlan = await exec<{ consumed_at: Date | null }[]>(
      `select a.consumed_at
         from import_approvals a
         inner join import_executions e on e.plan_id = a.plan_id
        where e.id = ?`,
      [executionId],
    );
    expect(approvalsForPlan).toHaveLength(1);
    expect(approvalsForPlan[0].consumed_at).not.toBeNull();
  });

  /* ------------------------------------------------------------- non-overlap */

  it('leaves work another worker is holding, and says why the pass was quiet', async () => {
    const source = await registerSource('sku,nombre\nHELD-1,En curso\n');
    const executionId = await queueExecution(source.id, source.hash);

    // Somebody else claimed it a moment ago and their lease is live.
    await exec(
      `update import_executions
          set lease_owner = 'another-worker', lease_expires_at = now() + interval '5 minutes', heartbeat_at = now()
        where id = ?`,
      [executionId],
    );

    const run = await runJob(['--mode=execution']);

    expect(run.code).toBe(EXIT.OK);
    // Not "nothing to do" — saturated. Those need different responses, so the
    // job distinguishes them rather than reporting two zeroes.
    expect(run.fact).toMatchObject({ executionsRun: 0, executionsFailed: 0 });

    const held = (
      await exec<{ status: string; lease_owner: string | null }[]>(
        `select status, lease_owner from import_executions where id = ?`,
        [executionId],
      )
    )[0];
    expect(held.lease_owner).toBe('another-worker');
    expect(held.status).toBe('QUEUED');

    // Release it so later cases are not blocked by this one.
    await exec(`update import_executions set lease_owner = null, lease_expires_at = null where id = ?`, [executionId]);
    await exec(`update import_executions set status = 'COMPLETED', finished_at = now() where id = ?`, [executionId]);
  });

  /* ----------------------------------------------------------------- bounds */

  it('claims no more than it was told to', async () => {
    const first = await registerSource('SKU,Nombre\nBOUND-1,Uno\n');
    const second = await registerSource('SKU,Nombre\nBOUND-2,Dos\n');
    await queueAnalysis(first.id, first.hash);
    await queueAnalysis(second.id, second.hash);

    const run = await runJob(['--mode=analysis', '--max-items=1']);

    expect(run.code).toBe(EXIT.OK);
    expect(run.fact).toMatchObject({ analysesRun: 1 });

    // The other is still waiting, for the next invocation. A bounded pass that
    // silently drained everything would make its own bound a lie.
    expect(
      Number(
        (
          await exec<{ count: string }[]>(
            `select count(*) from import_analyses where organization_id = ? and status = 'QUEUED'`,
            [organizationId],
          )
        )[0].count,
      ),
    ).toBe(1);
  });

  /* ---------------------------------------------------------------- failure */

  it('exits non-zero when an item it claimed could not be read', async () => {
    // A source whose object is not in storage at all: the file is gone.
    const missingKey = `imports/${organizationId}/${randomUUID()}.csv`;
    const sourceId = (
      await exec<{ id: string }[]>(
        `insert into import_sources
           (organization_id, object_key, original_file_name, size_bytes, content_hash, detected_format, parser_version)
         values (?, ?, 'gone.csv', 10, ?, 'CSV_OR_TEXT', 'p9-1') returning id`,
        [organizationId, missingKey, 'f'.repeat(64)],
      )
    )[0].id;
    const analysisId = await queueAnalysis(sourceId, 'f'.repeat(64));

    const run = await runJob(['--mode=analysis']);

    // Monitoring watches the exit code. A job that exits 0 having failed
    // everything it touched is monitoring that lies.
    expect(run.code).toBe(EXIT.ITEMS_FAILED);
    expect(run.fact).toMatchObject({ analysesFailed: 1, verdict: 'some items failed' });

    // And the failure is durable and tenant-facing, not only in a log.
    const analysis = (
      await exec<{ status: string; failure_reason: string | null }[]>(
        `select status, failure_reason from import_analyses where id = ?`,
        [analysisId],
      )
    )[0];
    expect(analysis.status).toBe('FAILED');
    expect(analysis.failure_reason ?? '').not.toBe('');
  });
});
