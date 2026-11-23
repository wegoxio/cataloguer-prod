'use client';

import React from 'react';
import { Archive, FolderTree, Image as ImageIcon, Package, RefreshCw, Sparkles } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { canViewOrganizationMetrics } from '../../../lib/permissions';
import { useT } from '../../../lib/i18n';
import AccessDenied from '../../../components/layout/access-denied';
import Button from '../../../components/ui/button';
import { useDashboardMetrics } from '../../../lib/domain-queries';

type Segment = { label: string; value: number; color: string };
const percentage = (value: number, total: number) => total > 0 ? Math.round((value / total) * 100) : 0;

function Donut({ total, segments, label }: { total: number; segments: Segment[]; label: string }) {
  const radius = 42;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return (
    <div className="relative h-44 w-44 shrink-0" role="img" aria-label={label}>
      <svg viewBox="0 0 112 112" className="h-full w-full -rotate-90">
        <circle cx="56" cy="56" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="12" />
        {segments.filter((segment) => segment.value > 0).map((segment) => {
          const length = total > 0 ? (segment.value / total) * circumference : 0;
          const node = <circle key={segment.label} cx="56" cy="56" r={radius} fill="none" stroke={segment.color} strokeWidth="12" strokeDasharray={`${length} ${circumference - length}`} strokeDashoffset={-offset} />;
          offset += length;
          return node;
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center"><strong className="text-2xl tabular-nums text-slate-900">{total.toLocaleString()}</strong><span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Total</span></div>
    </div>
  );
}

function DistributionCard({ title, description, total, segments }: { title: string; description: string; total: number; segments: Segment[] }) {
  return (
    <section className="card dashboard-card-enter p-5 sm:p-6">
      <h2 className="text-base font-bold text-slate-900">{title}</h2><p className="mt-1 text-xs text-slate-500">{description}</p>
      <div className="mt-5 flex flex-col items-center gap-6 sm:flex-row">
        <Donut total={total} segments={segments} label={`${title}: ${total}`} />
        <div className="w-full flex-1 space-y-4">
          {segments.map((segment) => { const share = percentage(segment.value, total); return (
            <div key={segment.label}>
              <div className="mb-1.5 flex justify-between gap-4 text-sm"><span className="flex items-center gap-2 text-slate-600"><i className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: segment.color }} />{segment.label}</span><strong className="tabular-nums text-slate-900">{segment.value.toLocaleString()} <span className="font-normal text-slate-400">({share}%)</span></strong></div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${share}%`, backgroundColor: segment.color }} /></div>
            </div>
          ); })}
        </div>
      </div>
    </section>
  );
}

function Skeleton() {
  return <div className="space-y-5" aria-label="Loading metrics"><div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[0,1,2,3].map((n) => <div key={n} className="h-28 animate-pulse rounded-2xl bg-white" />)}</div><div className="grid gap-5 lg:grid-cols-2">{[0,1].map((n) => <div key={n} className="h-72 animate-pulse rounded-2xl bg-white" />)}</div></div>;
}

export default function MetricsPage() {
  const { user, scope, accessToken } = useAuth();
  const t = useT();
  const mayView = canViewOrganizationMetrics(scope);
  const query = useDashboardMetrics(accessToken, scope?.organizationId, scope?.storeId, mayView);
  const metrics = query.data ?? null;
  if (!user) return null;
  if (!mayView) return <AccessDenied title={t('Company metrics are not part of your access')} reason={t('The company-wide figures are available to organization administrators.')} />;

  const products = metrics?.products.total ?? 0;
  const categories = metrics?.categories.total ?? 0;
  const images = metrics?.images.total ?? 0;
  const publishedRate = percentage(metrics?.products.published ?? 0, products);
  const categoryRate = percentage(metrics?.categories.active ?? 0, categories);
  const imageRate = percentage(metrics?.images.active ?? 0, images);

  return (
    <div className="mx-auto max-w-[1600px] space-y-6 dashboard-stagger">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">{t('Catalogue overview')}</p><h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-900">{t('Catalogue metrics')}</h1><p className="mt-1 text-sm text-slate-500">{t('A real-time view of publication, organization and media health.')}</p></div><Button variant="secondary" isLoading={query.isFetching} onClick={() => query.refetch()}><RefreshCw className="h-4 w-4" /> {t('Refresh data')}</Button></header>
      {query.isError && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"><span>{t('Catalogue metrics could not be loaded.')}</span><Button size="sm" variant="secondary" onClick={() => query.refetch()}>{t('Retry')}</Button></div>}
      {query.isPending ? <Skeleton /> : metrics ? <>
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[
            { label: t('Published products'), value: metrics.products.published, detail: `${publishedRate}% ${t('of the catalogue')}`, icon: Package, tone: 'bg-blue-50 text-blue-600' },
            { label: t('Active categories'), value: metrics.categories.active, detail: `${categoryRate}% ${t('available')}`, icon: FolderTree, tone: 'bg-violet-50 text-violet-600' },
            { label: t('Active images'), value: metrics.images.active, detail: `${imageRate}% ${t('available')}`, icon: ImageIcon, tone: 'bg-emerald-50 text-emerald-600' },
            { label: t('Archived records'), value: metrics.products.archived + metrics.categories.archived + metrics.images.archived, detail: t('Across products, categories and images'), icon: Archive, tone: 'bg-amber-50 text-amber-600' },
          ].map(({ label, value, detail, icon: Icon, tone }) => <article key={label} className="card dashboard-card-enter p-5"><div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p><p className="mt-2 text-3xl font-bold tabular-nums text-slate-900">{value.toLocaleString()}</p><p className="mt-1 text-xs text-slate-500">{detail}</p></div><span className={`rounded-xl p-2.5 ${tone}`}><Icon className="h-5 w-5" /></span></div></article>)}
        </section>
        <section className="grid gap-5 lg:grid-cols-2">
          <DistributionCard title={t('Product publication')} description={t('How the product catalogue is distributed by status.')} total={metrics.products.total} segments={[{ label: t('Published'), value: metrics.products.published, color: '#2563eb' }, { label: t('Draft'), value: metrics.products.draft, color: '#f59e0b' }, { label: t('Archived'), value: metrics.products.archived, color: '#94a3b8' }]} />
          <DistributionCard title={t('Category status')} description={t('Active navigation structure versus archived categories.')} total={metrics.categories.total} segments={[{ label: t('Active'), value: metrics.categories.active, color: '#7c3aed' }, { label: t('Archived'), value: metrics.categories.archived, color: '#cbd5e1' }]} />
        </section>
        <section className="card dashboard-card-enter p-5 sm:p-6"><div className="flex items-start gap-3"><span className="rounded-xl bg-emerald-50 p-2.5 text-emerald-600"><Sparkles className="h-5 w-5" /></span><div><h2 className="text-base font-bold text-slate-900">{t('Media library health')}</h2><p className="mt-1 text-xs text-slate-500">{t('Availability of assets currently stored in the catalogue.')}</p></div></div><div className="mt-5 grid gap-5 lg:grid-cols-[1fr_220px] lg:items-center"><div><div className="mb-2 flex justify-between text-sm"><span className="text-slate-600">{t('Active images')}</span><strong>{metrics.images.active.toLocaleString()} / {metrics.images.total.toLocaleString()}</strong></div><div className="h-4 overflow-hidden rounded-full bg-slate-100"><div className="h-full rounded-full bg-emerald-500 transition-[width] duration-700" style={{ width: `${imageRate}%` }} /></div><p className="mt-2 text-xs text-slate-500">{imageRate}% {t('of media is active')}</p></div><div className="rounded-xl border border-slate-100 bg-slate-50 p-4 text-center"><p className="text-3xl font-bold tabular-nums text-slate-900">{metrics.images.archived.toLocaleString()}</p><p className="mt-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{t('Archived images')}</p></div></div></section>
      </> : null}
    </div>
  );
}
