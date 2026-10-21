'use client';

import React from 'react';
import Link from 'next/link';
import { Building2, Activity } from 'lucide-react';
import { useAuth, userDisplayName } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import Badge from '../../components/ui/badge';
import { useOwnerActivity, useOwnerOverview } from '../../lib/domain-queries';
import { isUnscopedPlatformOwner } from '../../lib/permissions';

// The orange "spark": a company onboarded in the last 7 days is worth noticing
const isRecent = (dateStr: string) => Date.now() - new Date(dateStr).getTime() < 7 * 24 * 60 * 60 * 1000;

function Kpi({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div className="card p-4 overflow-hidden relative">
      {/* orange spark on the hero money metric */}
      {accent && <div className="absolute inset-x-0 top-0 h-[3px] bg-accent" />}
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">{label}</p>
      <p className="text-2xl font-bold text-ink-strong tabular-nums mt-0.5">{value}</p>
      {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
    </div>
  );
}

/**
 * The platform owner's landing view: the business (clients, money,
 * activity) instead of a catalog dashboard that mixes every company.
 */
export default function OwnerDashboard() {
  const { user, scope, accessToken } = useAuth();
  const t = useT();
  const enabled = isUnscopedPlatformOwner(scope);
  const overviewQuery = useOwnerOverview(accessToken, enabled);
  const activityQuery = useOwnerActivity(accessToken, enabled);
  const overview = overviewQuery.data ?? null;
  const activity = activityQuery.data ?? [];


  const money = (value: number) => `$${value.toFixed(value % 1 === 0 ? 0 : 2)}`;
  const activeClients = (overview?.clients ?? []).filter((client: any) => !client.archivedAt);

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-xl font-bold text-slate-800">{t('Dashboard')}</h2>
        <p className="text-xs text-slate-500 mt-1">
          {t('Welcome back,')} <span className="font-semibold text-slate-700">{userDisplayName(user)}</span> —{' '}
          {t('your platform at a glance.')}
        </p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi label={t('Active clients')} value={overview ? String(overview.totals.activeClients) : '—'} />
        <Kpi
          accent
          label={t('Monthly recurring')}
          value={overview ? money(overview.totals.monthlyRecurringUsd) : '—'}
          sub={t('sum of active plans')}
        />
        <Kpi label={t('Client orders this month')} value={overview ? String(overview.totals.ordersThisMonth) : '—'} />
        <Kpi label={t('Client sales this month')} value={overview ? money(overview.totals.revenueThisMonth) : '—'} />
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-bold text-slate-800 inline-flex items-center gap-2">
          <Building2 className="h-4 w-4 text-primary" /> {t('Your clients')}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {activeClients.map((client: any) => (
            <Link key={client.id} href={`/dashboard/website/${client.id}`} className="card p-4 hover:shadow-pop transition-shadow">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="text-sm font-bold text-slate-800 truncate">{client.name}</p>
                  {isRecent(client.createdAt) && <Badge variant="accent">{t('New')}</Badge>}
                </div>
                <Badge variant={client.billingStatus === 'ACTIVE' ? 'success' : 'warning'}>{client.plan.name}</Badge>
              </div>
              <p className="text-xs text-slate-500 mt-2">
                {client.ordersThisMonth} {t('orders')} · {money(client.revenueThisMonth)} {t('this month').toLowerCase()}
              </p>
              <p className="text-[11px] text-slate-400 mt-0.5">
                {client.productsCount} {t('items').toLowerCase()} · {client.usersCount} {t('users').toLowerCase()}
              </p>
            </Link>
          ))}
          {overview && activeClients.length === 0 && (
            <p className="text-xs text-slate-400">{t('No client companies yet.')}</p>
          )}
        </div>
      </div>

      <div>
        <div className="card overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100 flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-bold text-slate-800">{t('Recent activity')}</h3>
          </div>
          <div className="p-4 space-y-2">
            {activity.length === 0 ? (
              <p className="text-xs text-slate-400">{t('Nothing yet.')}</p>
            ) : (
              activity.map((entry) => (
                <div key={entry.id} className="text-xs text-slate-600 flex items-start justify-between gap-3">
                  <span className="min-w-0 truncate">{entry.message}</span>
                  <span className="shrink-0 text-slate-400">{new Date(entry.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              ))
            )}
            <Link href="/dashboard/audit-log" className="inline-block text-xs font-semibold text-primary hover:underline pt-1">
              {t('Audit Log')} →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
