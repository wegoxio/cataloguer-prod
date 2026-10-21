import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Store } from '../stores/entities/store.entity';
import { TenantScopeService } from './tenancy/tenant-scope.service';
import { UsersModule } from '../users/users.module';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { RefreshToken } from './entities/refresh-token.entity';
import { PasswordResetToken } from './entities/password-reset-token.entity';
import { MailModule } from '../mail/mail.module';

@Module({
  imports: [
    MikroOrmModule.forFeature([RefreshToken, PasswordResetToken, Store]),
    MailModule,
    UsersModule,
    JwtModule.register({}),
  ],
  providers: [AuthService, TenantScopeService],
  controllers: [AuthController],
  exports: [TenantScopeService, AuthService, JwtModule],
})
export class AuthModule {}
