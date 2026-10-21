import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Category } from '../categories/entities/category.entity';
import { Product } from '../products/entities/product.entity';
import { ProductRelation } from '../products/entities/product-relation.entity';
import { Store } from '../stores/entities/store.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { ProductTranslation } from '../localization/entities/product-translation.entity';
import { CategoryTranslation } from '../localization/entities/category-translation.entity';
import { PublicCatalogueService } from './public-catalogue.service';
import { PublicCatalogueController } from './public-catalogue.controller';
import { CatalogueLiveController } from './catalogue-live.controller';
import { ApiKeysModule } from '../api-keys/api-keys.module';
import { SalesModule } from '../sales/sales.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { CatalogueChannel } from '../catalogue-navigation/entities/catalogue-channel.entity';
import { StoreCategoryPublication } from '../catalogue-navigation/entities/store-category-publication.entity';
import { CatalogueGroup } from '../catalogue-navigation/entities/catalogue-group.entity';
import { CatalogueGroupCategory } from '../catalogue-navigation/entities/catalogue-group-category.entity';

@Module({
  // AuthModule + UsersModule back JwtAuthGuard on the authenticated
  // /catalogue/live-counts route (#175); the ApiKeyGuard path is unchanged.
  imports: [
    // related-product strips; both are read-only here.
    // Organization supplies the canonical content locale and the two
    // translation tables the localized reads resolve from (P5-W2); all
    // three are read-only here.
    MikroOrmModule.forFeature([
      Category,
      Product,
      Store,
      ProductRelation,
      Organization,
      ProductTranslation,
      CategoryTranslation,
      CatalogueChannel,
      StoreCategoryPublication,
      CatalogueGroup,
      CatalogueGroupCategory,
    ]),
    ApiKeysModule,
    SalesModule,
    AuthModule,
    UsersModule,
  ],
  controllers: [PublicCatalogueController, CatalogueLiveController],
  providers: [PublicCatalogueService],
})
export class PublicCatalogueModule {}
