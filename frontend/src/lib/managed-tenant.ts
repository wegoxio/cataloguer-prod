'use client';

import { useSyncExternalStore } from 'react';

/**
 * The tenant context of the panel (P0-11): which ORGANIZATION the actor is
 * working inside, and optionally which of its stores.
 *
 * Replaces the old "managed company" mode, which only knew a store — with
 * organization as the tenant, a store alone cannot say who the client is.
 *
 * Who sets it:
 *  - the platform owner entering "manage client" from the Clients page
 *  - an ORGANIZATION_MANAGER narrowing to one of their branches
 * Branch-bound users never see a selector; their context comes from their
 * own account and this storage stays empty.
 *
 * apiFetch reads it and sends X-Managed-Organization / X-Managed-Store; the
 * backend validates both against the actor's real scope (P0-03), so a stale
 * or tampered value is refused, never trusted.
 */
export interface ManagedTenant {
  organizationId: string;
  organizationName: string;
  /** Narrowed branch, when one is selected. */
  storeId?: string | null;
  storeName?: string | null;
}

const KEY = 'wegox-managed-tenant';
const LEGACY_KEY = 'wegox-managed-store';
const EVENT = 'wegox:managed-tenant';

let cachedRaw: string | null = null;
let cachedValue: ManagedTenant | null = null;

export function getManagedTenant(): ManagedTenant | null {
  if (typeof window === 'undefined') return null;
  // The legacy store-only mode cannot be upgraded (it never knew the
  // organization); drop it so the owner re-enters manage mode cleanly once.
  if (window.localStorage.getItem(LEGACY_KEY)) {
    window.localStorage.removeItem(LEGACY_KEY);
  }
  const raw = window.localStorage.getItem(KEY);
  if (raw === cachedRaw) return cachedValue;
  cachedRaw = raw;
  try {
    cachedValue = raw ? (JSON.parse(raw) as ManagedTenant) : null;
  } catch {
    cachedValue = null;
  }
  return cachedValue;
}

export function enterManagedTenant(tenant: ManagedTenant): void {
  window.localStorage.setItem(KEY, JSON.stringify(tenant));
  window.dispatchEvent(new Event(EVENT));
}

/**
 * Narrow (or widen, storeId=null) to one branch of the SAME organization.
 *
 * `own` is the actor's OWN company, and it is what makes this work for an
 * ORGANIZATION_MANAGER. Only the platform owner ever calls
 * `enterManagedTenant`, so a manager had nothing stored — and this function
 * returned silently when it found nothing, which left the branch selector
 * inert for exactly the role the selector exists for. A manager is already
 * inside its company; it has no "enter company" step to seed the value.
 */
export function narrowToStore(
  storeId: string | null,
  storeName?: string | null,
  own?: { organizationId: string; organizationName: string } | null,
): void {
  const current = getManagedTenant();
  const base = current ?? (own?.organizationId ? { ...own } : null);
  if (!base) return;
  enterManagedTenant({ ...base, storeId, storeName: storeName ?? null });
}

/**
 * The branch the selector should show, or `''` for "all branches".
 *
 * Storage supplies the value, but the SERVER SCOPE decides whether it counts:
 * the stored organization must be the one in scope, and the stored branch must
 * be one this actor may act on. A stale value left by another company — or a
 * hand-edited one — therefore selects nothing, rather than displaying a branch
 * the actor has no authority over.
 */
export function selectedStoreId(
  managed: ManagedTenant | null,
  scope: { organizationId: string | null; allowedStoreIds: string[] } | null,
): string {
  if (!managed?.storeId || !scope?.organizationId) return '';
  if (managed.organizationId !== scope.organizationId) return '';
  return scope.allowedStoreIds.includes(managed.storeId) ? managed.storeId : '';
}

export function exitManagedTenant(): void {
  window.localStorage.removeItem(KEY);
  window.localStorage.removeItem(LEGACY_KEY);
  window.dispatchEvent(new Event(EVENT));
}

/** Headers for calls that cannot go through apiFetch (file uploads, CSV). */
export function tenantHeaders(): Record<string, string> {
  const tenant = getManagedTenant();
  if (!tenant) return {};
  const headers: Record<string, string> = { 'X-Managed-Organization': tenant.organizationId };
  if (tenant.storeId) headers['X-Managed-Store'] = tenant.storeId;
  return headers;
}

function subscribe(callback: () => void): () => void {
  window.addEventListener(EVENT, callback);
  window.addEventListener('storage', callback);
  return () => {
    window.removeEventListener(EVENT, callback);
    window.removeEventListener('storage', callback);
  };
}

export function useManagedTenant(): ManagedTenant | null {
  return useSyncExternalStore(subscribe, getManagedTenant, () => null);
}
