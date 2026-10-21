'use client';

import React from 'react';
import Link from 'next/link';
import { useT } from '../../lib/i18n';

/**
 * A tile says one of THREE things, and it used to say two.
 *
 *   something waits ... amber, navigable, and it names the work
 *   nothing waits ..... green, and NOT a link — pressing "nothing waiting to
 *                       be grouped" used to open a page whose only content was
 *                       an empty state, which reads as broken
 *   we do not know .... the request failed. This was drawn amber with the
 *                       problem wording, so a failed fetch looked like a
 *                       backlog. Neutral, inert, and it says so.
 */
export interface AttentionTileProps {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  /** `null` means the count could not be read — not that it is zero. */
  count: number | null;
  /**
   * The caption for a count of exactly ONE, and the reason it is required
   * rather than optional.
   *
   * The number and the caption are two elements, but a reader sees one phrase:
   * "1" above "possible parent products to review" reads as "1 possible parent
   * products to review". An optional singular is how that comes back the next
   * time a tile is added, so every caller has to answer for its own grammar.
   */
  labelOne: string;
  /** The caption for two or more. */
  label: string;
  goodLabel: string;
  /** Shown when the count could not be read. Defaults to a neutral sentence. */
  unknownLabel?: string;
  testId?: string;
}

export default function AttentionTile({
  href,
  icon: Icon,
  count,
  labelOne,
  label,
  goodLabel,
  unknownLabel,
  testId,
}: AttentionTileProps) {
  const t = useT();
  const isUnknown = count === null;
  const isClean = count === 0;
  const inert = isUnknown || isClean;
  const body = (
    <div className="flex items-center gap-3">
      <div
        className={`p-2 rounded-md ${
          isUnknown
            ? 'bg-slate-100 text-slate-400'
            : isClean
              ? 'bg-emerald-50 text-emerald-600'
              : 'bg-amber-50 text-amber-600'
        }`}
      >
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-2xl font-bold text-ink-strong tabular-nums">{isUnknown ? '—' : count}</p>
        <p className="text-xs text-slate-500">
          {isUnknown
            ? (unknownLabel ?? t('could not be checked just now'))
            : isClean
              ? goodLabel
              : // ONE is its own caption. The clean and unknown states keep
                // their own wording and never inflect: neither is a count.
                count === 1
                ? labelOne
                : label}
        </p>
      </div>
    </div>
  );

  const shell = `card p-4 ${
    inert ? 'cursor-default' : 'transition-all hover:shadow-pop border-amber-200 hover:border-amber-300'
  }`;

  // NOT a link when there is nowhere useful to go. `aria-disabled` alone would
  // still be focusable and clickable; a plain element is inert to every input.
  return inert ? (
    <div className={shell} aria-disabled="true" data-testid={testId} data-state={isUnknown ? 'unknown' : 'clean'}>
      {body}
    </div>
  ) : (
    <Link href={href} className={shell} data-testid={testId} data-state="actionable">
      {body}
    </Link>
  );
}

/**
 * How many suggestions may honestly be described as waiting to be grouped.
 *
 * READY only. A blocked suggestion is still worth showing where it can be read
 * and acted on, but counting it on a tile would promise work the create
 * endpoint refuses. `readyCount` is the backend's own answer; the fallback is
 * for a dashboard served against a backend that predates it, where every
 * suggestion was ready by definition.
 */
export function readySuggestionCount(response: {
  data?: { readiness?: string }[];
  readyCount?: number;
} | null): number {
  const list = response?.data ?? [];
  return response?.readyCount ?? list.filter((s) => (s.readiness ?? 'READY') === 'READY').length;
}
