'use client';

import { useQuery } from '@tanstack/react-query';
import { apiFetch } from '../../lib/api-client';
import { queryKeys } from '../../lib/query-client';
import { categoryQueryIdentity } from '../categories/category-queries';
import {
  fetchLocations,
  fetchProductStock,
  fetchStockHistory,
  fetchTransfers,
} from './inventory-api';

export interface InventoryProductOption {
  id: string;
  name: string;
  sku?: string | null;
}

export function inventoryIdentity(organizationId: string, storeId?: string | null): string {
  return categoryQueryIdentity(organizationId, storeId);
}

export function useInventoryLocations(
  token: string | null,
  organizationId: string | null | undefined,
  storeId: string | null | undefined,
  enabled: boolean,
) {
  const identity = organizationId ? inventoryIdentity(organizationId, storeId) : 'no-organization';
  return useQuery({
    queryKey: queryKeys.inventoryLocations(identity),
    enabled: Boolean(token && organizationId && enabled),
    queryFn: () => fetchLocations(token as string),
  });
}

export function useInventoryTransfers(
  token: string | null,
  organizationId: string | null | undefined,
  storeId: string | null | undefined,
  enabled: boolean,
) {
  const identity = organizationId ? inventoryIdentity(organizationId, storeId) : 'no-organization';
  return useQuery({
    queryKey: queryKeys.inventoryTransfers(identity),
    enabled: Boolean(token && organizationId && enabled),
    queryFn: () => fetchTransfers(token as string),
  });
}

export function useInventoryProductSearch(
  token: string | null,
  organizationId: string | null | undefined,
  storeId: string | null | undefined,
  search: string,
  enabled: boolean,
) {
  const identity = organizationId ? inventoryIdentity(organizationId, storeId) : 'no-organization';
  const normalized = search.trim();
  return useQuery({
    queryKey: queryKeys.inventoryProductSearch(identity, normalized),
    enabled: Boolean(token && organizationId && enabled && normalized.length >= 2),
    queryFn: async (): Promise<InventoryProductOption[]> => {
      const response = await apiFetch(`/products?search=${encodeURIComponent(normalized)}&limit=10`, {
        token: token as string,
      });
      return response?.data ?? response?.items ?? [];
    },
  });
}

export function useInventoryStock(
  token: string | null,
  organizationId: string | null | undefined,
  storeId: string | null | undefined,
  productId: string | null | undefined,
  enabled: boolean,
) {
  const identity = organizationId ? inventoryIdentity(organizationId, storeId) : 'no-organization';
  return useQuery({
    queryKey: queryKeys.inventoryStock(identity, productId ?? ''),
    enabled: Boolean(token && organizationId && productId && enabled),
    queryFn: () => fetchProductStock(token as string, productId as string),
  });
}

export function useInventoryHistory(
  token: string | null,
  organizationId: string | null | undefined,
  storeId: string | null | undefined,
  productId: string | null | undefined,
  enabled: boolean,
) {
  const identity = organizationId ? inventoryIdentity(organizationId, storeId) : 'no-organization';
  return useQuery({
    queryKey: queryKeys.inventoryHistory(identity, productId ?? ''),
    enabled: Boolean(token && organizationId && productId && enabled),
    queryFn: () => fetchStockHistory(token as string, productId as string),
  });
}
