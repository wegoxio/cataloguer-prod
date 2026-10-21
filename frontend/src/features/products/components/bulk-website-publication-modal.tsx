'use client';

import React, { useMemo, useState } from 'react';
import Modal from '../../../components/ui/modal';
import Button from '../../../components/ui/button';
import Select from '../../../components/ui/select';
import { useT } from '../../../lib/i18n';
import type { Product } from '../types/product.types';

interface BulkWebsitePublicationModalProps {
  /** The company's websites (stores); archived ones are not offered. */
  stores: { id: string; name: string; archivedAt?: string | null }[];
  /** How many products are selected, across pages. */
  selectedCount: number;
  /**
   * The selected products the page has LOADED — the current page's rows. The
   * pre-flight counts below are computed from these and say so; the server's
   * per-product outcomes are the authoritative ones.
   */
  selectedOnPage: Product[];
  /** Pre-selected when the list is already filtered to a branch. */
  initialStoreId?: string | null;
  onRun: (storeId: string, published: boolean) => Promise<void>;
  onClose: () => void;
}

const storeIdOf = (ref: string | { id: string } | undefined): string | undefined =>
  typeof ref === 'string' ? ref : ref?.id;

/**
 * "Website publication" (ADR 029): publish or hide the selection on ONE website.
 *
 * Nothing is pre-decided. There is no default website unless the list is
 * already filtered to one, and no default action — the Stores modal's habit of
 * pre-checking every branch is exactly what a bulk publication must not have.
 * The confirmation text states what changes and what does not.
 */
export default function BulkWebsitePublicationModal({
  stores,
  selectedCount,
  selectedOnPage,
  initialStoreId = null,
  onRun,
  onClose,
}: BulkWebsitePublicationModalProps) {
  const t = useT();
  const activeStores = stores.filter((store) => !store.archivedAt);
  const [storeId, setStoreId] = useState<string>(
    initialStoreId && activeStores.some((s) => s.id === initialStoreId) ? initialStoreId : '',
  );
  const [action, setAction] = useState<'publish' | 'hide' | ''>('');
  const [busy, setBusy] = useState(false);

  const website = activeStores.find((s) => s.id === storeId)?.name ?? '';

  // Advisory only, and labelled "on this page": cards are skipped by the
  // server, and non-members are reported by it. Saying so before confirming
  // means neither reads as a surprise afterwards.
  const preflight = useMemo(() => {
    const parents = selectedOnPage.filter((p) => (p.children?.length ?? 0) > 0).length;
    const notMembers = storeId
      ? selectedOnPage.filter(
          (p) =>
            (p.children?.length ?? 0) === 0 &&
            !(p.branchLinks || []).some((l) => storeIdOf(l.store) === storeId) &&
            !(p.stores || []).some((s) => s.id === storeId),
        ).length
      : 0;
    return { parents, notMembers };
  }, [selectedOnPage, storeId]);

  const ready = storeId !== '' && action !== '' && !busy;

  return (
    <Modal open title={t('Website publication')} onClose={onClose}>
      <div className="space-y-4" data-testid="website-publication-modal">
        <p className="text-xs text-slate-500">
          {t(selectedCount > 1 ? '{count} products selected' : '{count} product selected', { count: selectedCount })}
        </p>

        <Select
          label={t('Website')}
          value={storeId}
          data-testid="wp-store"
          onChange={(e) => setStoreId(e.target.value)}
        >
          <option value="">{t('Choose a website')}</option>
          {activeStores.map((store) => (
            <option key={store.id} value={store.id}>
              {store.name}
            </option>
          ))}
        </Select>

        <fieldset className="space-y-2">
          <legend className="block text-[10px] font-semibold text-slate-500 uppercase mb-1">{t('Action')}</legend>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer">
            <input
              type="radio"
              name="wp-action"
              value="publish"
              data-testid="wp-publish"
              checked={action === 'publish'}
              onChange={() => setAction('publish')}
              className="text-primary focus:ring-primary"
            />
            {t('Publish here')}
          </label>
          <label className="flex items-center gap-2 text-sm font-medium text-slate-700 cursor-pointer">
            <input
              type="radio"
              name="wp-action"
              value="hide"
              data-testid="wp-hide"
              checked={action === 'hide'}
              onChange={() => setAction('hide')}
              className="text-primary focus:ring-primary"
            />
            {t('Hide here')}
          </label>
        </fieldset>

        {storeId && action && (
          <p className="text-xs text-slate-600 rounded-md bg-slate-50 border border-slate-200 p-3" data-testid="wp-confirm-text">
            {action === 'publish'
              ? t(
                  'The selected products will be shown on {website}. Nothing else changes: store membership, branch prices, stock, lead time, other websites and the product’s global status stay as they are.',
                  { website },
                )
              : t(
                  'The selected products will be hidden on {website}. They stay assigned to it with their branch prices and stock, so you can publish them again later.',
                  { website },
                )}
          </p>
        )}

        {(preflight.parents > 0 || preflight.notMembers > 0) && (
          <ul className="text-xs text-amber-800 space-y-1" data-testid="wp-preflight">
            {preflight.parents > 0 && (
              <li data-testid="wp-preflight-parents">
                {t('On this page: {n} parent cards will be skipped', { n: preflight.parents })}
                {' — '}
                {t(
                  'A parent card is not published on its own: it appears on a website when at least one of its child products is published there. Select the child products to change what the card shows.',
                )}
              </li>
            )}
            {preflight.notMembers > 0 && (
              <li data-testid="wp-preflight-not-members">
                {t('On this page: {n} products are not on this website and will be reported, not added', {
                  n: preflight.notMembers,
                })}
              </li>
            )}
          </ul>
        )}

        <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
          <Button variant="secondary" onClick={onClose} disabled={busy} data-testid="wp-cancel">
            {t('Cancel')}
          </Button>
          <Button
            isLoading={busy}
            disabled={!ready}
            data-testid="wp-submit"
            onClick={async () => {
              if (!ready) return;
              setBusy(true);
              try {
                await onRun(storeId, action === 'publish');
              } finally {
                setBusy(false);
              }
            }}
          >
            {action === 'hide' ? t('Hide here') : t('Publish here')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
