'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Building2,
  ShoppingBag,
  LayoutDashboard,
  FolderTree,
  Package,
  ArrowLeftRight,
  Boxes,
  Globe,
  UserCog,
  UsersRound,
  CreditCard,
  ScrollText,
  BarChart3,
  Settings } from 'lucide-react';
import { LogOut } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useAuth, userDisplayName } from '../../lib/auth';
import {
  canManageTeam,
  canViewOrganizationMetrics,
  canExportCatalogue,
  canRunCatalogueImport,
  canViewAuditLog,
  canViewInventory,
  canViewSubscription,
  effectiveStoreId as effectiveStoreIdOf,
  isPlatformManagingOrganization,
  isUnscopedPlatformOwner,
} from '../../lib/permissions';
import { useManagedTenant, narrowToStore, selectedStoreId } from '../../lib/managed-tenant';
import { useStores } from '../../lib/use-website-config';
import { useT } from '../../lib/i18n';
import { cn } from '../../lib/cn';

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  adminOnly?: boolean;
  unscopedOnly?: boolean;
  /**
   * Visibility decided by a centralized capability instead of a role guess.
   * Items carrying this must NOT also set adminOnly: the capability is the
   * single gate, so ADMIN loses Billing and ORGANIZATION_MANAGER gains the
   * Audit Log its backend access already grants.
   */
  capability?:
    | 'subscription'
    | 'auditLog'
    | 'importExport'
    | 'team'
    | 'metrics'
    | 'inventory';
  // Standard module the company may hide (Settings → Customization)
  hideKey?: string;
  // Catalog work: hidden from the unscoped platform owner, whose sidebar
  // is business-only (they reach client catalogs via Clients → company)
  catalogWork?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  // Platform-owner control panel: cross-client plans, modules and revenue
  { href: '/dashboard/clients', label: 'Clients', icon: Building2, adminOnly: true, unscopedOnly: true },
  // #275: the platform-wide user directory. `unscopedOnly` because the whole
  // point is the actor with NO company — a platform owner working inside one
  // is asking as that company and uses Team there.
  { href: '/dashboard/platform-users', label: 'Platform Users', icon: UsersRound, adminOnly: true, unscopedOnly: true },
  { href: '/dashboard/website', label: 'Websites / Apps', icon: Globe },
  { href: '/dashboard/categories', label: 'Categories', icon: FolderTree, catalogWork: true },
  { href: '/dashboard/products', label: 'Items', icon: Package, catalogWork: true },
  // Phase 8: the ledger finally has an operator surface. Gated by the same
  // capability the routes enforce — a branch admin reads its own branch, an
  // organization manager commands the whole company, editors and viewers
  // never see it because they cannot reach it.
  { href: '/dashboard/inventory', label: 'Inventory', icon: Boxes, catalogWork: true, capability: 'inventory', hideKey: 'INVENTORY' },
  { href: '/dashboard/sales', label: 'Sales', icon: ShoppingBag, catalogWork: true },
  // P5-A2 family 4: the screen carries an organization-wide import workflow
  // and a read-only export, and EDITOR/VIEWER hold neither — the item had no
  // role gate at all, so they reached a page that refuses them.
  { href: '/dashboard/import-export', label: 'Import / Export', icon: ArrowLeftRight, capability: 'importExport', hideKey: 'IMPORT_EXPORT', catalogWork: true },
  // P5-A2 family 6: staffing belongs to the manager too, so the nav follows the
  // shared capability instead of the SUPER_ADMIN|ADMIN guess.
  { href: '/dashboard/users', label: 'Team', icon: UserCog, capability: 'team' },
  { href: '/dashboard/billing', label: 'Billing', icon: CreditCard, capability: 'subscription' },
  // P5-A2 family 3: add-ons are the COMPANY's, and the organization manager
  // that runs the company may ask for them. `adminOnly` (SUPER_ADMIN | ADMIN)
  // hid the page from exactly the role the backend now admits.
  { href: '/dashboard/audit-log', label: 'Audit Log', icon: ScrollText, capability: 'auditLog', hideKey: 'AUDIT_LOG' },
  // P5-A2 family 7: company-wide catalogue metrics — un-narrowed organization
  // authority only; `unscopedOnly` is gone with the cross-tenant view it served.
  { href: '/dashboard/metrics', label: 'Metrics', icon: BarChart3, capability: 'metrics' },
  // Settings is open to everyone: it hosts personal security (password);
  // the global company settings inside stay admin-only
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
];

export default function Sidebar() {
  const pathname = usePathname();
  const { user, scope, logout } = useAuth();
  const router = useRouter();
  const t = useT();
  const { stores } = useStores();
  const inWebsites = pathname.startsWith('/dashboard/website');
  const activeStores = stores.filter((store) => !store.archivedAt);

  const isAdmin = user?.role === 'SUPER_ADMIN' || user?.role === 'ADMIN';

  // Unscoped platform owner: business-only sidebar — catalog modules live
  // inside each company. Entering "Manage company" mode re-scopes the whole
  // panel (apiFetch sends X-Managed-*) and this sidebar acts store-bound.
  //
  // These are two DIFFERENT questions, and asking the first one twice was the
  // bug: once the backend resolves a managed-organization scope the actor is
  // no longer unscoped, so `isUnscopedPlatformOwner && managed` would clear
  // exactly the context it was meant to describe.
  const isUnscopedOwner = isUnscopedPlatformOwner(scope);
  const isManagingTenant = isPlatformManagingOrganization(scope);
  const managed = useManagedTenant();
  // Storage supplies the LABELS for managed mode; the server scope decides
  // whether that mode exists at all. With no confirming scope, no context.
  const managing = isManagingTenant ? managed : null;
  // The selector follows STORAGE, filtered by the server scope — so it also
  // works for an ORGANIZATION_MANAGER, who is never in platform "manage
  // company" mode and whose selection `managing` therefore never described.
  const selectedBranchId = selectedStoreId(managed, scope);
  const effectiveStoreId = effectiveStoreIdOf(scope, user?.store?.id ?? null);

  // Modules the company chose to hide (Settings → Customization)
  const ownStore = effectiveStoreId ? stores.find((store) => store.id === effectiveStoreId) : undefined;
  const hiddenModules = ownStore?.hiddenModules ?? [];

  // One place decides capability-gated navigation; no inline role predicate.
  const capabilityAllows = (item: NavItem): boolean => {
    if (item.capability === 'subscription') {
      // The unscoped owner keeps the minimal placeholder page, not an
      // organization subscription.
      return canViewSubscription(scope) || isUnscopedPlatformOwner(scope);
    }
    if (item.capability === 'auditLog') return canViewAuditLog(scope);
    if (item.capability === 'importExport') return canRunCatalogueImport(scope) || canExportCatalogue(scope);
    if (item.capability === 'team') return canManageTeam(scope);
    if (item.capability === 'metrics') return canViewOrganizationMetrics(scope);
    if (item.capability === 'inventory') return canViewInventory(scope);
    return true;
  };

  const items = NAV_ITEMS.filter(
    (item) =>
      capabilityAllows(item) &&
      (!item.adminOnly || isAdmin) &&
      // #290: `unscopedOnly` means UNSCOPED — which a platform owner stops
      // being the moment they enter a company, not only when they narrow to a
      // branch. Checking `effectiveStoreId` alone left these entries visible
      // while managing a tenant, pointing at endpoints that answer 403 and
      // pages that redirect straight back. This corrects Clients and Platform
      // Users too, which carried the same gap.
      (!item.unscopedOnly || (!effectiveStoreId && !isManagingTenant)) &&
      (!item.hideKey || !effectiveStoreId || !hiddenModules.includes(item.hideKey)) &&
      (!item.catalogWork || !isUnscopedOwner || Boolean(managing)),
  );

  return (
    // `min-h-0` bounds this column to its flex row. Without it the aside grows
    // to fit its nav, the nav's own overflow-y-auto never engages, and the row
    // grows instead — which is how a sidebar ends up competing with the page
    // for the scrollbar.
    <aside className="w-56 shrink-0 min-h-0 bg-gradient-to-b from-[#101623] to-[#1f2937] flex flex-col">
      <div className="px-3 pt-3">
        <Link
          href="/dashboard"
          className="flex items-center justify-center px-3 py-2 rounded-xl bg-white/5 hover:bg-white/[0.07] transition-colors"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/CatalogLogoPrincipal.svg"
            alt="Catalog by Wegox"
            className="h-5 w-auto select-none"
          />
        </Link>
      </div>
      {/* Branch selector: presentation only. It follows the resolved scope so
          a stale browser value cannot conjure it. */}
      {/* Rendered whenever there is a branch to choose, including a company
          with exactly ONE: the selector is also the only way BACK to company
          level, and hiding it below two stores left a narrowed actor stuck
          inside its branch. */}
      {(managing || scope?.role === 'ORGANIZATION_MANAGER') && stores.filter((s) => !s.archivedAt).length > 0 && (
        <div className="px-3 pt-2">
          <select
            value={selectedBranchId}
            onChange={(e) => {
              const store = stores.find((s) => s.id === e.target.value);
              // The third argument is what lets an ORGANIZATION_MANAGER narrow
              // at all: it has no "enter company" step, so nothing seeded the
              // stored tenant and the selection had nowhere to land.
              narrowToStore(
                e.target.value || null,
                store?.name ?? null,
                scope?.organizationId
                  ? { organizationId: scope.organizationId, organizationName: user?.company ?? '' }
                  : null,
              );
            }}
            className="w-full text-xs rounded-lg bg-white/10 text-white border-0 py-1.5 px-2"
            title="Cambiar de sucursal dentro de la empresa"
          >
            <option value="">Todas las sucursales</option>
            {stores
              .filter((s) => !s.archivedAt)
              .map((s) => (
                <option key={s.id} value={s.id} className="text-slate-900">
                  {s.name}
                </option>
              ))}
          </select>
        </div>
      )}
      {/* Scrolls on short screens so the user block below stays reachable */}
      <nav className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1">
        {items.map((item) => {
          const active =
            item.href === '/dashboard' ? pathname === item.href : pathname.startsWith(item.href);
          const Icon = item.icon;
          return (
            <div key={item.href}>
            <Link
              href={item.href}
              className={cn(
                'flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                active
                  ? 'bg-primary text-white'
                  : 'text-slate-300 hover:bg-white/5 hover:text-white',
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {t(item.label)}
            </Link>
              {/* Per-website sub-navigation: expands inside the Websites
                  section, collapses everywhere else */}
              {item.href === '/dashboard/website' && inWebsites && activeStores.length > 0 && (
                <div className="ml-6 mt-1 space-y-0.5">
                  {activeStores.map((store) => {
                    const storeHref = `/dashboard/website/${store.id}`;
                    const storeActive = pathname === storeHref;
                    return (
                      <Link
                        key={store.id}
                        href={storeHref}
                        className={cn(
                          'block px-3 py-1.5 rounded-lg text-xs font-medium truncate transition-colors',
                          storeActive
                            ? 'bg-white/10 text-white'
                            : 'text-slate-400 hover:bg-white/5 hover:text-slate-200',
                        )}
                      >
                        {store.name}
                      </Link>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      {user && (
        <div className="p-3 border-t border-white/10 space-y-2 shrink-0">
          <div className="px-1">
            <p className="text-xs font-semibold text-slate-200 truncate">{userDisplayName(user)}</p>
            <p className="text-[10px] text-slate-500 truncate">{user.email}</p>
          </div>
          <button
            onClick={async () => {
              await logout();
              router.push('/login');
            }}
            className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 border border-white/15 rounded-lg text-xs font-medium text-slate-300 hover:bg-white/5 transition-colors"
          >
            <LogOut className="h-3.5 w-3.5" />
            {t('Sign Out')}
          </button>
        </div>
      )}
    </aside>
  );
}
