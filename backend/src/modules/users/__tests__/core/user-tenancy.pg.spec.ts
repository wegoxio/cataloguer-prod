import { EntityManager } from '@mikro-orm/postgresql';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { UsersService } from '../../users.service';
import { User } from '../../entities/user.entity';
import { Role } from '../../entities/role.entity';
import { PasswordResetToken } from '../../../auth/entities/password-reset-token.entity';
import { Store } from '../../../stores/entities/store.entity';
import { Organization } from '../../../organizations/entities/organization.entity';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * P5-A2 family 6 against real PostgreSQL.
 *
 * Two companies share one database. The staffing surface used to decide tenancy
 * from `actor.store` — which walls nothing for a store-less actor — so this
 * suite proves, against the DATABASE, that no staffing path reaches a foreign
 * organization and that a refused operation writes nothing at all.
 */
d('P5-A2 family 6 staffing tenancy (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let service: UsersService;

  let ORG_A: string;
  let STORE_A1: string;
  let STORE_A2: string;
  let STORE_B1: string;
  let managerA: User;
  let foreignUserId: string;
  let ownUserId: string;

  let scopeA: TenantScope;
  let narrowedA: TenantScope;
  const platform: TenantScope = {
    platform: true,
    role: 'SUPER_ADMIN',
    organizationId: null,
    storeId: null,
    allowedStoreIds: [],
  };

  const countUsers = async (where: any = {}) => em.fork().count(User, where);

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork();
    service = new UsersService(
      em.getRepository(User) as any,
      em.getRepository(Role) as any,
      em.getRepository(PasswordResetToken) as any,
      { recordAuditEntry: async () => undefined, recordAuditEntryIn: async () => undefined as never } as any,
      { send: async () => true, renderTemplate: () => '<html>invite</html>' } as any,
      { get: () => 'http://localhost:3000' } as any,
    );

    const organizationA = em.create(Organization, { name: 'Alpha', slug: 'alpha-staffing' } as any);
    const organizationB = em.create(Organization, { name: 'Beta', slug: 'beta-staffing' } as any);
    await em.persistAndFlush([organizationA, organizationB]);
    ORG_A = organizationA.id;

    const mk = (name: string, slug: string, organization: Organization) =>
      em.create(Store, { name, slug, organization, createdAt: new Date(), updatedAt: new Date() } as any);
    const a1 = mk('Alpha Centro', 'alpha-centro-staffing', organizationA);
    const a2 = mk('Alpha Norte', 'alpha-norte-staffing', organizationA);
    const b1 = mk('Beta Única', 'beta-unica-staffing', organizationB);
    await em.persistAndFlush([a1, a2, b1]);
    STORE_A1 = a1.id;
    STORE_A2 = a2.id;
    STORE_B1 = b1.id;

    // Roles are reference data: ensure the two this suite needs exist, exactly
    // as the sibling PG spec does, then load them as entities.
    const conn = em.getConnection();
    for (const name of ['EDITOR', 'ORGANIZATION_MANAGER', 'ADMIN', 'VIEWER']) {
      await conn.execute(
        'insert into roles (id, name) select gen_random_uuid(), ? where not exists (select 1 from roles where name = ?)',
        [name, name],
      );
    }
    const roleOf = async (name: string) => em.fork().findOne(Role, { name });
    const editorRole = await roleOf('EDITOR');
    const managerRole = await roleOf('ORGANIZATION_MANAGER');
    expect(editorRole).toBeTruthy();
    expect(managerRole).toBeTruthy();

    const manager = em.create(User, {
      email: 'om@alpha.test',
      passwordHash: 'set',
      role: managerRole,
      organization: organizationA,
      store: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    const own = em.create(User, {
      email: 'editor@alpha.test',
      passwordHash: 'set',
      role: editorRole,
      organization: organizationA,
      store: a2,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    const foreign = em.create(User, {
      email: 'editor@beta.test',
      passwordHash: 'set',
      role: editorRole,
      organization: organizationB,
      store: b1,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as any);
    await em.persistAndFlush([manager, own, foreign]);
    managerA = (await service.findById(manager.id)) as User;
    ownUserId = own.id;
    foreignUserId = foreign.id;

    scopeA = {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId: ORG_A,
      storeId: null,
      allowedStoreIds: [STORE_A1, STORE_A2],
    };
    narrowedA = { ...scopeA, storeId: STORE_A1 };
  });

  afterAll(async () => {
    await pg.close();
  });

  describe('invitations cannot reach a foreign organization', () => {
    it("refuses another company's branch, creating no user", async () => {
      const before = await countUsers();
      await expect(
        service.inviteUser(scopeA, managerA, {
          email: 'intruder@alpha.test',
          roleName: 'ADMIN',
          company: 'Alpha',
          storeId: STORE_B1,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(await countUsers()).toBe(before);
      expect(await countUsers({ email: 'intruder@alpha.test' })).toBe(0);
    });

    it('refuses the unscoped platform owner — staffing is a tenant mutation', async () => {
      const before = await countUsers();
      await expect(
        service.inviteUser(platform, managerA, {
          email: 'owner-invite@alpha.test',
          roleName: 'ADMIN',
          company: 'Alpha',
          storeId: STORE_A1,
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(await countUsers()).toBe(before);
    });

    it('binds a narrowed manager to its selected branch', async () => {
      const before = await countUsers();
      await expect(
        service.inviteUser(narrowedA, managerA, {
          email: 'sibling@alpha.test',
          roleName: 'ADMIN',
          company: 'Alpha',
          storeId: STORE_A2,
        }),
      ).rejects.toThrow(NotFoundException);
      expect(await countUsers()).toBe(before);
    });

    it('creates into an allowed branch of its own company', async () => {
      const before = await countUsers();
      const created: any = await service.inviteUser(scopeA, managerA, {
        email: 'new-admin@alpha.test',
        roleName: 'ADMIN',
        company: 'Alpha',
        storeId: STORE_A1,
      });
      expect(created.email).toBe('new-admin@alpha.test');
      expect(await countUsers()).toBe(before + 1);
    });
  });

  describe('managed-user paths cannot reach a foreign organization', () => {
    it('refuses every mutation against another company’s user, writing nothing', async () => {
      const before = await em.fork().findOne(User, { id: foreignUserId });
      await expect(service.updateRole(scopeA, managerA, foreignUserId, 'VIEWER')).rejects.toThrow(NotFoundException);
      await expect(service.deactivate(scopeA, managerA, foreignUserId)).rejects.toThrow(NotFoundException);
      await expect(service.reactivate(scopeA, managerA, foreignUserId)).rejects.toThrow(NotFoundException);
      await expect(service.resetPassword(scopeA, managerA, foreignUserId, 'a-new-password-1')).rejects.toThrow(
        NotFoundException,
      );
      await expect(service.setStore(scopeA, managerA, foreignUserId, STORE_A1)).rejects.toThrow(NotFoundException);

      const after = await em.fork().findOne(User, { id: foreignUserId });
      expect(after?.role?.id ?? null).toBe(before?.role?.id ?? null);
      expect(after?.deletedAt ?? null).toBe(before?.deletedAt ?? null);
      expect(after?.passwordHash).toBe(before?.passwordHash);
      expect((after?.store as any)?.id ?? null).toBe((before?.store as any)?.id ?? null);
    });

    it('refuses a sibling-branch user for a NARROWED manager, writing nothing', async () => {
      const before = await em.fork().findOne(User, { id: ownUserId });
      await expect(service.deactivate(narrowedA, managerA, ownUserId)).rejects.toThrow(NotFoundException);
      const after = await em.fork().findOne(User, { id: ownUserId });
      expect(after?.deletedAt ?? null).toBe(before?.deletedAt ?? null);
    });

    it('admits an un-narrowed manager on its own company', async () => {
      await expect(service.deactivate(scopeA, managerA, ownUserId)).resolves.toBeDefined();
      const after = await em.fork().findOne(User, { id: ownUserId });
      expect(after?.deletedAt).toBeTruthy();
    });
  });

  describe('store assignment', () => {
    it('refuses a destination branch outside the company, leaving the binding intact', async () => {
      const target = await em.fork().findOne(User, { email: 'new-admin@alpha.test' });
      await expect(service.setStore(scopeA, managerA, target!.id, STORE_B1)).rejects.toThrow(NotFoundException);
      const after = await em.fork().findOne(User, { id: target!.id }, { populate: ['store'] as never });
      expect((after?.store as any)?.id).toBe(STORE_A1);
    });

    it('refuses the unscoped platform owner', async () => {
      const target = await em.fork().findOne(User, { email: 'new-admin@alpha.test' });
      await expect(service.setStore(platform, managerA, target!.id, STORE_A2)).rejects.toThrow(ForbiddenException);
    });
  });

  it("organization B's users are untouched throughout", async () => {
    const foreign = await em.fork().findOne(User, { id: foreignUserId });
    expect(foreign?.deletedAt ?? null).toBeNull();
    expect(foreign?.email).toBe('editor@beta.test');
  });
});
