import { apiFetch } from '../../../lib/api-client';
import type {
  BranchPublicationItemOutcome,
  BranchPublicationRequestFailure,
  BulkBranchPublicationResult,
  BulkBranchPublicationRun,
} from '../types/product.types';

/**
 * Bulk per-website publication, sent in sequential chunks (ADR 029).
 *
 * The server accepts at most CHUNK_SIZE ids per request. A larger selection is
 * split IN SELECTION ORDER and sent one chunk at a time; each answer is merged
 * into one combined run.
 *
 * A failed request STOPS the run. Nothing is re-sent on its own: the ids of
 * the failed chunk and of every later chunk are recorded as NOT_ATTEMPTED and
 * offered for an explicit retry. Re-sending the interrupted chunk is safe —
 * the operation is idempotent, so whatever it had already applied comes back
 * as UNCHANGED — but it is the person's decision, never the code's.
 *
 * An explicit retry FOLDS into the run it continues (`foldRetry`): only the
 * retried ids' NOT_ATTEMPTED entries are replaced, every earlier UPDATED,
 * UNCHANGED, SKIPPED_PARENT and FAILED outcome keeps its message, and the
 * counts are recomputed from the final outcome set.
 */
export const CHUNK_SIZE = 1000;

export function chunkIds(ids: string[], size = CHUNK_SIZE): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

export function emptyRun(storeId: string, published: boolean, chunksTotal: number): BulkBranchPublicationRun {
  return {
    storeId,
    published,
    updatedCount: 0,
    unchangedCount: 0,
    skippedParentCount: 0,
    failedCount: 0,
    notAttemptedCount: 0,
    notAttemptedIds: [],
    outcomes: [],
    failure: null,
    chunksSent: 0,
    chunksTotal,
  };
}

/** The counts, derived from the outcomes — the one place they are computed. Pure. */
export function recount(run: BulkBranchPublicationRun): BulkBranchPublicationRun {
  const count = (kind: BranchPublicationItemOutcome['outcome']) => run.outcomes.filter((o) => o.outcome === kind).length;
  return {
    ...run,
    updatedCount: count('UPDATED'),
    unchangedCount: count('UNCHANGED'),
    skippedParentCount: count('SKIPPED_PARENT'),
    failedCount: count('FAILED'),
    notAttemptedCount: count('NOT_ATTEMPTED'),
    notAttemptedIds: run.outcomes.filter((o) => o.outcome === 'NOT_ATTEMPTED').map((o) => o.id),
  };
}

/** Folds one chunk's answer into the run. Pure. */
export function mergeChunk(run: BulkBranchPublicationRun, chunk: BulkBranchPublicationResult): BulkBranchPublicationRun {
  return recount({
    ...run,
    outcomes: [...run.outcomes, ...(chunk.outcomes ?? [])],
    chunksSent: run.chunksSent + 1,
  });
}

/** Records every id that was never answered, and what stopped the run. Pure. */
export function markNotAttempted(
  run: BulkBranchPublicationRun,
  ids: string[],
  failure: BranchPublicationRequestFailure,
): BulkBranchPublicationRun {
  const notAttempted: BranchPublicationItemOutcome[] = ids.map((id) => ({ id, outcome: 'NOT_ATTEMPTED' as const }));
  return recount({ ...run, outcomes: [...run.outcomes, ...notAttempted], failure });
}

/**
 * Folds an explicit retry into the run it continues. Only the retried ids'
 * NOT_ATTEMPTED entries give way; everything already decided stays, with its
 * message. Pure.
 */
export function foldRetry(base: BulkBranchPublicationRun, retry: BulkBranchPublicationRun): BulkBranchPublicationRun {
  const retried = new Set(retry.outcomes.map((o) => o.id));
  const kept = base.outcomes.filter((o) => !(o.outcome === 'NOT_ATTEMPTED' && retried.has(o.id)));
  return recount({
    ...base,
    outcomes: [...kept, ...retry.outcomes],
    failure: retry.failure,
    chunksSent: retry.chunksSent,
    chunksTotal: retry.chunksTotal,
  });
}

export interface RunOptions {
  accessToken: string;
  ids: string[];
  storeId: string;
  published: boolean;
  chunkSize?: number;
  onProgress?: (sent: number, total: number) => void;
  /** Injectable for tests; defaults to the app's authenticated fetch. */
  request?: (body: { ids: string[]; storeId: string; published: boolean }) => Promise<BulkBranchPublicationResult>;
}

export async function runBulkBranchPublication(options: RunOptions): Promise<BulkBranchPublicationRun> {
  const { accessToken, ids, storeId, published } = options;
  const size = options.chunkSize ?? CHUNK_SIZE;
  const request =
    options.request ??
    ((body) =>
      apiFetch('/bulk/products/branch-publication', {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify(body),
      }));

  const chunks = chunkIds(ids, size);
  let run = emptyRun(storeId, published, chunks.length);
  options.onProgress?.(0, chunks.length);

  for (let index = 0; index < chunks.length; index++) {
    try {
      const answer = await request({ ids: chunks[index], storeId, published });
      run = mergeChunk(run, answer);
      options.onProgress?.(run.chunksSent, chunks.length);
    } catch (err: any) {
      // Stop here. This chunk and everything after it is NOT_ATTEMPTED; the
      // chunks already answered are final and are never re-sent.
      const rest = chunks.slice(index).flat();
      return markNotAttempted(run, rest, {
        chunkIndex: index + 1,
        chunkCount: chunks.length,
        message: err?.message || 'request failed',
      });
    }
  }
  return run;
}
