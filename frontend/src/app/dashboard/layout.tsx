'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Building2, Loader2, Lock } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import { useManagedTenant, exitManagedTenant } from '../../lib/managed-tenant';
import { BillingStatusProvider, useBillingStatus } from '../../lib/billing-status';
import Sidebar from '../../components/layout/sidebar';
import AccessDenied from '../../components/layout/access-denied';
import { mayOpenDashboardRoute } from '../../lib/route-access';

/** Amber bar shown while the company hasn't paid (panel is read-only). */
function BillingGateBanner() {
  const t = useT();
  // Read once per tenant and refreshed on real billing events (#185), instead
  // of re-fetching on every navigation. `null` while loading keeps the banner
  // hidden, so no company ever sees another's state flash by.
  const { status } = useBillingStatus();

  if (!status || status === 'ACTIVE') return null;
  return (
    <div className="flex items-center gap-2 bg-amber-50 border-b border-amber-200 px-8 py-2.5 text-sm text-amber-800">
      <Lock className="h-4 w-4 shrink-0" />
      <span>
        {status === 'SUSPENDED'
          ? t('Your subscription is paused, so the panel is read-only.')
          : t('Your panel is read-only until the first payment.')}
      </span>
      <Link href="/dashboard/billing" className="font-semibold underline hover:text-amber-900">
        {t('Go to Billing')}
      </Link>
    </div>
  );
}

/**
 * Protects every /dashboard route in one place and provides the
 * persistent sidebar navigation shell.
 */
export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, scope, isLoading, isScopeLoading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const t = useT();
  const managed = useManagedTenant();
  const managing = user?.role === 'SUPER_ADMIN' && !user?.store && managed ? managed : null;

  useEffect(() => {
    if (!isLoading && !user) {
      router.push('/login');
    }
  }, [user, isLoading, router]);

  if (isLoading || (user && isScopeLoading)) {
    return (
      <div className="flex items-center justify-center min-h-[50vh] text-slate-400">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        <span className="text-sm">Loading session...</span>
      </div>
    );
  }

  if (!user) {
    return null; // Redirecting via useEffect
  }

  const routeAllowed = scope ? mayOpenDashboardRoute(pathname, scope) : false;

  return (
    <BillingStatusProvider>
    <div className="flex flex-col flex-1 min-h-0">
      {/* "Manage company" mode: an amber frame encapsulates the whole app so
          there is never a doubt the owner is inside a client's company */}
      <div
        className={
          managing
            ? 'flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden shadow-shell border-[3px] border-amber-400'
            : 'flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden shadow-shell'
        }
      >
        {managing && (
          <div className="flex items-center justify-between gap-3 bg-amber-50 border-b border-amber-300 px-4 py-2 shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <Building2 className="h-4 w-4 text-amber-700 shrink-0" />
              <span className="text-xs text-amber-700">{t('Managing company')}</span>
              <span className="text-sm font-bold text-amber-900 truncate">{managing.organizationName}</span>
            </div>
            <button
              onClick={() => {
                exitManagedTenant();
                router.push('/dashboard');
              }}
              className="shrink-0 px-3 py-1 rounded-full border border-amber-500 text-xs font-semibold text-amber-800 hover:bg-amber-100 transition-colors"
            >
              {t('Back to my platform')}
            </button>
          </div>
        )}
        {/* Floating shell: dark chrome fused to the light content panel */}
        <div className="flex flex-1 min-h-0 min-w-0">
          <Sidebar />
          {/* div, not main: the root layout already renders the <main> landmark */}
          <div className="flex-1 flex flex-col min-h-0 min-w-0 bg-shell">
            <BillingGateBanner />
            {/*
                The page's ONE vertical scroll region.

                `min-h-0` is what lets a flex child actually shrink and scroll
                rather than growing its parent; without it the column stretches to
                fit its content and the overflow silently moves up to an ancestor.
                Bottom padding is deliberately larger than top so a sticky action
                bar can never come to rest on top of the last control.
              */}
              {/*
                `pb-6`, not `pb-24`.

                The 96px was there to clear a sticky footer that no longer
                exists. Left behind it did real harm: `position: sticky;
                bottom: 0` resolves against this element's PADDING box, so the
                footer parked 96px above the visible bottom — across the middle
                of a long mapping form, with a dead band beneath it and mapping
                rows passing behind it. Ordinary breathing room is all this
                needs.
              */}
              <div className="flex-1 min-h-0 overflow-y-auto px-6 pt-6 pb-6">
                {routeAllowed ? children : <AccessDenied />}
              </div>
          </div>
        </div>
      </div>
    </div>
    </BillingStatusProvider>
  );
}
