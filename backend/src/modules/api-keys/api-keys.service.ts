import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository, QueryOrder } from '@mikro-orm/postgresql';
import { createHash, randomBytes } from 'crypto';
import { ApiKey } from './entities/api-key.entity';
import { Store } from '../stores/entities/store.entity';
import { ApiKeyCapability, DEFAULT_NEW_KEY_CAPABILITIES, normalizeCapabilities } from './api-key-capabilities';

const KEY_PREFIX = 'ck_'; // "catalogue key"
// Avoid a DB write on every catalogue request: refresh lastUsedAt at most
// once per interval.
const LAST_USED_REFRESH_MS = 60_000;

export interface CreatedApiKey {
  id: string;
  name: string;
  prefix: string;
  storeId: string;
  /** Full secret — returned exactly once, never retrievable again */
  key: string;
  /** What this key may do — echoed so the issuer sees exactly what was granted */
  capabilities: ApiKeyCapability[];
  createdAt: Date;
}

export interface VerifiedApiKey {
  /** Store whose catalogue this key exposes (null only for legacy keys) */
  storeId: string | null;
  organizationId: string | null;
  /** The key's granted authority (Phase 6). The guard enforces it per route. */
  capabilities: string[];
}

@Injectable()
export class ApiKeysService {
  constructor(
    @InjectRepository(ApiKey)
    private readonly apiKeyRepository: EntityRepository<ApiKey>,
  ) {}

  private hash(key: string): string {
    return createHash('sha256').update(key).digest('hex');
  }

  async create(
    name: string,
    storeId: string,
    createdByUserId?: string,
    requestedCapabilities?: string[],
  ): Promise<CreatedApiKey> {
    const em = this.apiKeyRepository.getEntityManager();
    const store = await em.findOne(Store, { id: storeId, archivedAt: null });
    if (!store) {
      throw new NotFoundException('Store not found or archived');
    }
    // Omitted means the SECURE default, not the historical everything-key. An
    // empty array or an unknown literal is refused loudly — an issuer who typed
    // a capability wrong must not receive a key with silently different power.
    let capabilities: ApiKeyCapability[];
    if (requestedCapabilities === undefined) {
      capabilities = [...DEFAULT_NEW_KEY_CAPABILITIES];
    } else {
      try {
        capabilities = normalizeCapabilities(requestedCapabilities);
      } catch (error) {
        throw new BadRequestException((error as Error).message);
      }
      if (!capabilities.length) {
        throw new BadRequestException('An API key needs at least one capability');
      }
    }
    const key = KEY_PREFIX + randomBytes(32).toString('base64url'); // 256-bit secret
    const entry = this.apiKeyRepository.create({
      name,
      prefix: key.slice(0, 10),
      keyHash: this.hash(key),
      store,
      createdByUserId: createdByUserId ?? null,
      capabilities,
      createdAt: new Date(),
    });
    await this.apiKeyRepository.getEntityManager().persistAndFlush(entry);
    return {
      id: entry.id,
      name: entry.name,
      prefix: entry.prefix,
      storeId: store.id,
      key,
      capabilities,
      createdAt: entry.createdAt,
    };
  }

  /**
   * PHASE 4 (C14): keys are listed for ONE company, and an organization is
   * REQUIRED.
   *
   * `storeScopeId ? { store } : {}` meant a store-less actor received every
   * company's keys — confirmed live on staging, where a request carrying
   * `X-Managed-Organization` still returned five other tenants' rows, because
   * the header never reached this query. A key belongs to a store, so the
   * company is reached through it.
   *
   * `storeFilterId` narrows further only when the caller explicitly asks for
   * one branch; it is a view preference, never the tenant boundary.
   */
  async findAll(organizationId: string | null, storeFilterId?: string) {
    if (!organizationId) {
      throw new ForbiddenException(
        'Listing API keys requires an organization context; a platform administrator must supply X-Managed-Organization',
      );
    }
    const where: any = storeFilterId
      ? { store: { id: storeFilterId, organization: organizationId } }
      : { store: { organization: organizationId } };
    const keys = await this.apiKeyRepository.find(where, {
      populate: ['store'],
      orderBy: { createdAt: QueryOrder.DESC },
    });
    return keys.map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      store: k.store ? { id: k.store.id, name: k.store.name } : null,
      capabilities: k.capabilities ?? [],
      lastUsedAt: k.lastUsedAt ?? null,
      revokedAt: k.revokedAt ?? null,
      createdAt: k.createdAt,
    }));
  }

  async revoke(id: string) {
    const key = await this.apiKeyRepository.findOne({ id });
    if (!key) {
      throw new NotFoundException('API key not found');
    }
    if (!key.revokedAt) {
      key.revokedAt = new Date();
      await this.apiKeyRepository.getEntityManager().flush();
    }
    return { id: key.id, name: key.name, prefix: key.prefix, revokedAt: key.revokedAt };
  }

  /**
   * Validates a presented key. Returns its store scope, or null when invalid.
   *
   * THE STORE'S LIFECYCLE IS PART OF "VALID" (#293). This method used to check
   * one thing — `revokedAt` on the key itself — and the eleven `/public` routes
   * that trust its answer checked the store's state exactly once between them,
   * in a downstream endpoint. So an ARCHIVED store kept serving its catalogue:
   * products, categories and site identity all answered
   * normally to a website whose branch the tenant had switched off. That was a
   * pre-existing leak, and Slice D closes it here rather than in eleven places.
   *
   * ONE CHOKEPOINT, TWO STATES, AND THE KEY IS NEVER TOUCHED. A removed store's
   * key stops authenticating and an archived store's key stops authenticating,
   * and neither is revoked, rotated, rewritten or deleted. That matters for
   * restoration: bringing a removed store back makes its existing keys work
   * again with no operator action, and bringing back one that was ALREADY
   * archived leaves them unusable — because the store is still archived, and
   * reactivating it is the tenant's own separate decision.
   *
   * THE CHECK BELOW IS THE ONLY THING STANDING HERE, and an earlier draft of
   * this comment claimed otherwise. It argued that `Store` carrying the
   * default-on removal filter would make the populate fail and hide the key by
   * itself, so the explicit test was belt-and-braces. That is wrong twice over:
   * `ApiKey.store` is NULLABLE, and the filter's documented behaviour for a
   * nullable many-to-one is to keep the owning row and null the link rather than
   * hide it — and, measured, the key still authenticated when the `removedAt`
   * clause was deleted. A mutation that removes this line is caught by a test,
   * which is how the claim was found to be false.
   *
   * So: no implicit protection is relied on, and none is claimed. Both states
   * are refused here, explicitly, and `store-removal.pg.spec.ts` kills the
   * mutant for each half separately.
   */
  async verify(key: string): Promise<VerifiedApiKey | null> {
    if (!key || !key.startsWith(KEY_PREFIX)) return null;
    const stored = await this.apiKeyRepository.findOne(
      { keyHash: this.hash(key) },
      { populate: ['store', 'store.organization'] as never },
    );
    if (!stored || stored.revokedAt) return null;

    /**
     * Read INCLUDING removed, and REFRESHED. Two deliberate choices:
     *
     * `INCLUDING_REMOVED`, because the question here is "what state is this
     * store in". A read that could not see a removed store would answer "it is
     * gone" — the same refusal by luck rather than by rule, and it would report
     * a store that never existed identically to one that is merely removed.
     *
     * `refresh: true`, because this is a LIFECYCLE question and the identity
     * map is not a source of truth for one. If anything earlier in the same
     * unit of work loaded this store, `findOne` would hand back that instance
     * and `verify` would decide from a snapshot taken before the removal — or,
     * worse, before the restoration, and keep refusing a branch that is back.
     * Each HTTP request forks its own entity manager so the window is narrow in
     * production; "narrow" is not a property to rest an authentication decision
     * on, and the suite reproduced the stale answer in one line without it.
     */
    const store = await this.apiKeyRepository
      .getEntityManager()
      .findOne(Store, { id: (stored.store as any)?.id ?? stored.store }, {
        refresh: true,
      } as never);
    if (!store || store.archivedAt) return null;
    // #294 (owner decision 9): the COMPANY's lifecycle is re-read explicitly,
    // from the branch's stored organization column with a statement that sees
    // every state — never through the ORM relation (filtered away for a
    // removed company) and never only through the branch's own lifecycle.
    const company = (await this.apiKeyRepository.getEntityManager().execute(
      `select o.archived_at as "archivedAt", o.merged_into_organization_id as "mergedIntoOrganizationId"
         from stores s join organizations o on o.id = s.organization_id
        where s.id = ?::uuid /* removed_at: read in every state on purpose; refused below */`,
      [store.id],
    )) as { archivedAt: Date | null; mergedIntoOrganizationId: string | null }[];
    const lifecycle = company[0];
    if (!lifecycle || lifecycle.archivedAt || lifecycle.mergedIntoOrganizationId) return null;

    const now = Date.now();
    if (!stored.lastUsedAt || now - stored.lastUsedAt.getTime() > LAST_USED_REFRESH_MS) {
      stored.lastUsedAt = new Date(now);
      // Best-effort: usage tracking must never break a catalogue request
      await this.apiKeyRepository
        .getEntityManager()
        .flush()
        .catch(() => undefined);
    }
    // The key identifies a branch; the branch identifies the client (P0-10).
    // Both travel with the request so every public query can pin the tenant.
    const organization = (stored.store as any)?.organization;
    return {
      storeId: stored.store?.id ?? null,
      organizationId: organization ? (organization.id ?? organization) : null,
      capabilities: stored.capabilities ?? [],
    };
  }
}
