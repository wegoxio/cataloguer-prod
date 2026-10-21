import { describe, it, expect, vi } from 'vitest';
import {
  chunkIds,
  emptyRun,
  foldRetry,
  markNotAttempted,
  mergeChunk,
  runBulkBranchPublication,
} from './bulk-branch-publication';
import type { BulkBranchPublicationResult } from '../types/product.types';

const ids = (n: number, prefix = 'p') => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);

const answer = (sent: string[], over: Partial<BulkBranchPublicationResult> = {}): BulkBranchPublicationResult => ({
  storeId: 'store-a',
  published: true,
  updatedCount: sent.length,
  unchangedCount: 0,
  skippedParentCount: 0,
  failedCount: 0,
  outcomes: sent.map((id) => ({ id, outcome: 'UPDATED' as const })),
  ...over,
});

/**
 * Chunking is sequential, in selection order, and a failed request stops the
 * run without re-sending anything on its own (ADR 029).
 */
describe('bulk website publication — chunked run', () => {
  describe('chunkIds', () => {
    it('splits in order at the chunk size', () => {
      expect(chunkIds([], 1000)).toEqual([]);
      expect(chunkIds(ids(1000), 1000)).toHaveLength(1);
      const two = chunkIds(ids(1001), 1000);
      expect(two).toHaveLength(2);
      expect(two[0][0]).toBe('p-1');
      expect(two[0]).toHaveLength(1000);
      expect(two[1]).toEqual(['p-1001']);
    });
  });

  describe('merging', () => {
    it('appends outcomes and derives every count from them — a chunk’s declared counts are not trusted', () => {
      let run = emptyRun('store-a', true, 2);
      run = mergeChunk(
        run,
        answer(['a', 'b', 'c', 'd'], {
          // Deliberately WRONG declared counts: the run must not sum these.
          updatedCount: 9,
          unchangedCount: 9,
          skippedParentCount: 9,
          failedCount: 9,
          outcomes: [
            { id: 'a', outcome: 'UPDATED' },
            { id: 'b', outcome: 'UNCHANGED' },
            { id: 'c', outcome: 'SKIPPED_PARENT', message: 'card' },
            { id: 'd', outcome: 'FAILED', message: 'not on that website' },
          ],
        }),
      );
      run = mergeChunk(run, answer(['e']));
      expect(run).toMatchObject({
        updatedCount: 2,
        unchangedCount: 1,
        skippedParentCount: 1,
        failedCount: 1,
        notAttemptedCount: 0,
        chunksSent: 2,
      });
      expect(run.outcomes.map((o) => o.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('records not-attempted ids with the STRUCTURED failure, in order', () => {
      const failure = { chunkIndex: 2, chunkCount: 3, message: 'boom' };
      const run = markNotAttempted(emptyRun('store-a', true, 3), ['x', 'y'], failure);
      expect(run.notAttemptedCount).toBe(2);
      expect(run.notAttemptedIds).toEqual(['x', 'y']);
      expect(run.outcomes).toEqual([
        { id: 'x', outcome: 'NOT_ATTEMPTED' },
        { id: 'y', outcome: 'NOT_ATTEMPTED' },
      ]);
      expect(run.failure).toEqual(failure);
      // No English sentence anywhere in the run: the panel builds it through t().
      expect(JSON.stringify(run)).not.toMatch(/Request \d+ of \d+ failed/);
    });
  });

  describe('foldRetry — an explicit retry continues the run it belongs to', () => {
    it('replaces only the retried ids’ NOT_ATTEMPTED entries, keeps every earlier decision with its message, and recounts', async () => {
      // Chunk 1 answered with a mixed result; chunk 2 failed (uncertain — the
      // server may or may not have applied it); chunk 3 was never sent.
      let attempt = 0;
      const request = vi.fn(async (body: { ids: string[] }) => {
        attempt += 1;
        if (attempt === 1) {
          return answer(body.ids, {
            updatedCount: 1,
            skippedParentCount: 1,
            failedCount: 1,
            outcomes: [
              { id: 'p-1', outcome: 'UPDATED', globalStatus: 'DRAFT' },
              { id: 'p-2', outcome: 'SKIPPED_PARENT', message: 'is a parent card' },
              { id: 'p-3', outcome: 'FAILED', message: 'not on that website' },
            ],
          });
        }
        throw new Error('gateway timeout');
      });
      const first = await runBulkBranchPublication({
        accessToken: 't',
        ids: ids(9),
        storeId: 'store-a',
        published: true,
        chunkSize: 3,
        request,
      });
      expect(first).toMatchObject({ updatedCount: 1, skippedParentCount: 1, failedCount: 1, notAttemptedCount: 6 });
      expect(first.notAttemptedIds).toEqual(['p-4', 'p-5', 'p-6', 'p-7', 'p-8', 'p-9']);
      expect(first.failure).toEqual({ chunkIndex: 2, chunkCount: 3, message: 'gateway timeout' });
      expect(request).toHaveBeenCalledTimes(2);

      // The explicit retry: the interrupted chunk had in fact been applied by
      // the server, so its ids come back UNCHANGED; the unsent chunk applies.
      const retry = await runBulkBranchPublication({
        accessToken: 't',
        ids: first.notAttemptedIds,
        storeId: 'store-a',
        published: true,
        chunkSize: 3,
        request: async (body) =>
          answer(body.ids, {
            updatedCount: body.ids.includes('p-7') ? 3 : 0,
            unchangedCount: body.ids.includes('p-4') ? 3 : 0,
            outcomes: body.ids.map((id) => ({ id, outcome: body.ids.includes('p-4') ? ('UNCHANGED' as const) : ('UPDATED' as const) })),
          }),
      });
      const folded = foldRetry(first, retry);

      // Every id exactly once; the first run's decisions and messages intact.
      expect(folded.outcomes.map((o) => o.id).sort()).toEqual(ids(9).sort());
      expect(folded.outcomes.find((o) => o.id === 'p-1')).toEqual({ id: 'p-1', outcome: 'UPDATED', globalStatus: 'DRAFT' });
      expect(folded.outcomes.find((o) => o.id === 'p-2')).toEqual({ id: 'p-2', outcome: 'SKIPPED_PARENT', message: 'is a parent card' });
      expect(folded.outcomes.find((o) => o.id === 'p-3')).toEqual({ id: 'p-3', outcome: 'FAILED', message: 'not on that website' });
      // Counts recomputed from the final outcome set, not carried over.
      expect(folded).toMatchObject({
        updatedCount: 4,
        unchangedCount: 3,
        skippedParentCount: 1,
        failedCount: 1,
        notAttemptedCount: 0,
        notAttemptedIds: [],
        failure: null,
      });
      expect(folded.outcomes.filter((o) => o.outcome === 'NOT_ATTEMPTED')).toHaveLength(0);
    });

    it('a retry that fails again keeps the earlier decisions and marks only what is still not attempted', async () => {
      const first = markNotAttempted(
        mergeChunk(emptyRun('store-a', false, 2), answer(['a'])),
        ['b', 'c'],
        { chunkIndex: 2, chunkCount: 2, message: 'boom' },
      );
      const retry = await runBulkBranchPublication({
        accessToken: 't',
        ids: ['b', 'c'],
        storeId: 'store-a',
        published: false,
        chunkSize: 1,
        request: async (body) => {
          if (body.ids[0] === 'c') throw new Error('still down');
          return answer(body.ids);
        },
      });
      const folded = foldRetry(first, retry);
      expect(folded.outcomes.map((o) => [o.id, o.outcome])).toEqual([
        ['a', 'UPDATED'],
        ['b', 'UPDATED'],
        ['c', 'NOT_ATTEMPTED'],
      ]);
      expect(folded).toMatchObject({ updatedCount: 2, notAttemptedCount: 1, notAttemptedIds: ['c'] });
      expect(folded.failure).toEqual({ chunkIndex: 2, chunkCount: 2, message: 'still down' });
    });
  });

  describe('runBulkBranchPublication', () => {
    it('sends chunks one at a time, in order, and combines them into one run', async () => {
      const seen: string[][] = [];
      let inFlight = 0;
      let maxInFlight = 0;
      const request = vi.fn(async (body: { ids: string[] }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        seen.push(body.ids);
        await Promise.resolve();
        inFlight -= 1;
        return answer(body.ids);
      });

      const run = await runBulkBranchPublication({
        accessToken: 't',
        ids: ids(5),
        storeId: 'store-a',
        published: true,
        chunkSize: 2,
        request,
      });

      expect(seen).toEqual([['p-1', 'p-2'], ['p-3', 'p-4'], ['p-5']]);
      expect(maxInFlight).toBe(1);
      expect(run).toMatchObject({
        updatedCount: 5,
        notAttemptedCount: 0,
        failure: null,
        chunksSent: 3,
        chunksTotal: 3,
      });
      expect(run.outcomes).toHaveLength(5);
    });

    it('stops at the first failed request: later chunks are never sent, and nothing is retried implicitly', async () => {
      const request = vi.fn(async (body: { ids: string[] }) => {
        if (body.ids.includes('p-3')) throw new Error('boom');
        return answer(body.ids);
      });

      const run = await runBulkBranchPublication({
        accessToken: 't',
        ids: ids(6),
        storeId: 'store-a',
        published: false,
        chunkSize: 2,
        request,
      });

      // Chunk 1 answered, chunk 2 failed, chunk 3 never sent.
      expect(request).toHaveBeenCalledTimes(2);
      expect(run.chunksSent).toBe(1);
      expect(run.updatedCount).toBe(2);
      expect(run.notAttemptedIds).toEqual(['p-3', 'p-4', 'p-5', 'p-6']);
      expect(run.notAttemptedCount).toBe(4);
      expect(run.failure).toEqual({ chunkIndex: 2, chunkCount: 3, message: 'boom' });
      // Every requested id has exactly one outcome.
      expect(run.outcomes.map((o) => o.id).sort()).toEqual(ids(6).sort());
      expect(run.outcomes.filter((o) => o.outcome === 'NOT_ATTEMPTED')).toHaveLength(4);
    });

    it('reports progress from the very start of THIS run and after each answered chunk', async () => {
      const progress: [number, number][] = [];
      await runBulkBranchPublication({
        accessToken: 't',
        ids: ids(3),
        storeId: 'store-a',
        published: true,
        chunkSize: 1,
        request: async (body) => answer(body.ids),
        onProgress: (sent, total) => progress.push([sent, total]),
      });
      // The first report is 0 of 3, before any request — so a retry of, say,
      // two ids shows "0 of 2", never the previous run's totals.
      expect(progress).toEqual([
        [0, 3],
        [1, 3],
        [2, 3],
        [3, 3],
      ]);
    });
  });
});
