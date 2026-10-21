import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg, insertOrganizationRaw } from '../../../../../test/pg-harness';
import { Organization } from '../../entities/organization.entity';
import { OrganizationMergeService } from '../../merge/organization-merge.service';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * #289 P1 — the merge's locks, proved by holding them and by racing them.
 *
 * "Proved by holding": a second transaction holds the source's `org-access`
 * lock; the merge must not complete until it is released. A lock that is
 * asserted from its own transaction only proves it can be acquired.
 *
 * "Proved by racing": two merges of one source into two different targets
 * start together. Exactly one may win; the other must find the record under
 * the row lock and refuse. Without the `FOR UPDATE` re-read, both would count
 * a clean source, both would commit, and the source's branches would be moved
 * twice while the record named only the last writer.
 */
d('OrganizationMergeService concurrency (#289 P1)', () => {
  let pg: DisposablePg;
  let em: EntityManager;
  let n = 0;

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork() as EntityManager;
  }, 300_000);

  afterAll(async () => {
    if (pg) await pg.close();
  });

  const service = () => {
    const fork = pg.orm.em.fork() as EntityManager;
    return new OrganizationMergeService(
      fork.getRepository(Organization) as any,
      { recordAuditEntryIn: jest.fn() } as any,
    );
  };
  const org = async (label: string): Promise<string> => {
    n += 1;
    return insertOrganizationRaw(em, { name: `${label} ${n}`, slug: `${label.toLowerCase()}-${n}` });
  };
  const store = async (organizationId: string): Promise<string> => {
    n += 1;
    const rows = await em.execute(
      `insert into stores (name, slug, organization_id, created_at, updated_at) values (?, ?, ?, now(), now()) returning id`,
      [`Branch ${n}`, `branch-${n}`, organizationId],
    );
    return rows[0].id as string;
  };
  const mergedInto = async (id: string): Promise<string | null> =>
    (
      await em.execute<{ merged_into_organization_id: string | null }[]>(
        `select merged_into_organization_id from organizations where id = ?`,
        [id],
      )
    )[0].merged_into_organization_id;
  const ownerOf = async (storeId: string): Promise<string> =>
    (await em.execute<{ organization_id: string }[]>(`select organization_id from stores where id = ?`, [storeId]))[0]
      .organization_id;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('waits for the source’s org-access lock — proved by holding it from another transaction', async () => {
    const target = await org('Target');
    const source = await org('Source');
    const branch = await store(source);

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = (pg.orm.em.fork() as EntityManager).transactional(async (tem) => {
      await tem.execute(`select pg_advisory_xact_lock(hashtextextended(?, 0))`, [`org-access:${source}`]);
      await released;
    });

    await sleep(100);
    let settled = false;
    const merge = service()
      .merge(target, source, false)
      .finally(() => (settled = true));
    await sleep(500);
    const settledWhileHeld = settled;
    const ownerWhileHeld = await ownerOf(branch);
    // Release BEFORE asserting: a failed assertion must never leave the
    // holder open, or the suite hangs instead of failing.
    release();
    await holder;
    const plan = await merge;
    expect(settledWhileHeld).toBe(false);
    expect(ownerWhileHeld).toBe(source);
    expect(plan.committable).toBe(true);
    expect(await ownerOf(branch)).toBe(target);
    expect(await mergedInto(source)).toBe(target);
  });

  it('waits for the source ROW lock too — proved by holding `FOR UPDATE` from another transaction', async () => {
    const target = await org('Target');
    const source = await org('Source');
    const branch = await store(source);

    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const holder = (pg.orm.em.fork() as EntityManager).transactional(async (tem) => {
      await tem.execute(`select id from organizations where id = ? for update`, [source]);
      await released;
    });

    await sleep(100);
    let settled = false;
    const merge = service()
      .merge(target, source, false)
      .finally(() => (settled = true));
    await sleep(500);
    const settledWhileHeld = settled;
    const ownerWhileHeld = await ownerOf(branch);
    release();
    await holder;
    const plan = await merge;
    expect(settledWhileHeld).toBe(false);
    expect(ownerWhileHeld).toBe(source);
    expect(plan.committable).toBe(true);
    expect(await mergedInto(source)).toBe(target);
  });

  it('two merges of one source into two targets: exactly one wins, the other refuses on the record', async () => {
    const source = await org('Source');
    const targetA = await org('TargetA');
    const targetB = await org('TargetB');
    const branch = await store(source);

    const outcomes = await Promise.allSettled([
      service().merge(targetA, source, false),
      service().merge(targetB, source, false),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0].reason?.message)).toMatch(/Merge refused/);

    const winner = (fulfilled[0] as PromiseFulfilledResult<any>).value.target.id as string;
    expect([targetA, targetB]).toContain(winner);
    expect(await mergedInto(source)).toBe(winner);
    expect(await ownerOf(branch)).toBe(winner);

    const retry = await service().merge(winner === targetA ? targetB : targetA, source, true);
    expect(retry.conflicts.map((c) => c.kind)).toEqual(['already-merged']);
  });

  it('a writer that commits an unmoved row BEFORE the merge counts is refused; this is the guarantee P1 makes', async () => {
    const target = await org('Target');
    const source = await org('Source');
    await (pg.orm.em.fork() as EntityManager).transactional(async (tem) => {
      await tem.execute(
        `insert into inventory_locations (organization_id, kind, code, name, is_default) values (?, 'WAREHOUSE', 'MAIN', 'Main', true)`,
        [source],
      );
    });
    await expect(service().merge(target, source, false)).rejects.toThrow(/Merge refused/);
    expect(await mergedInto(source)).toBeNull();
  });
});
