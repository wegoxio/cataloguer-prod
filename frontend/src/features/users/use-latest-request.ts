'use client';

import { useCallback, useRef } from 'react';

/**
 * LATEST REQUEST WINS — the smallest correct answer to overlapping reads.
 *
 * Two requests issued from one screen can answer in either order. The network
 * does not promise otherwise, and the slower one is frequently the older one:
 * a broad search ("a") is expensive, a narrow one ("alvarez") is cheap, and the
 * operator types the second while the first is still in flight. Whichever
 * lands last used to win, so the screen could settle on results for a query
 * that is no longer on screen, with filters that no longer match — and nothing
 * about the display would say so.
 *
 * Every call to `begin()` invalidates every earlier one. The returned predicate
 * answers "am I still the request the screen is waiting for?", and a stale
 * caller must write NOTHING: not the results, not the error, not the loading
 * flag. Clearing `loading` from a superseded request is its own bug — it says
 * "finished" while the current request is still running.
 *
 * A sequence number rather than `AbortController` on purpose: aborting asks the
 * network to stop, which it may or may not manage in time, and an abort still
 * has to be ignored on arrival. This ignores it directly, works identically in
 * a browser and in a test, and cannot be defeated by a response that was
 * already in flight.
 */
export function useLatestRequest(): () => () => boolean {
  const issued = useRef(0);
  return useCallback(() => {
    const ticket = (issued.current += 1);
    return () => ticket === issued.current;
  }, []);
}
