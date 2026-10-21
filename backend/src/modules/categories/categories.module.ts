import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Category } from './entities/category.entity';
import { CategoriesService } from './categories.service';
import { CategoriesController } from './categories.controller';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
// Side-effect import: see products.module.ts.

@Module({
  imports: [MikroOrmModule.forFeature([Category]), AuthModule, UsersModule, AuditLogModule],
  providers: [CategoriesService],
  controllers: [CategoriesController],
  // `CategoryRemovalService` is exported for `RecoveryModule`, which binds its
  // restore handler into the registry at boot (#292).
  exports: [CategoriesService],
})
export class CategoriesModule {}
