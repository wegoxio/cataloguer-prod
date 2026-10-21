import { describe, it, expect, vi } from 'vitest';
import { chunkIds, runChunkedBulk, BULK_CHUNK_SIZE, RETRY_SAFE_ACTIONS, isRetrySafe } from './bulk-chunked';

const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `p-${from + i}`);
const ok = (chunk: string[], failing: string[] = []) => ({
  successCount: chunk.filter((id) => !failing.includes(id)).length,
  failedCount: chunk.filter((id) => failing.includes(id)).length,
  successes: chunk.filter((id) => !failing.includes(id)),
  failures: chunk.filter((id) => failing.includes(id)).map((id) => ({ id, message: 'refused' })),
});

describe('chunkIds', () => {
  it('splits in selection order and keeps every id exactly once', () => {
    const chunks = chunkIds(ids(1250), 500);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 250]);
    expect(chunks.flat()).toEqual(ids(1250));
  });

  it('returns nothing for an empty selection and one chunk for a small one', () => {
    expect(chunkIds([], 500)).toEqual([]);
    expect(chunkIds(ids(3), 500)).toEqual([ids(3)]);
  });

  it('defaults to a bounded chunk no larger than the server accepts', () => {
    expect(BULK_CHUNK_SIZE).toBeLessThanOrEqual(1000);
    expect(chunkIds(ids(BULK_CHUNK_SIZE + 1))).toHaveLength(2);
  });

  it('refuses a nonsense chunk size rather than looping forever', () => {
    expect(() => chunkIds(ids(3), 0)).toThrow();
  });
});

describe('runChunkedBulk', () => {
  const base = { accessToken: 'token', endpoint: '/bulk/products/archive' };

  it('sends a selection spanning several chunks, one request each, in order', async () => {
    const sent: string[][] = [];
    const fetcher = vi.fn(async (_path: string, init: any) => {
      const chunk = JSON.parse(init.body).ids as string[];
      sent.push(chunk);
      return ok(chunk);
    });
    const run = await runChunkedBulk({ ...base, ids: ids(1200), chunkSize: 500, fetcher: fetcher as any });
    expect(sent.map((c) => c.length)).toEqual([500, 500, 200]);
    expect(sent.flat()).toEqual(ids(1200));
    expect(run.successCount).toBe(1200);
    expect(run.failedCount).toBe(0);
    expect(run.unconfirmedIds).toEqual([]);
    expect(run.notAttemptedIds).toEqual([]);
    expect(run.stoppedReason).toBeUndefined();
    expect(run.chunksSent).toBe(3);
    expect(run.chunksTotal).toBe(3);
  });

  it('carries the action body on every chunk, with only the ids changing', async () => {
    const bodies: any[] = [];
    const fetcher = vi.fn(async (_p: string, init: any) => {
      const parsed = JSON.parse(init.body);
      bodies.push(parsed);
      return ok(parsed.ids);
    });
    await runChunkedBulk({
      ...base,
      endpoint: '/bulk/products/status',
      ids: ids(3),
      chunkSize: 2,
      body: { status: 'PUBLISHED' },
      fetcher: fetcher as any,
    });
    expect(bodies.map((b) => b.status)).toEqual(['PUBLISHED', 'PUBLISHED']);
    expect(bodies.map((b) => b.ids)).toEqual([['p-1', 'p-2'], ['p-3']]);
  });

  it('keeps per-id failures and keeps going: the server tried them', async () => {
    const fetcher = vi.fn(async (_p: string, init: any) => {
      const chunk = JSON.parse(init.body).ids as string[];
      return ok(chunk, ['p-2', 'p-5']);
    });
    const run = await runChunkedBulk({ ...base, ids: ids(6), chunkSize: 3, fetcher: fetcher as any });
    expect(run.successCount).toBe(4);
    expect(run.failedCount).toBe(2);
    expect(run.failures.map((f) => f.id)).toEqual(['p-2', 'p-5']);
    expect(run.notAttemptedIds, 'nothing was skipped').toEqual([]);
    expect(run.unconfirmedIds, 'and nothing is in doubt').toEqual([]);
    expect(run.chunksSent).toBe(2);
  });

  it('a MIDDLE chunk that fails stops the run and names every id never sent', async () => {
    const fetcher = vi.fn(async (_p: string, init: any) => {
      const chunk = JSON.parse(init.body).ids as string[];
      if (chunk.includes('p-3')) throw new Error('gateway timeout');
      return ok(chunk);
    });
    const run = await runChunkedBulk({ ...base, ids: ids(6), chunkSize: 2, fetcher: fetcher as any });
    // Chunk 1 applied; chunk 2 failed; chunk 3 was never sent.
    expect(run.successCount).toBe(2);
    expect(run.successes).toEqual(['p-1', 'p-2']);
    // The chunk that failed is unconfirmed; only the later ones were never sent.
    expect(run.unconfirmedIds).toEqual(['p-3', 'p-4']);
    expect(run.notAttemptedIds).toEqual(['p-5', 'p-6']);
    expect(run.stoppedReason).toBe('gateway timeout');
    expect(run.chunksSent).toBe(1);
    expect(run.chunksTotal).toBe(3);
    expect(fetcher, 'no request after the stop').toHaveBeenCalledTimes(2);
  });

  it('a retry of the not-attempted ids cannot touch an id already applied', async () => {
    let failOnce = true;
    const fetcher = vi.fn(async (_p: string, init: any) => {
      const chunk = JSON.parse(init.body).ids as string[];
      if (failOnce && chunk.includes('p-3')) {
        failOnce = false;
        throw new Error('gateway timeout');
      }
      return ok(chunk);
    });
    const first = await runChunkedBulk({ ...base, ids: ids(6), chunkSize: 2, fetcher: fetcher as any });
    expect(first.successes).toEqual(['p-1', 'p-2']);

    const remainder = [...first.unconfirmedIds, ...first.notAttemptedIds];
    const retry = await runChunkedBulk({ ...base, ids: remainder, chunkSize: 2, fetcher: fetcher as any });
    const retried = fetcher.mock.calls.slice(2).map((c: any) => JSON.parse(c[1].body).ids).flat();
    expect(retried, 'the applied ids are not re-sent').not.toContain('p-1');
    expect(retried).not.toContain('p-2');
    expect(retry.successes).toEqual(['p-3', 'p-4', 'p-5', 'p-6']);
    expect(retry.notAttemptedIds).toEqual([]);
  });

  it('treats an answer that reports nothing as a stop, not as a success', async () => {
    const fetcher = vi.fn(async () => null);
    const run = await runChunkedBulk({ ...base, ids: ids(2), chunkSize: 2, fetcher: fetcher as any });
    expect(run.successCount).toBe(0);
    expect(run.unconfirmedIds).toEqual(['p-1', 'p-2']);
    expect(run.notAttemptedIds).toEqual([]);
    expect(run.stoppedReason).toBeTruthy();
  });

  it('reports progress per chunk so a long run is not a frozen screen', async () => {
    const seen: [number, number][] = [];
    const fetcher = vi.fn(async (_p: string, init: any) => ok(JSON.parse(init.body).ids));
    await runChunkedBulk({
      ...base,
      ids: ids(5),
      chunkSize: 2,
      fetcher: fetcher as any,
      onProgress: (sent, total) => seen.push([sent, total]),
    });
    expect(seen).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('sends one request for a selection that fits in a single chunk', async () => {
    const fetcher = vi.fn(async (_p: string, init: any) => ok(JSON.parse(init.body).ids));
    const run = await runChunkedBulk({ ...base, ids: ids(10), fetcher: fetcher as any });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(run.chunksTotal).toBe(1);
    expect(run.successCount).toBe(10);
  });
});

/**
 * WHICH ACTIONS TOLERATE A RETRY OVER IDS WHOSE FATE IS UNKNOWN.
 *
 * Absolute writes do: applying the same value twice leaves the same state.
 * Archive and restore do not — they are transitions with a precondition, so
 * every id the lost attempt did apply would report a failure on the retry and
 * the run would describe successful work as failed.
 */
describe('retry safety', () => {
  it('treats every absolute-value write as safe to repeat', () => {
    for (const action of ['publish', 'draft', 'category', 'inventory', 'pricing', 'stores']) {
      expect(isRetrySafe(action), action).toBe(true);
    }
  });

  it('refuses to call archive or restore safe to repeat', () => {
    expect(isRetrySafe('archive')).toBe(false);
    expect(isRetrySafe('restore')).toBe(false);
  });

  it('refuses anything it has not been told about', () => {
    expect(isRetrySafe('something-new')).toBe(false);
  });

  it('lists exactly the actions the page can run', () => {
    expect([...RETRY_SAFE_ACTIONS].sort()).toEqual(
      ['category', 'draft', 'inventory', 'pricing', 'publish', 'stores'].sort(),
    );
  });
});
