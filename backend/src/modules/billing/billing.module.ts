import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { Payment } from './entities/payment.entity';
import { Store } from '../stores/entities/store.entity';
import { StripeService } from './stripe/stripe.service';
import { StripeWebhookController } from './stripe/stripe-webhook.controller';
import { StripeEventsController } from './stripe/stripe-events.controller';
import { StripeReconcileController } from './stripe/stripe-reconcile.controller';
import { StripeReconcileService } from './stripe/stripe-reconcile.service';
import { AuditLog } from '../audit-log/entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { BillingController } from './billing.controller';

@Module({
  imports: [MikroOrmModule.forFeature([Payment, Store, AuditLog]), AuthModule, UsersModule],
  providers: [AuditLogService, StripeService, StripeReconcileService],
  controllers: [BillingController, StripeWebhookController, StripeEventsController, StripeReconcileController],
})
export class BillingModule {}
