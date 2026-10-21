'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../../lib/auth';
import { canViewAuditLog } from '../../../lib/permissions';
import { useT } from '../../../lib/i18n';
import AccessDenied from '../../../components/layout/access-denied';
import { useDebouncedValue } from '../../../lib/use-debounced-value';
import Input from '../../../components/ui/input';
import Select from '../../../components/ui/select';
import Button from '../../../components/ui/button';
import Badge from '../../../components/ui/badge';
import { useAuditLogs } from '../../../lib/domain-queries';

const ENTITY_TYPES = ['PRODUCT', 'CATEGORY', 'PRODUCT_IMAGE', 'SETTINGS', 'USER'];
const ACTIONS = [
  'CREATE',
  'UPDATE',
  'ARCHIVE',
  'RESTORE',
  'PUBLISH',
  'UNPUBLISH',
  'BULK_ARCHIVE',
  'BULK_RESTORE',
  'BULK_STATUS',
  'BULK_CATEGORY',
  'BULK_PRICING',
  'BULK_INVENTORY',
  'MAKE_PRIMARY',
  'DEACTIVATE',
  'REACTIVATE',
  'PASSWORD_RESET',
];

function actionBadgeVariant(action: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  if (action === 'CREATE') return 'success';
  if (action === 'UPDATE') return 'warning';
  if (action.includes('ARCHIVE') || action === 'DEACTIVATE') return 'danger';
  if (action.includes('RESTORE') || action === 'REACTIVATE') return 'info';
  return 'neutral';
}

export default function AuditLogPage() {
  const t = useT();
  const { user, scope, accessToken } = useAuth();

  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [actorEmail, setActorEmail] = useState('');
  const debouncedActorEmail = useDebouncedValue(actorEmail);
  const [expandedLogId, setExpandedLogId] = useState<string | null>(null);

  const [page, setPage] = useState(1);

  // The audit backend was made authoritative in family 1 and already admits the
  // ORGANIZATION_MANAGER; only this page's role heuristic lagged behind.
  const isAdmin = canViewAuditLog(scope);

  const filters = useMemo(() => ({ entityType, action, actorEmail: debouncedActorEmail, page, limit: 25 }), [entityType, action, debouncedActorEmail, page]);
  const logsQuery = useAuditLogs(accessToken, scope?.organizationId, scope?.storeId, filters, isAdmin);
  const logs = logsQuery.data?.items ?? [];
  const totalPages = logsQuery.data?.totalPages ?? 1;
  const totalCount = logsQuery.data?.total ?? 0;
  const loading = logsQuery.isPending;
  const error = logsQuery.error instanceof Error ? logsQuery.error.message : logsQuery.error ? 'Failed to retrieve audit logs' : null;

  useEffect(() => {
    setPage(1);
  }, [entityType, action, debouncedActorEmail]);

  if (!user) return null;
  if (!isAdmin) {
    return (
      <AccessDenied
        title={t('The audit history is not part of your access')}
        reason={t('The record of operator decisions is available to administrators.')}
      />
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">{t('Audit Log')}</h2>
        <p className="text-xs text-slate-500 mt-1">
          Browse and search accountability records for catalogue write operations
        </p>
      </div>

      {/* Filters */}
      <div className="p-4 bg-slate-50 border border-slate-200 rounded-md flex flex-wrap gap-4 items-end">
        <Input
          label={t('Actor Email')}
          placeholder="e.g. admin@example.com"
          value={actorEmail}
          onChange={(e) => setActorEmail(e.target.value)}
          className="flex-1 min-w-[200px]"
        />
        <Select
          label={t('Entity Type')}
          value={entityType}
          onChange={(e) => setEntityType(e.target.value)}
          className="w-44"
        >
          <option value="">{t('All Entity Types')}</option>
          {ENTITY_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </Select>
        <Select label={t('Action')} value={action} onChange={(e) => setAction(e.target.value)} className="w-44">
          <option value="">{t('All Actions')}</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </Select>
        <Button
          variant="secondary"
          size="sm"
          tooltip={t('Clear all filters')}
          onClick={() => {
            setEntityType('');
            setAction('');
            setActorEmail('');
            setPage(1);
          }}
        >
          Clear Filters
        </Button>
      </div>

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 text-red-700 text-xs rounded-md">{error}</div>
      )}

      {/* Results */}
      <div className="card p-0 border border-slate-200 shadow-sm overflow-hidden bg-white">
        {loading ? (
          <div className="flex items-center justify-center p-12">
            <p className="text-slate-500 text-sm">{t('Loading audit logs...')}</p>
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-12 text-slate-500 space-y-2">
            <p className="text-sm font-semibold">{t('No audit logs found')}</p>
            <p className="text-xs text-slate-400">Try adjusting your filters or checking back later.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 font-semibold text-[10px] uppercase">
                  <th className="px-6 py-3">{t('When')}</th>
                  <th className="px-6 py-3">{t('Who')}</th>
                  <th className="px-6 py-3">{t('Action')}</th>
                  <th className="px-6 py-3">{t('Description')}</th>
                  <th className="px-6 py-3 text-right">{t('Details')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {logs.map((log) => {
                  const hasChanges = log.changes && Object.keys(log.changes).length > 0;
                  const isExpanded = expandedLogId === log.id;

                  return (
                    <React.Fragment key={log.id}>
                      <tr className="hover:bg-slate-50 transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap text-xs text-slate-500">
                          {new Date(log.createdAt).toLocaleString()}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap font-medium text-slate-700">
                          {log.actorEmail || <span className="text-slate-400 italic">System</span>}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <Badge variant={actionBadgeVariant(log.action)}>{log.action}</Badge>
                        </td>
                        <td className="px-6 py-4 text-slate-700 max-w-md">
                          {log.message || <span className="text-slate-400 italic">{log.entityType.toLowerCase()}</span>}
                        </td>
                        <td className="px-6 py-4 text-right whitespace-nowrap">
                          {hasChanges ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-primary"
                              tooltip={t('Show the exact fields that changed')}
                              onClick={() => setExpandedLogId(isExpanded ? null : log.id)}
                            >
                              {isExpanded ? 'Hide Details' : 'View Details'}
                            </Button>
                          ) : (
                            <span className="text-xs text-slate-300">None</span>
                          )}
                        </td>
                      </tr>
                      {isExpanded && hasChanges && (
                        <tr className="bg-slate-50/50">
                          <td colSpan={6} className="px-6 py-4 border-t border-b border-slate-100">
                            <div className="p-3 bg-slate-900 text-slate-100 rounded-md font-mono text-xs overflow-x-auto max-w-[80vw]">
                              <pre>{JSON.stringify(log.changes, null, 2)}</pre>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {logs.length > 0 && (
          <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center justify-between">
            <span className="text-xs text-slate-500">
              Showing <span className="font-medium text-slate-700">{logs.length}</span> of{' '}
              <span className="font-medium text-slate-700">{totalCount}</span> entries
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
              >
                Previous
              </Button>
              <span className="text-xs text-slate-600 font-medium px-2">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
