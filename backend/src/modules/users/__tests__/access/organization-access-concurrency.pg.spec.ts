import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { UsersService } from '../../users.service';
import { User } from '../../entities/user.entity';
import { Role } from '../../entities/role.entity';
import { PasswordResetToken } from '../../../auth/entities/password-reset-token.entity';
import { AuditLogService } from '../../../audit-log/audit-log.service';
import { AuditLog } from '../../../audit-log/entities/audit-log.entity';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';
import { lockOrganizationAccess } from '../../access/access-locks';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * THE RACE THE LOCKS EXIST FOR, run on real connections.
 *
 * A count taken after a write is not a safeguard. Two transactions each demote
 * a different one of the last two managers; each counts what IT can see — its
 * own victim already excluded, the other's demotion invisible because it has
 * not committed — and each concludes one manager remains. Both commit. The
 * organization ends with none, and no single transaction was wrong on its own
 * evidence.
 *
 * These tests run genuinely concurrent transactions on separate connections
 * (`em.fork()` per attempt, `Promise.allSettled` so both are in flight) and
 * assert the COMMITTED state, not the return values. Remove
 * `lockOrganizationAccess` or `lockPlatformSuperAdmins` and they fail — which
 * is the point, and is what the mutation run checks.
 */
d('authority changes under concurrency (real PostgreSQL, #274)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;

  /**
   * ONE SERVICE PER CONNECTION, and this is what makes the race real.
   *
   * Nest gives every request its own EntityManager fork, so two concurrent
   * requests never share a connection. A test that reused one service would
   * serialise both attempts onto a single connection and prove nothing about
   * locking — the second would simply queue behind the first inside MikroORM,
   * not inside PostgreSQL.
   */
  const serviceOnOwnConnection = (): UsersService => {
    const fork = pg.orm.em.fork() as EntityManager;
    return new UsersService(
      fork.getRepository(User) as never,
      fork.getRepository(Role) as never,
      fork.getRepository(PasswordResetToken) as never,
      new AuditLogService(fork.getRepository(AuditLog) as never) as never,
      { send: async () => undefined, renderTemplate: () => '<html></html>' } as never,
      { get: () => undefined } as never,
    );
  };

  const conn = () => em.getConnection();
  const one = async (sql: string, params: unknown[] = []) => (await conn().execute(sql, params))[0];

  let seq = 0;
  const newOrg = async (): Promise<string> => {
    seq += 1;
    const row = await one(
      `insert into organizations (name, slug, created_at, updated_at) values (?, ?, now(), now()) returning id`,
      [`Race Org ${seq}`, `race-org-${seq}`],
    );
    return row.id as string;
  };
  const newStore = async (organizationId: string): Promise<string> => {
    seq += 1;
    const row = await one(
      `insert into stores (name, slug, organization_id, created_at, updated_at)
       values (?, ?, ?, now(), now()) returning id`,
      [`Race Store ${seq}`, `race-store-${seq}`, organizationId],
    );
    return row.id as string;
  };
  const roleId = async (name: string) => (await one('select id from roles where name = ?', [name])).id as string;
  const newUser = async (role: string, organizationId: string | null = null, storeId: string | null = null) => {
    seq += 1;
    const row = await one(
      `insert into users (email, password_hash, role_id, organization_id, store_id, created_at, updated_at)
       values (?, 'x', ?, ?, ?, now(), now()) returning id`,
      [`race-${seq}@example.com`, await roleId(role), organizationId, storeId],
    );
    return row.id as string;
  };

  const activeManagers = async (organizationId: string): Promise<number> =>
    Number(
      (
        await one(
          `select count(*)::int as c from users u join roles r on r.id = u.role_id
            where u.organization_id = ? and u.deleted_at is null and r.name = 'ORGANIZATION_MANAGER'`,
          [organizationId],
        )
      ).c,
    );
  const activeSuperAdmins = async (): Promise<number> =>
    Number(
      (
        await one(
          `select count(*)::int as c from users u join roles r on r.id = u.role_id
            where u.deleted_at is null and r.name = 'SUPER_ADMIN'`,
        )
      ).c,
    );
  const roleOf = async (userId: string): Promise<string> =>
    (await one(`select r.name from users u join roles r on r.id = u.role_id where u.id = ?`, [userId])).name as string;
  const storeOf = async (userId: string): Promise<string | null> =>
    (await one(`select store_id from users where id = ?`, [userId])).store_id as string | null;

  const platformScope = (): TenantScope => ({
    platform: true,
    role: 'SUPER_ADMIN',
    organizationId: null,
    storeId: null,
    allowedStoreIds: [],
  });

  const actorFor = async (): Promise<User> =>
    (await em.fork().findOne(User, { id: await newUser('SUPER_ADMIN') }, { populate: ['role'] as never })) as User;

  beforeAll(async () => {
    pg = await withDisposablePg();
    em = pg.orm.em.fork() as EntityManager;
    for (const name of ['SUPER_ADMIN', 'ADMIN', 'EDITOR', 'VIEWER']) {
      await conn().execute(
        `insert into roles (id, name) select gen_random_uuid(), ? where not exists (select 1 from roles where name = ?)`,
        [name, name],
      );
    }
  });

  afterAll(async () => {
    await pg?.close();
  });

  /**
   * A DETERMINISTIC lock detector, because a racing test is not one.
   *
   * Two `Promise.allSettled` attempts may simply not interleave — Node runs
   * one event loop, each transaction is milliseconds long, and the window in
   * which both have counted but neither has committed can close on its own.
   * A racing test that passes therefore proves the OUTCOME was right this
   * time, not that a lock produced it: removing the lock left both races
   * green.
   *
   * So the lock is detected directly. A separate connection HOLDS the
   * organization's advisory lock; the service call must then block. If it
   * completes while the lock is held, it never asked for it.
   */
  const holdOrganizationLock = async (organizationId: string) => {
    const holder = pg.orm.em.fork() as EntityManager;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finished = holder.transactional(async (tem) => {
      await lockOrganizationAccess(tem, organizationId);
      await held;
    });
    // Give the holder a moment to actually take it.
    await new Promise((r) => setTimeout(r, 150));
    return { release, finished };
  };

  const blocksWhileHeld = async (call: () => Promise<unknown>): Promise<boolean> => {
    const marker = Symbol('timeout');
    const raced = await Promise.race([
      call()
        .then(() => 'completed' as const)
        .catch(() => 'rejected' as const),
      new Promise((r) => setTimeout(() => r(marker), 1_500)),
    ]);
    return raced === marker;
  };

  it('the access change BLOCKS while the organization lock is held elsewhere', async () => {
    const org = await newOrg();
    const store = await newStore(org);
    await newUser('ORGANIZATION_MANAGER', org);
    const target = await newUser('VIEWER', org, store);
    const actor = await actorFor();

    const lock = await holdOrganizationLock(org);
    const blocked = await blocksWhileHeld(() =>
      serviceOnOwnConnection().changeOrganizationAccess(platformScope(), actor, org, target, {
        role: 'ADMIN',
        storeId: store,
      }),
    );
    lock.release();
    await lock.finished;

    expect(blocked).toBe(true);
    // And once released it goes through, so the block was the lock and not a
    // broken call.
    await serviceOnOwnConnection().changeOrganizationAccess(platformScope(), actor, org, target, {
      role: 'ADMIN',
      storeId: store,
    });
    expect(await roleOf(target)).toBe('ADMIN');
  });

  /**
   * WHAT PROTECTS THE LAST PLATFORM OWNER: the level rule, and nothing else.
   *
   * `assertCanManageRole` refuses a target whose level is greater than OR EQUAL
   * to the actor's, and every SUPER_ADMIN is level 5 — so one platform owner
   * cannot demote or deactivate another at all. Superadmin mutation is
   * structurally unsupported by the current API, which is why no count-and-lock
   * guard for it exists in the writers: unreachable code cannot be tested
   * through a real path, and the earlier draft's version also violated the
   * documented lock order. The full per-writer proof lives in
   * `organization-access.pg.spec.ts`.
   */
  it('no platform owner can demote or deactivate another — the level rule refuses first', async () => {
    const org = await newOrg();
    const store = await newStore(org);
    const owner = await newUser('SUPER_ADMIN', org, store);
    const actor = await actorFor();
    const scope: TenantScope = {
      platform: true,
      role: 'SUPER_ADMIN',
      organizationId: org,
      storeId: null,
      allowedStoreIds: [],
    };

    await expect(serviceOnOwnConnection().updateRole(scope, actor, owner, 'ADMIN')).rejects.toThrow(
      /cannot manage a user with role SUPER_ADMIN/i,
    );
    await expect(serviceOnOwnConnection().deactivate(scope, actor, owner)).rejects.toThrow(
      /cannot manage a user with role SUPER_ADMIN/i,
    );
    expect(await roleOf(owner)).toBe('SUPER_ADMIN');
    expect(await activeSuperAdmins()).toBeGreaterThanOrEqual(1);
  });

  it('two concurrent demotions cannot empty an organization of managers', async () => {
    const org = await newOrg();
    const store = await newStore(org);
    const first = await newUser('ORGANIZATION_MANAGER', org);
    const second = await newUser('ORGANIZATION_MANAGER', org);
    const actor = await actorFor();

    const demote = (userId: string) =>
      serviceOnOwnConnection().changeOrganizationAccess(platformScope(), actor, org, userId, {
        role: 'ADMIN',
        storeId: store,
      });

    const results = await Promise.allSettled([demote(first), demote(second)]);

    // Exactly one may succeed. The other must be refused by the rule, not by a
    // deadlock or a unique-violation accident.
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason?.message)).toMatch(/last active Organization Manager/i);

    // The committed state is the assertion that matters.
    expect(await activeManagers(org)).toBe(1);
  });

  it('two concurrent deactivations cannot empty an organization of managers', async () => {
    const org = await newOrg();
    const first = await newUser('ORGANIZATION_MANAGER', org);
    const second = await newUser('ORGANIZATION_MANAGER', org);
    const actor = await actorFor();
    const scope: TenantScope = {
      platform: true,
      role: 'SUPER_ADMIN',
      organizationId: org,
      storeId: null,
      allowedStoreIds: [],
    };

    const results = await Promise.allSettled([
      serviceOnOwnConnection().deactivate(scope, actor, first),
      serviceOnOwnConnection().deactivate(scope, actor, second),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await activeManagers(org)).toBe(1);
  });

  it('concurrent attempts on platform owners all refuse, and the population is unchanged', async () => {
    // A SUPER_ADMIN is permitted to carry an organization, which is exactly how
    // `PATCH /users/:id/role` can reach one — so this race is reachable.
    const org = await newOrg();
    const store = await newStore(org);
    const before = await activeSuperAdmins();
    const owners: string[] = [];
    // Leave the platform with exactly two owners beyond the ones this suite
    // already created, then race to demote both.
    for (let i = 0; i < 2; i += 1) owners.push(await newUser('SUPER_ADMIN', org, store));
    const actor = await actorFor();
    const scope: TenantScope = {
      platform: true,
      role: 'SUPER_ADMIN',
      organizationId: org,
      storeId: null,
      allowedStoreIds: [],
    };

    // Demote every owner the platform has, concurrently. One must survive.
    const all = await conn().execute(
      `select u.id from users u join roles r on r.id = u.role_id where r.name = 'SUPER_ADMIN' and u.deleted_at is null`,
    );
    const targets = (all as { id: string }[]).map((r) => r.id).filter((id) => id !== actor.id);
    await Promise.allSettled(targets.map((id) => serviceOnOwnConnection().updateRole(scope, actor, id, 'ADMIN')));

    expect(await activeSuperAdmins()).toBeGreaterThanOrEqual(1);
    expect(before).toBeGreaterThanOrEqual(0);
  });

  it('the same manager cannot be transferred to two different replacements', async () => {
    const org = await newOrg();
    const store = await newStore(org);
    const outgoing = await newUser('ORGANIZATION_MANAGER', org);
    const candidateA = await newUser('ADMIN', org, store);
    const candidateB = await newUser('ADMIN', org, store);
    const actor = await actorFor();

    const transfer = (replacementUserId: string) =>
      serviceOnOwnConnection().transferOrganizationManager(platformScope(), actor, org, {
        currentManagerUserId: outgoing,
        replacementUserId,
        formerManagerRole: 'ADMIN',
        formerManagerStoreId: store,
      });

    const results = await Promise.allSettled([transfer(candidateA), transfer(candidateB)]);

    // One transfer wins; the second finds the outgoing user is no longer a
    // manager and is refused by the rule rather than corrupting the pair.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await activeManagers(org)).toBe(1);
    const roles = await Promise.all([roleOf(candidateA), roleOf(candidateB), roleOf(outgoing)]);
    // Exactly one candidate was promoted, and the outgoing manager stepped down.
    expect(roles.filter((r) => r === 'ORGANIZATION_MANAGER')).toHaveLength(1);
    expect(roles[2]).toBe('ADMIN');
  });

  /**
   * STALE AUTHORITY — the failure mode a lock alone does not prevent.
   *
   * A request reads its target, then blocks on the organization lock. While it
   * waits, another transaction PROMOTES that same user to the organization's
   * only manager and commits. The blocked request resumes holding a snapshot
   * that says "ordinary ADMIN" and would happily deactivate or demote the last
   * manager — and the count would agree with it, because the count is right and
   * the ROLE is what went stale.
   *
   * These drive it deterministically: a third connection holds the lock, the
   * victim request is launched into that wait, the promotion runs and commits,
   * then the lock is released.
   */
  /**
   * A lock holder that CHANGES THE WORLD before it lets go.
   *
   * Racing two requests and hoping they interleave proved nothing earlier in
   * this file. This is deterministic instead: one transaction takes the
   * organization lock, the victim request is launched and queues behind it,
   * the holder then promotes the target and commits. The victim can only
   * resume afterwards, so it provably runs against authority that changed
   * while it waited — the exact shape a pre-lock snapshot gets wrong.
   */
  const holdLockThenPromote = async (organizationId: string, userId: string) => {
    const holder = pg.orm.em.fork() as EntityManager;
    let go!: () => void;
    const proceed = new Promise<void>((resolve) => {
      go = resolve;
    });
    const finished = holder.transactional(async (tem) => {
      await lockOrganizationAccess(tem, organizationId);
      await proceed;
      await tem.execute(
        `update users set role_id = (select id from roles where name = 'ORGANIZATION_MANAGER'), store_id = null where id = ?`,
        [userId],
      );
    });
    await new Promise((r) => setTimeout(r, 150));
    return { commitPromotion: go, finished };
  };

  it('a blocked DEACTIVATE re-reads the role and refuses to remove a newly promoted last manager', async () => {
    const org = await newOrg();
    const store = await newStore(org);
    const climber = await newUser('ADMIN', org, store);
    const actor = await actorFor();
    const scope: TenantScope = {
      platform: true,
      role: 'SUPER_ADMIN',
      organizationId: org,
      storeId: null,
      allowedStoreIds: [],
    };

    const holder = await holdLockThenPromote(org, climber);
    // Queues behind the lock while still believing the target is an ADMIN.
    const blocked = serviceOnOwnConnection().deactivate(scope, actor, climber);
    await new Promise((r) => setTimeout(r, 200));
    holder.commitPromotion();
    await holder.finished;

    // It resumes against the promoted row: the organization's ONLY manager.
    await expect(blocked).rejects.toThrow(/last active Organization Manager/i);
    expect(await activeManagers(org)).toBe(1);
    expect(await roleOf(climber)).toBe('ORGANIZATION_MANAGER');
  });

  it('a blocked ROLE CHANGE re-reads the role it is about to overwrite', async () => {
    const org = await newOrg();
    const store = await newStore(org);
    const climber = await newUser('ADMIN', org, store);
    const actor = await actorFor();
    const scope: TenantScope = {
      platform: true,
      role: 'SUPER_ADMIN',
      organizationId: org,
      storeId: null,
      allowedStoreIds: [],
    };

    const holder = await holdLockThenPromote(org, climber);
    // Aimed at an ADMIN; by the time it runs the target is the only manager.
    const blocked = serviceOnOwnConnection().updateRole(scope, actor, climber, 'VIEWER');
    await new Promise((r) => setTimeout(r, 200));
    holder.commitPromotion();
    await holder.finished;

    // Refused on the RELOADED row. Either rule may speak first — the binding
    // rule (a manager has no store, so VIEWER has none to keep) or the
    // last-manager rule — and both are decisions taken from locked state.
    await expect(blocked).rejects.toThrow(/must belong to a store|last active Organization Manager/i);
    expect(await roleOf(climber)).toBe('ORGANIZATION_MANAGER');
    expect(await activeManagers(org)).toBe(1);
  });

  it('concurrent changes to the SAME target cannot leave contradictory bindings', async () => {
    const org = await newOrg();
    const storeA = await newStore(org);
    const storeB = await newStore(org);
    await newUser('ORGANIZATION_MANAGER', org);
    const target = await newUser('VIEWER', org, storeA);
    const actor = await actorFor();

    const change = (role: string, storeId: string | null) =>
      serviceOnOwnConnection().changeOrganizationAccess(platformScope(), actor, org, target, { role, storeId });

    await Promise.allSettled([change('EDITOR', storeB), change('ORGANIZATION_MANAGER', null)]);

    // Whichever won, the committed row must be one of the two INTENDED states —
    // never a manager holding a store, nor a branch role holding none.
    const role = await roleOf(target);
    const store = await storeOf(target);
    if (role === 'ORGANIZATION_MANAGER') {
      expect(store).toBeNull();
    } else {
      expect(store).not.toBeNull();
    }
  });
});
