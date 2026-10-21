import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { validate } from './config/env.validation';
import { MaintenanceGuard } from './common/maintenance/maintenance.guard';
import { HealthModule } from './modules/health/health.module';
import { UsersModule } from './modules/users/users.module';
import { AuthModule } from './modules/auth/auth.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { ProductsModule } from './modules/products/products.module';
import { ProductImagesModule } from './modules/product-images/product-images.module';
import { PublicCatalogueModule } from './modules/public-catalogue/public-catalogue.module';
import { ImportsModule } from './modules/imports/imports.module';
import { ExportsModule } from './modules/exports/exports.module';
import { BulkOperationsModule } from './modules/bulk-operations/bulk-operations.module';
import { AuditLogModule } from './modules/audit-log/audit-log.module';
import { DashboardMetricsModule } from './modules/dashboard-metrics/dashboard-metrics.module';
import { SettingsModule } from './modules/settings/settings.module';
import { ApiKeysModule } from './modules/api-keys/api-keys.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ReportsModule } from './modules/reports/reports.module';
import { StoresModule } from './modules/stores/stores.module';
import { BillingModule } from './modules/billing/billing.module';
import { SalesModule } from './modules/sales/sales.module';
import { DiscountsModule } from './modules/discounts/discounts.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { LocalizationModule } from './modules/localization/localization.module';
import { CatalogueNavigationModule } from './modules/catalogue-navigation/catalogue-navigation.module';
import { HttpPerformanceInterceptor } from './common/interceptors/http-performance.interceptor';
import { CatalogueRevalidationInterceptor } from './common/catalogue-revalidation/catalogue-revalidation.interceptor';
import { CatalogueRevalidationService } from './common/catalogue-revalidation/catalogue-revalidation.service';
import { RateLimitModule } from './common/rate-limit/rate-limit.module';
import { ResilientThrottlerStorage } from './common/rate-limit/resilient-throttler.storage';
import { RateLimitMode } from './common/rate-limit/rate-limit.constants';
import databaseConfig from './database/mikro-orm.config';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
    }),
    // Global rate limit for every endpoint; auth and public-order endpoints
    // declare stricter overrides with @Throttle({ default: ... }). The single
    // `default` throttler and its IP tracker are unchanged; only the storage
    // varies (#181). In distributed-redis mode the counters live in a shared
    // Redis store so the limit is global across all backend containers; in
    // memory mode they are per-instance (local/test or single-instance only).
    ThrottlerModule.forRootAsync({
      imports: [RateLimitModule],
      inject: [ResilientThrottlerStorage, ConfigService],
      useFactory: (storage: ResilientThrottlerStorage, config: ConfigService) => {
        const throttlers = [{ name: 'default', ttl: 60_000, limit: 100 }];
        return config.get<RateLimitMode>('RATE_LIMIT_MODE') === RateLimitMode.DistributedRedis
          ? { throttlers, storage }
          : { throttlers };
      },
    }),
    MikroOrmModule.forRoot(databaseConfig),
    HealthModule,
    UsersModule,
    AuthModule,
    CategoriesModule,
    ProductsModule,
    ProductImagesModule,
    PublicCatalogueModule,
    ImportsModule,
    ExportsModule,
    BulkOperationsModule,
    AuditLogModule,
    DashboardMetricsModule,
    SettingsModule,
    ApiKeysModule,
    OrganizationsModule,
    ReportsModule,
    StoresModule,
    BillingModule,
    SalesModule,
    DiscountsModule,
    InventoryModule,
    LocalizationModule,
    CatalogueNavigationModule,
  ],
  providers: [
    CatalogueRevalidationService,
    {
      // P5-X1: FIRST, deliberately. During a cutover window every caller gets
      // the same answer, so refusing before throttling or authentication is
      // both cheapest and safest — no authenticated path can outrun a guard
      // that has not run yet.
      provide: APP_GUARD,
      useClass: MaintenanceGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: HttpPerformanceInterceptor,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: CatalogueRevalidationInterceptor,
    },
  ],
})
export class AppModule {}
