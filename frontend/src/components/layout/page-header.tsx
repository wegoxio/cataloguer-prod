'use client';

import React from 'react';
import Link from 'next/link';
import { ChevronRight, Building2, Store } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import { useManagedTenant } from '../../lib/managed-tenant';
import { useStores } from '../../lib/use-website-config';
import { effectiveStoreId as effectiveStoreIdOf } from '../../lib/permissions';
import { useT } from '../../lib/i18n';

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * The heading of every operational screen: WHERE you are, and WHOSE data you
 * are looking at.
 *
 * Both halves were missing. Pages began at an `<h2>` with no `<h1>` above it,
 * so a screen reader's document outline started mid-hierarchy; and the only
 * statement of tenant context lived in the sidebar, so an operator deep inside
 * a branch's stock could not tell from the page which company or branch owned
 * the numbers. Context here is DERIVED from the resolved scope, never from a
 * stored label alone — a stale browser value cannot invent a company.
 */
export default function PageHeader({
  title,
  description,
  crumbs = [],
  actions,
}: {
  title: string;
  description?: string;
  crumbs?: Crumb[];
  actions?: React.ReactNode;
}) {
  const t = useT();
  const { user, scope } = useAuth();
  const managed = useManagedTenant();
  const { stores } = useStores();

  const storeId = effectiveStoreIdOf(scope, user?.store?.id ?? null);
  const store = storeId ? stores.find((candidate) => candidate.id === storeId) : undefined;
  // The organization label follows the managed tenant when the platform owner
  // is inside a company; a tenant user's own company needs no announcement.
  const organizationLabel = managed?.organizationName ?? null;
  const storeLabel = store?.name ?? managed?.storeName ?? null;

  return (
    <div className="mb-5 space-y-2">
      {crumbs.length > 0 && (
        <nav aria-label={t('Breadcrumb')}>
          <ol className="flex items-center gap-1 text-xs text-slate-500 flex-wrap">
            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1;
              return (
                <li key={`${crumb.label}-${index}`} className="flex items-center gap-1">
                  {crumb.href && !last ? (
                    <Link href={crumb.href} className="hover:text-primary hover:underline">
                      {crumb.label}
                    </Link>
                  ) : (
                    <span className={last ? 'text-slate-700 font-medium' : undefined} aria-current={last ? 'page' : undefined}>
                      {crumb.label}
                    </span>
                  )}
                  {!last && <ChevronRight className="h-3 w-3 text-slate-300" aria-hidden="true" />}
                </li>
              );
            })}
          </ol>
        </nav>
      )}

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-xl font-bold text-slate-800 truncate">{title}</h1>
          {description && <p className="text-xs text-slate-500 mt-1">{description}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
      </div>

      {(organizationLabel || storeLabel) && (
        <p className="flex items-center gap-3 text-[11px] text-slate-500" data-testid="tenant-context">
          {organizationLabel && (
            <span className="inline-flex items-center gap-1">
              <Building2 className="h-3 w-3" aria-hidden="true" />
              <span className="sr-only">{t('Company')}: </span>
              {organizationLabel}
            </span>
          )}
          {storeLabel && (
            <span className="inline-flex items-center gap-1">
              <Store className="h-3 w-3" aria-hidden="true" />
              <span className="sr-only">{t('Branch')}: </span>
              {storeLabel}
            </span>
          )}
        </p>
      )}
    </div>
  );
}
