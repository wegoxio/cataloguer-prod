'use client';

import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { KeyRound, Copy, Check } from 'lucide-react';
import { apiFetch } from '../../../lib/api-client';
import { useAuth } from '../../../lib/auth';
import { canActOnAllowedStore, canAdministerBranchServices } from '../../../lib/permissions';
import { useToast } from '../../../components/ui/toast';
import { useT } from '../../../lib/i18n';
import Button from '../../../components/ui/button';
import Badge from '../../../components/ui/badge';
import Checkbox from '../../../components/ui/checkbox';
import Input from '../../../components/ui/input';
import Modal from '../../../components/ui/modal';
import ConfirmModal from '../../../components/ui/confirm-modal';
import Select from '../../../components/ui/select';
import { Table, THead, TH, TBody, TR, TD, EmptyState } from '../../../components/ui/table';
import type { StoreRecord } from '../../../lib/use-website-config';
import { tenantQueryIdentity, useApiKeys, type ApiKeyRecord } from '../../../lib/domain-queries';
import { queryKeys } from '../../../lib/query-client';

/**
 * Phase 6: what a key is ALLOWED to do. Mirrors the server's closed
 * vocabulary — the server normalizes and the database CHECKs, so this list is
 * presentation, not authority. New keys default to read-only; granting order
 * authority is a visible choice with a warning, never an accident.
 */
const CAPABILITY_OPTIONS = [
  { value: 'CATALOGUE_READ', label: 'Read the catalogue' },
  { value: 'ORDER_CREATE', label: 'Create orders' },
  { value: 'DISCOUNT_VALIDATE', label: 'Validate discount codes' },
] as const;

const CAPABILITY_BADGES: Record<string, string> = {
  CATALOGUE_READ: 'Read',
  ORDER_CREATE: 'Orders',
  DISCOUNT_VALIDATE: 'Discounts',
};

const DEFAULT_CAPABILITIES = ['CATALOGUE_READ'];

export default function ApiKeysCard({
  accessToken,
  stores,
  storeId,
}: {
  accessToken: string;
  stores: StoreRecord[];
  /** When set, the card is scoped to one store: filtered list, fixed store on create. */
  storeId?: string;
}) {
  const t = useT();
  const { scope } = useAuth();
  const queryClient = useQueryClient();
  const activeStores = stores.filter((store) => !store.archivedAt);
  const toast = useToast();
  /**
   * P5-A2 family 3 (D-1). A key is a STORE CREDENTIAL, so two questions are
   * asked and BOTH must answer yes.
   *
   * WHO — `canAdministerBranchServices`, the same authority that governs
   * other branch administration, because they share one server role
   * list. This card carries the check itself rather than trusting its caller:
   * the store page renders it on an ungated tab, so a VIEWER whose own branch
   * matched would otherwise have been offered "Create Key".
   *
   * WHICH BRANCH — `canActOnAllowedStore`. The server stopped preferring the
   * actor's own binding over the store actually asked for, and narrowing now
   * binds, so the picker offers exactly the branches that can hold a key.
   */
  const canAdminister = canAdministerBranchServices(scope);
  const targetableStores = activeStores.filter((store) => canActOnAllowedStore(scope, store.id));
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newStoreId, setNewStoreId] = useState('');
  const [newCapabilities, setNewCapabilities] = useState<string[]>(DEFAULT_CAPABILITIES);
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRecord | null>(null);

  const identity = tenantQueryIdentity(scope?.organizationId, scope?.storeId);
  const keysQuery = useApiKeys(accessToken, scope?.organizationId, scope?.storeId);
  const keys = keysQuery.data ?? [];
  const refreshKeys = () => queryClient.invalidateQueries({ queryKey: queryKeys.apiKeys(identity) });

  const visibleKeys = storeId ? keys.filter((key) => key.store?.id === storeId) : keys;

  // The card may be pinned to one branch by its page; otherwise the actor
  // picks, and a single reachable branch answers the question by itself.
  const createStoreId =
    storeId || newStoreId || (targetableStores.length === 1 ? targetableStores[0].id : '');
  const createAllowed = canAdminister && canActOnAllowedStore(scope, createStoreId);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    // Both checks again in the handler: authority first…
    if (!canAdminister) return;
    // …then the target. Never fall back to "the first store in the list":
    // that is how a request ends up naming a branch the actor may not touch.
    if (!createAllowed) {
      toast.error(t('Choose which branch this key is for'));
      return;
    }
    setCreating(true);
    try {
      const response = await apiFetch('/api-keys', {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({ name: newName.trim(), storeId: createStoreId, capabilities: newCapabilities }),
      });
      setCreatedKey(response?.data?.key ?? null);
      setNewName('');
      await refreshKeys();
    } catch (err: any) {
      toast.error(err.message || 'Failed to create API key');
    } finally {
      setCreating(false);
    }
  };

  /**
   * Revoking is store-targeted too: the key names its own branch, and the
   * server binds narrowing to it. A legacy store-less key belongs to no
   * tenant and only the unscoped platform owner may revoke it — which is not
   * an actor this card ever serves, so it stays refused here.
   */
  const canRevokeKey = (key: ApiKeyRecord): boolean =>
    canAdminister && canActOnAllowedStore(scope, key.store?.id);

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    if (!canRevokeKey(revokeTarget)) {
      setRevokeTarget(null);
      return;
    }
    try {
      await apiFetch(`/api-keys/${revokeTarget.id}/revoke`, { method: 'PATCH', token: accessToken });
      toast.success(`Key "${revokeTarget.name}" revoked`);
      setRevokeTarget(null);
      await refreshKeys();
    } catch (err: any) {
      toast.error(err.message || 'Failed to revoke key');
      setRevokeTarget(null);
    }
  };

  const closeCreate = () => {
    setIsCreateOpen(false);
    setCreatedKey(null);
    setCopied(false);
    setNewName('');
    setNewCapabilities(DEFAULT_CAPABILITIES);
  };

  const toggleCapability = (capability: string) =>
    setNewCapabilities((current) =>
      current.includes(capability) ? current.filter((entry) => entry !== capability) : [...current, capability],
    );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold text-slate-800">{t('API Access')}</h3>
          <Badge variant="info">{t('for the website')}</Badge>
        </div>
        {canAdminister && (
          <Button size="sm" tooltip={t('Create an access key for a website')} onClick={() => setIsCreateOpen(true)}>
            <KeyRound className="h-3.5 w-3.5" /> {t('New Key')}
          </Button>
        )}
      </div>
      <p className="text-xs text-slate-500">
        The website (and any integration) authenticates against the Catalogue API with one of these
        keys, sent as the <code className="bg-slate-100 px-1 rounded">X-Api-Key</code> header.
        Revoking a key cuts that consumer off immediately.
      </p>

      {visibleKeys.length === 0 ? (
        <EmptyState
          message={t('No API keys yet.')}
          hint={t('Create one and configure it on the website — the catalogue API requires it.')}
        />
      ) : (
        <Table>
          <THead>
            <TH>{t('Name')}</TH>
            <TH>{t('Store')}</TH>
            <TH>{t('Permissions')}</TH>
            <TH>{t('Key')}</TH>
            <TH>{t('Last used')}</TH>
            <TH>{t('Status')}</TH>
            <TH align="right">{t('Actions')}</TH>
          </THead>
          <TBody>
            {visibleKeys.map((key) => (
              <TR key={key.id} className={key.revokedAt ? 'bg-slate-50 text-slate-400' : ''}>
                <TD className="font-medium">{key.name}</TD>
                <TD className="text-xs text-slate-600">{key.store?.name || <span className="italic text-slate-400">all (legacy)</span>}</TD>
                <TD>
                  <div className="flex flex-wrap gap-1">
                    {(key.capabilities ?? []).map((capability) => (
                      <Badge key={capability} variant={capability === 'CATALOGUE_READ' ? 'info' : 'warning'}>
                        {t(CAPABILITY_BADGES[capability] ?? capability)}
                      </Badge>
                    ))}
                  </div>
                </TD>
                <TD className="font-mono text-xs">{key.prefix}…</TD>
                <TD className="text-xs text-slate-500">
                  {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : t('never')}
                </TD>
                <TD>
                  {key.revokedAt ? <Badge variant="danger">{t('Revoked')}</Badge> : <Badge variant="success">{t('Active')}</Badge>}
                </TD>
                <TD align="right">
                  {!key.revokedAt && canRevokeKey(key) && (
                    <Button size="sm" variant="ghost" className="text-danger" tooltip={t('Permanently disable this key — the website loses access')} onClick={() => setRevokeTarget(key)}>
                      {t('Revoke')}
                    </Button>
                  )}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      <Modal open={isCreateOpen} title={createdKey ? 'API Key Created' : 'New API Key'} onClose={closeCreate}>
        {createdKey ? (
          <div className="space-y-4">
            <p className="text-sm text-slate-600">
              Copy the key now — <span className="font-semibold">it will never be shown again</span>.
            </p>
            <div className="flex items-center gap-2 p-3 bg-slate-900 rounded-md">
              <code className="text-xs text-emerald-300 break-all flex-1">{createdKey}</code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(createdKey);
                  setCopied(true);
                }}
                className="text-slate-300 hover:text-white shrink-0"
                aria-label="Copy key"
              >
                {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
              </button>
            </div>
            <div className="flex justify-end">
              <Button onClick={closeCreate}>Done</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <Input
              label="Key name"
              placeholder="e.g. Client website (production)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            {!storeId && (
              <Select
                label="Store (the catalogue this key exposes)"
                value={createStoreId}
                onChange={(e) => setNewStoreId(e.target.value)}
              >
                <option value="">—</option>
                {targetableStores.map((store) => (
                  <option key={store.id} value={store.id}>
                    {store.name}
                  </option>
                ))}
              </Select>
            )}
            {!createAllowed && (
              <p className="text-xs text-slate-400">{t('Choose which branch this key is for')}</p>
            )}
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-slate-700">{t('Permissions')}</p>
              <p className="text-xs text-slate-500">
                {t('New keys are read-only by default. Grant only what the consumer really does.')}
              </p>
              {CAPABILITY_OPTIONS.map((option) => (
                <Checkbox
                  key={option.value}
                  label={t(option.label)}
                  checked={newCapabilities.includes(option.value)}
                  onChange={() => toggleCapability(option.value)}
                />
              ))}
              {newCapabilities.includes('ORDER_CREATE') && (
                <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2 py-1.5">
                  {t('This key will be able to PLACE ORDERS for the store. Anyone holding it can order — keep it strictly server-side and revoke it immediately if exposed.')}
                </p>
              )}
              {newCapabilities.length === 0 && (
                <p className="text-xs text-slate-400">{t('Select at least one permission')}</p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={closeCreate}>
                Cancel
              </Button>
              <Button
                onClick={handleCreate}
                isLoading={creating}
                disabled={!newName.trim() || !createAllowed || newCapabilities.length === 0}
              >
                Create Key
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        open={revokeTarget !== null}
        title="Revoke API Key"
        message={
          <>
            Revoke <span className="font-semibold">{revokeTarget?.name}</span>? Any website or
            integration using it will lose catalogue access <strong>immediately</strong>.
          </>
        }
        confirmLabel="Revoke"
        danger
        onConfirm={handleRevoke}
        onCancel={() => setRevokeTarget(null)}
      />
    </div>
  );
}
