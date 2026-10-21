import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type MessageHandler = (event: MessageEvent) => void;

class FakeBroadcastChannel {
  static channels = new Map<string, Set<FakeBroadcastChannel>>();
  private listeners = new Set<MessageHandler>();

  constructor(private readonly name: string) {
    const peers = FakeBroadcastChannel.channels.get(name) ?? new Set();
    peers.add(this);
    FakeBroadcastChannel.channels.set(name, peers);
  }

  addEventListener(_type: string, listener: MessageHandler) {
    this.listeners.add(listener);
  }

  postMessage(data: unknown) {
    for (const peer of FakeBroadcastChannel.channels.get(this.name) ?? []) {
      if (peer === this) continue;
      peer.listeners.forEach((listener) => listener({ data } as MessageEvent));
    }
  }

  close() {
    FakeBroadcastChannel.channels.get(this.name)?.delete(this);
  }
}

function lockManager() {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    request: <T>(_name: string, callback: () => Promise<T>): Promise<T> => {
      const result = tail.then(callback, callback);
      tail = result.catch(() => undefined);
      return result;
    },
  };
}

beforeEach(() => {
  FakeBroadcastChannel.channels.clear();
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  vi.stubGlobal('navigator', { ...window.navigator, locks: lockManager() });
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function twoTabs() {
  vi.resetModules();
  const first = await import('./auth-tab-coordinator');
  vi.resetModules();
  const second = await import('./auth-tab-coordinator');
  return { first, second };
}

describe('cross-tab authentication coordination', () => {
  it('rotates the refresh cookie once and gives both tabs the same in-memory result', async () => {
    const { first, second } = await twoTabs();
    let requests = 0;
    const serverRefresh = async () => {
      requests += 1;
      await Promise.resolve();
      return { ok: true as const, accessToken: 'fresh-token', user: { id: 'u1' } };
    };

    const [a, b] = await Promise.all([
      first.coordinateRefresh(serverRefresh),
      second.coordinateRefresh(serverRefresh),
    ]);

    expect(requests).toBe(1);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ ok: true, accessToken: 'fresh-token' });
    expect(window.localStorage.getItem('cataloguer-auth-event')).toBeNull();
  });

  it('propagates login and logout while never persisting the access token', async () => {
    const { first, second } = await twoTabs();
    const events: unknown[] = [];
    const unsubscribe = second.subscribeToSessionEvents((event) => events.push(event));

    first.announceSessionEstablished({ accessToken: 'memory-only-secret', user: { id: 'u1' } });
    first.announceSessionEnded();

    expect(events).toEqual([
      { type: 'established', accessToken: 'memory-only-secret', user: { id: 'u1' } },
      { type: 'ended' },
    ]);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain('memory-only-secret');
    unsubscribe();
  });
});
