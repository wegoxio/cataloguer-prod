'use client';

import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { ArrowLeft, ChevronDown, ChevronRight, History } from 'lucide-react';
import AccessDenied from '../../../components/layout/access-denied';
import { canRunCatalogueImport } from '../../../lib/permissions';
import { useAuth } from '../../../lib/auth';
import { useT } from '../../../lib/i18n';
import Badge from '../../../components/ui/badge';
import { importService } from '../services/import.service';
import type { ImportRecord } from '../types/import-record.types';

const TYPE_LABELS: Record<ImportRecord['type'], string> = {
  products: 'Products',
  categories: 'Categories',
};

/**
 * Every past import: rows in vs created/updated/skipped, per run. This list is
 * how "464 rows in, 413 created" stops being a mystery — the skipped rows and
 * their reasons are on the record, expandable per run.
 */
export default function ImportHistory() {
  const { accessToken, scope } = useAuth();
  const t = useT();
  const [expanded, setExpanded] = useState<string | null>(null);

  /**
   * Import history is organization-wide, exactly like running an import: the
   * backend answers a branch ADMIN with 403.
   *
   * That refusal used to be swallowed — `.catch(() => setRecords([]))` turned it
   * into "No imports recorded yet.", which is the failure mode AccessDenied was
   * written for: a refusal that reads as an empty truth. The predicate decides
   * what to RENDER; the backend remains the only thing that decides what is
   * returned.
   */
  const mayReadHistory = canRunCatalogueImport(scope);

  const historyQuery = useQuery({
    queryKey: ['imports', 'legacy-history'],
    enabled: Boolean(accessToken && mayReadHistory),
    queryFn: () => importService.getHistory(accessToken as string),
  });
  const records = historyQuery.isPending ? null : historyQuery.data ?? [];

  if (!mayReadHistory) {
    return (
      <AccessDenied
        title={t('Import history is not available for your access')}
        reason={t('Import history covers the whole company, so it is available to company-wide roles.')}
      />
    );
  }

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <div className="space-y-6">
      <Link
        href="/dashboard/import-export"
        className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
      >
        <ArrowLeft className="h-4 w-4" /> {t('Back to Import / Export')}
      </Link>

      <div>
        <h2 className="text-xl font-bold text-slate-800">{t('Import history')}</h2>
        <p className="text-xs text-slate-500 mt-1">
          {t('Every import that ran: how many rows came in, and what happened to each of them')}
        </p>
      </div>

      {records === null ? (
        <div className="text-slate-500 text-sm">{t('Loading…')}</div>
      ) : records.length === 0 ? (
        <div className="card p-8 text-center">
          <History className="h-8 w-8 text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-500">{t('No imports recorded yet.')}</p>
          <p className="text-xs text-slate-400 mt-1">
            {t('From now on, every import leaves a record here.')}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {records.map((record) => {
            const isOpen = expanded === record.id;
            const unaccounted =
              record.totalRows
                ? record.totalRows - record.created - record.updated - record.skipped
                : 0;
            return (
              <div key={record.id} className="card overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : record.id)}
                  className="w-full p-4 flex items-center justify-between gap-4 text-left hover:bg-slate-50 transition-colors"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-800 truncate">
                      {record.fileName || t('(file name not recorded)')}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {formatDate(record.createdAt)}
                      {record.actorEmail ? ` · ${record.actorEmail}` : ''}
                      {' · '}
                      {t(TYPE_LABELS[record.type] ?? record.type)}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 text-xs">
                    {record.totalRows != null && (
                      <span className="text-slate-500">
                        {t('{count} rows', { count: String(record.totalRows) })}
                      </span>
                    )}
                    <Badge variant="success">{record.created} {t('created')}</Badge>
                    {record.updated > 0 && <Badge variant="neutral">{record.updated} {t('updated')}</Badge>}
                    {record.skipped > 0 && <Badge variant="danger">{record.skipped} {t('skipped')}</Badge>}
                    {record.status === 'RUNNING' && (
                      <Badge variant="danger">{t('Incomplete')}</Badge>
                    )}
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4 text-slate-400" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-slate-400" />
                    )}
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-slate-100 p-4 text-sm space-y-3">
                    <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-600">
                      {record.images > 0 && <span>{t('{count} images linked', { count: String(record.images) })}</span>}
                      {record.groups > 0 && <span>{t('{count} parent products', { count: String(record.groups) })}</span>}
                      {unaccounted > 0 && (
                        <span className="text-amber-700 font-medium">
                          {t('{count} rows unaccounted for — the run may have stopped midway', { count: String(unaccounted) })}
                        </span>
                      )}
                    </div>
                    {record.errors?.length ? (
                      <div>
                        <p className="text-xs font-semibold text-slate-700 mb-1">
                          {t('Skipped rows and why')}
                        </p>
                        <ul className="space-y-0.5 max-h-64 overflow-y-auto">
                          {record.errors.map((error, index) => (
                            <li key={index} className="text-xs text-slate-500">
                              <span className="font-mono text-slate-600">{t('Row {row}', { row: String(error.row) })}</span>
                              {' — '}
                              {error.message}
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400">{t('No row-level problems recorded.')}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
