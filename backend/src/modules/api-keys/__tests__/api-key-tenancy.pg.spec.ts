import { EntityManager } from '@mikro-orm/postgresql';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../test/pg-harness';
import { ApiKeysService } from '../api-keys.service';
import { ApiKeysController } from '../api-keys.controller';
import { ApiKey } from '../entities/api-key.entity';
import { Store } from '../../stores/entities/store.entity';
import { Organization } from '../../organizations/entities/organization.entity';
import { TenantScope } from '../../auth/tenancy/tenant-scope';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * P5-A2 family 3 against real PostgreSQL: API keys are STORE CREDENTIALS, so
 * with two client organizations in one database an actor of one company can
 * neither list, create nor revoke the other's keys — and credentials are never
 * listed globally, not even for the platform owner.
 */
d('P5-A2 family 3 API key tenancy (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let service: ApiKeysService;
  let controller: ApiKeysController;

  let ORG_A: string;
  let ORG_B: string;
  let STORE_A1: string;
  let STORE_A2: string;
  let STORE_B1: string;

  let managerA: TenantScope;
  let narrowedA: TenantScope;
  let managerB: TenantScope;
  const platform: TenantScope = {
    platform: true,
    role: 'SUPER_ADMIN',
    organizationId: null,
    storeId: null,
    allowedStoreIds: [],
  };

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork();
    service = new ApiKeysService(em.getRepository(ApiKey) as any);
    controller = new ApiKeysController(service, em as any);

    const organizationA = em.create(Organization, { name: 'Alpha', slug: 'alpha-keys' } as any);
    const organizationB = em.create(Organization, { name: 'Beta', slug: 'beta-keys' } as any);
    await em.persistAndFlush([organizationA, organizationB]);
    ORG_A = organizationA.id;
    ORG_B = organizationB.id;

    const mk = (name: string, slug: string, organization: Organization) =>
      em.create(Store, { name, slug, organization, createdAt: new Date(), updatedAt: new Date() } as any);
    const a1 = mk('Alpha Centro', 'alpha-centro-keys', organizationA);
    const a2 = mk('Alpha Norte', 'alpha-norte-keys', organizationA);
    const b1 = mk('Beta Única', 'beta-unica-keys', organizationB);
    await em.persistAndFlush([a1, a2, b1]);
    STORE_A1 = a1.id;
    STORE_A2 = a2.id;
    STORE_B1 = b1.id;

    managerA = {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId: ORG_A,
      storeId: null,
      allowedStoreIds: [STORE_A1, STORE_A2],
    };
    narrowedA = { ...managerA, storeId: STORE_A1 };
    managerB = {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId: ORG_B,
      storeId: null,
      allowedStoreIds: [STORE_B1],
    };

    // One key per store, created through the real service
    await service.create('alpha centro key', STORE_A1);
    await service.create('alpha norte key', STORE_A2);
    await service.create('beta key', STORE_B1);
  });

  afterAll(async () => {
    await pg.close();
  });

  it('lists only the acting organization’s keys', async () => {
    const alpha = await service.findAll(ORG_A);
    expect(alpha.map((k) => k.name).sort()).toEqual(['alpha centro key', 'alpha norte key']);

    const beta = await service.findAll(ORG_B);
    expect(beta.map((k) => k.name)).toEqual(['beta key']);
  });

  it('never lists credentials globally — an organization is required', async () => {
    await expect(service.findAll(null)).rejects.toThrow(ForbiddenException);
    await expect(controller.findAll({ scope: platform })).rejects.toThrow(ForbiddenException);
  });

  it('narrows the listing to one branch when the caller asks for it', async () => {
    const narrowed = await service.findAll(ORG_A, STORE_A1);
    expect(narrowed.map((k) => k.name)).toEqual(['alpha centro key']);
  });

  it('refuses to create a key in another organization’s store, writing nothing', async () => {
    const before = await em.fork().count(ApiKey, {});
    await expect(
      controller.create({ scope: managerA, user: { id: 'u1' } }, { name: 'x', storeId: STORE_B1 } as any),
    ).rejects.toThrow(NotFoundException);
    expect(await em.fork().count(ApiKey, {})).toBe(before);
  });

  it('binds a narrowed manager to its selected branch on create', async () => {
    const before = await em.fork().count(ApiKey, {});
    await expect(
      controller.create({ scope: narrowedA, user: { id: 'u1' } }, { name: 'x', storeId: STORE_A2 } as any),
    ).rejects.toThrow(NotFoundException);
    expect(await em.fork().count(ApiKey, {})).toBe(before);
  });

  it('refuses to revoke another organization’s key, leaving it live', async () => {
    const betaKey = await em.fork().findOne(ApiKey, { name: 'beta key' });
    await expect(controller.revoke({ scope: managerA }, betaKey!.id)).rejects.toThrow(NotFoundException);
    const untouched = await em.fork().findOne(ApiKey, { id: betaKey!.id });
    expect(untouched?.revokedAt ?? null).toBeNull();
  });

  it('lets a manager revoke a key of its own organization', async () => {
    const ownKey = await em.fork().findOne(ApiKey, { name: 'alpha norte key' });
    await controller.revoke({ scope: managerA }, ownKey!.id);
    const revoked = await em.fork().findOne(ApiKey, { id: ownKey!.id });
    expect(revoked?.revokedAt).toBeTruthy();

    // …and the other tenant is entirely unaffected
    const betaKey = await em.fork().findOne(ApiKey, { name: 'beta key' });
    expect(betaKey?.revokedAt ?? null).toBeNull();
  });

  it('keeps organization B’s view unchanged throughout', async () => {
    const beta = await service.findAll(ORG_B);
    expect(beta).toHaveLength(1);
    expect(beta[0].revokedAt).toBeNull();
    await expect(controller.findAll({ scope: managerB })).resolves.toBeDefined();
  });
});
