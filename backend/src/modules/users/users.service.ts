import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityManager, EntityRepository, QueryOrder } from '@mikro-orm/postgresql';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import * as argon2 from 'argon2';
import { User } from './entities/user.entity';
import { Role } from './entities/role.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { PasswordResetToken } from '../auth/entities/password-reset-token.entity';
import { Store } from '../stores/entities/store.entity';
import { Organization } from '../organizations/entities/organization.entity';
import { TenantScope } from '../auth/tenancy/tenant-scope';
import { assertGlobalPlatform, requireOrganizationScope, resolveScopedStoreTarget } from '../auth/tenancy/tenant-assertions';
import { ORGANIZATION_ROLE, PLATFORM_ROLE, bindingOfUser, roleBindingError, userBindingError } from './authorization/role-levels';
import { canonicalEmail, canonicalEmailKey } from './identity/email-identity';
import {
  AccessSnapshot,
  countActiveManagers,
  lockOrganizationAccess,
  lockUsers,
  sameAccess,
  snapshotOf,
} from './access/access-locks';
import { withMemberLockedForIssuance } from './access/credential-issuance';
import { AuditLogService } from '../audit-log/audit-log.service';
import { MailService } from '../mail/mail.service';
import { EntityType, Action } from '../audit-log/entities/audit-log.entity';
import { OrganizationPlanPolicy } from '../billing/plans/organization-plan-policy';
import { PLATFORM_USERS_DEFAULT_LIMIT, PLATFORM_USERS_MAX_LIMIT } from './dto/platform-users-query.dto';

// Higher number = more privileged. An actor may only manage users (and
// assign roles) strictly below their own level. Every role is listed on
// purpose (#156): an unlisted role would default to 0 and let a plain ADMIN
// manage an ORGANIZATION_MANAGER above it.
const ROLE_LEVEL: Record<string, number> = {
  SUPER_ADMIN: 5,
  ORGANIZATION_MANAGER: 4,
  ADMIN: 3,
  STORE_ADMIN: 3,
  EDITOR: 2,
  VIEWER: 1,
};

// PHASE 4 (requirement 5): the roles an ORGANIZATION_MANAGER may mint — the
// assignable store-bound roles strictly below its own level, nothing else.
// The model has no separate "employee" role; EDITOR and VIEWER are the staff
// tiers. SUPER_ADMIN and ORGANIZATION_MANAGER are refused by this whitelist
// before the level comparison even runs.
const OM_INVITABLE_ROLES = ['ADMIN', 'EDITOR', 'VIEWER'];

export interface ListUsersParams {
  /** Tenant boundary (Phase 4, C13); resolved from req.scope, never a header. */
  organizationScopeId?: string;
  storeScopeId?: string;
  search?: string;
  includeDeactivated?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
}

/** The platform directory's filters (#275). Authority is NOT a parameter. */
export interface PlatformUsersParams {
  page?: number;
  limit?: number;
  search?: string;
  organizationId?: string;
  storeId?: string;
  role?: string;
  status?: 'active' | 'deactivated' | 'all';
  invitation?: 'pending' | 'none' | 'all';
}

const SORTABLE_FIELDS = ['createdAt', 'email'];

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface InviteUserParams {
  email: string;
  roleName: string;
  company?: string;
  firstName?: string;
  lastName?: string;
  storeId?: string;
}

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: EntityRepository<User>,
    @InjectRepository(Role)
    private readonly roleRepository: EntityRepository<Role>,
    @InjectRepository(PasswordResetToken)
    private readonly resetTokenRepository: EntityRepository<PasswordResetToken>,
    private readonly auditLogService: AuditLogService,
    private readonly mailService: MailService,
    private readonly configService: ConfigService,
  ) {}

  // Both loaders populate everything the binding assertion and the billing
  // gate read (#156): role, store, the store's organization and the user's
  // own organization. A ManyToOne with a NULL column loads as null, so a
  // missing relation is genuinely "none", never an uninitialized reference.
  /**
   * RESOLVES A PERSON BY ADDRESS, under the one identity rule (#291).
   *
   * Compared through `lower(email)` — the SAME expression
   * `users_email_active_unique` is built on — so this lookup and the index can
   * never disagree about who holds an address. An exact-bytes comparison here
   * meant someone stored as `Person@Example.com` simply could not sign in, and
   * meant every "is this taken?" check built on this method answered no for an
   * address the index would have refused.
   *
   * At most one LIVE row can match, because the partial unique index says so.
   * Removed identities are excluded by the entity's default filter, which is
   * why removal frees an address for reuse in any capitalisation.
   */
  async findByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({ [canonicalEmailKey()]: canonicalEmail(email), deletedAt: null } as never, {
      populate: ['role', 'store', 'store.organization', 'organization'] as never,
    });
  }

  /**
   * Does ANY live identity hold this address, deactivated ones included?
   *
   * `findByEmail` deliberately skips deactivated users, because a deactivated
   * person must not be able to sign in. Creation and invitation ask a different
   * question — may this address be given to somebody new — and the answer is no
   * while a deactivated account still holds it, since the unique index counts
   * it and the insert would fail with a constraint error instead of a sentence.
   */
  async findLiveIdentityByEmail(email: string): Promise<User | null> {
    return this.userRepository.findOne({ [canonicalEmailKey()]: canonicalEmail(email) } as never);
  }

  /** The repository's entity manager, for boundary reads that need raw SQL (the JWT guard's lifecycle read). */
  entityManager(): EntityManager {
    return this.userRepository.getEntityManager() as EntityManager;
  }

  async findById(id: string): Promise<User | null> {
    return this.userRepository.findOne(
      { id, deletedAt: null },
      { populate: ['role', 'store', 'store.organization', 'organization'] as never },
    );
  }

  async findRoleByName(name: string): Promise<Role | null> {
    return this.roleRepository.findOne({ name });
  }

  /**
   * Creates a user INSIDE a store (#156): the organization is derived from
   * the store itself, so a caller cannot pass a mismatched pair, and the
   * binding is validated by the shared rules before anything persists.
   * Sole consumer today: the local-only /auth/register-dev endpoint.
   */
  async createUserInStore(params: {
    email: string;
    passwordHash: string;
    roleName: string;
    storeId: string;
  }): Promise<User> {
    const { passwordHash, roleName, storeId } = params;
    // One identity rule, applied at the door (#291).
    const email = canonicalEmail(params.email);
    const role = await this.findRoleByName(roleName);
    if (!role) {
      throw new BadRequestException(`Role ${roleName} does not exist`);
    }
    // Archived stores are indistinguishable from absent ones on purpose
    const store = await this.userRepository
      .getEntityManager()
      .findOne(Store, { id: storeId, archivedAt: null }, { populate: ['organization'] as never });
    if (!store) {
      throw new BadRequestException('Store not found');
    }
    const organization = (store as any).organization ?? null;
    const bindingError = roleBindingError(role.name, {
      organizationId: organization ? (organization.id ?? organization) : null,
      storeId: store.id,
      storeOrganizationId: organization ? (organization.id ?? organization) : null,
    });
    if (bindingError) {
      throw new BadRequestException(bindingError);
    }
    const em = this.userRepository.getEntityManager();
    return em.transactional(async (tem) => {
      await OrganizationPlanPolicy.lock(tem, organization.id);
      await OrganizationPlanPolicy.assertTeamUserSlot(tem, organization);
      const user = tem.create(User, {
        email,
        passwordHash,
        role,
        store,
        organization,
        company: store.name,
      });
      await tem.persistAndFlush(user);
      return user;
    });
  }

  toSafeUser(user: User) {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName ?? null,
      lastName: user.lastName ?? null,
      company: user.company ?? null,
      role: user.role.name,
      store: user.store ? { id: user.store.id, name: user.store.name } : null,
      // Phase 4 (C13): minimal ownership reference, shipped in the SAME change
      // that scopes the query by organization — never before it, which would
      // only have made the previous cross-company leak more informative.
      organization: user.organization ? { id: user.organization.id, name: user.organization.name } : null,
      // Invited but hasn't set a password through the onboarding link yet
      pendingInvite: !user.passwordHash,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      deactivatedAt: user.deletedAt ?? null,
    };
  }

  private assertCanManageRole(actor: User, targetRoleName: string, action: string) {
    const actorLevel = ROLE_LEVEL[actor.role.name] ?? 0;
    const targetLevel = ROLE_LEVEL[targetRoleName] ?? 0;
    if (targetLevel >= actorLevel) {
      throw new ForbiddenException(`Cannot ${action} a user with role ${targetRoleName}`);
    }
  }

  private async getManagedUser(scope: TenantScope | undefined, actor: User, id: string): Promise<User> {
    if (actor.id === id) {
      throw new BadRequestException('You cannot manage your own account from here');
    }
    // Loads everything a binding-aware validation needs (#156): role change
    // decisions must see the target's committed organization, store and the
    // store's own organization, not just the store id.
    const user = await this.userRepository.findOne(
      { id },
      { populate: ['role', 'store', 'store.organization', 'organization'] as never },
    );
    // P5-A2 family 6: the tenant wall is the RESOLVED SCOPE, not the actor's
    // own binding. `actor.store && user.store?.id !== actor.store.id` walled
    // nothing at all for a store-less actor — an organization manager or a
    // platform session could reach any user of any company by id. The company
    // is required, and a narrowed actor is held to its selected branch.
    const organizationId = requireOrganizationScope(scope);
    const narrowedTo = scope?.storeId;
    const targetOrganizationId = user?.organization?.id ?? (user?.store as any)?.organization?.id ?? null;
    const outsideCompany = !user || targetOrganizationId !== organizationId;
    const outsideBranch = typeof narrowedTo === 'string' && narrowedTo.length > 0 && user?.store?.id !== narrowedTo;
    if (outsideCompany || outsideBranch) {
      throw new NotFoundException('User not found');
    }
    this.assertCanManageRole(actor, user.role.name, 'manage');
    return user;
  }

  async findAll(params: ListUsersParams) {
    const { search, includeDeactivated = false, sortDirection = 'desc' } = params;
    const page = Math.max(1, params.page || 1);
    const limit = Math.min(100, Math.max(1, params.limit || 25));
    const sortBy = SORTABLE_FIELDS.includes(params.sortBy || '') ? params.sortBy! : 'createdAt';

    // PHASE 4 (C13): the company is the tenant boundary and is REQUIRED.
    //
    // Previously the only clause was `store`, taken from the actor's own
    // binding, so a store-less actor received EVERY company's users — and
    // `X-Managed-Organization` never reached this query. A branch actor still
    // sees only its own branch; a company actor sees the whole company.
    const where: Record<string, unknown> = {};
    if (!params.organizationScopeId) {
      throw new ForbiddenException(
        'Listing users requires an organization context; a platform administrator must supply X-Managed-Organization',
      );
    }
    where.organization = params.organizationScopeId;
    if (params.storeScopeId) {
      where.store = params.storeScopeId;
    }
    if (!includeDeactivated) {
      where.deletedAt = null;
    }
    if (search) {
      where.email = { $ilike: `%${search}%` };
    }

    const [items, total] = await this.userRepository.findAndCount(where, {
      // `organization` is populated so `toSafeUser` can attribute a STORE-LESS
      // row. Without it an ORGANIZATION_MANAGER — which has no store by
      // definition — carried no ownership information at all, and could not be
      // reconciled even in principle.
      populate: ['role', 'organization'],
      orderBy: { [sortBy]: sortDirection === 'asc' ? QueryOrder.ASC : QueryOrder.DESC },
      limit,
      offset: (page - 1) * limit,
    });

    return {
      items: items.map((user) => this.toSafeUser(user)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /**
   * THE PLATFORM-WIDE USER LISTING (#275).
   *
   * `findAll` above is the TENANT listing and requires a company; without one
   * it refuses. That refusal is correct and stays, which is precisely why an
   * unscoped platform owner has had no user surface at all — the gap #275
   * exists to close. So this is a second, separately authorised read rather
   * than a relaxation of the first.
   *
   * FAILS CLOSED ON THE RESOLVED SCOPE, not on the role name. `@Roles` keeps
   * every non-superadmin out; this keeps out a SUPER_ADMIN who is currently
   * acting INSIDE a company (`X-Managed-Organization`), because that actor is
   * asking as that company and must not receive the platform population by
   * sending one header fewer.
   *
   * ORDERING IS DETERMINISTIC AND TOTAL: `createdAt DESC, id ASC`. Sorting by a
   * timestamp alone is not a stable page boundary — two users created in the
   * same millisecond can swap between page 1 and page 2, showing one twice and
   * the other never. The id breaks every tie.
   */
  async listPlatformUsers(scope: TenantScope | undefined, params: PlatformUsersParams) {
    // The SAME assertion the two selector lookups make — see
    // `assertGlobalPlatform`. Stated once so the three Slice B reads cannot
    // drift apart, which is precisely how the lookups shipped without it.
    assertGlobalPlatform(scope, 'The platform user directory');

    const page = Math.max(1, params.page || 1);
    const limit = Math.min(PLATFORM_USERS_MAX_LIMIT, Math.max(1, params.limit || PLATFORM_USERS_DEFAULT_LIMIT));

    const where: Record<string, unknown> = {};
    if (params.organizationId) where.organization = params.organizationId;
    if (params.storeId) where.store = params.storeId;
    if (params.role) where.role = { name: params.role };

    // Three states, and "all" is a real choice rather than the absence of one:
    // a directory that could not show deactivated people would hide exactly the
    // rows an administrator is looking for.
    if (params.status === 'deactivated') where.deletedAt = { $ne: null };
    else if (params.status !== 'all') where.deletedAt = null;

    // `pendingInvite` is derived from `passwordHash` being absent — the same
    // derivation `toSafeUser` publishes — so the filter and the column can
    // never disagree.
    //
    // `none` means NO PENDING INVITATION, and nothing more. A password may have
    // been set by the person, by a password reset, or by an administrator
    // through `PATCH /users/:id/password`; the row cannot tell those apart, so
    // neither may the vocabulary. See `PLATFORM_INVITATION_STATES`.
    if (params.invitation === 'pending') where.passwordHash = null;
    else if (params.invitation === 'none') where.passwordHash = { $ne: null };

    const search = params.search?.trim();
    if (search) {
      const like = { $ilike: `%${search}%` };
      where.$or = [{ email: like }, { firstName: like }, { lastName: like }, { company: like }];
    }

    // #294 (owner decision 12): people of a REMOVED company leave the ordinary
    // directory. The relation is nullable, so the ORM filter alone keeps their
    // rows with a null company; the exclusion is stated here explicitly, and a
    // platform account (no company at all) is kept.
    const [items, total] = await this.userRepository.findAndCount(where, {
      populate: ['role', 'organization', 'store'],
      orderBy: [{ createdAt: QueryOrder.DESC }, { id: QueryOrder.ASC }],
      limit,
      offset: (page - 1) * limit,
    });

    return {
      // `toSafeUser` is the projection, deliberately: it is the one place that
      // decides what a user row may contain, and it has never contained a
      // password hash, a token or a token hash.
      items: items.map((user) => this.toSafeUser(user)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /**
   * Creates an ORGANIZATION ADMINISTRATOR — the one path that can (Phase 4).
   *
   * `inviteUser` cannot: it derives the company FROM a store, so an
   * ORGANIZATION_MANAGER is unrepresentable there. With a store the binding
   * rules refuse it ("cannot be pinned to a store"); without one the company is
   * null and they refuse it again ("must belong to an organization"). The
   * two-step alternatives fail for the same reason — `setStore(null)` nulls the
   * organization along with the store, and `updateRole` validates against
   * COMMITTED bindings — so every ordering passes through an illegal state.
   *
   * This method takes the organization DIRECTLY, so the legal end state is
   * reached in ONE persist and no invalid intermediate ever exists. The role is
   * fixed here and never read from a request body: this route cannot mint any
   * other role, least of all a platform owner.
   *
   * BUS-001: organization administrators consume a seat even though they are
   * not pinned to a store. The organization-wide lock and count below make
   * this creation path obey the same commercial rule as store invitations.
   */
  async createOrganizationAdministrator(
    actor: User,
    params: { organizationId: string; email: string; firstName?: string; lastName?: string; company?: string },
  ) {
    const { organizationId, firstName, lastName, company } = params;
    // One identity rule, applied at the door: what is stored is what every
    // lookup and the unique index will compare (#291).
    const email = canonicalEmail(params.email);
    this.assertCanManageRole(actor, ORGANIZATION_ROLE, 'create');

    const existing = await this.findLiveIdentityByEmail(email);
    if (existing) {
      throw new BadRequestException('Email already registered');
    }

    const role = await this.findRoleByName(ORGANIZATION_ROLE);
    if (!role) {
      throw new BadRequestException(`Role ${ORGANIZATION_ROLE} does not exist`);
    }

    const em = this.userRepository.getEntityManager();
    const user = await em.transactional(async (tem) => {
      const organization = await OrganizationPlanPolicy.requireOrganization(tem, organizationId);
      await OrganizationPlanPolicy.lock(tem, organization.id);
      await OrganizationPlanPolicy.assertTeamUserSlot(tem, organization);

      // The same validator every other path uses — no bespoke rules here.
      const bindingError = roleBindingError(role.name, {
        organizationId: organization.id,
        storeId: null,
        storeOrganizationId: undefined,
      });
      if (bindingError) throw new BadRequestException(bindingError);

      const created = tem.create(User, {
        email,
        passwordHash: null,
        role,
        store: null,
        organization,
        company: company || organization.name,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
      });
      await tem.persistAndFlush(created);
      return created;
    });

    await this.sendInviteEmail(user, actor);

    await this.auditLogService.recordAuditEntry(
      actor.id,
      actor.email,
      EntityType.USER,
      user.id,
      Action.CREATE,
      { role: { before: null, after: role.name } },
      `Invited "${email}" as ${ORGANIZATION_ROLE} of organization "${(user.organization as Organization).name}"`,
      { organizationId: (user.organization as any)?.id ?? (user.organization as any) ?? null },
    );

    return this.toSafeUser(user);
  }

  /**
   * Creates a user without a password and emails them an onboarding link
   * (7-day single-use token, same storage as password resets). The user
   * cannot log in until they set their password through that link.
   */
  async inviteUser(scope: TenantScope | undefined, actor: User, params: InviteUserParams) {
    const { roleName, company, firstName, lastName, storeId } = params;
    // One identity rule, applied at the door (#291).
    const email = canonicalEmail(params.email);
    // PHASE 4 (requirement 5, positive half): an ORGANIZATION_MANAGER brings
    // people into branches of its OWN company. Its authority is the
    // authenticated actor's committed organization — the request can neither
    // name another company nor reach one through a foreign store — and it may
    // only mint store-bound roles strictly below its own level.
    const actorIsOrganizationManager = actor.role.name === ORGANIZATION_ROLE;
    const actorOrganizationId = actorIsOrganizationManager ? bindingOfUser(actor).organizationId : null;
    if (actorIsOrganizationManager) {
      if (!actorOrganizationId) {
        throw new ForbiddenException('Your account carries no organization — refusing to create users');
      }
      if (!OM_INVITABLE_ROLES.includes(roleName)) {
        throw new ForbiddenException(`An organization manager cannot create a user with role ${roleName}`);
      }
      if (!storeId) {
        throw new BadRequestException('An organization manager places the new user in a store — storeId is required');
      }
    }
    // P5-A2 family 6: the branch a person is invited into is NAMED by the
    // request and validated against the RESOLVED SCOPE — never taken from the
    // inviter's own binding, and never trusted because the target store
    // happens to exist. A narrowed actor invites into its selected branch.
    //
    // This also refuses an unscoped platform owner outright: staffing a client
    // company is a tenant mutation, so it must enter that company first.
    const effectiveStoreId = resolveScopedStoreTarget(scope, storeId ?? scope?.storeId ?? undefined);
    const effectiveCompany = company || (actor.store ? actor.company || actor.store.name : undefined);
    if (!effectiveCompany) {
      throw new BadRequestException('Company is required');
    }
    this.assertCanManageRole(actor, roleName, 'create');

    const existing = await this.findLiveIdentityByEmail(email);
    if (existing) {
      throw new BadRequestException('Email already registered');
    }

    const role = await this.findRoleByName(roleName);
    if (!role) {
      throw new BadRequestException(`Role ${roleName} does not exist`);
    }

    // The branch was already proven to belong to the caller's company by
    // `resolveScopedStoreTarget`; this lookup adds the archived-store rule and
    // loads the organization the new user will be bound to.
    const em = this.userRepository.getEntityManager();
    const user = await em.transactional(async (tem) => {
      const store = await tem.findOne(
        Store,
        { id: effectiveStoreId, archivedAt: null },
        { populate: ['organization'] as never },
      );
      if (!store) throw new BadRequestException('Store not found');

      // P0-04: a user's company comes from the branch it is being placed in.
      const organization = (store as any).organization ?? null;
      const organizationId = organization ? (organization.id ?? organization) : null;
      const bindingError = roleBindingError(role.name, {
        organizationId,
        storeId: store.id,
        storeOrganizationId: organizationId,
      });
      if (bindingError) throw new BadRequestException(bindingError);
      if (!organizationId) throw new BadRequestException('This store belongs to no organization');

      await OrganizationPlanPolicy.lock(tem, organizationId);
      await OrganizationPlanPolicy.assertTeamUserSlot(tem, organization);

      const user = tem.create(User, {
        email,
        passwordHash: null,
        role,
        store,
        organization,
        company: effectiveCompany,
        firstName: firstName || undefined,
        lastName: lastName || undefined,
      });
      await tem.persistAndFlush(user);
      return user;
    });

    await this.sendInviteEmail(user, actor);

    await this.auditLogService.recordAuditEntry(
      actor.id,
      actor.email,
      EntityType.USER,
      user.id,
      Action.CREATE,
      { role: { before: null, after: role.name } },
      `Invited "${email}" (${company}) with role ${role.name}`,
      {
        organizationId: (user.organization as any)?.id ?? (user.organization as any) ?? null,
        storeId: (user.store as any)?.id ?? (user.store as any) ?? null,
      },
    );

    return this.toSafeUser(user);
  }

  /** Re-issues the onboarding link for a user who hasn't finished setup. */
  async resendInvite(scope: TenantScope | undefined, actor: User, id: string) {
    const user = await this.getManagedUser(scope, actor, id);
    if (user.passwordHash) {
      throw new BadRequestException('User already finished their account setup');
    }
    if (user.deletedAt) {
      throw new BadRequestException('User is deactivated');
    }

    await this.sendInviteEmail(user, actor);

    await this.auditLogService.recordAuditEntry(
      actor.id,
      actor.email,
      EntityType.USER,
      user.id,
      Action.UPDATE,
      null,
      `Re-sent invitation to "${user.email}"`,
      {
        organizationId: (user.organization as any)?.id ?? (user.organization as any) ?? null,
        storeId: (user.store as any)?.id ?? (user.store as any) ?? null,
      },
    );

    return this.toSafeUser(user);
  }

  private async sendInviteEmail(user: User, actor: User): Promise<void> {
    // Delivered to the member AS RELOADED UNDER LOCK, never to the hint: an
    // address changed while the invitation waited must receive it, and the
    // old address must not.
    const issued = await this.issueInviteTokenSerialized(user);
    await this.deliverInviteEmail(issued.recipient, actor, issued.token);
  }

  /**
   * AN INVITATION IS ISSUED UNDER THE CANONICAL LOCKS (#277 P2).
   *
   * The first version issued the token straight from the caller's entity
   * manager. Against a concurrent archive that was a race: the caller had
   * seen an active company, the archive committed — revoking every unused
   * token it could see — and the new token landed afterwards, unrevoked, on a
   * member of an archived company, and redeemable the day the company was
   * restored. So every invitation now takes `org-access` (the archive's first
   * lock), re-reads the company's lifecycle `FOR SHARE` (the row the archive
   * holds `FOR UPDATE`), locks the member row, and only then writes. Whichever
   * side wins, no token outlives the archive: issued first, the archive marks
   * it used; archived first, nothing is issued.
   */
  async issueInviteTokenSerialized(user: User): Promise<{ token: string; recipient: User }> {
    const em = this.resetTokenRepository.getEntityManager() as EntityManager;
    // The loaded user is a HINT; the member and their company are re-derived
    // under the locks, with a restart if the membership moved meanwhile
    // (`credential-issuance.ts`). The RECIPIENT is the reloaded member, whose
    // address is the one of record at the moment the token was committed.
    const issued = await withMemberLockedForIssuance(em, user, async (tem, { user: current }) => ({
      token: await this.issueInviteTokenIn(tem, current),
      recipient: current,
    }));
    if (issued === null) {
      throw new BadRequestException(
        'This invitation cannot be sent: the member is no longer active, or their company is archived',
      );
    }
    return issued;
  }

  /**
   * THE DURABLE HALF OF AN INVITATION, issued through a caller's entity manager.
   *
   * Split out of `sendInviteEmail` so onboarding can commit the token in the
   * SAME transaction as the user it belongs to. The existing invite path
   * persisted the token in its own transaction after the user's had committed,
   * which leaves a window where a person exists with no way to reach the
   * product; `resendInvite` recovers from it, but only if someone notices.
   *
   * Returns the RAW token to the caller, who hands it to the mailer and to
   * nobody else. It is never returned in a response, written to an audit
   * record, or logged — only its SHA-256 is stored.
   */
  async issueInviteTokenIn(em: EntityManager, user: User): Promise<string> {
    // A fresh invite invalidates any previous unused link — the existing
    // contract, preserved exactly.
    await em.nativeDelete(PasswordResetToken, { user: user.id, usedAt: null });

    const token = randomBytes(32).toString('base64url');
    const entry = em.create(PasswordResetToken, {
      // By reference: the caller's user may have been loaded by another
      // context, and the row is what the token belongs to.
      user: em.getReference(User, user.id),
      tokenHash: createHash('sha256').update(token).digest('hex'),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      createdAt: new Date(),
    } as never);
    em.persist(entry);
    await em.flush();
    return token;
  }

  /**
   * The UNDURABLE half: a network call to the mail provider, which cannot join
   * a database transaction and is never asked to.
   *
   * `MailService.send` already reports failure by returning `false` rather than
   * throwing, so an unreachable provider is a delivery outcome, not a lost
   * onboarding. Callers surface the boolean; the recovery path is the existing
   * `resendInvite`.
   */
  async deliverInviteEmail(user: User, actor: User, token: string): Promise<boolean> {
    const base = (this.configService.get<string>('FRONTEND_URL') || 'http://localhost:3000').replace(/\/+$/, '');
    const link = `${base}/welcome?token=${token}`;
    return this.mailService.send(
      user.email,
      'You are invited to Catalog',
      this.mailService.renderTemplate('welcome-email', 'Welcome to Catalog by Wegox', {
        actorEmail: actor.email,
        company: user.company ?? user.email,
        link,
      }),
    );
  }

  async updateRole(scope: TenantScope | undefined, actor: User, id: string, roleName: string) {
    // A cheap pre-flight so an unauthorised or cross-tenant caller is refused
    // without taking a lock. It decides NOTHING: every check it makes is made
    // again below against state read under the lock.
    await this.getManagedUser(scope, actor, id);
    this.assertCanManageRole(actor, roleName, 'assign');

    const role = await this.findRoleByName(roleName);
    if (!role) {
      throw new BadRequestException(`Role ${roleName} does not exist`);
    }

    const em = this.userRepository.getEntityManager() as EntityManager;
    const outcome = await em.transactional(async (tem) => {
      const user = await this.reloadTargetUnderLock(tem, scope, actor, id);
      if (user.deletedAt) throw new BadRequestException('User is deactivated');

      const previousRole = user.role.name;

      // A genuine no-op: same role, nothing to record and nobody to sign out.
      if (previousRole === role.name) return { user, changed: false, previousRole };

      // #156, re-evaluated on the LOCKED row: the proposed role must be legal
      // for the bindings this user has right now, not the ones it had when the
      // request arrived.
      const bindingError = userBindingError(user, role.name);
      if (bindingError) throw new BadRequestException(bindingError);

      if (previousRole === ORGANIZATION_ROLE && role.name !== ORGANIZATION_ROLE) {
        await this.assertOrganizationKeepsAManager(tem, user);
      }

      // A native update: the row is what the lock protects, and this needs no
      // identity map, so the write lands on the SAME connection that holds the
      // lock rather than on the entity manager that happened to load the user.
      await tem.nativeUpdate(User, { id: user.id }, { role: role.id } as never);

      // A role change is a MATERIAL authority change, so it ends the target's
      // sessions and is audited transactionally — the same rule the new access
      // contract follows. Previously this route revoked nothing and audited
      // after the commit, so a failed audit left an unrecorded privilege
      // change and a signed-in holder of the old authority.
      const revokedSessions = await this.revokeSessionsIn(tem, user.id);
      await this.auditLogService.recordAuditEntryIn(
        tem,
        actor.id,
        actor.email,
        EntityType.USER,
        user.id,
        Action.UPDATE,
        { role: { before: previousRole, after: role.name }, revokedSessions },
        `Changed role of "${user.email}" from ${previousRole} to ${role.name}`,
        {
          organizationId: (user.organization as any)?.id ?? null,
          storeId: (user.store as any)?.id ?? null,
        },
      );
      return { user, changed: true, previousRole };
    });

    if (outcome.changed) outcome.user.role = role;
    return this.toSafeUser(outcome.user);
  }

  async deactivate(scope: TenantScope | undefined, actor: User, id: string) {
    await this.getManagedUser(scope, actor, id);

    // THE CHECK AND THE WRITE SHARE ONE TRANSACTION, and a concurrency test
    // proved why: taking the lock in its own transaction released it before the
    // write committed, so two deactivations each passed their own count and the
    // organization ended with no manager at all. A lock that does not outlive
    // the decision it protects is decoration — and neither does a row read
    // before the lock, which is why the target is reloaded inside it.
    const em = this.userRepository.getEntityManager() as EntityManager;
    const user = await em.transactional(async (tem) => {
      const target = await this.reloadTargetUnderLock(tem, scope, actor, id);
      if (target.deletedAt) throw new BadRequestException('User is already deactivated');

      // An organization must keep a manager while it is ACTIVE. An archived one
      // may have none, and archiving never strips managers — so the rule is
      // asked about the organization's state, not assumed from the user's.
      await this.assertOrganizationKeepsAManager(tem, target);

      const deletedAt = new Date();
      await tem.nativeUpdate(User, { id: target.id }, { deletedAt } as never);
      const revokedSessions = await this.revokeSessionsIn(tem, target.id);
      target.deletedAt = deletedAt;

      await this.auditLogService.recordAuditEntryIn(
        tem,
        actor.id,
        actor.email,
        EntityType.USER,
        target.id,
        Action.DEACTIVATE,
        { revokedSessions },
        `Deactivated user "${target.email}"`,
        {
          organizationId: (target.organization as any)?.id ?? null,
          storeId: (target.store as any)?.id ?? null,
        },
      );
      return target;
    });

    return this.toSafeUser(user);
  }

  async reactivate(scope: TenantScope | undefined, actor: User, id: string) {
    const managed = await this.getManagedUser(scope, actor, id);
    if (!managed.deletedAt) {
      throw new BadRequestException('User is not deactivated');
    }
    const organizationId = (managed.organization as any)?.id ?? (managed.organization as any) ?? null;
    if (!organizationId) throw new BadRequestException('User belongs to no organization');
    const user = await this.userRepository.getEntityManager().transactional(async (tem) => {
      const organization = await OrganizationPlanPolicy.requireOrganization(tem, organizationId);
      await OrganizationPlanPolicy.lock(tem, organization.id);
      await OrganizationPlanPolicy.assertTeamUserSlot(tem, organization);
      const user = await tem.findOne(User, { id }, { populate: ['role', 'store', 'organization'] as never });
      if (!user) throw new NotFoundException('User not found');
      if (!user.deletedAt) throw new BadRequestException('User is not deactivated');
      user.deletedAt = undefined;
      await tem.flush();
      return user;
    });

    await this.auditLogService.recordAuditEntry(
      actor.id,
      actor.email,
      EntityType.USER,
      user.id,
      Action.REACTIVATE,
      null,
      `Reactivated user "${user.email}"`,
      {
        organizationId: (user.organization as any)?.id ?? (user.organization as any) ?? null,
        storeId: (user.store as any)?.id ?? (user.store as any) ?? null,
      },
    );

    return this.toSafeUser(user);
  }

  async resetPassword(scope: TenantScope | undefined, actor: User, id: string, password: string) {
    const user = await this.getManagedUser(scope, actor, id);

    user.passwordHash = await argon2.hash(password);
    await this.userRepository.getEntityManager().flush();
    await this.revokeSessions(user.id);

    await this.auditLogService.recordAuditEntry(
      actor.id,
      actor.email,
      EntityType.USER,
      user.id,
      Action.PASSWORD_RESET,
      null,
      `Reset password of user "${user.email}"`,
      {
        organizationId: (user.organization as any)?.id ?? (user.organization as any) ?? null,
        storeId: (user.store as any)?.id ?? (user.store as any) ?? null,
      },
    );

    return this.toSafeUser(user);
  }

  /** Self-service: a user updates their own display names. */
  async updateProfile(userId: string, firstName?: string, lastName?: string) {
    const user = await this.findById(userId);
    if (!user) {
      throw new NotFoundException('User not found');
    }
    if (firstName !== undefined) user.firstName = firstName || undefined;
    if (lastName !== undefined) user.lastName = lastName || undefined;
    await this.userRepository.getEntityManager().flush();
    return this.toSafeUser(user);
  }

  /** Binds (or unbinds, storeId=null) a user to a store: their admin view narrows to it. */
  async setStore(scope: TenantScope | undefined, actor: User, id: string, storeId: string | null) {
    const user = await this.getManagedUser(scope, actor, id);
    // P5-A2 family 6: the destination branch is validated against the resolved
    // scope before anything moves — an unscoped platform owner is refused, an
    // organization actor may only assign within its own company, and a narrowed
    // one only to the branch it selected. Clearing the binding (null) stays a
    // company-level act and needs no target.
    const targetStoreId = storeId ? resolveScopedStoreTarget(scope, storeId) : null;
    const store = targetStoreId
      ? await this.userRepository
          .getEntityManager()
          .findOne(Store, { id: targetStoreId, archivedAt: null }, { populate: ['organization'] as never })
      : null;
    if (targetStoreId && !store) {
      throw new BadRequestException('Store not found');
    }

    // P0-04: moving a user follows its branch's company, and the resulting
    // combination must still be legal for that role.
    const organization = store ? ((store as any).organization ?? null) : null;
    const organizationId = organization ? (organization.id ?? organization) : null;
    const bindingError = roleBindingError(user.role?.name ?? '', {
      organizationId,
      storeId: store?.id ?? null,
      storeOrganizationId: store ? organizationId : undefined,
    });
    if (bindingError) {
      throw new BadRequestException(bindingError);
    }

    user.store = store;
    user.organization = organization;
    await this.userRepository.getEntityManager().flush();
    await this.auditLogService.recordAuditEntry(
      actor.id,
      actor.email,
      EntityType.USER,
      user.id,
      Action.UPDATE,
      null,
      store ? `Scoped "${user.email}" to store "${store.name}"` : `Unscoped "${user.email}" (all stores)`,
      { organizationId, storeId: store?.id ?? null },
    );
    return this.toSafeUser(user);
  }

  /**
   * ROLE AND BINDING MOVE TOGETHER, OR NOT AT ALL.
   *
   * The defect this closes is not that a role could not be set. It is that role
   * and store binding were two requests, and the legal combinations span both:
   * an ORGANIZATION_MANAGER must have NO store, every branch role must have
   * one, so promoting a store-bound admin needed two calls that could not both
   * be valid. The first would be refused by `roleBindingError` whichever order
   * you tried — set the role and the old store makes it illegal, clear the
   * store and the old role makes it illegal. There was no sequence that worked,
   * which is why no existing company can be given a manager today.
   *
   * One statement of intent — "this person, this role, this branch" — validated
   * and written in one transaction, is the whole idea.
   */
  async changeOrganizationAccess(
    scope: TenantScope | undefined,
    actor: User,
    organizationId: string,
    userId: string,
    desired: { role: string; storeId: string | null },
  ) {
    this.assertMayChangeAccess(scope, organizationId, desired.role);
    if (actor.id === userId) {
      throw new BadRequestException('You cannot manage your own account from here');
    }

    const em = this.userRepository.getEntityManager() as EntityManager;
    return em.transactional(async (tem) => {
      // Lock order 1 → 3. Nothing is read that a concurrent transaction could
      // still change, because it cannot get past the first line.
      await lockOrganizationAccess(tem, organizationId);
      await lockUsers(tem, [userId]);

      const target = await tem.findOne(
        User,
        { id: userId },
        { populate: ['role', 'store', 'store.organization', 'organization'] as never },
      );

      // A target outside this organization and a target that never existed are
      // the SAME answer. Distinguishing them turns the endpoint into an oracle
      // for "does this user id exist somewhere on the platform".
      const targetOrganizationId = (target?.organization as any)?.id ?? null;
      if (!target || targetOrganizationId !== organizationId) {
        throw new NotFoundException('User not found');
      }
      if (target.deletedAt) {
        throw new BadRequestException('User is deactivated; reactivate before changing access');
      }

      // Level check on BOTH sides: the actor must outrank who the target is
      // now, and who it is about to become.
      this.assertCanManageRole(actor, target.role.name, 'manage');
      this.assertCanManageRole(actor, desired.role, 'assign');

      const before = snapshotOf(target);
      const after = { role: desired.role, organizationId, storeId: desired.storeId };

      // IDEMPOTENCE IS A CONTRACT, NOT AN OPTIMISATION. A retry after a
      // successful change must not sign the person out a second time, and must
      // not write a second audit row saying nothing changed — a trail full of
      // no-ops is a trail nobody reads.
      if (sameAccess(before, after)) {
        return this.toSafeUser(target);
      }

      const store = await this.resolveAccessStore(tem, organizationId, desired.storeId);
      const bindingError = roleBindingError(desired.role, {
        organizationId,
        storeId: desired.storeId,
        storeOrganizationId: store ? ((store.organization as any)?.id ?? null) : undefined,
      });
      if (bindingError) throw new BadRequestException(bindingError);

      // The last-manager rule, counted while lock 1 is held so a concurrent
      // demotion of the OTHER last manager cannot pass its own count too.
      if (before.role === ORGANIZATION_ROLE && desired.role !== ORGANIZATION_ROLE) {
        const remaining = (await countActiveManagers(tem, organizationId)) - 1;
        if (remaining < 1) {
          throw new BadRequestException(
            'This is the organization’s last active Organization Manager. Use the manager transfer operation to appoint a replacement in the same step.',
          );
        }
      }

      const role = await tem.findOne(Role, { name: desired.role });
      if (!role) throw new BadRequestException(`Role ${desired.role} does not exist`);

      target.role = role;
      target.store = store;
      await tem.flush();

      const revokedSessions = await this.revokeSessionsIn(tem, target.id);
      await this.writeAccessAudit(tem, actor, target, before, after, revokedSessions, null);

      return this.toSafeUser(target);
    });
  }

  /**
   * THE ONLY WAY TO REPLACE AN ORGANIZATION'S LAST MANAGER.
   *
   * `changeOrganizationAccess` refuses to demote the last one, and that refusal
   * would be a dead end if this did not exist: a company whose manager leaves
   * could never hand over. Splitting it into "promote the replacement, then
   * demote the incumbent" is exactly the shape that fails halfway — two
   * managers if the second call is lost, and a race that briefly has none if
   * anyone reversed the order.
   *
   * One transaction, both sides, one correlation id joining their audit rows.
   */
  async transferOrganizationManager(
    scope: TenantScope | undefined,
    actor: User,
    organizationId: string,
    dto: {
      currentManagerUserId: string;
      replacementUserId: string;
      formerManagerRole: string;
      formerManagerStoreId: string;
    },
  ) {
    // Only the platform grants or revokes ORGANIZATION_MANAGER, and a transfer
    // does both at once.
    this.assertPlatformOwner(scope);
    if (dto.currentManagerUserId === dto.replacementUserId) {
      throw new BadRequestException('The replacement must be a different user');
    }
    if (actor.id === dto.currentManagerUserId || actor.id === dto.replacementUserId) {
      throw new BadRequestException('You cannot manage your own account from here');
    }

    const em = this.userRepository.getEntityManager() as EntityManager;
    return em.transactional(async (tem) => {
      await lockOrganizationAccess(tem, organizationId);
      await lockUsers(tem, [dto.currentManagerUserId, dto.replacementUserId]);

      const load = async (id: string) =>
        tem.findOne(User, { id }, { populate: ['role', 'store', 'store.organization', 'organization'] as never });
      const [outgoing, incoming] = await Promise.all([load(dto.currentManagerUserId), load(dto.replacementUserId)]);

      const inOrganization = (u: User | null) => u && ((u.organization as any)?.id ?? null) === organizationId;
      if (!inOrganization(outgoing) || !inOrganization(incoming)) {
        throw new NotFoundException('User not found');
      }
      if (outgoing!.deletedAt || incoming!.deletedAt) {
        throw new BadRequestException('Both users must be active');
      }

      const before = { outgoing: snapshotOf(outgoing!), incoming: snapshotOf(incoming!) };
      const after = {
        outgoing: { role: dto.formerManagerRole, organizationId, storeId: dto.formerManagerStoreId },
        incoming: { role: ORGANIZATION_ROLE, organizationId, storeId: null as string | null },
      };

      // AN IDENTICAL RETRY IS THE ACHIEVED STATE, NOT A REVERSAL. Retrying a
      // transfer that already committed must not swap the two back — which is
      // precisely what a naive re-run would do, since the roles are now the
      // mirror of what the request describes.
      if (sameAccess(before.outgoing, after.outgoing) && sameAccess(before.incoming, after.incoming)) {
        return { outgoing: this.toSafeUser(outgoing!), incoming: this.toSafeUser(incoming!), noop: true };
      }

      if (before.outgoing.role !== ORGANIZATION_ROLE) {
        throw new BadRequestException('The named current manager is not an Organization Manager');
      }
      if (before.incoming.role === ORGANIZATION_ROLE) {
        throw new BadRequestException('The replacement is already an Organization Manager');
      }
      this.assertCanManageRole(actor, before.incoming.role, 'manage');

      const store = await this.resolveAccessStore(tem, organizationId, dto.formerManagerStoreId);
      const bindingError = roleBindingError(dto.formerManagerRole, {
        organizationId,
        storeId: dto.formerManagerStoreId,
        storeOrganizationId: store ? ((store.organization as any)?.id ?? null) : undefined,
      });
      if (bindingError) throw new BadRequestException(bindingError);

      const [managerRole, lowerRole] = await Promise.all([
        tem.findOne(Role, { name: ORGANIZATION_ROLE }),
        tem.findOne(Role, { name: dto.formerManagerRole }),
      ]);
      if (!managerRole || !lowerRole) throw new BadRequestException('Role does not exist');

      // Promote FIRST, so no instant of the committed state has zero managers.
      // Both writes land in one transaction, so this ordering is belt and
      // braces — but the invariant is asserted below on the real count anyway.
      incoming!.role = managerRole;
      incoming!.store = null;
      outgoing!.role = lowerRole;
      outgoing!.store = store;
      await tem.flush();

      const remaining = await countActiveManagers(tem, organizationId);
      if (remaining < 1) {
        throw new BadRequestException('A transfer must leave the organization with an Organization Manager');
      }

      const correlationId = randomBytes(8).toString('hex');
      const [outRevoked, inRevoked] = await Promise.all([
        this.revokeSessionsIn(tem, outgoing!.id),
        this.revokeSessionsIn(tem, incoming!.id),
      ]);
      await this.writeAccessAudit(tem, actor, outgoing!, before.outgoing, after.outgoing, outRevoked, correlationId);
      await this.writeAccessAudit(tem, actor, incoming!, before.incoming, after.incoming, inRevoked, correlationId);

      return { outgoing: this.toSafeUser(outgoing!), incoming: this.toSafeUser(incoming!), noop: false };
    });
  }

  /**
   * RE-READ THE TARGET UNDER THE LOCK, AND RE-DECIDE ON WHAT IT SAYS.
   *
   * A request that waits for the organization lock can wait a long time, and
   * everything it learned before queuing may be false by the time it runs. The
   * dangerous shape is specific: read a user who is an ADMIN, block, let another
   * transaction promote that same user to the organization's only manager and
   * commit, then resume and deactivate them "because they are only an ADMIN".
   * The count would even agree — it is the ROLE that went stale, not the count.
   *
   * So nothing decided before the lock is allowed to survive it. This reloads
   * the row and its role, organization, store and the store's organization
   * through the transaction-bound entity manager, then re-applies the tenant
   * wall and the level rule against that state. Callers use ONLY what this
   * returns.
   *
   * Lock order here is the documented one and nothing else takes a lock later:
   * organization, then the target row. There is deliberately no platform lock —
   * see `assertCanManageRole` and the note on SUPER_ADMIN below.
   */
  private async reloadTargetUnderLock(
    tem: EntityManager,
    scope: TenantScope | undefined,
    actor: User,
    id: string,
  ): Promise<User> {
    const organizationId = requireOrganizationScope(scope);
    await lockOrganizationAccess(tem, organizationId);
    await lockUsers(tem, [id]);

    const user = await tem.findOne(
      User,
      { id },
      { populate: ['role', 'store', 'store.organization', 'organization'] as never, refresh: true },
    );

    // The same wall `getManagedUser` applies, restated on the locked row —
    // restated rather than shared, because the pre-flight version reads through
    // a different entity manager and cannot be trusted to describe this one.
    const narrowedTo = scope?.storeId;
    const targetOrganizationId = user?.organization?.id ?? (user?.store as any)?.organization?.id ?? null;
    const outsideCompany = !user || targetOrganizationId !== organizationId;
    const outsideBranch = typeof narrowedTo === 'string' && narrowedTo.length > 0 && user?.store?.id !== narrowedTo;
    if (outsideCompany || outsideBranch) {
      throw new NotFoundException('User not found');
    }
    if (actor.id === user!.id) {
      throw new BadRequestException('You cannot manage your own account from here');
    }
    this.assertCanManageRole(actor, user!.role.name, 'manage');
    return user!;
  }

  /*
   * WHAT PROTECTS THE LAST SUPER_ADMIN, and why there is no lock for it.
   *
   * Nothing here counts platform owners, and that is deliberate. `SUPER_ADMIN`
   * is level 5 and `assertCanManageRole` refuses any target whose level is
   * greater than OR EQUAL TO the actor's — so no actor, platform owner
   * included, can reach a `SUPER_ADMIN` through `updateRole`, `deactivate` or
   * the organization access contract, whose DTO also refuses the role outright.
   * Superadmin mutation is STRUCTURALLY UNSUPPORTED by the current API.
   *
   * An earlier revision carried a count-and-lock guard here "as future
   * defence". It was removed rather than kept, for two reasons. It was
   * unreachable, so no test could exercise it through a real path and it would
   * have rotted unnoticed. And it violated this file's own documented lock
   * order: the target row is locked during the reload above, and that guard
   * then asked for the PLATFORM lock afterwards — row-then-platform, the
   * reverse of what the order says. Incorrect unreachable code is worse than
   * absent code, because it reads like a guarantee.
   *
   * When a deliberate Superadmin-management contract is designed, it brings its
   * own lock discipline with it — taken before any row lock — and its own
   * tests. Until then the invariant is enforced by the level rule, and
   * `organization-access.pg.spec.ts` proves it against every current writer.
   */

  /**
   * An ACTIVE organization keeps at least one active Organization Manager.
   *
   * Archived organizations are exempt by design: archiving does not strip a
   * company's managers, and requiring one on a company nobody can use would
   * make archiving a trap. Restoring is where the rule is re-imposed (#277).
   */
  private async assertOrganizationKeepsAManager(tem: EntityManager, user: User): Promise<void> {
    if (user.role.name !== ORGANIZATION_ROLE) return;
    const organizationId = (user.organization as any)?.id ?? null;
    if (!organizationId) return;

    await lockOrganizationAccess(tem, organizationId);
    await lockUsers(tem, [user.id]);
    const organization = await tem.findOne(Organization, { id: organizationId });
    if (!organization || organization.archivedAt) return;
    const remaining = (await countActiveManagers(tem, organizationId)) - 1;
    if (remaining < 1) {
      throw new BadRequestException(
        'This is the organization’s last active Organization Manager. Use the manager transfer operation to appoint a replacement in the same step.',
      );
    }
  }

  /**
   * Who may call the organization access contract, and about which role.
   *
   * The organization comes from the PATH, never from a header — a forged
   * `X-Managed-Organization` cannot widen anything here because the scope it
   * produces is only ever compared against the path, never substituted for it.
   */
  private assertMayChangeAccess(scope: TenantScope | undefined, organizationId: string, targetRole: string): void {
    if (!scope) throw new ForbiddenException('Access denied: no tenant scope resolved');

    if (scope.platform === true && scope.role === PLATFORM_ROLE) {
      /*
       * A REAL PLATFORM OWNER KEEPS PLATFORM AUTHORITY, INCLUDING INSIDE A
       * MANAGED COMPANY.
       *
       * `platform: true` with role SUPER_ADMIN is set by the resolver from the
       * USER ROW; `X-Managed-Organization` can narrow which company such an
       * actor is working in, but it cannot manufacture that pair for anyone
       * else. So the header cannot invent this authority — and it must not
       * silently subtract it either. An earlier revision refused an owner that
       * had entered company A from naming company B, which quietly demoted an
       * authenticated platform owner because of a UI convenience header.
       *
       * The path names the subject; the owner may name any organization.
       */
      return;
    }

    if (scope.role === ORGANIZATION_ROLE) {
      // The company is the boundary, and it comes from the resolver — which
      // reads a tenant role's own binding and ignores the header entirely.
      if (scope.organizationId !== organizationId) throw new NotFoundException('User not found');
      /*
       * NARROWING DOES NOT REMOVE STAFFING AUTHORITY on this contract. A
       * manager working inside one branch is still the manager of the whole
       * company (ADR 014 §22), and an earlier revision of this PR invented a
       * "leave branch context first" refusal that no contract required.
       *
       * NOTE FOR REVIEW — the legacy `/users/:id/*` routes DISAGREE, and that
       * divergence is deliberate rather than overlooked. `getManagedUser` has
       * held a narrowed actor to its selected branch since P5-A2 family 6:
       *
       *   const outsideBranch = typeof narrowedTo === 'string' &&
       *     narrowedTo.length > 0 && user?.store?.id !== narrowedTo;
       *   if (outsideCompany || outsideBranch) throw new NotFoundException(...)
       *
       * That rule is untouched here. This contract follows the owner's decision
       * of 2026-09-08; reconciling the two surfaces is a separate decision, not
       * something to change silently inside this PR.
       */
      if (targetRole === ORGANIZATION_ROLE) {
        throw new ForbiddenException('Only a platform administrator may grant or revoke Organization Manager');
      }
      return;
    }

    throw new ForbiddenException('Access denied: insufficient permissions');
  }

  /**
   * A manager transfer grants AND revokes ORGANIZATION_MANAGER, so it is
   * platform-only — and, as above, a managed-organization header neither
   * manufactures that authority nor reduces it. The organization named in the
   * path is the subject.
   */
  private assertPlatformOwner(scope: TenantScope | undefined): void {
    if (!scope || scope.platform !== true || scope.role !== PLATFORM_ROLE) {
      throw new ForbiddenException('Only a platform administrator may transfer Organization Manager');
    }
  }

  /**
   * The branch a change names, proven to be this organization's and usable.
   *
   * `null` is a legitimate answer (organization-wide authority) and is returned
   * as such; a named branch must exist, be unarchived, and belong to the target
   * organization — a store of another company is `not found`, for the same
   * reason a user of another company is.
   */
  private async resolveAccessStore(
    em: EntityManager,
    organizationId: string,
    storeId: string | null,
  ): Promise<Store | null> {
    if (storeId === null) return null;
    const store = await em.findOne(Store, { id: storeId }, { populate: ['organization'] as never });
    if (!store || ((store.organization as any)?.id ?? null) !== organizationId) {
      throw new NotFoundException('Store not found');
    }
    if (store.archivedAt) {
      throw new BadRequestException('That branch is archived; choose an active branch');
    }
    return store;
  }

  /**
   * One audit row per affected person, written through the TRANSACTIONAL entity
   * manager so a failure here rolls the authority change back with it.
   *
   * `recordAuditEntry` swallows its own errors by design — business operations
   * must not fail because logging did. That is the right rule for a product
   * event and the wrong one for an authority change: an unlogged privilege
   * grant is exactly the record an audit exists to hold. `recordAuditEntryIn`
   * is the variant that participates, and does not swallow.
   */
  private async writeAccessAudit(
    em: EntityManager,
    actor: User,
    target: User,
    before: AccessSnapshot,
    after: AccessSnapshot,
    revokedSessions: number,
    correlationId: string | null,
  ): Promise<void> {
    await this.auditLogService.recordAuditEntryIn(
      em,
      actor.id,
      actor.email,
      EntityType.USER,
      target.id,
      Action.UPDATE,
      {
        access: { before, after },
        revokedSessions,
        ...(correlationId ? { transferCorrelationId: correlationId } : {}),
      },
      `Changed access of "${target.email}" from ${before.role}${before.storeId ? ` @${before.storeId}` : ''} to ${after.role}${after.storeId ? ` @${after.storeId}` : ''}`,
      { organizationId: after.organizationId, storeId: after.storeId },
    );
  }

  /**
   * Kills every active session of the user. Done directly on the
   * RefreshToken entity to avoid a circular UsersModule <-> AuthModule
   * dependency.
   */
  private async revokeSessions(userId: string): Promise<void> {
    await this.userRepository
      .getEntityManager()
      .nativeUpdate(RefreshToken, { user: userId, revokedAt: null }, { revokedAt: new Date() });
  }

  /**
   * The same revocation, INSIDE a caller's transaction, returning how many
   * sessions it ended.
   *
   * The count is not decoration: it goes into the audit record, so the trail
   * says whether anyone was actually signed out rather than merely that we
   * intended to be. Using the transactional entity manager is what makes the
   * revocation roll back with the authority change instead of outliving it.
   */
  private async revokeSessionsIn(em: EntityManager, userId: string): Promise<number> {
    return em.nativeUpdate(RefreshToken, { user: userId, revokedAt: null }, { revokedAt: new Date() });
  }
}
