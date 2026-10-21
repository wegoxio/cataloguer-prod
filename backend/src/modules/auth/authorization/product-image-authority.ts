import { ProductImageAuthority } from '../../storage/policy/storage-url.policy';
import { TenantScope, isUnscopedPlatform } from '../tenancy/tenant-scope';

/**
 * The authority a product-photo URL is validated against (#174, corrected).
 *
 * Derived from the RESOLVED scope and nothing else — never from a request
 * body, never from the session user's own bindings. Three cases, in the order
 * they must be asked:
 *
 *   1. an unscoped platform owner (no company in context) acts globally;
 *   2. an actor NARROWED to one branch is confined to that branch's bank,
 *      whatever its role;
 *   3. everyone else with a company — an un-narrowed ORGANIZATION_MANAGER, or
 *      a SUPER_ADMIN managing a company — may use that company's own banks,
 *      which is exactly `allowedStoreIds` (every live branch of it).
 *
 * An actor with no company and no branch that is not the platform owner gets
 * an organization authority with an empty list, which the policy refuses: a
 * scope that resolved to nothing must grant nothing.
 */
export function productImageAuthorityOf(scope: TenantScope | undefined): ProductImageAuthority {
  if (isUnscopedPlatform(scope)) return { kind: 'platform' };
  const narrowed = scope?.storeId ?? null;
  if (narrowed) return { kind: 'store', storeId: narrowed };
  return { kind: 'organization', allowedStoreIds: [...(scope?.allowedStoreIds ?? [])] };
}
