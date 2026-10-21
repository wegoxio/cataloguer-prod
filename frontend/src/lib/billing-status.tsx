'use client';

import React, { createContext, useCallback, useContext, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from './auth';
import { apiFetch } from './api-client';
import { useManagedTenant } from './managed-tenant';
import { queryClient, queryKeys } from './query-client';

export type BillingStatus = string;

export interface BillingPlan {
  key: string;
  name: string;
  priceUsd: number | null;
  maxWebsites: number | null;
  maxTeamUsers: number | null;
  complimentary?: boolean;
}

interface BillingData {
  status: BillingStatus;
  plan: BillingPlan | null;
}

interface BillingStatusContextType {
  status: BillingStatus | null;
  plan: BillingPlan | null;
  isLoading: boolean;
  refresh: () => void;
}

const INVALIDATION_KEY = 'wegox-billing-invalidated';
const INVALIDATION_EVENT = 'wegox:billing-invalidated';
const BillingStatusContext = createContext<BillingStatusContextType | undefined>(undefined);

function invalidationToken(): string {
  const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `${Date.now()}-${suffix}`;
}

export function publishBillingInvalidation(): void {
  if (typeof window === 'undefined') return;
  const token = invalidationToken();
  try {
    window.localStorage.setItem(INVALIDATION_KEY, token);
  } catch {
    // Same-tab invalidation still works when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent(INVALIDATION_EVENT, { detail: token }));
}

export function BillingStatusProvider({ children }: { children: React.ReactNode }) {
  const { user, accessToken } = useAuth();
  const tenant = useManagedTenant();
  const identity = `${user?.id ?? ''}|${tenant?.organizationId ?? ''}|${tenant?.storeId ?? ''}`;
  const key = queryKeys.billing(identity);
  const query = useQuery({
    queryKey: key,
    enabled: Boolean(user && accessToken),
    staleTime: 60_000,
    queryFn: async (): Promise<BillingData> => {
      try {
        const response = await apiFetch('/billing/status', { token: accessToken ?? undefined });
        return {
          status: response?.data?.billingStatus ?? 'ACTIVE',
          plan: response?.data?.plan ?? null,
        };
      } catch {
        // A connectivity failure must not trap a paying customer in read-only
        // mode. Reconnect/focus will revalidate this bounded-stale value.
        return { status: 'ACTIVE', plan: null };
      }
    },
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.billing(identity) });
  }, [identity]);

  useEffect(() => {
    const onLocal = () => refresh();
    const onStorage = (event: StorageEvent) => {
      if (event.key === INVALIDATION_KEY) refresh();
    };
    window.addEventListener(INVALIDATION_EVENT, onLocal);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(INVALIDATION_EVENT, onLocal);
      window.removeEventListener('storage', onStorage);
    };
  }, [refresh]);

  return (
    <BillingStatusContext.Provider
      value={{
        status: query.data?.status ?? null,
        plan: query.data?.plan ?? null,
        isLoading: query.isPending,
        refresh,
      }}
    >
      {children}
    </BillingStatusContext.Provider>
  );
}

export function useBillingStatus(): BillingStatusContextType {
  const context = useContext(BillingStatusContext);
  if (!context) throw new Error('useBillingStatus must be used within a BillingStatusProvider');
  return context;
}
