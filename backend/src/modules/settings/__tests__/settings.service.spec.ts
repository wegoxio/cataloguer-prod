import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@mikro-orm/nestjs';
import { SettingsService } from '../settings.service';
import { Settings } from '../entities/settings.entity';
import { AuditLogService } from '../../audit-log/audit-log.service';

describe('SettingsService', () => {
  let service: SettingsService;
  let mockRepo: any;
  let mockAuditService: any;

  beforeEach(async () => {
    mockRepo = {
      findOne: jest.fn(),
      create: jest.fn().mockImplementation((dto) => dto),
      getEntityManager: jest.fn().mockReturnValue({
        persistAndFlush: jest.fn(),
        flush: jest.fn(),
      }),
    };

    mockAuditService = {
      recordAuditEntry: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettingsService,
        {
          provide: getRepositoryToken(Settings),
          useValue: mockRepo,
        },
        {
          provide: AuditLogService,
          useValue: mockAuditService,
        },
      ],
    }).compile();

    service = module.get<SettingsService>(SettingsService);
  });

  describe('getSettings', () => {
    it('should create default singleton row when settings table is empty', async () => {
      mockRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.getSettings();

      expect(mockRepo.findOne).toHaveBeenCalledWith({ singletonKey: 'global' });
      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          singletonKey: 'global',
          currency: 'USD',
          timezone: 'UTC',
        }),
      );
      expect(result.singletonKey).toBe('global');
    });

    it('should return existing singleton row when found', async () => {
      const existing = { singletonKey: 'global', currency: 'EUR', timezone: 'CET' };
      mockRepo.findOne.mockResolvedValueOnce(existing);

      const result = await service.getSettings();

      expect(mockRepo.findOne).toHaveBeenCalledWith({ singletonKey: 'global' });
      expect(mockRepo.create).not.toHaveBeenCalled();
      expect(result).toBe(existing);
    });

    it('should catch unique constraint violation and return existing row during concurrent creation', async () => {
      const existing = { singletonKey: 'global', currency: 'EUR', timezone: 'CET' };
      mockRepo.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(existing);

      const uniqueViolationError = new Error('Unique constraint violation');
      (uniqueViolationError as any).code = '23505';

      mockRepo.getEntityManager().persistAndFlush.mockRejectedValueOnce(uniqueViolationError);
      mockRepo.getEntityManager().clear = jest.fn();

      const result = await service.getSettings();

      expect(mockRepo.findOne).toHaveBeenCalledTimes(2);
      expect(mockRepo.getEntityManager().clear).toHaveBeenCalled();
      expect(result).toBe(existing);
    });
  });

  describe('updateSettings', () => {
    it('should update only provided fields and preserve unspecified ones', async () => {
      const existing = {
        singletonKey: 'global',
        companyName: 'Wegox',
        companyEmail: 'admin@wegox.com',
        companyPhone: '123',
        companyAddress: 'Main St',
        currency: 'USD',
        timezone: 'UTC',
      } as any;
      mockRepo.findOne.mockResolvedValueOnce(existing);

      const dto = {
        companyName: 'New Wegox',
        currency: 'EUR',
      };

      const actor = { id: 'user-uuid', email: 'admin@example.com' };

      const result = await service.updateSettings(dto, actor);

      expect(result.companyName).toBe('New Wegox');
      expect(result.currency).toBe('EUR');
      expect(result.companyEmail).toBe('admin@wegox.com');
      expect(result.companyPhone).toBe('123');
      expect(result.companyAddress).toBe('Main St');
      expect(result.timezone).toBe('UTC');

      expect(mockAuditService.recordAuditEntry).toHaveBeenCalled();
    });

    it('should trim all string fields before saving', async () => {
      const existing = {
        singletonKey: 'global',
        companyName: 'Wegox',
        companyEmail: 'admin@wegox.com',
        companyPhone: '123',
        companyAddress: 'Main St',
        currency: 'USD',
        timezone: 'UTC',
      } as any;
      mockRepo.findOne.mockResolvedValueOnce(existing);

      const dto = {
        companyName: '  New Wegox   ',
        companyEmail: '  admin@wegox.com  ',
        companyPhone: '   123456   ',
        companyAddress: '   123 Main St   ',
        currency: '   EUR   ',
        timezone: '   Europe/Paris   ',
      };

      const result = await service.updateSettings(dto);

      expect(result.companyName).toBe('New Wegox');
      expect(result.companyEmail).toBe('admin@wegox.com');
      expect(result.companyPhone).toBe('123456');
      expect(result.companyAddress).toBe('123 Main St');
      expect(result.currency).toBe('EUR');
      expect(result.timezone).toBe('Europe/Paris');
    });

    it('should update nothing, avoid flush, create no audit entry, and preserve updatedAt when values are identical', async () => {
      const updatedAtDate = new Date(2026, 1, 1);
      const existing = {
        singletonKey: 'global',
        companyName: 'Wegox',
        companyEmail: 'admin@wegox.com',
        companyPhone: '123',
        companyAddress: 'Main St',
        currency: 'USD',
        timezone: 'UTC',
        updatedAt: updatedAtDate,
      } as any;
      mockRepo.findOne.mockResolvedValueOnce(existing);

      const dto = {
        companyName: 'Wegox',
        companyEmail: 'admin@wegox.com',
        companyPhone: '123',
        companyAddress: 'Main St',
        currency: 'USD',
        timezone: 'UTC',
      };

      const actor = { id: 'user-uuid', email: 'admin@example.com' };

      const result = await service.updateSettings(dto, actor);

      expect(mockRepo.getEntityManager().flush).not.toHaveBeenCalled();
      expect(mockAuditService.recordAuditEntry).not.toHaveBeenCalled();
      expect(result.updatedAt).toBe(updatedAtDate);
    });

    it('should succeed even if audit logging fails (try/catch safety)', async () => {
      const existing = {
        singletonKey: 'global',
        companyName: 'Wegox',
        currency: 'USD',
        timezone: 'UTC',
      } as any;
      mockRepo.findOne.mockResolvedValueOnce(existing);
      mockAuditService.recordAuditEntry.mockRejectedValueOnce(new Error('Audit DB Offline'));

      const dto = {
        companyName: 'New Wegox',
      };
      const actor = { id: 'user-uuid', email: 'admin@example.com' };

      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

      const result = await service.updateSettings(dto, actor);

      expect(result.companyName).toBe('New Wegox');
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
