import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll, click, type, flush, settle } from '../../test/render';
import { useBoundedLookup } from './use-bounded-lookup';
import type { TenantLookupPage } from './services/platform-users.service';

/**
 * THE LOOKUP'S TWO PROMISES, PROVED DIRECTLY (#275).
 *
 *   1. The LATEST request wins, whatever order the answers arrive in.
 *   2. A failure is a failure — never an empty, confident list.
 *
 * The fetcher below hands back a promise the test resolves BY HAND, so the
 * arrival order is dictated rather than hoped for. A test that only ever sees
 * responses land in the order they were sent proves nothing about the case that
 * breaks screens: the broad query is slow, the narrow one is fast, and the
 * stale answer routinely lands last.
 */
type Pending = { search: string; resolve: (page: TenantLookupPage) => void; reject: (error: Error) => void };

const page = (items: { id: string; name: string }[], total = items.length): TenantLookupPage => ({
  items,
  total,
  limit: 20,
  truncated: total > items.length,
});

let pending: Pending[] = [];

function Probe({ subject, enabled = true }: { subject: string; enabled?: boolean }) {
  const lookup = useBoundedLookup({
    fetcher: enabled
      ? (search) => new Promise<TenantLookupPage>((resolve, reject) => pending.push({ search, resolve, reject }))
      : null,
    subject,
  });
  return (
    <div>
      <span data-testid="state">{lookup.state}</span>
      <span data-testid="names">{lookup.items.map((item) => item.name).join(',')}</span>
      <span data-testid="total">{lookup.total}</span>
      <span data-testid="truncated">{String(lookup.truncated)}</span>
      <span data-testid="error">{lookup.error ?? ''}</span>
      <input data-testid="search" value={lookup.search} onChange={(event) => lookup.setSearch(event.target.value)} />
      <button data-testid="retry" onClick={lookup.retry}>
        retry
      </button>
    </div>
  );
}

const read = (r: { container: HTMLElement }, id: string) =>
  r.container.querySelector<HTMLElement>(`[data-testid="${id}"]`)!.textContent;

describe('#275 · useBoundedLookup', () => {
  afterEach(() => {
    pending = [];
    cleanupAll();
  });

  it('asks once on mount and reports loading until it is answered', async () => {
    const r = await renderComponent(<Probe subject="organizations" />);
    await flush();
    expect(read(r, 'state')).toBe('loading');
    expect(pending.length).toBe(1);

    pending[0].resolve(page([{ id: 'a', name: 'Acme' }], 137));
    await flush();
    expect(read(r, 'state')).toBe('ready');
    expect(read(r, 'names')).toBe('Acme');
    expect(read(r, 'total')).toBe('137');
    expect(read(r, 'truncated')).toBe('true');
  });

  it('a STALE answer landing last is discarded, results and state alike', async () => {
    const r = await renderComponent(<Probe subject="organizations" />);
    await flush();
    await type(r.container.querySelector('[data-testid="search"]'), 'riv');
    await settle();
    expect(pending.length).toBe(2);
    expect(pending[1].search).toBe('riv');

    // The newer, narrower answer arrives first.
    pending[1].resolve(page([{ id: 'r', name: 'Rival' }]));
    await flush();
    expect(read(r, 'names')).toBe('Rival');

    // The older, broader answer arrives second — and changes nothing.
    pending[0].resolve(page([{ id: 'a', name: 'Acme' }, { id: 'r', name: 'Rival' }]));
    await flush();
    expect(read(r, 'names')).toBe('Rival');
    expect(read(r, 'state')).toBe('ready');
  });

  it('a stale FAILURE cannot fail a request that succeeded after it', async () => {
    const r = await renderComponent(<Probe subject="organizations" />);
    await flush();
    await type(r.container.querySelector('[data-testid="search"]'), 'riv');
    await settle();

    pending[1].resolve(page([{ id: 'r', name: 'Rival' }]));
    await flush();
    pending[0].reject(new Error('the older one blew up'));
    await flush();

    expect(read(r, 'state')).toBe('ready');
    expect(read(r, 'names')).toBe('Rival');
    expect(read(r, 'error')).toBe('');
  });

  it('a stale SUCCESS cannot clear a live request’s loading state', async () => {
    const r = await renderComponent(<Probe subject="organizations" />);
    await flush();
    await type(r.container.querySelector('[data-testid="search"]'), 'riv');
    await settle();

    // Only the superseded request answers.
    pending[0].resolve(page([{ id: 'a', name: 'Acme' }]));
    await flush();
    expect(read(r, 'state')).toBe('loading');
    expect(read(r, 'names')).toBe('');
  });

  it('a failure keeps NO items and states the reason, with a retry that asks again', async () => {
    const r = await renderComponent(<Probe subject="organizations" />);
    await flush();
    pending[0].resolve(page([{ id: 'a', name: 'Acme' }]));
    await flush();
    expect(read(r, 'names')).toBe('Acme');

    await click(r.container.querySelector('[data-testid="retry"]'));
    await flush();
    pending[1].reject(new Error('The list could not be read'));
    await flush();

    expect(read(r, 'state')).toBe('failed');
    // NOT the previous company's results left sitting there, selectable.
    expect(read(r, 'names')).toBe('');
    expect(read(r, 'total')).toBe('0');
    expect(read(r, 'error')).toBe('The list could not be read');

    await click(r.container.querySelector('[data-testid="retry"]'));
    await flush();
    expect(pending.length).toBe(3);
    pending[2].resolve(page([{ id: 'a', name: 'Acme' }]));
    await flush();
    expect(read(r, 'state')).toBe('ready');
  });

  it('changing the subject clears the previous set BEFORE the new one is answered', async () => {
    const r = await renderComponent(<Probe subject="org-1" />);
    await flush();
    pending[0].resolve(page([{ id: 'store-a', name: 'Centro' }]));
    await flush();
    expect(read(r, 'names')).toBe('Centro');

    await r.rerender(<Probe subject="org-2" />);
    await flush();
    // The moment the company changes, the old company's branches are gone —
    // not once the new answer arrives, which is far too late for a control the
    // operator can already click.
    expect(read(r, 'names')).toBe('');
    expect(read(r, 'state')).toBe('loading');

    // And the first company's answer, arriving late, still cannot come back.
    pending[0].resolve(page([{ id: 'store-a', name: 'Centro' }]));
    await flush();
    expect(read(r, 'names')).toBe('');
  });

  it('a search term does not survive its subject', async () => {
    const r = await renderComponent(<Probe subject="org-1" />);
    await flush();
    await type(r.container.querySelector('[data-testid="search"]'), 'centro');
    await settle();
    expect(pending[pending.length - 1].search).toBe('centro');

    await r.rerender(<Probe subject="org-2" />);
    await flush();
    expect((r.container.querySelector('[data-testid="search"]') as HTMLInputElement).value).toBe('');
    // The new company is asked for its FIRST page, not for the old term.
    expect(pending[pending.length - 1].search).toBe('');
  });

  it('a null fetcher is "disabled", which is not "empty" and not "failed"', async () => {
    const r = await renderComponent(<Probe subject="" enabled={false} />);
    await flush();
    expect(read(r, 'state')).toBe('disabled');
    expect(pending.length).toBe(0);
  });

  it('ASKS AS SOON AS IT CAN: a fetcher that arrives late still fires', async () => {
    /**
     * The session's access token lands a render or two after mount, so the
     * first render legitimately has no fetcher. If gaining one does not wake
     * the effect, the control stays disabled forever on a page that finished
     * loading — which is exactly what the browser journey found.
     */
    const r = await renderComponent(<Probe subject="organizations" enabled={false} />);
    await flush();
    expect(read(r, 'state')).toBe('disabled');

    await r.rerender(<Probe subject="organizations" enabled />);
    await flush();
    expect(pending.length).toBe(1);
    expect(read(r, 'state')).toBe('loading');

    pending[0].resolve(page([{ id: 'a', name: 'Acme' }]));
    await flush();
    expect(read(r, 'state')).toBe('ready');
    expect(read(r, 'names')).toBe('Acme');
  });
});
