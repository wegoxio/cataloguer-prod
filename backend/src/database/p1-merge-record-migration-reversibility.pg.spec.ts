import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg, insertOrganizationRaw } from '../../test/pg-harness';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const MERGE_RECORD = 'Migration20260913120000';

/**
 * #289 P1 — the merge-record migration goes on, comes off, and refuses to come
 * off while it would destroy a record. Same shape as the Slice B–D
 * reversibility suites, including the rewind: a later slice that stacks
 * migrations above this one must not make the first `down()` here revert
 * someone else's work.
 */
d('merge-record migration reversibility (#289 P1)', () => {
  let pg: DisposablePg;
  let em: EntityManager;

  const migrator = () => pg.orm.getMigrator();
  const applied = async (): Promise<string[]> =>
    (await migrator().getExecutedMigrations()).map((m) => m.name.replace(/\.(js|ts)$/, ''));

  const columnExists = async (column: string): Promise<boolean> =>
    Number(
      (
        await em.execute<{ n: number }[]>(
          `select count(*)::int as n from information_schema.columns
            where table_schema = 'public' and table_name = 'organizations' and column_name = ?`,
          [column],
        )
      )[0].n,
    ) === 1;
  const constraintType = async (name: string): Promise<string | null> => {
    const rows = await em.execute<{ contype: string }[]>(`select contype from pg_constraint where conname = ?`, [name]);
    return rows[0]?.contype ?? null;
  };
  const indexDef = async (name: string): Promise<string | null> => {
    const rows = await em.execute<{ indexdef: string }[]>(`select indexdef from pg_indexes where indexname = ?`, [
      name,
    ]);
    return rows[0]?.indexdef ?? null;
  };

  const rewindToMergeRecord = async (): Promise<void> => {
    for (let step = 0; step < 20; step += 1) {
      const executed = await applied();
      const newest = executed[executed.length - 1];
      if (newest === MERGE_RECORD) return;
      if (!newest || newest < MERGE_RECORD) break;
      await migrator().down();
    }
    const executed = await applied();
    throw new Error(
      `could not rewind to ${MERGE_RECORD}; newest applied is ${executed[executed.length - 1] ?? '(none)'}`,
    );
  };

  beforeEach(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    await rewindToMergeRecord();
  }, 300_000);

  afterEach(async () => {
    if (pg) await pg.close();
  });

  it('applies: two nullable columns, a self-referencing FK on delete restrict, the pair check and a partial index', async () => {
    expect(await columnExists('merged_into_organization_id')).toBe(true);
    expect(await columnExists('merged_at')).toBe(true);
    expect(await constraintType('organizations_merged_into_organization_id_foreign')).toBe('f');
    expect(await constraintType('organizations_merge_record_check')).toBe('c');
    expect(await indexDef('organizations_merged_into_index')).toContain(
      'WHERE (merged_into_organization_id IS NOT NULL)',
    );
    const fk = await em.execute<{ confdeltype: string }[]>(
      `select confdeltype from pg_constraint where conname = 'organizations_merged_into_organization_id_foreign'`,
    );
    expect(fk[0].confdeltype).toBe('r');
  });

  it('the check ENFORCES: half a record, or a self-merge, is refused by the database itself', async () => {
    const a = await insertOrganizationRaw(em, { name: 'A', slug: 'p1-a' });
    const b = await insertOrganizationRaw(em, { name: 'B', slug: 'p1-b' });
    await expect(
      em.execute(`update organizations set merged_into_organization_id = ? where id = ?`, [b, a]),
    ).rejects.toThrow(/organizations_merge_record_check/);
    await expect(em.execute(`update organizations set merged_at = now() where id = ?`, [a])).rejects.toThrow(
      /organizations_merge_record_check/,
    );
    await expect(
      em.execute(`update organizations set merged_into_organization_id = ?, merged_at = now() where id = ?`, [a, a]),
    ).rejects.toThrow(/organizations_merge_record_check/);
    await em.execute(`update organizations set merged_into_organization_id = ?, merged_at = now() where id = ?`, [
      b,
      a,
    ]);
    await expect(em.execute(`delete from organizations where id = ?`, [b])).rejects.toThrow(/foreign key/);
  });

  it('reverses cleanly on an unused database, leaving no column, constraint or index', async () => {
    await migrator().down();
    expect(await applied()).not.toContain(MERGE_RECORD);
    expect(await columnExists('merged_into_organization_id')).toBe(false);
    expect(await columnExists('merged_at')).toBe(false);
    expect(await constraintType('organizations_merged_into_organization_id_foreign')).toBeNull();
    expect(await constraintType('organizations_merge_record_check')).toBeNull();
    expect(await indexDef('organizations_merged_into_index')).toBeNull();
  });

  it('and reapplies after reversal — every statement is idempotent', async () => {
    await migrator().down();
    await migrator().up({ to: MERGE_RECORD });
    expect(await applied()).toContain(MERGE_RECORD);
    expect(await columnExists('merged_at')).toBe(true);
    expect(await constraintType('organizations_merge_record_check')).toBe('c');
  });

  it('REFUSES to reverse while a merge record exists, and leaves the schema intact', async () => {
    const a = await insertOrganizationRaw(em, { name: 'A', slug: 'p1-a' });
    const b = await insertOrganizationRaw(em, { name: 'B', slug: 'p1-b' });
    await em.execute(`update organizations set merged_into_organization_id = ?, merged_at = now() where id = ?`, [
      b,
      a,
    ]);
    await expect(migrator().down()).rejects.toThrow(/1 organization\(s\) carry a merge record/);
    expect(await applied()).toContain(MERGE_RECORD);
    expect(await columnExists('merged_into_organization_id')).toBe(true);
    expect(await constraintType('organizations_merge_record_check')).toBe('c');
  });
});
