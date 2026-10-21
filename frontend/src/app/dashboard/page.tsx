'use client';

import React from 'react';
import Link from 'next/link';
import {
  FileEdit,
  ImageOff,
  FolderX,
  ClipboardX,
  Globe,
  ExternalLink,
  Activity,
  Megaphone,
  AlertTriangle,
  Layers,
} from 'lucide-react';
import { useAuth, userDisplayName } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import { useStores } from '../../lib/use-website-config';
import Badge from '../../components/ui/badge';
import OwnerDashboard from '../../features/dashboard/owner-dashboard';
import AttentionTile from '../../features/dashboard/attention-tile';
import { canViewAuditLog, isUnscopedPlatformOwner } from '../../lib/permissions';
import { useCatalogDashboard } from '../../lib/domain-queries';

interface AuditEntry {
  id: string;
  actorEmail: string | null;
  action: string;
  entityType: string;
  message: string | null;
  createdAt: string;
}

function timeAgo(iso: string): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

function actionVariant(action: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  if (action === 'CREATE') return 'success';
  if (action === 'UPDATE' || action.startsWith('BULK')) return 'warning';
  if (action.includes('ARCHIVE') || action === 'DEACTIVATE') return 'danger';
  if (action.includes('RESTORE') || action === 'REACTIVATE') return 'info';
  return 'neutral';
}

/** Uniform KPI card for the top strip. */
function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="card p-4">
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">{label}</p>
      <p className="text-2xl font-bold text-ink-strong tabular-nums mt-0.5">{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

export default function DashboardPage() {
  const { scope } = useAuth();
  // The platform owner lands on the business view, not a catalog dashboard —
  // and only a GENUINELY unscoped owner does. Entering "Manage company" mode
  // gives the resolved scope an organization, so this falls through to the
  // catalog view exactly as before — now decided by the backend-resolved scope
  // rather than by an absent store binding plus browser storage. While the
  // scope is still unresolved the answer is the catalog view, which is the
  // fail-closed direction for a privileged surface.
  if (isUnscopedPlatformOwner(scope)) {
    return <OwnerDashboard />;
  }
  return <CatalogDashboard />;
}

function CatalogDashboard() {
  const { user, scope, accessToken } = useAuth();
  const t = useT();
  const { stores } = useStores();
  // Recorded P5-A2 cleanup (D-4.4): the audit-log preview and its fetch were
  // gated on a role guess that excluded the ORGANIZATION_MANAGER the published
  // audit listing already serves. ONLY this decision changes here; every other
  // predicate on this page is untouched.
  const canSeeRecentActivity = canViewAuditLog(scope);
  const activeStores = stores.filter((store) => !store.archivedAt);
  const dashboardQuery = useCatalogDashboard(
    accessToken,
    scope?.organizationId,
    scope?.storeId,
    canSeeRecentActivity,
  );
  const dashboard = dashboardQuery.data;
  const attention = dashboard?.attention ?? { drafts: null, withoutImages: null, withoutCategory: null, missingRequired: null };
  const live = dashboard?.live ?? { products: null, categories: null };
  const activity = (dashboard?.activity ?? []) as AuditEntry[];
  const announcement = dashboard?.announcement ?? null;
  const pulse = dashboard?.pulse ?? null;
  const lowStock = dashboard?.lowStock ?? null;
  const groupable = dashboard?.groupable ?? null;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('Dashboard')}</h2>
          <p className="text-xs text-slate-500 mt-1">
            {t('Welcome back,')} <span className="font-semibold text-slate-700">{userDisplayName(user)}</span>
          </p>
        </div>
      </div>

      {announcement && (
        <div className="card p-4 border-blue-200 bg-blue-50/60 flex items-start gap-3">
          <Megaphone className="h-5 w-5 text-primary shrink-0 mt-0.5" />
          <div className="min-w-0">
            {announcement.title && <p className="text-sm font-bold text-slate-800">{announcement.title}</p>}
            {announcement.body && <p className="text-xs text-slate-600 mt-0.5 whitespace-pre-line">{announcement.body}</p>}
            {announcement.url && (
              <a
                href={announcement.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-block text-xs font-semibold text-primary hover:underline mt-1"
              >
                {t('Learn more')} →
              </a>
            )}
          </div>
        </div>
      )}

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {pulse && (
          <>
            <Kpi
              label={t('Sales today')}
              value={`$${pulse.todayTotal.toFixed(2)}`}
              sub={`${pulse.todayCount} ${t('orders')}`}
            />
            <Kpi
              label={t('Sales this week')}
              value={`$${pulse.weekTotal.toFixed(2)}`}
              sub={`${pulse.weekCount} ${t('orders')}`}
            />
          </>
        )}
        <Kpi
          label={t('published items')}
          value={String(live.products ?? '—')}
          sub={t('what visitors see')}
        />
        <Kpi label={t('active categories')} value={String(live.categories ?? '—')} />
      </div>

      {/* Needs attention — each number links to the pre-filtered list */}
      <div className="space-y-2">
        <h3 className="text-sm font-bold text-slate-800">{t('Needs your attention')}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <AttentionTile
            href="/dashboard/products?status=DRAFT"
            icon={FileEdit}
            count={attention.drafts}
            labelOne={t('draft not yet published')}
            label={t('drafts not yet published')}
            goodLabel={t('no drafts pending — all published')}
          />
          <AttentionTile
            href="/dashboard/products?hasImages=false"
            icon={ImageOff}
            count={attention.withoutImages}
            labelOne={t('item without photos')}
            label={t('items without photos')}
            goodLabel={t('every product has photos')}
          />
          <AttentionTile
            href="/dashboard/products?hasCategory=false"
            icon={FolderX}
            count={attention.withoutCategory}
            labelOne={t('item without a category')}
            label={t('items without a category')}
            goodLabel={t('everything categorized')}
          />
          <AttentionTile
            href="/dashboard/products?complete=false"
            icon={ClipboardX}
            count={attention.missingRequired}
            labelOne={t('item missing required fields')}
            label={t('items missing required fields')}
            goodLabel={t('every required field answered')}
          />
          <AttentionTile
            href="/dashboard/products?lowStock=true"
            icon={AlertTriangle}
            count={lowStock}
            labelOne={t('item low on stock (5 or fewer)')}
            label={t('items low on stock (5 or fewer)')}
            goodLabel={t('stock levels are healthy')}
          />
          <AttentionTile
            href="/dashboard/products?suggestions=open"
            icon={Layers}
            count={groupable}
            testId="tile-groupable"
            labelOne={t('possible product family to review')}
            label={t('possible product families to review')}
            goodLabel={t('nothing waiting to be grouped')}
            unknownLabel={t('possible product families could not be checked')}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Latest orders */}
        {pulse && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-slate-800">{t('Latest orders')}</h3>
              <Link href="/dashboard/sales" className="text-xs text-primary hover:underline">
                {t('view all')}
              </Link>
            </div>
            <div className="card p-2">
              {pulse.latest.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400">
                  {t('When your website receives orders, the newest appear here.')}
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {pulse.latest.map((o: any) => (
                    <li key={o.id} className="px-3 py-2.5 flex items-center justify-between text-xs">
                      <span className="font-mono text-slate-500">#{o.orderNumber}</span>
                      <span className="text-slate-600 truncate px-2 flex-1">{o.customerName || '—'}</span>
                      <span className="font-semibold text-slate-700 tabular-nums">${o.totalUsd}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}

        {/* Recent activity — audit-log capability, not a role guess */}
        {canSeeRecentActivity && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-slate-800">{t('Recent activity')}</h3>
              <Link href="/dashboard/audit-log" className="text-xs text-primary hover:underline">
                {t('view all')}
              </Link>
            </div>
            <div className="card p-2">
              {activity.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-400 flex flex-col items-center gap-2">
                  <Activity className="h-5 w-5" />
                  {t('No activity yet — it will appear here as your team works.')}
                </div>
              ) : (
                <ul className="divide-y divide-slate-100">
                  {activity.map((entry) => (
                    <li key={entry.id} className="px-3 py-2.5 flex items-start gap-2.5">
                      <Badge variant={actionVariant(entry.action)} className="mt-0.5 shrink-0">
                        {entry.action.replace(/_/g, ' ').toLowerCase()}
                      </Badge>
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-slate-700 truncate" title={entry.message || ''}>
                          {entry.message || `${entry.entityType.toLowerCase()} changed`}
                        </p>
                        <p className="text-[10px] text-slate-400">
                          {entry.actorEmail || 'system'} · {timeAgo(entry.createdAt)}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Website shortcuts */}
      {activeStores.length > 0 && (
        <div className="card p-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs">
          <span className="font-semibold text-slate-500">{t('Your websites')}:</span>
          {activeStores.map((store) => (
            <span key={store.id} className="inline-flex items-center gap-1.5">
              <Globe className="h-3.5 w-3.5 text-slate-400" />
              <span className="text-slate-600 font-medium">{store.name}</span>
              {store.websiteUrl ? (
                <a
                  href={store.websiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-1"
                >
                  {t('open site')} <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <span className="text-slate-400 italic">{t('no website connected')}</span>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
