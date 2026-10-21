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
import { slugify } from '../../../imports/preview/woocommerce-mapper';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * A CLIENT IS ONE THING, so onboarding is one transaction.
 *
 * The defect is not that the three old requests were slow. It is that any
 * PREFIX of them could commit — and that the third was wrong even when it
 * succeeded, creating a store-bound ADMIN so that no company onboarded through
 * the panel ever had an ORGANIZATION_MANAGER. Every test below asserts the
 * whole outcome or asserts that NOTHING was written; there is no middle state
 * to assert.
 */
d('organization onboarding (real PostgreSQL, #276)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let service: OrganizationOnboardingService;
  let usersService: UsersService;
  let sent: { to: string; html: string }[];
  let mailOutcome: boolean;

  const conn = () => em.getConnection();
  const one = async (sql: string, params: unknown[] = []) => (await conn().execute(sql, params))[0];
  const all = (sql: string, params: unknown[] = []) => conn().execute(sql, params);

  let seq = 0;
  const roleId = async (name: string) => (await one('select id from roles where name = ?', [name])).id as string;

  const counts = async () => ({
    organizations: Number((await one(`select count(*)::int as c from organizations`)).c),
    stores: Number((await one(`select count(*)::int as c from stores`)).c),
    users: Number((await one(`select count(*)::int as c from users`)).c),
    tokens: Number((await one(`select count(*)::int as c from password_reset_tokens`)).c),
    audits: Number((await one(`select count(*)::int as c from audit_logs`)).c),
  });

  const managerRow = (email: string) =>
    one(
      `select r.name as role, u.organization_id, u.store_id, u.deleted_at, u.password_hash
         from users u join roles r on r.id = u.role_id where u.email = ?`,
      [email],
    );

  const request = (over: Partial<OnboardRequest> = {}): OnboardRequest => {
    seq += 1;
    return {
      organization: { name: `Acme ${seq}`, plan: 'BASICO' },
      store: { name: `Centro ${seq}`, websiteUrl: `https://acme${seq}.example.com` },
      manager: { email: `owner${seq}@acme.example.com`, firstName: 'Ana', lastName: 'Díaz' },
      ...over,
    };
  };

  const buildService = (audit: unknown, users?: UsersService) =>
    new OrganizationOnboardingService(
      em.getRepository(Organization) as never,
      (users ?? usersService) as never,
      audit as never,
    );

  beforeAll(async () => {
    pg = await withDisposablePg();
    em = pg.orm.em.fork() as EntityManager;
    for (const name of ['SUPER_ADMIN', 'ADMIN', 'EDITOR', 'VIEWER']) {
      await conn().execute(
        `insert into roles (id, name) select gen_random_uuid(), ? where not exists (select 1 from roles where name = ?)`,
        [name, name],
      );
    }
    sent = [];
    mailOutcome = true;
    const mail = {
      // Mirrors the real contract exactly: a boolean, never a throw.
      send: async (to: string, _subject: string, html: string) => {
        sent.push({ to, html });
        return mailOutcome;
      },
      renderTemplate: (_t: string, _s: string, vars: Record<string, string>) => `<a href="${vars.link}">go</a>`,
    };
    usersService = new UsersService(
      em.getRepository(User) as never,
      em.getRepository(Role) as never,
      em.getRepository(PasswordResetToken) as never,
      new AuditLogService(em.getRepository(AuditLog) as never) as never,
      mail as never,
      { get: () => 'https://panel.example.com' } as never,
    );
    service = buildService(new AuditLogService(em.getRepository(AuditLog) as never));
  });

  afterAll(async () => {
    await pg?.close();
  });

  const actor = async (): Promise<User> => {
    seq += 1;
    const row = await one(
      `insert into users (email, password_hash, role_id, created_at, updated_at)
       values (?, 'x', ?, now(), now()) returning id`,
      [`owner-actor-${seq}@wegox.com`, await roleId('SUPER_ADMIN')],
    );
    return (await em.fork().findOne(User, { id: row.id }, { populate: ['role'] as never })) as User;
  };

  it('creates organization, store, MANAGER and invitation in one unit', async () => {
    const a = await actor();
    const req = request();
    const result = await service.onboard(a, req);

    expect(result.idempotent).toBe(false);
    expect(result.organization.name).toBe(req.organization.name);
    expect(result.store?.name).toBe(req.store!.name);
    // THE DEFECT THIS CLOSES: the first user is a manager, never an ADMIN.
    expect(result.manager.role).toBe('ORGANIZATION_MANAGER');
    expect(result.manager.store).toBeNull();
    expect(result.invitation).toEqual({ pending: true, deliveryStatus: 'DELIVERED' });

    const row = await managerRow(req.manager.email);
    expect(row.role).toBe('ORGANIZATION_MANAGER');
    expect(row.store_id).toBeNull();
    expect(row.organization_id).toBe(result.organization.id);
    expect(row.deleted_at).toBeNull();
    expect(row.password_hash).toBeNull();
  });

  it('NO ADMIN IS EVER WRITTEN by onboarding', async () => {
    const before = Number(
      (await one(`select count(*)::int as c from users u join roles r on r.id=u.role_id where r.name='ADMIN'`)).c,
    );
    await service.onboard(await actor(), request());
    const after = Number(
      (await one(`select count(*)::int as c from users u join roles r on r.id=u.role_id where r.name='ADMIN'`)).c,
    );
    expect(after).toBe(before);
  });

  it('the invitation token exists BEFORE delivery is attempted, and its raw value never escapes', async () => {
    const a = await actor();
    const req = request();
    sent = [];
    const result = await service.onboard(a, req);

    const tokens = await all(
      `select t.token_hash from password_reset_tokens t join users u on u.id = t.user_id where u.email = ?`,
      [req.manager.email],
    );
    expect(tokens).toHaveLength(1);
    // The mail carries the link; the response and the audit do not.
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(req.manager.email);
    const raw = /token=([^"&]+)/.exec(sent[0].html)?.[1] ?? '';
    expect(raw.length).toBeGreaterThan(20);
    expect(JSON.stringify(result)).not.toContain(raw);
    const audits = await all(`select changes, message from audit_logs where entity_id = ?`, [result.manager.id]);
    expect(JSON.stringify(audits)).not.toContain(raw);
    expect(JSON.stringify(audits)).not.toContain(tokens[0].token_hash);
  });

  it('writes three correlated audit records — organization, store and manager', async () => {
    const a = await actor();
    const req = request();
    const result = await service.onboard(a, req);
    const rows = await all(`select entity_type, changes from audit_logs where entity_id in (?, ?, ?)`, [
      result.organization.id,
      result.store!.id,
      result.manager.id,
    ]);
    expect(rows).toHaveLength(3);
    const ids = new Set(rows.map((r: any) => r.changes.onboarding.correlationId));
    expect(ids.size).toBe(1);
    expect(new Set(rows.map((r: any) => r.entity_type))).toEqual(new Set(['ORGANIZATION', 'STORE', 'USER']));
  });

  it('accepts an onboarding with NO initial store (contract optionality, D2)', async () => {
    const result = await service.onboard(await actor(), request({ store: null }));
    expect(result.store).toBeNull();
    expect(result.manager.role).toBe('ORGANIZATION_MANAGER');
  });

  describe('delivery failure keeps everything committed (D5)', () => {
    it('reports FAILED and loses nothing', async () => {
      const a = await actor();
      const req = request();
      mailOutcome = false;
      try {
        const result = await service.onboard(a, req);
        expect(result.invitation).toEqual({ pending: true, deliveryStatus: 'FAILED' });
        // Everything else is committed and valid.
        expect((await managerRow(req.manager.email)).role).toBe('ORGANIZATION_MANAGER');
        const tokens = await all(
          `select 1 from password_reset_tokens t join users u on u.id=t.user_id where u.email = ?`,
          [req.manager.email],
        );
        expect(tokens).toHaveLength(1);
      } finally {
        mailOutcome = true;
      }
    });

    it('the existing resend path re-issues exactly one live token', async () => {
      const a = await actor();
      const req = request();
      mailOutcome = false;
      let managerId!: string;
      try {
        managerId = (await service.onboard(a, req)).manager.id;
      } finally {
        mailOutcome = true;
      }
      // THE BRIDGE, and why it exists: `UsersService.resendInvite` walls its
      // target with `requireOrganizationScope`, so the UNSCOPED platform owner
      // on the onboarding success screen cannot call it at all.
      await expect(
        usersService.resendInvite(
          { platform: true, role: 'SUPER_ADMIN', organizationId: null, storeId: null, allowedStoreIds: [] } as never,
          a,
          managerId,
        ),
      ).rejects.toThrow(/organization context/i);

      const organizationId = (await managerRow(req.manager.email)).organization_id as string;
      const resent = await service.resendManagerInvitation(a, organizationId, managerId);
      expect(resent).toEqual({ pending: true, deliveryStatus: 'DELIVERED' });
      // The existing contract: a fresh invite invalidates the previous unused link.
      const tokens = await all(`select 1 from password_reset_tokens where user_id = ? and used_at is null`, [
        managerId,
      ]);
      expect(tokens).toHaveLength(1);
    });
  });

  describe('idempotency compares the COMPLETE request', () => {
    it('an exact retry returns the same state and writes nothing new', async () => {
      const a = await actor();
      const req = request();
      const first = await service.onboard(a, req);
      const before = await counts();
      sent = [];

      const retry = await service.onboard(a, req);

      expect(retry.idempotent).toBe(true);
      expect(retry.organization.id).toBe(first.organization.id);
      expect(retry.manager.id).toBe(first.manager.id);
      expect(retry.store?.id).toBe(first.store?.id);
      expect(await counts()).toEqual(before);
      // No second token, and DELIBERATELY no second email.
      expect(sent).toHaveLength(0);
    });

    it('a DIFFERENT organization name for the same email is a conflict that writes nothing', async () => {
      const a = await actor();
      const req = request();
      await service.onboard(a, req);
      const before = await counts();
      await expect(
        service.onboard(a, { ...req, organization: { ...req.organization, name: 'Something Else' } }),
      ).rejects.toThrow(/already belongs to a user/i);
      expect(await counts()).toEqual(before);
    });

    it('a different STORE for the same email is a conflict', async () => {
      const a = await actor();
      const req = request();
      await service.onboard(a, req);
      await expect(service.onboard(a, { ...req, store: { ...req.store!, name: 'Another Branch' } })).rejects.toThrow(
        /already belongs to a user/i,
      );
    });

    it('a different manager PROFILE for the same email is a conflict', async () => {
      const a = await actor();
      const req = request();
      await service.onboard(a, req);
      await expect(service.onboard(a, { ...req, manager: { ...req.manager, firstName: 'Someone' } })).rejects.toThrow(
        /already belongs to a user/i,
      );
    });

    it('AN UNRELATED ORGANIZATION WITH THE SAME DISPLAY NAME IS NOT A RETRY', async () => {
      const a = await actor();
      const first = request({ organization: { name: 'Twin Co', plan: 'BASICO' } });
      await service.onboard(a, first);
      // Same company name, DIFFERENT person: a new client that happens to share
      // a display name, not a repeat of the first.
      const second = request({ organization: { name: 'Twin Co', plan: 'BASICO' } });
      const result = await service.onboard(a, second);
      expect(result.idempotent).toBe(false);
      const slugs = await all(`select slug from organizations where name = 'Twin Co' order by slug`);
      expect(slugs.map((r: any) => r.slug)).toEqual(['twin-co', 'twin-co-2']);
    });

    it('a STORE-LESS non-manager whose state OTHERWISE MATCHES is a conflict, not a retry', async () => {
      /*
       * Constructed so that EVERY other comparison passes and only the role
       * differs: same email, same organization name and plan, no store on
       * either side, same first and last name. If the role check were dropped,
       * this request would silently ADOPT an existing platform administrator
       * into a request that asked to create a manager — and report success.
       */
      const a = await actor();
      const req = request({ store: null });
      const org = await one(
        `insert into organizations (name, slug, plan, created_at, updated_at)
         values (?, ?, 'BASICO', now(), now()) returning id`,
        [req.organization.name, `storeless-${Date.now().toString(36)}-${seq}`],
      );
      await conn().execute(
        `insert into users (email, password_hash, role_id, organization_id, store_id, first_name, last_name, created_at, updated_at)
         values (?, 'x', ?, ?, null, 'Ana', 'Díaz', now(), now())`,
        [req.manager.email, await roleId('SUPER_ADMIN'), org.id],
      );
      const before = await counts();
      await expect(service.onboard(a, req)).rejects.toThrow(/already belongs to a user/i);
      expect(await counts()).toEqual(before);
    });

    it('an existing email that is NOT an onboarded manager is a conflict', async () => {
      const a = await actor();
      const req = request();
      // A plain ADMIN with that address — never an onboarding product.
      const org = await one(
        `insert into organizations (name, slug, created_at, updated_at) values ('Other','other-${Date.now()}',now(),now()) returning id`,
      );
      const store = await one(
        `insert into stores (name, slug, organization_id, created_at, updated_at) values ('B','b-${Date.now()}',?,now(),now()) returning id`,
        [org.id],
      );
      await conn().execute(
        `insert into users (email, password_hash, role_id, organization_id, store_id, created_at, updated_at)
         values (?, 'x', ?, ?, ?, now(), now())`,
        [req.manager.email, await roleId('ADMIN'), org.id, store.id],
      );
      const before = await counts();
      await expect(service.onboard(a, req)).rejects.toThrow(/already belongs to a user/i);
      expect(await counts()).toEqual(before);
    });
  });

  describe('every failure boundary rolls the whole unit back', () => {
    const nothingWritten = async (before: Awaited<ReturnType<typeof counts>>) => {
      expect(await counts()).toEqual(before);
    };

    it('an unknown role leaves nothing behind (failure before the organization)', async () => {
      const a = await actor();
      const before = await counts();
      await conn().execute(`update roles set name = 'ORGANIZATION_MANAGER_TMP' where name = 'ORGANIZATION_MANAGER'`);
      try {
        await expect(service.onboard(a, request())).rejects.toThrow(/does not exist/i);
      } finally {
        await conn().execute(`update roles set name = 'ORGANIZATION_MANAGER' where name = 'ORGANIZATION_MANAGER_TMP'`);
      }
      await nothingWritten(before);
    });

    it('an unknown plan is refused by the SERVICE too, not only the DTO', async () => {
      const a = await actor();
      const before = await counts();
      // GRATIS allows one team user and one website in the shipped plan table;
      // onboarding needs one of each, so the limit is exercised by asking for a
      // plan whose seat allowance the manager itself would exceed.
      await expect(
        service.onboard(a, request({ organization: { name: 'Seat Bound', plan: 'NO_SUCH_PLAN' } })),
      ).rejects.toThrow(/unknown plan/i);
      await nothingWritten(before);
    });

    it('a token failure rolls back organization, store, manager and audits', async () => {
      const a = await actor();
      const before = await counts();
      const brokenUsers = {
        toSafeUser: usersService.toSafeUser.bind(usersService),
        issueInviteTokenIn: async () => {
          throw new Error('token store unavailable');
        },
        deliverInviteEmail: async () => true,
      };
      const brittle = buildService(new AuditLogService(em.getRepository(AuditLog) as never), brokenUsers as never);
      await expect(brittle.onboard(a, request())).rejects.toThrow(/token store unavailable/i);
      await nothingWritten(before);
    });

    it('the ORGANIZATION audit is TRANSACTIONAL — a non-participating write would survive the rollback', async () => {
      const a = await actor();
      const before = await counts();
      const real = new AuditLogService(em.getRepository(AuditLog) as never);
      // `recordAuditEntry` is the forgiving, NON-transactional writer and really
      // persists; `recordAuditEntryIn` fails. If any audit call in onboarding
      // used the forgiving one, its row would outlive the rollback and the
      // count below would move.
      const halfBroken = {
        recordAuditEntry: real.recordAuditEntry.bind(real),
        recordAuditEntryIn: async () => {
          throw new Error('audit sink unavailable');
        },
      };
      await expect(buildService(halfBroken).onboard(a, request())).rejects.toThrow(/audit sink unavailable/i);
      expect(await counts()).toEqual(before);
    });

    it('an AUDIT failure rolls back organization, store, manager and token', async () => {
      const a = await actor();
      const before = await counts();
      const brittle = buildService({
        recordAuditEntry: async () => undefined,
        recordAuditEntryIn: async () => {
          throw new Error('audit sink unavailable');
        },
      });
      await expect(brittle.onboard(a, request())).rejects.toThrow(/audit sink unavailable/i);
      await nothingWritten(before);
    });
  });
  /**
   * WHAT WE KNOW ABOUT THE EMAIL, AND NOTHING MORE.
   *
   * The boolean this replaces could not distinguish "the attempt failed" from
   * "no attempt was made", so an exact retry — which deliberately sends nothing
   * — reported the same `false` as a dead mail provider, and went on reporting
   * it after the manager had already accepted the invitation.
   */
  describe('invitation delivery state is closed and truthful', () => {
    const acceptInvitation = async (email: string) => {
      await conn().execute(`update users set password_hash = 'accepted-hash' where email = ?`, [email]);
      await conn().execute(
        `update password_reset_tokens set used_at = now()
          where user_id = (select id from users where email = ?)`,
        [email],
      );
    };

    it('a new onboarding whose mail succeeds is DELIVERED and pending', async () => {
      const result = await service.onboard(await actor(), request());
      expect(result.invitation).toEqual({ pending: true, deliveryStatus: 'DELIVERED' });
    });

    it('a new onboarding whose mail fails is FAILED and pending', async () => {
      mailOutcome = false;
      try {
        const result = await service.onboard(await actor(), request());
        expect(result.invitation).toEqual({ pending: true, deliveryStatus: 'FAILED' });
      } finally {
        mailOutcome = true;
      }
    });

    it('an exact retry sends NOTHING, replaces NOTHING, and reports UNKNOWN', async () => {
      const a = await actor();
      const req = request();
      const created = await service.onboard(a, req);
      const sentBefore = sent.length;
      const tokenBefore = (
        await all(`select token_hash from password_reset_tokens where user_id = ? and used_at is null`, [
          created.manager.id,
        ])
      ).map((r: any) => r.token_hash);
      expect(tokenBefore).toHaveLength(1);

      const retry = await service.onboard(a, req);
      expect(retry.idempotent).toBe(true);
      expect(retry.invitation).toEqual({ pending: true, deliveryStatus: 'UNKNOWN' });
      // The claim is about the wire, not the label: no second message was sent.
      expect(sent).toHaveLength(sentBefore);
      // And the link already in the manager's inbox still works. Re-issuing on
      // a retry would silently kill it — `issueInviteTokenIn` deletes the old
      // one — so a duplicate click would break the invitation it duplicated.
      const tokenAfter = (
        await all(`select token_hash from password_reset_tokens where user_id = ? and used_at is null`, [
          created.manager.id,
        ])
      ).map((r: any) => r.token_hash);
      expect(tokenAfter).toEqual(tokenBefore);
    });

    it('an exact retry AFTER acceptance is not pending, and is never described as failed', async () => {
      const a = await actor();
      const req = request();
      await service.onboard(a, req);
      await acceptInvitation(req.manager.email);

      const retry = await service.onboard(a, req);
      expect(retry.idempotent).toBe(true);
      expect(retry.invitation.pending).toBe(false);
      expect(retry.invitation.deliveryStatus).not.toBe('FAILED');
      // Acceptance is NOT proof of delivery: `resetPassword` can set a password
      // with no email involved, so the honest answer stays UNKNOWN.
      expect(retry.invitation.deliveryStatus).toBe('UNKNOWN');
    });

    it('an explicit resend moves UNKNOWN to the outcome of THAT attempt', async () => {
      const a = await actor();
      const req = request();
      const created = await service.onboard(a, req);
      const organizationId = created.organization.id;

      const retry = await service.onboard(a, req);
      expect(retry.invitation.deliveryStatus).toBe('UNKNOWN');

      const resent = await service.resendManagerInvitation(a, organizationId, created.manager.id);
      expect(resent).toEqual({ pending: true, deliveryStatus: 'DELIVERED' });
    });

    it('a resend whose mail fails is FAILED, and the new token is still usable', async () => {
      const a = await actor();
      const req = request();
      const created = await service.onboard(a, req);
      mailOutcome = false;
      try {
        const resent = await service.resendManagerInvitation(a, created.organization.id, created.manager.id);
        expect(resent).toEqual({ pending: true, deliveryStatus: 'FAILED' });
      } finally {
        mailOutcome = true;
      }
      // Committed before the mail was attempted, so the link exists to re-send.
      const live = await all(`select 1 from password_reset_tokens where user_id = ? and used_at is null`, [
        created.manager.id,
      ]);
      expect(live).toHaveLength(1);
    });

    it('a resend is refused once the manager has accepted', async () => {
      const a = await actor();
      const req = request();
      const created = await service.onboard(a, req);
      await acceptInvitation(req.manager.email);
      await expect(service.resendManagerInvitation(a, created.organization.id, created.manager.id)).rejects.toThrow(
        /already finished/i,
      );
    });
  });

  /**
   * A UNIQUE INDEX IS NOT AN ERROR MESSAGE (#276 correction 5).
   *
   * The onboarding locks serialise onboarding against onboarding, and nothing
   * more: `POST /users` and `POST /organizations` are supported writers that
   * take none of them. Each test below drives a REAL second connection into the
   * gap between this transaction's read and its insert, so the 23505 is genuine
   * rather than simulated.
   */
  describe('a collision caused by another writer is a sanitized conflict', () => {
    /**
     * Runs `sql` on its OWN connection, committed, from inside our transaction —
     * the moment a legacy writer would land in. Wrapping a private step is the
     * smallest way to make the interleaving deterministic; the collision itself
     * is entirely real.
     */
    let restore: (() => void) | null = null;
    const interleave = (methodName: 'uniqueSlugIn', sql: () => Promise<unknown>) => {
      const target = service as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const original = target[methodName].bind(service);
      target[methodName] = async (...args: unknown[]) => {
        const value = await original(...args);
        await sql();
        return value;
      };
      restore = () => {
        target[methodName] = original;
      };
    };

    afterEach(() => {
      restore?.();
      restore = null;
    });

    it('another writer taking the EMAIL first is a 409, not a database message', async () => {
      const a = await actor();
      const req = request();
      const other = em.fork().getConnection();
      const before = await counts();

      // Committed by a different connection after we have looked and found the
      // email free — exactly what `POST /users` does without our lock.
      interleave('uniqueSlugIn', () =>
        other.execute(
          `insert into users (email, password_hash, role_id, created_at, updated_at)
                       values (?, 'x', (select id from roles where name = 'ADMIN'), now(), now())`,
          [req.manager.email],
        ),
      );

      const failure = await service.onboard(a, req).catch((e) => e);
      expect(failure.getStatus?.()).toBe(409);
      expect(String(failure.message)).toMatch(/already belongs to a user/i);
      // The database's own words never reach the client.
      expect(String(failure.message)).not.toMatch(/duplicate key|unique constraint|users_email_unique/i);

      // Everything this transaction wrote is gone; only the other writer's row remains.
      const after = await counts();
      expect(after.organizations).toBe(before.organizations);
      expect(after.stores).toBe(before.stores);
      expect(after.tokens).toBe(before.tokens);
      expect(after.audits).toBe(before.audits);
      expect(after.users).toBe(before.users + 1);
    });

    it('another writer taking the ORGANIZATION SLUG is a 409, not a database message', async () => {
      const a = await actor();
      const req = request();
      const other = em.fork().getConnection();
      const before = await counts();

      // We choose a free slug under our lock; a legacy writer that never takes
      // that lock inserts it before our flush.
      interleave('uniqueSlugIn', () =>
        other.execute(
          `insert into organizations (name, slug, created_at, updated_at) values ('Interloper', ?, now(), now())`,
          [slugify(req.organization.name)],
        ),
      );

      const failure = await service.onboard(a, req).catch((e) => e);
      expect(failure.getStatus?.()).toBe(409);
      expect(String(failure.message)).toMatch(/created at the same moment|took that web address/i);
      expect(String(failure.message)).not.toMatch(/duplicate key|unique constraint|organizations_slug_unique/i);

      const after = await counts();
      expect(after.users).toBe(before.users);
      expect(after.stores).toBe(before.stores);
      expect(after.tokens).toBe(before.tokens);
      expect(after.organizations).toBe(before.organizations + 1); // the interloper only
    });
  });
});
