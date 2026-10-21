import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, EntityManager } from '@mikro-orm/postgresql';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { randomBytes } from 'crypto';
import { Organization } from '../entities/organization.entity';
import { Store } from '../../stores/entities/store.entity';
import { User } from '../../users/entities/user.entity';
import { Role } from '../../users/entities/role.entity';
import { UsersService } from '../../users/users.service';
import { ORGANIZATION_ROLE, roleBindingError } from '../../users/authorization/role-levels';
import { lockOrganizationAccess, lockUsers } from '../../users/access/access-locks';
import { organizationIsInactive, readOrganizationLifecycleLocked } from '../lifecycle/organization-archived';
import { OrganizationPlanPolicy } from '../../billing/plans/organization-plan-policy';
import { ensureDefaultWarehouseIn, ensureStoreCustodyIn } from '../../inventory/locations/inventory-location-provisioning';
import { PLANS } from '../../stores/plans';
import { AuditLogService } from '../../audit-log/audit-log.service';
import { EntityType, Action } from '../../audit-log/entities/audit-log.entity';
import { slugify } from '../../imports/preview/woocommerce-mapper';
import { canonicalEmail, canonicalEmailKey } from '../../users/identity/email-identity';

export interface OnboardRequest {
  organization: { name: string; plan?: string };
  store?: { name: string; websiteUrl?: string } | null;
  manager: { email: string; firstName?: string; lastName?: string };
}

/**
 * WHAT WE KNOW ABOUT THE INVITATION EMAIL, AND NOTHING MORE.
 *
 * `DELIVERED` and `FAILED` are the outcome of a delivery attempt THIS request
 * made. `UNKNOWN` means no attempt was made here and the database does not
 * record whether an earlier one succeeded — which is the honest answer for
 * every exact retry, because nothing in the schema stores a delivery outcome.
 *
 * A boolean could not say that. `delivered: false` on a retry read as "the
 * invitation failed" and put failure copy and a resend button in front of an
 * operator whose invitation was fine — and, once the manager had accepted it,
 * in front of an invitation that no longer existed.
 *
 * ACCEPTANCE IS NOT TREATED AS PROOF OF DELIVERY EITHER, though it is tempting:
 * a user with a password must have followed an emailed link — except that
 * `UsersService.resetPassword` lets an administrator set someone's password
 * directly, with no email involved. So acceptance proves the account is usable,
 * not that the message arrived, and the status stays `UNKNOWN`.
 */
export type InvitationDeliveryStatus = 'DELIVERED' | 'FAILED' | 'UNKNOWN';

export interface InvitationState {
  /** True while the manager has not finished account setup. */
  pending: boolean;
  deliveryStatus: InvitationDeliveryStatus;
}

export interface OnboardResult {
  organization: { id: string; name: string; slug: string; plan: string; archivedAt: Date | null };
  store: { id: string; name: string; slug: string; websiteUrl: string | null } | null;
  manager: ReturnType<UsersService['toSafeUser']>;
  invitation: InvitationState;
  idempotent: boolean;
}

/** The comparable shape of a completed onboarding — the retry oracle. */
interface OnboardingState {
  organizationName: string;
  plan: string;
  storeName: string | null;
  storeWebsiteUrl: string | null;
  managerEmail: string;
  managerFirstName: string | null;
  managerLastName: string | null;
}

const norm = (v: string | null | undefined): string | null => {
  const s = (v ?? '').trim();
  return s.length ? s : null;
};
/**
 * The shared identity rule, aliased locally so the many call sites below read
 * the way they always did. Previously a private copy of the same two calls —
 * one definition of "the same address" is the point of #291's correction.
 */
const normEmail = canonicalEmail;

const EMAIL_TAKEN = 'That email already belongs to a user; onboarding creates a new manager';

/**
 * `audit_logs.message` is `varchar(255)`, and these messages embed values the
 * caller supplies — a 200-character company name plus a 254-character email is
 * comfortably past it. An audit row that cannot be written rolls the whole
 * onboarding back, so a legal request would have failed on the shape of its own
 * audit trail. The structured `changes` payload carries the data; the message
 * is a human summary, and a summary may be trimmed.
 *
 * (The same column is reachable from other writers with long names. Bounding it
 * for every writer is a change to shared behaviour and is not made here.)
 */
const AUDIT_MESSAGE_MAX = 255;
const auditMessage = (text: string): string =>
  text.length <= AUDIT_MESSAGE_MAX ? text : `${text.slice(0, AUDIT_MESSAGE_MAX - 1)}…`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class OrganizationOnboardingService {
  constructor(
    @InjectRepository(Organization)
    private readonly organizationRepository: EntityRepository<Organization>,
    private readonly usersService: UsersService,
    private readonly auditLogService: AuditLogService,
  ) {}

  /**
   * A CLIENT IS ONE THING, SO IT IS CREATED IN ONE TRANSACTION.
   *
   * The panel used to build a client from three independent requests —
   * organization, then store, then a user posted as `role: 'ADMIN'` with that
   * store. Any prefix could commit alone, and the third request was wrong even
   * when it succeeded: it produced a branch administrator, so no company
   * onboarded through the UI ever had an ORGANIZATION_MANAGER. Retrying made it
   * worse, because the slug helper appends `-2` and a retry created a SECOND
   * organization rather than repairing the first.
   *
   * Everything below commits together or not at all, and the caller cannot ask
   * for a different role: there is one correct answer and the server gives it.
   *
   * ── LOCK ORDER ──────────────────────────────────────────────────────────
   *
   *   1. `onboard-email:<lower(email)>` ...... two requests naming the same
   *      prospective manager. FIRST, because the idempotency decision is read
   *      under it, and a decision read outside its lock is a guess.
   *   2. `onboard-org-slug:<base>` ........... two requests naming the same
   *      COMPANY with different emails. They never meet on lock 1, so without
   *      this they race on `organizations.slug`: read-then-insert with no lock,
   *      both picking the same candidate, one dying on the unique index with a
   *      message about a constraint rather than about onboarding.
   *   3. `onboard-store-slug:<base>` ......... only when a store is requested.
   *      `stores.slug` is a SEPARATE GLOBAL namespace, so two requests with
   *      different company names, different emails and the same initial-website
   *      name meet on none of the locks above and race there instead. This is
   *      the collision lock 2 does not cover.
   *   4. `OrganizationPlanPolicy.lock(organization.id)` once the row exists, so
   *      the seat and website checks are the same protected checks every other
   *      writer uses.
   *   5. rows and writes.
   *
   * Locks 2 and 3 live in DIFFERENT KEY NAMESPACES on purpose. An earlier draft
   * used a single `onboard-slug:` prefix, which would have made a company and a
   * website that happen to share a name contend for one key — and, worse, made
   * the two look interchangeable to a later reader. `onboard-org-slug:acme` and
   * `onboard-store-slug:acme` are distinct keys, so a request whose store is
   * named after its company takes two different locks in a fixed order and
   * cannot deadlock against another doing the same.
   *
   * Nothing takes a later lock before an earlier one, and none is taken after a
   * row lock.
   */
  async onboard(actor: User, request: OnboardRequest): Promise<OnboardResult> {
    const email = normEmail(request.manager.email);
    const organizationName = norm(request.organization.name);
    if (!organizationName) throw new BadRequestException('The organization needs a name');
    if (request.store && !norm(request.store.name)) {
      throw new BadRequestException('The website needs a name');
    }
    // The DTO already refuses an unknown plan, and so does this — the service
    // is callable from tests and future callers, and `planOf` silently falls
    // back to the default, so an unvalidated string would persist as a plan
    // name that matches nothing while the limits of a different plan apply.
    if (request.organization.plan !== undefined && !PLANS[request.organization.plan]) {
      throw new BadRequestException(`Unknown plan: ${request.organization.plan}`);
    }

    const desired: OnboardingState = {
      organizationName,
      plan: request.organization.plan ?? 'BASICO',
      storeName: request.store ? norm(request.store.name) : null,
      storeWebsiteUrl: request.store ? this.normalizeUrl(request.store.websiteUrl) : null,
      managerEmail: email,
      managerFirstName: norm(request.manager.firstName),
      managerLastName: norm(request.manager.lastName),
    };

    const em = this.organizationRepository.getEntityManager() as EntityManager;

    // The transaction returns everything the caller needs INCLUDING the raw
    // invite token, which never leaves this process: it is handed to the mailer
    // after commit and is not part of the response.
    const committed = await this.withSanitizedConflicts(async () =>
      em.transactional(async (tem) => {
        await this.lockOnboardingEmail(tem, email);
        await this.lockOrganizationSlug(tem, this.organizationSlugBase(organizationName));
        if (desired.storeName) {
          await this.lockStoreSlug(tem, this.storeSlugBase(desired.storeName));
        }

        // Asked through `lower(email)`, the same expression the unique index
        // is built on (#291): otherwise onboarding could sail past this check
        // with a differently-capitalised address and fail on the constraint,
        // reporting a conflict it had already decided did not exist.
        const existing = await tem.findOne(User, { [canonicalEmailKey()]: email } as never, {
          populate: ['role', 'store', 'organization'] as never,
        });
        if (existing) {
          // D1: the ONLY tolerated existing email is an exact retry of an
          // onboarding that already committed for this same final state.
          const previous = await this.stateOfExistingOnboarding(tem, existing);
          if (previous && this.sameState(previous, desired)) {
            return {
              organization: existing.organization as Organization,
              store: null as Store | null,
              manager: existing,
              token: null as string | null,
              idempotent: true,
              previousStore: await this.initialStoreOf(tem, (existing.organization as any)?.id ?? null),
            };
          }
          throw new ConflictException(EMAIL_TAKEN);
        }

        const role = await tem.findOne(Role, { name: ORGANIZATION_ROLE });
        if (!role) throw new BadRequestException(`Role ${ORGANIZATION_ROLE} does not exist`);

        const organization = tem.create(Organization, {
          name: organizationName,
          slug: await this.uniqueSlugIn(tem, organizationName),
          plan: desired.plan,
          billingStatus: 'ACTIVE',
        } as never);
        await tem.persistAndFlush(organization);

        // Lock 4: the same plan lock every other writer takes, now that there
        // is an organization id to take it on.
        await OrganizationPlanPolicy.lock(tem, organization.id);

        // #284: THE COMPANY'S DEFAULT WAREHOUSE IS PART OF THE COMPANY. It is
        // created here, under the plan lock, in the same transaction as the
        // organization row — with or without an initial store, because
        // product-level stock and supplier receiving resolve it regardless of
        // branches. No store-specific location is invented for a store-less
        // onboarding; a store created later provisions its own custody below
        // and in `StoresService.create`, through the same shared rules.
        await ensureDefaultWarehouseIn(tem, organization.id);

        let store: Store | null = null;
        if (request.store) {
          await OrganizationPlanPolicy.assertWebsiteSlot(tem, organization);
          store = tem.create(Store, {
            name: desired.storeName!,
            slug: await this.uniqueStoreSlugIn(tem, desired.storeName!),
            websiteUrl: desired.storeWebsiteUrl ?? undefined,
            websiteProductPath: '/products/{slug}',
            websiteCategoryPath: '/categories/{slug}',
            organization,
            createdAt: new Date(),
            updatedAt: new Date(),
          } as never);
          await tem.persistAndFlush(store);
          // #284: the branch's custody location, committed with the branch.
          await ensureStoreCustodyIn(tem, organization.id, { id: store.id, name: store.name });
        }

        await OrganizationPlanPolicy.assertTeamUserSlot(tem, organization);

        // The binding is validated by the SHARED rule, not restated here: an
        // ORGANIZATION_MANAGER carries its company and no branch.
        const bindingError = roleBindingError(ORGANIZATION_ROLE, {
          organizationId: organization.id,
          storeId: null,
          storeOrganizationId: undefined,
        });
        if (bindingError) throw new BadRequestException(bindingError);

        const manager = tem.create(User, {
          email,
          passwordHash: null,
          role,
          store: null,
          organization,
          company: organizationName,
          firstName: desired.managerFirstName ?? undefined,
          lastName: desired.managerLastName ?? undefined,
        } as never);
        await tem.persistAndFlush(manager);

        // The invitation is DURABLE STATE and belongs in the transaction. The
        // existing invite path commits its token afterwards, which leaves a
        // window where a user exists with no way in; here the token either
        // exists with the user or neither does.
        const token = await this.usersService.issueInviteTokenIn(tem, manager);

        const correlationId = randomBytes(8).toString('hex');
        const context = { organizationId: organization.id, storeId: store?.id ?? null };
        await this.auditLogService.recordAuditEntryIn(
          tem,
          actor.id,
          actor.email,
          EntityType.ORGANIZATION,
          organization.id,
          Action.CREATE,
          { onboarding: { correlationId, plan: organization.plan, withStore: store !== null } },
          auditMessage(`Onboarded organization "${organization.name}"`),
          { organizationId: organization.id, storeId: null },
        );
        if (store) {
          await this.auditLogService.recordAuditEntryIn(
            tem,
            actor.id,
            actor.email,
            EntityType.STORE,
            store.id,
            Action.CREATE,
            { onboarding: { correlationId } },
            auditMessage(`Created initial website "${store.name}" for "${organization.name}"`),
            context,
          );
        }
        await this.auditLogService.recordAuditEntryIn(
          tem,
          actor.id,
          actor.email,
          EntityType.USER,
          manager.id,
          Action.CREATE,
          {
            onboarding: { correlationId },
            access: {
              before: null,
              after: { role: ORGANIZATION_ROLE, organizationId: organization.id, storeId: null },
            },
            // Whether an invitation exists — never the token, never its hash.
            invitationIssued: true,
          },
          auditMessage(`Invited "${manager.email}" as ${ORGANIZATION_ROLE} of "${organization.name}"`),
          { organizationId: organization.id, storeId: null },
        );

        return { organization, store, manager, token, idempotent: false, previousStore: null as Store | null };
      }),
    );

    // AFTER COMMIT, AND ONLY AFTER. The database transaction is never held open
    // across a network call to the mail provider.
    //
    // An exact retry deliberately sends NOTHING: it issued no new token, and
    // re-delivering on every retry would turn a duplicate click into a stream
    // of invitations. Resend is an explicit act — and because no attempt was
    // made here, the status is UNKNOWN rather than a guess in either direction.
    let deliveryStatus: InvitationDeliveryStatus = 'UNKNOWN';
    if (!committed.idempotent && committed.token) {
      const delivered = await this.usersService.deliverInviteEmail(committed.manager, actor, committed.token);
      deliveryStatus = delivered ? 'DELIVERED' : 'FAILED';
    }

    const store = committed.store ?? committed.previousStore;
    return {
      organization: {
        id: committed.organization.id,
        name: committed.organization.name,
        slug: committed.organization.slug,
        plan: committed.organization.plan,
        archivedAt: committed.organization.archivedAt ?? null,
      },
      store: store ? { id: store.id, name: store.name, slug: store.slug, websiteUrl: store.websiteUrl ?? null } : null,
      manager: this.usersService.toSafeUser(committed.manager),
      invitation: {
        // D3: acceptance is not part of being an active manager, but the panel
        // must be able to SAY whether the invitation is still outstanding.
        pending: !committed.manager.passwordHash,
        deliveryStatus,
      },
      idempotent: committed.idempotent,
    };
  }

  /**
   * THE SMALLEST BRIDGE FOR RESEND, and why one is needed at all.
   *
   * `UsersService.resendInvite` walls its target with `getManagedUser`, which
   * calls `requireOrganizationScope` — so an UNSCOPED platform owner, which is
   * exactly what the operator is on the onboarding success screen, is refused
   * outright. Without a bridge, D5's "offer a supported resend action" would
   * point at a route the caller cannot use, and the operator would have to
   * enter the brand-new company first just to re-send the invitation that
   * created it.
   *
   * So the organization comes from the PATH, as it does on the access contract,
   * and the target must be an active manager of that organization with a
   * pending invitation. This is deliberately narrower than `resendInvite`: it
   * cannot touch a user who has already finished setup, is not an
   * ORGANIZATION_MANAGER, or belongs to another company.
   *
   * ── DECIDED UNDER THE LOCK, ON WHAT THE LOCK PROTECTS ───────────────────
   *
   * Issuing an invitation is a WRITE that deletes the previous unused token, so
   * it cannot read its eligibility from an unlocked row. Two concurrent
   * resends, or a resend racing a Slice A role change, acceptance or
   * deactivation, would each decide from state the other was replacing. The
   * order is Slice A's, unchanged, so the two contracts serialise against each
   * other rather than merely against themselves:
   *
   *   1. `org-access:<organizationId>` — `lockOrganizationAccess`
   *   2. the target row, `FOR UPDATE` — `lockUsers`
   *   3. reload through the TRANSACTION's entity manager with `refresh: true`,
   *      and validate only from what comes back
   *   4. invalidate, re-issue and audit inside the same transaction
   *   5. deliver, after commit
   *
   * WHAT CANNOT BE UNDONE, stated rather than implied: a mail already handed to
   * the provider cannot be recalled by a rollback. So two resends a second
   * apart may put two links in someone's inbox. The rule that makes that safe
   * is the one `issueInviteTokenIn` already enforces — the NEWEST COMMITTED
   * TOKEN IS THE ONLY VALID ONE, every replaced link is dead on arrival — and
   * step 1 is what makes "newest" well defined instead of a race.
   */
  async resendManagerInvitation(actor: User, organizationId: string, userId: string): Promise<InvitationState> {
    // Before any lock: a malformed id is not a database error. `lockUsers`
    // would hand a non-UUID straight to `where id in (?)` and turn a typo into
    // a 500, and the answer must be the same one a foreign id gets anyway.
    if (!UUID_RE.test(organizationId) || !UUID_RE.test(userId)) {
      throw new BadRequestException('User not found');
    }

    const em = this.organizationRepository.getEntityManager() as EntityManager;
    const { manager, token } = await em.transactional(async (tem) => {
      await lockOrganizationAccess(tem, organizationId);
      // #277 P2: the company's lifecycle, re-read FOR SHARE after the lock the
      // archive takes first. An invitation re-sent while the company archives
      // must not outlive the archive's token revocation.
      const lifecycle = await readOrganizationLifecycleLocked(tem, organizationId);
      // A company that does not exist answers exactly as a user that does not:
      // the probe below must stay indistinguishable for foreign, unknown and
      // malformed ids. Only a company that exists and is inactive says so.
      if (!lifecycle) throw new BadRequestException('User not found');
      if (organizationIsInactive(lifecycle)) {
        throw new BadRequestException('The company is archived — restore it before re-sending invitations');
      }
      await lockUsers(tem, [userId]);

      // `refresh: true`: the row may have been changed by whoever held the lock
      // a moment ago, and a cached instance would describe the state we waited
      // out. Every check below reads this object and nothing else.
      const user = await tem.findOne(
        User,
        { id: userId },
        { populate: ['role', 'store', 'organization'] as never, refresh: true },
      );

      const belongs = user && ((user.organization as any)?.id ?? null) === organizationId;
      // Indistinguishable from a user that does not exist, for the same reason
      // the access contract makes them indistinguishable.
      if (!belongs) throw new BadRequestException('User not found');
      if (user!.deletedAt) throw new BadRequestException('User is deactivated');
      if (user!.role?.name !== ORGANIZATION_ROLE) {
        throw new BadRequestException('That user is not this organization’s manager');
      }
      if (user!.passwordHash) {
        throw new BadRequestException('User already finished their account setup');
      }
      // Replaces any previous unused link — the existing invitation contract.
      const issued = await this.usersService.issueInviteTokenIn(tem, user!);
      await this.auditLogService.recordAuditEntryIn(
        tem,
        actor.id,
        actor.email,
        EntityType.USER,
        user!.id,
        Action.UPDATE,
        { invitationIssued: true },
        auditMessage(`Re-sent onboarding invitation to "${user!.email}"`),
        { organizationId, storeId: null },
      );
      return { manager: user!, token: issued };
    });

    // An explicit act, so its outcome is knowable and reported as such.
    const delivered = await this.usersService.deliverInviteEmail(manager, actor, token);
    return { pending: !manager.passwordHash, deliveryStatus: delivered ? 'DELIVERED' : 'FAILED' };
  }

  /**
   * A UNIQUE INDEX IS NOT AN ERROR MESSAGE.
   *
   * The advisory locks above serialise onboarding against onboarding, and
   * that is all they can do: `POST /users`, `POST /organizations` and
   * `POST /stores` are supported writers that take none of them. One of those,
   * landing between this transaction's read and its insert, still produces a
   * genuine `23505` — and the whole transaction is already rolled back by the
   * time it surfaces, so nothing partial survives.
   *
   * What must not surface is the database's own text. `duplicate key value
   * violates unique constraint "users_email_unique"` names internal schema in a
   * client-facing 500. This maps the constraint to the documented conflict the
   * caller can act on, and says nothing else.
   */
  private async withSanitizedConflicts<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const conflict = this.conflictFromUniqueViolation(error);
      if (conflict) throw conflict;
      throw error;
    }
  }

  private conflictFromUniqueViolation(error: unknown): ConflictException | null {
    const wrapper = error as { code?: string; constraint?: string; previous?: { code?: string; constraint?: string } };
    const driver = wrapper?.previous ?? wrapper;
    const code = driver?.code ?? wrapper?.code;
    if (!(error instanceof UniqueConstraintViolationException) && code !== '23505') return null;

    const constraint = String(driver?.constraint ?? wrapper?.constraint ?? '');
    if (constraint.includes('users_email')) return new ConflictException(EMAIL_TAKEN);
    if (constraint.includes('organizations_slug')) {
      return new ConflictException('Another client took that web address while this one was being created; try again');
    }
    if (constraint.includes('stores_slug')) {
      return new ConflictException('Another website took that address while this one was being created; try again');
    }
    // Sanitized on purpose: an unrecognised constraint still must not put the
    // database's message, or the schema's names, in front of a client.
    return new ConflictException('That client conflicts with one created at the same moment; try again');
  }

  /** Lock 1 — one onboarding per prospective manager at a time. */
  private async lockOnboardingEmail(em: EntityManager, email: string): Promise<void> {
    await em.execute(`select pg_advisory_xact_lock(hashtextextended(?, 0))`, [`onboard-email:${email}`]);
  }

  /**
   * Lock 2 — one ORGANIZATION slug base at a time.
   *
   * Two companies called "Acme" onboarded by two different people never meet on
   * the email lock. Without this they both read "acme" as free and one loses to
   * the unique index with an error about a constraint.
   */
  private async lockOrganizationSlug(em: EntityManager, base: string): Promise<void> {
    await em.execute(`select pg_advisory_xact_lock(hashtextextended(?, 0))`, [`onboard-org-slug:${base}`]);
  }

  /**
   * Lock 3 — one STORE slug base at a time, in its own namespace.
   *
   * `stores.slug` is globally unique and has nothing to do with the company's
   * slug, so two requests with DIFFERENT company names and DIFFERENT emails but
   * the SAME initial-website name pass locks 1 and 2 side by side and collide
   * here. The separate `onboard-store-slug:` prefix is what stops a company and
   * a website that share a name from aliasing onto one key.
   */
  private async lockStoreSlug(em: EntityManager, base: string): Promise<void> {
    await em.execute(`select pg_advisory_xact_lock(hashtextextended(?, 0))`, [`onboard-store-slug:${base}`]);
  }

  /** The slug base each lock is taken on — identical to what allocation uses. */
  private organizationSlugBase(name: string): string {
    return slugify(name) || 'organizacion';
  }

  private storeSlugBase(name: string): string {
    return slugify(name) || 'tienda';
  }

  /** Slug allocation, safe because lock 2 is held for this base. */
  private async uniqueSlugIn(em: EntityManager, name: string): Promise<string> {
    const base = this.organizationSlugBase(name);
    let candidate = base;
    let n = 2;
    while (await em.findOne(Organization, { slug: candidate })) {
      candidate = `${base}-${n}`;
      n += 1;
      if (n > 200) {
        candidate = `${base}-${Date.now().toString(36)}`;
        break;
      }
    }
    return candidate;
  }

  /**
   * Slug allocation, safe because lock 3 is held for this base.
   *
   * `INCLUDING_REMOVED` because `stores_slug_unique` is TOTAL and Slice D keeps
   * it that way: a removed store still holds its web address, so a probe that
   * could not see removed rows would hand out a slug the index still refuses and
   * break onboarding for a reason nobody could see. See `Migration20260912120000`.
   */
  private async uniqueStoreSlugIn(em: EntityManager, name: string): Promise<string> {
    const base = this.storeSlugBase(name);
    let candidate = base;
    let n = 2;
    while (await em.findOne(Store, { slug: candidate })) {
      candidate = `${base}-${n}`;
      n += 1;
      if (n > 200) {
        candidate = `${base}-${Date.now().toString(36)}`;
        break;
      }
    }
    return candidate;
  }

  private normalizeUrl(url: string | null | undefined): string | null {
    const trimmed = norm(url);
    return trimmed ? trimmed.replace(/\/+$/, '') : null;
  }

  /** The organization's initial (oldest) store, for describing a retry. */
  private async initialStoreOf(em: EntityManager, organizationId: string | null): Promise<Store | null> {
    if (!organizationId) return null;
    const stores = await em.find(Store, { organization: organizationId }, { orderBy: { createdAt: 'ASC' }, limit: 1 });
    return stores[0] ?? null;
  }

  /**
   * The state a previous onboarding left behind, or null when this user was not
   * created by one.
   *
   * "Not created by one" is judged strictly: the user must still be an active
   * ORGANIZATION_MANAGER of an organization, with no store. An ADMIN, a
   * deactivated user, or a manager who has since been moved is NOT a retry —
   * it is a conflict, and returning it as success would silently adopt a person
   * into a request that asked to create one.
   *
   * A manager who has ACCEPTED the invitation is still a retry: the request
   * that created them succeeded, and answering their duplicate with a 409 would
   * describe a company that plainly exists as a conflict. What changes is what
   * we can say about the invitation, which by then is no longer pending.
   */
  private async stateOfExistingOnboarding(em: EntityManager, user: User): Promise<OnboardingState | null> {
    if (user.deletedAt) return null;
    if (user.role?.name !== ORGANIZATION_ROLE) return null;
    if (user.store) return null;
    const organizationId = (user.organization as any)?.id ?? null;
    if (!organizationId) return null;
    const organization = await em.findOne(Organization, { id: organizationId });
    if (!organization || organization.archivedAt) return null;

    const store = await this.initialStoreOf(em, organizationId);
    return {
      organizationName: organization.name,
      plan: organization.plan,
      storeName: store ? store.name : null,
      storeWebsiteUrl: store ? (store.websiteUrl ?? null) : null,
      managerEmail: normEmail(user.email),
      managerFirstName: norm(user.firstName),
      managerLastName: norm(user.lastName),
    };
  }

  /**
   * A retry is the WHOLE request repeated, not just a familiar email.
   *
   * "Same email and same organization name" was not enough: two unrelated
   * companies may share a display name, and a second request that changes the
   * website, the plan or the person's name is a different intent that must not
   * be answered with someone else's organization.
   */
  private sameState(a: OnboardingState, b: OnboardingState): boolean {
    return (
      a.organizationName === b.organizationName &&
      a.plan === b.plan &&
      a.storeName === b.storeName &&
      a.storeWebsiteUrl === b.storeWebsiteUrl &&
      a.managerEmail === b.managerEmail &&
      a.managerFirstName === b.managerFirstName &&
      a.managerLastName === b.managerLastName
    );
  }
}
