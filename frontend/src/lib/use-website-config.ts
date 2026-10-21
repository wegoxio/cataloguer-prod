'use client';

import { useCallback, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from './auth';
import { useManagedTenant } from './managed-tenant';
import { apiFetch } from './api-client';
import { queryClient, queryKeys } from './query-client';

export interface StoreRecord {
  id: string;
  name: string;
  slug: string;
  websiteUrl: string | null;
  websiteProductPath: string;
  websiteCategoryPath: string;
  // Standard modules the company hid from its sidebar (Settings → Customization)
  hiddenModules: string[] | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactAddress?: string | null;
  archivedAt: string | null;
  /** Present when the API reports it; removed branches are also filtered server-side. */
  removedAt?: string | null;
  createdAt: string;
}

export interface WebsiteConfig {
  websiteUrl: string | null;
  websiteProductPath: string;
  websiteCategoryPath: string;
}

/** Builds the public URL of an entity on a store's website, or null if unconfigured. */
export function buildWebsiteUrl(
  config: WebsiteConfig | null,
  kind: 'product' | 'category',
  slug: string,
): string | null {
  if (!config?.websiteUrl) return null;
  const pattern = kind === 'product' ? config.websiteProductPath : config.websiteCategoryPath;
  if (!pattern?.includes('{slug}')) return null;
  return `${config.websiteUrl}${pattern.replace('{slug}', encodeURIComponent(slug))}`;
}

// Cross-component sync: saving store changes anywhere (e.g. Settings →
// Customization) invalidates the one cached list, and every mounted reader
// re-renders from it. The event is kept so existing callers of
// `notifyStoresUpdated()` keep working unchanged.
const STORES_UPDATED_EVENT = 'wegox:stores-updated';
const STORES_UPDATED_KEY = 'wegox-stores-invalidated';

/** One stable empty array, so "no stores yet" never looks like a new value. */
const NO_STORES: StoreRecord[] = [];

export function notifyStoresUpdated(): void {
  void queryClient.invalidateQueries({ queryKey: ['stores'] });
  try {
    window.localStorage.setItem(STORES_UPDATED_KEY, `${Date.now()}-${Math.random()}`);
  } catch {
    // Same-tab invalidation still works without storage.
  }
  window.dispatchEvent(new Event(STORES_UPDATED_EVENT));
}

/**
 * All stores (ADR 007), readable by any authenticated role.
 *
 * Reads the ONE application-level cache (#184) instead of fetching per mount:
 * thirteen call sites plus the always-mounted sidebar used to issue thirteen
 * identical requests. The cache is keyed by scope, so a platform owner who
 * switches managed company never sees the previous company's branches.
 */
export function useStores(): { stores: StoreRecord[]; refresh: () => void; loaded: boolean } {
  const { accessToken, user } = useAuth();
  const tenant = useManagedTenant();
  const identity = `${user?.id ?? ''}|${tenant?.organizationId ?? ''}|${tenant?.storeId ?? ''}`;
  const query = useQuery({
    queryKey: queryKeys.stores(identity),
    enabled: Boolean(accessToken && user),
    queryFn: async () => {
      const response = await apiFetch('/stores?includeArchived=true', { method: 'GET', token: accessToken ?? undefined });
      return (response?.data ?? []) as StoreRecord[];
    },
  });

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.stores(identity) });
  }, [identity]);

  useEffect(() => {
    const onLocal = () => refresh();
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORES_UPDATED_KEY) refresh();
    };
    window.addEventListener(STORES_UPDATED_EVENT, onLocal);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(STORES_UPDATED_EVENT, onLocal);
      window.removeEventListener('storage', onStorage);
    };
  }, [refresh]);

  const stores = query.data ?? NO_STORES;

  // `loaded` separates "the list has not arrived" (or failed and will retry)
  // from "the company has no branches". Forms that must name a branch block
  // submission until it is true (#295 G1 acceptance).
  return { stores, refresh, loaded: query.isSuccess };
}

/**
 * Connection used for "View on site" links: the first active store with a
 * website URL. (Per-store links across the catalogue arrive with P7.2,
 * when products know which stores they belong to.)
 */
export function useWebsiteConfig(): WebsiteConfig | null {
  const { stores } = useStores();
  const first = stores.find((store) => !store.archivedAt && store.websiteUrl);
  return first
    ? {
        websiteUrl: first.websiteUrl,
        websiteProductPath: first.websiteProductPath || '/products/{slug}',
        websiteCategoryPath: first.websiteCategoryPath || '/categories/{slug}',
      }
    : null;
}
