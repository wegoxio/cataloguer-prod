'use client';

import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiFetch } from './api-client';
import { apiFetchValidated } from './api-contract';
import { queryKeys } from './query-client';
import { categoryQueryIdentity } from '../features/categories/category-queries';
import type { ManagedUser } from '../features/users/components/user-table';
import {
  platformUsersService,
  type PlatformUserFilters,
  type PlatformUserPage,
} from '../features/users/services/platform-users.service';

const liveCountsResponseSchema = z.object({
  data: z.object({ products: z.coerce.number().nonnegative(), categories: z.coerce.number().nonnegative() }),
}).passthrough();

const totalResponseSchema = z.object({ total: z.coerce.number().nonnegative() }).passthrough();

const metricsSchema = z.object({
  categories: z.object({ total: z.coerce.number(), active: z.coerce.number(), archived: z.coerce.number() }),
  products: z.object({ total: z.coerce.number(), draft: z.coerce.number(), published: z.coerce.number(), archived: z.coerce.number() }),
  images: z.object({ total: z.coerce.number(), active: z.coerce.number(), archived: z.coerce.number() }),
}).passthrough();

const reportSummaryResponseSchema = z.object({
  data: z.object({
    sales: z.object({
      todayCount: z.coerce.number().nonnegative(),
      todayTotal: z.coerce.number().nonnegative(),
      weekCount: z.coerce.number().nonnegative(),
      weekTotal: z.coerce.number().nonnegative(),
    }),
    stock: z.object({ lowStock: z.coerce.number().nonnegative() }),
  }),
}).passthrough();

export const tenantQueryIdentity = (
  organizationId: string | null | undefined,
  storeId: string | null | undefined,
) => organizationId ? categoryQueryIdentity(organizationId, storeId) : 'no-organization';

export function useWebsiteLiveCounts(token: string | null, organizationId?: string | null, storeId?: string | null) {
  const identity = tenantQueryIdentity(organizationId, storeId);
  return useQuery({
    queryKey: queryKeys.websiteLiveCounts(identity),
    enabled: Boolean(token && organizationId),
    queryFn: async (): Promise<{ products: number; categories: number }> => {
      const response = await apiFetchValidated('/catalogue/live-counts', liveCountsResponseSchema, { method: 'GET', token: token as string });
      return { products: response?.data?.products ?? 0, categories: response?.data?.categories ?? 0 };
    },
  });
}

export interface UserListFilters { search: string; includeDeactivated: boolean; page: number; limit: number }
export function useTeamUsers(token: string | null, organizationId: string | null | undefined, storeId: string | null | undefined, filters: UserListFilters, enabled: boolean) {
  const identity = tenantQueryIdentity(organizationId, storeId);
  return useQuery({
    queryKey: queryKeys.users(identity, filters),
    enabled: Boolean(token && organizationId && enabled),
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === identity ? previous : undefined,
    queryFn: async (): Promise<{ items: ManagedUser[]; totalPages: number }> => {
      const params = new URLSearchParams();
      if (filters.search) params.set('search', filters.search);
      if (filters.includeDeactivated) params.set('includeDeactivated', 'true');
      params.set('page', String(filters.page));
      params.set('limit', String(filters.limit));
      const response = await apiFetch(`/users?${params}`, { method: 'GET', token: token as string });
      return { items: response?.items ?? [], totalPages: Math.max(1, Number(response?.totalPages) || 1) };
    },
  });
}

export interface AuditLogRow {
  id: string; actorUserId?: string | null; actorEmail?: string | null; entityType: string;
  entityId: string; action: string; changes?: Record<string, unknown> | null; message?: string | null; createdAt: string;
}
export interface AuditFilters { entityType: string; action: string; actorEmail: string; page: number; limit: number }
export function useAuditLogs(token: string | null, organizationId: string | null | undefined, storeId: string | null | undefined, filters: AuditFilters, enabled: boolean) {
  const identity = tenantQueryIdentity(organizationId, storeId);
  return useQuery({
    queryKey: queryKeys.auditLogs(identity, filters),
    enabled: Boolean(token && organizationId && enabled),
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === identity ? previous : undefined,
    queryFn: async (): Promise<{ items: AuditLogRow[]; totalPages: number; total: number }> => {
      const params = new URLSearchParams();
      if (filters.entityType) params.set('entityType', filters.entityType);
      if (filters.action) params.set('action', filters.action);
      if (filters.actorEmail) params.set('actorEmail', filters.actorEmail);
      params.set('page', String(filters.page));
      params.set('limit', String(filters.limit));
      const response = await apiFetch(`/audit-logs?${params}`, { method: 'GET', token: token as string });
      return { items: response?.items ?? [], totalPages: Math.max(1, Number(response?.totalPages) || 1), total: Number(response?.total) || 0 };
    },
  });
}

export interface MetricsData {
  categories: { total: number; active: number; archived: number };
  products: { total: number; draft: number; published: number; archived: number };
  images: { total: number; active: number; archived: number };
}
export function useDashboardMetrics(token: string | null, organizationId: string | null | undefined, storeId: string | null | undefined, enabled: boolean) {
  const identity = tenantQueryIdentity(organizationId, storeId);
  return useQuery({
    queryKey: queryKeys.metrics(identity),
    enabled: Boolean(token && organizationId && enabled),
    queryFn: () => apiFetchValidated('/dashboard-metrics', metricsSchema, { method: 'GET', token: token as string }) as Promise<MetricsData>,
  });
}

export function useSales(token: string | null, organizationId: string | null | undefined, storeId: string | null | undefined, status: string, enabled: boolean) {
  const identity = tenantQueryIdentity(organizationId, storeId);
  return useQuery({
    queryKey: queryKeys.sales(identity, status),
    enabled: Boolean(token && organizationId && enabled),
    queryFn: async (): Promise<any[]> => {
      const response = await apiFetch(`/sales?limit=100${status ? `&status=${status}` : ''}`, { method: 'GET', token: token as string });
      return response?.items ?? [];
    },
  });
}

export function useSalesCatalogue(token: string | null, organizationId: string | null | undefined, scopeStoreId: string | null | undefined, targetStoreId: string | null, enabled: boolean) {
  const identity = tenantQueryIdentity(organizationId, scopeStoreId);
  return useQuery({
    queryKey: queryKeys.salesCatalogue(identity, targetStoreId ?? ''),
    enabled: Boolean(token && organizationId && enabled),
    queryFn: async (): Promise<any[]> => {
      const storeParam = targetStoreId ? `&storeId=${targetStoreId}` : '';
      const response = await apiFetch(`/products?limit=100&status=PUBLISHED&excludeParents=true${storeParam}`, { token: token as string });
      return response?.items ?? [];
    },
  });
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  store?: { id: string; name: string } | null;
  capabilities?: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function useApiKeys(token: string, organizationId?: string | null, storeId?: string | null) {
  const identity = tenantQueryIdentity(organizationId, storeId);
  return useQuery({
    queryKey: queryKeys.apiKeys(identity),
    enabled: Boolean(token && organizationId),
    queryFn: async (): Promise<ApiKeyRecord[]> => {
      const response = await apiFetch('/api-keys', { method: 'GET', token });
      return response?.data ?? [];
    },
  });
}

export interface CatalogDashboardData {
  attention: { drafts: number | null; withoutImages: number | null; withoutCategory: number | null; missingRequired: number | null };
  live: { products: number | null; categories: number | null };
  groupable: number | null;
  announcement: { title: string | null; body: string | null; url: string | null } | null;
  pulse: { todayCount: number; todayTotal: number; weekCount: number; weekTotal: number; latest: any[] } | null;
  lowStock: number | null;
  activity: any[];
}

export function useCatalogDashboard(token: string | null, organizationId: string | null | undefined, storeId: string | null | undefined, includeActivity: boolean) {
  const identity = tenantQueryIdentity(organizationId, storeId);
  return useQuery({
    queryKey: queryKeys.catalogDashboard(identity, includeActivity),
    enabled: Boolean(token && organizationId),
    queryFn: async (): Promise<CatalogDashboardData> => {
      const total = (path: string) => apiFetchValidated(path, totalResponseSchema, { method: 'GET', token: token as string })
        .then((response) => response?.total ?? 0)
        .catch(() => null);
      const [drafts, withoutImages, withoutCategory, missingRequired, products, categories, suggestions, announcementResponse, summaryResponse, latestResponse, activityResponse] = await Promise.all([
        total('/products?status=DRAFT&limit=1'),
        total('/products?hasImages=false&limit=1'),
        total('/products?hasCategory=false&limit=1'),
        total('/products?complete=false&limit=1'),
        total('/products?status=PUBLISHED&limit=1'),
        total('/categories?limit=1'),
        apiFetch('/products/family-suggestions', { method: 'GET', token: token as string }).catch(() => null),
        apiFetch('/settings/announcement', { token: token as string }).catch(() => null),
        apiFetchValidated('/reports/summary', reportSummaryResponseSchema, { token: token as string }).catch(() => null),
        apiFetch('/sales?limit=3', { token: token as string }).catch(() => null),
        includeActivity ? apiFetch('/audit-logs?limit=6', { method: 'GET', token: token as string }).catch(() => null) : null,
      ]);
      const summary = summaryResponse?.data;
      const suggestionRows = suggestions?.data ?? [];
      const groupable = suggestions?.readyCount
        ?? (Array.isArray(suggestionRows)
          ? suggestionRows.filter((row: any) => (row?.readiness ?? 'READY') === 'READY').length
          : 0);
      return {
        attention: { drafts, withoutImages, withoutCategory, missingRequired },
        live: { products, categories },
        groupable: suggestions ? groupable : null,
        announcement: announcementResponse?.data?.title || announcementResponse?.data?.body ? announcementResponse.data : null,
        pulse: summary ? {
          todayCount: summary.sales.todayCount,
          todayTotal: summary.sales.todayTotal,
          weekCount: summary.sales.weekCount,
          weekTotal: summary.sales.weekTotal,
          latest: (latestResponse?.items ?? []).slice(0, 3),
        } : null,
        lowStock: summary?.stock?.lowStock ?? null,
        activity: activityResponse?.items ?? [],
      };
    },
  });
}

export function useOwnerOverview(token: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.ownerOverview,
    enabled: Boolean(token && enabled),
    queryFn: async () => (await apiFetch('/stores/overview', { token: token as string }))?.data ?? null,
  });
}

const clientDetailsResponseSchema = z.object({
  data: z.object({
    company: z.object({ id: z.string(), name: z.string(), slug: z.string(), status: z.string(), createdAt: z.coerce.string(), archivedAt: z.string().nullable(), defaultContentLocale: z.string() }),
    plan: z.object({ key: z.string(), name: z.string(), priceUsd: z.number().nullable(), complimentary: z.boolean().optional(), maxWebsites: z.number().nullable(), maxTeamUsers: z.number().nullable(), stripeManaged: z.boolean(), subscriptionStatus: z.string().nullable(), nextChargeAt: z.coerce.string().nullable() }),
    usage: z.object({ stores: z.number(), activeStores: z.number(), products: z.number(), publishedProducts: z.number(), categories: z.number(), teamUsers: z.number(), activeTeamUsers: z.number(), pendingInvitations: z.number() }),
    commerce: z.object({ ordersTotal: z.number(), ordersThisMonth: z.number(), revenueThisMonth: z.number(), revenueTotal: z.number(), lastOrderAt: z.coerce.string().nullable(), paymentsCount: z.number(), totalPaid: z.number(), lastPaymentAt: z.coerce.string().nullable() }),
    stores: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string(), websiteUrl: z.string().nullable(), archivedAt: z.coerce.string().nullable(), createdAt: z.coerce.string() })),
    managers: z.array(z.object({ id: z.string(), email: z.string(), firstName: z.string().nullable(), lastName: z.string().nullable(), deletedAt: z.coerce.string().nullable() })),
    recentPayments: z.array(z.object({ id: z.string(), amountUsd: z.number(), description: z.string().nullable(), status: z.string(), paidAt: z.coerce.string().nullable(), invoiceUrl: z.string().nullable(), storeName: z.string() })),
    availablePlans: z.array(z.object({ key: z.string(), name: z.string(), priceUsd: z.number().nullable(), maxWebsites: z.number().nullable().optional(), maxTeamUsers: z.number().nullable().optional(), complimentary: z.boolean().optional() }).passthrough()),
  }),
});
export type ClientDetails = z.infer<typeof clientDetailsResponseSchema>['data'];

export function useClientDetails(token: string | null, organizationId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.clientDetails(organizationId),
    enabled: Boolean(token && organizationId && enabled),
    queryFn: async (): Promise<ClientDetails> =>
      (await apiFetchValidated(`/organizations/${organizationId}/client-details`, clientDetailsResponseSchema, {
        method: 'GET',
        token: token as string,
      })).data,
  });
}

export function useOwnerActivity(token: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.ownerActivity,
    enabled: Boolean(token && enabled),
    queryFn: async (): Promise<any[]> => (await apiFetch('/audit-logs?limit=8', { token: token as string }))?.items ?? [],
  });
}

export interface ActiveCompanyRecord {
  id: string;
  name: string;
  plan: string;
  billingStatus: string;
  archivedAt: string | null;
  mergedIntoOrganizationId: string | null;
  liveStoreCount: number;
}

export function useActiveCompanies(token: string, reloadNonce = 0) {
  return useQuery({
    queryKey: queryKeys.activeCompanies(reloadNonce),
    enabled: Boolean(token),
    queryFn: async (): Promise<ActiveCompanyRecord[]> => {
      const response = await apiFetch('/organizations?includeArchived=true', { method: 'GET', token });
      return ((response?.data ?? []) as ActiveCompanyRecord[])
        .filter((company) => !company.archivedAt && !company.mergedIntoOrganizationId);
    },
  });
}

export function usePlatformUsers(token: string | null, page: number, filters: PlatformUserFilters, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.platformUsers(page, filters),
    enabled: Boolean(token && enabled),
    queryFn: async (): Promise<PlatformUserPage> => {
      const response = await platformUsersService.list(token as string, page, filters);
      if (!response || !Array.isArray(response.items)) throw new Error('Could not load the platform users');
      return response;
    },
  });
}

export interface BillingPageData {
  subscription: any | null;
  payments: any[];
  stripeInfo: any | null;
  recurring: { usd: number; companies: number } | null;
}

export function useBillingPageData(
  token: string | null,
  organizationId: string | null | undefined,
  storeId: string | null | undefined,
  showSubscription: boolean,
  isOwner: boolean,
) {
  const identity = tenantQueryIdentity(organizationId, storeId);
  const mode = isOwner ? 'owner' : showSubscription ? 'subscriber' : 'none';
  return useQuery({
    queryKey: queryKeys.billingPage(identity, mode),
    enabled: Boolean(token && (showSubscription || isOwner)),
    queryFn: async (): Promise<BillingPageData> => {
      const [overview, subscription, stripeInfo, payments] = await Promise.all([
        isOwner ? apiFetch('/stores/overview', { method: 'GET', token: token as string }).catch(() => null) : null,
        apiFetch('/stores/subscription', { method: 'GET', token: token as string }).catch(() => null),
        showSubscription ? apiFetch('/billing/stripe-info', { method: 'GET', token: token as string }).catch(() => null) : null,
        showSubscription ? apiFetch('/billing/payments', { method: 'GET', token: token as string }).catch(() => null) : null,
      ]);
      const totals = overview?.data?.totals;
      return {
        subscription: subscription?.data ?? null,
        stripeInfo: stripeInfo?.data ?? null,
        payments: payments?.data ?? [],
        recurring: totals ? { usd: totals.monthlyRecurringUsd, companies: totals.recurringCompanies ?? 0 } : null,
      };
    },
  });
}

export function useSettings(token: string | null, organizationId: string | null | undefined, enabled: boolean) {
  const identity = tenantQueryIdentity(organizationId, null);
  return useQuery({
    queryKey: queryKeys.settings(identity),
    enabled: Boolean(token && enabled),
    queryFn: async () => (await apiFetch('/settings', { method: 'GET', token: token as string }))?.data ?? null,
  });
}

export interface SessionRecord {
  id: string;
  createdAt: string;
  ip: string | null;
  userAgent: string | null;
}

export function useSessions(token: string | null) {
  return useQuery({
    queryKey: queryKeys.sessions,
    enabled: Boolean(token),
    queryFn: async (): Promise<SessionRecord[]> => (await apiFetch('/auth/sessions', { token: token as string }))?.data ?? [],
  });
}
