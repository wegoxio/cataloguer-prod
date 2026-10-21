import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LockMode } from '@mikro-orm/core';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityDTO, EntityManager, EntityRepository, QueryOrder, wrap } from '@mikro-orm/postgresql';
import { Organization } from './entities/organization.entity';
import { Store } from '../stores/entities/store.entity';
import { slugify } from '../imports/preview/woocommerce-mapper';
import { AuditLogService } from '../audit-log/audit-log.service';
import { Action, EntityType } from '../audit-log/entities/audit-log.entity';
import { Actor } from '../audit-log/types/actor.type';
import { CreateOrganizationDto, UpdateOrganizationDto } from './dto/organization.dto';
import {
  TENANT_LOOKUP_DEFAULT_LIMIT,
  TENANT_LOOKUP_MAX_LIMIT,
  type TenantLookupPage,
} from './dto/tenant-lookup-query.dto';
import { OrganizationPlanPolicy } from '../billing/plans/organization-plan-policy';
import { assertGlobalPlatform } from '../auth/tenancy/tenant-assertions';
import { ensureDefaultWarehouseIn } from '../inventory/locations/inventory-location-provisioning';
import { TenantScope } from '../auth/tenancy/tenant-scope';
import { PLANS } from '../stores/plans';
import { lockOrganizationAccess, lockUsers } from '../users/access/access-locks';

/** A company as the listing reports it, plus its live-branch count. */
export type OrganizationListing = EntityDTO<Organization> & { liveStoreCount: number };

@Injectable()
export class OrganizationsService {
  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: EntityRepository<Organization>,
    @InjectRepository(Store)
    private readonly storeRepository: EntityRepository<Store>,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * The company listing, with ONE truthful fact for action discovery (#294):
   * how many of the company's branches are LIVE — neither archived nor
   * removed. The Clients page shows "Remove company" on an active company only
   * when this is zero. It is counted with a statement, never read off the
   * `stores` relation: that relation is filtered (a removed branch is not
   * loaded) and nullable, so a count taken through it would be a count of
   * what the ORM happened to see. The number is advisory — the removal
   * preview and the removal transaction re-evaluate every blocker themselves.
   */
  async findAll(includeArchived = false): Promise<OrganizationListing[]> {
    const organizations = await this.organizationRepository.find(includeArchived ? {} : { archivedAt: null }, {
      orderBy: { createdAt: 'desc' },
    });
    if (organizations.length === 0) return [];
    const em = this.organizationRepository.getEntityManager() as EntityManager;
    const counted: { organizationId: string; n: number }[] = await em.execute(
      `select organization_id as "organizationId", count(*)::int as n
         from stores
        where organization_id in (?) and archived_at is null and removed_at is null /* removed_at: a live branch is neither archived nor removed */
        group by organization_id`,
      [organizations.map((o) => o.id)],
    );
    const liveStores = new Map(counted.map((row) => [row.organizationId, row.n]));
    return organizations.map((organization) => ({
      ...wrap(organization).toObject(),
      liveStoreCount: liveStores.get(organization.id) ?? 0,
    }));
  }

  async findById(id: string): Promise<Organization> {
    const organization = await this.organizationRepository.findOne({ id });
    if (!organization) throw new NotFoundException(`Organization with ID ${id} not found`);
    return organization;
  }

  async create(dto: CreateOrganizationDto, actor?: Actor): Promise<Organization> {
    if (!dto.name?.trim()) throw new BadRequestException('The organization needs a name');

    // #284: the organization and its default warehouse commit together. This
    // is the legacy single-step creator (`POST /organizations`), still a
    // supported route; a company it creates must be able to hold stock exactly
    // as one created by onboarding can, through the same shared rule and under
    // the same plan lock every custody writer takes.
    const em = this.organizationRepository.getEntityManager() as EntityManager;
    const plan = dto.plan || 'BASICO';
    // Plan Gratis is never created waiting for payment (owner decision).
    const billingStatus = OrganizationPlanPolicy.billingStatusFor(plan, dto.billingStatus || undefined, 'ACTIVE');
    const organization = await em.transactional(async (tem) => {
      const created = tem.create(Organization, {
        name: dto.name.trim(),
        slug: await this.uniqueSlug(dto.name),
        plan,
        billingStatus,
      } as any);
      await tem.persistAndFlush(created);
      await OrganizationPlanPolicy.lock(tem, created.id);
      await ensureDefaultWarehouseIn(tem, created.id);
      return created;
    });

    if (actor) {
      await this.auditLogService.recordAuditEntry(
        actor.id,
        actor.email,
        EntityType.ORGANIZATION,
        organization.id,
        Action.CREATE,
        null,
        `Created organization "${organization.name}"`,
        { organizationId: organization.id },
      );
    }
    return organization;
  }

  async update(id: string, dto: UpdateOrganizationDto, actor?: Actor): Promise<Organization> {
    if (dto.name !== undefined && !dto.name.trim()) throw new BadRequestException('The organization needs a name');
    const targetPlan = dto.plan === undefined ? undefined : PLANS[dto.plan];
    if (dto.plan !== undefined && !targetPlan) throw new BadRequestException(`Unknown plan: ${dto.plan}`);

    let before!: { name: string; plan: string; billingStatus: string };
    const audit = (tem: EntityManager, updated: Organization) =>
      this.auditLogService.recordAuditEntryIn(
        tem,
        actor?.id ?? null,
        actor?.email ?? null,
        EntityType.ORGANIZATION,
        updated.id,
        Action.UPDATE,
        { before, after: { name: updated.name, plan: updated.plan, billingStatus: updated.billingStatus } },
        `Updated organization "${updated.name}"`,
        { organizationId: updated.id },
      );
    const organization = await this.organizationRepository.getEntityManager().transactional(async (tem) => {
      let current = await tem.findOne(Organization, { id });
      if (!current) throw new NotFoundException(`Organization with ID ${id} not found`);
      const changingPlan = targetPlan !== undefined && dto.plan !== current.plan;
      if (changingPlan) {
        await OrganizationPlanPolicy.lock(tem, current.id);
        // Re-read under a row lock: checkout and the Stripe webhook write the
        // subscription id under this same lock pair, so the check below sees it.
        current = await tem.findOne(Organization, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true });
        if (!current) throw new NotFoundException(`Organization with ID ${id} not found`);
      }
      before = { name: current.name, plan: current.plan, billingStatus: current.billingStatus };

      if (changingPlan && targetPlan) {
        await OrganizationPlanPolicy.assertComplimentaryAssignable(tem, current, targetPlan.key);
        await OrganizationPlanPolicy.assertPlanChange(tem, current, targetPlan);
      }
      if (dto.name !== undefined) current.name = dto.name.trim();
      if (dto.plan !== undefined) current.plan = dto.plan;
      // A complimentary plan is always ACTIVE; any other plan keeps the requested
      // status, or its current one when none was sent.
      current.billingStatus = OrganizationPlanPolicy.billingStatusFor(
        current.plan,
        dto.billingStatus,
        current.billingStatus,
      );
      await tem.flush();
      // Audited in the SAME transaction (#318): a change that cannot be recorded
      // does not happen. The entry names plan and billing state, never a Stripe id.
      if (actor) await audit(tem, current);
      return current;
    });
    return organization;
  }

  /**
   * ARCHIVE MAKES A COMPANY OPERATIONALLY INACTIVE (#277 P2, owner decision 8),
   * and it does so under the canonical lock order every writer of manager
   * authority shares:
   *
   *   org-access → lifecycle:organization → organization row FOR UPDATE →
   *   member rows FOR UPDATE ascending → writes and audit.
   *
   * In one transaction: the branches are checked (archiving never strands a
   * live branch — archive them first, the rule since P0), the company is
   * archived, every member's refresh sessions are revoked, every member's
   * authentication generation advances (so any access or refresh token minted
   * before this moment is refused by the guard, and nothing resumes after a
   * later restoration), and every unused invitation or reset token is marked
   * used. Passwords and enrolled MFA stay: restoration needs nothing
   * re-enrolled and revives nothing — members sign in again. The audit row
   * commits with the change or not at all.
   *
   * Managers are NOT stripped: an archived company may hold zero active
   * managers, and restoration re-imposes the invariant
   * (`OrganizationActivationService`). Already archived → idempotent no-op.
   */
  /**
   * Archives a company: operationally inactive, in one transaction (#277 P2).
   *
   * UNSCOPED PLATFORM AUTHORITY ONLY, asserted here as well as at the
   * controller: the class-level role guard admits a Superadmin who has entered
   * a company through `X-Managed-Organization` or `X-Managed-Store`, and such
   * an actor may not archive. A refused caller loads nothing: the assertion
   * runs before the first read.
   *
   * ORDER OF WRITES, AND WHY IT MATTERS. The database guard
   * (`Migration20260913140000`) refuses every operational write under an
   * archived company, `users` included. The member bookkeeping — sessions
   * revoked, generations advanced, unused tokens spent — is therefore written
   * BEFORE `archived_at` is stamped, so that in this transaction's own view
   * the company is still active while its people are being signed out. Commit
   * makes the two visible together; nothing outside sees one without the
   * other.
   */
  async archive(scope: TenantScope | undefined, id: string, actor?: Actor): Promise<Organization> {
    assertGlobalPlatform(scope, 'Archiving an organization');
    const em = this.organizationRepository.getEntityManager() as EntityManager;
    await em.transactional(async (tem) => {
      await lockOrganizationAccess(tem, id);
      const rows: { id: string; name: string; archived_at: Date | null; removedAt?: Date | null }[] = await tem.execute(
        `select id, name, archived_at, removed_at as "removedAt"
           from organizations where id = ?::uuid for update /* removed_at: read in every state; a removed company is not on this surface */`,
        [id],
      );
      const locked = rows[0];
      // #294: a removed company belongs to Recovery; on this surface it is not found.
      if (!locked || locked.removedAt) throw new NotFoundException(`Organization with ID ${id} not found`);
      if (locked.archived_at) return;
      const liveStores = await tem.count(Store, { organization: id, archivedAt: null });
      if (liveStores > 0) {
        throw new BadRequestException(`Archive this organization's ${liveStores} active store(s) first`);
      }
      // Every member, in every lifecycle state: a removed member's generation
      // advancing is harmless and keeps the statement uniform.
      const members: { id: string }[] = await tem.execute(
        `select id from users where organization_id = ?::uuid order by id /* removed_at: all members, by design */`,
        [id],
      );
      const memberIds = members.map((m) => m.id);
      await lockUsers(tem, memberIds);
      let revokedSessions = 0;
      let invalidatedTokens = 0;
      if (memberIds.length) {
        revokedSessions = Number(
          (
            await tem.execute(
              `with done as (update refresh_tokens set revoked_at = now() where user_id in (?) and revoked_at is null returning 1)
             select count(*)::int as n from done`,
              [memberIds],
            )
          )[0]?.n ?? 0,
        );
        await tem.execute(
          `update users set auth_generation = auth_generation + 1 where organization_id = ?::uuid /* removed_at: all members, by design */`,
          [id],
        );
        invalidatedTokens = Number(
          (
            await tem.execute(
              `with done as (update password_reset_tokens set used_at = now() where user_id in (?) and used_at is null returning 1)
             select count(*)::int as n from done`,
              [memberIds],
            )
          )[0]?.n ?? 0,
        );
      }
      // The stamp LAST: from here on, this company's rows refuse every writer.
      await tem.execute(
        `update organizations set archived_at = now(), updated_at = now() where id = ?::uuid /* removed_at: refused above under the lock */`,
        [id],
      );
      if (actor) {
        await this.auditLogService.recordAuditEntryIn(
          tem,
          actor.id,
          actor.email,
          EntityType.ORGANIZATION,
          id,
          Action.ARCHIVE,
          { members: memberIds.length, revokedSessions, invalidatedTokens, generationsAdvanced: memberIds.length },
          `Archived organization "${locked.name}"`,
          { organizationId: id },
        );
      }
    });
    return this.findById(id);
  }

  /** Stores belonging to one organization. The tenant boundary in practice. */
  async findStores(organizationId: string, includeArchived = false): Promise<Store[]> {
    await this.findById(organizationId);
    return this.storeRepository.find(
      { organization: organizationId, ...(includeArchived ? {} : { archivedAt: null }) },
      { orderBy: { createdAt: 'desc' } },
    );
  }

  /**
   * COMPANIES FOR A SELECTOR — bounded, searchable, deterministically ordered.
   *
   * `findAll` above answers with every organization and is what the management
   * screens use; this is what a PICKER uses. The difference is not cosmetic: a
   * picker's cost must not grow with the customer base, and nothing in the
   * product caps how many client companies exist.
   *
   * ORDERED BY NAME, then id. A picker ordered by creation date asks the
   * operator to know when a company was signed up in order to find it; the id
   * breaks ties so the same search never returns a different slice.
   *
   * `total` is the count of everything that MATCHES, not the count returned, so
   * the caller can tell the operator that there is more to narrow toward.
   *
   * FAILS CLOSED ON THE RESOLVED SCOPE, not on the role name — the same
   * condition `listPlatformUsers` applies, through the same function. This
   * exists to feed an unscoped-only screen; a platform administrator acting
   * inside a managed company is refused rather than answered.
   */
  async lookup(scope: TenantScope | undefined, search?: string, limit?: number): Promise<TenantLookupPage> {
    assertGlobalPlatform(scope, 'The company lookup');
    const size = this.lookupSize(limit);
    const where: Record<string, unknown> = { archivedAt: null };
    const term = search?.trim();
    if (term) where.name = { $ilike: `%${term}%` };

    const [rows, total] = await this.organizationRepository.findAndCount(where, {
      orderBy: [{ name: QueryOrder.ASC }, { id: QueryOrder.ASC }],
      limit: size,
    });
    return this.lookupPage(rows, total, size);
  }

  /**
   * ONE COMPANY'S BRANCHES, bounded the same way — because the plan does not
   * bound them. `PLANS.CORPORATIVO.maxWebsites` is `null` and
   * `assertWebsiteSlot` returns early on null, so a corporate client's branch
   * count has no enforced ceiling anywhere in the product.
   *
   * Unknown or archived company: 404 from `findById`, exactly as
   * `findStores` does. An empty list would say "this company has no branches"
   * about a company that does not exist.
   *
   * Same unscoped-platform requirement as the company lookup, and applied
   * BEFORE the company is resolved.
   */
  async lookupStores(
    scope: TenantScope | undefined,
    organizationId: string,
    search?: string,
    limit?: number,
  ): Promise<TenantLookupPage> {
    // AUTHORITY FIRST, then existence. Checking the company before the actor
    // would let a scoped administrator tell an existing company from a
    // nonexistent one by the difference between 404 and 403.
    assertGlobalPlatform(scope, 'The branch lookup');
    await this.findById(organizationId);
    const size = this.lookupSize(limit);
    const where: Record<string, unknown> = { organization: organizationId, archivedAt: null };
    const term = search?.trim();
    if (term) where.name = { $ilike: `%${term}%` };

    const [rows, total] = await this.storeRepository.findAndCount(where, {
      orderBy: [{ name: QueryOrder.ASC }, { id: QueryOrder.ASC }],
      limit: size,
    });
    return this.lookupPage(rows, total, size);
  }

  /**
   * The ceiling, enforced in the SERVICE and not only in the DTO. Validation
   * guards the HTTP route; this guards every caller, including a future one
   * that does not pass through a pipe.
   */
  private lookupSize(limit?: number): number {
    if (!limit || !Number.isFinite(limit)) return TENANT_LOOKUP_DEFAULT_LIMIT;
    return Math.min(TENANT_LOOKUP_MAX_LIMIT, Math.max(1, Math.floor(limit)));
  }

  /** Id and name only: a picker has no business receiving plans or billing state. */
  private lookupPage(rows: { id: string; name: string }[], total: number, limit: number): TenantLookupPage {
    return {
      items: rows.map((row) => ({ id: row.id, name: row.name })),
      total,
      limit,
      truncated: total > rows.length,
    };
  }

  /** Slugs are globally unique; suffix until free. */
  private async uniqueSlug(name: string): Promise<string> {
    const base = slugify(name) || 'organizacion';
    let candidate = base;
    let n = 2;
    while (await this.organizationRepository.findOne({ slug: candidate })) {
      candidate = `${base}-${n}`;
      n += 1;
    }
    return candidate;
  }
}
