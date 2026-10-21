import { EntityManager } from '@mikro-orm/postgresql';
import { DisposablePg, pgTestsEnabled, withDisposablePg } from '../../../../../test/pg-harness';
import { Organization } from '../../../organizations/entities/organization.entity';
import { Store } from '../../../stores/entities/store.entity';
import { User } from '../../../users/entities/user.entity';
import { Role } from '../../../users/entities/role.entity';
import { OrganizationPlanPolicy } from '../../plans/organization-plan-policy';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

d('BUS-001 plan limits under real PostgreSQL concurrency', () => {
  jest.setTimeout(300_000);
  let pg: DisposablePg;
  let em: EntityManager;
  let role: Role;

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork();
    role = em.create(Role, { name: 'BUS001_VIEWER' } as any);
    await em.persistAndFlush(role);
  });

  afterAll(async () => {
    if (pg) await pg.close();
  });

  const organization = async (slug: string) => {
    const org = em.create(Organization, { name: slug, slug, plan: 'BASICO' } as any);
    await em.persistAndFlush(org);
    return org;
  };

  it('two concurrent website creates competing for one Basic slot produce exactly one store', async () => {
    const org = await organization('bus-websites');
    const attempt = (suffix: string) =>
      pg.orm.em.fork().transactional(async (tem) => {
        const current = await OrganizationPlanPolicy.requireOrganization(tem as EntityManager, org.id);
        await OrganizationPlanPolicy.lock(tem as EntityManager, org.id);
        await OrganizationPlanPolicy.assertWebsiteSlot(tem as EntityManager, current);
        const store = tem.create(Store, { name: suffix, slug: `bus-${suffix}`, organization: current } as any);
        await tem.persistAndFlush(store);
      });

    const results = await Promise.allSettled([attempt('one'), attempt('two')]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await em.fork().count(Store, { organization: org.id, archivedAt: null })).toBe(1);
  });

  it('two concurrent reactivations competing for the final Basic seat activate exactly one user', async () => {
    const org = await organization('bus-users');
    const store = em.create(Store, { name: 'Users', slug: 'bus-users-store', organization: org } as any);
    const users = Array.from({ length: 4 }, (_, index) =>
      em.create(User, {
        email: `bus-${index}@example.test`,
        passwordHash: null,
        role,
        organization: org,
        store,
        company: 'BUS',
        deletedAt: index >= 2 ? new Date() : undefined,
      } as any),
    );
    await em.persistAndFlush([store, ...users]);

    const reactivate = (id: string) =>
      pg.orm.em.fork().transactional(async (tem) => {
        const current = await OrganizationPlanPolicy.requireOrganization(tem as EntityManager, org.id);
        await OrganizationPlanPolicy.lock(tem as EntityManager, org.id);
        await OrganizationPlanPolicy.assertTeamUserSlot(tem as EntityManager, current);
        const user = await tem.findOneOrFail(User, { id });
        user.deletedAt = undefined;
        await tem.flush();
      });

    const results = await Promise.allSettled([reactivate(users[2].id), reactivate(users[3].id)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(await em.fork().count(User, { organization: org.id, deletedAt: null })).toBe(3);
  });
});
