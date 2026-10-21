import { TenantBackfillService } from '../../tenancy/tenant-backfill.service';

describe('TenantBackfillService', () => {
  /** Answers each count query in the order the service issues them. */
  const buildWith = (answers: Record<string, number>) => {
    // Longest key first: 'from stores' would otherwise also swallow
    // 'from stores where organization_id is null'
    const keys = Object.keys(answers).sort((a, b) => b.length - a.length);
    const execute = jest.fn().mockImplementation((sql: string) => {
      const match = keys.find((k) => sql.includes(k));
      return Promise.resolve([{ n: match ? answers[match] : 0 }]);
    });
    const repo: any = {
      getEntityManager: () => ({ getConnection: () => ({ execute }) }),
    };
    return new TenantBackfillService(repo);
  };

  it('reports clean when every store has an organization and nothing is ambiguous', async () => {
    const report = await buildWith({
      'from stores where organization_id is null': 0,
      'from organizations': 3,
    }).report();

    expect(report.storesWithoutOrganization).toBe(0);
    expect(report.conflicts).toEqual([]);
    expect(report.clean).toBe(true);
  });

  it('is not clean while a store still has no organization', async () => {
    const report = await buildWith({ 'organization_id is null': 2 }).report();

    expect(report.storesWithoutOrganization).toBe(2);
    expect(report.clean).toBe(false);
  });

  it('flags a product owned by two organizations rather than picking one', async () => {
    const report = await buildWith({ 'count(distinct s.organization_id) > 1': 4 }).report();

    const conflict = report.conflicts.find((c) => c.kind === 'product-spans-organizations');
    expect(conflict?.count).toBe(4);
    expect(report.clean).toBe(false);
  });

  it('flags tenant users with no store, and does not count a real SUPER_ADMIN', async () => {
    // The query itself excludes SUPER_ADMIN; a non-zero result means real orphans
    const report = await buildWith({ "<> 'SUPER_ADMIN'": 1 }).report();

    expect(report.conflicts.find((c) => c.kind === 'tenant-user-without-store')?.count).toBe(1);
  });

  it('flags products that belong to no store at all', async () => {
    const report = await buildWith({ 'not exists (select 1 from store_products': 7 }).report();

    expect(report.conflicts.find((c) => c.kind === 'product-without-store')?.count).toBe(7);
  });
});
