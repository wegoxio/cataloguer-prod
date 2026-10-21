import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { Settings } from './entities/settings.entity';
import { CreateUpdateSettingsDto } from './dto/create-update-settings.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EntityType, Action } from '../audit-log/entities/audit-log.entity';

@Injectable()
export class SettingsService {
  constructor(
    @InjectRepository(Settings)
    private readonly settingsRepository: EntityRepository<Settings>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async getSettings(): Promise<Settings> {
    let settings = await this.settingsRepository.findOne({ singletonKey: 'global' });
    if (!settings) {
      try {
        settings = this.settingsRepository.create({
          singletonKey: 'global',
          currency: 'USD',
          timezone: 'UTC',
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        await this.settingsRepository.getEntityManager().persistAndFlush(settings);
      } catch (err: any) {
        const isUniqueViolation =
          err.code === '23505' ||
          err.driverError?.code === '23505' ||
          err.name === 'UniqueConstraintViolationException' ||
          String(err).toLowerCase().includes('unique') ||
          String(err.message).toLowerCase().includes('unique') ||
          String(err).toLowerCase().includes('duplicate') ||
          String(err.message).toLowerCase().includes('duplicate');

        if (isUniqueViolation) {
          this.settingsRepository.getEntityManager().clear();
          const existing = await this.settingsRepository.findOne({ singletonKey: 'global' });
          if (existing) {
            return existing;
          }
        }
        throw err;
      }
    }
    return settings;
  }

  async updateSettings(dto: CreateUpdateSettingsDto, actor?: { id: string; email: string }): Promise<Settings> {
    const settings = await this.getSettings();

    const before = {
      companyName: settings.companyName ?? null,
      companyEmail: settings.companyEmail ?? null,
      companyPhone: settings.companyPhone ?? null,
      companyAddress: settings.companyAddress ?? null,
      currency: settings.currency,
      timezone: settings.timezone,
    };

    let hasChanges = false;

    if (dto.companyName !== undefined) {
      const targetValue = dto.companyName !== null ? dto.companyName.trim() : undefined;
      if (targetValue !== (settings.companyName ?? undefined)) {
        settings.companyName = targetValue;
        hasChanges = true;
      }
    }
    if (dto.companyEmail !== undefined) {
      const targetValue = dto.companyEmail !== null ? dto.companyEmail.trim() : undefined;
      if (targetValue !== (settings.companyEmail ?? undefined)) {
        settings.companyEmail = targetValue;
        hasChanges = true;
      }
    }
    if (dto.companyPhone !== undefined) {
      const targetValue = dto.companyPhone !== null ? dto.companyPhone.trim() : undefined;
      if (targetValue !== (settings.companyPhone ?? undefined)) {
        settings.companyPhone = targetValue;
        hasChanges = true;
      }
    }
    if (dto.companyAddress !== undefined) {
      const targetValue = dto.companyAddress !== null ? dto.companyAddress.trim() : undefined;
      if (targetValue !== (settings.companyAddress ?? undefined)) {
        settings.companyAddress = targetValue;
        hasChanges = true;
      }
    }
    if (dto.currency !== undefined) {
      const targetValue = dto.currency !== null ? dto.currency.trim() : 'USD';
      if (targetValue !== settings.currency) {
        settings.currency = targetValue;
        hasChanges = true;
      }
    }
    if (dto.timezone !== undefined) {
      const targetValue = dto.timezone !== null ? dto.timezone.trim() : 'UTC';
      if (targetValue !== settings.timezone) {
        settings.timezone = targetValue;
        hasChanges = true;
      }
    }
    // Announcement fields: plain overwrite, empty string clears
    if (dto.announcementTitle !== undefined) {
      const targetValue = dto.announcementTitle?.trim() || undefined;
      if (targetValue !== (settings.announcementTitle ?? undefined)) {
        settings.announcementTitle = targetValue;
        hasChanges = true;
      }
    }
    if (dto.announcementBody !== undefined) {
      const targetValue = dto.announcementBody?.trim() || undefined;
      if (targetValue !== (settings.announcementBody ?? undefined)) {
        settings.announcementBody = targetValue;
        hasChanges = true;
      }
    }
    if (dto.announcementUrl !== undefined) {
      const targetValue = dto.announcementUrl?.trim() || undefined;
      if (targetValue !== (settings.announcementUrl ?? undefined)) {
        settings.announcementUrl = targetValue;
        hasChanges = true;
      }
    }

    if (hasChanges) {
      await this.settingsRepository.getEntityManager().flush();

      if (actor) {
        const changes: Record<string, any> = {};
        const afterCompanyName = settings.companyName ?? null;
        if (before.companyName !== afterCompanyName) {
          changes.companyName = { before: before.companyName, after: afterCompanyName };
        }
        const afterCompanyEmail = settings.companyEmail ?? null;
        if (before.companyEmail !== afterCompanyEmail) {
          changes.companyEmail = { before: before.companyEmail, after: afterCompanyEmail };
        }
        const afterCompanyPhone = settings.companyPhone ?? null;
        if (before.companyPhone !== afterCompanyPhone) {
          changes.companyPhone = { before: before.companyPhone, after: afterCompanyPhone };
        }
        const afterCompanyAddress = settings.companyAddress ?? null;
        if (before.companyAddress !== afterCompanyAddress) {
          changes.companyAddress = { before: before.companyAddress, after: afterCompanyAddress };
        }
        if (before.currency !== settings.currency) {
          changes.currency = { before: before.currency, after: settings.currency };
        }
        if (before.timezone !== settings.timezone) {
          changes.timezone = { before: before.timezone, after: settings.timezone };
        }

        if (Object.keys(changes).length > 0) {
          try {
            await this.auditLogService.recordAuditEntry(
              actor.id,
              actor.email,
              EntityType.SETTINGS,
              settings.id,
              Action.UPDATE,
              changes,
              'Updated global settings',
              // Genuinely platform-level: global settings belong to no tenant
              { organizationId: null },
            );
          } catch (err) {
            console.error('Audit log save failed for Settings update, ignoring to prevent rollback:', err);
          }
        }
      }
    }

    return settings;
  }
}
