'use client';

import React from 'react';
import Button from '../../../components/ui/button';
import Badge from '../../../components/ui/badge';
import Input from '../../../components/ui/input';
import { useToast } from '../../../components/ui/toast';
import { useT } from '../../../lib/i18n';
import { apiFetch } from '../../../lib/api-client';
import { canActOnAllowedStore, canManageCatalogue, type SessionScope } from '../../../lib/permissions';
import type { Product } from '../types/product.types';
import type { StoreRecord } from '../../../lib/use-website-config';

/**
 * WHAT EACH BRANCH OWNS about a product (P5-W4, capability 4).
 *
 * Named once, in the order the roadmap names them, so the panel and the tests
 * cannot drift from the contract: price, sale price, allocation (the branch's
 * own units), publication, availability, inventory tracking and lead time.
 * Everything NOT in this list — name, description, SKU, manufacturer code,
 * specifications, documents, relations, categories, family membership — is
 * owned by the COMPANY and is the same in every branch.
 */
export const STORE_OWNED_FIELDS = [
  'price',
  'salePrice',
  'stockQuantity',
  'published',
  'availableQuantity',
  'trackInventory',
  'leadTimeDays',
] as const;

export interface BranchRow {
  storeId: string;
  storeName: string;
  linked: boolean;
  published: boolean;
  /** Null means "this branch uses the company's base price". */
  price: number | null;
  salePrice: number | null;
  stockQuantity: number;
  trackInventory: boolean;
  leadTimeDays: number | null;
}

/**
 * One row per branch of the company, whether or not the product is in it.
 *
 * A branch with no link is shown as NOT LINKED rather than omitted: "this
 * product is absent from Outlet" is exactly the fact an operator needs, and a
 * panel that only listed linked branches made absence invisible.
 */
export function toBranchRows(product: Product, stores: StoreRecord[]): BranchRow[] {
  const links = product.branchLinks ?? [];
  const linkFor = (storeId: string) =>
    links.find((link) => (typeof link.store === 'string' ? link.store : link.store.id) === storeId) ?? null;

  return stores
    .filter((store) => !store.archivedAt)
    .map((store) => {
      const link = linkFor(store.id);
      return {
        storeId: store.id,
        storeName: store.name,
        linked: link !== null,
        published: Boolean(link?.published),
        price: link?.price ?? null,
        salePrice: link?.salePrice ?? null,
        stockQuantity: link?.stockQuantity ?? 0,
        trackInventory: Boolean(link?.trackInventory),
        leadTimeDays: (link as { leadTimeDays?: number | null } | null)?.leadTimeDays ?? null,
      };
    });
}

export interface ProductBranchPanelProps {
  product: Product;
  stores: StoreRecord[];
  accessToken: string | null;
  scope: SessionScope | null | undefined;
  onChanged?: () => void;
}

/**
 * The branch half of a product (P5-W4, capability 4).
 *
 * This panel exists because the two halves were mixed: one form showed a
 * company-wide name beside a "stock quantity" that belongs to one branch, and
 * nothing said which was which. Stock is never shared between branches, a
 * price may be overridden per branch, and publication is per branch — reading
 * any of those as company-wide is how somebody publishes to a website they did
 * not mean to.
 *
 * AVAILABILITY IS SHOWN AND NEVER EDITED. `availableQuantity` is derived from
 * the ledger (owned minus reserved, transfer-committed, in transit and
 * non-sellable), so offering a field for it would invite an edit that cannot
 * exist. Allocation is changed by moving stock, not by typing a different
 * number into the derived figure.
 *
 * AUTHORITY: `canManageCatalogue` says WHO may edit, and
 * `canActOnAllowedStore` says WHICH BRANCH may be named — the same pair the
 * server applies with `assertProductInOrganization` plus
 * `resolveStoresInScope`. A narrowed actor sees its siblings' rows read-only
 * rather than not at all, because "the Outlet holds four" is information its
 * own branch legitimately needs.
 */
export default function ProductBranchPanel({ product, stores, accessToken, scope, onChanged }: ProductBranchPanelProps) {
  const t = useT();
  const toast = useToast();
  const canManage = canManageCatalogue(scope);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Record<string, { price: string; salePrice: string; leadTimeDays: string }>>(
    {},
  );

  const rows = React.useMemo(() => toBranchRows(product, stores), [product, stores]);

  const editableHere = (storeId: string) => canManage && canActOnAllowedStore(scope, storeId);

  const patchBranch = async (storeId: string, body: Record<string, unknown>) => {
    // The handler asks both questions again. A row rendered read-only can
    // still be reached; the server refuses either way.
    if (!editableHere(storeId) || !accessToken) {
      toast.error(t('You do not have permission to do this.'));
      return;
    }
    setBusy(storeId);
    try {
      await apiFetch(`/products/${product.id}/stores/${storeId}`, {
        method: 'PUT',
        token: accessToken,
        body: JSON.stringify(body),
      });
      toast.success(t('Branch settings saved'));
      onChanged?.();
    } catch (err: any) {
      toast.error(err?.message || t('Could not save the branch settings'));
    } finally {
      setBusy(null);
    }
  };

  const unlink = async (storeId: string) => {
    if (!editableHere(storeId) || !accessToken) {
      toast.error(t('You do not have permission to do this.'));
      return;
    }
    setBusy(storeId);
    try {
      await apiFetch(`/products/${product.id}/stores/${storeId}`, { method: 'DELETE', token: accessToken });
      toast.success(t('Removed from this branch'));
      onChanged?.();
    } catch (err: any) {
      toast.error(err?.message || t('Could not remove it from the branch'));
    } finally {
      setBusy(null);
    }
  };

  const draftFor = (row: BranchRow) =>
    draft[row.storeId] ?? {
      price: row.price === null ? '' : String(row.price),
      salePrice: row.salePrice === null ? '' : String(row.salePrice),
      leadTimeDays: row.leadTimeDays === null ? '' : String(row.leadTimeDays),
    };

  const setDraftField = (storeId: string, field: 'price' | 'salePrice' | 'leadTimeDays', value: string) =>
    setDraft((current) => {
      const row = rows.find((candidate) => candidate.storeId === storeId) as BranchRow;
      const base = current[storeId] ?? draftFor(row);
      return { ...current, [storeId]: { ...base, [field]: value } };
    });

  return (
    <div className="card p-6" data-testid="branch-panel">
      <h3 className="text-sm font-bold text-slate-800 mb-1">{t('Set by each branch')}</h3>
      <p className="text-xs text-slate-500 mb-4">
        {t(
          'Price, sale price, units held, publication, inventory tracking and lead time belong to ONE branch and are never shared. What is sellable right now is worked out from the ledger and is shown, not typed.',
        )}
      </p>

      {rows.length === 0 ? (
        <p className="text-xs text-slate-400">{t('This company has no active branches yet.')}</p>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => {
            const editable = editableHere(row.storeId);
            const values = draftFor(row);
            return (
              <div
                key={row.storeId}
                className="p-3 rounded-md border border-slate-100"
                data-testid={`branch-row-${row.storeId}`}
              >
                <div className="flex items-center gap-2 flex-wrap mb-2">
                  <span className="text-xs font-semibold text-slate-800">{row.storeName}</span>
                  {!row.linked ? (
                    <Badge variant="neutral">{t('Not in this branch')}</Badge>
                  ) : row.published ? (
                    <Badge variant="success">{t('Published here')}</Badge>
                  ) : (
                    <Badge variant="neutral">{t('Hidden here')}</Badge>
                  )}
                  {!editable && <Badge variant="neutral">{t('Read only')}</Badge>}
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                  <div>
                    <p className="text-[10px] uppercase text-slate-400">{t('Units held here')}</p>
                    <p className="font-semibold text-slate-800" data-testid={`branch-stock-${row.storeId}`}>
                      {row.trackInventory ? row.stockQuantity : t('Untracked')}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase text-slate-400">{t('Sellable now')}</p>
                    {/* The number itself lives in the Stock card below, which
                        reads the ledger for the whole item. Naming the figure
                        here without it invited the two to disagree, so this
                        says where the answer is instead of pretending to be it. */}
                    <p className="text-[11px] text-slate-400" data-testid={`branch-available-${row.storeId}`}>
                      {t('See Stock, below')}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase text-slate-400">{t('Inventory tracking')}</p>
                    <p className="font-semibold text-slate-800">{row.trackInventory ? t('On') : t('Off')}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase text-slate-400">{t('Lead time (days)')}</p>
                    <p className="font-semibold text-slate-800">
                      {row.leadTimeDays === null ? t('Not stated') : row.leadTimeDays}
                    </p>
                  </div>
                </div>

                {editable && row.linked && (
                  <div className="mt-3 pt-3 border-t border-slate-100 flex items-end gap-2 flex-wrap">
                    <Input
                      label={t('Branch price')}
                      aria-label={`${row.storeName} ${t('Branch price')}`}
                      data-testid={`branch-price-${row.storeId}`}
                      type="number"
                      step="0.01"
                      placeholder={t('Company base price')}
                      className="max-w-[140px]"
                      value={values.price}
                      onChange={(e) => setDraftField(row.storeId, 'price', e.target.value)}
                    />
                    <Input
                      label={t('Branch sale price')}
                      aria-label={`${row.storeName} ${t('Branch sale price')}`}
                      data-testid={`branch-sale-${row.storeId}`}
                      type="number"
                      step="0.01"
                      placeholder={t('No sale')}
                      className="max-w-[140px]"
                      value={values.salePrice}
                      onChange={(e) => setDraftField(row.storeId, 'salePrice', e.target.value)}
                    />
                    <Input
                      label={t('Lead time (days)')}
                      aria-label={`${row.storeName} ${t('Lead time (days)')}`}
                      data-testid={`branch-lead-${row.storeId}`}
                      type="number"
                      placeholder={t('Not stated')}
                      className="max-w-[120px]"
                      value={values.leadTimeDays}
                      onChange={(e) => setDraftField(row.storeId, 'leadTimeDays', e.target.value)}
                    />
                    <Button
                      size="sm"
                      isLoading={busy === row.storeId}
                      data-testid={`branch-save-${row.storeId}`}
                      onClick={() =>
                        patchBranch(row.storeId, {
                          price: values.price === '' ? null : Number(values.price),
                          salePrice: values.salePrice === '' ? null : Number(values.salePrice),
                          leadTimeDays: values.leadTimeDays === '' ? null : Number(values.leadTimeDays),
                        })
                      }
                    >
                      {t('Save')}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      data-testid={`branch-publish-${row.storeId}`}
                      onClick={() => patchBranch(row.storeId, { published: !row.published })}
                    >
                      {row.published ? t('Hide here') : t('Publish here')}
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      data-testid={`branch-tracking-${row.storeId}`}
                      onClick={() => patchBranch(row.storeId, { trackInventory: !row.trackInventory })}
                    >
                      {row.trackInventory ? t('Stop tracking here') : t('Track inventory here')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      data-testid={`branch-unlink-${row.storeId}`}
                      onClick={() => unlink(row.storeId)}
                    >
                      {t('Remove from branch')}
                    </Button>
                  </div>
                )}

                {editable && !row.linked && (
                  <div className="mt-3 pt-3 border-t border-slate-100">
                    <Button
                      size="sm"
                      isLoading={busy === row.storeId}
                      data-testid={`branch-link-${row.storeId}`}
                      onClick={() => patchBranch(row.storeId, {})}
                    >
                      {t('Add to this branch')}
                    </Button>
                    <p className="text-[11px] text-slate-400 mt-1">
                      {t('It is added hidden, at the company base price, with no stock. Publishing here is a separate act.')}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
