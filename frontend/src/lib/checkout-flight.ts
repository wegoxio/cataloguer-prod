/**
 * Single-flight for the checkout button (#248, PR C, decision D-9).
 *
 * The backend guarantees that two concurrent checkout requests for one
 * company receive the SAME hosted URL; the page's half of that contract is to
 * not send the second request at all. While one request is in flight, another
 * click joins it and receives its result; once it settles (either way) the
 * next click starts a fresh request.
 */
export function createSingleFlight<T>(): (run: () => Promise<T>) => Promise<T> {
  let inflight: Promise<T> | null = null;
  return (run) => {
    if (inflight) return inflight;
    inflight = run().finally(() => {
      inflight = null;
    });
    return inflight;
  };
}
