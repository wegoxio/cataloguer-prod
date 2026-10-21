import {
  canExportCatalogue,
  canManageTeam,
  canRunCatalogueImport,
  canViewAuditLog,
  canViewInventory,
  canViewOrganizationMetrics,
  canViewSubscription,
  isUnscopedPlatformOwner,
  type SessionScope,
} from './permissions';

export function mayOpenDashboardRoute(pathname: string, scope: SessionScope): boolean {
  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/settings')) return true;
  // The websites index is also the store/branch administration surface. It is
  // deliberately visible to an unscoped platform owner, exactly like the
  // sidebar entry; the individual catalogue routes below are tenant-bound.
  if (pathname.startsWith('/dashboard/website')) return true;
  if (pathname.startsWith('/dashboard/clients') || pathname.startsWith('/dashboard/platform-users')) {
    return isUnscopedPlatformOwner(scope);
  }
  if (pathname.startsWith('/dashboard/inventory')) return canViewInventory(scope);
  if (pathname.startsWith('/dashboard/import-export')) {
    return canRunCatalogueImport(scope) || canExportCatalogue(scope);
  }
  if (pathname.startsWith('/dashboard/users')) return canManageTeam(scope);
  if (pathname.startsWith('/dashboard/billing')) {
    return canViewSubscription(scope) || isUnscopedPlatformOwner(scope);
  }
  if (pathname.startsWith('/dashboard/audit-log')) return canViewAuditLog(scope);
  if (pathname.startsWith('/dashboard/metrics')) return canViewOrganizationMetrics(scope);

  // Catalogue routes need an organization resolved by the backend. This also
  // refuses an unscoped platform owner until it enters a client company.
  if (
    pathname.startsWith('/dashboard/products') ||
    pathname.startsWith('/dashboard/categories') ||
    pathname.startsWith('/dashboard/sales')
  ) {
    return Boolean(scope.organizationId);
  }
  return false;
}
