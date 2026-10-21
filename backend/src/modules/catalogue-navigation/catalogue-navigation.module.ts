import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { CatalogueChannel } from './entities/catalogue-channel.entity';
import { CatalogueGroup } from './entities/catalogue-group.entity';
import { StoreCategoryPublication } from './entities/store-category-publication.entity';
import { CatalogueGroupCategory } from './entities/catalogue-group-category.entity';
import { CatalogueNavigationService } from './catalogue-navigation.service';
import { CatalogueNavigationController } from './catalogue-navigation.controller';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [MikroOrmModule.forFeature([CatalogueChannel, CatalogueGroup, StoreCategoryPublication, CatalogueGroupCategory]), AuthModule, UsersModule],
  providers: [CatalogueNavigationService],
  controllers: [CatalogueNavigationController],
  exports: [CatalogueNavigationService],
})
export class CatalogueNavigationModule {}
