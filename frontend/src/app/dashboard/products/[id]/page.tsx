'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, ExternalLink, ImageIcon } from 'lucide-react';
import { useAuth } from '../../../../lib/auth';
import { canManageCatalogue } from '../../../../lib/permissions';
import { useT } from '../../../../lib/i18n';
import Button from '../../../../components/ui/button';
import Badge from '../../../../components/ui/badge';
import { FamilyRoleBadge } from '../../../../features/products/family-role';
import { useStores } from '../../../../lib/use-website-config';
import ProductSpecificationsPanel from '../../../../features/products/components/product-specifications-panel';
import ProductRelatedPanel from '../../../../features/products/components/product-related-panel';
import ProductBranchPanel from '../../../../features/products/components/product-branch-panel';
import ProductTranslationsPanel from '../../../../features/products/components/product-translations-panel';
import ProductInventoryCard from '../../../../features/inventory/components/product-inventory-card';
import ProductFamilyPanel, { familyRoleOf } from '../../../../features/products/components/product-family-panel';
import { useProductDetail } from '../../../../features/products/product-detail-query';

const fmtMoney = (val?: number | null) =>
  val === null || val === undefined ? '—' : `$${Number(val).toFixed(2)}`;
const fmtDate = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '—');

function actionBadgeVariant(action: string): 'success' | 'warning' | 'danger' | 'info' | 'neutral' {
  if (action === 'CREATE') return 'success';
  if (action === 'UPDATE') return 'warning';
  if (action.includes('ARCHIVE') || action === 'DEACTIVATE') return 'danger';
  if (action.includes('RESTORE') || action === 'REACTIVATE') return 'info';
  return 'neutral';
}

/** Read-only page with everything about one item: current details + history. */
export default function ProductDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, scope, accessToken } = useAuth();
  const t = useT();
  // Set by the family panel after a join, and held here across the reload
  // that unmounts it (see `ProductFamilyPanel`'s `focusHeading`).
  const [focusFamilyHeading, setFocusFamilyHeading] = useState(false);
  const { stores: companyStores } = useStores();
  const detailQuery = useProductDetail(accessToken, scope?.organizationId, scope?.storeId, id);
  const product = detailQuery.data?.product ?? null;
  const history = detailQuery.data?.history ?? null;
  const family = detailQuery.data?.family ?? null;
  const definitions = detailQuery.data?.definitions ?? [];
  const effective = detailQuery.data?.effective ?? [];
  const relations = detailQuery.data?.relations ?? [];
  const loading = detailQuery.isPending;
  const error = detailQuery.error instanceof Error && detailQuery.error.message !== 'ITEM_NOT_FOUND'
    ? detailQuery.error.message
    : null;

  // P5-A2 family 4: editing an item and its photos is catalogue authority,
  // read from the resolved scope.
  const canManage = canManageCatalogue(scope);

  const refresh = () => void detailQuery.refetch();

  if (!user) return null;
  if (loading) return <div className="text-slate-500 text-sm">{t('Loading…')}</div>;
  if (error || !product) {
    return (
      <div className="space-y-4">
        <Link href="/dashboard/products" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> {t('Back to items')}
        </Link>
        <div className="card p-8 text-center text-sm text-slate-500">{error || t('Item not found')}</div>
      </div>
    );
  }

  const activeImages = (product.images || []).filter((img) => !img.archivedAt);
  const cover = activeImages.find((img) => img.isPrimary) || activeImages[0];
  const stores = product.stores || [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Link href="/dashboard/products" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
          <ArrowLeft className="h-4 w-4" /> {t('Back to items')}
        </Link>
        {canManage && !product.archivedAt && (
          <Button size="sm" tooltip={t('Edit name, price, stock, images and child products')} onClick={() => router.push(`/dashboard/products?edit=${product.id}`)}>
            {t('Edit')}
          </Button>
        )}
      </div>

      {/* Header */}
      <div className="card p-6 flex gap-5 items-start flex-wrap">
        {cover ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover.url} alt={cover.altText || product.name} className="h-28 w-28 rounded-xl object-cover border border-line" />
        ) : (
          <div className="h-28 w-28 rounded-xl bg-slate-100 border border-line flex items-center justify-center">
            <ImageIcon className="h-8 w-8 text-slate-300" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-bold text-slate-800">{product.name}</h2>
            {product.status === 'PUBLISHED' ? (
              <Badge variant="success">{t('Published')}</Badge>
            ) : product.status === 'ARCHIVED' ? (
              <Badge variant="danger">{t('Archived')}</Badge>
            ) : (
              <Badge variant="neutral">{t('Draft')}</Badge>
            )}
            {product.archivedAt && <Badge variant="danger">{t('Archived')}</Badge>}
            {/* The role, stated. It used to be inferable only from the
                "Not purchasable" consequence or a child link — and a standalone
                item carried nothing at all. */}
            <FamilyRoleBadge product={product} t={t} />
            {familyRoleOf(product) === 'PARENT' && (
              <Badge variant="warning" data-testid="detail-not-purchasable">
                {t('Not purchasable — its child products carry the stock and price')}
              </Badge>
            )}
            {typeof product.parent === 'object' && product.parent?.name && (
              <Link
                href={`/dashboard/products/${product.parent.id}`}
                className="text-xs text-primary underline hover:no-underline"
              >
                {t('Child of {parent}', { parent: product.parent.name })}
              </Link>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {t('Categories')}: {product.categories?.map((c) => c.name).join(', ') || '—'} · SKU:{' '}
            {product.sku || '—'} ·{' '}
            <span className="font-mono">{product.slug}</span>
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-4">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">{t('Price')}</p>
              <p className="text-lg font-bold text-slate-800">{fmtMoney(product.price)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">{t('Sale Price')}</p>
              <p className="text-lg font-bold text-emerald-700">{fmtMoney(product.salePrice)}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">{t('Stock')}</p>
              <p className="text-lg font-bold text-slate-800">
                {product.trackInventory ? product.stockQuantity ?? 0 : t('Untracked')}
              </p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-slate-400">{t('Websites')}</p>
              <p className="text-lg font-bold text-slate-800">{stores.length}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Description */}
      <div className="card p-6">
        <h3 className="text-sm font-bold text-slate-800 mb-2">{t('Description')}</h3>
        <p className="text-sm text-slate-600 whitespace-pre-wrap">{product.description || t('No description.')}</p>
      </div>

      {/* Photos */}
      <div className="card p-6">
        <h3 className="text-sm font-bold text-slate-800 mb-3">{t('Photos')}</h3>
        {activeImages.length === 0 ? (
          // A WARNING, not a neutral empty state: an item without a photo
          // renders as a grey placeholder on every website that shows it.
          <p className="text-xs text-amber-700" data-testid="missing-photo-warning" role="status">
            {t('This item has no photo — websites showing it render a placeholder instead of the product.')}
          </p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-8 gap-3">
            {activeImages.map((img) => (
              <div key={img.id} className="relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={img.url} alt={img.altText || product.name} className="h-20 w-full rounded-lg object-cover border border-line" />
                {img.isPrimary && (
                  <span className="absolute top-1 left-1 rounded-full bg-primary text-white text-[9px] font-bold px-1.5 py-0.5">
                    {t('Primary')}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* P5-W4 capability 1: specification groups, effective values, overrides */}
      <ProductSpecificationsPanel
        productId={product.id}
        role={familyRoleOf(product)}
        accessToken={accessToken}
        scope={scope}
        definitions={definitions}
        effective={effective}
        onChanged={refresh}
      />

      {/* P5-W4 capability 2: documents and related products (the gallery is
          edited from the catalogue LIST's images modal, which owns the upload
          flow — the item form has never carried it) */}
      <ProductRelatedPanel
        productId={product.id}
        accessToken={accessToken}
        scope={scope}
        relations={relations}
        onChanged={refresh}
      />

      {/* P5-W4 capability 3: parent and child administration */}
      <ProductFamilyPanel
        product={product}
        family={family}
        accessToken={accessToken}
        scope={scope}
        onChanged={refresh}
        focusHeading={focusFamilyHeading}
        onFocusHeadingChange={setFocusFamilyHeading}
      />

      {/* P5-W4 capability 4: everything a BRANCH owns, kept separate from the
          company-owned information above */}
      <ProductBranchPanel
        product={product}
        stores={companyStores}
        accessToken={accessToken}
        scope={scope}
        onChanged={refresh}
      />

      {/* Phase 8: the ledger's own answer for THIS item — owned, sellable, and
          what is holding the difference back. The branch panel above says what
          each branch holds; this says what any of it can actually do. */}
      <ProductInventoryCard productId={product.id} accessToken={accessToken} scope={scope} />

      {/* Phase 8: the Spanish-first copy and its translations, one record per
          product (ADR 016 §2) — never a second product for a second language */}
      <ProductTranslationsPanel product={product} accessToken={accessToken} scope={scope} onChanged={refresh} />

      {/* History (admins only — API hides it from other roles) */}
      {history !== null && (
        <div className="card p-6">
          <h3 className="text-sm font-bold text-slate-800 mb-3">{t('History')}</h3>
          {history.length === 0 ? (
            <p className="text-xs text-slate-400">{t('No changes recorded yet.')}</p>
          ) : (
            <ul className="space-y-3">
              {history.map((entry) => (
                <li key={entry.id} className="flex items-start gap-3 text-sm">
                  <Badge variant={actionBadgeVariant(entry.action)} className="mt-0.5 shrink-0">
                    {entry.action}
                  </Badge>
                  <div className="min-w-0">
                    <p className="text-slate-700">{entry.description || entry.action}</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {entry.actorEmail || '—'} · {fmtDate(entry.createdAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
