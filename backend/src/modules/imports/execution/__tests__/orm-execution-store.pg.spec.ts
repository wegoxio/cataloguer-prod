import { fakeTransactionalEm } from './support/test-transaction';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { BatchAlreadyCommittedError, OrmExecutionStore } from '../orm-execution-store';
import { executePlan, RowApplication, UnitApplier } from '../import-executor';
import { PlannedBatch, PlannedUnit, planBatches } from '../batch-planner';
import { CancellationToken } from '../cancellation';
import { BatchBudget } from '../batch-budget';
import { RowOutcome } from '../../entities/import-row-result.entity';

/** The approver an execution runs under; appliers attribute writes to them. */
const APPROVER = '00000000-0000-4000-8000-000000000001';

/**
 * The executor against a real database.
 *
 * The guarantee this exists to prove cannot be proved in memory: that the
 * checkpoint and the batch's mutations commit or roll back TOGETHER. A fake
 * store can be written to behave that way; only Postgres can demonstrate that
 * a rolled-back batch leaves no checkpoint, and that a second worker racing the
 * same batch loses cleanly rather than applying it twice.
 */

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const row = (n: number): PlannedUnit => ({ kind: 'ROW', sourceRows: [n], mutations: { row: n } });

d('the execution store (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let store: OrmExecutionStore;
  let organizationId: string;
  let sourceId: string;

  const exec = async <T>(sql: string, params: unknown[] = []): Promise<T> =>
    pg.orm.em.getConnection().execute(sql, params) as Promise<T>;

  /** A plan of its own, because a plan may be executed once and once only. */
  const newPlan = async (): Promise<string> => {
    const rows = await exec<{ id: string }[]>(
      `insert into import_plans
         (organization_id, source_id, import_type, plan_hash, source_hash, analyzer_version,
          mapping, decisions, target_assumptions, summary)
       values (?, ?, 'PRODUCTS', ?, repeat('b',64), 'p9-1',
               '{}'::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb) returning id`,
      [organizationId, sourceId, randomUUID().replace(/-/g, '').padEnd(64, '0')],
    );
    return rows[0].id;
  };

  /**
   * A fresh RUNNING execution, on its own plan.
   *
   * Two schema rules shape this, and both are deliberate concurrency controls
   * rather than accidents. Only ONE execution per organization may be live at a
   * time, so the previous one is closed out; and a plan may be executed only
   * ONCE, ever, so each run gets its own plan. Ignoring either would be exactly
   * the mistake a careless second worker makes.
   */
  const newExecution = async (): Promise<string> => {
    await exec(
      `update import_executions set status='COMPLETED', finished_at=now()
        where organization_id = ? and status in ('QUEUED','RUNNING')`,
      [organizationId],
    );
    const rows = await exec<{ id: string }[]>(
      `insert into import_executions (organization_id, plan_id, execution_identity, status)
       values (?, ?, ?, 'RUNNING') returning id`,
      [organizationId, await newPlan(), `exec-${randomUUID()}`],
    );
    return rows[0].id;
  };

  beforeAll(async () => {
    pg = await withDisposablePg();
    em = pg.orm.em.fork() as EntityManager;
    store = new OrmExecutionStore(em);

    organizationId = (
      await exec<{ id: string }[]>(
        `insert into organizations (id, name, slug, created_at, updated_at)
         values (gen_random_uuid(), 'Exec Co', ?, now(), now()) returning id`,
        [`exec-co-${Date.now()}`],
      )
    )[0].id;

    sourceId = (
      await exec<{ id: string }[]>(
        `insert into import_sources
           (organization_id, object_key, original_file_name, size_bytes, content_hash, detected_format, parser_version)
         values (?, ?, 'x.csv', 10, repeat('a',64), 'CSV_OR_TEXT', 'p9-1') returning id`,
        [organizationId, `imports/${organizationId}/exec.csv`],
      )
    )[0].id;
  }, 300_000);

  afterAll(async () => {
    await pg?.close();
  });

  const succeeding: UnitApplier = {
    apply: async (unit) =>
      unit.sourceRows.map((sourceRow) => ({ sourceRow, outcome: RowOutcome.CREATED, targetType: 'product' })),
  };

  describe('the checkpoint commits WITH the batch', () => {
    it('leaves a checkpoint when the batch commits', async () => {
      const executionId = await newExecution();
      const [batch] = planBatches('plan-hash-1', [row(2), row(3)], 2);

      await store.commitBatch(executionId, batch, async () => [
        { sourceRow: 2, outcome: RowOutcome.CREATED },
        { sourceRow: 3, outcome: RowOutcome.CREATED },
      ]);

      const checkpoints = await store.loadCheckpoints(executionId);
      expect(checkpoints).toEqual([{ batchIndex: 0, batchFingerprint: batch.fingerprint }]);
    });

    it('leaves NO checkpoint when the work throws', async () => {
      // The half that cannot be faked: the checkpoint insert happened inside
      // the same transaction, so it went with the rollback.
      const executionId = await newExecution();
      const [batch] = planBatches('plan-hash-1', [row(2)], 2);

      await expect(
        store.commitBatch(executionId, batch, async () => {
          throw new Error('the applier gave up');
        }),
      ).rejects.toThrow('the applier gave up');

      expect(await store.loadCheckpoints(executionId)).toEqual([]);
    });

    it('rolls back the running tally with the batch', async () => {
      const executionId = await newExecution();
      const [batch] = planBatches('plan-hash-1', [row(2)], 2);

      await expect(
        store.commitBatch(executionId, batch, async () => {
          throw new Error('nope');
        }),
      ).rejects.toThrow();

      const counts = await exec<{ batches_completed: number; rows_created: number }[]>(
        `select batches_completed, rows_created from import_executions where id = ?`,
        [executionId],
      );
      expect(Number(counts[0].batches_completed)).toBe(0);
      expect(Number(counts[0].rows_created)).toBe(0);
    });

    it('keeps the tally consistent with the checkpoints', async () => {
      const executionId = await newExecution();
      const batches = planBatches('plan-hash-1', [row(2), row(3), row(4), row(5)], 2);
      for (const batch of batches) {
        await store.commitBatch(executionId, batch, async () =>
          batch.units.flatMap((u) => u.sourceRows.map((sourceRow) => ({ sourceRow, outcome: RowOutcome.CREATED }))),
        );
      }

      const counts = await exec<{ batches_completed: number; rows_created: number }[]>(
        `select batches_completed, rows_created from import_executions where id = ?`,
        [executionId],
      );
      expect(Number(counts[0].batches_completed)).toBe(2);
      expect(Number(counts[0].rows_created)).toBe(4);
      expect(await store.loadCheckpoints(executionId)).toHaveLength(2);
    });
  });

  describe('one live import per company', () => {
    it('refuses a second live execution, which is the global concurrency control', async () => {
      // Two imports running at once against the same catalogue could interleave
      // creates and updates of the same product. The database settles it rather
      // than an in-process guard that only holds inside one container.
      await newExecution();
      await expect(
        exec(
          `insert into import_executions (organization_id, plan_id, execution_identity, status)
           values (?, ?, ?, 'RUNNING')`,
          [organizationId, await newPlan(), `exec-${randomUUID()}`],
        ),
      ).rejects.toThrow(/one_live_per_org|duplicate key/i);
    });

    it('allows the next one once the previous has finished', async () => {
      await newExecution();
      await expect(newExecution()).resolves.toMatch(/^[0-9a-f-]{36}$/);
    });

    it('refuses to execute the same PLAN twice, ever', async () => {
      // The strongest form of "a successful mutation is never rerun": a second
      // execution of an approved plan cannot exist at all, so no delay in
      // reporting or logging can lead to one being started.
      const planId = await newPlan();
      await exec(
        `update import_executions set status='COMPLETED', finished_at=now()
          where organization_id = ? and status in ('QUEUED','RUNNING')`,
        [organizationId],
      );
      await exec(
        `insert into import_executions (organization_id, plan_id, execution_identity, status)
         values (?, ?, ?, 'COMPLETED')`,
        [organizationId, planId, `exec-${randomUUID()}`],
      );

      await expect(
        exec(
          `insert into import_executions (organization_id, plan_id, execution_identity, status)
           values (?, ?, ?, 'RUNNING')`,
          [organizationId, planId, `exec-${randomUUID()}`],
        ),
      ).rejects.toThrow(/one_per_plan|duplicate key/i);
    });
  });

  describe('two workers racing the same batch', () => {
    it('lets the second one lose cleanly instead of applying it twice', async () => {
      // The lease exists to prevent this, but a lease is not a lock and a
      // mis-timed steal is a case the design tolerates. The database settles it.
      const executionId = await newExecution();
      const [batch] = planBatches('plan-hash-1', [row(2)], 2);

      await store.commitBatch(executionId, batch, async () => [{ sourceRow: 2, outcome: RowOutcome.CREATED }]);

      await expect(
        store.commitBatch(executionId, batch, async () => [{ sourceRow: 2, outcome: RowOutcome.CREATED }]),
      ).rejects.toBeInstanceOf(BatchAlreadyCommittedError);

      // Still exactly one checkpoint and one batch's worth of counts.
      expect(await store.loadCheckpoints(executionId)).toHaveLength(1);
      const counts = await exec<{ rows_created: number }[]>(`select rows_created from import_executions where id = ?`, [
        executionId,
      ]);
      expect(Number(counts[0].rows_created)).toBe(1);
    });
  });

  describe('row results', () => {
    it('records one per source row', async () => {
      const executionId = await newExecution();
      await store.recordRowResults(executionId, [
        { sourceTable: 'Productos', sourceRow: 2, outcome: RowOutcome.CREATED, targetType: 'product' },
        { sourceTable: 'Productos', sourceRow: 3, outcome: RowOutcome.FAILED, reason: 'no name' },
      ]);

      const rows = await exec<{ source_row: number; outcome: string }[]>(
        `select source_row, outcome from import_row_results where execution_id = ? order by source_row`,
        [executionId],
      );
      expect(rows.map((r) => [Number(r.source_row), r.outcome])).toEqual([
        [2, 'CREATED'],
        [3, 'FAILED'],
      ]);
    });

    it('keeps the FIRST verdict when a run is retried', async () => {
      // The first answer describes what actually happened; a retry that
      // overwrote it would erase the record of the original outcome.
      const executionId = await newExecution();
      await store.recordRowResults(executionId, [
        { sourceTable: 'Productos', sourceRow: 2, outcome: RowOutcome.CREATED },
      ]);
      await store.recordRowResults(executionId, [
        { sourceTable: 'Productos', sourceRow: 2, outcome: RowOutcome.FAILED, reason: 'changed my mind' },
      ]);

      const rows = await exec<{ outcome: string; reason: string | null }[]>(
        `select outcome, reason from import_row_results where execution_id = ?`,
        [executionId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].outcome).toBe('CREATED');
    });

    it('writes a large report without exceeding the parameter limit', async () => {
      // Chunked deliberately: one statement per five hundred rows rather than
      // one with half a million parameters, which Postgres refuses.
      const executionId = await newExecution();
      const many = Array.from({ length: 1200 }, (_, i) => ({
        sourceTable: 'Productos',
        sourceRow: i + 2,
        outcome: RowOutcome.CREATED,
      }));
      await store.recordRowResults(executionId, many);

      const counted = await exec<{ count: string }[]>(
        `select count(*)::text as count from import_row_results where execution_id = ?`,
        [executionId],
      );
      expect(Number(counted[0].count)).toBe(1200);
    });

    it('does nothing at all for an empty report', async () => {
      const executionId = await newExecution();
      await expect(store.recordRowResults(executionId, [])).resolves.toBeUndefined();
    });
  });

  describe('finishing', () => {
    const report = (headline: string, total: number) => ({
      summary: { created: 0, updated: 0, skipped: 0, blocked: 0, failed: 0, unresolved: 0, total },
      headline,
      repair: [],
      rows: [],
    });

    it('records the terminal status and releases the lease', async () => {
      const executionId = await newExecution();
      await exec(`update import_executions set lease_owner='worker-a' where id = ?`, [executionId]);

      await store.finish(executionId, 'COMPLETED', report('All 4 rows were imported.', 4));

      const rows = await exec<{ status: string; lease_owner: string | null; failure_reason: string | null }[]>(
        `select status, lease_owner, failure_reason from import_executions where id = ?`,
        [executionId],
      );
      expect(rows[0].status).toBe('COMPLETED');
      expect(rows[0].lease_owner).toBeNull();
      expect(rows[0].failure_reason).toBeNull();
    });

    it('records a partial run as PARTIALLY_COMPLETED, with the headline', async () => {
      const executionId = await newExecution();
      await store.finish(executionId, 'PARTIALLY_COMPLETED', report('2 of 4 rows were imported.', 4));

      const rows = await exec<{ status: string; failure_reason: string }[]>(
        `select status, failure_reason from import_executions where id = ?`,
        [executionId],
      );
      expect(rows[0].status).toBe('PARTIALLY_COMPLETED');
      expect(rows[0].failure_reason).toBe('2 of 4 rows were imported.');
    });

    it('does NOT overwrite a run that already finished', async () => {
      // A worker slow to write its summary must not overwrite a terminal state
      // recorded while another worker resumed and finished the run.
      const executionId = await newExecution();
      await store.finish(executionId, 'COMPLETED', report('All 4 rows were imported.', 4));
      await store.finish(executionId, 'FAILED', report('Everything broke.', 4));

      const rows = await exec<{ status: string }[]>(`select status from import_executions where id = ?`, [executionId]);
      expect(rows[0].status).toBe('COMPLETED');
    });
  });

  describe('a whole run, end to end', () => {
    it('applies every batch, checkpoints each, and reports every row', async () => {
      const executionId = await newExecution();
      const result = await executePlan({
        executionId,
        organizationId,
        importType: 'PRODUCTS',
        approvedByUserId: APPROVER,
        planHash: 'plan-hash-e2e',
        sourceTable: 'Productos',
        units: [row(2), row(3), row(4), row(5)],
        applier: succeeding,
        store,
        cancellation: new CancellationToken(),
        beat: async () => true,
        budget: new BatchBudget(30_000, 1, 2),
      });

      expect(result.outcome).toBe('COMPLETED');
      expect(await store.loadCheckpoints(executionId)).toHaveLength(2);

      const rows = await exec<{ count: string }[]>(
        `select count(*)::text as count from import_row_results where execution_id = ?`,
        [executionId],
      );
      expect(Number(rows[0].count)).toBe(4);
    });

    it('RESUMES without re-applying what already committed', async () => {
      // The interrupted-execution case: the first run dies after one batch, the
      // second picks it up, and no product is created twice.
      const executionId = await newExecution();
      const applied: number[] = [];
      const recording: UnitApplier = {
        apply: async (unit) => {
          applied.push(...unit.sourceRows);
          return unit.sourceRows.map((sourceRow) => ({ sourceRow, outcome: RowOutcome.CREATED }));
        },
      };

      // First attempt: fail while committing the second batch.
      let calls = 0;
      const flaky = {
        ...store,
        loadCheckpoints: store.loadCheckpoints.bind(store),
        recordRowResults: store.recordRowResults.bind(store),
        finish: store.finish.bind(store),
        commitBatch: async (
          id: string,
          batch: PlannedBatch,
          work: (em: EntityManager) => Promise<RowApplication[]>,
        ) => {
          calls++;
          if (calls === 2) {
            // The realistic shape of the failure: the applier finishes and the
            // COMMIT is what fails. Throwing before `work` would test a
            // different, easier case.
            return store.commitBatch(id, batch, async () => {
              await work(fakeTransactionalEm());
              throw new Error('the worker died');
            });
          }
          return store.commitBatch(id, batch, work);
        },
      };

      const params = {
        executionId,
        organizationId,
        importType: 'PRODUCTS',
        approvedByUserId: APPROVER,
        planHash: 'plan-hash-resume',
        sourceTable: 'Productos',
        units: [row(2), row(3), row(4), row(5)],
        applier: recording,
        cancellation: new CancellationToken(),
        beat: async () => true,
        budget: new BatchBudget(30_000, 1, 2),
      };

      const first = await executePlan({ ...params, store: flaky });
      expect(first.outcome).toBe('FAILED');
      expect(applied).toEqual([2, 3, 4, 5]); // batch 2 was applied then rolled back

      // The run is still RUNNING for the resume's benefit; the first attempt
      // marked it FAILED, so reopen it as a resumed worker would.
      await exec(`update import_executions set status='RUNNING', finished_at=null where id = ?`, [executionId]);

      applied.length = 0;
      const second = await executePlan({ ...params, store });

      expect(second.outcome).toBe('COMPLETED');
      // Only the batch that never committed was applied the second time.
      expect(applied).toEqual([4, 5]);
      expect(await store.loadCheckpoints(executionId)).toHaveLength(2);

      // And exactly one result per row, because the first attempt's results
      // were already recorded and the second did not overwrite them.
      const rows = await exec<{ source_row: number; outcome: string }[]>(
        `select source_row, outcome from import_row_results where execution_id = ? order by source_row`,
        [executionId],
      );
      expect(rows.map((r) => Number(r.source_row))).toEqual([2, 3, 4, 5]);
    });
  });
});

if (!gate.enabled) {
  // eslint-disable-next-line no-console
  console.log(`execution store PG suite skipped: ${gate.reason}`);
}
