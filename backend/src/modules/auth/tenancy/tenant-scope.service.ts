import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import { Store } from '../../stores/entities/store.entity';
import { ORGANIZATION_LEVEL_ROLES, TenantScope } from './tenant-scope';

/**
 * Builds the TenantScope for a request (P0-03).
 *
 * Two headers narrow the context, and both are validated rather than trusted:
 *  - `X-Managed-Organization` — platform owner acting inside one company
 *  - `X-Managed-Store` — narrowing to one branch, which must belong to the
 *    organization already in scope
 *
 * A store id belonging to another company is refused. That refusal is the
 * point of this service: previously any id the caller sent was accepted as
 * long as the caller was a SUPER_ADMIN.
 */
@Injectable()
export class TenantScopeService {
  constructor(
    @InjectRepository(Store)
    private readonly storeRepository: EntityRepository<Store>,
  ) {}

  async resolve(user: any, headers: Record<string, any> = {}): Promise<TenantScope> {
    const role: string = user?.role?.name ?? '';
    const isPlatform = role === 'SUPER_ADMIN' && !user?.store;

    const header = (name: string): string | null => {
      const raw = headers[name];
      return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    };
    const wantedOrganization = header('x-managed-organization');
    const wantedStore = header('x-managed-store');

    if (isPlatform) {
      return this.platformScope(role, wantedOrganization, wantedStore);
    }

    // The organization comes from the caller's own persisted bindings, never
    // from a header — anything else would let a tenant nominate its own
    // tenancy. Derivation is ROLE-AWARE (#156):
    //  - a store-carrying SUPER_ADMIN reaches here (isPlatform requires no
    //    store) and keeps its pre-existing meaning: scoped through that
    //    store, its organization derived FROM the store; an organization
    //    binding it may also carry plays no part, exactly as before.
    //  - every tenant role uses its own `user.organization` — that is what
    //    makes a store-less ORGANIZATION_MANAGER resolvable at all — and the
    //    auth boundary has already validated it against the store's
    //    organization before any request reaches this point.
    const ownStore = user?.store ?? null;
    const organizationId = role === 'SUPER_ADMIN' ? this.organizationIdOf(ownStore) : this.organizationIdOf(user);

    if (ORGANIZATION_LEVEL_ROLES.includes(role) && organizationId) {
      const siblings = await this.storesOf(organizationId);
      const allowedStoreIds = siblings.map((s) => s.id);
      // A company-level actor may narrow to one of its own branches
      const storeId = wantedStore ?? ownStore?.id ?? null;
      if (storeId && !allowedStoreIds.includes(storeId)) {
        throw new ForbiddenException('That store belongs to another organization');
      }
      return { platform: false, organizationId, storeId, allowedStoreIds, role };
    }

    // Store-level roles are pinned to their own branch. A header naming a
    // different one is refused even when that branch is a sibling — and a
    // user's own organization NEVER widens a store-level role (#156).
    const storeId = ownStore?.id ?? null;
    if (wantedStore && storeId && wantedStore !== storeId) {
      throw new ForbiddenException('You can only act on your own store');
    }
    return {
      platform: false,
      organizationId,
      storeId,
      allowedStoreIds: storeId ? [storeId] : [],
      role,
    };
  }

  /** The platform owner, optionally acting inside one company or branch. */
  private async platformScope(
    role: string,
    wantedOrganization: string | null,
    wantedStore: string | null,
  ): Promise<TenantScope> {
    if (!wantedOrganization && !wantedStore) {
      return { platform: true, organizationId: null, storeId: null, allowedStoreIds: [], role };
    }

    let organizationId = wantedOrganization;
    let storeId: string | null = null;

    // #294 (owner decision 5): entering a REMOVED company by header fails as
    // not found BEFORE any tenant operation is reachable. The organization row
    // is loaded through the ORM, whose default-on filter hides a removed
    // company, so a removed id is indistinguishable from an unknown one;
    // an ARCHIVED company is still enterable (unchanged here; #277's).
    if (organizationId) {
      if (!(await this.organizationIsLive(organizationId))) throw new NotFoundException('Organization not found');
    }
    if (wantedStore) {
      const store = await this.loadStore(wantedStore);
      if (!store) throw new NotFoundException('Store not found');
      // The branch's company is read from the STORED column, never from the
      // populated relation (filtered away for a removed company), and then
      // proved live through the same filtered read as above.
      const storeOrganizationId = await this.liveOrganizationIdOfStore(store.id);
      if (!storeOrganizationId) throw new NotFoundException('Store not found');
      // Both headers given: they must agree, or the request is incoherent
      if (organizationId && storeOrganizationId && storeOrganizationId !== organizationId) {
        throw new ForbiddenException('That store belongs to another organization');
      }
      organizationId = organizationId ?? storeOrganizationId;
      storeId = store.id;
    }

    const siblings = organizationId ? await this.storesOf(organizationId) : [];
    return {
      platform: true,
      organizationId: organizationId ?? null,
      storeId,
      allowedStoreIds: siblings.map((s) => s.id),
      role,
    };
  }

  /**
   * Is the company live (not removed)? A RAW read, on purpose: an ORM
   * `findOne` by primary key answers from the identity map when the row was
   * loaded earlier in the same unit of work, without the filter, and this
   * decision must come from the database every time.
   */
  private async organizationIsLive(organizationId: string): Promise<boolean> {
    const rows = (await this.storeRepository
      .getEntityManager()
      .execute(
        `select 1 as live from organizations where id = ?::uuid and removed_at is null /* removed_at: the managed-scope entry check (#294) */`,
        [organizationId],
      )) as unknown[];
    return rows.length === 1;
  }

  /** The organization id stored on the branch, only if that company is not removed. */
  private async liveOrganizationIdOfStore(storeId: string): Promise<string | null> {
    const rows = (await this.storeRepository
      .getEntityManager()
      .execute(
        `select organization_id from stores where id = ?::uuid /* removed_at: the company is judged next, raw */`,
        [storeId],
      )) as { organization_id: string | null }[];
    const organizationId = rows[0]?.organization_id ?? null;
    if (!organizationId) return null;
    return (await this.organizationIsLive(organizationId)) ? organizationId : null;
  }

  private async loadStore(id: string) {
    return this.storeRepository.findOne({ id, archivedAt: null }, { populate: ['organization'] as never });
  }

  private async storesOf(organizationId: string) {
    return this.storeRepository.find({ organization: organizationId, archivedAt: null }, { fields: ['id'] });
  }

  /** Tolerates the relation being an entity, a reference or a raw id. */
  private organizationIdOf(store: any): string | null {
    if (!store?.organization) return null;
    return typeof store.organization === 'string' ? store.organization : (store.organization.id ?? null);
  }
}
