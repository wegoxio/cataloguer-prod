import { EntityManager } from '@mikro-orm/postgresql';
import { ForbiddenException } from '@nestjs/common';
import { pgTestsEnabled, withDisposablePg, DisposablePg } from '../../../../../test/pg-harness';
import { BillingController } from '../../billing.controller';
import { Payment } from '../../entities/payment.entity';
import { Store } from '../../../stores/entities/store.entity';
import { Organization } from '../../../organizations/entities/organization.entity';
import { TenantScope } from '../../../auth/tenancy/tenant-scope';

const gate = pgTestsEnabled();
const d = gate.enabled ? describe : describe.skip;

/**
 * P5-A2 family 3 against real PostgreSQL (D-5, closes F1).
 *
 * Payment history is ORGANIZATION-level. With two paying clients in one
 * database, the query that used to fall through to `{}` for any store-less
 * actor would have returned both tenants' rows; here it must return exactly
 * one company's, and nothing at all for the unscoped platform owner.
 */
d('P5-A2 family 3 payment tenancy (real PostgreSQL)', () => {
  jest.setTimeout(300_000);

  let pg: DisposablePg;
  let em: EntityManager;
  let controller: BillingController;

  let ORG_A: string;
  let ORG_B: string;
  let STORE_A1: string;
  let STORE_A2: string;
  let STORE_B1: string;

  let managerA: TenantScope;
  let narrowedA: TenantScope;
  let managedOwnerA: TenantScope;
  let managerB: TenantScope;
  const platform: TenantScope = {
    platform: true,
    role: 'SUPER_ADMIN',
    organizationId: null,
    storeId: null,
    allowedStoreIds: [],
  };

  const amounts = (res: any): string[] => res.data.map((p: any) => p.amountUsd).sort();

  beforeAll(async () => {
    pg = await withDisposablePg({});
    em = pg.orm.em.fork();
    controller = new BillingController(
      em.getRepository(Payment) as any,
      { recordAuditEntry: jest.fn() } as any,
      {} as any,
    );

    const organizationA = em.create(Organization, { name: 'Alpha', slug: 'alpha-pay' } as any);
    const organizationB = em.create(Organization, { name: 'Beta', slug: 'beta-pay' } as any);
    await em.persistAndFlush([organizationA, organizationB]);
    ORG_A = organizationA.id;
    ORG_B = organizationB.id;

    const mk = (name: string, slug: string, organization: Organization) =>
      em.create(Store, { name, slug, organization, createdAt: new Date(), updatedAt: new Date() } as any);
    const a1 = mk('Alpha Centro', 'alpha-centro-pay', organizationA);
    const a2 = mk('Alpha Norte', 'alpha-norte-pay', organizationA);
    const b1 = mk('Beta Única', 'beta-unica-pay', organizationB);
    await em.persistAndFlush([a1, a2, b1]);
    STORE_A1 = a1.id;
    STORE_A2 = a2.id;
    STORE_B1 = b1.id;

    const pay = (store: Store, amountUsd: string, description: string) =>
      em.create(Payment, {
        store,
        amountUsd,
        description,
        status: 'PAID',
        paidAt: new Date(),
        createdAt: new Date(),
      } as any);
    await em.persistAndFlush([
      pay(a1, '30.00', 'alpha centro'),
      pay(a2, '50.00', 'alpha norte'),
      pay(b1, '70.00', 'beta only'),
    ]);

    managerA = {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId: ORG_A,
      storeId: null,
      allowedStoreIds: [STORE_A1, STORE_A2],
    };
    narrowedA = { ...managerA, storeId: STORE_A1 };
    managedOwnerA = {
      platform: true,
      role: 'SUPER_ADMIN',
      organizationId: ORG_A,
      storeId: null,
      allowedStoreIds: [STORE_A1, STORE_A2],
    };
    managerB = {
      platform: false,
      role: 'ORGANIZATION_MANAGER',
      organizationId: ORG_B,
      storeId: null,
      allowedStoreIds: [STORE_B1],
    };
  });

  afterAll(async () => {
    await pg.close();
  });

  it('returns every payment of the acting organization and none of the other', async () => {
    const res = await controller.list({ scope: managerA });
    expect(amounts(res)).toEqual(['30.00', '50.00']);
    expect(JSON.stringify(res.data)).not.toContain('beta only');
  });

  it('is identical for a NARROWED manager — the subscription is the organization’s (D-5)', async () => {
    const wide = await controller.list({ scope: managerA });
    const narrow = await controller.list({ scope: narrowedA });
    expect(amounts(narrow)).toEqual(amounts(wide));
    expect(amounts(narrow)).toEqual(['30.00', '50.00']);
  });

  it('serves a SUPER_ADMIN inside a managed organization that same company view', async () => {
    const res = await controller.list({ scope: managedOwnerA });
    expect(amounts(res)).toEqual(['30.00', '50.00']);
  });

  it('serves the other company only its own row', async () => {
    const res = await controller.list({ scope: managerB });
    expect(amounts(res)).toEqual(['70.00']);
  });

  it('refuses the unscoped platform owner — no cross-tenant payment rows (F1)', async () => {
    await expect(controller.list({ scope: platform })).rejects.toThrow(ForbiddenException);
  });

  it('refuses a request carrying no resolved scope', async () => {
    await expect(controller.list({})).rejects.toThrow(ForbiddenException);
  });

  it('every row in the database is still present — listing mutates nothing', async () => {
    expect(await em.fork().count(Payment, {})).toBe(3);
  });
});
