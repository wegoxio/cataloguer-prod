import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Settings } from './entities/settings.entity';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [MikroOrmModule.forFeature([Settings, AuditLog]), AuditLogModule, AuthModule, UsersModule],
  providers: [SettingsService],
  controllers: [SettingsController],
  exports: [SettingsService],
})
export class SettingsModule {}
