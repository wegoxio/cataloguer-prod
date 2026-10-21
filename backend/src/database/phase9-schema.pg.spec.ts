import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../test/pg-harness';

/**
 * Phase 9 schema, proven against real PostgreSQL.
 *
 * The interesting assertions are the CHECK constraints and the partial unique
 * indexes, because those are the ones that carry a decision rather than a
 * shape. Decision A in particular — "historical sales never touch inventory" —
 * is enforced here by the database, so introducing an inventory-affecting mode
 * would require a migration and the review a migration implies, not just a
 * change of mind in a service.
 */
const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

d('Phase 9 import schema (real PostgreSQL)', () => {
  let pg: DisposablePg;
  let orgId: string;

  beforeAll(async () => {
    pg = await withDisposablePg({});
    const em = pg.orm.em.fork();
    const row = await em.getConnection().execute(
      `insert into organizations (id, name, slug, created_at, updated_at)
       values (gen_random_uuid(), 'P9 Co', 'p9-co-${Date.now()}', now(), now()) returning id`,
    );
    orgId = row[0].id;
  }, 300_000);

  afterAll(async () => {
    await pg?.close();
  });

  const exec = (sql: string, params: unknown[] = []) => pg.orm.em.fork().getConnection().execute(sql, params);

  const makeSource = async () => {
    const r = await exec(
      `insert into import_sources
         (organization_id, object_key, original_file_name, size_bytes, content_hash, detected_format, parser_version)
       values (?, ?, 'x.csv', 100, repeat('a',64), 'CSV_OR_TEXT', 'p9-1') returning id`,
      [orgId, `imports/${orgId}/${Math.random()}.csv`],
    );
    return r[0].id as string;
  };

  const makePlan = async (sourceId: string, type: string, mode: string | null, storeId: string | null, hash: string) =>
    exec(
      `insert into import_plans
         (organization_id, source_id, store_id, import_type, sales_inventory_mode, plan_hash, source_hash,
          analyzer_version, mapping, decisions, target_assumptions, summary)
       values (?, ?, ?, ?, ?, ?, repeat('b',64), 'p9-1', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb)
       returning id`,
      [orgId, sourceId, storeId, type, mode, hash],
    );

  it('creates the import lifecycle tables', async () => {
    const rows = await exec(
      `select table_name from information_schema.tables
        where table_schema='public' and table_name like 'import_%' order by table_name`,
    );
    expect(rows.map((r: { table_name: string }) => r.table_name)).toEqual([
      'import_analyses',
      'import_approvals',
      'import_checkpoints',
      'import_executions',
      'import_external_identities',
      'import_mapping_templates',
      'import_plans',
      'import_row_results',
      'import_sources',
      // Migration20260826140000. A separate table on purpose: no fulfilment,
      // availability or ledger query can reach a historical sale.
      'imported_historical_sales',
    ]);
  });

  describe('decision A is enforced by the database', () => {
    it('REFUSES a historical sales plan without the record-only mode', async () => {
      const s = await makeSource();
      await expect(makePlan(s, 'HISTORICAL_STORE_SALES', null, orgId, repeat('1'))).rejects.toThrow(
        /import_plans_sales_mode_check/,
      );
    });

    it('REFUSES any sales mode other than record-only', async () => {
      const s = await makeSource();
      await expect(makePlan(s, 'HISTORICAL_STORE_SALES', 'INVENTORY_AFFECTING', orgId, repeat('2'))).rejects.toThrow(
        /import_plans_sales_mode_check|invalid input/,
      );
    });

    it('REFUSES a sales mode on a catalogue plan', async () => {
      const s = await makeSource();
      await expect(makePlan(s, 'PRODUCTS', 'HISTORICAL_RECORD_ONLY', null, repeat('3'))).rejects.toThrow(
        /import_plans_sales_mode_check/,
      );
    });

    it('accepts a well-formed record-only sales plan', async () => {
      const s = await makeSource();
      const r = await makePlan(s, 'HISTORICAL_STORE_SALES', 'HISTORICAL_RECORD_ONLY', orgId, repeat('4'));
      expect(r[0].id).toBeTruthy();
    });
  });

  describe('decision F is enforced by the database', () => {
    it('REFUSES a historical sales plan that names no store', async () => {
      const s = await makeSource();
      await expect(makePlan(s, 'HISTORICAL_STORE_SALES', 'HISTORICAL_RECORD_ONLY', null, repeat('5'))).rejects.toThrow(
        /import_plans_sales_needs_store_check/,
      );
    });

    it('allows a catalogue plan with no store, because it is organization-owned', async () => {
      const s = await makeSource();
      const r = await makePlan(s, 'PRODUCTS', null, null, repeat('6'));
      expect(r[0].id).toBeTruthy();
    });
  });

  describe('global per-organization concurrency', () => {
    it('permits only ONE live execution per organization', async () => {
      const s1 = await makeSource();
      const p1 = (await makePlan(s1, 'PRODUCTS', null, null, repeat('7')))[0].id;
      const s2 = await makeSource();
      const p2 = (await makePlan(s2, 'PRODUCTS', null, null, repeat('8')))[0].id;

      await exec(
        `insert into import_executions (organization_id, plan_id, execution_identity, status)
         values (?, ?, 'exec-1', 'RUNNING')`,
        [orgId, p1],
      );
      // A second live execution for the same tenant is refused by the database,
      // not by an in-process semaphore each container would count separately.
      await expect(
        exec(
          `insert into import_executions (organization_id, plan_id, execution_identity, status)
           values (?, ?, 'exec-2', 'QUEUED')`,
          [orgId, p2],
        ),
      ).rejects.toThrow(/import_executions_one_live_per_org/);
    });

    it('allows a new execution once the previous one finished', async () => {
      await exec(`update import_executions set status='COMPLETED' where organization_id=?`, [orgId]);
      const s = await makeSource();
      const p = (await makePlan(s, 'PRODUCTS', null, null, repeat('9')))[0].id;
      const r = await exec(
        `insert into import_executions (organization_id, plan_id, execution_identity, status)
         values (?, ?, 'exec-3', 'QUEUED') returning id`,
        [orgId, p],
      );
      expect(r[0].id).toBeTruthy();
    });
  });

  describe('checkpoint uniqueness is the idempotency', () => {
    it('refuses a second checkpoint for the same batch', async () => {
      const exId = (await exec(`select id from import_executions where execution_identity='exec-3'`))[0].id;
      await exec(
        `insert into import_checkpoints (execution_id, batch_index, first_row, last_row, batch_fingerprint)
         values (?, 0, 1, 200, repeat('c',64))`,
        [exId],
      );
      // A resumed worker discovers an already-committed batch by this failure,
      // never by trusting a counter it kept in memory.
      await expect(
        exec(
          `insert into import_checkpoints (execution_id, batch_index, first_row, last_row, batch_fingerprint)
           values (?, 0, 1, 200, repeat('c',64))`,
          [exId],
        ),
      ).rejects.toThrow(/import_checkpoints_execution_batch_unique/);
    });
  });

  describe('a source row outlives its bytes', () => {
    it('keeps the row and its hash after the object is deleted by retention', async () => {
      const s = await makeSource();
      await exec(`update import_sources set status='EXPIRED', object_deleted_at=now() where id=?`, [s]);
      const row = (await exec(`select status, content_hash, object_deleted_at from import_sources where id=?`, [s]))[0];
      expect(row.status).toBe('EXPIRED');
      expect(row.content_hash).toHaveLength(64);
      expect(row.object_deleted_at).toBeTruthy();
    });
  });

  describe('external identity', () => {
    it('is unique per organization, system, id and target type', async () => {
      const target = (await exec(`select gen_random_uuid() as id`))[0].id;
      await exec(
        `insert into import_external_identities (organization_id, source_system, external_id, target_type, target_id)
         values (?, 'woocommerce', '1234', 'product', ?)`,
        [orgId, target],
      );
      await expect(
        exec(
          `insert into import_external_identities (organization_id, source_system, external_id, target_type, target_id)
           values (?, 'woocommerce', '1234', 'product', ?)`,
          [orgId, target],
        ),
      ).rejects.toThrow(/import_external_identities_unique/);
    });
  });

  it('reverses cleanly', async () => {
    const migrator = pg.orm.getMigrator();
    // Two steps, not one. Migration20260826140000 (imported_historical_sales)
    // now sits on top of the schema migration, and reverting only the head
    // would leave the nine tables in place and this assertion would be testing
    // nothing. Derived from the migration list rather than hardcoded, so a
    // third Phase 9 migration does not silently make it vacuous again.
    const applied = await migrator.getExecutedMigrations();
    const schemaIndex = applied.findIndex((m) => m.name.startsWith('Migration20260826120000'));
    expect(schemaIndex).toBeGreaterThanOrEqual(0);
    const stepsBack = applied.length - schemaIndex;
    for (let i = 0; i < stepsBack; i++) await migrator.down();

    const after = await exec(
      `select count(*)::int as n from information_schema.tables
        where table_schema='public' and table_name in
        ('import_sources','import_analyses','import_plans','import_approvals','import_executions',
         'import_checkpoints','import_row_results','import_external_identities','import_mapping_templates',
         'imported_historical_sales')`,
    );
    expect(after[0].n).toBe(0);
    await migrator.up();
  }, 300_000);
});

const repeat = (c: string) => c.repeat(64);
