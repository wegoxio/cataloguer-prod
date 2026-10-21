import { Controller, Get, Patch, Body, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { SettingsService } from './settings.service';
import { CreateUpdateSettingsDto } from './dto/create-update-settings.dto';

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('settings')
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  // Read by every dashboard: the platform-owner announcement, if any
  @Roles('SUPER_ADMIN', 'ADMIN', 'EDITOR', 'VIEWER')
  @Get('announcement')
  async announcement() {
    const settings = await this.settingsService.getSettings();
    return {
      data: {
        title: settings.announcementTitle ?? null,
        body: settings.announcementBody ?? null,
        url: settings.announcementUrl ?? null,
      },
    };
  }

  @Roles('SUPER_ADMIN', 'ADMIN')
  @Get()
  async getSettings() {
    const settings = await this.settingsService.getSettings();
    return { data: settings };
  }

  // P0-09: these are PLATFORM settings (the announcement every tenant sees).
  // A client admin editing them would broadcast to every other client, so
  // writing is platform-only. Tenants keep read access for display.
  @Roles('SUPER_ADMIN')
  @Patch()
  async updateSettings(@Req() req: any, @Body() dto: CreateUpdateSettingsDto) {
    const settings = await this.settingsService.updateSettings(dto, req.user);
    return { data: settings };
  }
}
