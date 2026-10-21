import { roleNeedsStore, STORE_BOUND_ROLES } from './effective-access';

/**
 * WHAT THE ACCESS CONTRACT ALLOWS, MIRRORED ONCE (#275).
 *
 * These are not the UI's own opinion about roles. `ORGANIZATION_ASSIGNABLE_ROLES`
 * in `backend/src/modules/organizations/dto/organization-access.dto.ts` is the
 * authority; this is the panel's copy of it, kept in ONE place so a screen
 * cannot quietly offer something the endpoint refuses — or, worse, stop
 * offering something it allows.
 *
 * `SUPER_ADMIN` is absent because platform authority is not an organization's
 * to grant. `STORE_ADMIN` is absent because it is an unused compatibility alias
 * whose disposition is #278; no new surface may spread it. Neither is a display
 * decision — both are refused at the endpoint's validation, before any service.
 */
export const ASSIGNABLE_ROLES = ['ORGANIZATION_MANAGER', 'ADMIN', 'EDITOR', 'VIEWER'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

/** Roles that may never be offered for assignment, and why, for the record. */
export const NEVER_ASSIGNABLE = {
  SUPER_ADMIN: 'platform authority is not an organization’s to grant',
  STORE_ADMIN: 'unused compatibility alias; disposition pending (#278)',
} as const;

/**
 * The two shapes access can take. Deriving the role list FROM the binding is
 * what makes an invalid combination unselectable instead of merely rejected:
 * there is no way to hold "Organization-wide" and `ADMIN` at the same time,
 * because the second list is a function of the first choice.
 */
export type AccessShape = 'ORGANIZATION' | 'BRANCH';

export function rolesForShape(shape: AccessShape): readonly AssignableRole[] {
  return shape === 'ORGANIZATION' ? (['ORGANIZATION_MANAGER'] as const) : (STORE_BOUND_ROLES as readonly AssignableRole[]);
}

export function shapeOfRole(role: string): AccessShape {
  return roleNeedsStore(role) ? 'BRANCH' : 'ORGANIZATION';
}

/**
 * The body the endpoint expects — including `storeId: null`, which is a
 * MEANINGFUL value and not an omission. The DTO validates it when present and
 * requires it to be present, because "I forgot the branch" and "I mean no
 * branch" must not be the same request.
 */
export interface AccessChangeBody {
  role: AssignableRole;
  storeId: string | null;
}

export function accessBody(role: AssignableRole, storeId: string | null): AccessChangeBody {
  return { role, storeId: roleNeedsStore(role) ? storeId : null };
}

/**
 * Why this selection cannot be submitted yet, or null when it can.
 *
 * Mirrors `roleBindingError` in `backend/src/modules/users/role-levels.ts`: a
 * branch role needs a branch, an organization role must not carry one. The
 * server decides; this only stops the panel making a request it knows will be
 * refused, and says why in the operator's language.
 */
export function accessSelectionProblem(role: AssignableRole | null, storeId: string | null): string | null {
  if (!role) return 'Choose a role.';
  if (roleNeedsStore(role) && !storeId) return 'This role works in one branch, so choose the branch.';
  return null;
}

/** A promotion to company-wide authority — the change that needs typing to confirm. */
export function isEscalation(currentRole: string, nextRole: AssignableRole): boolean {
  return nextRole === 'ORGANIZATION_MANAGER' && currentRole !== 'ORGANIZATION_MANAGER';
}

/**
 * ROLES AS WORDS, not as enum constants (#275).
 *
 * The Team table renders `{user.role}`, so an operator has always been shown
 * `ORGANIZATION_MANAGER`. New surfaces say "Organization Manager" in English
 * and carry the established Spanish through the same dictionary every other
 * string uses — which only works if the ENGLISH LABEL is the translation key.
 * Feeding `t()` the enum would have made the English UI show the enum, which is
 * exactly what the browser caught.
 */
export const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'Platform administrator',
  ORGANIZATION_MANAGER: 'Organization Manager',
  ADMIN: 'Branch administrator',
  STORE_ADMIN: 'Branch administrator (legacy)',
  EDITOR: 'Editor',
  VIEWER: 'Viewer',
};

/** The label, or the raw name when a role outside the model somehow appears. */
export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

/** "Company-wide in Acme" / "Branch: Acme · Centro" — access as a sentence. */
export function describeAccess(
  role: string,
  organizationName: string | null,
  storeName: string | null,
  t: (key: string) => string,
): string {
  const company = organizationName ?? t('no company');
  if (!roleNeedsStore(role)) return `${t('Company-wide in')} ${company}`;
  return `${t('Branch:')} ${company} · ${storeName ?? t('no branch')}`;
}
