'use client';

import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, ShoppingBag } from 'lucide-react';
import { useAuth } from '../../../lib/auth';
import { canManageOrders, effectiveStoreId as effectiveStoreIdOf } from '../../../lib/permissions';
import { resolveBranchTarget } from '../../../lib/branch-target';
import AccessDenied from '../../../components/layout/access-denied';
import { apiFetch } from '../../../lib/api-client';
import { useT } from '../../../lib/i18n';
import { useToast } from '../../../components/ui/toast';
import Badge from '../../../components/ui/badge';
import Select from '../../../components/ui/select';
import Button from '../../../components/ui/button';
import { Table, THead, TH, TBody, TR, TD, EmptyState } from '../../../components/ui/table';
import Input from '../../../components/ui/input';
import Modal from '../../../components/ui/modal';
import { useStores } from '../../../lib/use-website-config';
import { tenantQueryIdentity, useSales, useSalesCatalogue } from '../../../lib/domain-queries';
import { queryKeys } from '../../../lib/query-client';

const STATUSES = ['NEW', 'CONFIRMED', 'PAID', 'DELIVERED', 'CANCELLED'] as const;
const STATUS_BADGE: Record<string, 'info' | 'warning' | 'success' | 'neutral' | 'danger'> = {
  NEW: 'info',
  CONFIRMED: 'warning',
  PAID: 'success',
  DELIVERED: 'neutral',
  CANCELLED: 'danger',
};
const STATUS_ES: Record<string, string> = {
  NEW: 'Nueva',
  CONFIRMED: 'Confirmada',
  PAID: 'Pagada',
  DELIVERED: 'Entregada',
  CANCELLED: 'Cancelada',
};

/** Sales: orders placed by final users on the company's websites. */
export default function SalesPage() {
  const { user, scope, accessToken } = useAuth();
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  /**
   * P5-A2 family 5 (D-5.1). The owner-only picker is gone: it offered EVERY
   * company's stores because it was built on `role === 'SUPER_ADMIN' && !store`.
   * The selector is now derived from the resolved scope and offers exactly the
   * branches that scope allows — so a managed platform session and an
   * un-narrowed manager choose within their own company, while a narrowed
   * actor, an ADMIN and an EDITOR are locked to the branch they already have.
   */
  const mayWork = canManageOrders(scope);
  const { stores, loaded: storesLoaded } = useStores();
  const lockedStoreId = effectiveStoreIdOf(scope, user?.store?.id ?? null);
  // Which branch an order belongs to only matters when the actor spans several.
  const showBranchColumn = !lockedStoreId;

  // Manual sale entry (phone / in-person orders)
  const [saleOpen, setSaleOpen] = useState(false);
  const [saleBusy, setSaleBusy] = useState(false);
  const [sale, setSale] = useState<{ storeId: string; customerName: string; customerPhone: string; rows: { productId: string; quantity: number }[] }>({
    storeId: '',
    customerName: '',
    customerPhone: '',
    rows: [{ productId: '', quantity: 1 }],
  });
  /**
   * The branch this manual sale is entered for (#295 G1 acceptance), from the
   * one decision the invoice editor shares: a branch actor's own branch; the
   * only live branch of a company-wide actor (the picker used to require two
   * or more, so one branch meant NO branch and the server refused the sale);
   * an explicit choice among several; a blocked state when there is none.
   */
  const saleTarget = resolveBranchTarget({ scope, legacyStoreId: user?.store?.id ?? null, stores, loaded: storesLoaded, selected: sale.storeId });
  const saleTargetStoreId = saleTarget.storeId;
  const saleBranchBlocked = saleTargetStoreId === null;

  const identity = tenantQueryIdentity(scope?.organizationId, scope?.storeId);
  const salesQuery = useSales(accessToken, scope?.organizationId, scope?.storeId, status, mayWork);
  const catalogueStoreId = saleTarget.state !== 'locked' ? saleTargetStoreId : null;
  const catalogueQuery = useSalesCatalogue(
    accessToken,
    scope?.organizationId,
    scope?.storeId,
    catalogueStoreId,
    saleOpen && !saleBranchBlocked,
  );
  const orders = salesQuery.data ?? [];
  const catalog = catalogueQuery.data ?? [];
  const loading = salesQuery.isPending;
  const refreshSales = () => queryClient.invalidateQueries({ queryKey: queryKeys.salesRoot(identity) });

  const submitSale = async () => {
    if (!accessToken) return;
    const items = sale.rows.filter((r) => r.productId).map((r) => ({ productId: r.productId, quantity: r.quantity || 1 }));
    if (!items.length) {
      toast.error(t('Add at least one item'));
      return;
    }
    // No request without a branch: the modal already says why.
    if (saleBranchBlocked) return;
    setSaleBusy(true);
    try {
      const r = await apiFetch('/sales', {
        method: 'POST',
        token: accessToken,
        body: JSON.stringify({
          // Named explicitly and validated by the server against the scope.
          storeId: saleTargetStoreId ?? undefined,
          customerName: sale.customerName || undefined,
          customerPhone: sale.customerPhone || undefined,
          items,
        }),
      });
      toast.success(`${t('Sale recorded')} #${r?.data?.orderNumber ?? ''} — $${r?.data?.totalUsd ?? ''}`);
      setSaleOpen(false);
      setSale({ storeId: '', customerName: '', customerPhone: '', rows: [{ productId: '', quantity: 1 }] });
      await refreshSales();
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    } finally {
      setSaleBusy(false);
    }
  };

  const changeStatus = async (id: string, next: string) => {
    try {
      await apiFetch(`/sales/${id}/status`, {
        method: 'PATCH',
        token: accessToken || '',
        body: JSON.stringify({ status: next }),
      });
      toast.success(t('Order updated'));
      await refreshSales();
    } catch (err: any) {
      toast.error(err.message || 'Failed');
    }
  };

  if (!user) return null;

  // D-5.1: an unscoped platform session, and any role the commerce contract
  // excludes, gets no tenant commerce screen and issues no request for one.
  if (!mayWork) {
    return (
      <AccessDenied
        title={t('Sales are not part of your access')}
        reason={t('You do not have access to this company’s sales.')}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('Sales')}</h2>
          <p className="text-xs text-slate-500 mt-1">{t('Orders placed by your website visitors')}</p>
        </div>
          <div className="flex items-center gap-2">
            <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
              <option value="">{t('All Statuses')}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>{STATUS_ES[s]}</option>
              ))}
            </Select>
            <Button size="sm" tooltip={t('Record a sale agreed by phone or in person')} onClick={() => setSaleOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> {t('Add Sale')}
            </Button>
          </div>
      </div>

      <Modal open={saleOpen} title={t('Add Sale')} onClose={() => setSaleOpen(false)}>
        <div className="space-y-4">
          {saleTarget.showPicker && (
            <Select
              label={t('Branch')}
              id="sale-branch"
              data-testid="branch-target-picker"
              value={saleTargetStoreId ?? ''}
              onChange={(e) => setSale({ ...sale, storeId: e.target.value })}
            >
              <option value="">—</option>
              {saleTarget.options.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          )}
          {saleTarget.state === 'single' && (
            <p className="text-xs text-slate-500" data-testid="branch-target-single">
              {t('Branch')}: <span className="font-semibold text-slate-700">{saleTarget.resolvedName}</span>
            </p>
          )}
          {saleTarget.invalidated && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2" role="alert" data-testid="branch-target-invalidated">
              {t('The branch that was selected is no longer available. Choose a branch.')}
            </p>
          )}
          {saleTarget.state === 'choose' && !saleTarget.invalidated && saleTargetStoreId === null && (
            <p className="text-xs text-slate-500" data-testid="branch-target-choose">{t('Choose a branch')}</p>
          )}
          {saleTarget.state === 'none' && (
            <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md p-2" role="alert" data-testid="branch-target-none">
              {t('This company has no active branch.')} {t('A sale needs an active branch; nothing will be sent.')}
            </p>
          )}
          {saleTarget.state === 'loading' && (
            <p className="text-xs text-slate-400" data-testid="branch-target-loading">{t('Loading…')}</p>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Input
              label={t('Customer (optional)')}
              value={sale.customerName}
              onChange={(e) => setSale({ ...sale, customerName: e.target.value })}
            />
            <Input
              label={t('Phone (optional)')}
              placeholder="+58 412 1234567"
              value={sale.customerPhone}
              onChange={(e) => setSale({ ...sale, customerPhone: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <div className="grid grid-cols-[1fr_64px_24px] gap-2 text-[10px] font-semibold text-slate-500 uppercase">
              <span>{t('Item')}</span>
              <span>{t('Qty')}</span>
              <span />
            </div>
            {sale.rows.map((row, i) => (
              <div key={i} className="grid grid-cols-[1fr_64px_24px] gap-2 items-center">
                <Select
                  value={row.productId}
                  onChange={(e) => setSale({ ...sale, rows: sale.rows.map((r, j) => (j === i ? { ...r, productId: e.target.value } : r)) })}
                >
                  <option value="">—</option>
                  {catalog.map((prd) => (
                    <option key={prd.id} value={prd.id}>
                      {prd.name} (${prd.salePrice && Number(prd.salePrice) < Number(prd.price) ? prd.salePrice : prd.price})
                    </option>
                  ))}
                </Select>
                <input
                  type="number"
                  min={1}
                  value={row.quantity}
                  onChange={(e) => setSale({ ...sale, rows: sale.rows.map((r, j) => (j === i ? { ...r, quantity: parseInt(e.target.value, 10) || 1 } : r)) })}
                  className="px-2 py-1.5 border border-line rounded-lg text-xs focus:outline-none focus:border-primary"
                />
                <button
                  className="text-slate-300 hover:text-danger text-sm"
                  aria-label={t('Remove row')}
                  onClick={() => setSale({ ...sale, rows: sale.rows.filter((_, j) => j !== i) })}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              className="text-xs font-semibold text-primary hover:underline"
              onClick={() => setSale({ ...sale, rows: [...sale.rows, { productId: '', quantity: 1 }] })}
            >
              + {t('Add row')}
            </button>
          </div>
          <p className="text-xs text-slate-400">{t('Prices come from the catalog automatically — sale prices apply when set.')}</p>
          <div className="flex justify-end gap-2 pt-3 border-t border-slate-100">
            <Button variant="secondary" onClick={() => setSaleOpen(false)}>{t('Cancel')}</Button>
            <Button isLoading={saleBusy} onClick={submitSale} disabled={saleBranchBlocked} data-testid="sale-submit">
              {t('Record sale')}
            </Button>
          </div>
        </div>
      </Modal>

      {loading ? (
        <div className="text-slate-500 text-sm">{t('Loading…')}</div>
      ) : orders.length === 0 ? (
        <div className="card p-10 border border-slate-200 shadow-sm bg-white text-center space-y-2">
          <ShoppingBag className="h-8 w-8 mx-auto text-slate-300" />
          <p className="text-sm text-slate-500">{t('No orders yet — they appear here the moment a visitor checks out.')}</p>
        </div>
      ) : (
        <Table>
          <THead>
            <TH>{t('Order')}</TH>
            <TH>{t('Date')}</TH>
            {showBranchColumn && <TH>{t('Branch')}</TH>}
            <TH>{t('Customer')}</TH>
            <TH>{t('Items')}</TH>
            <TH align="right">{t('Total')}</TH>
            <TH>{t('Status')}</TH>
            <TH align="right">{t('Actions')}</TH>
          </THead>
          <TBody>
            {orders.map((o) => (
              <React.Fragment key={o.id}>
                <TR>
                  <TD className="font-mono text-xs font-bold text-primary">#{o.orderNumber}</TD>
                  <TD className="text-xs text-slate-500">{new Date(o.createdAt).toLocaleString()}</TD>
                  {showBranchColumn && <TD className="text-xs">{o.store?.name}</TD>}
                  <TD className="text-sm">
                    {o.customerName || <span className="italic text-slate-400">—</span>}
                    {o.customerPhone && <div className="text-[10px] text-slate-400">{o.customerPhone}</div>}
                  </TD>
                  <TD>
                    <button className="text-xs text-primary hover:underline" onClick={() => setExpanded(expanded === o.id ? null : o.id)}>
                      {o.items.length} {t('items')}
                    </button>
                  </TD>
                  <TD align="right" className="font-bold">${o.totalUsd}</TD>
                  <TD><Badge variant={STATUS_BADGE[o.status] || 'neutral'}>{STATUS_ES[o.status] || o.status}</Badge></TD>
                  <TD align="right">
                    <div className="inline-flex items-center gap-2">
                      <Select
                        value={o.status}
                        onChange={(e) => changeStatus(o.id, e.target.value)}
                        className="w-36 inline-block"
                      >
                        {STATUSES.map((s) => (
                          <option key={s} value={s}>{STATUS_ES[s]}</option>
                        ))}
                      </Select>
                    </div>
                  </TD>
                </TR>
                {expanded === o.id && (
                  <TR className="bg-slate-50">
                    <td colSpan={showBranchColumn ? 8 : 7} className="px-4 py-2">
                      <div className="text-xs text-slate-600 space-y-1 py-1">
                        {o.items.map((item: any, idx: number) => (
                          <div key={idx} className="flex justify-between max-w-md">
                            <span>
                              {item.quantity}× {item.productName}
                              {item.variantName && <span className="text-slate-400"> · {item.variantName}</span>}
                            </span>
                            <span className="font-semibold">${(Number(item.unitPriceUsd) * item.quantity).toFixed(2)}</span>
                          </div>
                        ))}
                        {Number(o.discountUsd) > 0 && (
                          <div className="flex justify-between max-w-md text-emerald-700 border-t border-slate-100 pt-1 mt-1">
                            <span>{t('Discount')} {o.discountCode ? `(${o.discountCode})` : ''}</span>
                            <span className="font-semibold">−${Number(o.discountUsd).toFixed(2)}</span>
                          </div>
                        )}
                      </div>
                    </td>
                  </TR>
                )}
              </React.Fragment>
            ))}
          </TBody>
        </Table>
      )}
      {
        <div className="flex justify-end">
          <Button variant="secondary" size="sm" tooltip={t('Reload the list')} onClick={refreshSales}>{t('Refresh')}</Button>
        </div>
      }
    </div>
  );
}
