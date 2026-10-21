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
  const { stores, refresh } = useStores();
  const live = useWebsiteLiveCounts(accessToken, scope?.organizationId, scope?.storeId).data ?? null;

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
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-bold text-slate-800">{t('Websites / Apps')}</h2>
        <p className="text-xs text-slate-500 mt-1">
          {t('Your websites, their connections, and what the catalogue API exposes to each one')}
        </p>
      </div>

      <StoresCard
        stores={stores}
        canCreate={canAddStore}
        canManageStore={(storeId: string) => canManageStore(scope, storeId)}
        accessToken={accessToken || ''}
        onChanged={refresh}
      />

      {/* What's live */}
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold text-slate-800">{t('Live right now')}</h3>
          <Badge variant="success">Catalogue API</Badge>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="card p-5 flex items-center gap-3">
            <div className="p-2 rounded-md bg-emerald-50 text-emerald-600">
              <Package className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-800">{live ? live.products : '—'}</p>
              <p className="text-xs text-slate-500">published products visible to visitors</p>
            </div>
          </div>
          <div className="card p-5 flex items-center gap-3">
            <div className="p-2 rounded-md bg-emerald-50 text-emerald-600">
              <FolderTree className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-800">{live ? live.categories : '—'}</p>
              <p className="text-xs text-slate-500">active categories visible to visitors</p>
            </div>
          </div>
        </div>
        <p className="text-xs text-slate-400">
          Drafts, archived items and internal fields (like cost) are never exposed to any website.
        </p>
      </div>

      {canAdministerKeys && reachableStore && accessToken && (
        <ApiKeysCard accessToken={accessToken} stores={stores} />
      )}
    </div>
  );
}
