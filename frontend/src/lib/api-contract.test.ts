import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

describe('apiFetchValidated', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    window.localStorage.setItem('wegox-lang', 'en');
  });

  it('returns a response that satisfies the runtime contract', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { total: 4 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const { apiFetchValidated } = await import('./api-contract');
    const result = await apiFetchValidated('/totals', z.object({ data: z.object({ total: z.number() }) }));
    expect(result.data.total).toBe(4);
  });

  it('rejects a successful but malformed server response', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: { total: 'not-a-number' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const { ApiContractError, apiFetchValidated } = await import('./api-contract');
    await expect(apiFetchValidated('/totals', z.object({ data: z.object({ total: z.number() }) })))
      .rejects.toBeInstanceOf(ApiContractError);
  });
});
