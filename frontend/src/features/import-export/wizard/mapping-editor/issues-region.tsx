'use client';

import React from 'react';
import { cn } from '../../../../lib/cn';
import type { GroupedIssue, IssueSeverity, SourceAnchor } from '../api/wizard-contract.types';

/**
 * Everything wrong with the import, and what it would take to proceed.
 *
 * The workspace is built around one distinction the legacy importer never made:
 * a **blocking** problem is a fact about the data that no amount of confirming
 * can change, while a **warning** is a decision nobody has made yet. Blending
 * them into a single "errors" list produces either an importer that refuses
 * everything or one that warns about everything and is ignored.
 *
 * So warnings get a checkbox and blocking problems do not. That asymmetry is
 * the point: if blocking issues could be waved through, severity would be a
 * suggestion, and the first time anyone was in a hurry it would be waved
 * through.
 *
 * Repeats are grouped by the server. Eight hundred rows with an unparseable
 * price is one problem, and a list of eight hundred entries is one nobody
 * reads.
 */

const SEVERITY_ORDER: IssueSeverity[] = ['BLOCKING', 'WARNING', 'INFORMATIONAL'];

const SEVERITY_LABEL: Record<IssueSeverity, string> = {
  BLOCKING: 'Must be fixed',
  WARNING: 'Needs your confirmation',
  INFORMATIONAL: 'For your information',
};

const SEVERITY_STYLE: Record<IssueSeverity, string> = {
  BLOCKING: 'border-rose-300 bg-rose-50',
  WARNING: 'border-amber-300 bg-amber-50',
  INFORMATIONAL: 'border-slate-200 bg-slate-50',
};

export function IssuesRegion({
  issues,
  acknowledged,
  onAcknowledge,
  onUnacknowledge,
  onGoToAnchor,
}: {
  issues: GroupedIssue[];
  acknowledged: string[];
  onAcknowledge: (code: string) => void;
  onUnacknowledge: (code: string) => void;
  onGoToAnchor?: (anchor: SourceAnchor) => void;
}) {
  if (issues.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-slate-600" data-testid="issues-empty">
        Nothing to report. Everything in this mapping looks straightforward.
      </p>
    );
  }

  return (
    <div className="space-y-4" data-testid="issues-region">
      {SEVERITY_ORDER.map((severity) => {
        const inSeverity = issues.filter((i) => i.severity === severity);
        if (inSeverity.length === 0) return null;
        return (
          <section key={severity} aria-labelledby={`severity-${severity}`}>
            <h3 id={`severity-${severity}`} className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">
              {SEVERITY_LABEL[severity]}
            </h3>
            <ul className="space-y-2">
              {inSeverity.map((issue) => (
                <IssueCard
                  key={`${issue.code}-${issue.message}`}
                  issue={issue}
                  acknowledged={acknowledged.includes(issue.code)}
                  onAcknowledge={onAcknowledge}
                  onUnacknowledge={onUnacknowledge}
                  onGoToAnchor={onGoToAnchor}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function IssueCard({
  issue,
  acknowledged,
  onAcknowledge,
  onUnacknowledge,
  onGoToAnchor,
}: {
  issue: GroupedIssue;
  acknowledged: boolean;
  onAcknowledge: (code: string) => void;
  onUnacknowledge: (code: string) => void;
  onGoToAnchor?: (anchor: SourceAnchor) => void;
}) {
  const checkboxId = `ack-${issue.code}`;

  return (
    <li className={cn('rounded border p-3', SEVERITY_STYLE[issue.severity])} data-issue={issue.code}>
      <p className="text-sm font-semibold text-slate-800">{issue.message}</p>

      {issue.count > 1 ? (
        // The scale, said plainly. "800 rows" is what tells someone whether
        // this is a typo or a broken column.
        <p className="mt-0.5 text-xs font-medium text-slate-600">Affects {issue.count} rows.</p>
      ) : null}

      {issue.guidance ? <p className="mt-1 text-xs text-slate-700">{issue.guidance}</p> : null}

      {issue.examples.length > 0 ? (
        <div className="mt-2">
          <p className="text-xs font-medium text-slate-600">
            {issue.count > issue.examples.length ? 'First few places:' : 'Where:'}
          </p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {issue.examples.map((anchor, index) => (
              <li key={index}>
                {onGoToAnchor ? (
                  <button
                    type="button"
                    onClick={() => onGoToAnchor(anchor)}
                    className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs font-mono text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                  >
                    {describeAnchor(anchor)}
                  </button>
                ) : (
                  <span className="rounded border border-slate-200 bg-white px-2 py-0.5 text-xs font-mono text-slate-700">
                    {describeAnchor(anchor)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {issue.severity === 'WARNING' ? (
        <div className="mt-2.5 flex items-start gap-2">
          <input
            id={checkboxId}
            type="checkbox"
            checked={acknowledged}
            onChange={() => (acknowledged ? onUnacknowledge(issue.code) : onAcknowledge(issue.code))}
            className="mt-0.5"
          />
          <label htmlFor={checkboxId} className="text-xs font-medium text-slate-800">
            I have read this and want to continue anyway
          </label>
        </div>
      ) : null}

      {issue.severity === 'BLOCKING' ? (
        // Deliberately no control. A blocking problem is not a decision the
        // person is being asked to make, and offering a checkbox would imply
        // it were.
        <p className="mt-2 text-xs font-semibold text-rose-800">
          This has to be fixed in your file or your mapping before the import can run.
        </p>
      ) : null}
    </li>
  );
}

/** A place in the file, in the words the person uses for it. */
export function describeAnchor(anchor: SourceAnchor): string {
  const parts: string[] = [];
  if (anchor.sheet) parts.push(anchor.sheet);
  if (anchor.row !== undefined) parts.push(`row ${anchor.row}`);
  if (anchor.column) parts.push(anchor.column);
  if (parts.length === 0) return anchor.cellRef ?? 'the file';
  return parts.join(' · ');
}
