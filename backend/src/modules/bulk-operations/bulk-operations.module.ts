import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Product } from '../products/entities/product.entity';
import { StoreProduct } from '../products/entities/store-product.entity';
import { Store } from '../stores/entities/store.entity';
import { Category } from '../categories/entities/category.entity';
import { BulkOperationsController } from './bulk-operations.controller';
import { BulkOperationsService } from './bulk-operations.service';
import { ProductsModule } from '../products/products.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { InventoryModule } from '../inventory/inventory.module';

@Module({
  imports: [
    InventoryModule,
    MikroOrmModule.forFeature([Product, Category, Store, StoreProduct]),
    ProductsModule,
    AuthModule,
    UsersModule,
    AuditLogModule,
  ],
  controllers: [BulkOperationsController],
  providers: [BulkOperationsService],
})
export class BulkOperationsModule {}
