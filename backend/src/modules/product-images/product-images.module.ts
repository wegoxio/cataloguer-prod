import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { ProductImage } from './entities/product-image.entity';
import { ProductImagesService } from './product-images.service';
import { ProductImagesController } from './product-images.controller';
import { ProductsModule } from '../products/products.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AuditLogModule } from '../audit-log/audit-log.module';

@Module({
  imports: [
    MikroOrmModule.forFeature([ProductImage]),
    StorageModule,
    ProductsModule,
    AuthModule,
    UsersModule,
    AuditLogModule,
  ],
  providers: [ProductImagesService],
  controllers: [ProductImagesController],
  exports: [ProductImagesService],
})
export class ProductImagesModule {}
