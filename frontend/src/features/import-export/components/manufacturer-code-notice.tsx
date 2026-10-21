'use client';

import React from 'react';
import { useT } from '../../../lib/i18n';

export interface ManufacturerCodeMatch {
  code: string;
  outcome: 'NONE' | 'UNIQUE' | 'AMBIGUOUS';
  productIds: string[];
  /** 1-based spreadsheet rows, matching the per-row error channel. */
  rowNumbers: number[];
}

export interface ManufacturerCodeNoticeProps {
  matches: ManufacturerCodeMatch[];
  ambiguities: number;
}

/**
 * What the manufacturer codes in this file would match, BEFORE anything is
 * written (P5-W1 / P5-W5).
 *
 * The wizard's whole promise is that the operator sees the consequence before
 * approving it. An ambiguous code — one answering to two products of this
 * company — is exactly the consequence that must not first surface as a
 * mystery halfway through a commit, so it is stated here with the code and the
 * rows that used it.
 *
 * IT NEVER OFFERS A CHOICE. Picking one of the colliding products would be the
 * silent resolution the contract forbids; the row is refused and the operator
 * fixes the duplicate codes or matches by SKU instead.
 */
export default function ManufacturerCodeNotice({ matches, ambiguities }: ManufacturerCodeNoticeProps) {
  const t = useT();
  if (!matches.length) return null;

  const ambiguous = matches.filter((match) => match.outcome === 'AMBIGUOUS');
  const willUpdate = matches.filter((match) => match.outcome === 'UNIQUE');
  const willCreate = matches.filter((match) => match.outcome === 'NONE');

  return (
    <div className="space-y-2" data-testid="manufacturer-code-notice">
      {ambiguities > 0 && (
        <div
          className="p-3 rounded-md border border-amber-300 bg-amber-50 text-sm text-amber-900"
          data-testid="manufacturer-code-ambiguities"
        >
          <p className="font-bold">
            {t('{count} manufacturer codes match more than one product', { count: String(ambiguities) })}
          </p>
          <p className="text-xs mt-1">
            {t(
              'These rows will NOT be applied. A manufacturer code is the supplier reference, not an identity, so several of your products may legitimately share one — and nothing here will guess which of them you meant.',
            )}
          </p>
          <ul className="text-xs mt-2 space-y-1">
            {ambiguous.map((match) => (
              <li key={match.code} data-testid={`manufacturer-code-ambiguous-${match.code}`}>
                <span className="font-mono">{match.code}</span>{' '}
                {t('matches {count} products; used on rows {rows}', {
                  count: String(match.productIds.length),
                  rows: match.rowNumbers.join(', '),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-[11px] text-slate-500" data-testid="manufacturer-code-summary">
        {t('{updates} codes match one existing product; {creations} are new.', {
          updates: String(willUpdate.length),
          creations: String(willCreate.length),
        })}
      </p>
    </div>
  );
}
