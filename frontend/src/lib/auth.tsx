'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { advanceSessionGeneration, apiFetch, registerSessionLostHandler, registerTokenRefreshHandler, requestSessionRefreshResult } from './api-client';
import { exitManagedTenant, useManagedTenant } from './managed-tenant';
import { parseSessionScope, SessionScope } from './permissions';
import { announceSessionEnded, announceSessionEstablished, subscribeToSessionEvents } from './auth-tab-coordinator';
import { clearSessionQueries } from './query-client';

interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  role: string;
  mfaEnabled?: boolean;
  store: { id: string; name: string } | null;
}

/** Friendliest available label: name → company → email. */
export function userDisplayName(user: User | null): string {
  if (!user) return '';
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ');
  return name || user.company || user.email;
}

interface AuthContextType {
  user: User | null;
  /**
   * The tenant scope the BACKEND resolved for this session and tenant context.
   * Null while absent, loading, stale or failed — capability helpers grant
   * nothing in that state. Managed-tenant storage only decides which headers
   * are sent; it never grants authority here.
   */
  scope: SessionScope | null;
  accessToken: string | null;
  isLoading: boolean;
  isScopeLoading: boolean;
  login: (email: string, pass: string) => Promise<{ mfaRequired?: boolean; challengeToken?: string } | void>;
  verifyMfa: (challengeToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * Re-asks the backend what this session may do, without blanking the scope
   * while the request is in flight. For the moment after a role or
   * store-binding change: the server is never stale (the guard re-reads the
   * user per request), but the UI keeps rendering yesterday's capabilities
   * until somebody asks again. On FAILURE the scope drops to null — an error
   * is never proof that old privileges still stand.
   */
  refreshScope: () => Promise<void>;
  refreshIdentity: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [scope, setScope] = useState<SessionScope | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  // Every scope request carries a generation; only the newest may write state,
  // so a slow earlier reply can never overwrite a newer resolved scope. This
  // is suppression on arrival, not transport cancellation.
  const scopeGeneration = useRef(0);
  /**
   * The session's EPOCH. Incremented the moment a sign-out or session loss
   * begins, so any refresh already in flight at that moment resolves into a
   * stale epoch and is discarded. Without it, a refresh racing a click on
   * Sign Out would land after the cleanup and resurrect the whole session on
   * screen — token, user, tenant data and all.
   */
  const sessionEpoch = useRef(0);
  /** Mirror of `user` for callbacks that must not close over stale state. */
  const userRef = useRef<User | null>(null);
  userRef.current = user;
  const managedTenant = useManagedTenant();
  const tenantKey = managedTenant ? `${managedTenant.organizationId}:${managedTenant.storeId ?? ''}` : '';

  /** Everything a dead session leaves behind, removed in one place. */
  const clearSession = useCallback(() => {
    sessionEpoch.current += 1;
    advanceSessionGeneration();
    setAccessToken(null);
    setUser(null);
    setScope(null);
    // The previous tenant's rows must not outlive the session that read them.
    clearSessionQueries();
    // Nor may the managed-company context: it persists in localStorage and
    // would otherwise ride into the NEXT session on this browser as an
    // X-Managed-Organization header — input, not authority, but still the
    // last customer's name sitting in storage after sign-out.
    exitManagedTenant();
  }, []);

  // Background refreshes (401 retries in the api client) keep us in sync —
  // but only while a session exists to renew. After sign-out, a late-arriving
  // refresh result must not quietly re-arm the token.
  useEffect(() => {
    registerTokenRefreshHandler((token) => {
      if (!userRef.current) return;
      setAccessToken(token);
    });
    // The server refused a refresh: the session is over EVERYWHERE, not just
    // for whichever component's request happened to hit the 401. The dashboard
    // layout redirects to /login the moment the user is gone.
    registerSessionLostHandler(() => {
      clearSession();
    });
    return subscribeToSessionEvents((event) => {
      if (event.type === 'ended') {
        clearSession();
        return;
      }
      // A login or refresh completed in another tab. It represents a newer
      // session generation than any request currently in flight here.
      sessionEpoch.current += 1;
      advanceSessionGeneration();
      setAccessToken(event.accessToken);
      setUser(event.user as User);
    });
  }, [clearSession]);
  const [isLoading, setIsLoading] = useState(true);
  const [isScopeLoading, setIsScopeLoading] = useState(false);

  const refreshSession = useCallback(async () => {
    const epoch = sessionEpoch.current;
    try {
      // THROUGH the api-client's single flight, never a second POST beside
      // it: the refresh cookie rotates on use, and a concurrent pair means
      // the loser presents a dead cookie and logs a live session out.
      const result = await requestSessionRefreshResult();
      // A sign-out or session loss that happened while we awaited wins: this
      // result describes a session that no longer exists.
      if (epoch !== sessionEpoch.current) return;
      if (result.ok) {
        setAccessToken(result.accessToken);
        setUser(result.user as User);
      } else if (result.reason === 'refused') {
        // The server said no: there is no session. Drop the resolved scope at
        // once rather than leaving stale authority on screen.
        setAccessToken(null);
        setUser(null);
        setScope(null);
      }
      // 'network': the timer fired into a flaky connection. Keep what we hold;
      // the next 401 will retry the refresh, and a genuine refusal then ends
      // the session through the session-lost handler. On first load nothing is
      // held yet, so this branch changes nothing there.
    } finally {
      setIsLoading(false);
    }
  }, []);

  const login = async (email: string, pass: string): Promise<{ mfaRequired?: boolean; challengeToken?: string } | void> => {
    const response = await apiFetch('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password: pass }),
    });

    if (response?.data?.mfaRequired) {
      return { mfaRequired: true, challengeToken: response.data.challengeToken };
    }
    if (response?.data) {
      advanceSessionGeneration();
      setAccessToken(response.data.accessToken);
      setUser(response.data.user);
      announceSessionEstablished({ accessToken: response.data.accessToken, user: response.data.user });
    }
  };

  const verifyMfa = async (challengeToken: string, code: string) => {
    const response = await apiFetch('/auth/mfa/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeToken, code }),
    });
    if (response?.data) {
      advanceSessionGeneration();
      setAccessToken(response.data.accessToken);
      setUser(response.data.user);
      announceSessionEstablished({ accessToken: response.data.accessToken, user: response.data.user });
    }
  };

  const logout = async () => {
    // The epoch turns FIRST, before the request: anything in flight from the
    // old session — a scheduled refresh, a background 401 retry — is stale
    // from this line on, however long it takes to resolve.
    sessionEpoch.current += 1;
    advanceSessionGeneration();
    announceSessionEnded();
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } catch (err) {
      console.error('Logout request failed', err);
    } finally {
      clearSession();
    }
  };

  useEffect(() => {
    refreshSession();
  }, [refreshSession]);

  /**
   * Resolve the tenant scope from the server.
   *
   * The backend resolves it from the `X-Managed-*` headers the API client
   * attaches, so the answer changes whenever the organization or branch
   * selector moves — and whenever the session itself changes. Both are
   * dependencies here.
   *
   * The security property is that a stale or superseded response can NEVER
   * update scope. Two independent mechanisms enforce it:
   *
   *  1. CANCELLATION — each request gets an AbortController whose signal is
   *     handed to apiFetch (FetchOptions extends RequestInit, so the signal
   *     reaches fetch unchanged). The cleanup aborts it, which covers token
   *     change, tenant change, logout, refresh failure and unmount, since all
   *     of those either change a dependency or unmount the provider.
   *  2. SUPPRESSION — scope is cleared the instant a dependency changes, and
   *     every request carries a generation that only the newest may write.
   *     Kept as defense in depth for a reply that resolves in the gap before
   *     the abort lands.
   *
   * An abort is expected, not a failure: `apiFetch` translates every rejection
   * into a user-facing connection message, so the signal itself is consulted
   * before any error-state write.
   */
  useEffect(() => {
    const generation = ++scopeGeneration.current;
    setScope(null);
    if (!accessToken) {
      setIsScopeLoading(false);
      return;
    }
    setIsScopeLoading(true);

    // Created only once there is a session to resolve.
    const controller = new AbortController();
    let alive = true;
    (async () => {
      try {
        const response = await apiFetch('/auth/me', { token: accessToken, signal: controller.signal });
        if (!alive || generation !== scopeGeneration.current) return;
        setScope(parseSessionScope(response?.data?.scope));
      } catch {
        if (controller.signal.aborted) return; // superseded on purpose
        // Fail closed: an unresolved scope grants nothing.
        if (!alive || generation !== scopeGeneration.current) return;
        setScope(null);
      } finally {
        if (alive && generation === scopeGeneration.current) setIsScopeLoading(false);
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [accessToken, tenantKey]);

  useEffect(() => {
    if (!accessToken) return;

    // Refresh token every 14 minutes (since access tokens are valid for 15m)
    const interval = setInterval(() => {
      refreshSession();
    }, 14 * 60 * 1000);

    return () => clearInterval(interval);
  }, [accessToken, refreshSession]);

  /**
   * Unlike the resolution effect above, this does NOT blank the scope first:
   * blanking would flash every capability-gated screen into its refused state
   * for a session that is still valid. It only ever replaces the scope with a
   * fresh answer, and a tenant switch that raced past it wins (generation).
   */
  const refreshScope = useCallback(async () => {
    if (!accessToken) return;
    // CLAIM a generation rather than reading one: two concurrent refreshes
    // used to carry the same number, so the slower earlier reply could land
    // last and overwrite the newer answer. Now only the newest claim writes.
    const generation = ++scopeGeneration.current;
    try {
      const response = await apiFetch('/auth/me', { token: accessToken });
      if (generation !== scopeGeneration.current) return; // superseded
      setScope(parseSessionScope(response?.data?.scope));
    } catch {
      if (generation !== scopeGeneration.current) return;
      // FAIL CLOSED, like the resolution effect above. Keeping the old scope
      // here treated an error as proof that yesterday's privileges still
      // stand — precisely backwards for the one caller this function has,
      // which invokes it immediately after changing somebody's access. The
      // cost is honest: a transient /auth/me failure blanks capability-gated
      // controls until the next successful resolution (the 14-minute refresh,
      // a tenant switch, or a reload), instead of rendering stale authority.
      setScope(null);
    }
  }, [accessToken]);

  const refreshIdentity = useCallback(async () => {
    if (!accessToken) return;
    const response = await apiFetch('/auth/me', { token: accessToken });
    const data = response?.data;
    if (!data) return;
    setUser((current) => current ? { ...current, ...data, store: data.store ?? current.store } : current);
    setScope(parseSessionScope(data.scope));
  }, [accessToken]);

  return (
    <AuthContext.Provider value={{ user, scope, accessToken, isLoading, isScopeLoading, login, verifyMfa, logout, refreshScope, refreshIdentity }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
