import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Category } from '../categories/entities/category.entity';
import { Product } from '../products/entities/product.entity';
import { ProductImage } from '../product-images/entities/product-image.entity';
import { DashboardMetricsService } from './dashboard-metrics.service';
import { DashboardMetricsController } from './dashboard-metrics.controller';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [MikroOrmModule.forFeature([Category, Product, ProductImage]), AuthModule, UsersModule],
  providers: [DashboardMetricsService],
  controllers: [DashboardMetricsController],
})
export class DashboardMetricsModule {}
