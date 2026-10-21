'use client';

import React from 'react';
import { useAuth } from '../../../lib/auth';
import { canViewOrganizationMetrics } from '../../../lib/permissions';
import { useT } from '../../../lib/i18n';
import AccessDenied from '../../../components/layout/access-denied';
import { useDashboardMetrics } from '../../../lib/domain-queries';

function MetricCard({ title, id, rows }: { title: string; id: string; rows: [string, number][] }) {
  return (
    <div className="card p-6 border border-slate-200 shadow-sm space-y-4 bg-white">
      <h3 className="text-lg font-bold text-slate-800 border-b border-slate-100 pb-2">{title}</h3>
      <div className="space-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between items-center text-sm">
            <span className="text-slate-500">{label}</span>
            <span id={`metric-${id}-${label.toLowerCase()}`} className="font-semibold text-slate-800">
              {value}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MetricsPage() {
  const { user, scope, accessToken } = useAuth();
  const t = useT();

  // P5-A2 family 7 (option A): these counts are company-wide by construction,
  // so they belong to UN-NARROWED organization authority. A narrowed actor
  // leaves branch context to see them; ADMIN reads branch figures in Reports.
  const isAdmin = canViewOrganizationMetrics(scope);

  const metricsQuery = useDashboardMetrics(accessToken, scope?.organizationId, scope?.storeId, isAdmin);
  const metrics = metricsQuery.data ?? null;
  const loading = metricsQuery.isPending;
  const error = metricsQuery.isError ? 'Unable to load metrics.' : null;

  if (!user) return null;
  if (!isAdmin) {
    return (
      <AccessDenied
        title={t('Company metrics are not part of your access')}
        reason={t('The company-wide figures are available to organization administrators.')}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">Catalogue Metrics</h2>
        <p className="text-xs text-slate-500 mt-1">Real-time aggregate counts across the catalogue</p>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 text-red-700 text-xs rounded-md">{error}</div>
      )}

      {loading ? (
        <div className="text-slate-500 text-sm">Loading metrics...</div>
      ) : metrics ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <MetricCard
            title="Categories"
            id="categories"
            rows={[
              ['Total', metrics.categories.total],
              ['Active', metrics.categories.active],
              ['Archived', metrics.categories.archived],
            ]}
          />
          <MetricCard
            title="Products"
            id="products"
            rows={[
              ['Total', metrics.products.total],
              ['Draft', metrics.products.draft],
              ['Published', metrics.products.published],
              ['Archived', metrics.products.archived],
            ]}
          />
          <MetricCard
            title="Images"
            id="images"
            rows={[
              ['Total', metrics.images.total],
              ['Active', metrics.images.active],
              ['Archived', metrics.images.archived],
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}
