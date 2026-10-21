'use client';

import * as Sentry from '@sentry/nextjs';
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiContractError } from './api-contract';
import { isApiError } from './api-client';

function reportServerStateError(error: unknown, operation: 'query' | 'mutation'): void {
  // Expected business/authorization refusals belong in the UI, not in the
  // incident queue. Broken contracts, network failures and 5xx responses do.
  if (isApiError(error)) return; // HTTP failures are reported once by api-client.
  if (!(error instanceof ApiContractError)) return;
  Sentry.captureException(error, {
    tags: {
      layer: 'server-state',
      operation,
      contract: error instanceof ApiContractError ? 'invalid' : 'unknown',
    },
  });
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: (error) => reportServerStateError(error, 'query') }),
  mutationCache: new MutationCache({ onError: (error) => reportServerStateError(error, 'mutation') }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      // Component tests intentionally run without a backend. Retrying every
      // mounted query there only duplicates refused localhost connections;
      // production keeps one bounded retry for transient failures.
      retry: process.env.NODE_ENV === 'test' ? false : 1,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: { retry: false },
  },
});

export const queryKeys = {
  stores: (identity: string) => ['stores', identity] as const,
  billing: (identity: string) => ['billing-status', identity] as const,
  billingPage: (identity: string, mode: string) => ['billing-page', identity, mode] as const,
  categoriesRoot: (identity: string) => ['catalogue', identity, 'categories'] as const,
  categories: (identity: string, filters: object) =>
    ['catalogue', identity, 'categories', filters] as const,
  productsRoot: (identity: string) => ['catalogue', identity, 'products'] as const,
  products: (identity: string, filters: object) =>
    ['catalogue', identity, 'products', filters] as const,
  productDetail: (identity: string, productId: string) =>
    ['catalogue', identity, 'products', 'detail', productId] as const,
  productImages: (identity: string, productId: string, includeArchived: boolean) =>
    ['catalogue', identity, 'products', productId, 'images', { includeArchived }] as const,
  inventoryRoot: (identity: string) => ['inventory', identity] as const,
  inventoryLocations: (identity: string) => ['inventory', identity, 'locations'] as const,
  inventoryTransfers: (identity: string, status = '') =>
    ['inventory', identity, 'transfers', status] as const,
  inventoryStock: (identity: string, productId: string) =>
    ['inventory', identity, 'products', productId, 'stock'] as const,
  inventoryHistory: (identity: string, productId: string) =>
    ['inventory', identity, 'products', productId, 'history'] as const,
  inventoryProductSearch: (identity: string, search: string) =>
    ['inventory', identity, 'product-search', search] as const,
  websiteLiveCounts: (identity: string) => ['website', identity, 'live-counts'] as const,
  usersRoot: (identity: string) => ['users', identity] as const,
  users: (identity: string, filters: object) => ['users', identity, filters] as const,
  auditLogs: (identity: string, filters: object) => ['audit-logs', identity, filters] as const,
  metrics: (identity: string) => ['dashboard-metrics', identity] as const,
  salesRoot: (identity: string) => ['sales', identity] as const,
  sales: (identity: string, status: string) => ['sales', identity, status] as const,
  salesCatalogue: (identity: string, storeId: string) =>
    ['sales', identity, 'catalogue', storeId] as const,
  apiKeys: (identity: string) => ['website', identity, 'api-keys'] as const,
  catalogDashboard: (identity: string, includeActivity: boolean) => ['dashboard', identity, 'catalog', { includeActivity }] as const,
  ownerOverview: ['dashboard', 'platform', 'overview'] as const,
  ownerActivity: ['dashboard', 'platform', 'activity'] as const,
  activeCompanies: (reloadNonce: number) => ['organizations', 'active', reloadNonce] as const,
  platformUsersRoot: ['platform-users'] as const,
  platformUsers: (page: number, filters: object) => ['platform-users', page, filters] as const,
  settings: (identity: string) => ['settings', identity] as const,
  sessions: ['auth', 'sessions'] as const,
};

export function clearSessionQueries(): void {
  queryClient.clear();
}
