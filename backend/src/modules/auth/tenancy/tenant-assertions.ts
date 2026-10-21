import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Store } from '../../stores/entities/store.entity';
import { Product } from '../../products/entities/product.entity';
import { Category } from '../../categories/entities/category.entity';
import { TenantScope, isUnscopedPlatform, scopeAllowsStore } from './tenant-scope';

/**
 * The three checks P0-07 asks for by name. Every id a request supplies —
 * body, query or path — goes through one of these before it is acted on, so
 * an actor of organization A cannot even resolve organization B's UUIDs.
 *
 * All three throw 404, never 403: a foreign id must be indistinguishable from
 * a nonexistent one, otherwise the API confirms what exists elsewhere.
 *
 * A platform actor with no tenant context (scope.platform, no organization)
 * passes every check — that is the Wegox owner acting globally.
 */

/**
 * A real platform owner acting GLOBALLY — no company in context.
 *
 * Exported for #275: the platform user directory is the one read surface
 * whose whole precondition is this state, and it must ask the same question
 * every tenant assertion here already asks rather than re-deriving it.
 */
export const isGlobalPlatform = (scope?: TenantScope | null): boolean =>
  !!scope && scope.platform && !scope.organizationId;

/**
 * THE ONE PLACE SLICE B'S THREE READS ASK THE QUESTION.
 *
 * `GET /users/platform` and the two selectors that feed it —
 * `GET /organizations/lookup` and `GET /organizations/:id/stores/lookup` —
 * exist for exactly one actor and have no other caller. Their `@Roles`
 * decorators keep every non-superadmin out; this keeps out a SUPER_ADMIN who
 * is currently acting INSIDE a company, because that actor is asking AS that
 * company and must not receive a platform-wide answer by sending one header
 * fewer.
 *
 * Stated once, called three times. Two of the three shipped without it: the
 * lookups inherited only the controller's role requirement, so a platform
 * administrator inside a managed company could enumerate every client company
 * on the platform through a selector endpoint. The frontend hides the page;
 * hiding is not a boundary, and the endpoint is.
 *
 * `subject` names the surface so a refusal says which read was refused, while
 * the CONDITION stays in one function that cannot drift between the three.
 */
export function assertGlobalPlatform(scope: TenantScope | undefined, subject: string): void {
  if (!isGlobalPlatform(scope)) {
    throw new ForbiddenException(`${subject} is available only to an unscoped platform administrator`);
  }
}

const organizationIdOf = (entity: any): string | null => {
  const organization = entity?.organization;
  if (!organization) return null;
  return typeof organization === 'string' ? organization : (organization.id ?? null);
};

/**
 * The company a scope may act inside, or a refusal (P5-A2 family 3).
 *
 * Unlike listings that a platform owner may legitimately run globally, the
 * surfaces in this family — API credentials, purchased add-ons, subscription
 * and payment history — are TENANT data. The unscoped platform owner does not
 * receive a global view of them: it must enter a managed organization first,
 * so a platform session can never fall through into another company's
 * commercial records by omission.
 */
export function requireOrganizationScope(scope: TenantScope | undefined): string {
  if (!scope) throw new ForbiddenException('Access denied: no tenant scope resolved');
  const organizationId = scope.organizationId;
  if (typeof organizationId !== 'string' || organizationId.length === 0) {
    throw new ForbiddenException(
      'This requires an organization context; a platform administrator must supply X-Managed-Organization',
    );
  }
  return organizationId;
}

/**
 * Validates an EXPLICIT target store against the resolved scope, and returns it.
 *
 * The target always arrives in the request (query, body or path) — it is never
 * inferred from `req.user.store`, which is the actor-derived source this phase
 * removes. Narrowing binds: an actor that selected one branch may name only
 * that branch, and a store-level role is simply always narrowed.
 *
 *   unscoped platform owner ........ refused (must enter an organization)
 *   un-narrowed OM / managed SA .... any store the scope allows
 *   narrowed OM / managed SA ....... exactly scope.storeId
 *   ADMIN / EDITOR ................. exactly its own store
 *
 * Missing target = 400 (a malformed request); foreign or disallowed target =
 * 404, indistinguishable from a nonexistent one.
 */
export function resolveScopedStoreTarget(scope: TenantScope | undefined, requested: unknown): string {
  requireOrganizationScope(scope);
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new BadRequestException('A target storeId is required for this operation');
  }
  const narrowedTo = scope?.storeId;
  if (typeof narrowedTo === 'string' && narrowedTo.length > 0) {
    if (requested !== narrowedTo) throw new NotFoundException(`Store with ID ${requested} not found`);
    return requested;
  }
  if (!scopeAllowsStore(scope, requested)) {
    throw new NotFoundException(`Store with ID ${requested} not found`);
  }
  return requested;
}

/** True only for the platform owner acting globally — re-exported for controllers. */
export function assertUnscopedPlatformOwner(scope: TenantScope | undefined): void {
  if (!isUnscopedPlatform(scope)) {
    throw new NotFoundException();
  }
}

export async function assertStoreInOrganization(
  em: EntityManager,
  scope: TenantScope | undefined,
  storeId: string,
): Promise<void> {
  if (isGlobalPlatform(scope)) return;
  const store = await em.findOne(Store, { id: storeId }, { populate: ['organization'] as never });
  if (!store || !scope?.organizationId || organizationIdOf(store) !== scope.organizationId) {
    throw new NotFoundException(`Store with ID ${storeId} not found`);
  }
}

/**
 * Resolves requested store ids UNDER the caller's authority, or refuses.
 *
 * Store membership decides what a public storefront shows, so a request that
 * names a store must be answered by "may this actor touch that store?", never
 * by "does that store exist?". Resolving globally and then explaining the
 * failure is what let one company's products be attached to another company's
 * branch: the lookup succeeded, and only the message was reassuring.
 *
 * Ids are de-duplicated FIRST, so repeating one cannot make a resolved set look
 * short and produce a misleading "missing store" error. Every unauthorized,
 * foreign or nonexistent id yields the SAME not-found shape, so a caller cannot
 * learn which sibling branches exist. Nothing is mutated: callers run this
 * before any `stores.set`, pivot creation or flush.
 */
export async function resolveStoresInScope(
  em: EntityManager,
  scope: TenantScope | undefined,
  storeIds: string[] | undefined,
): Promise<Store[]> {
  const wanted = Array.from(new Set(storeIds ?? []));
  if (wanted.length === 0) return [];

  const where: any = { id: { $in: wanted } };
  // A company-wide actor is still confined to its own company; only the
  // platform owner acting globally has no organization to be confined to.
  if (!isGlobalPlatform(scope)) {
    if (!scope?.organizationId) throw new NotFoundException(`Store with ID ${wanted[0]} not found`);
    where.organization = scope.organizationId;
  }

  const found = await em.find(Store, where, { populate: ['organization'] as never });
  const byId = new Map(found.map((store) => [store.id, store]));
  for (const id of wanted) {
    if (!byId.has(id) || !scopeAllowsStore(scope, id)) {
      throw new NotFoundException(`Store with ID ${id} not found`);
    }
  }
  return wanted.map((id) => byId.get(id) as Store);
}

export async function assertProductInOrganization(
  em: EntityManager,
  scope: TenantScope | undefined,
  productId: string,
): Promise<void> {
  if (isGlobalPlatform(scope)) return;
  const product = await em.findOne(Product, { id: productId }, { populate: ['organization'] as never });
  if (!product || !scope?.organizationId || organizationIdOf(product) !== scope.organizationId) {
    throw new NotFoundException(`Product with ID ${productId} not found`);
  }
}

export async function assertCategoryInOrganization(
  em: EntityManager,
  scope: TenantScope | undefined,
  categoryId: string,
): Promise<void> {
  if (isGlobalPlatform(scope)) return;
  const category = await em.findOne(Category, { id: categoryId }, { populate: ['organization'] as never });
  if (!category || !scope?.organizationId || organizationIdOf(category) !== scope.organizationId) {
    throw new NotFoundException(`Category with ID ${categoryId} not found`);
  }
}
