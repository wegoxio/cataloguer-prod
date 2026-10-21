import { EntityManager } from '@mikro-orm/postgresql';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { UsersService } from '../../users.service';
import { User } from '../../entities/user.entity';
import { Role } from '../../entities/role.entity';
import { PasswordResetToken } from '../../../auth/entities/password-reset-token.entity';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * PHASE 4 (requirement 5, positive half) against a real PostgreSQL: the
 * ORGANIZATION_MANAGER creates its company's store-bound staff through the
 * REAL service path, and every refusal leaves no row behind.
 *
 * The live defect this closes: P4-S stage S2 — the manager's invite of a
 * Store B admin — returned 403 because POST /users never admitted the role.
 * These tests hold the service half of the repair: own-branch creation
 * works end-to-end (user persisted org+store attributed, invite token
 * stored), while foreign/archived branches, store-less hires, and any
 * attempt to mint SUPER_ADMIN or a peer manager refuse without persisting.
 */
d('ORGANIZATION_MANAGER user creation (real PostgreSQL, Phase 4 requirement 5)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let service: UsersService;

  const conn = () => em.getConnection();
  const one = async (sql: string, params: unknown[] = []) => (await conn().execute(sql, params))[0];

  let seq = 0;
  const newOrg = async (): Promise<string> => {
    seq += 1;
    const row = await one(
      `insert into organizations (name, slug, created_at, updated_at) values (?, ?, now(), now()) returning id`,
      [`OM Org ${seq}`, `om-org-${seq}`],
    );
    return row.id as string;
  };
  const newStore = async (organizationId: string, archived = false): Promise<string> => {
    seq += 1;
    const row = await one(
      `insert into stores (name, slug, organization_id, archived_at, created_at, updated_at)
       values (?, ?, ?, ${archived ? 'now()' : 'null'}, now(), now()) returning id`,
      [`OM Store ${seq}`, `om-store-${seq}`, organizationId],
    );
    return row.id as string;
  };
  const roleId = async (name: string) => (await one('select id from roles where name = ?', [name])).id as string;
  const userRowByEmail = (email: string) =>
    one(
      `select u.organization_id, u.store_id, u.password_hash, r.name as role_name
         from users u join roles r on r.id = u.role_id where u.email = ?`,
      [email],
    );
  const countByEmail = async (email: string) =>
    (await one('select count(*)::int as c from users where email = ?', [email])).c as number;

  let orgA: string;
  let orgB: string;
  let storeA1: string;
  let archivedA2: string;
  let foreignB1: string;
  let manager: User;
  let managerScope: any;

  beforeAll(async () => {
    pg = await withDisposablePg();
    em = pg.orm.em.fork() as EntityManager;
    // The base roles come from the SEEDER in real environments; the harness
    // only migrates (the migration range already inserted
    // ORGANIZATION_MANAGER and STORE_ADMIN).
    for (const name of ['SUPER_ADMIN', 'ADMIN', 'EDITOR', 'VIEWER']) {
      await conn().execute(
        `insert into roles (id, name) select gen_random_uuid(), ? where not exists (select 1 from roles where name = ?)`,
        [name, name],
      );
    }
    orgA = await newOrg();
    orgB = await newOrg();
    storeA1 = await newStore(orgA);
    archivedA2 = await newStore(orgA, true);
    foreignB1 = await newStore(orgB);

    const managerRow = await one(
      `insert into users (email, role_id, organization_id, store_id, password_hash, created_at, updated_at)
       values (?, ?, ?, null, 'set', now(), now()) returning id`,
      ['om-actor@om.test', await roleId('ORGANIZATION_MANAGER'), orgA],
    );

    // The REAL service over the real repositories; only the outward-facing
    // collaborators are stubbed, minimally and by name.
    const auditLogService = { recordAuditEntry: async () => undefined };
    const mailService = { send: async () => undefined, renderTemplate: () => '<html></html>' };
    const configService = { get: () => undefined };
    service = new UsersService(
      em.getRepository(User) as never,
      em.getRepository(Role) as never,
      em.getRepository(PasswordResetToken) as never,
      auditLogService as never,
      mailService as never,
      configService as never,
    );
    manager = (await service.findById(managerRow.id as string)) as User;
    expect(manager.role.name).toBe('ORGANIZATION_MANAGER');
    // P5-A2 family 6: the service takes the RESOLVED SCOPE first. This manager
    // runs organization A un-narrowed, exactly as the resolver would report it.
    managerScope = {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId: orgA,
      storeId: null,
      allowedStoreIds: [storeA1, archivedA2],
    } as any;
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  it('creates a store-bound ADMIN in its own branch — the Store B case', async () => {
    const result = await service.inviteUser(managerScope, manager, {
      email: 'storeb-admin@om.test',
      roleName: 'ADMIN',
      company: 'OM Org 1',
      storeId: storeA1,
    });
    expect(result.role).toBe('ADMIN');
    expect(result.pendingInvite).toBe(true);

    const row = await userRowByEmail('storeb-admin@om.test');
    expect(row.role_name).toBe('ADMIN');
    expect(row.organization_id).toBe(orgA); // the MANAGER's company
    expect(row.store_id).toBe(storeA1); // the requested branch
    expect(row.password_hash).toBeNull(); // invited, onboarding sets it
    // The onboarding token was stored for the new user.
    const tok = await one(
      `select count(*)::int as c from password_reset_tokens t
        join users u on u.id = t.user_id where u.email = ?`,
      ['storeb-admin@om.test'],
    );
    expect(tok.c).toBe(1);
  });

  it('refuses to mint a SUPER_ADMIN, persisting nothing', async () => {
    await expect(
      service.inviteUser(managerScope, manager, {
        email: 'x1@om.test',
        roleName: 'SUPER_ADMIN',
        company: 'X',
        storeId: storeA1,
      }),
    ).rejects.toThrow(/cannot create a user with role SUPER_ADMIN/);
    expect(await countByEmail('x1@om.test')).toBe(0);
  });

  it('refuses to mint a peer ORGANIZATION_MANAGER, persisting nothing', async () => {
    await expect(
      service.inviteUser(managerScope, manager, {
        email: 'x2@om.test',
        roleName: 'ORGANIZATION_MANAGER',
        company: 'X',
        storeId: storeA1,
      }),
    ).rejects.toThrow(/cannot create a user with role ORGANIZATION_MANAGER/);
    expect(await countByEmail('x2@om.test')).toBe(0);
  });

  it('refuses a store-less creation', async () => {
    await expect(
      service.inviteUser(managerScope, manager, { email: 'x3@om.test', roleName: 'ADMIN', company: 'X' }),
    ).rejects.toThrow(/storeId is required/);
    expect(await countByEmail('x3@om.test')).toBe(0);
  });

  it("refuses another company's store — indistinguishable from an absent one", async () => {
    // P5-A2 family 6: the branch is now refused by the SCOPE resolver before
    // any lookup, so the message is the shared not-found shape every other
    // family-3-onwards surface uses. Still a 404, still tells the caller
    // nothing about whether the store exists.
    await expect(
      service.inviteUser(managerScope, manager, {
        email: 'x4@om.test',
        roleName: 'ADMIN',
        company: 'X',
        storeId: foreignB1,
      }),
    ).rejects.toThrow(/not found/);
    expect(await countByEmail('x4@om.test')).toBe(0);
  });

  it('refuses an archived store of its own company', async () => {
    await expect(
      service.inviteUser(managerScope, manager, {
        email: 'x5@om.test',
        roleName: 'ADMIN',
        company: 'X',
        storeId: archivedA2,
      }),
    ).rejects.toThrow('Store not found');
    expect(await countByEmail('x5@om.test')).toBe(0);
  });
});
