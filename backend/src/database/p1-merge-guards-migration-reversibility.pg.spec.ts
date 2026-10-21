import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg, insertOrganizationRaw } from '../../test/pg-harness';
import { P1_MERGED_GUARD_FUNCTION, organizationGuards } from '../modules/organizations/lifecycle/organization-dependency-census';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

const MERGE_GUARDS = 'Migration20260913130000';

/**
 * The census is read as it is NOW; this suite rewinds to P1's migration, whose
 * trigger list is FROZEN at the tables that existed then. A table that was
 * given a guard by a LATER migration does not exist at this point of the chain
 * and so carries none here.
 *
 * ADR 030 is the first such addition: `Migration20261004120000` creates
 * `asset_collections` and `asset_collection_members` and installs their guards
 * itself. They are NAMED rather than subtracted as a number, so the next table
 * guarded after P1 has to be added to this list on purpose.
 */
const GUARDED_AFTER_P1 = ['asset_collection_members', 'asset_collections'];
const guardsInstalledByP1 = (): number =>
  organizationGuards().filter((guard) => !GUARDED_AFTER_P1.includes(guard.table)).length * 2;

/**
 * #289 P1 — the guard migration goes on, comes off, and refuses to come off
 * while a merge record depends on it. Same rewind discipline as the other
 * reversibility suites.
 *
 * #277 P2 layered `Migration20260913140000` on top, which replaces the P1
 * function and restores it on `down`. The rewind below therefore passes
 * through P2's reversal first (it refuses only while a company is archived,
 * and a fresh database has none), and what it then asserts is P1's own state:
 * P1's function name, P1's trigger count.
 */
d('merge-guards migration reversibility (#289 P1)', () => {
  let pg: DisposablePg;
  let em: EntityManager;

  const migrator = () => pg.orm.getMigrator();
  const applied = async (): Promise<string[]> =>
    (await migrator().getExecutedMigrations()).map((m) => m.name.replace(/\.(js|ts)$/, ''));
  const guardTriggers = async (): Promise<number> =>
    Number(
      (
        await em.execute<{ n: number }[]>(
          `select count(*)::int as n from pg_trigger t join pg_proc p on p.oid = t.tgfoid
            where p.proname = ? and not t.tgisinternal`,
          [P1_MERGED_GUARD_FUNCTION],
        )
      )[0].n,
    );
  const functionExists = async (): Promise<boolean> =>
    Number(
      (
        await em.execute<{ n: number }[]>(`select count(*)::int as n from pg_proc where proname = ?`, [
          P1_MERGED_GUARD_FUNCTION,
        ])
      )[0].n,
    ) === 1;

  const rewindToGuards = async (): Promise<void> => {
    for (let step = 0; step < 20; step += 1) {
      const executed = await applied();
      const newest = executed[executed.length - 1];
      if (newest === MERGE_GUARDS) return;
      if (!newest || newest < MERGE_GUARDS) break;
      await migrator().down();
    }
    const executed = await applied();
    throw new Error(
      `could not rewind to ${MERGE_GUARDS}; newest applied is ${executed[executed.length - 1] ?? '(none)'}`,
    );
  };

  beforeEach(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
    await rewindToGuards();
  }, 300_000);

  afterEach(async () => {
    if (pg) await pg.close();
  });

  it('applies: one function and two guards per MOVED and UNMOVED class', async () => {
    expect(await functionExists()).toBe(true);
    // Ninety-two: two per class of the census as P1 froze it. Written out once,
    // so the filter above cannot quietly make this "whatever is installed".
    expect(guardsInstalledByP1()).toBe(92);
    expect(organizationGuards().length * 2).toBe(92 + GUARDED_AFTER_P1.length * 2);
    expect(await guardTriggers()).toBe(guardsInstalledByP1());
  });

  it('reverses cleanly on an unused database and reapplies idempotently', async () => {
    await migrator().down();
    expect(await applied()).not.toContain(MERGE_GUARDS);
    expect(await guardTriggers()).toBe(0);
    expect(await functionExists()).toBe(false);
    await migrator().up({ to: MERGE_GUARDS });
    expect(await guardTriggers()).toBe(guardsInstalledByP1());
    expect(await functionExists()).toBe(true);
  }, 120_000);

  it('REFUSES to reverse while a merge record exists, and keeps every guard', async () => {
    const a = await insertOrganizationRaw(em, { name: 'A', slug: 'g-a' });
    const b = await insertOrganizationRaw(em, { name: 'B', slug: 'g-b' });
    await em.execute(`update organizations set merged_into_organization_id = ?, merged_at = now() where id = ?`, [
      b,
      a,
    ]);
    await expect(migrator().down()).rejects.toThrow(/carry a merge record they protect/);
    expect(await applied()).toContain(MERGE_GUARDS);
    expect(await guardTriggers()).toBe(guardsInstalledByP1());
  }, 120_000);
});
