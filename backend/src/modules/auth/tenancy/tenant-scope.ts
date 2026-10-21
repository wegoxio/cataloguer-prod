// Role names come from the single source of truth rather than repeated string
// literals. `role-levels` imports nothing, so there is no cycle.
import { ORGANIZATION_ROLE, PLATFORM_ROLE } from '../../users/authorization/role-levels';

/**
 * Who the caller is acting as, for this one request (P0-03).
 *
 * Before this, authorization was inferred from `request.user.store`, which the
 * guard rewrote when the platform owner sent `X-Managed-Store`. A mutated user
 * cannot say whether the actor is the platform, a company manager or a single
 * branch — the three cases look identical once the field has been overwritten.
 *
 * TenantScope states it explicitly and is never mutated afterwards.
 */
export interface TenantScope {
  /** A real SUPER_ADMIN. Keeps its powers even while acting inside a company. */
  platform: boolean;

  /** The company in context. Null only for the platform owner acting globally. */
  organizationId: string | null;

  /** The single branch in context, when the actor is narrowed to one. */
  storeId: string | null;

  /**
   * Branches this actor may touch. An empty array means "not restricted by
   * store" and is only ever combined with `platform: true`; anything else must
   * treat an empty list as "nothing".
   */
  allowedStoreIds: string[];

  role: string;
}

/**
 * Roles that may span several branches of one company. ONLY the manager role
 * (#156): the binding rules pin ADMIN to a store, so scope resolution listing
 * it here contradicted them and handed a branch admin every sibling branch.
 */
export const ORGANIZATION_LEVEL_ROLES = ['ORGANIZATION_MANAGER'];

/** Roles bound to exactly one branch. ADMIN is one of them (P0-04 kept it as
 *  a branch-level role for compatibility; its scope now matches). */
export const STORE_LEVEL_ROLES = ['STORE_ADMIN', 'ADMIN', 'EDITOR', 'VIEWER'];

/**
 * True when the scope may act on this store.
 *
 * The platform owner acting globally may act anywhere; everyone else is held
 * to the branches their organization actually owns. This is the single check
 * that stops a store id from another company being accepted.
 */
export function scopeAllowsStore(scope: TenantScope | undefined, storeId: string): boolean {
  if (!scope) return false;
  if (scope.platform && scope.allowedStoreIds.length === 0 && !scope.organizationId) return true;
  return scope.allowedStoreIds.includes(storeId);
}

/**
 * True ONLY for the platform owner acting globally — no company, no branch.
 *
 * Fails closed on shape and pins the ROLE as well as the flag: a scope that
 * merely LOOKS unscoped (both ids null) never grants the global branch, and a
 * platform actor that has entered a company is no longer global. Callers use
 * this where "everything, across tenants" is the alternative to a tenant view,
 * so an accidental grant here is a cross-tenant grant.
 */
export function isUnscopedPlatform(scope: TenantScope | undefined): boolean {
  if (!scope) return false;
  const { platform, organizationId, storeId, role } = scope;
  return platform === true && role === PLATFORM_ROLE && organizationId === null && storeId === null;
}

/**
 * True when the actor may see a company's COMMERCIAL terms — plan, price,
 * contractual limits, payment history (P5-A2 family 3, D-5).
 *
 * Deliberately narrower than "works inside the company": a branch admin runs a
 * store without seeing what the company pays. Deliberately narrower than
 * `platform` too: the unscoped owner is not a paying tenant and receives no
 * tenant commercial rows here — its aggregate view is a separate surface.
 *
 *   ORGANIZATION_MANAGER of the company ....... yes
 *   SUPER_ADMIN inside a managed company ...... yes
 *   SUPER_ADMIN unscoped ...................... no
 *   ADMIN / EDITOR / VIEWER ................... no
 */
export function canReadCommercialTerms(scope: TenantScope | undefined): boolean {
  if (!scope) return false;
  const { platform, organizationId, role } = scope;
  if (typeof organizationId !== 'string' || organizationId.length === 0) return false;
  if (role === ORGANIZATION_ROLE) return true;
  return platform === true && role === PLATFORM_ROLE;
}

/**
 * True when the actor speaks for the WHOLE company, not one branch (B4a2).
 *
 * Some data is owned by the product rather than by a branch — product field
 * values, for instance: one row per (product, field), read by every store that
 * shows that product. Being able to see a product in your own branch does not
 * make you entitled to change what a sibling branch reads, so presence in a
 * store is NOT authority over shared data.
 *
 * The test is the scope itself: a company context, not narrowed to a single
 * branch. A store-level role always carries `storeId`, so it never qualifies;
 * the platform owner acting inside a company qualifies exactly like a company
 * manager, and loses it the moment it narrows to one branch. The unscoped
 * platform owner has no company at all — callers must reject that separately,
 * because "which company?" is a malformed request, not a hidden resource.
 */
export function hasOrganizationWideAuthority(scope: TenantScope | undefined): boolean {
  if (!scope) return false;
  return !!scope.organizationId && scope.storeId === null;
}

/**
 * True when the actor is an ORGANIZATION ADMINISTRATOR of the company in scope
 * (Phase 4, corrected model).
 *
 * DESTRUCTIVE authority over shared, organization-owned data — archiving,
 * restoring or deleting a category, deleting a shared asset — belongs to the
 * company administrator, never to a branch. Creating, reading, updating and
 * USING that data stays open to branch admins.
 *
 * Deliberately stricter than `hasOrganizationWideAuthority`, and deliberately
 * NOT a replacement for it: that predicate is scope-only and is already relied
 * on by product-field, bulk-operation and detach-and-delete call sites, so
 * redefining it would change behaviour well outside this phase. This one
 * additionally pins the ROLE, so no future store-less role silently inherits
 * the power to delete another branch's work.
 *
 *   ORGANIZATION_MANAGER, own company .............. yes
 *   SUPER_ADMIN + X-Managed-Organization ........... yes (tenant operations)
 *   SUPER_ADMIN unscoped ........................... no  — names no company
 *   SUPER_ADMIN narrowed to one store .............. no  — acting as a branch
 *   ADMIN / STORE_ADMIN bound to a store ........... no
 *
 * FAILS CLOSED ON SHAPE. Fields are destructured from the typed `TenantScope`,
 * so a renamed or removed field is a compile error rather than a silent grant;
 * at runtime every branch denies unless the exact expected value is present.
 * `storeId` must be explicitly `null` — were it ever to become optional,
 * `undefined !== null` denies rather than grants.
 */
export function isOrganizationAdministrator(scope: TenantScope | undefined): boolean {
  if (!scope) return false;
  const { organizationId, storeId, role, platform } = scope;
  if (typeof organizationId !== 'string' || organizationId.length === 0) return false;
  if (storeId !== null) return false;
  if (typeof role !== 'string') return false;
  if (role === ORGANIZATION_ROLE) return true;
  return platform === true && role === PLATFORM_ROLE;
}
