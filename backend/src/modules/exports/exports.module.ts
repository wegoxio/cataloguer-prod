import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Category } from '../categories/entities/category.entity';
import { Product } from '../products/entities/product.entity';
import { ExportsController } from './exports.controller';
import { ExportsService } from './exports.service';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [MikroOrmModule.forFeature([Category, Product]), AuthModule, UsersModule],
  controllers: [ExportsController],
  providers: [ExportsService],
})
export class ExportsModule {}
