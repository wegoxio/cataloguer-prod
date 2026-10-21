import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { DiscountCode } from './entities/discount-code.entity';
import { DiscountsService } from './discounts.service';
import { DiscountsController } from './discounts.controller';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
// #295 G2: registers `discount` as a removable type, as a module-load side effect.

@Module({
  imports: [MikroOrmModule.forFeature([DiscountCode]), AuthModule, UsersModule, AuditLogModule],
  providers: [DiscountsService],
  controllers: [DiscountsController],
  exports: [DiscountsService],
})
export class DiscountsModule {}
