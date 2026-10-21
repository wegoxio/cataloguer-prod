'use client';

import React from 'react';
import { Layers, AlertTriangle } from 'lucide-react';
import Button from '../../../components/ui/button';
import { useT } from '../../../lib/i18n';
import {
  isSuggestionReady,
  type FamilySuggestion,
  type SuggestionBlockedReason,
} from '../services/family-suggestions.service';

/**
 * ONE suggestion-review experience, rendered wherever suggestions are shown.
 *
 * There used to be a second grouping workflow: `/dashboard/products/groups` had
 * its own one-click "Group them" that posted straight to the create endpoint —
 * no preflight, no preview, no editable labels, and a red toast when the rules
 * refused. Manual grouping in Items had all of those. Two implementations of
 * one act drift, and this is the drift.
 *
 * So this component OWNS the review, and both surfaces render it: the Items
 * banner and the `/groups` route. Accepting a suggestion opens the same modal
 * manual grouping opens, which means one preflight, one preview, one set of
 * refusals — and this component never creates anything itself.
 */

/** What each blocked reason means, said as something a person can act on. */
export function blockedReasonText(reason: SuggestionBlockedReason, t: (k: string) => string): string {
  switch (reason) {
    case 'MIXED_PUBLICATION_STATUS':
      return t('These items are not all published or all draft. Align their status first.');
    case 'MEMBER_WITHOUT_STORE':
      return t('One of these items is in no shop. A child product has to be sold somewhere.');
    case 'SPECIFICATION_CONFLICT':
      return t('One of these items holds a specification value that a child product cannot have.');
    case 'DUPLICATE_LABEL':
      return t('Two of these items would show the same option, so a shopper could not tell them apart.');
    case 'TOO_FEW_MEMBERS':
      return t('A parent card needs at least two child products.');
    default:
      return t('This group cannot be created yet.');
  }
}

export interface SuggestionReviewProps {
  suggestions: FamilySuggestion[] | null;
  /** Null while the request is in flight or has not been made. */
  canManage: boolean;
  /** Opens the shared grouping modal preseeded with this suggestion. */
  onReview: (suggestion: FamilySuggestion) => void;
  onDismiss: (suggestion: FamilySuggestion) => void;
  /** The suggestion currently being acted on, so its buttons can wait. */
  busyName?: string | null;
}

export default function SuggestionReview({
  suggestions,
  canManage,
  onReview,
  onDismiss,
  busyName,
}: SuggestionReviewProps) {
  const t = useT();
  const [index, setIndex] = React.useState(0);

  // The list shrinks as suggestions are grouped or dismissed. Staying on an
  // index that no longer exists would show an empty card next to "2 of 3".
  React.useEffect(() => {
    const count = suggestions?.length ?? 0;
    if (index > 0 && index >= count) setIndex(Math.max(0, count - 1));
  }, [suggestions, index]);

  if (suggestions === null) {
    return (
      <div className="text-slate-500 text-sm" data-testid="suggestions-loading">
        {t('Loading…')}
      </div>
    );
  }

  if (suggestions.length === 0) {
    return (
      <div className="card p-8 text-center" data-testid="suggestions-empty">
        <Layers className="h-8 w-8 text-slate-300 mx-auto mb-2" />
        <p className="text-sm text-slate-500">{t('Nothing to group right now.')}</p>
        <p className="text-xs text-slate-400 mt-1">
          {t('We only suggest a group when the difference between the names is clearly a colour or a size.')}
        </p>
      </div>
    );
  }

  const current = suggestions[Math.min(index, suggestions.length - 1)];
  const ready = isSuggestionReady(current);
  const busy = busyName === current.name;
  const reasons = current.blockedReasons ?? [];

  return (
    <div className="card p-4 space-y-3" data-testid="suggestion-review">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="font-semibold text-slate-800" data-testid="suggestion-name">
            {current.name}
          </p>
          <p className="text-xs text-slate-500">
            {t('{index} of {total}', { index: index + 1, total: suggestions.length } as never)}
          </p>
        </div>
        {suggestions.length > 1 && (
          <div className="flex items-center gap-1 shrink-0">
            <Button
              size="sm"
              variant="ghost"
              data-testid="suggestion-prev"
              disabled={index === 0}
              onClick={() => setIndex((i) => Math.max(0, i - 1))}
            >
              {t('Previous')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              data-testid="suggestion-next"
              disabled={index >= suggestions.length - 1}
              onClick={() => setIndex((i) => Math.min(suggestions.length - 1, i + 1))}
            >
              {t('Next')}
            </Button>
          </div>
        )}
      </div>

      <ul className="space-y-0.5">
        {current.members.map((member) => {
          // Which member is the problem, rather than only that there is one.
          const draft = member.status && member.status !== 'PUBLISHED';
          const noStore = member.hasStore === false;
          const conflicted = member.hasSpecificationConflict === true;
          return (
            <li key={member.id} className="text-xs text-slate-500 flex items-center gap-2 flex-wrap">
              <span className="inline-block min-w-16 font-medium text-slate-700">{member.label}</span>
              <span className="text-slate-400">— {member.name}</span>
              {draft && (
                <span className="text-amber-700 bg-amber-50 rounded px-1.5" data-testid={`member-draft-${member.id}`}>
                  {t('Draft')}
                </span>
              )}
              {noStore && (
                <span
                  className="text-amber-700 bg-amber-50 rounded px-1.5"
                  data-testid={`member-no-store-${member.id}`}
                >
                  {t('In no shop')}
                </span>
              )}
              {conflicted && (
                <span
                  className="text-amber-700 bg-amber-50 rounded px-1.5"
                  data-testid={`member-conflict-${member.id}`}
                >
                  {t('Specification conflict')}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      {/* A blocked suggestion stays visible — it is useful discovery — but it
          says what to fix and cannot be accepted from here. */}
      {!ready && (
        <div
          className="rounded bg-amber-50 border border-amber-200 p-2 space-y-1"
          role="status"
          data-testid="suggestion-blocked"
        >
          <p className="text-xs font-semibold text-amber-800 flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />
            {t('This group needs a correction before it can be created.')}
          </p>
          {reasons.map((reason) => (
            <p key={reason} className="text-xs text-amber-700" data-testid={`blocked-reason-${reason}`}>
              {blockedReasonText(reason, t)}
            </p>
          ))}
        </div>
      )}

      {canManage && (
        /*
         * WRAPS, and that is load-bearing. The dashboard shell does not
         * collapse its sidebar at 390px, so the content column there is barely
         * eighty pixels wide. A non-wrapping `justify-end` row overflows to the
         * LEFT, which put this button underneath the sidebar — visible, and
         * unclickable, because the nav swallowed the pointer.
         */
        <div className="flex flex-wrap items-center gap-2 justify-end">
          <Button
            size="sm"
            data-testid="suggestion-review-open"
            disabled={!ready || busy}
            aria-describedby={!ready ? 'suggestion-blocked-desc' : undefined}
            tooltip={
              ready
                ? t('Check the details and group these items')
                : t('Fix what is listed above before this group can be created')
            }
            onClick={() => onReview(current)}
          >
            {t('Review')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            data-testid="suggestion-dismiss"
            disabled={busy}
            tooltip={t('Not one parent — never suggest this group again')}
            onClick={() => onDismiss(current)}
          >
            {t('Dismiss')}
          </Button>
        </div>
      )}
      {!ready && (
        <span id="suggestion-blocked-desc" className="sr-only">
          {reasons.map((reason) => blockedReasonText(reason, t)).join(' ')}
        </span>
      )}
    </div>
  );
}
