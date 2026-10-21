import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { User } from './entities/user.entity';
import { Role } from './entities/role.entity';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { PasswordResetToken } from '../auth/entities/password-reset-token.entity';
import { TenantScopeService } from '../auth/tenancy/tenant-scope.service';
import { Store } from '../stores/entities/store.entity';
import { MailModule } from '../mail/mail.module';
// Side-effect import: registering `users` as removable is what activates the
// recovery registry, the query-surface census and the boot-time metadata guard.

@Module({
  // JwtModule, AuditLogService and TenantScopeService are provided directly
  // instead of importing AuthModule/AuditLogModule: both of those modules
  // import UsersModule, so importing them back would be circular.
  // TenantScopeService is a dependency of JwtAuthGuard, which Nest resolves
  // in the context of the module whose controller uses it.
  imports: [
    MikroOrmModule.forFeature([User, Role, RefreshToken, PasswordResetToken, AuditLog, Store]),
    JwtModule.register({}),
    MailModule,
  ],
  providers: [UsersService, AuditLogService, TenantScopeService],
  controllers: [UsersController],
  exports: [UsersService],
})
export class UsersModule {}
