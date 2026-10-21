'use client';

import React from 'react';
import Link from 'next/link';
import { ExternalLink } from 'lucide-react';
import { Table, THead, TH, TBody, TR, TD, EmptyState } from '../../../components/ui/table';
import Badge from '../../../components/ui/badge';
import { useT } from '../../../lib/i18n';
import Button from '../../../components/ui/button';
import { cn } from '../../../lib/cn';
import { labelOf, type Product as BaseProduct } from '../types/product.types';
import { familyRoleLabelFor, familyRoleOf } from '../family-role';
import type { CategoryRef } from '../../categories/types/category.types';

interface ProductImage {
  id: string;
  url: string;
  isPrimary: boolean;
  archivedAt?: string | null;
}

interface Product extends BaseProduct {
  images?: ProductImage[];
  archivedAt?: string | null;
  category?: CategoryRef | null;
}

interface ProductTableProps {
  products: Product[];
  /** Ordinary catalogue editing — SUPER_ADMIN, ORGANIZATION_MANAGER or ADMIN. */
  canManage: boolean;
  /**
   * Archive, restore and permanent delete (P5-A2 canonical family 7).
   *
   * REQUIRED, and deliberately not defaulted to `canManage`: a default would
   * silently restore the broader authority the moment a future caller forgot
   * the prop, which is the failure direction this family exists to remove.
   * The server refuses these three for a branch ADMIN and for any narrowed
   * actor, so the panel must not offer them either.
   */
  canArchive: boolean;
  /** True when a filter is narrowing the list, so an empty result means that. */
  filtered?: boolean;
  /** Offered from the true-empty state, and only to somebody who may create. */
  onAddItem?: () => void;
  /** Offered from the filtered-empty state; resets every active filter. */
  onClearFilters?: () => void;
  onEdit: (product: Product) => void;
  onArchive: (id: string) => void;
  onRestore: (id: string) => void;
  /**
   * #292: removal, not deletion. The old `onDelete` ran an irreversible
   * permanent delete and was offered only on archived rows; this is
   * recoverable and has no such precondition, so the name and the placement
   * both changed rather than one of them.
   */
  selectedProductIds: string[];
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  /** Returns the public website URL for a published product, or null when unavailable */
  websiteUrlForProduct?: (product: Product) => string | null;
  /**
   * The branch the list is filtered to, if any (ADR 029). With one, each row
   * says whether it is "Published here" or "Hidden here" ON that branch — the
   * fact a bulk website publication changes, which the global Status badge
   * does not show.
   */
  branchFilterStoreId?: string | null;
}

const storeIdOf = (ref: string | { id: string } | undefined): string | undefined =>
  typeof ref === 'string' ? ref : ref?.id;

const formatCurrency = (val?: number | null) => {
  if (val === undefined || val === null) return '-';
  return `$${Number(val).toFixed(2)}`;
};

/*
 * THE STICKY GROUP: checkbox, image and name stay put while the rest of the
 * table scrolls sideways, so a row never loses its identity.
 *
 * Every sticky cell has an OPAQUE background, because whatever scrolls under
 * it must not bleed through. Header cells paint above body cells (z-20 over
 * z-10); the tint of a selected row is translucent on the row itself, so a
 * sticky cell repaints it as an overlay that sits ABOVE its opaque background
 * and BELOW its content. The last cell of the group carries the edge line.
 */
const stickyHeader = 'sticky z-20 bg-slate-50';
const stickyCell = 'sticky z-10 bg-white group-hover:bg-slate-50';
const stickySelected = 'before:absolute before:inset-0 before:-z-10 before:bg-primary/5 before:pointer-events-none';
const stickyEdge = 'border-r border-slate-200';
/*
 * The group pins only when the scroll box can hold it AND this much room
 * beside it. A pinned block wider than its box covers every other column, and
 * nothing scrolling underneath is ever reachable — which is exactly what would
 * happen at 390px, where the fixed sidebar leaves the table about 118px. In
 * that case the columns simply scroll, as they did before the group existed.
 */
const STICKY_MIN_ROOM_PX = 160;

export default function ProductTable({
  products,
  canManage,
  canArchive,
  onEdit,
  onArchive,
  onRestore,
  selectedProductIds,
  onToggleSelect,
  onToggleSelectAll,
  websiteUrlForProduct,
  filtered = false,
  onAddItem,
  onClearFilters,
  branchFilterStoreId = null,
}: ProductTableProps) {
  const t = useT();
  /*
   * The header checkbox describes THIS PAGE by membership, never by count.
   * Comparing lengths broke the moment "all N matching" put ids from other
   * pages into the selection: every row here was selected and the box showed
   * unchecked. Some-but-not-all is a third state, said with `indeterminate`
   * (and `aria-checked="mixed"`), which only a ref can set.
   */
  const selected = new Set(selectedProductIds);
  const onPageSelected = products.filter((p) => selected.has(p.id)).length;
  const allOnPage = products.length > 0 && onPageSelected === products.length;
  const someOnPage = onPageSelected > 0 && !allOnPage;
  const headerCheckbox = React.useRef<HTMLInputElement | null>(null);
  React.useEffect(() => {
    if (headerCheckbox.current) headerCheckbox.current.indeterminate = someOnPage;
  }, [someOnPage]);

  /*
   * The sticky offsets are MEASURED, not guessed. An auto-layout table may hand
   * a column more width than its class asks for, and a hard-coded `left` would
   * then let the name column slide over the image. The header cells are the
   * source of truth; the body cells use the same numbers, so header and body
   * stay aligned by construction. Re-measured whenever either header resizes.
   */
  const checkboxHeader = React.useRef<HTMLTableCellElement | null>(null);
  const imageHeader = React.useRef<HTMLTableCellElement | null>(null);
  const nameHeader = React.useRef<HTMLTableCellElement | null>(null);
  const [stickyLeft, setStickyLeft] = React.useState({ image: 0, name: 0 });
  // On until a measurement says the box is too narrow: a DOM with no layout
  // (tests) measures zero everywhere and keeps the group, a real browser
  // decides from the scroll box it actually has.
  const [stickyOn, setStickyOn] = React.useState(true);
  // Whether the box actually scrolls sideways. Off until measured: a box that
  // fits its table is not a scroller, must not take a tab stop, and must not
  // tell a screen reader that it scrolls. Same measurement pass as the group.
  const [overflowing, setOverflowing] = React.useState(false);
  React.useLayoutEffect(() => {
    const measure = () => {
      // Fractional, never `offsetWidth`: that rounds to whole pixels, and at a
      // narrow width a column is 46.875px wide, so a rounded offset leaves a
      // sub-pixel seam between two pinned cells for a row to show through.
      const width = (cell: HTMLTableCellElement | null) => cell?.getBoundingClientRect().width ?? 0;
      const checkbox = width(checkboxHeader.current);
      const image = width(imageHeader.current);
      const name = width(nameHeader.current);
      // The scroll box is the table's parent: the `Table` wrapper.
      const box = checkboxHeader.current?.closest('table')?.parentElement ?? null;
      const room = box?.clientWidth ?? 0;
      const on = room === 0 || room >= checkbox + image + name + STICKY_MIN_ROOM_PX;
      // One pixel of tolerance: fractional column widths can leave a box a
      // sub-pixel "wider" than its table without anything to scroll to.
      const overflow = box ? box.scrollWidth > box.clientWidth + 1 : false;
      setStickyOn((current) => (current === on ? current : on));
      setOverflowing((current) => (current === overflow ? current : overflow));
      setStickyLeft((current) =>
        current.image === checkbox && current.name === checkbox + image
          ? current
          : { image: checkbox, name: checkbox + image },
      );
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    for (const cell of [checkboxHeader.current, imageHeader.current, nameHeader.current]) {
      if (cell) observer.observe(cell);
    }
    // The box for the room it offers, the table for the width it needs: a
    // language or font change widens a column the group does not include,
    // and only the table's own size says so.
    const tableElement = checkboxHeader.current?.closest('table');
    if (tableElement) observer.observe(tableElement);
    if (tableElement?.parentElement) observer.observe(tableElement.parentElement);
    return () => observer.disconnect();
  }, [products.length]);

  if (products.length === 0) {
    /*
     * TWO DIFFERENT EMPTIES, and they were one message.
     *
     * "No products found. Create your first product or adjust the filters
     * above." is said to somebody who has never added anything AND to somebody
     * whose filter is one checkbox too narrow, offers neither of them a way
     * out, and was the one empty state in the dashboard still in English.
     */
    return filtered ? (
      <EmptyState
        testId="empty-filtered"
        message={t('No items match these filters.')}
        hint={t('Widen or clear them to see the rest of your catalogue.')}
        action={
          onClearFilters ? (
            <Button size="sm" variant="secondary" data-testid="empty-clear-filters" onClick={onClearFilters}>
              {t('Clear filters')}
            </Button>
          ) : undefined
        }
      />
    ) : (
      <EmptyState
        testId="empty-catalogue"
        message={t('No items yet.')}
        hint={t('Add your first item, or a parent card with child products.')}
        action={
          // Offered only to somebody who may actually do it: the server refuses
          // creation for a reader, and an action that always fails is worse
          // than none.
          canManage && onAddItem ? (
            <Button size="sm" data-testid="empty-add-item" onClick={onAddItem}>
              {t('Add Item')}
            </Button>
          ) : undefined
        }
      />
    );
  }

  return (
    <Table
      wrapperProps={{
        // A named region always; a TAB STOP and the "scrolls" wording only
        // while there is something to scroll to. Both facts, and the sticky
        // decision, are exposed as data attributes so a browser test asserts
        // what the component decided rather than re-deriving its rule.
        role: 'region',
        'aria-label': overflowing ? t('Items table, scrolls horizontally') : t('Items table'),
        ...(overflowing ? { tabIndex: 0 } : {}),
        'data-testid': 'items-table-box',
        'data-sticky-columns': stickyOn ? 'true' : 'false',
        'data-horizontal-overflow': overflowing ? 'true' : 'false',
      }}
    >
      <THead>
        <TH ref={checkboxHeader} className={cn('w-12', stickyOn && stickyHeader, stickyOn && 'left-0')}>
          <input
            ref={headerCheckbox}
            type="checkbox"
            data-testid="select-all-on-page"
            checked={allOnPage}
            aria-checked={someOnPage ? 'mixed' : allOnPage}
            aria-label={t('Select every item on this page')}
            onChange={onToggleSelectAll}
            className="rounded text-primary focus:ring-primary"
          />
        </TH>
        <TH
          ref={imageHeader}
          className={cn('w-[4.5rem]', stickyOn && stickyHeader)}
          style={stickyOn ? { left: stickyLeft.image } : undefined}
        >
          {t('Image')}
        </TH>
        <TH
          ref={nameHeader}
          className={cn(stickyOn && stickyHeader, stickyOn && stickyEdge)}
          style={stickyOn ? { left: stickyLeft.name } : undefined}
        >
          {t('Name')}
        </TH>
        <TH>{t('Role')}</TH>
        <TH>{t('Parent item')}</TH>
        <TH>{t('Status')}</TH>
        <TH>{t('Category')}</TH>
        <TH align="right">{t('Price')}</TH>
        <TH align="right">{t('Sale Price')}</TH>
        <TH align="right">{t('Stock')}</TH>
        {(canManage || canArchive) && <TH align="center">{t('Actions')}</TH>}
      </THead>
      <TBody>
        {products.map((product) => {
          const primaryImage = product.images?.find((img) => img.isPrimary && !img.archivedAt);
          const isSelected = selectedProductIds.includes(product.id);
          return (
            <TR
              key={product.id}
              className={cn('group hover:bg-slate-50 transition-colors', isSelected && 'bg-primary/5')}
            >
              <TD className={cn(stickyOn && stickyCell, stickyOn && 'left-0', stickyOn && isSelected && stickySelected)}>
                <input
                  type="checkbox"
                  checked={isSelected}
                  // Named after the item: a column of unlabelled boxes reads as
                  // "checkbox, checkbox, checkbox" to a screen reader.
                  aria-label={t('Select {name}', { name: product.name })}
                  onChange={() => onToggleSelect(product.id)}
                  className="rounded text-primary focus:ring-primary"
                />
              </TD>
              <TD
                className={cn(stickyOn && stickyCell, stickyOn && isSelected && stickySelected)}
                style={stickyOn ? { left: stickyLeft.image } : undefined}
              >
                {primaryImage ? (
                  // Plain <img>: URLs are arbitrary external hosts; next/image
                  // optimization arrives with the P3 upload/thumbnail work.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={primaryImage.url}
                    alt={product.name}
                    className="w-10 h-10 object-cover rounded border border-slate-200"
                  />
                ) : (
                  <div className="w-10 h-10 bg-slate-100 border border-slate-200 rounded flex items-center justify-center text-[10px] text-slate-400 font-semibold select-none">
                    {t('No Image')}
                  </div>
                )}
              </TD>
              <TD
                className={cn(stickyOn && stickyCell, stickyOn && stickyEdge, stickyOn && isSelected && stickySelected)}
                style={stickyOn ? { left: stickyLeft.name } : undefined}
              >
                {/* ONLY the item's own identity lives here: its name, where it
                    is on the website, whether it is archived, and its slug. The
                    family it belongs to is a fact about the item, so it has
                    its own columns (Role, Parent item) and never wraps the
                    name. The box is capped so a long name truncates instead of
                    widening the pinned column across the viewport. */}
                <div className="max-w-[22rem] min-w-0 font-medium text-slate-900 flex items-center gap-1.5">
                  <Link
                    href={`/dashboard/products/${product.id}`}
                    className="truncate hover:text-primary hover:underline transition-colors"
                    title={product.name}
                  >
                    {product.name}
                  </Link>
                  {product.status === 'PUBLISHED' && !product.archivedAt && websiteUrlForProduct?.(product) && (
                    <a
                      href={websiteUrlForProduct(product)!}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={t('View on website')}
                      aria-label={t('View on website')}
                      className="shrink-0 text-slate-300 hover:text-primary transition-colors"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                  )}
                  {product.archivedAt && (
                    <Badge variant="danger" className="shrink-0">
                      {t('Archived')}
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-slate-400 font-mono truncate max-w-[22rem]">{product.slug}</div>
              </TD>
              <TD>
                {/* Text, not a badge: this is a column of values, and a value a
                    reader can compare down the column beats a coloured pill
                    repeated on every row. */}
                <span
                  className="text-xs text-slate-700 whitespace-nowrap"
                  data-testid={`family-role-${product.id}`}
                  data-role={familyRoleOf(product)}
                >
                  {familyRoleLabelFor(product, t)}
                </span>
                {familyRoleOf(product) === 'PARENT' && (
                  /* A parent is the card, never the sale: the row shows a price
                     and a stock figure its children carry, so the fact that IT
                     cannot be bought must be said — and it belongs beside the
                     role that causes it. */
                  <div
                    className="text-[10px] text-amber-700 whitespace-nowrap"
                    data-testid={`not-purchasable-${product.id}`}
                  >
                    {t('Not purchasable')}
                  </div>
                )}
              </TD>
              <TD>
                {(() => {
                  /* Which family a child belongs to, and the option it is sold
                     under. A standalone item and a parent card have no parent,
                     and say so with a dash a screen reader can name rather than
                     an empty cell it would skip. */
                  const parentRef = product.parent;
                  const parentId = typeof parentRef === 'string' ? parentRef : parentRef?.id;
                  const parentName = typeof parentRef === 'object' ? parentRef?.name : undefined;
                  if (familyRoleOf(product) !== 'CHILD' || !parentId) {
                    return (
                      // `relative` is load-bearing: `sr-only` is absolutely
                      // positioned, and without a positioned ancestor INSIDE
                      // the scroll box its containing block is the page, so it
                      // escapes the wrapper's clipping and widens the document
                      // to wherever this cell sits — a phantom overflow at
                      // narrow widths. Anchored here, it is clipped with the
                      // table like everything else in the cell.
                      <span data-testid={`parent-item-${product.id}`} className="relative inline-block text-slate-400">
                        <span aria-hidden="true">—</span>
                        <span className="sr-only">{t('No parent')}</span>
                      </span>
                    );
                  }
                  const label = labelOf(product);
                  // A parent known only by id (the relation was not populated)
                  // still links, under a neutral name rather than a blank.
                  const shown = parentName ?? t('Parent item');
                  const linkLabel = parentName ? t('Open parent {name}', { name: parentName }) : t('Open parent item');
                  return (
                    <div data-testid={`parent-item-${product.id}`}>
                      <Link
                        href={`/dashboard/products/${parentId}`}
                        className="text-sm text-primary hover:underline"
                        data-testid={`parent-of-${product.id}`}
                        aria-label={linkLabel}
                      >
                        {shown}
                      </Link>
                      {label && (
                        <div className="text-xs text-slate-500" data-testid={`option-label-${product.id}`}>
                          {t('Option: {label}', { label })}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </TD>
              <TD>
                {product.status === 'PUBLISHED' ? (
                  <Badge variant="success">{t('Published')}</Badge>
                ) : product.status === 'ARCHIVED' ? (
                  <Badge variant="danger">{t('Archived')}</Badge>
                ) : (
                  <Badge variant="neutral">{t('Draft')}</Badge>
                )}
                {branchFilterStoreId &&
                  (() => {
                    /* The branch flag, read off the link row the list already
                       carries. A card has links of its own (derived from its
                       children), so it is badged too; a row with no link for
                       this branch cannot appear under a branch filter. */
                    const link = (product.branchLinks || []).find((l) => storeIdOf(l.store) === branchFilterStoreId);
                    if (!link) return null;
                    return (
                      <div className="mt-1" data-testid={`branch-state-${product.id}`} data-published={String(!!link.published)}>
                        <Badge variant={link.published ? 'info' : 'neutral'}>
                          {link.published ? t('Published here') : t('Hidden here')}
                        </Badge>
                      </div>
                    );
                  })()}
              </TD>
              <TD className="text-xs text-slate-600">
                {product.categories && product.categories.length > 0 ? (
                  <span className="flex flex-wrap gap-1">
                    {product.categories.map((c) => (
                      <span
                        key={c.id}
                        className={`inline-block rounded px-1.5 py-0.5 ${
                          c.archivedAt ? 'text-slate-400 italic' : 'bg-slate-100 text-slate-700'
                        }`}
                      >
                        {c.archivedAt ? `[${t('Archived')}] ` : ''}
                        {c.name}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="text-slate-400 italic">{t('Unassigned')}</span>
                )}
              </TD>
              {/* Numbers line up down the page: right-aligned, with digits of
                  equal width, so a column of prices can be compared at a glance. */}
              <TD align="right" className="font-medium tabular-nums whitespace-nowrap">
                {formatCurrency(product.price)}
              </TD>
              <TD align="right" className="font-medium text-emerald-700 tabular-nums whitespace-nowrap">
                {formatCurrency(product.salePrice)}
              </TD>
              <TD align="right" className="tabular-nums whitespace-nowrap">
                <span
                  className={cn(
                    product.trackInventory &&
                      (product.stockQuantity || 0) === 0 &&
                      'text-danger font-medium',
                  )}
                >
                  {product.stockQuantity ?? 0}
                </span>
                {!product.trackInventory && (
                  <span className="ml-1 text-[10px] text-slate-400 uppercase">untracked</span>
                )}
              </TD>
              {(canManage || canArchive) && (
                <TD align="center" className="whitespace-nowrap space-x-1">
                  {/* Editing and archival are separate authorities: a branch
                      admin keeps Edit and never sees Archive/Restore/Delete. */}
                  {!product.archivedAt && canManage && (
                    <Button size="sm" variant="secondary" tooltip={t('Edit name, price, stock, images and child products')} onClick={() => onEdit(product)}>
                      {t('Edit')}
                    </Button>
                  )}
                  {!product.archivedAt && canArchive && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      tooltip={t('Hide from the catalog (can be restored later)')}
                      onClick={() => onArchive(product.id)}
                    >
                      {t('Archive')}
                    </Button>
                  )}
                  {product.archivedAt && canArchive && (
                    <Button size="sm" variant="secondary" tooltip={t('Bring back into the catalog')} onClick={() => onRestore(product.id)}>
                      {t('Restore')}
                    </Button>
                  )}
                  {/*
                    NOT gated on `archivedAt` any more. Archiving was the old
                    permanent delete's precondition; removal is a different,
                    recoverable act and requiring an unrelated lifecycle first
                    would make one a gate on the other.
                  */}
                </TD>
              )}
            </TR>
          );
        })}
      </TBody>
    </Table>
  );
}
