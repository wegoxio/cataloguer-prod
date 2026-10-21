export type CoordinatedSession = { accessToken: string; user: unknown };
export type CoordinatedRefreshResult =
  | ({ ok: true } & CoordinatedSession)
  | { ok: false; reason: 'refused' | 'network' };

type AuthMessage =
  | ({ type: 'refresh-result'; sentAt: number } & CoordinatedRefreshResult)
  | ({ type: 'session-established'; sentAt: number } & CoordinatedSession)
  | { type: 'session-ended'; sentAt: number };
type WireAuthMessage = AuthMessage & { source: string };

type SessionEvent =
  | ({ type: 'established' } & CoordinatedSession)
  | { type: 'ended' };

const CHANNEL_NAME = 'cataloguer-auth-v1';
const STORAGE_EVENT_KEY = 'cataloguer-auth-event';
const STORAGE_LOCK_KEY = 'cataloguer-auth-refresh-lock';
const REFRESH_LOCK = 'cataloguer-auth-refresh-v1';
const LOCK_LEASE_MS = 15_000;
const TAB_ID = `${Date.now()}-${Math.random()}`;

let channel: BroadcastChannel | null | undefined;
const messageListeners = new Set<(message: AuthMessage) => void>();
const sessionListeners = new Set<(event: SessionEvent) => void>();

function dispatch(message: AuthMessage): void {
  messageListeners.forEach((listener) => listener(message));
  if (message.type === 'session-established' || (message.type === 'refresh-result' && message.ok)) {
    sessionListeners.forEach((listener) => listener({ type: 'established', accessToken: message.accessToken, user: message.user }));
  } else if (message.type === 'session-ended' || (message.type === 'refresh-result' && !message.ok && message.reason === 'refused')) {
    sessionListeners.forEach((listener) => listener({ type: 'ended' }));
  }
}

function getChannel(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') {
    channel = null;
    return channel;
  }
  channel = new BroadcastChannel(CHANNEL_NAME);
  channel.addEventListener('message', (event: MessageEvent<WireAuthMessage>) => {
    if (event.data.source !== TAB_ID) dispatch(event.data);
  });
  return channel;
}

function publish(message: AuthMessage): void {
  getChannel()?.postMessage({ ...message, source: TAB_ID } satisfies WireAuthMessage);
  // The storage event is deliberately credential-free. It gives older
  // browsers immediate logout propagation without persisting an access token.
  if (typeof window !== 'undefined' && (message.type === 'session-ended' || (message.type === 'refresh-result' && !message.ok && message.reason === 'refused'))) {
    try {
      window.localStorage.setItem(STORAGE_EVENT_KEY, JSON.stringify({ type: 'session-ended', sentAt: message.sentAt, source: TAB_ID }));
      window.localStorage.removeItem(STORAGE_EVENT_KEY);
    } catch {
      // Storage may be disabled; the current tab still completes normally.
    }
  }
}

export function subscribeToSessionEvents(listener: (event: SessionEvent) => void): () => void {
  sessionListeners.add(listener);
  getChannel();
  if (typeof window === 'undefined') return () => sessionListeners.delete(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_EVENT_KEY || !event.newValue) return;
    try {
      const stored = JSON.parse(event.newValue);
      if (stored.source !== TAB_ID) listener({ type: 'ended' });
    } catch {
      // Ignore malformed coordination data.
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    sessionListeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

export function announceSessionEstablished(session: CoordinatedSession): void {
  publish({ type: 'session-established', sentAt: Date.now(), ...session });
}

export function announceSessionEnded(): void {
  publish({ type: 'session-ended', sentAt: Date.now() });
}

async function withStorageLease<T>(task: () => Promise<T>): Promise<T> {
  if (typeof window === 'undefined') return task();
  const owner = `${Date.now()}-${Math.random()}`;
  while (true) {
    const now = Date.now();
    let current: { owner: string; expiresAt: number } | null = null;
    try {
      current = JSON.parse(window.localStorage.getItem(STORAGE_LOCK_KEY) ?? 'null');
    } catch {
      return task();
    }
    if (!current || current.expiresAt <= now) {
      window.localStorage.setItem(STORAGE_LOCK_KEY, JSON.stringify({ owner, expiresAt: now + LOCK_LEASE_MS }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      const claimed = JSON.parse(window.localStorage.getItem(STORAGE_LOCK_KEY) ?? 'null');
      if (claimed?.owner === owner) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try {
    return await task();
  } finally {
    try {
      const current = JSON.parse(window.localStorage.getItem(STORAGE_LOCK_KEY) ?? 'null');
      if (current?.owner === owner) window.localStorage.removeItem(STORAGE_LOCK_KEY);
    } catch {
      // A disabled store cannot retain the lease.
    }
  }
}

/**
 * Exactly one tab rotates the refresh cookie. Waiting tabs consume its
 * in-memory BroadcastChannel result instead of presenting the old cookie.
 */
export async function coordinateRefresh(
  refresh: () => Promise<CoordinatedRefreshResult>,
): Promise<CoordinatedRefreshResult> {
  const authChannel = getChannel();
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!authChannel) {
    // Without BroadcastChannel no token can safely cross tabs. Web Locks can
    // still serialize rotations; on legacy browsers preserve the old local
    // behavior rather than persisting credentials in storage.
    return locks ? locks.request(REFRESH_LOCK, refresh) : refresh();
  }

  let remoteResult: CoordinatedRefreshResult | null = null;
  let resolveRemote!: (result: CoordinatedRefreshResult) => void;
  const remote = new Promise<CoordinatedRefreshResult>((resolve) => { resolveRemote = resolve; });
  const listener = (message: AuthMessage) => {
    if (message.type !== 'refresh-result') return;
    const result: CoordinatedRefreshResult = message.ok
      ? { ok: true, accessToken: message.accessToken, user: message.user }
      : { ok: false, reason: message.reason };
    remoteResult = result;
    resolveRemote(result);
  };
  messageListeners.add(listener);

  const runWhileLocked = async () => {
    // A tab ahead of us completed while this request waited for the lock.
    if (remoteResult) return remoteResult;
    const result = await refresh();
    publish({ type: 'refresh-result', sentAt: Date.now(), ...result });
    return result;
  };
  const local = locks
    ? locks.request(REFRESH_LOCK, runWhileLocked)
    : withStorageLease(runWhileLocked);

  try {
    return await Promise.race([local, remote]);
  } finally {
    messageListeners.delete(listener);
  }
}

/** Test-only reset for module singletons. */
export function resetAuthTabCoordinatorForTests(): void {
  channel?.close();
  channel = undefined;
  messageListeners.clear();
  sessionListeners.clear();
}
