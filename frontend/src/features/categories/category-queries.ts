'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api-client';
import { queryKeys } from '../../lib/query-client';
import type { Category } from './types/category.types';

export interface CategoryListFilters {
  search?: string;
  includeArchived?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDirection?: 'asc' | 'desc';
}

export interface CategoryListResult {
  items: Category[];
  total: number;
  totalPages: number;
}

export function categoryQueryIdentity(organizationId: string, storeId?: string | null): string {
  return `${organizationId}|${storeId ?? '*'}`;
}

function categorySearch(filters: CategoryListFilters): string {
  const params = new URLSearchParams();
  if (filters.search) params.set('search', filters.search);
  if (filters.includeArchived) params.set('includeArchived', 'true');
  if (filters.page !== undefined) params.set('page', String(filters.page));
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  if (filters.sortBy) params.set('sortBy', filters.sortBy);
  if (filters.sortDirection) params.set('sortDirection', filters.sortDirection);
  return params.toString();
}

export async function fetchCategoryList(token: string, filters: CategoryListFilters): Promise<CategoryListResult> {
  const response = await apiFetch(`/categories?${categorySearch(filters)}`, {
    method: 'GET',
    token,
  });
  return {
    items: response?.items ?? [],
    total: Number(response?.total) || 0,
    totalPages: Math.max(1, Number(response?.totalPages) || 1),
  };
}

export async function fetchCategoryDirectory(token: string): Promise<Category[]> {
  const firstPage = await fetchCategoryList(token, {
    page: 1,
    limit: 100,
    sortBy: 'name',
    sortDirection: 'asc',
  });
  const remainingPages = await Promise.all(
    Array.from({ length: Math.max(0, firstPage.totalPages - 1) }, (_, index) =>
      fetchCategoryList(token, {
        page: index + 2,
        limit: 100,
        sortBy: 'name',
        sortDirection: 'asc',
      }),
    ),
  );
  const byId = new Map(
    [firstPage, ...remainingPages]
      .flatMap((page) => page.items)
      .map((category) => [category.id, category]),
  );
  return [...byId.values()];
}

export function useCategoryList(
  token: string | null,
  organizationId: string | null | undefined,
  storeId: string | null | undefined,
  filters: CategoryListFilters,
) {
  const identity = organizationId ? categoryQueryIdentity(organizationId, storeId) : 'no-organization';
  return useQuery({
    queryKey: queryKeys.categories(identity, filters),
    enabled: Boolean(token && organizationId),
    queryFn: () => fetchCategoryList(token as string, filters),
    // Keep the previous page while filters/pagination change inside the same
    // tenant, but never carry one company's rows into another tenant even for
    // a loading frame.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === identity ? previous : undefined,
  });
}

export function useCategoryDirectory(
  token: string | null,
  organizationId: string | null | undefined,
  storeId: string | null | undefined,
  enabled = true,
) {
  const identity = organizationId ? categoryQueryIdentity(organizationId, storeId) : 'no-organization';
  return useQuery({
    queryKey: [...queryKeys.categoriesRoot(identity), 'directory'] as const,
    enabled: enabled && Boolean(token && organizationId),
    queryFn: () => fetchCategoryDirectory(token as string),
  });
}
