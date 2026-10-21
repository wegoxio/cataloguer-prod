import { apiFetch } from '../../../lib/api-client';
import type { BulkResult } from '../types/product.types';

/**
 * BULK ACTIONS, SENT IN BOUNDED CHUNKS.
 *
 * The server walks a bulk request's ids one at a time, each with its own
 * queries and its own audit write, inside one HTTP request. Measured, that is
 * roughly a minute per two thousand items and it gets slower as the request's
 * identity map grows, so a single ten-thousand-id request can pass the
 * gateway's timeout AFTER writing part of the set — the one outcome nobody
 * can report honestly. Sending several bounded requests instead means every
 * id has a known state when the run stops.
 *
 * The same shape branch publication has used since ADR 029: chunks in
 * selection order, one at a time, each answer merged into a running total. A
 * chunk that fails outright stops the run. Its own ids become UNCONFIRMED —
 * the server may have applied them before the answer was lost — and only the
 * chunks after it are NOT ATTEMPTED. Per-id failures inside a chunk are a
 * third thing: the server tried them and said no, so they are carried as
 * failures and the run continues.
 */
export const BULK_CHUNK_SIZE = 500;

/**
 * WHICH ACTIONS MAY BE RETRIED OVER UNCONFIRMED IDS.
 *
 * Every action here writes an ABSOLUTE value — this status, this category,
 * this stock count, this price, this set of shops — so applying it twice
 * leaves exactly the state applying it once leaves. Re-sending an id the
 * server already handled changes nothing and reports nothing false.
 *
 * Archive and restore are deliberately absent. They are not writes of a value
 * but transitions with a precondition: the server refuses an already-archived
 * product with "Product is already archived". Re-sending the unconfirmed ids
 * is harmless to the data, but every id the first attempt did apply would come
 * back as a failure, and a run that reported dozens of failures for work that
 * actually succeeded would be a worse answer than no retry at all. For those,
 * only the ids nobody sent may be retried, and the unconfirmed ones are named
 * for a person to look at.
 */
export const RETRY_SAFE_ACTIONS = ['publish', 'draft', 'category', 'inventory', 'pricing', 'stores'] as const;

export function isRetrySafe(action: string): boolean {
  return (RETRY_SAFE_ACTIONS as readonly string[]).includes(action);
}

export interface ChunkedBulkRun extends BulkResult {
  /*
   * THE CHUNK THAT FAILED IS NOT THE SAME AS THE CHUNKS NEVER SENT.
   *
   * A request that fails outright — a timeout, a dropped connection — failed
   * on the way back as easily as on the way out. The server may have applied
   * some, all or none of that chunk before the client stopped hearing from
   * it. Those ids are UNCONFIRMED: nobody can say what happened to them
   * without looking. Calling them "not attempted" would be a claim the client
   * has no way to support, and it is the claim that makes a blind retry look
   * safe.
   *
   * Ids in later chunks were never put on the wire at all. Those really are
   * not attempted, and a retry of them cannot repeat anything.
   */
  unconfirmedIds: string[];
  /** Ids no request ever carried, because the run stopped before them. */
  notAttemptedIds: string[];
  /** Why the run stopped, when it did. Absent on a complete run. */
  stoppedReason?: string;
  chunksSent: number;
  chunksTotal: number;
}

export function chunkIds(ids: string[], size = BULK_CHUNK_SIZE): string[][] {
  if (size < 1) throw new Error('chunk size must be at least 1');
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

export interface ChunkedBulkOptions {
  accessToken: string;
  /** The bulk endpoint, e.g. `/bulk/products/archive`. */
  endpoint: string;
  ids: string[];
  /** Everything the endpoint needs besides the ids. */
  body?: Record<string, unknown>;
  chunkSize?: number;
  onProgress?: (sent: number, total: number) => void;
  /** Injected in tests; the real caller uses the shared client. */
  fetcher?: typeof apiFetch;
}

/**
 * Runs one bulk action over a selection of any size.
 *
 * Never throws for a chunk failure: the run is the answer, including which
 * ids were never sent. It throws only for a caller error, such as an empty
 * selection, which is a bug rather than an outcome.
 */
export async function runChunkedBulk(options: ChunkedBulkOptions): Promise<ChunkedBulkRun> {
  const { accessToken, endpoint, ids, body = {}, chunkSize = BULK_CHUNK_SIZE, onProgress } = options;
  const send = options.fetcher ?? apiFetch;
  const chunks = chunkIds(ids, chunkSize);

  const run: ChunkedBulkRun = {
    successCount: 0,
    failedCount: 0,
    successes: [],
    failures: [],
    unconfirmedIds: [],
    notAttemptedIds: [],
    chunksSent: 0,
    chunksTotal: chunks.length,
  };
  onProgress?.(0, chunks.length);

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    try {
      const answer = await send(endpoint, {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({ ...body, ids: chunk }),
      });
      // An answer that is not a bulk result is not a success: treat it as a
      // stop rather than counting ids the server never confirmed.
      if (!answer || typeof answer.successCount !== 'number') {
        throw new Error('The server did not report what it did');
      }
      run.successCount += answer.successCount ?? 0;
      run.failedCount += answer.failedCount ?? 0;
      run.successes.push(...(answer.successes ?? []));
      run.failures.push(...(answer.failures ?? []));
      run.chunksSent += 1;
      onProgress?.(run.chunksSent, chunks.length);
    } catch (err: any) {
      // This chunk reached the server or did not; nobody here can tell. It is
      // unconfirmed. Everything after it was never sent.
      run.unconfirmedIds = chunk;
      run.notAttemptedIds = chunks.slice(i + 1).flat();
      run.stoppedReason = err?.message || 'The operation stopped';
      return run;
    }
  }
  return run;
}
