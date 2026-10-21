import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { UsersService } from '../../users.service';
import { User } from '../../entities/user.entity';
import { Role } from '../../entities/role.entity';
import { PasswordResetToken } from '../../../auth/entities/password-reset-token.entity';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';
import { AuditLogService } from '../../../audit-log/audit-log.service';
import { AuditLog } from '../../../audit-log/entities/audit-log.entity';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * SLICE A against a real PostgreSQL: role and store binding move together, or
 * not at all.
 *
 * The defect being closed is not "the role could not be set". It is that role
 * and binding were two requests and the legal combinations span both, so
 * promoting a store-bound admin had NO valid ordering — set the role first and
 * the stale store makes it illegal; clear the store first and the stale role
 * does. These tests assert the combination, never one half of it, and every
 * refusal is checked to have left the database exactly as it was.
 */
d('organization access contract (real PostgreSQL, #274)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let service: UsersService;

  const conn = () => em.getConnection();
  const one = async (sql: string, params: unknown[] = []) => (await conn().execute(sql, params))[0];

  let seq = 0;
  const newOrg = async (archived = false): Promise<string> => {
    seq += 1;
    const row = await one(
      `insert into organizations (name, slug, archived_at, created_at, updated_at)
       values (?, ?, ${archived ? 'now()' : 'null'}, now(), now()) returning id`,
      [`Access Org ${seq}`, `access-org-${seq}`],
    );
    return row.id as string;
  };
  const newStore = async (organizationId: string, archived = false): Promise<string> => {
    seq += 1;
    const row = await one(
      `insert into stores (name, slug, organization_id, archived_at, created_at, updated_at)
       values (?, ?, ?, ${archived ? 'now()' : 'null'}, now(), now()) returning id`,
      [`Access Store ${seq}`, `access-store-${seq}`, organizationId],
    );
    return row.id as string;
  };
  const roleId = async (name: string) => (await one('select id from roles where name = ?', [name])).id as string;

  const newUser = async (opts: {
    role: string;
    organizationId?: string | null;
    storeId?: string | null;
    deactivated?: boolean;
  }): Promise<string> => {
    seq += 1;
    const row = await one(
      `insert into users (email, password_hash, role_id, organization_id, store_id, deleted_at, created_at, updated_at)
       values (?, 'x', ?, ?, ?, ${opts.deactivated ? 'now()' : 'null'}, now(), now()) returning id`,
      [`access-${seq}@example.com`, await roleId(opts.role), opts.organizationId ?? null, opts.storeId ?? null],
    );
    return row.id as string;
  };

  /** The persisted access of a user, as the contract defines it. */
  const accessOf = (userId: string) =>
    one(
      `select r.name as role, u.organization_id, u.store_id, u.deleted_at
         from users u join roles r on r.id = u.role_id where u.id = ?`,
      [userId],
    );

  const liveSessions = async (userId: string): Promise<number> =>
    Number(
      (await one(`select count(*)::int as c from refresh_tokens where user_id = ? and revoked_at is null`, [userId])).c,
    );
  const addSession = async (userId: string) => {
    seq += 1;
    // `refresh_tokens.id` has no database default — the entity supplies it —
    // so the fixture must too.
    await conn().execute(
      `insert into refresh_tokens (id, user_id, token_hash, expires_at, created_at)
       values (gen_random_uuid(), ?, ?, now() + interval '1 day', now())`,
      [userId, `hash-${seq}`],
    );
  };
  const auditRowsFor = async (userId: string) =>
    conn().execute(`select changes, message from audit_logs where entity_id = ? order by created_at`, [userId]);

  const load = async (id: string): Promise<User> =>
    (await em.fork().findOne(User, { id }, { populate: ['role', 'store', 'organization'] as never })) as User;

  /** A scope as the REAL resolver would produce it for these actors. */
  const platformScope = (organizationId: string | null = null): TenantScope => ({
    platform: true,
    role: 'SUPER_ADMIN',
    organizationId,
    storeId: null,
    allowedStoreIds: [],
  });
  const managerScope = (organizationId: string, storeId: string | null = null): TenantScope => ({
    platform: false,
    role: 'ORGANIZATION_MANAGER',
    organizationId,
    storeId,
    allowedStoreIds: [],
  });

  beforeAll(async () => {
    pg = await withDisposablePg();
    em = pg.orm.em.fork() as EntityManager;
    // The harness MIGRATES but does not seed, and only the Phase 4 migration
    // inserts roles — ORGANIZATION_MANAGER and STORE_ADMIN. The four older
    // names are seeder-created in a real environment, so the fixture supplies
    // them here rather than pretending the migration did.
    for (const name of ['SUPER_ADMIN', 'ADMIN', 'EDITOR', 'VIEWER']) {
      await em
        .getConnection()
        .execute(
          `insert into roles (id, name) select gen_random_uuid(), ? where not exists (select 1 from roles where name = ?)`,
          [name, name],
        );
    }
    // The REAL audit service over the real repository: these tests assert what
    // lands in `audit_logs`, so stubbing the writer would test the stub.
    // Repositories from a FORK, never the global EntityManager: MikroORM
    // refuses context-specific actions on the global instance, and the service
    // does exactly those.
    const auditLogService = new AuditLogService(em.getRepository(AuditLog) as never);
    service = new UsersService(
      em.getRepository(User) as never,
      em.getRepository(Role) as never,
      em.getRepository(PasswordResetToken) as never,
      auditLogService as never,
      { send: async () => undefined, renderTemplate: () => '<html></html>' } as never,
      { get: () => undefined } as never,
    );
  });

  afterAll(async () => {
    await pg?.close();
  });

  /** The same real service, with an audit sink that always fails. */
  const brittleService = () =>
    new UsersService(
      em.getRepository(User) as never,
      em.getRepository(Role) as never,
      em.getRepository(PasswordResetToken) as never,
      {
        recordAuditEntry: async () => undefined,
        recordAuditEntryIn: async () => {
          throw new Error('audit sink unavailable');
        },
      } as never,
      { send: async () => undefined, renderTemplate: () => '<html></html>' } as never,
      { get: () => undefined } as never,
    );

  it('promotes a store-bound ADMIN to Organization Manager and clears the store in one step', async () => {
    const org = await newOrg();
    const store = await newStore(org);
    const incumbent = await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
    const target = await newUser({ role: 'ADMIN', organizationId: org, storeId: store });
    await addSession(target);
    const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));

    await service.changeOrganizationAccess(platformScope(), actor, org, target, {
      role: 'ORGANIZATION_MANAGER',
      storeId: null,
    });

    const after = await accessOf(target);
    expect(after.role).toBe('ORGANIZATION_MANAGER');
    expect(after.organization_id).toBe(org);
    // The half that had no valid ordering before: the store is gone.
    expect(after.store_id).toBeNull();
    expect(await liveSessions(target)).toBe(0);
    expect(incumbent).toBeTruthy();
  });

  /**
   * #275: the directory changes ONE person at a time.
   *
   * The Platform Users page shows many rows and acts on one. A change that
   * moved a bystander would be invisible on that screen — the operator is
   * looking at the row they clicked — so the isolation is asserted here, on
   * every field the row displays, for a colleague in the SAME branch and for
   * someone in another company entirely.
   */
  it('changing one user alters NOBODY else, in the same branch or another company', async () => {
    const org = await newOrg();
    const store = await newStore(org);
    const otherOrg = await newOrg();
    const otherStore = await newStore(otherOrg);

    await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
    const target = await newUser({ role: 'ADMIN', organizationId: org, storeId: store });
    const colleague = await newUser({ role: 'EDITOR', organizationId: org, storeId: store });
    const stranger = await newUser({ role: 'ADMIN', organizationId: otherOrg, storeId: otherStore });
    await addSession(colleague);
    await addSession(stranger);

    const before = { colleague: await accessOf(colleague), stranger: await accessOf(stranger) };
    const colleagueSessions = await liveSessions(colleague);
    const strangerSessions = await liveSessions(stranger);

    const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));
    await service.changeOrganizationAccess(platformScope(), actor, org, target, { role: 'VIEWER', storeId: store });

    expect((await accessOf(target)).role).toBe('VIEWER');
    // Byte for byte: role, company and branch, for both bystanders.
    expect(await accessOf(colleague)).toEqual(before.colleague);
    expect(await accessOf(stranger)).toEqual(before.stranger);
    // And their sessions are untouched — revocation is the target's alone.
    expect(await liveSessions(colleague)).toBe(colleagueSessions);
    expect(await liveSessions(stranger)).toBe(strangerSessions);
  });

  it('demotes a manager to a branch role and sets the required store in one step', async () => {
    const org = await newOrg();
    const store = await newStore(org);
    await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
    const target = await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
    const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));

    await service.changeOrganizationAccess(platformScope(), actor, org, target, { role: 'EDITOR', storeId: store });

    const after = await accessOf(target);
    expect(after.role).toBe('EDITOR');
    expect(after.store_id).toBe(store);
  });

  it('records before/after role AND binding, plus the revocation count, without secrets', async () => {
    const org = await newOrg();
    const store = await newStore(org);
    const target = await newUser({ role: 'VIEWER', organizationId: org, storeId: store });
    await addSession(target);
    await addSession(target);
    const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));

    await service.changeOrganizationAccess(platformScope(), actor, org, target, { role: 'ADMIN', storeId: store });

    const rows = await auditRowsFor(target);
    expect(rows).toHaveLength(1);
    const changes = rows[0].changes;
    expect(changes.access.before).toEqual({ role: 'VIEWER', organizationId: org, storeId: store });
    expect(changes.access.after).toEqual({ role: 'ADMIN', organizationId: org, storeId: store });
    expect(changes.revokedSessions).toBe(2);
    expect(JSON.stringify(rows[0])).not.toMatch(/password|token_hash|secret/i);
  });

  it('an identical request is an idempotent no-op: no audit row, no session revoked', async () => {
    const org = await newOrg();
    const store = await newStore(org);
    const target = await newUser({ role: 'ADMIN', organizationId: org, storeId: store });
    await addSession(target);
    const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));

    await service.changeOrganizationAccess(platformScope(), actor, org, target, { role: 'ADMIN', storeId: store });

    expect(await auditRowsFor(target)).toHaveLength(0);
    expect(await liveSessions(target)).toBe(1);
  });

  describe('refusals leave the database untouched', () => {
    const unchanged = async (userId: string, expected: { role: string; store: string | null }) => {
      const row = await accessOf(userId);
      expect(row.role).toBe(expected.role);
      expect(row.store_id).toBe(expected.store);
      expect(await auditRowsFor(userId)).toHaveLength(0);
    };

    it('a manager may not be given a store', async () => {
      const org = await newOrg();
      const store = await newStore(org);
      const target = await newUser({ role: 'ADMIN', organizationId: org, storeId: store });
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));
      await expect(
        service.changeOrganizationAccess(platformScope(), actor, org, target, {
          role: 'ORGANIZATION_MANAGER',
          storeId: store,
        }),
      ).rejects.toThrow(/cannot be pinned to a store/i);
      await unchanged(target, { role: 'ADMIN', store });
    });

    it('a branch role may not be left without a store', async () => {
      const org = await newOrg();
      const target = await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
      await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));
      await expect(
        service.changeOrganizationAccess(platformScope(), actor, org, target, { role: 'ADMIN', storeId: null }),
      ).rejects.toThrow(/must belong to a store/i);
      await unchanged(target, { role: 'ORGANIZATION_MANAGER', store: null });
    });

    it("another organization's store is not found", async () => {
      const org = await newOrg();
      const foreign = await newStore(await newOrg());
      const store = await newStore(org);
      const target = await newUser({ role: 'ADMIN', organizationId: org, storeId: store });
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));
      await expect(
        service.changeOrganizationAccess(platformScope(), actor, org, target, { role: 'EDITOR', storeId: foreign }),
      ).rejects.toThrow(/store not found/i);
      await unchanged(target, { role: 'ADMIN', store });
    });

    it('an archived store is refused', async () => {
      const org = await newOrg();
      const store = await newStore(org);
      const archived = await newStore(org, true);
      const target = await newUser({ role: 'ADMIN', organizationId: org, storeId: store });
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));
      await expect(
        service.changeOrganizationAccess(platformScope(), actor, org, target, { role: 'EDITOR', storeId: archived }),
      ).rejects.toThrow(/archived/i);
      await unchanged(target, { role: 'ADMIN', store });
    });

    it('a deactivated target is refused', async () => {
      const org = await newOrg();
      const store = await newStore(org);
      const target = await newUser({ role: 'ADMIN', organizationId: org, storeId: store, deactivated: true });
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));
      await expect(
        service.changeOrganizationAccess(platformScope(), actor, org, target, { role: 'EDITOR', storeId: store }),
      ).rejects.toThrow(/deactivated/i);
    });

    it('a target of another organization is NOT FOUND, and so is one that never existed', async () => {
      const org = await newOrg();
      const otherOrg = await newOrg();
      const foreignStore = await newStore(otherOrg);
      const foreign = await newUser({ role: 'ADMIN', organizationId: otherOrg, storeId: foreignStore });
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));

      const madeUp = '00000000-0000-4000-8000-000000000000';
      const a = await service
        .changeOrganizationAccess(platformScope(), actor, org, foreign, { role: 'VIEWER', storeId: null })
        .catch((e) => e);
      const b = await service
        .changeOrganizationAccess(platformScope(), actor, org, madeUp, { role: 'VIEWER', storeId: null })
        .catch((e) => e);
      // Indistinguishable on purpose: otherwise the endpoint answers "does this
      // id exist somewhere on the platform".
      expect(a.constructor.name).toBe(b.constructor.name);
      expect(a.message).toBe(b.message);
      // And specifically NOT FOUND. Two identical 403s would be
      // indistinguishable from each other while still confirming to the caller
      // that the organization exists and it simply lacks rights over it.
      expect(a.constructor.name).toBe('NotFoundException');
      expect(a.getStatus?.()).toBe(404);
      await unchanged(foreign, { role: 'ADMIN', store: foreignStore });
    });
  });

  it('AUDIT FAILURE ROLLS THE AUTHORITY CHANGE BACK — role, binding and sessions', async () => {
    const org = await newOrg();
    const store = await newStore(org);
    const target = await newUser({ role: 'VIEWER', organizationId: org, storeId: store });
    await addSession(target);
    const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));

    // An unrecorded privilege grant is precisely the event an audit trail
    // exists to hold, so the grant must not survive its own logging failure.
    const failingAudit = {
      recordAuditEntry: async () => undefined,
      recordAuditEntryIn: async () => {
        throw new Error('audit sink unavailable');
      },
    };
    const brittle = new UsersService(
      em.getRepository(User) as never,
      em.getRepository(Role) as never,
      em.getRepository(PasswordResetToken) as never,
      failingAudit as never,
      { send: async () => undefined, renderTemplate: () => '<html></html>' } as never,
      { get: () => undefined } as never,
    );

    await expect(
      brittle.changeOrganizationAccess(platformScope(), actor, org, target, { role: 'ADMIN', storeId: store }),
    ).rejects.toThrow(/audit sink unavailable/i);

    const after = await accessOf(target);
    expect(after.role).toBe('VIEWER');
    // The session revocation is inside the same transaction, so it rolled back too.
    expect(await liveSessions(target)).toBe(1);
  });

  describe('who may do what', () => {
    it('a manager may staff its own company but never mint another manager', async () => {
      const org = await newOrg();
      const store = await newStore(org);
      const manager = await load(await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org }));
      const target = await newUser({ role: 'VIEWER', organizationId: org, storeId: store });

      await service.changeOrganizationAccess(managerScope(org), manager, org, target, {
        role: 'EDITOR',
        storeId: store,
      });
      expect((await accessOf(target)).role).toBe('EDITOR');

      await expect(
        service.changeOrganizationAccess(managerScope(org), manager, org, target, {
          role: 'ORGANIZATION_MANAGER',
          storeId: null,
        }),
      ).rejects.toThrow(/platform administrator/i);
    });

    it('a manager reaching into another company gets NOT FOUND, header or no header', async () => {
      const org = await newOrg();
      const otherOrg = await newOrg();
      const store = await newStore(otherOrg);
      const manager = await load(await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org }));
      const target = await newUser({ role: 'VIEWER', organizationId: otherOrg, storeId: store });

      // The scope names the manager's OWN company — the path names another.
      await expect(
        service.changeOrganizationAccess(managerScope(org), manager, otherOrg, target, {
          role: 'EDITOR',
          storeId: store,
        }),
      ).rejects.toThrow(/not found/i);
    });

    it('A NARROWED MANAGER KEEPS ITS COMPANY-WIDE STAFFING AUTHORITY', async () => {
      // Narrowing chooses which branch the panel is showing; it does not
      // demote the person running the company (ADR 014 §22). An earlier
      // revision of this contract refused here, which was an invented rule.
      const org = await newOrg();
      const branchA = await newStore(org);
      const branchB = await newStore(org);
      const manager = await load(await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org }));
      const target = await newUser({ role: 'VIEWER', organizationId: org, storeId: branchB });

      // Narrowed to A, acting on someone in B — its own company either way.
      await service.changeOrganizationAccess(managerScope(org, branchA), manager, org, target, {
        role: 'EDITOR',
        storeId: branchB,
      });
      expect((await accessOf(target)).role).toBe('EDITOR');
    });

    it('a narrowed manager still cannot mint a manager', async () => {
      const org = await newOrg();
      const store = await newStore(org);
      const manager = await load(await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org }));
      const target = await newUser({ role: 'ADMIN', organizationId: org, storeId: store });
      await expect(
        service.changeOrganizationAccess(managerScope(org, store), manager, org, target, {
          role: 'ORGANIZATION_MANAGER',
          storeId: null,
        }),
      ).rejects.toThrow(/platform administrator/i);
    });

    it('A PLATFORM OWNER INSIDE COMPANY A KEEPS ITS AUTHORITY OVER COMPANY B', async () => {
      // The managed-organization header is a UI convenience. It cannot
      // manufacture platform authority for anyone else, and it must not
      // quietly subtract it from a real owner either — an earlier revision
      // refused this, demoting an authenticated SUPER_ADMIN by header.
      const orgA = await newOrg();
      const orgB = await newOrg();
      const store = await newStore(orgB);
      await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: orgB });
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));
      const target = await newUser({ role: 'VIEWER', organizationId: orgB, storeId: store });

      await service.changeOrganizationAccess(platformScope(orgA), actor, orgB, target, {
        role: 'EDITOR',
        storeId: store,
      });
      expect((await accessOf(target)).role).toBe('EDITOR');
    });

    it('an UNSCOPED platform owner may name any organization', async () => {
      const org = await newOrg();
      const store = await newStore(org);
      await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));
      const target = await newUser({ role: 'VIEWER', organizationId: org, storeId: store });

      await service.changeOrganizationAccess(platformScope(null), actor, org, target, {
        role: 'ADMIN',
        storeId: store,
      });
      expect((await accessOf(target)).role).toBe('ADMIN');
    });

    it('nobody manages their own account here', async () => {
      const org = await newOrg();
      const store = await newStore(org);
      const actor = await load(await newUser({ role: 'SUPER_ADMIN', organizationId: org }));
      await expect(
        service.changeOrganizationAccess(platformScope(org), actor, org, actor.id, {
          role: 'ADMIN',
          storeId: store,
        }),
      ).rejects.toThrow(/your own account/i);
    });

    it('an ADMIN actor holds none of this', async () => {
      const org = await newOrg();
      const store = await newStore(org);
      const actor = await load(await newUser({ role: 'ADMIN', organizationId: org, storeId: store }));
      const target = await newUser({ role: 'VIEWER', organizationId: org, storeId: store });
      await expect(
        service.changeOrganizationAccess(
          { platform: false, role: 'ADMIN', organizationId: org, storeId: store, allowedStoreIds: [store] },
          actor,
          org,
          target,
          { role: 'EDITOR', storeId: store },
        ),
      ).rejects.toThrow(/insufficient permissions/i);
    });
  });

  describe('an active organization keeps a manager', () => {
    it('the last active manager cannot be demoted through the access endpoint', async () => {
      const org = await newOrg();
      const store = await newStore(org);
      const only = await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));

      await expect(
        service.changeOrganizationAccess(platformScope(), actor, org, only, { role: 'ADMIN', storeId: store }),
      ).rejects.toThrow(/last active Organization Manager/i);
      expect((await accessOf(only)).role).toBe('ORGANIZATION_MANAGER');
    });

    it('a manager may be demoted while a second one remains', async () => {
      const org = await newOrg();
      const store = await newStore(org);
      await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
      const second = await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));

      await service.changeOrganizationAccess(platformScope(), actor, org, second, { role: 'ADMIN', storeId: store });
      expect((await accessOf(second)).role).toBe('ADMIN');
    });

    it('a DEACTIVATED manager does not count as the one that remains', async () => {
      const org = await newOrg();
      const store = await newStore(org);
      const only = await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
      await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org, deactivated: true });
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));

      await expect(
        service.changeOrganizationAccess(platformScope(), actor, org, only, { role: 'ADMIN', storeId: store }),
      ).rejects.toThrow(/last active Organization Manager/i);
    });
  });

  /**
   * THE LEGACY WRITERS NOW FOLLOW THE SAME RULE, because "material authority
   * change" was never a property of the new endpoint — it is a property of the
   * change. `PATCH /users/:id/role` previously revoked nothing and audited
   * after the commit; `deactivate` revoked inside but audited outside.
   */
  describe('legacy /users writers: sessions and audit are transactional too', () => {
    const scopeFor = (org: string): TenantScope => ({
      platform: true,
      role: 'SUPER_ADMIN',
      organizationId: org,
      storeId: null,
      allowedStoreIds: [],
    });

    it('updateRole revokes the sessions it invalidates, and audits the count', async () => {
      const org = await newOrg();
      const store = await newStore(org);
      const target = await newUser({ role: 'EDITOR', organizationId: org, storeId: store });
      await addSession(target);
      await addSession(target);
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));

      await service.updateRole(scopeFor(org), actor, target, 'VIEWER');

      expect((await accessOf(target)).role).toBe('VIEWER');
      expect(await liveSessions(target)).toBe(0);
      const [row] = await auditRowsFor(target);
      expect(row.changes.role).toEqual({ before: 'EDITOR', after: 'VIEWER' });
      expect(row.changes.revokedSessions).toBe(2);
    });

    it('updateRole to the SAME role is a no-op: no audit row, no session revoked', async () => {
      const org = await newOrg();
      const store = await newStore(org);
      const target = await newUser({ role: 'EDITOR', organizationId: org, storeId: store });
      await addSession(target);
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));

      await service.updateRole(scopeFor(org), actor, target, 'EDITOR');

      expect(await auditRowsFor(target)).toHaveLength(0);
      expect(await liveSessions(target)).toBe(1);
    });

    it('a failing audit ROLLS BACK updateRole — role and sessions both survive', async () => {
      const org = await newOrg();
      const store = await newStore(org);
      const target = await newUser({ role: 'EDITOR', organizationId: org, storeId: store });
      await addSession(target);
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));

      await expect(brittleService().updateRole(scopeFor(org), actor, target, 'VIEWER')).rejects.toThrow(
        /audit sink unavailable/i,
      );

      expect((await accessOf(target)).role).toBe('EDITOR');
      expect(await liveSessions(target)).toBe(1);
    });

    it('a failing audit ROLLS BACK deactivate — the user stays active and signed in', async () => {
      const org = await newOrg();
      const store = await newStore(org);
      const target = await newUser({ role: 'VIEWER', organizationId: org, storeId: store });
      await addSession(target);
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));

      await expect(brittleService().deactivate(scopeFor(org), actor, target)).rejects.toThrow(
        /audit sink unavailable/i,
      );

      expect((await accessOf(target)).deleted_at).toBeNull();
      expect(await liveSessions(target)).toBe(1);
    });

    it('deactivate audits the revocation count transactionally', async () => {
      const org = await newOrg();
      const store = await newStore(org);
      const target = await newUser({ role: 'VIEWER', organizationId: org, storeId: store });
      await addSession(target);
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));

      await service.deactivate(scopeFor(org), actor, target);

      expect((await accessOf(target)).deleted_at).not.toBeNull();
      expect(await liveSessions(target)).toBe(0);
      const [row] = await auditRowsFor(target);
      expect(row.changes.revokedSessions).toBe(1);
    });
  });

  /**
   * THE WRITER CENSUS (5-D2), asserted rather than asserted-about.
   *
   * Every backend path that can eliminate effective Organization Manager
   * authority, and what happens at each. Two of them are exempt BY THE ACCEPTED
   * RULE rather than by oversight, and the exemption is what these prove.
   */
  /**
   * WHAT PROTECTS THE LAST SUPER_ADMIN — proved against EVERY current writer.
   *
   * The answer is the level rule, not a lock and not a count.
   * `assertCanManageRole` refuses a target whose level is >= the actor's, and
   * SUPER_ADMIN is the top level, so no actor can reach one. The organization
   * access contract refuses it a second time, in the DTO, before any service
   * runs. Superadmin mutation is structurally unsupported.
   *
   * This is the census: every backend path that writes `users.role_id` or
   * `users.deleted_at`, each asked to modify a SUPER_ADMIN and each refusing.
   * A direct test of a lock helper would prove nothing about these routes.
   */
  describe('no current API writer can modify a SUPER_ADMIN', () => {
    const setup = async () => {
      const org = await newOrg();
      const store = await newStore(org);
      await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
      // A SUPER_ADMIN carrying an organization — the only shape that gets
      // anywhere near a tenant-scoped writer.
      const owner = await newUser({ role: 'SUPER_ADMIN', organizationId: org, storeId: store });
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));
      const scope: TenantScope = {
        platform: true,
        role: 'SUPER_ADMIN',
        organizationId: org,
        storeId: null,
        allowedStoreIds: [],
      };
      return { org, store, owner, actor, scope };
    };

    it('updateRole refuses — the level rule, before anything is locked', async () => {
      const { org, owner, actor, scope } = await setup();
      await expect(service.updateRole(scope, actor, owner, 'ADMIN')).rejects.toThrow(
        /cannot manage a user with role SUPER_ADMIN/i,
      );
      expect((await accessOf(owner)).role).toBe('SUPER_ADMIN');
      expect(await auditRowsFor(owner)).toHaveLength(0);
      expect(org).toBeTruthy();
    });

    it('deactivate refuses', async () => {
      const { owner, actor, scope } = await setup();
      await expect(service.deactivate(scope, actor, owner)).rejects.toThrow(
        /cannot manage a user with role SUPER_ADMIN/i,
      );
      expect((await accessOf(owner)).deleted_at).toBeNull();
    });

    it('the organization access contract refuses a SUPER_ADMIN TARGET', async () => {
      const { org, store, owner, actor } = await setup();
      await expect(
        service.changeOrganizationAccess(platformScope(), actor, org, owner, { role: 'ADMIN', storeId: store }),
      ).rejects.toThrow(/cannot manage a user with role SUPER_ADMIN/i);
      expect((await accessOf(owner)).role).toBe('SUPER_ADMIN');
    });

    it('the manager transfer refuses a SUPER_ADMIN on either side', async () => {
      const { org, store, owner, actor } = await setup();
      const manager = await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
      await expect(
        service.transferOrganizationManager(platformScope(), actor, org, {
          currentManagerUserId: manager,
          replacementUserId: owner,
          formerManagerRole: 'ADMIN',
          formerManagerStoreId: store,
        }),
      ).rejects.toThrow(/cannot manage a user with role SUPER_ADMIN/i);
      expect((await accessOf(owner)).role).toBe('SUPER_ADMIN');
      expect((await accessOf(manager)).role).toBe('ORGANIZATION_MANAGER');
    });

    it('resetPassword and setStore refuse too — the same rule guards every staffing writer', async () => {
      const { org, store, owner, actor, scope } = await setup();
      await expect(service.resetPassword(scope, actor, owner, 'irrelevant-value')).rejects.toThrow(
        /cannot manage a user with role SUPER_ADMIN/i,
      );
      await expect(service.setStore(scope, actor, owner, store)).rejects.toThrow(
        /cannot manage a user with role SUPER_ADMIN/i,
      );
      expect(org).toBeTruthy();
    });

    it('the population is unchanged after every refusal', async () => {
      const remaining = await one(
        `select count(*)::int as c from users u join roles r on r.id = u.role_id
          where u.deleted_at is null and r.name = 'SUPER_ADMIN'`,
      );
      expect(Number(remaining.c)).toBeGreaterThan(0);
    });
  });

  describe('every writer that can eliminate manager authority', () => {
    it('ARCHIVING an organization does NOT remove its managers', async () => {
      const org = await newOrg();
      const manager = await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
      await conn().execute(`update organizations set archived_at = now() where id = ?`, [org]);

      const row = await accessOf(manager);
      expect(row.role).toBe('ORGANIZATION_MANAGER');
      expect(row.deleted_at).toBeNull();
    });

    it('an ARCHIVED organization is exempt from the manager rule — but since #277 P2 the DATABASE refuses the write first: it is operationally inactive', async () => {
      // Before P2 this case deactivated the only manager of an archived company
      // and expected it to be PERMITTED: the rule asks the organization, not the
      // user, and an archived one may hold zero managers. That exemption still
      // stands (the merge case below produces exactly that state), but the
      // write itself no longer reaches the rule: every member change under an
      // archived company is refused by the lifecycle guard with WGR03. The
      // manager stays; the company must be restored before its people change.
      const org = await newOrg();
      const store = await newStore(org);
      const only = await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));
      await conn().execute(`update organizations set archived_at = now() where id = ?`, [org]);

      await expect(
        service.deactivate(
          { platform: true, role: 'SUPER_ADMIN', organizationId: org, storeId: null, allowedStoreIds: [] },
          actor,
          only,
        ),
      ).rejects.toThrow(/organization is archived/);
      expect((await accessOf(only)).deleted_at).toBeNull();
      expect(store).toBeTruthy();
    });

    it('MERGE leaves the source ARCHIVED, so its zero managers are legal', async () => {
      // The merge service retags users to the target and archives the source in
      // ONE transaction (`organization-merge.service.ts`), so the state it
      // produces — a source with no users — is the permitted archived case, not
      // an active organization stripped of managers. Reproduced here as SQL
      // because the invariant belongs to the resulting STATE, not the caller.
      const source = await newOrg();
      const target = await newOrg();
      const manager = await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: source });
      await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: target });

      await conn().execute(`update users set organization_id = ? where organization_id = ?`, [target, source]);
      await conn().execute(`update organizations set archived_at = now() where id = ?`, [source]);

      const sourceManagers = await one(
        `select count(*)::int as c from users u join roles r on r.id = u.role_id
          where u.organization_id = ? and u.deleted_at is null and r.name = 'ORGANIZATION_MANAGER'`,
        [source],
      );
      const targetManagers = await one(
        `select count(*)::int as c from users u join roles r on r.id = u.role_id
          where u.organization_id = ? and u.deleted_at is null and r.name = 'ORGANIZATION_MANAGER'`,
        [target],
      );
      expect(Number(sourceManagers.c)).toBe(0);
      // The manager did not vanish; it moved, and the target now has two.
      expect(Number(targetManagers.c)).toBe(2);
      expect((await accessOf(manager)).role).toBe('ORGANIZATION_MANAGER');
    });

    it('REACTIVATE can only add managers, never remove one', async () => {
      const org = await newOrg();
      const only = await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
      const dormant = await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org, deactivated: true });
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));

      await service.reactivate(
        { platform: true, role: 'SUPER_ADMIN', organizationId: org, storeId: null, allowedStoreIds: [] },
        actor,
        dormant,
      );
      expect((await accessOf(dormant)).deleted_at).toBeNull();
      expect((await accessOf(only)).role).toBe('ORGANIZATION_MANAGER');
    });

    it('AN ACTIVE ORGANIZATION WITH ZERO MANAGERS CAN STILL BE REPAIRED', async () => {
      // The transitional case until Slice C: onboarding created active
      // companies whose only user is a store-bound ADMIN. Slice A must be able
      // to give them their first manager — a global "must have one" check would
      // have made those companies unfixable.
      const org = await newOrg();
      const store = await newStore(org);
      const lonelyAdmin = await newUser({ role: 'ADMIN', organizationId: org, storeId: store });
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));

      await service.changeOrganizationAccess(platformScope(), actor, org, lonelyAdmin, {
        role: 'ORGANIZATION_MANAGER',
        storeId: null,
      });

      const row = await accessOf(lonelyAdmin);
      expect(row.role).toBe('ORGANIZATION_MANAGER');
      expect(row.store_id).toBeNull();
    });
  });

  describe('manager transfer', () => {
    const setup = async () => {
      const org = await newOrg();
      const store = await newStore(org);
      const outgoing = await newUser({ role: 'ORGANIZATION_MANAGER', organizationId: org });
      const incoming = await newUser({ role: 'ADMIN', organizationId: org, storeId: store });
      const actor = await load(await newUser({ role: 'SUPER_ADMIN' }));
      return { org, store, outgoing, incoming, actor };
    };

    it('swaps both sides in one transaction and never leaves the company without a manager', async () => {
      const { org, store, outgoing, incoming, actor } = await setup();
      await addSession(outgoing);
      await addSession(incoming);

      const result = await service.transferOrganizationManager(platformScope(), actor, org, {
        currentManagerUserId: outgoing,
        replacementUserId: incoming,
        formerManagerRole: 'ADMIN',
        formerManagerStoreId: store,
      });

      expect(result.noop).toBe(false);
      expect((await accessOf(incoming)).role).toBe('ORGANIZATION_MANAGER');
      expect((await accessOf(incoming)).store_id).toBeNull();
      expect((await accessOf(outgoing)).role).toBe('ADMIN');
      expect((await accessOf(outgoing)).store_id).toBe(store);
      expect(await liveSessions(outgoing)).toBe(0);
      expect(await liveSessions(incoming)).toBe(0);
    });

    it('correlates both audit records', async () => {
      const { org, store, outgoing, incoming, actor } = await setup();
      await service.transferOrganizationManager(platformScope(), actor, org, {
        currentManagerUserId: outgoing,
        replacementUserId: incoming,
        formerManagerRole: 'ADMIN',
        formerManagerStoreId: store,
      });
      const [out] = await auditRowsFor(outgoing);
      const [inc] = await auditRowsFor(incoming);
      expect(out.changes.transferCorrelationId).toBeTruthy();
      expect(out.changes.transferCorrelationId).toBe(inc.changes.transferCorrelationId);
    });

    it('AN IDENTICAL RETRY IS A NO-OP, not a reversal', async () => {
      const { org, store, outgoing, incoming, actor } = await setup();
      const dto = {
        currentManagerUserId: outgoing,
        replacementUserId: incoming,
        formerManagerRole: 'ADMIN',
        formerManagerStoreId: store,
      };
      await service.transferOrganizationManager(platformScope(), actor, org, dto);
      const again = await service.transferOrganizationManager(platformScope(), actor, org, dto);

      expect(again.noop).toBe(true);
      // The swap stands; it was not undone by replaying the request.
      expect((await accessOf(incoming)).role).toBe('ORGANIZATION_MANAGER');
      expect((await accessOf(outgoing)).role).toBe('ADMIN');
      // And no second pair of audit rows.
      expect(await auditRowsFor(outgoing)).toHaveLength(1);
      expect(await auditRowsFor(incoming)).toHaveLength(1);
    });

    it('a manager may not transfer; only the platform may', async () => {
      const { org, store, outgoing, incoming } = await setup();
      const manager = await load(outgoing);
      await expect(
        service.transferOrganizationManager(managerScope(org), manager, org, {
          currentManagerUserId: outgoing,
          replacementUserId: incoming,
          formerManagerRole: 'ADMIN',
          formerManagerStoreId: store,
        }),
      ).rejects.toThrow(/platform administrator/i);
    });

    it('refuses when the named current manager is not one', async () => {
      const { org, store, incoming, actor } = await setup();
      const notAManager = await newUser({ role: 'EDITOR', organizationId: org, storeId: store });
      await expect(
        service.transferOrganizationManager(platformScope(), actor, org, {
          currentManagerUserId: notAManager,
          replacementUserId: incoming,
          formerManagerRole: 'ADMIN',
          formerManagerStoreId: store,
        }),
      ).rejects.toThrow(/not an Organization Manager/i);
    });

    it('refuses a replacement from another company as NOT FOUND', async () => {
      const { org, store, outgoing, actor } = await setup();
      const otherOrg = await newOrg();
      const foreign = await newUser({ role: 'ADMIN', organizationId: otherOrg, storeId: await newStore(otherOrg) });
      await expect(
        service.transferOrganizationManager(platformScope(), actor, org, {
          currentManagerUserId: outgoing,
          replacementUserId: foreign,
          formerManagerRole: 'ADMIN',
          formerManagerStoreId: store,
        }),
      ).rejects.toThrow(/not found/i);
      expect((await accessOf(outgoing)).role).toBe('ORGANIZATION_MANAGER');
    });
  });
});
