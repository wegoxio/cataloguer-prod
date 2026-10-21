'use client';

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import Badge from '../../../components/ui/badge';
import { useT } from '../../../lib/i18n';
import type { ProductStock } from '../inventory-api';

function StockCell({ label, value, tone, hint }: { label: string; value: number; tone?: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-white px-3 py-2">
      <p className="text-[10px] font-semibold text-slate-500 uppercase">{label}</p>
      <p className={`text-lg font-bold tabular-nums ${tone ?? 'text-slate-800'}`}>{value}</p>
      {hint && <p className="text-[10px] text-slate-400 leading-tight mt-0.5">{hint}</p>}
    </div>
  );
}

/**
 * What a product's stock IS, in the terms an operator argues about.
 *
 * The panel used to show one number — the units a branch holds — beside the
 * literal words "Worked out from the ledger" where the sellable figure
 * belonged. That is the number that matters most, because it is what a
 * customer can actually buy, and it is routinely LOWER than the shelf: units
 * can be reserved for someone, committed to a transfer, travelling, or damaged
 * and not yet reclassified. Showing the shelf alone invites promising stock
 * that cannot ship.
 *
 * Each bucket is therefore named and shown separately, and the difference
 * between owned and sellable is stated rather than left to be inferred.
 */
export default function StockBreakdown({ stock }: { stock: ProductStock }) {
  const t = useT();
  const withheld = stock.reserved + stock.transferCommitted + stock.inTransit + stock.nonSellable;
  const allocated = stock.perStore.reduce((sum, row) => sum + row.held, 0);
  // A remainder that cannot be explained by the buckets is worth saying out
  // loud: it means a projection disagrees, and an operator should look.
  const unexplained = stock.organizationTotal - allocated - stock.warehouseRemainder;

  return (
    <section className="space-y-3" data-testid="stock-breakdown">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <StockCell
          label={t('Owned by the company')}
          value={stock.organizationTotal}
          hint={t('Everywhere, including units in transit')}
        />
        <StockCell
          label={t('Sellable now')}
          value={stock.sellable}
          tone="text-emerald-700"
          hint={t('What a customer can actually buy')}
        />
        <StockCell label={t('In the warehouse')} value={stock.warehouseRemainder} hint={t('Not yet allocated to a branch')} />
        <StockCell
          label={t('Held back')}
          value={withheld}
          tone={withheld > 0 ? 'text-amber-700' : undefined}
          hint={t('Reserved, committed, travelling or not sellable')}
        />
      </div>

      {withheld > 0 && (
        <div className="flex flex-wrap gap-2" data-testid="withheld-buckets">
          {stock.reserved > 0 && <Badge variant="warning">{t('Reserved')}: {stock.reserved}</Badge>}
          {stock.transferCommitted > 0 && (
            <Badge variant="warning">{t('Committed to a transfer')}: {stock.transferCommitted}</Badge>
          )}
          {stock.inTransit > 0 && <Badge variant="info">{t('In transit')}: {stock.inTransit}</Badge>}
          {stock.nonSellable > 0 && (
            <Badge variant="danger">{t('Damaged or not sellable')}: {stock.nonSellable}</Badge>
          )}
        </div>
      )}

      <div>
        <p className="text-[10px] font-semibold text-slate-500 uppercase mb-1">{t('Per branch')}</p>
        {stock.perStore.length === 0 ? (
          <p className="text-xs text-slate-400">{t('No branch holds this item yet.')}</p>
        ) : (
          <ul className="divide-y divide-slate-100 border border-slate-100 rounded-lg overflow-hidden">
            {stock.perStore.map((row) => (
              <li key={row.storeId} className="flex items-center justify-between px-3 py-2 text-sm bg-white">
                <span className="text-slate-700">{row.storeName}</span>
                <span className="font-semibold tabular-nums text-slate-800">{row.held}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {unexplained !== 0 && (
        <p
          className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-3 py-2"
          role="status"
          data-testid="reconciliation-warning"
        >
          <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            {t(
              'The branch allocations and the warehouse do not add up to the company total. {n} unit(s) are somewhere else — usually in transit. Check the movements below before adjusting anything.',
              { n: String(unexplained) },
            )}
          </span>
        </p>
      )}
    </section>
  );
}
