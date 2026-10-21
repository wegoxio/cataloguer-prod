import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { AuditLogService } from '../audit-log.service';
import { AuditLog, EntityType, Action } from '../entities/audit-log.entity';

describe('AuditLogService', () => {
  let service: AuditLogService;
  let mockRepo: any;

  beforeEach(async () => {
    mockRepo = {
      create: jest.fn().mockImplementation((dto) => dto),
      getEntityManager: jest.fn().mockReturnValue({
        persistAndFlush: jest.fn(),
      }),
      findAndCount: jest.fn().mockResolvedValue([[], 0]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditLogService,
        {
          provide: getRepositoryToken(AuditLog),
          useValue: mockRepo,
        },
      ],
    }).compile();

    service = module.get<AuditLogService>(AuditLogService);
  });

  describe('recordAuditEntry', () => {
    it('should create and persist a new audit entry', async () => {
      const persistAndFlushSpy = jest.fn();
      mockRepo.getEntityManager.mockReturnValue({
        persistAndFlush: persistAndFlushSpy,
      });

      await service.recordAuditEntry(
        'user-uuid',
        'admin@example.com',
        EntityType.PRODUCT,
        'product-uuid',
        Action.CREATE,
        null,
        'Created product test',
        { organizationId: 'org-uuid', storeId: 'store-uuid' },
      );

      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          actorUserId: 'user-uuid',
          actorEmail: 'admin@example.com',
          entityType: EntityType.PRODUCT,
          entityId: 'product-uuid',
          action: Action.CREATE,
          changes: null,
          message: 'Created product test',
          organizationId: 'org-uuid',
          storeId: 'store-uuid',
        }),
      );
      expect(persistAndFlushSpy).toHaveBeenCalled();
    });

    it('persists an explicit platform-level context as nulls — a statement, not a default', async () => {
      await service.recordAuditEntry(
        'user-uuid',
        'admin@example.com',
        EntityType.SETTINGS,
        'settings-uuid',
        Action.UPDATE,
        null,
        'Updated global settings',
        { organizationId: null },
      );

      expect(mockRepo.create).toHaveBeenCalledWith(expect.objectContaining({ organizationId: null, storeId: null }));
    });

    it('should catch errors and not throw if repository save fails', async () => {
      mockRepo.getEntityManager.mockReturnValue({
        persistAndFlush: jest.fn().mockRejectedValue(new Error('DB Connection Timeout')),
      });

      // To make sure console.error is clean in output, we can mock it
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      await expect(
        service.recordAuditEntry(
          'user-uuid',
          'admin@example.com',
          EntityType.PRODUCT,
          'product-uuid',
          Action.CREATE,
          null,
          null,
          { organizationId: null },
        ),
      ).resolves.not.toThrow();

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe('findAll', () => {
    it('filters a store view by the rows STORED context — exact organization AND exact store (#203)', async () => {
      mockRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll(
        {},
        { page: 1, limit: 10 },
        { kind: 'store', organizationId: 'org-a', storeId: 'store-a1' },
      );

      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        { organizationId: 'org-a', storeId: 'store-a1' },
        expect.objectContaining({ limit: 10, offset: 0 }),
      );
      // The old actor-derived filter must be gone entirely
      const where = mockRepo.findAndCount.mock.calls[0][0];
      expect(where).not.toHaveProperty('actorUserId');
    });

    it('filters an organization view by organization only — no store constraint (P5-A2 family 1)', async () => {
      mockRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll({}, { page: 1, limit: 10 }, { kind: 'organization', organizationId: 'org-a' });

      const where = mockRepo.findAndCount.mock.calls[0][0];
      expect(where).toEqual({ organizationId: 'org-a' });
      // Organization-wide means store-level AND org-level rows of THIS org:
      // no storeId key at all, so store_id IS NULL rows are included too.
      expect(where).not.toHaveProperty('storeId');
    });

    it('fail-closed: refuses a malformed view with an empty organization before any query', async () => {
      await expect(service.findAll({}, {}, { kind: 'organization', organizationId: '' } as any)).rejects.toThrow(
        'tenant view without an organization',
      );
      await expect(
        service.findAll({}, {}, { kind: 'store', organizationId: null, storeId: 'store-a1' } as any),
      ).rejects.toThrow('tenant view without an organization');
      expect(mockRepo.findAndCount).not.toHaveBeenCalled();
    });

    it('fail-closed: refuses a store view with an empty store before any query', async () => {
      await expect(
        service.findAll({}, {}, { kind: 'store', organizationId: 'org-a', storeId: '' } as any),
      ).rejects.toThrow('store view without a store');
      expect(mockRepo.findAndCount).not.toHaveBeenCalled();
    });

    it('should query logs applying filters and sorting defaults', async () => {
      mockRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll(
        {
          entityType: EntityType.PRODUCT,
          actorEmail: 'admin@example.com',
          action: Action.UPDATE,
        },
        {
          page: 1,
          limit: 10,
        },
      );

      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        {
          entityType: EntityType.PRODUCT,
          actorEmail: { $ilike: '%admin@example.com%' },
          action: Action.UPDATE,
        },
        {
          limit: 10,
          offset: 0,
          orderBy: { createdAt: 'DESC' },
        },
      );
    });

    it('should apply pagination offset and limit constraints', async () => {
      mockRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll(
        {},
        {
          page: 3,
          limit: 50,
          sortBy: 'action',
          sortDirection: 'asc',
        },
      );

      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        {},
        {
          limit: 50,
          offset: 100,
          orderBy: { action: 'ASC' },
        },
      );
    });

    it('should clamp limit parameter to maximum 100 and default page to 1', async () => {
      mockRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.findAll(
        {},
        {
          page: -5,
          limit: 500,
        },
      );

      expect(mockRepo.findAndCount).toHaveBeenCalledWith(
        {},
        {
          limit: 100,
          offset: 0,
          orderBy: { createdAt: 'DESC' },
        },
      );
    });
  });
});
