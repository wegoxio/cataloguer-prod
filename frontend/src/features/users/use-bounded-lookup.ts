'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useDebouncedValue } from '../../lib/use-debounced-value';
import { useLatestRequest } from './use-latest-request';

/**
 * The shape any bounded lookup answers with. `TenantLookupPage` satisfies it,
 * and so does the recovery "Removed by" lookup — deliberately, so there is ONE
 * implementation of the four-state rule below rather than one per selector.
 */
export interface BoundedLookupPage<T> {
  items: T[];
  total: number;
  truncated: boolean;
}

/**
 * FOUR OUTCOMES, AND NONE OF THEM IS "[]".
 *
 * A selector that renders an empty array cannot distinguish four different
 * situations that demand four different responses from the operator:
 *
 *   disabled — nothing was asked for yet (no company chosen).
 *   loading  — we are asking. Wait; do not conclude anything.
 *   ready    — we asked and the answer is the answer, including "none".
 *   failed   — we asked and could not find out. This is NOT "none".
 *
 * The previous version collapsed the last two: a failed lookup called
 * `setOrganizations([])`, and the screen then showed a selector with no
 * companies in it and no indication that anything had gone wrong. An operator
 * reading that concludes the platform has no client companies. Turning an
 * unanswered question into a confident, wrong answer is the defect; keeping the
 * four states apart is the fix.
 */
export type LookupState = 'disabled' | 'loading' | 'ready' | 'failed';

export interface BoundedLookup<T> {
  state: LookupState;
  items: T[];
  /** How many match in total — larger than `items.length` when truncated. */
  total: number;
  truncated: boolean;
  error: string | null;
  search: string;
  setSearch: (value: string) => void;
  /** Ask again after a failure, with the search term unchanged. */
  retry: () => void;
}

export interface BoundedLookupOptions<T> {
  /**
   * The fetcher, or null to disable the lookup entirely. Null is how "no
   * company is chosen" is expressed: not an empty result, not a failure.
   */
  fetcher: ((search: string) => Promise<BoundedLookupPage<T>>) | null;
  /**
   * What identifies WHICH set is being looked up — the organization id for a
   * branch lookup, a constant for the company lookup.
   *
   * Changing it does not merely re-fetch: it CLEARS the previous set first, in
   * the same render. A branch belonging to the company the operator just
   * navigated away from must never be visible, never selectable and never
   * submittable, not even for the moment the next request is in flight.
   */
  subject: string;
}

export function useBoundedLookup<T>({ fetcher, subject }: BoundedLookupOptions<T>): BoundedLookup<T> {
  /**
   * The term is stored WITH the subject it was typed for, so a term can never
   * outlive its company. Debouncing the pair rather than the string is what
   * makes the switch immediate: the moment the subject changes, the debounced
   * pair still names the OLD subject, `term` below reads as empty, and the
   * effect asks the new company for its first page without waiting out a
   * debounce that belongs to a company nobody is looking at.
   */
  const [typed, setTyped] = useState<{ subject: string; value: string }>({ subject, value: '' });
  const settled = useDebouncedValue(typed);
  const term = settled.subject === subject ? settled.value : '';
  const setSearch = useCallback((value: string) => setTyped({ subject, value }), [subject]);
  const [nonce, setNonce] = useState(0);
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [state, setState] = useState<LookupState>(fetcher ? 'loading' : 'disabled');
  const [error, setError] = useState<string | null>(null);

  const beginRequest = useLatestRequest();

  /**
   * Keep the fetcher itself out of the dependencies — callers build it inline,
   * so a new function identity every render would re-fetch forever — but keep
   * WHETHER THERE IS ONE in them.
   *
   * Those are different facts, and conflating them cost a working screen: the
   * session's access token arrives a render or two after mount, so the first
   * render has no fetcher and the lookup correctly reports `disabled`. Without
   * `enabled` in the dependency array, the ref quietly gained a fetcher and the
   * effect never ran again — leaving a permanently disabled picker on a page
   * that had finished loading. The browser journey caught it; no unit test did,
   * because a mocked session hands over its token immediately.
   */
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const enabled = !!fetcher;

  // The subject changed — drop the old set BEFORE anything is requested. A
  // search term belongs to the subject it was typed for, so it goes too.
  const previousSubject = useRef(subject);
  if (previousSubject.current !== subject) {
    previousSubject.current = subject;
    setItems([]);
    setTotal(0);
    setTruncated(false);
    setError(null);
    setTyped({ subject, value: '' });
  }

  useEffect(() => {
    const current = fetcherRef.current;
    if (!current) {
      setState('disabled');
      setItems([]);
      setTotal(0);
      setTruncated(false);
      setError(null);
      return;
    }
    const isCurrent = beginRequest();
    setState('loading');
    setError(null);
    current(term)
      .then((page) => {
        // Superseded: write NOTHING. Not the items, and not the state — a
        // stale request reporting "ready" would end the current request's
        // loading indication while it is still in flight.
        if (!isCurrent()) return;
        setItems(page.items);
        setTotal(page.total);
        setTruncated(page.truncated);
        setState('ready');
      })
      .catch((err: any) => {
        if (!isCurrent()) return;
        // A failure keeps NO items. Showing the previous company's branches
        // beside an error is worse than showing none: it is selectable.
        setItems([]);
        setTotal(0);
        setTruncated(false);
        setState('failed');
        setError(err?.message || 'The list could not be loaded');
      });
    // `subject` is a dependency so switching company re-asks even when the
    // debounced term is identical (both empty, which is the common case).
  }, [term, subject, nonce, enabled, beginRequest]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);

  return { state, items, total, truncated, error, search: typed.value, setSearch, retry };
}
