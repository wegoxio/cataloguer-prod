import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { OrganizationOnboardingService, OnboardRequest } from '../../onboarding/organization-onboarding.service';
import { UsersService } from '../../../users/users.service';
import { User } from '../../../users/entities/user.entity';
import { Role } from '../../../users/entities/role.entity';
import { Organization } from '../../entities/organization.entity';
import { PasswordResetToken } from '../../../auth/entities/password-reset-token.entity';
import { AuditLogService } from '../../../audit-log/audit-log.service';
import { AuditLog } from '../../../audit-log/entities/audit-log.entity';
import { lockOrganizationAccess, lockUsers } from '../../../users/access/access-locks';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * RE-ISSUING AN INVITATION IS A WRITE, SO IT CANNOT DECIDE FROM AN UNLOCKED ROW.
 *
 * `issueInviteTokenIn` DELETES every unused token for the user and creates a
 * replacement. Reading eligibility outside a lock means deciding from state
 * somebody else is in the middle of replacing: two resends each delete the
 * other's link, and a resend racing a Slice A demotion, a deactivation or the
 * manager's own acceptance can mint a manager invitation for someone who is, by
 * commit time, none of those things.
 *
 * The order is Slice A's, unchanged — `org-access:<organizationId>`, then the
 * target row `FOR UPDATE` — so the two contracts serialise against each other
 * and not merely against themselves. Every test here runs its attempts on
 * SEPARATE CONNECTIONS, because a shared EntityManager would serialise inside
 * MikroORM and prove nothing about PostgreSQL.
 *
 * WHAT IS NOT CLAIMED: a message already handed to the mail provider cannot be
 * recalled by a rollback, so two resends a second apart may put two links in an
 * inbox. The guarantee is about validity, not about delivery — the newest
 * COMMITTED token is the only one that works, and every replaced link is dead.
 */
d('resending a manager invitation under concurrency (real PostgreSQL, #276)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let mailOutcome: boolean;

  const conn = () => em.getConnection();
  const one = async (sql: string, params: unknown[] = []) => (await conn().execute(sql, params))[0];
  const all = (sql: string, params: unknown[] = []) => conn().execute(sql, params);

  let seq = 0;
  const roleId = async (name: string) => (await one('select id from roles where name = ?', [name])).id as string;

  /** One service per connection — what makes the race real. */
  const serviceOn = (audit?: unknown): { service: OrganizationOnboardingService; fork: EntityManager } => {
    const fork = pg.orm.em.fork() as EntityManager;
    const mail = {
      send: async () => mailOutcome,
      renderTemplate: (_t: string, _s: string, vars: Record<string, string>) => `<a href="${vars.link}">go</a>`,
    };
    const users = new UsersService(
      fork.getRepository(User) as never,
      fork.getRepository(Role) as never,
      fork.getRepository(PasswordResetToken) as never,
      new AuditLogService(fork.getRepository(AuditLog) as never) as never,
      mail as never,
      { get: () => 'https://panel.example.com' } as never,
    );
    const service = new OrganizationOnboardingService(
      fork.getRepository(Organization) as never,
      users as never,
      (audit ?? new AuditLogService(fork.getRepository(AuditLog) as never)) as never,
    );
    return { service, fork };
  };
  const serviceOnOwnConnection = (audit?: unknown): OrganizationOnboardingService => serviceOn(audit).service;

  const actor = async (): Promise<User> => {
    seq += 1;
    const row = await one(
      `insert into users (email, password_hash, role_id, created_at, updated_at)
       values (?, 'x', ?, now(), now()) returning id`,
      [`resend-actor-${seq}@wegox.com`, await roleId('SUPER_ADMIN')],
    );
    return (await em.fork().findOne(User, { id: row.id }, { populate: ['role'] as never })) as User;
  };

  const request = (): OnboardRequest => {
    seq += 1;
    return {
      organization: { name: `Resend Co ${seq}`, plan: 'BASICO' },
      store: { name: `Resend Site ${seq}` },
      manager: { email: `resend${seq}@example.com`, firstName: 'Ana' },
    };
  };

  /** A freshly onboarded company with a pending manager invitation. */
  const onboarded = async () => {
    const a = await actor();
    const created = await serviceOnOwnConnection().onboard(a, request());
    return { actor: a, organizationId: created.organization.id, managerId: created.manager.id };
  };

  const liveTokens = async (userId: string): Promise<string[]> =>
    (await all(`select token_hash from password_reset_tokens where user_id = ? and used_at is null`, [userId])).map(
      (r: any) => r.token_hash as string,
    );

  /**
   * Holds Slice A's access lock and the manager's row, applies `change`, and
   * commits only when released — so a resend started meanwhile is provably
   * queued behind a change it must then read.
   */
  const holdingTheAccessLock = async (
    organizationId: string,
    userId: string,
    change: (tem: EntityManager) => Promise<void>,
    { rowLock = true }: { rowLock?: boolean } = {},
  ) => {
    const holder = pg.orm.em.fork() as EntityManager;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const committed = holder.transactional(async (tem) => {
      await lockOrganizationAccess(tem, organizationId);
      // `rowLock: false` isolates the ADVISORY lock. Inserting a token takes a
      // FOR KEY SHARE lock on the manager's row, so a holder that also holds
      // FOR UPDATE would block the resend whether or not it took lock 1 —
      // a detector that proves the foreign key, not the contract.
      if (rowLock) await lockUsers(tem, [userId]);
      await change(tem);
      await held;
    });
    await new Promise((r) => setTimeout(r, 150));
    return {
      // Give the racing attempt time to actually reach the lock. Releasing in
      // the next statement commits before it has started, and then every
      // version of the code passes.
      release: async () => {
        await new Promise((r) => setTimeout(r, 400));
        release();
      },
      committed,
    };
  };

  beforeAll(async () => {
    pg = await withDisposablePg();
    em = pg.orm.em.fork() as EntityManager;
    mailOutcome = true;
    for (const name of ['SUPER_ADMIN', 'ADMIN', 'EDITOR', 'VIEWER']) {
      await conn().execute(
        `insert into roles (id, name) select gen_random_uuid(), ? where not exists (select 1 from roles where name = ?)`,
        [name, name],
      );
    }
  });

  afterEach(() => {
    mailOutcome = true;
  });

  afterAll(async () => {
    await pg?.close();
  });

  it('TWO CONCURRENT RESENDS leave exactly one valid unused token', async () => {
    const { actor: a, organizationId, managerId } = await onboarded();

    const results = await Promise.allSettled([
      serviceOnOwnConnection().resendManagerInvitation(a, organizationId, managerId),
      serviceOnOwnConnection().resendManagerInvitation(a, organizationId, managerId),
    ]);
    for (const r of results) {
      if (r.status === 'rejected') {
        throw new Error(`expected both to succeed, got: ${String((r as PromiseRejectedResult).reason?.message)}`);
      }
    }

    // Not "at most one wrote": exactly one link is live, and it is the newest.
    const live = await liveTokens(managerId);
    expect(live).toHaveLength(1);
  });

  it('a resend racing ACCEPTANCE cannot invite a user who has already accepted', async () => {
    const { actor: a, organizationId, managerId } = await onboarded();
    const before = await liveTokens(managerId);
    expect(before).toHaveLength(1);

    const { release, committed } = await holdingTheAccessLock(organizationId, managerId, async (tem) => {
      await tem.execute(`update users set password_hash = 'accepted-hash' where id = ?`, [managerId]);
    });

    // Queued behind the acceptance; it must read the row it waited for, not the
    // one it saw before the wait.
    const resend = serviceOnOwnConnection()
      .resendManagerInvitation(a, organizationId, managerId)
      .then(() => 'issued an invitation for an accepted user')
      .catch((e) => String(e.message));
    await release();
    await committed;

    expect(await resend).toMatch(/already finished/i);
    // Nothing was re-issued: the token count did not grow behind the refusal.
    expect(await liveTokens(managerId)).toEqual(before);
  });

  it('a resend racing DEACTIVATION cannot issue from stale state', async () => {
    const { actor: a, organizationId, managerId } = await onboarded();

    const { release, committed } = await holdingTheAccessLock(organizationId, managerId, async (tem) => {
      await tem.execute(`update users set deleted_at = now() where id = ?`, [managerId]);
    });
    const resend = serviceOnOwnConnection()
      .resendManagerInvitation(a, organizationId, managerId)
      .then(() => 'issued an invitation for a deactivated user')
      .catch((e) => String(e.message));
    await release();
    await committed;

    expect(await resend).toMatch(/deactivated/i);
  });

  it('a resend racing ROLE REMOVAL cannot issue a MANAGER invitation from stale state', async () => {
    const { actor: a, organizationId, managerId } = await onboarded();

    const { release, committed } = await holdingTheAccessLock(organizationId, managerId, async (tem) => {
      await tem.execute(`update users set role_id = (select id from roles where name = 'ADMIN') where id = ?`, [
        managerId,
      ]);
    });
    const resend = serviceOnOwnConnection()
      .resendManagerInvitation(a, organizationId, managerId)
      .then(() => 'issued a manager invitation to a non-manager')
      .catch((e) => String(e.message));
    await release();
    await committed;

    expect(await resend).toMatch(/not this organization/i);
  });

  it('BLOCKS on the ADVISORY LOCK ALONE, not on a foreign key', async () => {
    const { actor: a, organizationId, managerId } = await onboarded();
    const { release, committed } = await holdingTheAccessLock(organizationId, managerId, async () => undefined, {
      rowLock: false,
    });

    const marker = Symbol('timeout');
    const raced = await Promise.race([
      serviceOnOwnConnection()
        .resendManagerInvitation(a, organizationId, managerId)
        .then(() => 'completed' as const)
        .catch(() => 'rejected' as const),
      new Promise((r) => setTimeout(() => r(marker), 1_500)),
    ]);
    await release();
    await committed;
    // Finishing while the lock was held would mean it never asked for it.
    expect(raced).toBe(marker);
  });

  describe('a target that is not this organization’s pending manager', () => {
    it('foreign, nonexistent and malformed ids are INDISTINGUISHABLE', async () => {
      const a = await actor();
      const mine = await onboarded();
      const theirs = await onboarded();
      const service = serviceOnOwnConnection();

      const message = async (organizationId: string, userId: string) =>
        service
          .resendManagerInvitation(a, organizationId, userId)
          .then(() => 'resolved')
          .catch((e) => String(e.message));

      const foreign = await message(mine.organizationId, theirs.managerId);
      const missing = await message(mine.organizationId, '11111111-1111-4111-8111-111111111111');
      const malformed = await message(mine.organizationId, 'not-a-uuid');
      const unknownOrg = await message('22222222-2222-4222-8222-222222222222', mine.managerId);

      expect(foreign).toBe('User not found');
      expect(missing).toBe('User not found');
      // A typo must not become a 500 from `where id in ('not-a-uuid')`.
      expect(malformed).toBe('User not found');
      expect(unknownOrg).toBe('User not found');
      // The foreign manager's own invitation was not touched by the probe.
      expect(await liveTokens(theirs.managerId)).toHaveLength(1);
    });
  });

  it('a failure BEFORE commit leaves the previous valid token intact', async () => {
    const { actor: a, organizationId, managerId } = await onboarded();
    const before = await liveTokens(managerId);
    expect(before).toHaveLength(1);

    // The audit write is inside the transaction, so a sink that throws is a
    // real pre-commit failure — after the old token was deleted and the new one
    // created, which is exactly the window that must roll back.
    const brittle = serviceOnOwnConnection({
      recordAuditEntry: async () => undefined,
      recordAuditEntryIn: async () => {
        throw new Error('audit sink unavailable');
      },
    });
    await expect(brittle.resendManagerInvitation(a, organizationId, managerId)).rejects.toThrow(/audit sink/i);

    // Byte for byte the same link: the manager's invitation still works.
    expect(await liveTokens(managerId)).toEqual(before);
  });

  it('an EMAIL failure after commit leaves the NEW token available for another resend', async () => {
    const { actor: a, organizationId, managerId } = await onboarded();
    const before = await liveTokens(managerId);

    mailOutcome = false;
    const failed = await serviceOnOwnConnection().resendManagerInvitation(a, organizationId, managerId);
    expect(failed).toEqual({ pending: true, deliveryStatus: 'FAILED' });

    // Committed before the mail was attempted: a NEW link exists, the old one
    // is gone, and a second explicit resend can deliver it.
    const after = await liveTokens(managerId);
    expect(after).toHaveLength(1);
    expect(after[0]).not.toBe(before[0]);

    mailOutcome = true;
    const retried = await serviceOnOwnConnection().resendManagerInvitation(a, organizationId, managerId);
    expect(retried).toEqual({ pending: true, deliveryStatus: 'DELIVERED' });
    expect(await liveTokens(managerId)).toHaveLength(1);
  });
  /**
   * THE OTHER HALF OF "DECIDE UNDER THE LOCK": DECIDE ON WHAT YOU RE-READ.
   *
   * Waiting for the lock is worthless if the row that comes back afterwards is
   * the one already sitting in the entity manager's identity map. A request
   * that read the manager earlier — and Nest gives a request ONE entity manager
   * — would validate against the state it saw before it waited. `refresh: true`
   * is what forces the read to come from the database.
   */
  it('re-reads the row rather than the identity map it already holds', async () => {
    const a = await actor();
    const { organizationId, managerId } = await onboarded();
    const { service, fork } = serviceOn();

    // An earlier read in the same request context, exactly as a list or a
    // permission check would have done.
    const cached = await fork.findOne(
      User,
      { id: managerId },
      { populate: ['role', 'store', 'organization'] as never },
    );
    expect(cached!.passwordHash).toBeNull();

    // Somebody else accepts the invitation, and commits.
    await conn().execute(`update users set password_hash = 'accepted-hash' where id = ?`, [managerId]);

    await expect(service.resendManagerInvitation(a, organizationId, managerId)).rejects.toThrow(/already finished/i);
  });
});
