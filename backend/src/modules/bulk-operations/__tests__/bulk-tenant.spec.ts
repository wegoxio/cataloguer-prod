import { BulkOperationsService } from '../bulk-operations.service';
import { PublicationGuardService } from '../../products/publication/publication-guard.service';
import { stockDouble } from '../../../../test/inventory-stock-support';

/**
 * P0-07: a bulk batch mixing ids of two organizations only touches the
 * actor's own rows; the foreign ones fail exactly like nonexistent ids.
 */
describe('bulk operations respect the tenant boundary (P0-07)', () => {
  const ROWS: Record<string, any> = {
    'p-own': { id: 'p-own', status: 'DRAFT', archivedAt: null },
    'p-foreign': { id: 'p-foreign', status: 'DRAFT', archivedAt: null },
  };

  const productRepo: any = {
    // The org filter is IN the where — a foreign id simply finds nothing
    findOne: jest.fn(async (where: any) => {
      if (where.organization && where.id === 'p-foreign') return null;
      return ROWS[where.id] ?? null;
    }),
    getEntityManager: () => ({ flush: jest.fn() }),
  };
  const service = new BulkOperationsService(
    productRepo,
    { findOne: jest.fn() } as any,
    { archive: jest.fn().mockResolvedValue(undefined) } as any,
    { recordAuditEntry: jest.fn() } as any,
    new PublicationGuardService(),
    stockDouble() as any,
  );

  it('archives own ids and reports the foreign one as not found', async () => {
    const result = await service.bulkArchive('org-acme', ['p-own', 'p-foreign']);

    expect(result.successCount).toBe(1);
    expect(result.failedCount).toBe(1);
    expect(result.failures[0].id).toBe('p-foreign');
    // Same wording as a nonexistent id — nothing about org B is disclosed
    expect(result.failures[0].message).toMatch(/not found/i);
  });

  /**
   * P5-A2 CANONICAL FAMILY 7 — this test previously asserted the defect.
   *
   * It read "touches everything when the platform owner runs unscoped", and it
   * was true: `bulkArchive(undefined, …)` dropped the organization filter and
   * archived products by id across every company. `organizationId` is now a
   * required `string`, so that call does not compile, and the controller
   * refuses the request before the service is reached (see
   * `bulk-authority.spec.ts`). The behaviour below is what replaced it.
   */
  it('always filters by organization — every id is resolved inside ONE company', async () => {
    ROWS['p-own'].archivedAt = null;
    ROWS['p-foreign'].archivedAt = null;
    productRepo.findOne.mockClear();

    const result = await service.bulkArchive('org-acme', ['p-own', 'p-foreign']);

    expect(result.successCount).toBe(1);
    for (const [where] of productRepo.findOne.mock.calls) {
      expect(where).toHaveProperty('organization', 'org-acme');
    }
  });
});
