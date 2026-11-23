'use client';

import React from 'react';
import { Package, FolderTree } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { useT } from '../../../lib/i18n';
import { useStores } from '../../../lib/use-website-config';
import Badge from '../../../components/ui/badge';
import StoresCard from '../../../features/website/components/stores-card';
import ApiKeysCard from '../../../features/website/components/api-keys-card';
import {
  canActOnAllowedStore,
  canAdministerBranchServices,
  canCreateStore,
  canManageStore,
} from '../../../lib/permissions';
import { useWebsiteLiveCounts } from '../../../lib/domain-queries';

export default function WebsitePage() {
  const t = useT();
  const { scope, accessToken } = useAuth();
  const { stores, refresh, loaded: storesLoaded } = useStores();
  const liveQuery = useWebsiteLiveCounts(accessToken, scope?.organizationId, scope?.storeId);
  const live = liveQuery.data ?? null;

  // Store structure and API keys are DIFFERENT powers: §12 gives store
  // structure to SUPER_ADMIN and ORGANIZATION_MANAGER only, while API keys are
  // branch-service administration (P5-A2 family 3).
  const canAddStore = canCreateStore(scope);

  /**
   * The API-key card's PARENT gate, agreeing with the card itself.
   *
   * It was `user.role === 'SUPER_ADMIN' || user.role === 'ADMIN'`, which hid
   * the card from the ORGANIZATION_MANAGER the family-3 backend admits — a
   * parent gate blocking an authority the server grants. Authority now comes
   * from the resolved scope, and because this instance is not pinned to one
   * branch, the target half asks whether ANY branch is reachable: a narrowed
   * actor reaches exactly its selected branch, and the card then offers only
   * the branches that passed the same check.
   */
  const canAdministerKeys = canAdministerBranchServices(scope);
  const reachableStore = stores.some((store) => !store.archivedAt && canActOnAllowedStore(scope, store.id));

  // "What's live" comes from the same catalogue the websites consume, read
  // through the panel's own authenticated, tenant-scoped endpoint (#175) — so
  // these numbers are exactly what a visitor of this website sees right now.
  return (
    <div className="mx-auto w-full max-w-[1600px] space-y-6">
      <div>
        <h2 className="text-xl font-bold text-slate-800">{t('Websites / Apps')}</h2>
        <p className="text-xs text-slate-500 mt-1">
          {t('Your websites, their connections, and what the catalogue API exposes to each one')}
        </p>
      </div>

      {!storesLoaded ? (
        <div className="space-y-3" role="status" aria-label={t('Loading websites')}>
          <div className="h-5 w-40 animate-pulse rounded bg-slate-200" />
          <div className="card h-36 animate-pulse bg-slate-100" />
        </div>
      ) : <StoresCard
        stores={stores}
        canCreate={canAddStore}
        canManageStore={(storeId: string) => canManageStore(scope, storeId)}
        accessToken={accessToken || ''}
        onChanged={refresh}
      />}

      {/* What's live */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold text-slate-800">{t('Live right now')}</h3>
          <Badge variant="success">Catalogue API</Badge>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="card dashboard-card-enter flex min-h-28 items-center gap-4 p-4 sm:p-5">
            <div className="p-2 rounded-md bg-emerald-50 text-emerald-600">
              <Package className="h-5 w-5" />
            </div>
            <div>
              {liveQuery.isPending ? <div className="h-8 w-20 animate-pulse rounded bg-slate-200" /> : <p className="text-2xl font-bold tabular-nums text-slate-800 sm:text-3xl">{live ? live.products : '—'}</p>}
              <p className="text-xs text-slate-500">{t('published products visible to visitors')}</p>
            </div>
          </div>
          <div className="card dashboard-card-enter flex min-h-28 items-center gap-4 p-4 sm:p-5">
            <div className="p-2 rounded-md bg-emerald-50 text-emerald-600">
              <FolderTree className="h-5 w-5" />
            </div>
            <div>
              {liveQuery.isPending ? <div className="h-8 w-20 animate-pulse rounded bg-slate-200" /> : <p className="text-2xl font-bold tabular-nums text-slate-800 sm:text-3xl">{live ? live.categories : '—'}</p>}
              <p className="text-xs text-slate-500">{t('active categories visible to visitors')}</p>
            </div>
          </div>
        </div>
        {liveQuery.isError && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800" role="alert">
            <span>{t('Live catalogue counts could not be loaded.')}</span>
            <button type="button" className="font-semibold text-amber-900 hover:underline" onClick={() => liveQuery.refetch()}>{t('Retry')}</button>
          </div>
        )}
        <p className="text-xs leading-5 text-slate-500">
          {t('Drafts, archived items and internal fields (like cost) are never exposed to any website.')}
        </p>
      </section>

      {canAdministerKeys && reachableStore && accessToken && (
        <ApiKeysCard accessToken={accessToken} stores={stores} />
      )}
    </div>
  );
}
