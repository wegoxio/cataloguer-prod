'use client';

import React from 'react';
import Link from 'next/link';
import { useT } from '../../../lib/i18n';
import { canViewInventory, type SessionScope } from '../../../lib/permissions';
import StockBreakdown from './stock-breakdown';
import { useInventoryStock } from '../inventory-queries';

/**
 * The ledger's answer for one item, on the item's own page.
 *
 * The branch panel beside this says what each branch HOLDS, which is the
 * number an operator changes. This says what the company owns and what can
 * actually be sold, which is the number a customer meets — and until Phase 8
 * the second was a placeholder string, so the two could disagree silently.
 *
 * A role without inventory access sees nothing here rather than an empty
 * card: the absence is the honest answer, and the routes refuse it anyway.
 */
export default function ProductInventoryCard({
  productId,
  accessToken,
  scope,
}: {
  productId: string;
  accessToken: string | null;
  scope: SessionScope | null | undefined;
}) {
  const t = useT();
  const mayView = canViewInventory(scope);
  const stockQuery = useInventoryStock(
    accessToken,
    scope?.organizationId,
    scope?.storeId,
    productId,
    mayView,
  );
  const stock = stockQuery.data ?? null;

  if (!mayView) return null;

  return (
    <div className="card p-6 space-y-3" data-testid="product-inventory-card">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-bold text-slate-800">{t('Stock')}</h3>
        <Link href="/dashboard/inventory" className="text-xs text-primary hover:underline">
          {t('Inventory operations')}
        </Link>
      </div>
      {stockQuery.isError ? (
        <p className="text-xs text-slate-400">{t('The stock figures could not be read just now.')}</p>
      ) : stock ? (
        <StockBreakdown stock={stock} />
      ) : (
        <p className="text-xs text-slate-400">{t('Reading the ledger…')}</p>
      )}
    </div>
  );
}
