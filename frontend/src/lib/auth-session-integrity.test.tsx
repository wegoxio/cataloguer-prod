import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { AuthProvider, useAuth } from './auth';
import { renderComponent, cleanupAll, flush } from '../test/render';
import { getManagedTenant, enterManagedTenant } from './managed-tenant';
import { queryClient } from './query-client';
import { resetAuthTabCoordinatorForTests } from './auth-tab-coordinator';
import { resetApiClientSessionForTests } from './api-client';

/**
 * Session integrity under the failure paths nobody had tested.
 *
 * Three defects demonstrated by inspection and closed here, each with the
 * regression that would have caught it:
 *
 *  1. A background refresh REFUSED by the server (revoked/expired refresh
 *     token) cleared nothing — the dashboard kept rendering the dead
 *     session's tenant data until reload.
 *  2. A refresh in flight when Sign Out was clicked resurrected the whole
 *     session when it resolved.
 *  3. The managed-company context and the stores cache outlived sign-out.
 *
 * Plus the mid-session authority rules: refreshScope now fails CLOSED and is
 * race-protected by claimed generations.
 */

/** What the provider currently holds, exposed for assertion. */
function Probe() {
  const { user, accessToken, scope, isLoading, login, logout, refreshScope } = useAuth();
  (window as any).__auth = { user, accessToken, scope, isLoading, login, logout, refreshScope };
  return (
    <div>
      <span data-testid="who">{user?.email ?? '(signed out)'}</span>
      <span data-testid="token">{accessToken ? 'held' : 'none'}</span>
      <span data-testid="scope-role">{scope?.role ?? '(no scope)'}</span>
    </div>
  );
}

type Route = (init: RequestInit | undefined) => Promise<{ status: number; body?: unknown }> | { status: number; body?: unknown };

let routes: Record<string, Route>;

const SESSION = {
  accessToken: 'token-alpha',
  user: { id: 'u1', email: 'person@example.test', firstName: 'P', lastName: 'T', company: null, role: 'ADMIN', store: { id: 's1', name: 'Store' } },
};
const SCOPE = { platform: false, role: 'ADMIN', organizationId: 'org-1', storeId: 's1', allowedStoreIds: ['s1'] };

beforeEach(() => {
  // This suite exercises one tab. Cross-tab behavior has its own coordinator
  // suite and must not leak through Node's process-wide BroadcastChannel.
  vi.stubGlobal('BroadcastChannel', undefined);
  resetAuthTabCoordinatorForTests();
  resetApiClientSessionForTests();
  queryClient.clear();
  window.localStorage.clear();
  routes = {
    '/auth/refresh': () => ({ status: 401 }),
    '/auth/login': () => ({ status: 200, body: { data: SESSION } }),
    '/auth/me': () => ({ status: 200, body: { data: { ...SESSION.user, scope: SCOPE } } }),
    '/auth/logout': () => ({ status: 200, body: { data: { ok: true } } }),
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^.*\/api\/v1/, '');
    const route = Object.keys(routes).find((r) => path === r || path.startsWith(`${r}?`));
    if (!route) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    const out = await routes[route](init);
    return new Response(JSON.stringify(out.body ?? { message: 'error' }), { status: out.status });
  }));
});

afterEach(() => {
  cleanupAll();
  resetAuthTabCoordinatorForTests();
  vi.unstubAllGlobals();
});

const auth = () => (window as any).__auth;

async function renderSignedIn() {
  const view = await renderComponent(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await flush();
  await act(async () => {
    await auth().login('person@example.test', 'pw');
  });
  await flush();
  expect(view.get('who').textContent).toBe('person@example.test');
  expect(view.get('scope-role').textContent).toBe('ADMIN');
  return view;
}

describe('a refresh the server refuses ends the session everywhere', () => {
  it('clears user, token, scope and tenant context on a background 401 refresh refusal', async () => {
    const view = await renderSignedIn();
    enterManagedTenant({ organizationId: 'org-1', organizationName: 'Client Co', storeId: null, storeName: null });

    // The api-client's shared refresh hits a server that refuses it.
    const { requestSessionRefresh } = await import('./api-client');
    await act(async () => {
      await requestSessionRefresh();
    });
    await flush();

    expect(view.get('who').textContent).toBe('(signed out)');
    expect(view.get('token').textContent).toBe('none');
    expect(view.get('scope-role').textContent).toBe('(no scope)');
    // The last-managed company must not survive into the next session.
    expect(getManagedTenant()).toBeNull();
  });

  it('the 14-minute timer firing into a NETWORK failure keeps the session', async () => {
    vi.useFakeTimers();
    try {
      const view = await renderSignedIn();
      routes['/auth/refresh'] = () => { throw new TypeError('network down'); };
      await act(async () => {
        await vi.advanceTimersByTimeAsync(14 * 60 * 1000 + 10);
      });
      expect(view.get('who').textContent).toBe('person@example.test');
      expect(view.get('token').textContent).toBe('held');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a NETWORK failure is transient: it does not sign the session out', async () => {
    const view = await renderSignedIn();
    routes['/auth/refresh'] = () => { throw new TypeError('network down'); };
    const { requestSessionRefresh } = await import('./api-client');
    await act(async () => {
      expect(await requestSessionRefresh()).toBeNull();
    });
    await flush();
    // Still signed in: a flaky connection is not a revoked session.
    expect(view.get('who').textContent).toBe('person@example.test');
  });
});

describe('in-flight responses cannot repopulate a session that ended', () => {
  it('a refresh resolving AFTER logout does not resurrect the session', async () => {
    const view = await renderSignedIn();

    // Refresh starts, then hangs until we release it — with a VALID session.
    let release!: () => void;
    routes['/auth/refresh'] = () =>
      new Promise((resolve) => {
        release = () => resolve({ status: 200, body: { data: { ...SESSION, accessToken: 'token-late' } } });
      });
    const { requestSessionRefresh } = await import('./api-client');
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = requestSessionRefresh();
      await Promise.resolve();
    });

    await act(async () => {
      await auth().logout();
    });
    expect(view.get('who').textContent).toBe('(signed out)');

    await act(async () => {
      release();
      await pending;
    });
    await flush();

    // The late success belongs to a dead epoch: nothing comes back.
    expect(view.get('who').textContent).toBe('(signed out)');
    expect(view.get('token').textContent).toBe('none');
  });

  it('a late token-refresh callback after logout is ignored', async () => {
    const view = await renderSignedIn();
    await act(async () => {
      await auth().logout();
    });
    const { registerTokenRefreshHandler } = await import('./api-client');
    // Simulate the api-client invoking the registered handler late: the
    // provider re-registers on mount, so drive the real one via a refresh
    // that succeeds after logout.
    routes['/auth/refresh'] = () => ({ status: 200, body: { data: { ...SESSION, accessToken: 'token-zombie' } } });
    const { requestSessionRefresh } = await import('./api-client');
    await act(async () => {
      await requestSessionRefresh();
    });
    // requestSessionRefresh fires onTokenRefreshed('token-zombie'); the
    // guard refuses it because no user is signed in. (The refreshSession
    // path is separately epoch-guarded.)
    expect(view.get('token').textContent).toBe('none');
    expect(view.get('who').textContent).toBe('(signed out)');
    void registerTokenRefreshHandler;
  });
});

describe('scope refresh under authority change', () => {
  it('fails CLOSED: an /auth/me error drops the scope instead of preserving old privileges', async () => {
    const view = await renderSignedIn();
    routes['/auth/me'] = () => ({ status: 500, body: { message: 'boom' } });
    await act(async () => {
      await auth().refreshScope();
    });
    expect(view.get('scope-role').textContent).toBe('(no scope)');
  });

  it('a slower earlier refreshScope cannot overwrite a newer answer', async () => {
    const view = await renderSignedIn();

    let releaseFirst!: () => void;
    const gated = new Promise<void>((r) => (releaseFirst = r));
    let call = 0;
    routes['/auth/me'] = async () => {
      call += 1;
      if (call === 1) {
        await gated;
        return { status: 200, body: { data: { scope: { ...SCOPE, role: 'ORGANIZATION_MANAGER', storeId: null, allowedStoreIds: ['s1'] } } } };
      }
      return { status: 200, body: { data: { scope: { ...SCOPE, role: 'VIEWER' } } } };
    };

    let first!: Promise<void>;
    await act(async () => {
      first = auth().refreshScope(); // will hang
      await Promise.resolve();
    });
    await act(async () => {
      await auth().refreshScope(); // resolves VIEWER — the newer truth
    });
    expect(view.get('scope-role').textContent).toBe('VIEWER');

    await act(async () => {
      releaseFirst();
      await first;
    });
    // The stale elevated answer lost: authority did not roll back.
    expect(view.get('scope-role').textContent).toBe('VIEWER');
  });
});

describe('sign-out leaves nothing behind', () => {
  it('clears the managed-tenant storage and the application query cache', async () => {
    await renderSignedIn();
    enterManagedTenant({ organizationId: 'org-1', organizationName: 'Client Co', storeId: null, storeName: null });
    queryClient.setQueryData(['stores', 'u1|org-1|'], [{ id: 's1', name: 'Store' }]);
    expect(queryClient.getQueryCache().getAll()).not.toHaveLength(0);
    expect(getManagedTenant()).not.toBeNull();
    await act(async () => {
      await auth().logout();
    });
    expect(getManagedTenant()).toBeNull();
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  });
});
