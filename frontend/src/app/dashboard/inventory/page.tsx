'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, ClipboardCheck, RefreshCw, Search } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { useT } from '../../../lib/i18n';
import { useDebouncedValue } from '../../../lib/use-debounced-value';
import { canCommandInventory, canRecountInventory, canViewInventory } from '../../../lib/permissions';
import PageHeader from '../../../components/layout/page-header';
import AccessDenied from '../../../components/layout/access-denied';
import Button from '../../../components/ui/button';
import Badge from '../../../components/ui/badge';
import Input from '../../../components/ui/input';
import Select from '../../../components/ui/select';
import Modal from '../../../components/ui/modal';
import { useToast } from '../../../components/ui/toast';
import StockBreakdown from '../../../features/inventory/components/stock-breakdown';
import {
  advanceTransfer,
  fetchReconciliation,
  newIdempotencyKey,
  postRecount,
  postReclassify,
  type ReconciliationFinding,
  type TransferRow,
} from '../../../features/inventory/inventory-api';
import {
  inventoryIdentity,
  type InventoryProductOption,
  useInventoryHistory,
  useInventoryLocations,
  useInventoryProductSearch,
  useInventoryStock,
  useInventoryTransfers,
} from '../../../features/inventory/inventory-queries';
import { queryKeys } from '../../../lib/query-client';

/**
 * Inventory operations.
 *
 * Phase 5 built the ledger and deliberately gave it no routes, so this screen
 * did not exist: an operator could see the units a branch held and nothing
 * else — not what was sellable, not what was reserved or damaged, not where
 * anything had moved. Every number here comes from the ledger, and every
 * button is a named command the server authorises independently.
 */
export default function InventoryPage() {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { user, scope, accessToken } = useAuth();

  const mayView = canViewInventory(scope);
  const mayRecount = canRecountInventory(scope);
  const mayCommand = canCommandInventory(scope);

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search);
  const [selected, setSelected] = useState<InventoryProductOption | null>(null);
  const [findings, setFindings] = useState<ReconciliationFinding[] | null>(null);
  const [busy, setBusy] = useState(false);

  const [recountOpen, setRecountOpen] = useState(false);
  const [recountForm, setRecountForm] = useState({ locationId: '', countedQuantity: '', reason: '' });
  const [reclassifyOpen, setReclassifyOpen] = useState(false);
  const [reclassifyForm, setReclassifyForm] = useState({ locationId: '', quantity: '', reason: '' });

  const identity = scope?.organizationId
    ? inventoryIdentity(scope.organizationId, scope.storeId)
    : 'no-organization';
  const locationsQuery = useInventoryLocations(accessToken, scope?.organizationId, scope?.storeId, mayView);
  const transfersQuery = useInventoryTransfers(accessToken, scope?.organizationId, scope?.storeId, mayCommand);
  const searchQuery = useInventoryProductSearch(
    accessToken,
    scope?.organizationId,
    scope?.storeId,
    debouncedSearch,
    mayView,
  );
  const stockQuery = useInventoryStock(
    accessToken,
    scope?.organizationId,
    scope?.storeId,
    selected?.id,
    mayView,
  );
  const historyQuery = useInventoryHistory(
    accessToken,
    scope?.organizationId,
    scope?.storeId,
    selected?.id,
    mayView,
  );
  const options = debouncedSearch.trim().length >= 2 ? searchQuery.data ?? [] : [];
  const locations = locationsQuery.data ?? [];
  const transfers = transfersQuery.data ?? [];
  const stock = stockQuery.data ?? null;
  const history = historyQuery.data ?? [];

  const loadProduct = useCallback(
    async (product: InventoryProductOption) => {
      setSelected(product);
    },
    [],
  );

  const refreshSelected = useCallback(async () => {
    if (!selected) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.inventoryStock(identity, selected.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.inventoryHistory(identity, selected.id) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.productsRoot(identity) }),
    ]);
  }, [selected, queryClient, identity]);

  useEffect(() => {
    if (selected && (stockQuery.isError || historyQuery.isError)) {
      toast.error(t('Could not read the stock of this item'));
    }
  }, [selected, stockQuery.isError, historyQuery.isError, toast, t]);

  const runRecount = async () => {
    if (!accessToken || !selected) return;
    const counted = Number(recountForm.countedQuantity);
    if (!recountForm.locationId || !Number.isFinite(counted) || counted < 0 || recountForm.reason.trim().length < 3) {
      toast.error(t('Choose a location, a counted quantity and say why'));
      return;
    }
    setBusy(true);
    try {
      await postRecount(accessToken, {
        productId: selected.id,
        locationId: recountForm.locationId,
        countedQuantity: counted,
        reason: recountForm.reason.trim(),
      });
      toast.success(t('Count recorded'));
      setRecountOpen(false);
      setRecountForm({ locationId: '', countedQuantity: '', reason: '' });
      await refreshSelected();
    } catch (error: any) {
      toast.error(error.message || t('The count could not be recorded'));
    } finally {
      setBusy(false);
    }
  };

  const runReclassify = async () => {
    if (!accessToken || !selected) return;
    const quantity = Number(reclassifyForm.quantity);
    if (!reclassifyForm.locationId || !Number.isFinite(quantity) || quantity < 1 || reclassifyForm.reason.trim().length < 3) {
      toast.error(t('Choose a location, how many units and say why'));
      return;
    }
    setBusy(true);
    try {
      // One key per intent: if the response is lost and the operator presses
      // again, the ledger settles it as a replay instead of damaging twice.
      await postReclassify(accessToken, newIdempotencyKey(), {
        productId: selected.id,
        locationId: reclassifyForm.locationId,
        quantity,
        from: { physicalCondition: 'GOOD', operationalState: 'AVAILABLE' },
        to: { physicalCondition: 'DAMAGED', operationalState: 'NON_SELLABLE' },
        reason: reclassifyForm.reason.trim(),
      });
      toast.success(t('Units marked as not sellable'));
      setReclassifyOpen(false);
      setReclassifyForm({ locationId: '', quantity: '', reason: '' });
      await refreshSelected();
    } catch (error: any) {
      toast.error(error.message || t('The units could not be reclassified'));
    } finally {
      setBusy(false);
    }
  };

  const runReconciliation = async () => {
    if (!accessToken) return;
    setBusy(true);
    try {
      const result = await fetchReconciliation(accessToken);
      setFindings(result.findings);
      if (result.healthy) toast.success(t('Every inventory invariant holds'));
    } catch (error: any) {
      toast.error(error.message || t('The check could not run'));
    } finally {
      setBusy(false);
    }
  };

  const stepTransfer = async (
    transfer: TransferRow,
    step: 'commit' | 'dispatch' | 'receive' | 'start-return' | 'complete-return' | 'cancel',
  ) => {
    if (!accessToken) return;
    setBusy(true);
    try {
      await advanceTransfer(accessToken, transfer.id, step);
      toast.success(t('Transfer updated'));
      await queryClient.invalidateQueries({ queryKey: queryKeys.inventoryTransfers(identity) });
      await refreshSelected();
    } catch (error: any) {
      toast.error(error.message || t('The transfer could not be updated'));
    } finally {
      setBusy(false);
    }
  };

  if (!user) return null;
  if (!mayView) {
    return (
      <AccessDenied
        title={t('Inventory is not part of your access')}
        reason={t('Stock figures, movements and adjustments are available to branch and company administrators.')}
      />
    );
  }

  const locationName = (id: string) => locations.find((location) => location.id === id)?.name ?? id;

  return (
    <div>
      <PageHeader
        title={t('Inventory')}
        description={t('What the company owns, what each branch holds, and what can actually be sold.')}
        crumbs={[{ label: t('Dashboard'), href: '/dashboard' }, { label: t('Inventory') }]}
        actions={
          mayCommand ? (
            <Button variant="secondary" isLoading={busy} onClick={runReconciliation}>
              <ClipboardCheck className="h-3.5 w-3.5" /> {t('Check the books')}
            </Button>
          ) : undefined
        }
      />

      {findings !== null && (
        <div
          className={`mb-4 rounded-lg border px-3 py-2 text-xs ${
            findings.length === 0
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-amber-200 bg-amber-50 text-amber-900'
          }`}
          role="status"
          data-testid="reconciliation-result"
        >
          {findings.length === 0 ? (
            <p>{t('Every inventory invariant holds.')}</p>
          ) : (
            <>
              <p className="font-bold mb-1">{t('{n} invariant(s) disagree', { n: String(findings.length) })}</p>
              <ul className="list-disc pl-4 space-y-0.5">
                {findings.map((finding, index) => (
                  <li key={`${finding.invariant}-${index}`}>
                    <span className="font-semibold">{finding.invariant}</span>: {finding.detail}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}

      <div className="card p-4 space-y-3">
        <label className="block">
          <span className="text-[10px] font-semibold text-slate-500 uppercase">{t('Find an item')}</span>
          <div className="relative mt-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" aria-hidden="true" />
            <input
              className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
              placeholder={t('Search by name, SKU or manufacturer code')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label={t('Search by name, SKU or manufacturer code')}
            />
          </div>
        </label>

        {options.length > 0 && (
          <ul className="divide-y divide-slate-100 border border-slate-100 rounded-lg overflow-hidden" data-testid="search-results">
            {options.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  onClick={() => loadProduct(option)}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-slate-50 flex items-center justify-between gap-3"
                >
                  <span className="truncate text-slate-700">{option.name}</span>
                  {option.sku && <span className="text-[11px] text-slate-400 shrink-0">{option.sku}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected && stock && (
        <div className="card p-4 mt-4 space-y-4" data-testid="product-inventory">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-sm font-bold text-slate-800">{selected.name}</h2>
              <p className="text-[11px] text-slate-400">{t('Every figure below comes from the inventory ledger.')}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" onClick={refreshSelected} tooltip={t('Read the numbers again')}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
              {mayRecount && (
                <Button variant="secondary" onClick={() => setRecountOpen(true)}>
                  <ClipboardCheck className="h-3.5 w-3.5" /> {t('Record a count')}
                </Button>
              )}
              {mayCommand && (
                <Button variant="secondary" onClick={() => setReclassifyOpen(true)}>
                  {t('Mark as damaged')}
                </Button>
              )}
            </div>
          </div>

          <StockBreakdown stock={stock} />

          <div>
            <h3 className="text-[10px] font-semibold text-slate-500 uppercase mb-1">{t('Movements')}</h3>
            {history.length === 0 ? (
              <p className="text-xs text-slate-400">{t('Nothing has moved yet.')}</p>
            ) : (
              <div className="overflow-x-auto border border-slate-100 rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold text-slate-500 uppercase">{t('When')}</th>
                      <th className="px-3 py-2 text-left font-semibold text-slate-500 uppercase">{t('What')}</th>
                      <th className="px-3 py-2 text-left font-semibold text-slate-500 uppercase">{t('Where')}</th>
                      <th className="px-3 py-2 text-right font-semibold text-slate-500 uppercase">{t('Units')}</th>
                      <th className="px-3 py-2 text-left font-semibold text-slate-500 uppercase">{t('Who')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((movement, index) => (
                      <tr key={`${movement.id}-${index}`} className="border-t border-slate-100">
                        <td className="px-3 py-1.5 text-slate-500 whitespace-nowrap">
                          {new Date(movement.postedAt).toLocaleString()}
                        </td>
                        <td className="px-3 py-1.5">
                          <Badge variant="neutral">{movement.type}</Badge>
                        </td>
                        <td className="px-3 py-1.5 text-slate-600">{movement.locationName ?? '—'}</td>
                        <td
                          className={`px-3 py-1.5 text-right font-semibold tabular-nums ${
                            movement.quantityDelta < 0 ? 'text-red-600' : 'text-emerald-700'
                          }`}
                        >
                          {movement.quantityDelta > 0 ? `+${movement.quantityDelta}` : movement.quantityDelta}
                        </td>
                        <td className="px-3 py-1.5 text-slate-500">{movement.actorEmail ?? movement.actorKind}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {mayCommand && (
        <div className="card p-4 mt-4 space-y-2" data-testid="transfers">
          <div className="flex items-center gap-2">
            <ArrowLeftRight className="h-4 w-4 text-primary" aria-hidden="true" />
            <h2 className="text-sm font-bold text-slate-800">{t('Transfers')}</h2>
          </div>
          <p className="text-[11px] text-slate-400">
            {t('Stock moving between the warehouse and a branch, or between branches. Each step is recorded.')}
          </p>
          {transfers.length === 0 ? (
            <p className="text-xs text-slate-400">{t('No transfers yet.')}</p>
          ) : (
            <ul className="divide-y divide-slate-100 border border-slate-100 rounded-lg overflow-hidden">
              {transfers.map((transfer) => (
                <li key={transfer.id} className="px-3 py-2 flex items-center justify-between gap-3 text-sm bg-white">
                  <div className="min-w-0">
                    <p className="text-slate-700 truncate">
                      {transfer.sourceName} → {transfer.destinationName}
                    </p>
                    <p className="text-[11px] text-slate-400">
                      {transfer.reference || t('No reference')} · {new Date(transfer.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant={transfer.status === 'RECEIVED' ? 'success' : 'info'}>{transfer.status}</Badge>
                    {transfer.status === 'DRAFT' && (
                      <Button size="sm" variant="secondary" isLoading={busy} onClick={() => stepTransfer(transfer, 'commit')}>
                        {t('Commit')}
                      </Button>
                    )}
                    {transfer.status === 'COMMITTED' && (
                      <Button size="sm" variant="secondary" isLoading={busy} onClick={() => stepTransfer(transfer, 'dispatch')}>
                        {t('Dispatch')}
                      </Button>
                    )}
                    {['IN_TRANSIT', 'PARTIALLY_RECEIVED'].includes(transfer.status) && (
                      <>
                        <Button size="sm" isLoading={busy} onClick={() => stepTransfer(transfer, 'receive')}>
                          {t('Receive')}
                        </Button>
                        {/* Goods on the road cannot be cancelled — they exist
                            somewhere between two shelves. Turning them around
                            is its own recorded movement, not an undo. */}
                        <Button
                          size="sm"
                          variant="secondary"
                          isLoading={busy}
                          onClick={() => stepTransfer(transfer, 'start-return')}
                        >
                          {t('Turn it back')}
                        </Button>
                      </>
                    )}
                    {transfer.status === 'RETURNING' && (
                      <Button size="sm" isLoading={busy} onClick={() => stepTransfer(transfer, 'complete-return')}>
                        {t('Returned home')}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <Modal open={recountOpen} title={t('Record a count')} onClose={() => setRecountOpen(false)}>
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            {t('Say what is physically there. This replaces the figure rather than adding to it, so counting twice is safe.')}
          </p>
          <Select
            label={t('Where')}
            value={recountForm.locationId}
            onChange={(event) => setRecountForm({ ...recountForm, locationId: event.target.value })}
          >
            <option value="">—</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name} ({location.kind})
              </option>
            ))}
          </Select>
          <Input
            label={t('Units counted')}
            type="number"
            min={0}
            value={recountForm.countedQuantity}
            onChange={(event) => setRecountForm({ ...recountForm, countedQuantity: event.target.value })}
          />
          <Input
            label={t('Why')}
            placeholder={t('e.g. annual count')}
            value={recountForm.reason}
            onChange={(event) => setRecountForm({ ...recountForm, reason: event.target.value })}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setRecountOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button isLoading={busy} onClick={runRecount}>
              {t('Record the count')}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={reclassifyOpen} title={t('Mark units as damaged')} onClose={() => setReclassifyOpen(false)}>
        <div className="space-y-3">
          <p className="text-xs text-slate-500">
            {t('These units stay owned by the company but stop being sellable. The company total does not change.')}
          </p>
          <Select
            label={t('Where')}
            value={reclassifyForm.locationId}
            onChange={(event) => setReclassifyForm({ ...reclassifyForm, locationId: event.target.value })}
          >
            <option value="">—</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name} ({location.kind})
              </option>
            ))}
          </Select>
          <Input
            label={t('How many units')}
            type="number"
            min={1}
            value={reclassifyForm.quantity}
            onChange={(event) => setReclassifyForm({ ...reclassifyForm, quantity: event.target.value })}
          />
          <Input
            label={t('Why')}
            placeholder={t('e.g. water damage in the stockroom')}
            value={reclassifyForm.reason}
            onChange={(event) => setReclassifyForm({ ...reclassifyForm, reason: event.target.value })}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setReclassifyOpen(false)}>
              {t('Cancel')}
            </Button>
            <Button isLoading={busy} onClick={runReclassify}>
              {t('Mark as damaged')}
            </Button>
          </div>
        </div>
      </Modal>
      <span className="sr-only" data-testid="selected-location-hint">
        {selected && recountForm.locationId ? locationName(recountForm.locationId) : ''}
      </span>
    </div>
  );
}
