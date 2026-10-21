import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Organization } from './entities/organization.entity';
import { Store } from '../stores/entities/store.entity';
import { OrganizationsService } from './organizations.service';
import { TenantBackfillService } from './tenancy/tenant-backfill.service';
import { OrganizationMergeService } from './merge/organization-merge.service';
import { OrganizationOnboardingService } from './onboarding/organization-onboarding.service';
import { OrganizationsController } from './organizations.controller';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [MikroOrmModule.forFeature([Organization, Store]), AuditLogModule, AuthModule, UsersModule],
  controllers: [OrganizationsController],
  providers: [
    OrganizationsService,
    TenantBackfillService,
    OrganizationMergeService,
    OrganizationOnboardingService,
  ],
  exports: [
    OrganizationsService,
    TenantBackfillService,
    OrganizationMergeService,
    OrganizationOnboardingService,
  ],
})
export class OrganizationsModule {}
