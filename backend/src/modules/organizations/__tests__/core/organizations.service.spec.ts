import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrganizationsService } from '../../organizations.service';

describe('OrganizationsService', () => {
  let service: OrganizationsService;
  let orgRepo: any;
  let storeRepo: any;
  let em: any;

  beforeEach(() => {
    em = {
      persistAndFlush: jest.fn(),
      flush: jest.fn(),
      // #284: `create` now takes the plan lock and provisions the default
      // warehouse inside its transaction. The double answers those statements
      // by SHAPE — a select finds nothing, an insert returns one id — so the
      // service's own branching is what runs, not a stub of it.
      execute: jest.fn().mockImplementation(async (sql: string) => (/^\s*insert/i.test(sql) ? [{ id: 'wh-new' }] : [])),
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((_entity: unknown, data: any) => ({ id: 'org-new', ...data })),
    };
    em.transactional = jest.fn((callback: any) => callback(em));
    orgRepo = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((data: any) => ({ id: 'org-new', ...data })),
      getEntityManager: jest.fn().mockReturnValue(em),
    };
    storeRepo = { find: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) };
    service = new OrganizationsService(orgRepo, storeRepo, { recordAuditEntry: jest.fn() } as any);
  });

  describe('the tenant boundary', () => {
    it('only returns the stores of the organization asked for', async () => {
      orgRepo.findOne.mockResolvedValue({ id: 'org-a', name: 'Acme' });

      await service.findStores('org-a');

      // The org filter is what stops one client reading another's branches
      expect(storeRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ organization: 'org-a', archivedAt: null }),
        expect.any(Object),
      );
    });

    it('refuses to list stores for an organization that does not exist', async () => {
      orgRepo.findOne.mockResolvedValue(null);

      await expect(service.findStores('org-unknown')).rejects.toThrow(NotFoundException);
      expect(storeRepo.find).not.toHaveBeenCalled();
    });

    it('never widens the query when asked for archived stores too', async () => {
      orgRepo.findOne.mockResolvedValue({ id: 'org-a', name: 'Acme' });

      await service.findStores('org-a', true);

      const [where] = storeRepo.find.mock.calls[0];
      expect(where.organization).toBe('org-a');
      expect(where.archivedAt).toBeUndefined();
    });
  });

  describe('create', () => {
    it('derives a slug and defaults plan and billing status', async () => {
      const organization: any = await service.create({ name: 'Muebles del Sur' });

      expect(organization.slug).toBe('muebles-del-sur');
      expect(organization.plan).toBe('BASICO');
      expect(organization.billingStatus).toBe('ACTIVE');
    });

    it('suffixes the slug when one is already taken', async () => {
      orgRepo.findOne.mockResolvedValueOnce({ id: 'existing', slug: 'acme' }).mockResolvedValueOnce(null);

      const organization: any = await service.create({ name: 'Acme' });

      expect(organization.slug).toBe('acme-2');
    });

    it('rejects a blank name', async () => {
      await expect(service.create({ name: '   ' })).rejects.toThrow(BadRequestException);
    });
  });

  describe('archive', () => {
    // #277 P2 moved archive onto the canonical lock order with raw, locked
    // SQL and session/generation/token effects; the mock repository cannot
    // stand in for that. Its behaviour — the live-branch refusal, the
    // atomic member effects, idempotency — is proved against PostgreSQL in
    // `organization-activation.pg.spec.ts`.
    it('is proved against PostgreSQL, not a mock (see organization-activation.pg.spec.ts)', () => {
      expect(typeof service.archive).toBe('function');
    });
  });

  describe('update plan', () => {
    it('rejects a downgrade that cannot hold the current organization usage', async () => {
      em.findOne.mockResolvedValue({
        id: 'org-a',
        name: 'Acme',
        plan: 'CRECIMIENTO',
        billingStatus: 'ACTIVE',
      });
      em.count.mockResolvedValueOnce(2).mockResolvedValueOnce(4);

      await expect(service.update('org-a', { plan: 'BASICO' } as any)).rejects.toThrow(
        /archive 1 website and deactivate 1 team member/,
      );
      expect(em.flush).not.toHaveBeenCalled();
    });

    it('changes plans transactionally when current usage fits', async () => {
      const organization: any = {
        id: 'org-a',
        name: 'Acme',
        plan: 'CRECIMIENTO',
        billingStatus: 'ACTIVE',
      };
      em.findOne.mockResolvedValue(organization);

      await service.update('org-a', { plan: 'BASICO' } as any);

      expect(em.execute).toHaveBeenCalled();
      expect(em.count).toHaveBeenCalledTimes(2);
      expect(organization.plan).toBe('BASICO');
      expect(em.flush).toHaveBeenCalled();
    });
  });
});
