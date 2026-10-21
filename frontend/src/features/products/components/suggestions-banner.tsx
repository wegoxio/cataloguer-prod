'use client';

import React from 'react';
import Button from '../../../components/ui/button';
import { useT } from '../../../lib/i18n';
import SuggestionReview from './suggestion-review';
import { isSuggestionReady, type FamilySuggestion } from '../services/family-suggestions.service';

/**
 * Discovery, where the items are.
 *
 * Suggestions used to live on their own route, which is why the two grouping
 * workflows drifted apart. The banner is deliberately thin: it announces how
 * much is waiting, opens and closes, and delegates the whole review to the one
 * component that owns it.
 *
 * It CANNOT touch the items table's selection — it is given no way to. Loading
 * suggestions must never silently tick checkboxes somebody did not tick, so
 * reviewing one is an explicit act that opens the modal with its OWN members.
 *
 * READING AND ACTING ARE SEPARATE. Anyone who may list the company's products
 * may read what those products look like together — the server already decides
 * which products that is. Acting on one needs the authority manual grouping
 * needs, and a reader is shown the discovery WITHOUT the buttons rather than
 * shown buttons the server would refuse.
 */
export interface SuggestionsBannerProps {
  /** Null while the request is in flight or failed: unknown, not "none". */
  suggestions: FamilySuggestion[] | null;
  /** The SAME authority the bulk grouping action uses — `canManageCatalogue`. */
  canManage: boolean;
  open: boolean;
  onToggle: () => void;
  busyName?: string | null;
  onReview: (suggestion: FamilySuggestion) => void;
  onDismiss: (suggestion: FamilySuggestion) => void;
}

export default function SuggestionsBanner({
  suggestions,
  canManage,
  open,
  onToggle,
  busyName,
  onReview,
  onDismiss,
}: SuggestionsBannerProps) {
  const t = useT();

  // Nothing to announce: no suggestions, or none readable yet.
  if (suggestions === null || suggestions.length === 0) return null;

  // Only READY suggestions are described as waiting to be grouped — promising
  // that a blocked one can be accepted is a promise the create endpoint
  // refuses. Blocked ones are still reviewable, and say what to fix.
  const readyCount = suggestions.filter(isSuggestionReady).length;

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3" data-testid="suggestions-banner">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-xs text-slate-700" data-testid="suggestions-summary">
          {readyCount > 0
            ? /*
               * TWO WHOLE SENTENCES, chosen by the count — never one sentence
               * with an "s" bolted on. English needs both the noun and the verb
               * to agree ("1 group … looks", "2 groups … look"), and Spanish
               * needs the same ("1 grupo … parece", "2 grupos … parecen"), so a
               * suffix rule would be wrong in both languages at once. Same shape
               * as the bulk bar's "{count} product(s) selected".
               */
              t(
                readyCount === 1
                  ? '{n} group of items looks like one product.'
                  : '{n} groups of items look like one product.',
                { n: readyCount } as never,
              )
            : t('Some items look like one product, but need a correction first.')}
        </p>
        <Button
          size="sm"
          variant="secondary"
          data-testid="suggestions-toggle"
          aria-expanded={open}
          aria-controls="suggestions-panel"
          onClick={onToggle}
        >
          {/* "Review" promises an act. To somebody who may only look, the
              honest word for opening a panel is "Show". */}
          {open ? t('Hide') : canManage ? t('Review') : t('Show')}
        </Button>
      </div>
      {open && (
        <div className="mt-3" id="suggestions-panel">
          <SuggestionReview
            suggestions={suggestions}
            canManage={canManage}
            busyName={busyName}
            onReview={onReview}
            onDismiss={onDismiss}
          />
        </div>
      )}
    </div>
  );
}
