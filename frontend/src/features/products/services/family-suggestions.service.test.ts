import { describe, it, expect, afterEach, vi } from 'vitest';
import { familySuggestionsService, isSuggestionReady } from './family-suggestions.service';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('../../../lib/api-client', () => ({ apiFetch }));

afterEach(() => {
  apiFetch.mockReset();
});

const member = (id: string) => ({ id, name: `Camiseta ${id}`, label: id });

describe('reading family suggestions', () => {
  it('answers one shape, whatever the backend sent', async () => {
    apiFetch.mockResolvedValue({
      data: [{ name: 'Camiseta', members: [member('a'), member('b')], readiness: 'READY', blockedReasons: [] }],
      readyCount: 1,
      blockedCount: 0,
    });
    const listing = await familySuggestionsService.list('tok');
    expect(listing.suggestions).toHaveLength(1);
    expect(listing.readyCount).toBe(1);
    expect(listing.blockedCount).toBe(0);
    expect(apiFetch).toHaveBeenCalledWith('/products/family-suggestions', { method: 'GET', token: 'tok' });
  });

  it('trusts the backend counts over its own arithmetic', async () => {
    apiFetch.mockResolvedValue({
      data: [{ name: 'A', members: [], readiness: 'READY' }, { name: 'B', members: [], readiness: 'BLOCKED' }],
      readyCount: 1,
      blockedCount: 1,
    });
    const listing = await familySuggestionsService.list('tok');
    expect([listing.readyCount, listing.blockedCount]).toEqual([1, 1]);
  });

  /**
   * The counts are SIBLINGS of `data`, not a replacement for it. A dashboard
   * served against a backend that predates them still has to render, and every
   * suggestion there was ready by definition.
   */
  it('derives the counts when the backend did not send them', async () => {
    apiFetch.mockResolvedValue({
      data: [
        { name: 'A', members: [], readiness: 'READY' },
        { name: 'B', members: [], readiness: 'BLOCKED' },
        { name: 'C', members: [] },
      ],
    });
    const listing = await familySuggestionsService.list('tok');
    expect(listing.readyCount).toBe(2);
    expect(listing.blockedCount).toBe(1);
  });

  it('reads an empty answer as nothing to group', async () => {
    apiFetch.mockResolvedValue({ data: [] });
    const listing = await familySuggestionsService.list('tok');
    expect(listing).toEqual({ suggestions: [], readyCount: 0, blockedCount: 0 });
  });

  it('treats a suggestion with no verdict as ready', () => {
    expect(isSuggestionReady({ name: 'A', members: [] })).toBe(true);
    expect(isSuggestionReady({ name: 'A', members: [], readiness: 'READY' })).toBe(true);
    expect(isSuggestionReady({ name: 'A', members: [], readiness: 'BLOCKED' })).toBe(false);
  });
});

describe('acting on one', () => {
  /**
   * The service posts to the SAME create endpoint manual grouping uses. It has
   * no shortcut of its own — the authoritative rules live behind that boundary.
   */
  it('creates through the ordinary family endpoint, sending only id and label', async () => {
    apiFetch.mockResolvedValue({});
    await familySuggestionsService.createGroup('tok', {
      name: 'Camiseta',
      members: [
        { id: 'a', name: 'Camiseta roja', label: 'Roja', price: 10, status: 'PUBLISHED', hasStore: true },
        { id: 'b', name: 'Camiseta azul', label: 'Azul' },
      ],
      readiness: 'READY',
    });
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe('/products/families');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({
      name: 'Camiseta',
      members: [
        { id: 'a', label: 'Roja' },
        { id: 'b', label: 'Azul' },
      ],
    });
  });

  it('remembers a "no" by name, so it is never suggested again', async () => {
    apiFetch.mockResolvedValue({});
    await familySuggestionsService.dismiss('tok', 'Camiseta');
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe('/products/family-suggestions/dismiss');
    expect(JSON.parse(init.body)).toEqual({ name: 'Camiseta' });
  });

  it('lets a refusal reach the caller rather than swallowing it', async () => {
    apiFetch.mockRejectedValue(new Error('These items are not all published or all draft.'));
    await expect(familySuggestionsService.dismiss('tok', 'Camiseta')).rejects.toThrow(/published or all draft/);
  });
});
