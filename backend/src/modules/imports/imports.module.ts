import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Category } from '../categories/entities/category.entity';
import { Product } from '../products/entities/product.entity';
import { ProductImage } from '../product-images/entities/product-image.entity';
import { ImportsController } from './imports.controller';
import { GenericImportService } from './preview/generic-import.service';
import { FamilyLearningService } from '../products/families/family-learning.service';
import { PublicationGuardService } from '../products/publication/publication-guard.service';
import { ProductFieldsService } from '../products/fields/product-fields.service';
import { ProductFieldDefinition } from '../products/entities/product-field-definition.entity';
import { FamilyVocabulary } from '../products/entities/family-vocabulary.entity';
import { DismissedSuggestion } from '../products/entities/dismissed-suggestion.entity';
import { Store } from '../stores/entities/store.entity';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { ImportUploadSecurityModule } from './upload-security/import-upload-security.module';
import { StorageModule } from '../storage/storage.module';
import { InventoryModule } from '../inventory/inventory.module';
import { ImportWizardController } from './wizard/wizard.controller';
import { MappingTemplateService } from './templates/mapping-template.service';
import { ImportMappingTemplate } from './entities/import-mapping-template.entity';
import { ImportedHistoricalSale } from './entities/imported-historical-sale.entity';
import { HistoricalSalesApplier } from './appliers/historical-sales.applier';
import { ProductsApplier } from './appliers/products.applier';
import { CategoriesApplier } from './appliers/categories.applier';
import { InventoryProposalApplier } from './appliers/inventory-proposal.applier';
import { ImportLifecycleController } from './lifecycle/lifecycle.controller';
import { ImportLifecycleService } from './lifecycle/import-lifecycle.service';
import { ImportSourceStorageService } from './storage/import-source-storage.service';
import { ImportApprovalService } from './plan/import-approval.service';
import { OrmExecutionStore } from './execution/orm-execution-store';
import { ImportLeaseService } from './worker/import-lease.service';
import { ImportRunnerService } from './runner/import-runner.service';
import { ProductRelationshipsApplier } from './runner/product-relationships.applier';

@Module({
  imports: [
    InventoryModule,
    MikroOrmModule.forFeature([
      Category,
      Product,
      ProductImage,
      Store,
      AuditLog,
      FamilyVocabulary,
      DismissedSuggestion,
      ProductFieldDefinition,
      ImportMappingTemplate,
      ImportedHistoricalSale,
    ]),
    AuthModule,
    UsersModule,
    ImportUploadSecurityModule,
    StorageModule,
  ],
  controllers: [ImportsController, ImportWizardController, ImportLifecycleController],
  providers: [
    GenericImportService,
    FamilyLearningService,
    AuditLogService,
    PublicationGuardService,
    ProductFieldsService,
    MappingTemplateService,
    OrmExecutionStore,
    HistoricalSalesApplier,
    ProductsApplier,
    CategoriesApplier,
    InventoryProposalApplier,
    ImportLifecycleService,
    ImportSourceStorageService,
    ImportApprovalService,
    ImportLeaseService,
    ImportRunnerService,
    ProductRelationshipsApplier,
  ],
  // Exported so a job entrypoint can resolve the runner from the application
  // context and call `drainOnce()`. Nothing in the serving path drains queues.
  exports: [ImportRunnerService],
})
export class ImportsModule {}
