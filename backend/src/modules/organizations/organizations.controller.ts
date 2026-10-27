import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { OrganizationsService } from './organizations.service';
import { TenantBackfillService } from './tenancy/tenant-backfill.service';
import { CreateOrganizationDto, MergeOrganizationDto, UpdateOrganizationDto } from './dto/organization.dto';
import { CreateOrganizationAdministratorDto } from './dto/create-organization-administrator.dto';
import { ChangeUserAccessDto, TransferOrganizationManagerDto } from './dto/organization-access.dto';
import { OnboardOrganizationDto } from './dto/onboard-organization.dto';
import { TenantLookupQueryDto } from './dto/tenant-lookup-query.dto';
import { OrganizationOnboardingService } from './onboarding/organization-onboarding.service';
import { OrganizationMergeService } from './merge/organization-merge.service';
import { UsersService } from '../users/users.service';
import { assertGlobalPlatform } from '../auth/tenancy/tenant-assertions';
import { isComplimentaryPlan } from '../stores/plans';
import { ConfirmPlanChangeDto, RequestPlanChangeDto } from './dto/plan-change.dto';
import { ClientAdministrationService } from './admin/client-administration.service';

/**
 * Organizations are the platform's tenants, so only a real SUPER_ADMIN
 * manages them. Tenant-scoped users never reach this controller — which is
 * what stops one client from enumerating another's branches.
 */
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly tenantBackfillService: TenantBackfillService,
    private readonly organizationMergeService: OrganizationMergeService,
    private readonly usersService: UsersService,
    private readonly onboardingService: OrganizationOnboardingService,
    private readonly clientAdministrationService: ClientAdministrationService,
  ) {}

  @Get(':id/client-details')
  async clientDetails(@Req() req: any, @Param('id') id: string) {
    assertGlobalPlatform(req.scope, 'Reading client administration details');
    return { data: await this.clientAdministrationService.details(id) };
  }

  @Throttle({ default: { limit: 5, ttl: 60 * 60_000 } })
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  @Post(':id/plan-change/challenges')
  async requestPlanChange(@Req() req: any, @Param('id') id: string, @Body() dto: RequestPlanChangeDto) {
    assertGlobalPlatform(req.scope, 'Requesting a client plan change');
    return { data: await this.clientAdministrationService.requestPlanChange(id, dto.plan, req.user) };
  }

  @Throttle({ default: { limit: 10, ttl: 10 * 60_000 } })
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  @Post(':id/plan-change/confirm')
  async confirmPlanChange(@Req() req: any, @Param('id') id: string, @Body() dto: ConfirmPlanChangeDto) {
    assertGlobalPlatform(req.scope, 'Confirming a client plan change');
    return { data: await this.clientAdministrationService.confirmPlanChange(id, dto.challengeId, dto.code, req.user) };
  }

  /**
   * Creates an organization's ORGANIZATION_MANAGER (Phase 4).
   *
   * Platform administration, not a tenant operation: only Wegox creates a
   * company's first administrator, and from there that administrator invites
   * its own store-bound admins. This lives here rather than under `/users`
   * because the organization is the subject and comes from the path — a body
   * cannot nominate which company it administers.
   *
   * `forbidNonWhitelisted` is set explicitly on this route so `role`,
   * `storeId` or `organizationId` in the body is a NAMED 400 rather than a
   * silent strip. Privilege escalation should be refused loudly.
   */
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  @Post(':id/administrators')
  async createAdministrator(@Req() req: any, @Param('id') id: string, @Body() dto: CreateOrganizationAdministratorDto) {
    const user = await this.usersService.createOrganizationAdministrator(req.user, {
      organizationId: id,
      email: dto.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      company: dto.company,
    });
    return { data: user };
  }

  /**
   * ONBOARD A CLIENT AS ONE UNIT.
   *
   * Replaces the panel's three independent requests — organization, store, then
   * a user posted as `role: 'ADMIN'` — with a single transaction. The body
   * carries no role: the first user of a company is always an
   * ORGANIZATION_MANAGER with no branch, and letting a client name that is how
   * every company onboarded through the UI ended up without one.
   *
   * Statuses, following this project's existing conventions (`ConflictException`
   * is already used in `products.service.ts`; there is no `@HttpCode` anywhere,
   * so POST answers 201):
   *
   *   201  created — `idempotent: false`
   *   201  exact retry — `idempotent: true`, nothing written, no email sent
   *   409  the email exists in any other state; nothing is written
   *   400  validation, plan/seat limits, or an unknown plan
   *   403  any caller that is not a platform administrator
   */
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  @Post('onboard')
  async onboard(@Req() req: any, @Body() dto: OnboardOrganizationDto) {
    // Plan Gratis is assigned only by the UNSCOPED platform owner; a platform
    // administrator working inside a managed company or branch holds no such
    // authority, even though the class-level role admits it here.
    if (isComplimentaryPlan(dto.organization?.plan)) assertGlobalPlatform(req.scope, 'Assigning Plan Gratis');
    const data = await this.onboardingService.onboard(req.user, {
      organization: { name: dto.organization.name, plan: dto.organization.plan },
      store: dto.store ? { name: dto.store.name, websiteUrl: dto.store.websiteUrl } : null,
      manager: { email: dto.manager.email, firstName: dto.manager.firstName, lastName: dto.manager.lastName },
    });
    return { data };
  }

  /**
   * Re-send a brand-new manager's invitation, addressed by PATH.
   *
   * The onboarding success screen runs as an UNSCOPED platform owner, which
   * `POST /users/:id/resend-invite` refuses — it requires an organization
   * context. This is the smallest bridge that lets D5's "supported resend
   * action" actually be pressed, and it is narrower than the route it stands
   * in for: only an active manager of the named organization with a pending
   * invitation.
   */
  @Post(':organizationId/managers/:userId/resend-invitation')
  async resendManagerInvitation(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('userId') userId: string,
  ) {
    const data = await this.onboardingService.resendManagerInvitation(req.user, organizationId, userId);
    return { data };
  }

  /**
   * ONE STATEMENT OF ACCESS: role and branch, validated and written together.
   *
   * This route breaks the controller's SUPER_ADMIN-only rule on purpose, so the
   * `@Roles` list is stated here rather than inherited: ADR 014 gives an
   * ORGANIZATION_MANAGER the staffing surface of its own company, and the
   * service decides which of the two callers may do what. The organization is
   * the PATH's, never a header's — a forged `X-Managed-Organization` produces a
   * scope that is only ever compared against the path, never substituted for it.
   *
   * `forbidNonWhitelisted` is explicit, as it is on `createAdministrator`: a
   * body carrying `organizationId`, `userId` or anything else that looks like
   * it might redirect the subject is a NAMED 400, never a silent strip.
   */
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  @Roles('SUPER_ADMIN', 'ORGANIZATION_MANAGER')
  @Patch(':organizationId/users/:userId/access')
  async changeUserAccess(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Param('userId') userId: string,
    @Body() dto: ChangeUserAccessDto,
  ) {
    const user = await this.usersService.changeOrganizationAccess(req.scope, req.user, organizationId, userId, {
      role: dto.role,
      storeId: dto.storeId,
    });
    return { data: user };
  }

  /**
   * Hand a company's management to someone else without it ever having nobody.
   *
   * Platform-only, because a transfer grants AND revokes ORGANIZATION_MANAGER
   * in one act, and only the platform may do either.
   */
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  @Post(':organizationId/managers/transfer')
  async transferManager(
    @Req() req: any,
    @Param('organizationId') organizationId: string,
    @Body() dto: TransferOrganizationManagerDto,
  ) {
    const result = await this.usersService.transferOrganizationManager(req.scope, req.user, organizationId, dto);
    return { data: result };
  }

  /**
   * State of the tenant backfill: counts to reconcile, plus anything the
   * migration could not decide on its own (P0-02).
   */
  @Get('backfill-report')
  async backfillReport() {
    return { data: await this.tenantBackfillService.report() };
  }

  /**
   * THE BOUNDED COMPANY PICKER (#275).
   *
   * Declared BEFORE `@Get(':id')` on purpose: Nest matches in declaration
   * order, and the parameterised route would otherwise swallow `/lookup` and
   * answer 404 for an organization whose id is the word "lookup".
   *
   * Separate from `findAll` rather than a parameter on it. `findAll` is a
   * management listing whose callers depend on receiving everything, including
   * archived rows on request; adding a silent default limit to it would have
   * truncated those screens without any of them asking. `findAll` also keeps
   * its own authority — the class `@Roles` — unchanged; only the two lookups
   * carry the stricter unscoped requirement, because only they were built for
   * an unscoped-only screen.
   */
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  @Get('lookup')
  async lookup(@Req() req: any, @Query() query: TenantLookupQueryDto) {
    return { data: await this.organizationsService.lookup(req.scope, query.search, query.limit) };
  }

  /** One company's branches, bounded the same way — see `lookupStores`. */
  @UsePipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }))
  @Get(':id/stores/lookup')
  async lookupStores(@Req() req: any, @Param('id') id: string, @Query() query: TenantLookupQueryDto) {
    return { data: await this.organizationsService.lookupStores(req.scope, id, query.search, query.limit) };
  }

  // #294 (owner decision 13): the four company routes below are UNSCOPED-ONLY.
  // A platform administrator who has entered a company through the managed
  // headers is acting as that company, and a company neither enumerates nor
  // edits companies. The bounded lookups keep their own, narrower contract.
  @Get()
  async findAll(@Req() req: any, @Query('includeArchived') includeArchived?: string) {
    assertGlobalPlatform(req.scope, 'Listing organizations');
    return { data: await this.organizationsService.findAll(includeArchived === 'true') };
  }

  @Get(':id')
  async findOne(@Req() req: any, @Param('id') id: string) {
    assertGlobalPlatform(req.scope, 'Reading an organization');
    return { data: await this.organizationsService.findById(id) };
  }

  @Get(':id/stores')
  async findStores(@Param('id') id: string, @Query('includeArchived') includeArchived?: string) {
    return { data: await this.organizationsService.findStores(id, includeArchived === 'true') };
  }

  @Post()
  async create(@Req() req: any, @Body() dto: CreateOrganizationDto) {
    assertGlobalPlatform(req.scope, 'Creating an organization');
    return { data: await this.organizationsService.create(dto, req.user) };
  }

  @Patch(':id')
  async update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateOrganizationDto) {
    assertGlobalPlatform(req.scope, 'Editing an organization');
    if (dto.plan !== undefined) throw new BadRequestException('Plan changes require email verification');
    return { data: await this.organizationsService.update(id, dto, req.user) };
  }

  /**
   * Merges another organization INTO this one (P0-12). Defaults to dry-run;
   * the commit needs an explicit dryRun:false and refuses unresolved
   * conflicts either way.
   *
   * UNSCOPED PLATFORM AUTHORITY ONLY (#289 P1). The class-level `@Roles`
   * admits every Superadmin, but a Superadmin acting INSIDE a company
   * (`X-Managed-Organization` / `X-Managed-Store`) is acting as that company,
   * and a company does not merge companies. The assertion runs before the
   * service is reached, for the dry-run as much as for the commit, so a
   * refused caller learns nothing about either organization.
   */
  @Post(':id/merge')
  async merge(@Req() req: any, @Param('id') id: string, @Body() dto: MergeOrganizationDto) {
    assertGlobalPlatform(req.scope, 'Organization merge');
    return {
      data: await this.organizationMergeService.merge(id, dto.sourceOrganizationId, dto.dryRun !== false, req.user),
    };
  }

  /**
   * UNSCOPED PLATFORM AUTHORITY ONLY (#277 P2). Archiving makes a company
   * operationally inactive for every one of its people; a Superadmin who has
   * entered a company through `X-Managed-Organization` or `X-Managed-Store`
   * is refused at this boundary, before the service is reached, and the
   * service asserts again itself.
   */
  /**
   * #294 (P3) — removal preview: advisory; the authoritative decision is taken
   * under the locks by `remove`. Unscoped platform owner only, asserted here
   * and again in the service. A removed company answers 404 on this surface.
   */

  /**
   * #294 (P3) — removal. 200 on success; a refusal is a 409 raised HERE, after
   * the service transaction — and its blocked audit row — has committed.
   */

  @Patch(':id/archive')
  async archive(@Req() req: any, @Param('id') id: string) {
    assertGlobalPlatform(req.scope, 'Archiving an organization');
    return { data: await this.organizationsService.archive(req.scope, id, req.user) };
  }

  /**
   * #277 P2 — what restoring this archived company would do: the manager that
   * would be kept, the members an explicit choice may name, the seats, and
   * every consequence, computed from current state. Unscoped platform owner
   * only, like the restoration itself.
   */
  // At the boundary, before the service is reached: a refused caller learns
  // nothing about the company's people. The service asserts again itself.

  /**
   * Restores an ordinarily archived company. Active again ONLY in the same
   * transaction that leaves it with an eligible manager. A refusal is a 409
   * with stable blocker codes, raised after the transaction — and its blocked
   * audit row — has committed.
   */
}
