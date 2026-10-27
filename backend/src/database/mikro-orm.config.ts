import { readFileSync } from 'node:fs';
import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { SeedManager } from '@mikro-orm/seeder';
import * as dotenv from 'dotenv';
import { User } from '../modules/users/entities/user.entity';
import { Role } from '../modules/users/entities/role.entity';
import { Category } from '../modules/categories/entities/category.entity';
import { Product } from '../modules/products/entities/product.entity';
import { ProductImage } from '../modules/product-images/entities/product-image.entity';
import { AuditLog } from '../modules/audit-log/entities/audit-log.entity';
import { Settings } from '../modules/settings/entities/settings.entity';
import { RefreshToken } from '../modules/auth/entities/refresh-token.entity';
import { ApiKey } from '../modules/api-keys/entities/api-key.entity';
import { PasswordResetToken } from '../modules/auth/entities/password-reset-token.entity';
import { Organization } from '../modules/organizations/entities/organization.entity';
import { Store } from '../modules/stores/entities/store.entity';
import { DiscountCode } from '../modules/discounts/entities/discount-code.entity';
import { Payment } from '../modules/billing/entities/payment.entity';
import { SalesOrder, SalesOrderItem } from '../modules/sales/sales-order.entity';
import { StoreProduct } from '../modules/products/entities/store-product.entity';
import { ImportSource } from '../modules/imports/entities/import-source.entity';
import { ImportAnalysis } from '../modules/imports/entities/import-analysis.entity';
import { ImportMappingTemplate } from '../modules/imports/entities/import-mapping-template.entity';
import { ImportPlan } from '../modules/imports/entities/import-plan.entity';
import { ImportApproval } from '../modules/imports/entities/import-approval.entity';
import { ImportExecution, ImportCheckpoint } from '../modules/imports/entities/import-execution.entity';
import { ImportRowResult, ImportExternalIdentity } from '../modules/imports/entities/import-row-result.entity';
import { ImportedHistoricalSale } from '../modules/imports/entities/imported-historical-sale.entity';
import { FamilyVocabulary } from '../modules/products/entities/family-vocabulary.entity';
import { DismissedSuggestion } from '../modules/products/entities/dismissed-suggestion.entity';
import { ProductFieldDefinition } from '../modules/products/entities/product-field-definition.entity';
import { StoreFieldSetting } from '../modules/products/entities/store-field-setting.entity';
import { ProductFieldValue } from '../modules/products/entities/product-field-value.entity';
import { ProductRelation } from '../modules/products/entities/product-relation.entity';
import { InventoryLocation } from '../modules/inventory/entities/inventory-location.entity';
import { InventoryTransaction } from '../modules/inventory/entities/inventory-transaction.entity';
import { InventoryTransactionIntent } from '../modules/inventory/entities/inventory-transaction-intent.entity';
import { InventoryEntry } from '../modules/inventory/entities/inventory-entry.entity';
import { InventoryBalance } from '../modules/inventory/entities/inventory-balance.entity';
import { InventoryTransitBalance } from '../modules/inventory/entities/inventory-transit-balance.entity';
import { InventoryOpeningReconciliation } from '../modules/inventory/entities/inventory-opening-reconciliation.entity';
import { InventoryOpeningReconciliationAllocation } from '../modules/inventory/entities/inventory-opening-reconciliation-allocation.entity';
import { InventoryReservation } from '../modules/inventory/entities/inventory-reservation.entity';
import { InventoryBackorder } from '../modules/inventory/entities/inventory-backorder.entity';
import { InventoryBackorderAllocation } from '../modules/inventory/entities/inventory-backorder-allocation.entity';
import { InventoryTransfer } from '../modules/inventory/entities/inventory-transfer.entity';
import { InventoryTransferLine } from '../modules/inventory/entities/inventory-transfer-line.entity';
import { ProductTranslation } from '../modules/localization/entities/product-translation.entity';
import { CategoryTranslation } from '../modules/localization/entities/category-translation.entity';
import { CatalogueChannel } from '../modules/catalogue-navigation/entities/catalogue-channel.entity';
import { CatalogueGroup } from '../modules/catalogue-navigation/entities/catalogue-group.entity';
import { StoreCategoryPublication } from '../modules/catalogue-navigation/entities/store-category-publication.entity';
import { CatalogueGroupCategory } from '../modules/catalogue-navigation/entities/catalogue-group-category.entity';
import { PlanChangeChallenge } from '../modules/organizations/entities/plan-change-challenge.entity';

// Load environment variables for CLI commands
dotenv.config();

export default defineConfig({
  entities: [
    User,
    Role,
    Category,
    Product,
    ProductImage,
    AuditLog,
    Settings,
    RefreshToken,
    ApiKey,
    Organization,
    Store,
    DiscountCode,
    Payment,
    SalesOrder,
    SalesOrderItem,
    StoreProduct,
    PasswordResetToken,
    ImportSource,
    ImportAnalysis,
    ImportMappingTemplate,
    ImportPlan,
    ImportApproval,
    ImportExecution,
    ImportCheckpoint,
    ImportRowResult,
    ImportedHistoricalSale,
    ImportExternalIdentity,
    FamilyVocabulary,
    DismissedSuggestion,
    ProductFieldDefinition,
    StoreFieldSetting,
    ProductFieldValue,
    ProductRelation,
    InventoryLocation,
    InventoryTransaction,
    InventoryTransactionIntent,
    InventoryEntry,
    InventoryBalance,
    InventoryTransitBalance,
    InventoryOpeningReconciliation,
    InventoryOpeningReconciliationAllocation,
    InventoryReservation,
    InventoryBackorder,
    InventoryBackorderAllocation,
    InventoryTransfer,
    InventoryTransferLine,
    ProductTranslation,
    CategoryTranslation,
    CatalogueChannel,
    CatalogueGroup,
    StoreCategoryPublication,
    CatalogueGroupCategory,
    PlanChangeChallenge,
  ],
  clientUrl: process.env.DATABASE_URL,
  /*
    TLS with certificate AND hostname validation, when a CA is provided.

    This is the ONLY place the application's database TLS can be configured.
    MikroORM extracts host/port/user/password/database from `clientUrl` and
    silently drops every other URL parameter — measured on the installed
    packages, not read from docs — so an `sslmode` in the URL does nothing
    here (it is kept in the URL for libpq consumers, where it is real).
    `driverOptions.connection.ssl` reaches the pg driver intact, and with
    `rejectUnauthorized: true` node validates both the chain against this CA
    and the hostname against the certificate's altnames.

    Fail-closed by construction: if DATABASE_CA_PATH names a missing file,
    `readFileSync` throws at boot and the service never comes up half-secure.
    When the variable is absent (local dev, unit tests, disposable-PG
    harness), behaviour is exactly what it was before.

    Measured before this shipped (2026-09-01, against the
    serving host): without this block the connection is PLAINTEXT
    (pg_stat_ssl.ssl = false); with it, TLSv1.3; with a wrong CA it refuses
    (SELF_SIGNED_CERT_IN_CHAIN); by raw IP it refuses
    (ERR_TLS_CERT_ALTNAME_INVALID).
  */
  driverOptions: process.env.DATABASE_CA_PATH
    ? {
        connection: {
          ssl: { ca: readFileSync(process.env.DATABASE_CA_PATH, 'utf8'), rejectUnauthorized: true },
        },
      }
    : undefined,
  // Supabase's pooler reaps idle connections; drop ours first so a query
  // never lands on a dead socket (Sentry: read ECONNRESET on /auth/refresh)
  pool: { min: 0, idleTimeoutMillis: 30_000 },
  extensions: [Migrator, SeedManager],
  migrations: {
    path: 'dist/database/migrations',
    pathTs: 'src/database/migrations',
    // Diff against the live DB instead of a snapshot file: the snapshot
    // path crashes knex on our audit-log check constraints (2026-07-09).
    snapshot: false,
  },
  seeder: {
    path: 'dist/database/seeders',
    pathTs: 'src/database/seeders',
    defaultSeeder: 'DatabaseSeeder',
  },
});
