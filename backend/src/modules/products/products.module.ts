import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Product } from './entities/product.entity';
import { Category } from '../categories/entities/category.entity';
import { ProductsService } from './catalogue/products.service';
import { ProductFamilyService } from './families/product-family.service';
import { FamilyLearningService } from './families/family-learning.service';
import { FamilyVocabulary } from './entities/family-vocabulary.entity';
import { DismissedSuggestion } from './entities/dismissed-suggestion.entity';
import { ProductsController } from './catalogue/products.controller';
import { ProductFieldDefinition } from './entities/product-field-definition.entity';
import { StoreFieldSetting } from './entities/store-field-setting.entity';
import { ProductFieldValue } from './entities/product-field-value.entity';
import { ProductRelation } from './entities/product-relation.entity';
import { ProductRelationsService } from './relations/product-relations.service';
import { ProductRelationsController } from './relations/product-relations.controller';
import { ProductFieldsService } from './fields/product-fields.service';
import { CuratedFieldRegistryService } from './fields/curated-field-registry.service';
import { PublicationGuardService } from './publication/publication-guard.service';
import {
  ProductFieldValuesController,
  ProductFieldsController,
  StoreFieldSettingsController,
} from './fields/product-fields.controller';
import { CategoriesModule } from '../categories/categories.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { InventoryModule } from '../inventory/inventory.module';
// Side-effect import: registering `products` as removable is what activates the
// recovery registry, the query-surface census and the boot-time metadata guard.

@Module({
  imports: [
    InventoryModule,
    MikroOrmModule.forFeature([
      Product,
      Category,
      FamilyVocabulary,
      DismissedSuggestion,
      ProductFieldDefinition,
      StoreFieldSetting,
      ProductFieldValue,
      ProductRelation,
    ]),
    CategoriesModule,
    AuthModule,
    UsersModule,
    AuditLogModule,
  ],
  providers: [
    ProductsService,
    ProductFamilyService,
    FamilyLearningService,
    ProductFieldsService,
    CuratedFieldRegistryService,
    PublicationGuardService,
    ProductRelationsService,
  ],
  controllers: [
    ProductsController,
    ProductFieldsController,
    StoreFieldSettingsController,
    ProductFieldValuesController,
    ProductRelationsController,
  ],
  exports: [
    ProductsService,
    // Exported for `RecoveryModule`, which binds the restore handler (#292).
    ProductFamilyService,
    FamilyLearningService,
    ProductFieldsService,
    PublicationGuardService,
  ],
})
export class ProductsModule {}
