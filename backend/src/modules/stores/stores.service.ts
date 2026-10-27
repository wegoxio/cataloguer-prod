import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, QueryOrder } from '@mikro-orm/postgresql';
import { Store } from './entities/store.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { User } from '../users/entities/user.entity';
import { LockMode } from '@mikro-orm/core';
import { DEFAULT_PLAN, effectiveBillingStatus, effectivePlanPriceUsd, PLANS, tenantOfferedPlans } from './plans';
import { CreateStoreDto, UpdateStoreDto } from './dto/store.dto';
import { AuditLogService } from '../audit-log/audit-log.service';
import { EntityType, Action } from '../audit-log/entities/audit-log.entity';
import { Actor } from '../audit-log/types/actor.type';
import {
  isOrganizationAdministrator,
  isUnscopedPlatform,
  scopeAllowsStore,
  TenantScope,
} from '../auth/tenancy/tenant-scope';
import { OrganizationPlanPolicy } from '../billing/plans/organization-plan-policy';
import { ensureStoreCustodyIn } from '../inventory/locations/inventory-location-provisioning';

// Paid add-ons a company can buy; each unlocks a navbar module

// Standard modules a company may hide from its own sidebar (Settings →
// Customization). Core modules (Items, Categories, Sales…) are not listed:
// hiding those would break the product.
const HIDEABLE_MODULES = ['IMPORT_EXPORT', 'AUDIT_LOG'];

@Injectable()
export class StoresService {
  constructor(
    @InjectRepository(Store)
    private readonly storeRepository: EntityRepository<Store>,
    private readonly auditLogService: AuditLogService,
  ) {}

  /** The client owning a store; billing fields live there since P0-09. */
  private orgOf(store: any): any {
    return store?.organization ?? null;
  }

  // ---------------------------------------------------------------------
  // P5-A2 family 2 — authority derives from the resolved TenantScope and from
  // NOTHING else. `Actor` survives only as the audit actor's identity; it is
  // never an authorization input here again. The old `assertTenant` checked
  // `actor.store` and therefore passed unconditionally for ANY store-less
  // actor, so widening ORGANIZATION_MANAGER onto it would have granted every
  // organization's stores. Refusals are 404-shaped for resources (no existence
  // oracle) and 403 for authority.
  // ---------------------------------------------------------------------

  /** The organization a scope may act inside; null means "all" (platform). */
  private organizationScopeOf(scope?: TenantScope): string | null {
    if (isUnscopedPlatform(scope)) return null;
    const organizationId = scope?.organizationId;
    if (typeof organizationId !== 'string' || organizationId.length === 0) {
      throw new ForbiddenException('Access denied: no organization in scope');
    }
    return organizationId;
  }

  private notFound(storeId: string): never {
    throw new NotFoundException(`Store with ID ${storeId} not found`);
  }

  /** Pre-load: the scope must name an organization and allow this branch. */
  private assertStoreInScope(storeId: string, scope?: TenantScope): void {
    if (isUnscopedPlatform(scope)) return;
    if (!scope) throw new ForbiddenException('Access denied: no tenant scope resolved');
    this.organizationScopeOf(scope);
    if (!scopeAllowsStore(scope, storeId)) this.notFound(storeId);
  }

  /**
   * Post-load: the STORED organization must be the scope's own. Defence in
   * depth — a stale `allowedStoreIds` cannot outlive the row it describes.
   */
  private assertLoadedStoreInScope(store: Store, scope?: TenantScope): void {
    if (isUnscopedPlatform(scope)) return;
    const organizationId = this.organizationScopeOf(scope);
    if (this.orgOf(store)?.id !== organizationId) this.notFound(store.id);
  }

  /** True for an actor that holds organization authority when un-narrowed. */
  private holdsOrganizationAuthority(scope?: TenantScope): boolean {
    const role = scope?.role;
    if (role === 'ORGANIZATION_MANAGER') return true;
    return scope?.platform === true && role === 'SUPER_ADMIN';
  }

  /**
   * Structure: create/update/archive/restore (§12 — ADMIN holds none).
   *
   * D-E: narrowing RESTRICTS and never expands. A narrowed organization actor
   * keeps its powers over the branch it selected and loses them everywhere
   * else; a store-level role never had them at all.
   */
  private assertCoreStoreAuthority(storeId: string, scope?: TenantScope): void {
    if (isUnscopedPlatform(scope)) return;
    if (!scope) throw new ForbiddenException('Access denied: no tenant scope resolved');
    if (!this.holdsOrganizationAuthority(scope)) {
      throw new ForbiddenException('Access denied: managing stores is an organization-level operation');
    }
    const narrowedTo = scope.storeId;
    if (typeof narrowedTo === 'string' && narrowedTo.length > 0 && narrowedTo !== storeId) {
      this.notFound(storeId);
    }
    this.assertStoreInScope(storeId, scope);
  }

  /** Creating a branch is organization-level and never possible from inside one. */
  private assertStoreCreationAuthority(scope?: TenantScope): void {
    if (isUnscopedPlatform(scope)) return;
    if (!this.holdsOrganizationAuthority(scope)) {
      throw new ForbiddenException('Access denied: creating stores is an organization-level operation');
    }
    if (!isOrganizationAdministrator(scope)) {
      throw new BadRequestException(
        'Leave the branch context before adding a store: a new store belongs to the organization, not to the branch you are working inside',
      );
    }
  }

  /**
   * Website content and pop-ups. NARROWING BINDS HERE TOO — the branch
   * selector is a restriction of what the actor may touch, not merely a
   * display filter:
   *
   *   unscoped SUPER_ADMIN ................................ every store
   *   un-narrowed OM / SUPER_ADMIN in a managed organization every store of it
   *   narrowed OM / SUPER_ADMIN ........................... the selected store
   *   ADMIN ............................................... its exact branch
   *
   * The subscription is the deliberate exception to this rule: it describes
   * the ORGANIZATION, so narrowing does not change its answer.
   */
  /**
   * #174 media authority, stated explicitly. A store-less organization actor
   * must NEVER fall into the platform branch: no store and platform authority
   * are different things.
   */
  async findAll(includeArchived = false, scope?: TenantScope): Promise<Store[]> {
    const where: Record<string, unknown> = includeArchived ? {} : { archivedAt: null };
    const organizationId = this.organizationScopeOf(scope);
    // P0-11: inside a company context the list is that company's branches,
    // so every frontend selector shows only allowed stores by construction
    if (organizationId) where.organization = organizationId;
    // A narrowed actor sees the branch it selected, nothing beside it
    if (organizationId && scope?.storeId) where.id = scope.storeId;
    return this.storeRepository.find(where, {
      orderBy: { createdAt: QueryOrder.ASC },
    });
  }

  async findById(id: string): Promise<Store> {
    const store = await this.storeRepository.findOne({ id }, { populate: ['organization'] as never });
    if (!store) {
      throw new NotFoundException(`Store with ID ${id} not found`);
    }
    return store;
  }

  /**
   * Current plan + usage of the ORGANIZATION (the My subscription card).
   *
   * A Cataloguer subscription belongs to a client organization, never to one
   * of its branches — `plan`, `stripeSubscriptionId` and `billingStatus` all
   * live on Organization. `scope.storeId` is therefore deliberately UNREAD:
   * narrowing to a branch must not change which subscription is described.
   *
   * The unscoped platform owner is not a paying tenant and keeps the minimal
   * historical placeholder; the global platform dashboard is a separate,
   * out-of-scope surface and nothing here anticipates it.
   */
  async getSubscription(scope?: TenantScope) {
    const organizationId = this.organizationScopeOf(scope);
    if (organizationId === null) {
      return { platformOwner: true, status: 'ACTIVE' };
    }
    const em = this.storeRepository.getEntityManager();
    const organization = await em.findOne(Organization, { id: organizationId });
    if (!organization) {
      throw new ForbiddenException('Access denied: organization in scope no longer exists');
    }
    const plan = PLANS[(organization as any).plan] ?? PLANS[DEFAULT_PLAN];
    const teamUsers = await em.count(User, { organization: organizationId, deletedAt: null });
    const websites = await this.storeRepository.count({ organization: organizationId, archivedAt: null });
    return {
      platformOwner: false,
      status: 'ACTIVE',
      // A tenant sees only the plans it may choose: never Plan Gratis, which the
      // platform owner assigns. A company already on it is told so instead.
      plans: tenantOfferedPlans(),
      stripeManaged: Boolean((organization as any).stripeSubscriptionId),
      planManagedByPlatform: plan.complimentary,
      plan: {
        key: plan.key,
        name: plan.name,
        priceUsd: effectivePlanPriceUsd(plan, organization),
        complimentary: plan.complimentary,
      },
      usage: {
        teamUsers,
        maxTeamUsers: plan.maxTeamUsers,
        websites,
        maxWebsites: plan.maxWebsites,
      },
    };
  }

  /**
   * Owner-only control panel: every client company with its plan, modules,
   * team size, catalog size, this month's sales and payment history — one
   * grouped query per table, never per store.
   */
  async getOwnerOverview() {
    const em = this.storeRepository.getEntityManager();
    // #294: a REMOVED company's branches leave the Clients overview explicitly —
    // the relation is nullable, so the company filter alone would keep the rows.
    const companies = await em.find(Organization, {}, { orderBy: { createdAt: QueryOrder.ASC } });
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const connection = em.getConnection();
    const [storeRows, userRows, orderRows, paymentRows, productRows, categoryRows] = await Promise.all([
      connection.execute(
        `SELECT organization_id, count(*)::int AS stores,
                count(*) FILTER (WHERE archived_at IS NULL)::int AS active_stores,
                (array_agg(website_url ORDER BY created_at) FILTER (WHERE archived_at IS NULL AND website_url IS NOT NULL))[1] AS website_url
           FROM stores WHERE removed_at IS NULL AND organization_id IS NOT NULL GROUP BY organization_id`,
      ),
      connection.execute(
        // ONE literal, deliberately: the query-surface census reads statements,
        // and a statement split across concatenated strings is a statement it
        // cannot reason about.
        `SELECT organization_id, count(*)::int AS users FROM users
          WHERE deleted_at IS NULL AND removed_at IS NULL AND organization_id IS NOT NULL
          GROUP BY organization_id`,
      ),
      connection.execute(
        `SELECT organization_id,
                count(*) FILTER (WHERE created_at >= ?)::int AS month_orders,
                coalesce(sum(total_usd) FILTER (WHERE created_at >= ? AND status <> 'CANCELLED'), 0)::float AS month_revenue,
                max(created_at) AS last_order_at
           FROM sales_orders WHERE organization_id IS NOT NULL GROUP BY organization_id`,
        [monthStart, monthStart],
      ),
      connection.execute(
        `SELECT s.organization_id, coalesce(sum(p.amount_usd), 0)::float AS total_paid,
                max(p.paid_at) AS last_payment_at
           FROM payments p JOIN stores s ON s.id = p.store_id
          WHERE p.status = 'PAID' AND s.organization_id IS NOT NULL GROUP BY s.organization_id`,
      ),
      connection.execute(
        // #292: a branch's item count excludes removed items. The pivot row is
        // retained with its item, so counting the pivot alone would keep
        // reporting stock a branch cannot see.
        `SELECT organization_id, count(*)::int AS products FROM products
          WHERE removed_at IS NULL AND organization_id IS NOT NULL GROUP BY organization_id`,
      ),
      connection.execute(
        `SELECT organization_id, count(*)::int AS categories FROM categories
          WHERE removed_at IS NULL AND organization_id IS NOT NULL GROUP BY organization_id`,
      ),
    ]);

    const byOrganization = <T extends { organization_id: string }>(rows: T[]) =>
      new Map(rows.map((row) => [row.organization_id, row]));
    const stores = byOrganization(storeRows as any[]);
    const users = byOrganization(userRows as any[]);
    const orders = byOrganization(orderRows as any[]);
    const payments = byOrganization(paymentRows as any[]);
    const products = byOrganization(productRows as any[]);
    const categories = byOrganization(categoryRows as any[]);

    const clients = companies.map((organization) => {
      const plan = PLANS[organization.plan] ?? PLANS[DEFAULT_PLAN];
      return {
        id: organization.id,
        organizationId: organization.id,
        name: organization.name,
        slug: organization.slug,
        websiteUrl: (stores.get(organization.id) as any)?.website_url ?? null,
        plan: {
          key: plan.key,
          name: plan.name,
          priceUsd: effectivePlanPriceUsd(plan, organization),
          complimentary: plan.complimentary,
        },
        billingStatus: effectiveBillingStatus(organization),
        archivedAt: organization.archivedAt ?? null,
        organizationArchivedAt: organization.archivedAt ?? null,
        organizationMergedIntoId: organization.mergedIntoOrganizationId ?? null,
        createdAt: organization.createdAt,
        storesCount: (stores.get(organization.id) as any)?.stores ?? 0,
        activeStoresCount: (stores.get(organization.id) as any)?.active_stores ?? 0,
        usersCount: (users.get(organization.id) as any)?.users ?? 0,
        productsCount: (products.get(organization.id) as any)?.products ?? 0,
        categoriesCount: (categories.get(organization.id) as any)?.categories ?? 0,
        ordersThisMonth: (orders.get(organization.id) as any)?.month_orders ?? 0,
        revenueThisMonth: (orders.get(organization.id) as any)?.month_revenue ?? 0,
        lastOrderAt: (orders.get(organization.id) as any)?.last_order_at ?? null,
        totalPaid: (payments.get(organization.id) as any)?.total_paid ?? 0,
        lastPaymentAt: (payments.get(organization.id) as any)?.last_payment_at ?? null,
      };
    });

    const active = clients.filter((client) => !client.archivedAt && !client.organizationMergedIntoId);
    // RECURRING REVENUE IS PER COMPANY (#318). A plan belongs to a company, so
    // each live company is counted EXACTLY ONCE — with no branch, one, or many —
    // at its effective price; Plan Gratis and a contractual $0 add nothing.
    // Summing the branch rows above counted a company once per branch and
    // never counted a company without a branch. The removal filter is on, so a
    // removed company is excluded; archived and merged companies are excluded
    // explicitly. Every other total keeps its meaning.
    const recurringCompanies = companies.filter((company) => !company.archivedAt && !company.mergedIntoOrganizationId);
    const monthlyRecurringUsd = recurringCompanies.reduce(
      (sum, company) => sum + (effectivePlanPriceUsd(PLANS[company.plan] ?? PLANS[DEFAULT_PLAN], company) ?? 0),
      0,
    );
    return {
      totals: {
        activeClients: active.length,
        monthlyRecurringUsd,
        recurringCompanies: recurringCompanies.length,
        ordersThisMonth: active.reduce((sum, client) => sum + client.ordersThisMonth, 0),
        revenueThisMonth: active.reduce((sum, client) => sum + client.revenueThisMonth, 0),
      },
      clients,
      plans: Object.values(PLANS),
    };
  }

  /** Owner-only: moves a client's website to another commercial plan. */
  async setPlan(id: string, planKey: string, actor?: Actor): Promise<Store> {
    if (!PLANS[planKey]) {
      throw new BadRequestException(`Unknown plan '${planKey}'`);
    }
    const em = this.storeRepository.getEntityManager();
    const result = await em.transactional(async (tem) => {
      const store = await tem.findOne(Store, { id }, { populate: ['organization'] as never });
      if (!store) throw new NotFoundException(`Store with ID ${id} not found`);
      const organization = this.orgOf(store);
      if (!organization) throw new BadRequestException('This store belongs to no organization');
      await OrganizationPlanPolicy.lock(tem, organization.id);
      // Row lock + refresh: checkout and the Stripe webhook write the
      // subscription id under this same lock pair.
      const locked = await tem.findOne(
        Organization,
        { id: organization.id },
        { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
      );
      if (!locked) throw new BadRequestException('This store belongs to no organization');
      await OrganizationPlanPolicy.assertComplimentaryAssignable(tem, locked, planKey);
      await OrganizationPlanPolicy.assertPlanChange(tem, locked, PLANS[planKey]);
      const before = locked.plan;
      const statusBefore = locked.billingStatus;
      locked.plan = planKey;
      locked.billingStatus = OrganizationPlanPolicy.billingStatusFor(planKey, undefined, locked.billingStatus);
      await tem.flush();
      // Audited in the SAME transaction (#318): a change that cannot be recorded does not happen.
      await this.auditLogService.recordAuditEntryIn(
        tem,
        actor?.id ?? null,
        actor?.email ?? null,
        EntityType.STORE,
        store.id,
        Action.UPDATE,
        {
          plan: { before, after: planKey },
          ...(statusBefore !== locked.billingStatus
            ? { billingStatus: { before: statusBefore, after: locked.billingStatus } }
            : {}),
        },
        `Changed plan of "${store.name}" from ${before} to ${planKey}`,
        { organizationId: locked.id ?? null, storeId: store.id },
      );
      return { store, organization: locked, before, statusBefore };
    });
    return result.store;
  }

  /** Owner-only: turns a client's paid add-ons (navbar modules) on/off. */
  /** Content blocks of a website (Builder-editable site copy). */
  // #174: typed IMAGE blocks must reference this catalog's own storage.
  // Every other type (TEXT, COLOR, FLAG, absent-defaulting-to-TEXT…) keeps
  // its behavior untouched — the type contract itself is #173 territory.
  /** Removes a content override: the website falls back to its original text. */
  async create(dto: CreateStoreDto, scope?: TenantScope, actor?: Actor): Promise<Store> {
    this.assertStoreCreationAuthority(scope);
    // P0-01: a branch with no client is exactly the ambiguity Organization
    // exists to remove, so refuse to create one. Existing stores are given an
    // organization by the backfill in #192.
    if (!dto.organizationId) {
      throw new BadRequestException('A store must belong to an organization');
    }
    // Organization wall: the requested owner must be the scope's own company.
    // Without this, widening ORGANIZATION_MANAGER would let it plant a store
    // inside another client's organization by naming that id in the body.
    const organizationScope = this.organizationScopeOf(scope);
    if (organizationScope !== null && dto.organizationId !== organizationScope) {
      throw new ForbiddenException('Access denied: a store may only be created inside your own organization');
    }
    const em = this.storeRepository.getEntityManager();
    const { store, organization } = await em.transactional(async (tem) => {
      const organization = await OrganizationPlanPolicy.requireOrganization(tem, dto.organizationId!);
      await OrganizationPlanPolicy.lock(tem, organization.id);
      await OrganizationPlanPolicy.assertWebsiteSlot(tem, organization);

      const { slugify } = await import('../imports/preview/woocommerce-mapper');
      let autoSlug = slugify(dto.name || '');
      let slugSuffix = 2;
      /**
       * THE PROBE MUST SEE REMOVED STORES TOO (#293).
       *
       * `stores_slug_unique` is TOTAL — Slice D deliberately does not make it
       * partial, because the brief requires a removed store to keep its web
       * address reserved. So a removed store still HOLDS its slug at the
       * database level while the default-on removal filter hides it from this
       * read. Without `INCLUDING_REMOVED` the loop would conclude the slug is
       * free, hand it to the insert below, and turn store creation into a raw
       * unique violation with no explanation — a creation-path regression
       * caused by a removal-path change.
       *
       * Cap the search: beyond 50 collisions fall back to a time suffix.
       */
      while (autoSlug && slugSuffix <= 50 && (await tem.findOne(Store, { slug: autoSlug }))) {
        autoSlug = `${slugify(dto.name)}-${slugSuffix++}`;
      }
      if (slugSuffix > 50) autoSlug = `${slugify(dto.name)}-${Date.now().toString(36)}`;

      const store = tem.create(Store, {
        name: dto.name,
        slug: autoSlug,
        websiteUrl: dto.websiteUrl ? dto.websiteUrl.replace(/\/+$/, '') : undefined,
        websiteProductPath: dto.websiteProductPath || '/products/{slug}',
        websiteCategoryPath: dto.websiteCategoryPath || '/categories/{slug}',
        organization,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      await tem.persistAndFlush(store);
      // #284: a branch that exists has a custody location, at the one boundary
      // every supported store creation passes through — this transaction,
      // under the plan lock it already holds. Onboarding's initial store takes
      // the same path through the same shared rules.
      await ensureStoreCustodyIn(tem as never, organization.id, { id: store.id, name: store.name });
      return { store, organization };
    });

    await this.auditLogService.recordAuditEntry(
      actor?.id ?? null,
      actor?.email ?? null,
      EntityType.STORE,
      store.id,
      Action.CREATE,
      null,
      `Created store "${store.name}"`,
      { organizationId: (organization as any)?.id ?? (organization as any) ?? null, storeId: store.id },
    );
    return store;
  }

  async update(id: string, dto: UpdateStoreDto, scope?: TenantScope, actor?: Actor): Promise<Store> {
    this.assertCoreStoreAuthority(id, scope);
    const store = await this.findById(id);
    this.assertLoadedStoreInScope(store, scope);

    // #174: image URLs must reference this catalog's own storage. Only
    // non-empty values are checked — omitted keeps the field, '' clears it
    // (the established contract, preserved below by `|| undefined`).
    if (dto.hiddenModules !== undefined) {
      const unknown = dto.hiddenModules.find((key) => !HIDEABLE_MODULES.includes(key));
      if (unknown) {
        throw new BadRequestException(`Module '${unknown}' cannot be hidden`);
      }
    }

    // Field-level diff: no-op saves create NO audit entry, real ones say
    // exactly which fields changed (before/after in the changes payload)
    const changes: Record<string, { before: unknown; after: unknown }> = {};
    const clip = (value: unknown) =>
      typeof value === 'string' && value.length > 120 ? value.slice(0, 120) + '…' : value;
    const apply = (field: string, next: unknown) => {
      const before = (store as any)[field];
      if (JSON.stringify(before ?? null) === JSON.stringify(next ?? null)) return;
      changes[field] = { before: clip(before ?? null), after: clip(next ?? null) };
      (store as any)[field] = next;
    };

    // Slug edits ignored: system-owned
    if (dto.name !== undefined) apply('name', dto.name);
    if (dto.hiddenModules !== undefined) apply('hiddenModules', [...new Set(dto.hiddenModules)]);
    if (dto.contactEmail !== undefined) apply('contactEmail', dto.contactEmail || undefined);
    if (dto.contactPhone !== undefined) apply('contactPhone', dto.contactPhone || undefined);
    if (dto.contactAddress !== undefined) apply('contactAddress', dto.contactAddress || undefined);
    if (dto.websiteUrl !== undefined) {
      apply('websiteUrl', dto.websiteUrl ? dto.websiteUrl.replace(/\/+$/, '') : undefined);
    }
    if (dto.websiteProductPath !== undefined) {
      apply('websiteProductPath', dto.websiteProductPath || '/products/{slug}');
    }
    if (dto.websiteCategoryPath !== undefined) {
      apply('websiteCategoryPath', dto.websiteCategoryPath || '/categories/{slug}');
    }

    const changedFields = Object.keys(changes);
    if (changedFields.length === 0) {
      return store; // nothing changed: no flush, no audit noise
    }
    await this.storeRepository.getEntityManager().flush();

    // The company label on users is denormalized (stamped at invite time);
    // a store rename must reach it or the old name lingers in the panel
    if (changes.name) {
      await this.storeRepository.getEntityManager().nativeUpdate(User, { store: store.id }, { company: store.name });
    }

    await this.auditLogService.recordAuditEntry(
      actor?.id ?? null,
      actor?.email ?? null,
      EntityType.STORE,
      store.id,
      Action.UPDATE,
      changes,
      `Updated store "${store.name}": ${changedFields.join(', ')}`,
      { organizationId: this.orgOf(store)?.id ?? null, storeId: store.id },
    );

    return store;
  }

  /** Every pop-up this store has run, newest first (Pop-ups tab history). */
  /** Copies a past pop-up back onto the store and turns it on. */
  // #174: historical snapshots must not smuggle a pre-policy external image
  // back onto the store — reactivation re-validates like any other write
  // Re-publishing a past pop-up is a NEW use: an archived image is refused
  // here rather than silently going live again.
  // A past end date would keep it invisible — re-activate open-ended instead
  /** Removes a pop-up from the history. If it's the live one, also turns it off. */
  // If this snapshot is the one currently live, take it down with it

  async archive(id: string, scope?: TenantScope, actor?: Actor): Promise<Store> {
    this.assertCoreStoreAuthority(id, scope);
    const store = await this.findById(id);
    this.assertLoadedStoreInScope(store, scope);
    if (store.archivedAt) {
      throw new BadRequestException('Store is already archived');
    }
    /**
     * A COMPANY MAY ARCHIVE ITS LAST ACTIVE BRANCH (owner decision, #293).
     *
     * This used to count the company's active stores and refuse at one, on the
     * reasoning that a client should never be left without a channel. The owner
     * has retired that rule: a store-less organization is a VALID state. The
     * company stays active, its Organization Managers keep company-wide access,
     * and every store-dependent surface says truthfully that there is no branch
     * rather than quietly selecting one.
     *
     * DELETED RATHER THAN NARROWED, because Slice D also lets the final branch
     * be REMOVED. Keeping the refusal here would have left two adjacent
     * lifecycle operations disagreeing about whether zero branches is legal —
     * reachable by removing, refused by archiving — which is the kind of
     * inconsistency that survives for years because each half looks right on its
     * own. The 400 it produced is gone from the API contract deliberately; see
     * ADR 022 §2.
     *
     * The organization is still required: a store belonging to no company has
     * no owner to be archived on behalf of, and that is a different fault.
     */
    const organization = this.orgOf(store);
    if (!organization) {
      throw new BadRequestException('This store belongs to no organization');
    }

    store.archivedAt = new Date();
    await this.storeRepository.getEntityManager().flush();
    await this.auditLogService.recordAuditEntry(
      actor?.id ?? null,
      actor?.email ?? null,
      EntityType.STORE,
      store.id,
      Action.ARCHIVE,
      null,
      `Archived store "${store.name}"`,
      { organizationId: this.orgOf(store)?.id ?? null, storeId: store.id },
    );
    return store;
  }

  async restore(id: string, scope?: TenantScope, actor?: Actor): Promise<Store> {
    this.assertCoreStoreAuthority(id, scope);
    const loaded = await this.findById(id);
    this.assertLoadedStoreInScope(loaded, scope);
    if (!loaded.archivedAt) {
      throw new BadRequestException('Store is not archived');
    }
    const organizationId = this.orgOf(loaded)?.id;
    if (!organizationId) throw new BadRequestException('This store belongs to no organization');
    const store = await this.storeRepository.getEntityManager().transactional(async (tem) => {
      const organization = await OrganizationPlanPolicy.requireOrganization(tem, organizationId);
      await OrganizationPlanPolicy.lock(tem, organization.id);
      await OrganizationPlanPolicy.assertWebsiteSlot(tem, organization);
      const store = await tem.findOne(Store, { id });
      if (!store) throw new NotFoundException(`Store with ID ${id} not found`);
      if (!store.archivedAt) throw new BadRequestException('Store is not archived');
      store.archivedAt = undefined;
      await tem.flush();
      return store;
    });
    await this.auditLogService.recordAuditEntry(
      actor?.id ?? null,
      actor?.email ?? null,
      EntityType.STORE,
      store.id,
      Action.RESTORE,
      null,
      `Restored store "${store.name}"`,
      { organizationId: this.orgOf(store)?.id ?? null, storeId: store.id },
    );
    return store;
  }
}
