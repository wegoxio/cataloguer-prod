'use client';

import React from 'react';
import Tooltip from '../../../components/ui/tooltip';
import { useT } from '../../../lib/i18n';
import { cn } from '../../../lib/cn';

export type BulkQuickAction = 'archive' | 'restore' | 'publish' | 'draft';
export type BulkModalType = 'category' | 'inventory' | 'pricing' | 'stores' | 'group' | 'websitePublication';

interface BulkActionsBarProps {
  count: number;
  /** Organization-wide bulk authority (P5-A2 family 4, D-4.1). */
  canManage: boolean;
  /**
   * Store re-assignment is narrower still: it is an organization-wide act, so
   * a NARROWED actor is refused (D-4.2).
   *
   * REQUIRED, and deliberately not defaulted to `canManage`: a default would
   * silently restore the broader authority the moment a future caller forgot
   * the prop, which is the failure direction this family exists to remove.
   */
  canAssignStores: boolean;
  /**
   * Bulk archive and restore (P5-A2 canonical family 7): organization
   * administrator only, and a NARROWED actor is refused — the same predicate
   * that governs archiving one product.
   *
   * REQUIRED for the same reason as `canAssignStores`: a default would restore
   * the broader authority the moment a caller forgot the prop.
   */
  canArchive: boolean;
  /**
   * Why grouping is unavailable for the current selection, or null when it is
   * available. The bar SHOWS the action either way — a reader must be able to
   * tell "this cannot be done with these items" from "this feature is gone" —
   * and states the reason when it is inert.
   */
  groupBlockedReason: string | null;
  /** A run is in flight: the controls are not offered until it ends. */
  busy?: boolean;
  onClear: () => void;
  onQuickAction: (action: BulkQuickAction) => void;
  onOpenModal: (modal: BulkModalType) => void;
}

const barButton =
  'px-3 py-1 rounded text-xs font-semibold transition-colors bg-white/10 hover:bg-white/20 text-white';

export default function BulkActionsBar({
  count,
  canManage,
  canAssignStores,
  canArchive,
  groupBlockedReason,
  busy = false,
  onClear,
  onQuickAction,
  onOpenModal,
}: BulkActionsBarProps) {
  const t = useT();

  /*
   * THE BAR MUST NOT COVER A ROW.
   *
   * It is `fixed`, so it is outside the flow and sits over whatever the
   * viewport's bottom happens to be showing — which, with the table above it,
   * is a row and its checkbox. A pointer or touch on that checkbox lands on
   * the bar instead, and there is no gesture that gets past it: scrolling does
   * not help when the document has nothing left to scroll.
   *
   * A fixed padding guess does not fix it either. It has to be the bar's OWN
   * height, because the bar wraps to two and three lines as the viewport
   * narrows and as the blocked-grouping reason appears — the very cases where
   * it covers the most.
   *
   * So the bar renders a spacer of exactly its measured footprint, in the flow,
   * at the end of the page's content. The document then always ends far enough
   * below the last row for that row to be scrolled clear, at every width and
   * for a list of any length. The spacer exists only while the bar does.
   */
  const barRef = React.useRef<HTMLDivElement | null>(null);
  const [footprint, setFootprint] = React.useState(0);
  React.useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) {
      setFootprint(0);
      return;
    }
    // 16px is the `bottom-4` offset; another 16px so the last row clears the
    // bar rather than touching it.
    const measure = () => setFootprint(Math.ceil(el.getBoundingClientRect().height) + 32);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [count, groupBlockedReason, canManage, canAssignStores, canArchive]);

  if (count === 0) return null;

  return (
    <>
      <div aria-hidden data-testid="bulk-bar-spacer" style={{ height: footprint }} />
      <div
        ref={barRef}
        data-testid="bulk-bar"
        /*
         * `rounded-full` on a box that has wrapped to a dozen lines draws a
         * circle, not a pill — which is what the bar becomes at 390px now that
         * grouping adds a button and a reason to it. The pill is kept where the
         * bar is one line and the corner radius is capped once it is not.
         */
        className="fixed bottom-4 left-1/2 -translate-x-1/2 max-w-[calc(100vw-1rem)] bg-slate-900 text-white px-6 py-3 rounded-3xl sm:rounded-full shadow-lg flex items-center gap-4 z-40"
      >
      <span className="text-xs font-semibold whitespace-nowrap">
        {/* Grouped the same way the selection summary above groups it, so the
            two numbers on screen never look like different quantities. */}
        {t(count > 1 ? '{count} products selected' : '{count} product selected', { count: count.toLocaleString() })}
      </span>
      <Tooltip content={t('Deselect all products')}><button
        data-testid="bulk-clear"
        onClick={onClear}
        className="text-xs text-slate-300 hover:text-white border-r border-slate-700 pr-4 font-semibold"
      >
        {t('Clear')}
      </button></Tooltip>
      {busy ? (
        <span className="text-xs font-semibold" role="status" data-testid="bulk-running">
          {t('Working…')}
        </span>
      ) : canManage ? (
        <div className="flex gap-1.5 flex-wrap">
          <Tooltip content={t('Make selected products visible on the website')}><button onClick={() => onQuickAction('publish')} className={barButton}>
            {t('Publish')}
          </button></Tooltip>
          <Tooltip content={t('Hide selected products from the website')}><button onClick={() => onQuickAction('draft')} className={barButton}>
            {t('Draft')}
          </button></Tooltip>
          <Tooltip content={groupBlockedReason ?? t('Group these items under one parent card')}>
            <button
              data-testid="bulk-group"
              disabled={groupBlockedReason !== null}
              aria-describedby={groupBlockedReason ? 'bulk-group-blocked' : undefined}
              onClick={() => onOpenModal('group')}
              className={cn(barButton, groupBlockedReason && 'opacity-50 cursor-not-allowed')}
            >
              {t('Group as parent and children')}
            </button>
          </Tooltip>
          {groupBlockedReason && (
            <span id="bulk-group-blocked" className="text-[10px] text-white/70" data-testid="bulk-group-blocked">
              {groupBlockedReason}
            </span>
          )}
          <Tooltip content={t('Move selected products to a category')}><button onClick={() => onOpenModal('category')} className={barButton}>
            {t('Category')}
          </button></Tooltip>
          {canAssignStores && (
            <Tooltip content={t('Choose which stores show these products')}><button onClick={() => onOpenModal('stores')} className={barButton}>
              {t('Stores')}
            </button></Tooltip>
          )}
          {canAssignStores && (
            /* Per-website publication (ADR 029): flips "Published here / Hidden
               here" on ONE website and changes nothing else. Same authority as
               Stores — it names a website, so a narrowed actor is refused. */
            <Tooltip content={t('Publish or hide the selected products on one website')}>
              <button data-testid="bulk-website-publication" onClick={() => onOpenModal('websitePublication')} className={barButton}>
                {t('Website publication')}
              </button>
            </Tooltip>
          )}
          <Tooltip content={t('Update stock for all selected products')}><button onClick={() => onOpenModal('inventory')} className={barButton}>
            {t('Inventory')}
          </button></Tooltip>
          <Tooltip content={t('Change prices for all selected products')}><button onClick={() => onOpenModal('pricing')} className={barButton}>
            {t('Pricing')}
          </button></Tooltip>
          {canArchive && (
            <>
              <Tooltip content={t('Bring archived products back to the catalog')}><button onClick={() => onQuickAction('restore')} className={barButton}>
                {t('Restore')}
              </button></Tooltip>
              <Tooltip content={t('Hide all selected products (restorable)')}><button
                onClick={() => onQuickAction('archive')}
                className={cn(barButton, 'bg-danger hover:bg-danger hover:opacity-90')}
              >
                {t('Archive')}
              </button></Tooltip>
            </>
          )}
        </div>
      ) : (
        // These act on the whole company's catalogue, so they are no longer an
        // "Admin" power (D-4.1). Plain wording, and translated like every other
        // string the panel shows.
        <span className="text-xs text-slate-400 italic">
          {t('Only organization managers can perform bulk actions.')}
        </span>
      )}
      </div>
    </>
  );
}
