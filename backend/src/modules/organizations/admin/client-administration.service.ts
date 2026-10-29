import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { Action, EntityType } from '../../audit-log/entities/audit-log.entity';
import { OrganizationPlanPolicy } from '../../billing/plans/organization-plan-policy';
import { StripeService } from '../../billing/stripe/stripe.service';
import { MailService } from '../../mail/mail.service';
import { DEFAULT_PLAN, effectiveBillingStatus, effectivePlanPriceUsd, PLANS } from '../../stores/plans';
import { User } from '../../users/entities/user.entity';
import { Organization } from '../entities/organization.entity';
import { PlanChangeChallenge } from '../entities/plan-change-challenge.entity';

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const MAX_REQUESTS_PER_HOUR = 5;

@Injectable()
export class ClientAdministrationService {
  constructor(
    private readonly em: EntityManager,
    private readonly config: ConfigService,
    private readonly mail: MailService,
    private readonly audit: AuditLogService,
    private readonly stripe: StripeService,
  ) {}

  async details(organizationId: string) {
    const organization = await this.em.findOne(Organization, { id: organizationId });
    if (!organization) throw new NotFoundException('Client company not found');
    const plan = PLANS[organization.plan] ?? PLANS[DEFAULT_PLAN];
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const [stores, catalogueRows, userRows, salesRows, paymentRows, recentPayments, managerRows] = await Promise.all([
      this.em.getConnection().execute(
        `select id, name, slug, website_url as "websiteUrl", archived_at as "archivedAt", created_at as "createdAt"
           from stores where organization_id = ? and removed_at is null order by created_at asc`,
        [organizationId],
      ),
      this.em.getConnection().execute(
        `select
           (select count(*)::int from products where organization_id = ? and removed_at is null) as products,
           (select count(*)::int from products where organization_id = ? and removed_at is null and archived_at is null and status = 'PUBLISHED') as "publishedProducts",
           (select count(*)::int from categories where organization_id = ? and removed_at is null and archived_at is null) as categories`,
        [organizationId, organizationId, organizationId],
      ),
      this.em.getConnection().execute(
        `select count(*)::int as total,
                count(*) filter (where deleted_at is null)::int as active,
                count(*) filter (where password_hash is null and deleted_at is null)::int as pending
           from users where organization_id = ? and removed_at is null`,
        [organizationId],
      ),
      this.em.getConnection().execute(
        `select count(*)::int as "ordersTotal",
                count(*) filter (where created_at >= ?)::int as "ordersThisMonth",
                coalesce(sum(total_usd) filter (where created_at >= ? and status <> 'CANCELLED'), 0)::float as "revenueThisMonth",
                coalesce(sum(total_usd) filter (where status <> 'CANCELLED'), 0)::float as "revenueTotal",
                max(created_at) as "lastOrderAt"
           from sales_orders where organization_id = ?`,
        [monthStart, monthStart, organizationId],
      ),
      this.em.getConnection().execute(
        `select count(*) filter (where p.status = 'PAID')::int as "paymentsCount",
                coalesce(sum(p.amount_usd) filter (where p.status = 'PAID'), 0)::float as "totalPaid",
                max(p.paid_at) filter (where p.status = 'PAID') as "lastPaymentAt"
           from payments p join stores s on s.id = p.store_id where s.organization_id = ?`,
        [organizationId],
      ),
      this.em.getConnection().execute(
        `select p.id, p.amount_usd::float as "amountUsd", p.description, p.status,
                p.paid_at as "paidAt", p.invoice_url as "invoiceUrl", s.name as "storeName"
           from payments p join stores s on s.id = p.store_id
          where s.organization_id = ? order by p.paid_at desc limit 10`,
        [organizationId],
      ),
      this.em.getConnection().execute(
        `select u.id, u.email, u.first_name as "firstName", u.last_name as "lastName", u.deleted_at as "deletedAt",
                (u.password_hash is null) as "pendingInvite",
                (select max(prt.expires_at) from password_reset_tokens prt
                  where prt.user_id = u.id and prt.used_at is null) as "invitationExpiresAt"
           from users u join roles r on r.id = u.role_id
          where u.organization_id = ? and u.removed_at is null and r.name = 'ORGANIZATION_MANAGER'
          order by u.created_at asc`,
        [organizationId],
      ),
    ]);

    const catalogue = catalogueRows[0] ?? {};
    const users = userRows[0] ?? {};
    const sales = salesRows[0] ?? {};
    const payments = paymentRows[0] ?? {};
    const stripeInfo = organization.stripeSubscriptionId
      ? await this.stripe.getStripeInfo(organizationId).catch(() => ({ active: false }))
      : { active: false };
    return {
      company: {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        status: organization.archivedAt ? 'ARCHIVED' : effectiveBillingStatus(organization),
        createdAt: organization.createdAt,
        archivedAt: organization.archivedAt ?? null,
        defaultContentLocale: organization.defaultContentLocale,
      },
      plan: {
        key: plan.key,
        name: plan.name,
        priceUsd: effectivePlanPriceUsd(plan, organization),
        complimentary: plan.complimentary,
        maxWebsites: plan.maxWebsites,
        maxTeamUsers: plan.maxTeamUsers,
        stripeManaged: Boolean(organization.stripeSubscriptionId),
        subscriptionStatus: 'status' in stripeInfo ? (stripeInfo.status ?? null) : null,
        nextChargeAt: 'nextChargeAt' in stripeInfo ? (stripeInfo.nextChargeAt ?? null) : null,
      },
      usage: {
        stores: stores.length,
        activeStores: stores.filter((store: any) => !store.archivedAt).length,
        products: Number(catalogue.products ?? 0),
        publishedProducts: Number(catalogue.publishedProducts ?? 0),
        categories: Number(catalogue.categories ?? 0),
        teamUsers: Number(users.total ?? 0),
        activeTeamUsers: Number(users.active ?? 0),
        pendingInvitations: Number(users.pending ?? 0),
      },
      commerce: {
        ordersTotal: Number(sales.ordersTotal ?? 0),
        ordersThisMonth: Number(sales.ordersThisMonth ?? 0),
        revenueThisMonth: Number(sales.revenueThisMonth ?? 0),
        revenueTotal: Number(sales.revenueTotal ?? 0),
        lastOrderAt: sales.lastOrderAt ?? null,
        paymentsCount: Number(payments.paymentsCount ?? 0),
        totalPaid: Number(payments.totalPaid ?? 0),
        lastPaymentAt: payments.lastPaymentAt ?? null,
      },
      stores,
      managers: managerRows,
      recentPayments,
      availablePlans: Object.values(PLANS),
    };
  }

  async requestPlanChange(organizationId: string, targetPlan: string, actor: User) {
    const organization = await this.em.findOne(Organization, { id: organizationId });
    const plan = PLANS[targetPlan];
    if (!organization) throw new NotFoundException('Client company not found');
    if (!plan) throw new BadRequestException('Unknown plan');
    if (organization.plan === targetPlan) throw new ConflictException('The company already has that plan');
    if (!actor?.id || !actor.email) throw new UnauthorizedException('Administrator identity is incomplete');
    if (!this.mail.isConfigured) throw new ServiceUnavailableException('Email delivery is not configured');

    const since = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await this.em.count(PlanChangeChallenge, { actorUserId: actor.id, createdAt: { $gte: since } });
    if (recent >= MAX_REQUESTS_PER_HOUR) {
      throw new HttpException('Too many verification codes requested', HttpStatus.TOO_MANY_REQUESTS);
    }

    await this.em.nativeUpdate(
      PlanChangeChallenge,
      { actorUserId: actor.id, organizationId, consumedAt: null },
      { consumedAt: new Date() },
    );

    let code = '';
    let codeDigest = '';
    for (let attempt = 0; attempt < 30; attempt += 1) {
      code = randomInt(0, 1_000_000).toString().padStart(6, '0');
      codeDigest = this.digest(code);
      if ((await this.em.count(PlanChangeChallenge, { codeDigest })) === 0) break;
      code = '';
    }
    if (!code) throw new ServiceUnavailableException('Could not generate a unique verification code');

    const challenge = this.em.create(PlanChangeChallenge, {
      organizationId,
      actorUserId: actor.id,
      targetPlan,
      codeDigest,
      failedAttempts: 0,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
      createdAt: new Date(),
    });
    await this.em.persistAndFlush(challenge);

    const html = this.mail.renderTemplate('plan-change-code', 'Confirm plan change', {
      code,
      company: organization.name,
      currentPlan: PLANS[organization.plan]?.name ?? organization.plan,
      targetPlan: plan.name,
      expiresMinutes: String(CODE_TTL_MS / 60_000),
    });
    const delivered = await this.mail.send(actor.email, `Verification code for ${organization.name}`, html);
    if (!delivered) {
      challenge.consumedAt = new Date();
      await this.em.flush();
      throw new ServiceUnavailableException('The verification email could not be delivered');
    }

    return { challengeId: challenge.id, expiresAt: challenge.expiresAt, email: this.maskEmail(actor.email) };
  }

  async confirmPlanChange(organizationId: string, challengeId: string, code: string, actor: User) {
    return this.em.transactional(async (tem) => {
      const challenge = await tem.findOne(
        PlanChangeChallenge,
        { id: challengeId, organizationId, actorUserId: actor.id },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );
      if (!challenge) throw new NotFoundException('Verification request not found');
      if (challenge.consumedAt) throw new ConflictException('This verification code has already been used');
      if (challenge.expiresAt.getTime() <= Date.now()) {
        challenge.consumedAt = new Date();
        await tem.flush();
        throw new UnauthorizedException('The verification code has expired');
      }
      if (challenge.failedAttempts >= MAX_FAILED_ATTEMPTS)
        throw new UnauthorizedException('Too many incorrect attempts');

      const supplied = Buffer.from(this.digest(code), 'hex');
      const expected = Buffer.from(challenge.codeDigest, 'hex');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        challenge.failedAttempts += 1;
        if (challenge.failedAttempts >= MAX_FAILED_ATTEMPTS) challenge.consumedAt = new Date();
        await tem.flush();
        throw new UnauthorizedException('The verification code is incorrect');
      }

      await OrganizationPlanPolicy.lock(tem, organizationId);
      const organization = await tem.findOne(
        Organization,
        { id: organizationId },
        { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
      );
      if (!organization) throw new NotFoundException('Client company not found');
      const target = PLANS[challenge.targetPlan];
      if (!target) throw new BadRequestException('The requested plan no longer exists');
      await OrganizationPlanPolicy.assertComplimentaryAssignable(tem, organization, target.key);
      await OrganizationPlanPolicy.assertPlanChange(tem, organization, target);

      const before = organization.plan;
      const billingBefore = organization.billingStatus;
      organization.plan = target.key;
      organization.billingStatus = OrganizationPlanPolicy.billingStatusFor(
        target.key,
        undefined,
        organization.billingStatus,
      );
      challenge.consumedAt = new Date();
      await tem.flush();
      await this.audit.recordAuditEntryIn(
        tem,
        actor.id,
        actor.email,
        EntityType.ORGANIZATION,
        organization.id,
        Action.UPDATE,
        {
          plan: { before, after: target.key },
          billingStatus: { before: billingBefore, after: organization.billingStatus },
        },
        `Changed plan of "${organization.name}" from ${before} to ${target.key} after email verification`,
        { organizationId },
      );
      return {
        plan: {
          key: target.key,
          name: target.name,
          priceUsd: effectivePlanPriceUsd(target, organization),
          complimentary: target.complimentary,
        },
        billingStatus: effectiveBillingStatus(organization),
      };
    });
  }

  private digest(code: string): string {
    const secret = this.config.get<string>('PLAN_CHANGE_CODE_SECRET') || this.config.get<string>('JWT_SECRET');
    if (!secret) throw new ServiceUnavailableException('Plan-change verification is not configured');
    return createHmac('sha256', secret).update(code).digest('hex');
  }

  private maskEmail(email: string): string {
    const [local, domain] = email.split('@');
    return `${local.slice(0, 2)}${'*'.repeat(Math.max(2, local.length - 2))}@${domain}`;
  }
}
