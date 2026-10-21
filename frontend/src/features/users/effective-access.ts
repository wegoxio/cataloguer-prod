import type { SessionScope } from '../../lib/permissions';
import {
  canCommandInventory,
  canManageCatalogue,
  canManageOrders,
  canManageTeam,
  canRecountInventory,
  canViewAuditLog,
  canViewInventory,
  canViewOrganizationMetrics,
} from '../../lib/permissions';

/**
 * WHAT A ROLE WILL BE ABLE TO DO, before the change is saved (Phase 8 B).
 *
 * The preview is computed by the SAME predicates every screen gates on, fed a
 * hypothetical scope shaped exactly like the one /auth/me would resolve for
 * the target after the change. That is what keeps it truthful: there is no
 * second table of role descriptions to drift from the real gates — if a
 * capability line is wrong here, the screen it describes is wrong too.
 */

/** Branch-shaped roles must be pinned to one store (mirrors role-levels.ts). */
export const STORE_BOUND_ROLES = ['ADMIN', 'EDITOR', 'VIEWER'] as const;

export interface AccessPreviewLine {
  /** Stable key, and the English label the i18n dictionary translates. */
  label: string;
  allowed: boolean;
}

/** The scope the backend would resolve for this role and binding. */
export function hypotheticalScope(role: string, storeId: string | null): SessionScope {
  return {
    platform: role === 'SUPER_ADMIN',
    role,
    organizationId: 'preview-organization',
    storeId,
    allowedStoreIds: storeId ? [storeId] : [],
  };
}

export function effectiveAccessPreview(role: string, storeId: string | null): AccessPreviewLine[] {
  const scope = hypotheticalScope(role, storeId);
  return [
    { label: 'Edit the catalogue', allowed: canManageCatalogue(scope) },
    { label: 'See stock and movements', allowed: canViewInventory(scope) },
    { label: 'Count stock in their own branch', allowed: canRecountInventory(scope) },
    { label: 'Issue company-wide stock commands', allowed: canCommandInventory(scope) },
    { label: 'Manage sales', allowed: canManageOrders(scope) },
    { label: 'Invite people and change roles', allowed: canManageTeam(scope) },
    { label: 'See company-wide metrics', allowed: canViewOrganizationMetrics(scope) },
    { label: 'Read the audit history', allowed: canViewAuditLog(scope) },
  ];
}

/** True when this role cannot exist without a store binding (role-levels.ts). */
export function roleNeedsStore(role: string): boolean {
  return (STORE_BOUND_ROLES as readonly string[]).includes(role);
}
