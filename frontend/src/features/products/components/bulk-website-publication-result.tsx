'use client';

import React from 'react';
import Button from '../../../components/ui/button';
import { useT } from '../../../lib/i18n';
import type { BranchPublicationProgress, BulkBranchPublicationRun, Product } from '../types/product.types';

interface BulkWebsitePublicationResultProps {
  run: BulkBranchPublicationRun;
  /** The website the run targeted, for the heading. */
  websiteName: string;
  /** Loaded rows, to show names instead of ids where possible. */
  products: Product[];
  /** The run in flight right now — its own numbers, never a finished run's. */
  progress?: BranchPublicationProgress | null;
  /** True after the operation completed but the list could not be reloaded. */
  refreshFailed?: boolean;
  onRetryNotAttempted?: () => void;
  onDismiss: () => void;
}

/**
 * The combined result of a bulk website publication (ADR 029).
 *
 * Four server outcomes and one client-only one, each with its own count:
 * Updated, Already in that state, Skipped parent cards, Failed, Not attempted.
 * Skipped cards are explained once — they are expected in a "select all"
 * and are not errors. Failures are listed with the server's reason. Ids that
 * were never sent are retried only from the button, never on their own, and
 * a retry folds into THIS result rather than replacing it.
 */
export default function BulkWebsitePublicationResult({
  run,
  websiteName,
  products,
  progress = null,
  refreshFailed = false,
  onRetryNotAttempted,
  onDismiss,
}: BulkWebsitePublicationResultProps) {
  const t = useT();
  const busy = progress !== null;
  const nameOf = (id: string) => products.find((p) => p.id === id)?.name ?? id;
  const failed = run.outcomes.filter((o) => o.outcome === 'FAILED');
  const skipped = run.outcomes.filter((o) => o.outcome === 'SKIPPED_PARENT');
  const drafts = run.outcomes.filter(
    (o) => (o.outcome === 'UPDATED' || o.outcome === 'UNCHANGED') && o.globalStatus === 'DRAFT',
  ).length;

  return (
    <div
      className="rounded-lg border border-slate-200 bg-white p-4 text-sm space-y-3"
      role="status"
      aria-live="polite"
      data-testid="wp-result"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="font-semibold text-slate-900">
          {t('Website publication')}
          {websiteName ? ` — ${websiteName}` : ''}
          {' · '}
          {run.published ? t('Publish here') : t('Hide here')}
        </div>
        <button onClick={onDismiss} className="text-xs text-slate-500 hover:text-slate-800" data-testid="wp-dismiss">
          {t('Dismiss results')}
        </button>
      </div>

      {progress && (
        <p className="text-xs text-slate-500" data-testid="wp-progress">
          {t('Sending {sent} of {total} requests…', { sent: progress.sent, total: progress.total })}
        </p>
      )}

      <ul className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs">
        <li className="rounded bg-emerald-50 text-emerald-800 px-2 py-1" data-testid="wp-updated">
          {t('Updated: {n}', { n: run.updatedCount })}
        </li>
        <li className="rounded bg-slate-100 text-slate-700 px-2 py-1" data-testid="wp-unchanged">
          {t('Already in that state: {n}', { n: run.unchangedCount })}
        </li>
        <li className="rounded bg-amber-50 text-amber-800 px-2 py-1" data-testid="wp-skipped">
          {t('Skipped parent cards: {n}', { n: run.skippedParentCount })}
        </li>
        <li className="rounded bg-red-50 text-red-800 px-2 py-1" data-testid="wp-failed">
          {t('Failed: {n}', { n: run.failedCount })}
        </li>
        <li className="rounded bg-slate-100 text-slate-700 px-2 py-1" data-testid="wp-not-attempted">
          {t('Not attempted: {n}', { n: run.notAttemptedCount })}
        </li>
      </ul>

      {drafts > 0 && (
        <p className="text-xs text-slate-600" data-testid="wp-drafts-note">
          {t('{n} of these are global Drafts and stay off the website until published globally', { n: drafts })}
        </p>
      )}

      {refreshFailed && (
        <p className="text-xs text-amber-800" data-testid="wp-refresh-failed">
          {t('The list could not be refreshed; the website publication itself completed.')}
        </p>
      )}

      {skipped.length > 0 && (
        <details className="text-xs" data-testid="wp-skipped-details">
          <summary className="cursor-pointer text-amber-800">{t('Skipped parent cards: {n}', { n: skipped.length })}</summary>
          <p className="mt-1 text-slate-600">
            {t(
              'A parent card is not published on its own: it appears on a website when at least one of its child products is published there. Select the child products to change what the card shows.',
            )}
          </p>
          <ul className="mt-1 list-disc pl-5 text-slate-700">
            {skipped.map((o) => (
              <li key={o.id}>{nameOf(o.id)}</li>
            ))}
          </ul>
        </details>
      )}

      {failed.length > 0 && (
        <ul className="text-xs text-red-800 list-disc pl-5 space-y-0.5" data-testid="wp-failed-list">
          {failed.map((o) => (
            <li key={o.id}>
              <span className="font-medium">{nameOf(o.id)}</span>
              {o.message ? `: ${o.message}` : ''}
            </li>
          ))}
        </ul>
      )}

      {run.failure && (
        <div className="text-xs text-red-800 space-y-2" data-testid="wp-error">
          <p data-testid="wp-failure-message">
            {t('Request {k} of {n} failed: {message}', {
              k: run.failure.chunkIndex,
              n: run.failure.chunkCount,
              message: run.failure.message,
            })}
          </p>
          <p className="text-slate-600">
            {t('If the interrupted request was applied, those products appear as “Already in that state”.')}
          </p>
          {onRetryNotAttempted && run.notAttemptedIds.length > 0 && (
            <Button size="sm" variant="secondary" data-testid="wp-retry" disabled={busy} onClick={onRetryNotAttempted}>
              {t('Retry the {m} not attempted', { m: run.notAttemptedIds.length })}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
