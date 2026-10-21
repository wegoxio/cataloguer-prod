import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { QueryOrder } from '@mikro-orm/core';
import { IsDateString, IsNumber, IsString, IsUUID, Min } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Payment } from './entities/payment.entity';
import { Store } from '../stores/entities/store.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { effectiveBillingStatus, effectivePlanPriceUsd, PLANS } from '../stores/plans';
import { assertUnscopedPlatformOwner, requireOrganizationScope } from '../auth/tenancy/tenant-assertions';
import { canReadCommercialTerms } from '../auth/tenancy/tenant-scope';
import { CheckoutDto } from './dto/checkout.dto';
import { StripeService } from './stripe/stripe.service';
import { requestIdOf } from '../../common/observability/request-id';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EntityType, Action } from '../audit-log/entities/audit-log.entity';

class RecordPaymentDto {
  @IsUUID()
  storeId!: string;

  @IsNumber()
  @Min(0)
  amountUsd!: number;

  @IsString()
  description!: string;

  @IsDateString()
  paidAt!: string;
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN', 'ADMIN')
@Controller('billing')
export class BillingController {
  constructor(
    @InjectRepository(Payment)
    private readonly paymentRepository: EntityRepository<Payment>,
    private readonly auditLogService: AuditLogService,
    private readonly stripeService: StripeService,
  ) {}

  // Card payment: hosted Stripe Checkout for the actor's own COMPANY.
  // D-4: a subscription belongs to the organization, so the organization is
  // the identity; the unscoped platform owner must enter a managed company
  // rather than receive an implicit one.
  @Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER')
  @Post('checkout')
  async checkout(@Req() req: any, @Body() body: CheckoutDto) {
    const organizationId = requireOrganizationScope(req.scope);
    const url = await this.stripeService.createCheckout(
      organizationId,
      body.plan,
      { id: req.user?.id ?? null, email: req.user?.email ?? null },
      { requestId: requestIdOf(req) },
    );
    return { data: { url } };
  }

  @Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER')
  @Get('stripe-info')
  async stripeInfo(@Req() req: any) {
    const organizationId = requireOrganizationScope(req.scope);
    return { data: await this.stripeService.getStripeInfo(organizationId) };
  }

  @Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER')
  @Post('portal')
  async portal(@Req() req: any) {
    const organizationId = requireOrganizationScope(req.scope);
    const url = await this.stripeService.createPortal(organizationId);
    return { data: { url } };
  }

  /**
   * Detailed payment history — ORGANIZATION-level (D-5).
   *
   * `req.user?.store ? { store } : {}` fell through to an UNFILTERED query for
   * any store-less actor, so a manager or a platform owner in a managed company
   * would have read every tenant's payments. History is now the organization's,
   * branch narrowing does not change it, and the unscoped platform owner gets
   * no tenant rows at all — its future dashboard is a separate aggregate
   * surface, deliberately not built here.
   */
  @Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER')
  @Get('payments')
  async list(@Req() req: any) {
    const organizationId = requireOrganizationScope(req.scope);
    const where = { store: { organization: organizationId } };
    const payments = await this.paymentRepository.find(where as any, {
      populate: ['store'],
      orderBy: { paidAt: QueryOrder.DESC },
      limit: 100,
    });
    return {
      data: payments.map((p) => ({
        id: p.id,
        store: { id: p.store.id, name: p.store.name },
        amountUsd: p.amountUsd,
        description: p.description,
        status: p.status,
        invoiceUrl: p.invoiceUrl ?? null,
        paidAt: p.paidAt,
      })),
    };
  }

  /**
   * Two different things travel on this route, and they are separated by role.
   *
   *  - `billingStatus` is OPERATIONAL: it tells every staff member whether the
   *    panel is read-only, so all five roles receive it.
   *  - `plan` is COMMERCIAL — price and contractual limits — so it is returned
   *    only to organization authority (ORGANIZATION_MANAGER, or a SUPER_ADMIN
   *    inside a managed company). ADMIN, EDITOR and VIEWER are NOT refused the
   *    endpoint; they receive the status with `plan: null`.
   *
   * The organization comes from the resolved scope; reading it through
   * `user.store.organization` left store-less actors with a default 'ACTIVE'
   * and no plan, which misreported a suspended company as operating normally.
   */
  @Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER', 'ADMIN', 'EDITOR', 'VIEWER')
  @Get('status')
  async status(@Req() req: any) {
    const organizationId = req.scope?.organizationId ?? null;
    if (!organizationId) {
      // A platform actor with no company in context is not a paying tenant.
      return { data: { billingStatus: 'ACTIVE', plan: null } };
    }
    const em = this.paymentRepository.getEntityManager();
    const organization: any = await em.findOne(Organization, { id: organizationId });
    const commercial = canReadCommercialTerms(req.scope);
    const plan = commercial && organization ? PLANS[organization.plan] : null;
    return {
      data: {
        billingStatus: effectiveBillingStatus(organization),
        plan: plan
          ? {
              key: organization.plan,
              name: plan.name,
              priceUsd: effectivePlanPriceUsd(plan, organization),
              maxWebsites: plan.maxWebsites,
              maxTeamUsers: plan.maxTeamUsers,
              complimentary: plan.complimentary,
            }
          : null,
      },
    };
  }

  // Manual entry (Zelle, cash, transfer): the PLATFORM OWNER records what a
  // client paid. This is a commercial control, so it requires the genuinely
  // unscoped owner — a SUPER_ADMIN working inside a managed company holds
  // organization authority, not platform authority.
  @Roles('SUPER_ADMIN')
  @Post('payments')
  async record(@Req() req: any, @Body() dto: RecordPaymentDto) {
    assertUnscopedPlatformOwner(req.scope);
    const em = this.paymentRepository.getEntityManager();
    // P5-A1 fail-closed: a payment records against a real client store with a
    // real organization — a failed lookup must never silently become platform
    // context. Refused BEFORE the payment row exists.
    const store = await em.findOne(Store, { id: dto.storeId }, { populate: ['organization'] as never });
    if (!store) throw new BadRequestException('Store not found — cannot record a payment for a missing store');
    const organization = (store as any)?.organization;
    if (!organization) {
      throw new BadRequestException('This store belongs to no organization — cannot record a tenant payment');
    }
    const payment = this.paymentRepository.create({
      store: dto.storeId as any,
      amountUsd: dto.amountUsd.toFixed(2),
      description: dto.description,
      status: 'PAID',
      paidAt: new Date(dto.paidAt),
      createdAt: new Date(),
    });
    // Any recorded payment unlocks a pending or suspended panel — of the CLIENT
    organization.billingStatus = 'ACTIVE';
    await em.persistAndFlush(payment);
    await this.auditLogService.recordAuditEntry(
      req.user?.id ?? null,
      req.user?.email ?? null,
      EntityType.STORE,
      dto.storeId,
      Action.CREATE,
      null,
      `Recorded payment $${dto.amountUsd.toFixed(2)} — ${dto.description}`,
      { organizationId: (organization as any).id, storeId: dto.storeId },
    );
    return { data: { id: payment.id } };
  }
}
