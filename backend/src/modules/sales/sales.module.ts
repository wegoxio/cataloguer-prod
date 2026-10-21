import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { SalesOrder, SalesOrderItem } from './sales-order.entity';
import { Product } from '../products/entities/product.entity';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { SalesService } from './sales.service';
import { SalesController } from './sales.controller';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { DiscountsModule } from '../discounts/discounts.module';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [
    InventoryModule,
    MikroOrmModule.forFeature([SalesOrder, SalesOrderItem, Product, AuditLog]),
    AuthModule,
    UsersModule,
    DiscountsModule,
    InventoryModule,
  ],
  providers: [SalesService, AuditLogService],
  controllers: [SalesController],
  exports: [SalesService],
})
export class SalesModule {}
