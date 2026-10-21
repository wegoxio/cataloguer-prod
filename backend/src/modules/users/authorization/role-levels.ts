/**
 * What each role is allowed to be missing (P0-04).
 *
 * The hole this closes: a tenant user with no store behaved as if global,
 * because "no store" was read everywhere as "sees everything". Only a real
 * SUPER_ADMIN may be unbound; every other role must name its company, and
 * branch-level roles must name their branch.
 *
 * `ADMIN` and `STORE_ADMIN` both appear on purpose. The issue allows renaming
 * ADMIN or introducing STORE_ADMIN alongside it with temporary compatibility;
 * this takes the second route, so existing ADMIN accounts keep working while
 * new users can be created at the correct level.
 */

/** The platform owner. The only role that may have neither company nor branch. */
export const PLATFORM_ROLE = 'SUPER_ADMIN';

/** Spans every branch of one company. Has an organization, no single store. */
export const ORGANIZATION_ROLE = 'ORGANIZATION_MANAGER';

/** Pinned to exactly one branch. */
export const STORE_ROLES = ['STORE_ADMIN', 'ADMIN', 'EDITOR', 'VIEWER'];

export const ALL_ROLES = [PLATFORM_ROLE, ORGANIZATION_ROLE, ...STORE_ROLES];

export interface RoleBinding {
  organizationId?: string | null;
  storeId?: string | null;
  /**
   * The organization of the bound store, when the caller knows it.
   * `undefined` means "not looked up" (the consistency rules are skipped);
   * `null` means "looked up and the store has none" (invalid with a store).
   */
  storeOrganizationId?: string | null;
}

/**
 * Why a role/binding combination is invalid, or null when it is fine.
 *
 * Returning the reason rather than a boolean keeps the message identical at
 * every call site — invitations, reassignment and seeding all reject for the
 * same stated reason. This module stays framework-neutral on purpose: each
 * boundary maps the reason to its own status (401 at login, 403 on requests,
 * 400 on management mutations).
 */
export function roleBindingError(role: string, binding: RoleBinding): string | null {
  if (role === PLATFORM_ROLE) {
    // #194 permits the platform owner to be unbound and does not prohibit it
    // from carrying bindings; none are validated here. How those optional
    // bindings affect request scope is TenantScopeService's decision.
    return null;
  }

  // A role name outside the known model is corruption; guessing what it may
  // access would be the opposite of failing closed.
  if (!ALL_ROLES.includes(role)) {
    return `Unknown role ${role}`;
  }

  if (!binding.organizationId) {
    return `${role} must belong to an organization`;
  }

  if (STORE_ROLES.includes(role) && !binding.storeId) {
    return `${role} must belong to a store`;
  }

  // An organization-level user is not pinned to one branch; carrying a store
  // would make it ambiguous which branch its actions belong to.
  if (role === ORGANIZATION_ROLE && binding.storeId) {
    return `${ORGANIZATION_ROLE} spans the whole organization and cannot be pinned to a store`;
  }

  // #156: presence is not enough — the store must belong to the user's own
  // organization. Defined once, here; every caller shares this rule.
  if (binding.storeId && binding.storeOrganizationId !== undefined) {
    if (!binding.storeOrganizationId) {
      return `${role} is bound to a store that has no organization`;
    }
    if (binding.storeOrganizationId !== binding.organizationId) {
      return `${role} is bound to a store of a different organization`;
    }
  }

  return null;
}

/** The shape `userBindingError` reads — a User loaded with role, store,
 *  store.organization and organization. Structural on purpose so pure unit
 *  tests need no ORM entities. */
export interface BoundUserLike {
  role?: { name?: string } | null;
  organization?: { id?: string } | string | null;
  store?: {
    id?: string;
    archivedAt?: Date | null;
    organization?: { id?: string } | string | null;
  } | null;
}

const idOf = (rel: { id?: string } | string | null | undefined): string | null => {
  if (!rel) return null;
  return typeof rel === 'string' ? rel : (rel.id ?? null);
};

/** Extracts a {@link RoleBinding} from a loaded user — the ONE place entity
 *  shape is interpreted, so callers can never disagree about it. */
export function bindingOfUser(user: BoundUserLike): RoleBinding {
  const store = user.store ?? null;
  return {
    organizationId: idOf(user.organization),
    storeId: store ? (store.id ?? null) : null,
    storeOrganizationId: store ? idOf(store.organization) : undefined,
  };
}

/**
 * Why this persisted user must not act, or null when its bindings are sound.
 *
 * `roleName` defaults to the user's own role; pass a different one to ask
 * "would this user be valid AS that role?" (role changes validate against the
 * committed bindings before mutating anything).
 *
 * Composes {@link roleBindingError} — the rules live there, never restated —
 * and adds the one persisted-state rule the pure binding cannot see: a store
 * binding pointing at an ARCHIVED store is stale and fails closed for every
 * role, the platform owner included, until someone reassigns it.
 */
export function userBindingError(user: BoundUserLike, roleName?: string): string | null {
  const role = roleName ?? user.role?.name;
  if (!role) {
    return 'User has no role';
  }
  const error = roleBindingError(role, bindingOfUser(user));
  if (error) {
    return error;
  }
  if (user.store?.archivedAt) {
    return `${role} is bound to an archived store`;
  }
  return null;
}

/** True when this role may act across several branches of its company. */
export function isOrganizationLevel(role: string): boolean {
  return role === ORGANIZATION_ROLE;
}
