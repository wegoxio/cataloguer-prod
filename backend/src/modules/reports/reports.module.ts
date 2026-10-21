import { Module } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

@Module({
  // AuthModule + UsersModule: JwtAuthGuard resolves in the module whose
  // controller uses it (the #229 lesson — unit tests mock guards, only a
  // real boot catches a hole here)
  imports: [AuthModule, UsersModule],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
