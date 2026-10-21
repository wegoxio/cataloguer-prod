'use client';

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '../../../lib/auth';
import {
  canBulkAssignStores,
  canArchiveCatalogueItem,
  canBulkMutateCatalogue,
  canManageCatalogue,
} from '../../../lib/permissions';
import { useNumberFormatter, useT } from '../../../lib/i18n';
import { NoOrganizationContext } from '../../../components/layout/access-denied';
import { apiFetch } from '../../../lib/api-client';
import { useDebouncedValue } from '../../../lib/use-debounced-value';
import { useLatestRequest } from '../../../features/users/use-latest-request';
import { useToast } from '../../../components/ui/toast';
import { useStores, buildWebsiteUrl } from '../../../lib/use-website-config';
import Button from '../../../components/ui/button';
import Modal from '../../../components/ui/modal';
import ConfirmModal from '../../../components/ui/confirm-modal';
import Pagination from '../../../components/ui/pagination';
import ProductTable from '../../../features/products/components/product-table';
import ProductForm, {
  type ProductFormSubmission,
  type ProductStorePrice,
} from '../../../features/products/components/product-form';
import ProductImagesPanel from '../../../features/products/components/product-images-panel';
import ProductFilters from '../../../features/products/components/product-filters';
import BulkActionsBar, {
  BulkModalType,
  BulkQuickAction,
} from '../../../features/products/components/bulk-actions-bar';
import BulkResultPanel from '../../../features/products/components/bulk-result-panel';
import BulkCategoryModal from '../../../features/products/components/bulk-category-modal';
import BulkInventoryModal from '../../../features/products/components/bulk-inventory-modal';
import BulkPricingModal from '../../../features/products/components/bulk-pricing-modal';
import BulkStoresModal from '../../../features/products/components/bulk-stores-modal';
import BulkWebsitePublicationModal from '../../../features/products/components/bulk-website-publication-modal';
import BulkWebsitePublicationResult from '../../../features/products/components/bulk-website-publication-result';
import { foldRetry, runBulkBranchPublication } from '../../../features/products/services/bulk-branch-publication';
import { runChunkedBulk, isRetrySafe } from '../../../features/products/services/bulk-chunked';
import CreateParentCardForm from '../../../features/products/components/create-parent-card-form';
import SuggestionsBanner from '../../../features/products/components/suggestions-banner';
import {
  familySuggestionsService,
  type FamilySuggestion,
} from '../../../features/products/services/family-suggestions.service';
import GroupAsFamilyModal, {
  groupBlockedReason as reasonGroupingBlocked,
} from '../../../features/products/components/group-as-family-modal';
import { familyService } from '../../../features/products/services/family.service';
import {
  Product,
  BulkResult,
  BulkBranchPublicationRun,
  BranchPublicationProgress,
  ProductFilterState,
  DEFAULT_PRODUCT_FILTERS,
} from '../../../features/products/types/product.types';
import type { CategoryRef } from '../../../features/categories/types/category.types';
import { useCategoryList } from '../../../features/categories/category-queries';
import { categoryQueryIdentity } from '../../../features/categories/category-queries';
import { fetchProductList } from '../../../features/products/product-queries';
import { queryKeys } from '../../../lib/query-client';

/**
 * The largest page an address may name. 100,000 pages of 25 rows is 2.5
 * million items, far beyond any catalogue this list serves, so anything above
 * it is a malformed or hostile address rather than a page: it is treated like
 * other invalid input instead of becoming an offset the database has to
 * compute. A page that is merely beyond the LAST page is still clamped after
 * the response, as it always was. Not exported: a route module may only
 * export what Next understands, and the tests pin the ceiling by value.
 */
const MAX_URL_PAGE = 100_000;

/**
 * A canonical positive integer and nothing else: digits only, no sign, no
 * leading zero, no whitespace, no fraction, no exponent, no hexadecimal.
 * Anything looser would be parsed by `Number` into a page the address does
 * not actually say, and the address would then be left contradicting the
 * list.
 */
const CANONICAL_PAGE = /^[1-9]\d*$/;

/**
 * The page named in the URL, or null when absent or not a canonical page
 * within the ceiling. Every null is canonicalised by the caller to page 1
 * with the parameter removed, through the same replace path a reset uses.
 */
function pageFromUrl(): number | null {
  const raw = new URLSearchParams(window.location.search).get('page');
  if (raw === null || !CANONICAL_PAGE.test(raw)) return null;
  const parsed = Number(raw);
  return parsed <= MAX_URL_PAGE ? parsed : null;
}

/**
 * Whether two id lists name the same SET: order and repeats do not count. A
 * category list the reader left alone can come back from the form in another
 * order, and that must not read as a change.
 */
function sameIdSet(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && a.every((id) => right.has(id));
}

/**
 * A SELECTION THAT OUTLIVES THE PAGE, AND WHY IT DOES.
 *
 * `matching` is every id the current filters returned. `remainder` is what a
 * bulk run left behind when it stopped: ids the server may or may not have
 * applied, plus ids nobody ever sent. Both belong to a SCOPE rather than to a
 * page, so both survive paging and both die when the scope changes — and both
 * have to say which they are, because "700 selected" means something
 * different in each case.
 */
/**
 * WHAT A RUN LEFT BEHIND, KEPT UNTIL SOMEBODY HAS READ IT.
 *
 * A toast is gone in seconds and a bulk bar disappears with its selection, so
 * neither can carry ids a person still has to reconcile. When a chunk's
 * request fails, the ids it was carrying may or may not have been applied;
 * for archive and restore nothing may be re-selected on their behalf, so the
 * only place their identity survives is here. It stays on screen until it is
 * dismissed.
 */
type RunReport = {
  scope: string;
  action: string;
  confirmed: number;
  failures: { id: string; message: string }[];
  /** Named where the name is known, so a person can go and look. */
  unconfirmed: { id: string; name: string | null }[];
  notAttempted: number;
  retrySafe: boolean;
};

type CrossPageSelection =
  | { kind: 'matching'; scope: string; total: number }
  /*
   * A remainder the reader has since edited by hand. It is no longer that
   * run's leftovers, so it stops counting them, but its ids still reach well
   * beyond the page in front of the reader — calling it "on this page" would
   * be false, and letting a page change drop it would lose the retry set
   * without a word. It is an explicit list of ids bound to the scope.
   */
  | { kind: 'edited'; scope: string; total: number }
  | {
      kind: 'remainder';
      scope: string;
      total: number;
      action: string;
      unconfirmed: string[];
      notAttempted: string[];
      confirmed: number;
      failed: number;
      retrySafe: boolean;
    };

export default function ProductsPage() {
  const t = useT();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { scope, accessToken } = useAuth();
  const toast = useToast();
  const { stores } = useStores();

  const [cachedProducts, setCachedProducts] = useState<Product[]>([]);
  const [productsTenant, setProductsTenant] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const categoryOptionsQuery = useCategoryList(
    accessToken,
    scope?.organizationId,
    scope?.storeId,
    { limit: 100 },
  );
  const categories = (categoryOptionsQuery.data?.items ?? []) as CategoryRef[];

  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [activeBulkModal, setActiveBulkModal] = useState<BulkModalType | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  /*
   * A website publication run (ADR 029) keeps its OWN result, apart from the
   * other bulk actions': it has five outcomes rather than two, it spans
   * several requests, and its "not attempted" ids must survive until the
   * person decides whether to retry them. It also holds its own product list,
   * so navigating away does not lose the names the panel shows.
   */
  const [websiteRun, setWebsiteRun] = useState<{
    run: BulkBranchPublicationRun;
    websiteName: string;
    /** The operation completed but the list could not be reloaded afterwards. */
    refreshFailed: boolean;
  } | null>(null);
  // Progress of the run in flight — its own state, seeded for each run and
  // each retry, so a retry never reports against a finished run's chunk count.
  const [websiteProgress, setWebsiteProgress] = useState<BranchPublicationProgress | null>(null);
  /*
   * ONE RUN AT A TIME, DECIDED SYNCHRONOUSLY.
   *
   * Two clicks on Publish, or Publish and then Archive, arrive before any
   * state from the first has rendered. A ref is the only thing that can say
   * "already running" in that gap; the state beside it is what the bar reads
   * to stop offering the controls.
   */
  const bulkRunningRef = useRef(false);
  const [bulkRunning, setBulkRunning] = useState<string | null>(null);
  /** The last run's leftovers, kept until dismissed. */
  const [runReport, setRunReport] = useState<RunReport | null>(null);
  /** Chunk progress of a non-publication bulk action, when there is more than one. */
  const [bulkProgress, setBulkProgress] = useState<{ sent: number; total: number } | null>(null);

  const [isFormOpen, setIsFormOpen] = useState(false);
  /*
   * WHAT "Add Item" IS ADDING.
   *
   * A single item and a parent card are different things, and the form for one
   * is not the form for the other: a card has no price to charge, no stock, no
   * SKU and no shops of its own. The choice is the first thing asked, so the
   * rest of the dialog can be honest about what it is collecting.
   */
  const [newKind, setNewKind] = useState<'item' | 'card'>('item');
  const [cardCandidates, setCardCandidates] = useState<Product[]>([]);
  const [cardSearching, setCardSearching] = useState(false);
  /*
   * SUGGESTIONS LIVE HERE NOW.
   *
   * They are discovery, and discovery belongs where the items are — the
   * separate page was a second grouping workflow with none of this one's
   * safeguards. The banner never touches the table's selection: loading a
   * suggestion must not silently tick checkboxes somebody did not tick, so
   * reviewing one is an explicit act that opens the modal with its OWN
   * members.
   */
  const [suggestions, setSuggestions] = useState<FamilySuggestion[] | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionBusy, setSuggestionBusy] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<FamilySuggestion | null>(null);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Product | null>(null);
  const [managingProductImages, setManagingProductImages] = useState<Product | null>(null);

  const [filters, setFilters] = useState<ProductFilterState>(DEFAULT_PRODUCT_FILTERS);
  // Only the free-text search is debounced; other filters apply instantly
  const debouncedSearch = useDebouncedValue(filters.search);
  const effectiveFiltersKey = JSON.stringify({ ...filters, search: debouncedSearch });
  const effectiveFilters = useMemo<ProductFilterState>(() => JSON.parse(effectiveFiltersKey), [effectiveFiltersKey]);
  /*
   * THE TYPED SEARCH AND THE LIST DO NOT AGREE YET.
   *
   * While the debounce runs, the rows on screen still answer the previous
   * search. Offering "select everything that matches" there would take a
   * snapshot of a list the reader has already stopped asking for, and the
   * count beside it would be the old one. The offer waits until the two agree.
   */
  const searchSettling = filters.search !== debouncedSearch;
  /** Whether anything narrows the list, which changes how a count reads. */
  const hasActiveFilters = useMemo(
    () => JSON.stringify(filters) !== JSON.stringify(DEFAULT_PRODUCT_FILTERS),
    [filters],
  );
  // Read synchronously, so the FIRST request already asks for the page in the
  // address instead of fetching page 1 and then the real one. Nothing in the
  // server-rendered markup depends on it: the list renders its loading state
  // until the client has fetched, so the server's 1 and the client's value
  // never disagree in anything that is hydrated.
  const [page, setPage] = useState(() => (typeof window === 'undefined' ? 1 : (pageFromUrl() ?? 1)));
  /*
   * TWO PAGES, NOT ONE, AND ONE OF THEM IS LIVE.
   *
   * `page` is the page the reader ASKED for: it goes into the request, the
   * address and the "loading page N" line. `answered` is the page the rows on
   * screen BELONG to, together with the scope they were fetched for: it is
   * what the summary and the current-page marker describe, and it moves only
   * when an answer is applied, in the same commit as the rows and the totals.
   *
   * `requestedPageRef` is the reader's intent RIGHT NOW. React state is not
   * enough for that: a click updates state, but the render and the effect
   * that starts the request happen later, and a response can land in
   * between. Every page change therefore goes through `applyPage`, which
   * writes this ref before it touches state, so an answer that arrives after
   * the reader has already chosen another page can see that it is obsolete
   * even though its own request is still the last one that STARTED.
   */
  const requestedPageRef = useRef(page);
  const [answered, setAnswered] = useState<{ page: number; scope: string } | null>(null);
  const answeredRef = useRef<{ page: number; scope: string } | null>(null);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState(0);
  /*
   * TWO KINDS OF SELECTION, AND THE DIFFERENCE IS THE POINT.
   *
   * A PAGE selection is the rows the reader ticked on the page in front of
   * them. It belongs to that page and dies when they leave it.
   *
   * An EVERYTHING-THAT-MATCHES selection is every id the current filters
   * return, fetched in one snapshot. It belongs to the SCOPE, not to a page,
   * so it survives paging — that is the whole reason to offer it — and it
   * carries the scope it was taken for, so a later filter, search, branch or
   * company change stops it describing the screen instead of silently
   * applying a bulk action to a set the reader never saw. `total` is the
   * count the server reported for that scope, which is what the reader is
   * told they are acting on.
   */
  const [matchingSelection, setMatchingSelection] = useState<CrossPageSelection | null>(null);
  const matchingSelectionRef = useRef<CrossPageSelection | null>(null);
  /** Set when the scope matches more ids than one selection may carry. */
  const [selectionTooLarge, setSelectionTooLarge] = useState<{ scope: string; total: number; cap: number } | null>(null);

  /*
   * THE PAGE LIVES IN THE URL TOO.
   *
   * A click on a page number pushes a history entry, so Back returns to the
   * page the reader came from and Forward re-applies it. A filter change
   * resets to page 1 and REPLACES the entry: nobody expects Back to undo a
   * filter. Normalising an invalid or out-of-range value replaces as well.
   * Nothing is written when the URL already says the same, so hydration and
   * clamping never leave a duplicate entry behind. The listener below reads
   * the page back on popstate without pushing anything.
   */
  const writePageToUrl = useCallback((next: number, mode: 'push' | 'replace') => {
    const url = new URL(window.location.href);
    const before = url.searchParams.get('page');
    if (next <= 1) url.searchParams.delete('page');
    else url.searchParams.set('page', String(next));
    if (before === url.searchParams.get('page')) return;
    const target = url.pathname + url.search + url.hash;
    if (mode === 'push') window.history.pushState(window.history.state, '', target);
    else window.history.replaceState(window.history.state, '', target);
  }, []);
  /*
   * THE ONLY WAY THE PAGE CHANGES. Every path goes through here: a numbered
   * click, First/Previous/Next/Last, Back and Forward, a filter reset, a
   * clamp, a rollback after a failure, and normalising a malformed address.
   * The live intent is written FIRST, synchronously, before React state and
   * before the address, so a response that lands between this call and the
   * render it causes already sees the page the reader is waiting for.
   * `'none'` is for Back and Forward, where the browser already moved the
   * address and writing it again would fight the history stack.
   */
  const applyPage = useCallback(
    (next: number, mode: 'push' | 'replace' | 'none') => {
      requestedPageRef.current = next;
      setPage(next);
      if (mode !== 'none') writePageToUrl(next, mode);
    },
    [writePageToUrl],
  );
  /** A page change the READER asked for: state and a history entry. */
  const goToPage = useCallback((next: number) => applyPage(next, 'push'), [applyPage]);
  // The filter key this page mounted with, or that its deep link settles on.
  // Reaching it is not a filter CHANGE and must not send the list to page 1.
  const lastFiltersKeyRef = useRef<string | null>(null);
  const deepLinkFiltersKeyRef = useRef<string | null>(null);

  const updateFilters = useCallback((partial: Partial<ProductFilterState>) => {
    setFilters((prev) => ({ ...prev, ...partial }));
  }, []);

  /*
   * THE SCOPE A ROW BELONGS TO: the company plus every effective filter,
   * search, sort and branch. Rows answered for one scope may never be shown
   * as a page of another, so the answered page carries the scope it was
   * fetched for and the summary only describes rows whose scope is still the
   * one on screen. Unlike the page, the scope can only change through a
   * render — it is derived from state — so mirroring it in a ref during
   * render keeps the ref exactly as current as the screen.
   */
  const tenantKey = `${scope?.organizationId ?? ''}|${scope?.storeId ?? '*'}`;
  const scopeKey = `${tenantKey}|${effectiveFiltersKey}`;
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  // Previous filter/page rows may remain visible while the same tenant loads,
  // but a tenant switch hides them synchronously. No effect or network timing
  // may leave one company's catalogue painted inside another company's shell.
  const products = useMemo(
    () => (productsTenant === tenantKey ? cachedProducts : []),
    [productsTenant, tenantKey, cachedProducts],
  );
  // The rows on screen, but only while they still belong to the scope the
  // reader is looking at. A filter, sort, branch or company change makes this
  // null again: no page is answered for the new scope until it answers.
  const answeredPage = answered && answered.scope === scopeKey ? answered.page : null;
  // The cross-page selection, but only while it still describes the filters
  // on screen. A scope change makes it null, so no bulk action can run on a
  // set the reader chose under filters they have since changed.
  const crossPageSelection = matchingSelection && matchingSelection.scope === scopeKey ? matchingSelection : null;
  const tooLargeForScope = selectionTooLarge && selectionTooLarge.scope === scopeKey ? selectionTooLarge : null;
  /*
   * WHETHER WE HOLD THE RECORDS, NOT JUST THE IDS. A cross-page selection is
   * a list of ids; only the current page's full products are loaded. Any
   * control that needs the records themselves — grouping reads names, roles
   * and children — can act on the selection only while every selected id is
   * on screen. Grouping 25 of 60 because the other 35 were not loaded is the
   * silent wrong answer this guards against.
   */
  const selectionFullyLoaded = selectedProductIds.every((id) => products.some((p) => p.id === id));
  /** Numbers are read by people: group the thousands. */
  const numberFormatter = useNumberFormatter();
  const nf = useCallback((n: number) => numberFormatter.format(n), [numberFormatter]);

  /*
   * THE SENTENCE THAT DESCRIBES THE SELECTION.
   *
   * It has to stay true after the reader edits a cross-page selection by hand.
   * Unticking one of sixty leaves a cross-page selection of fifty-nine, and
   * calling that "every item matching these filters" is simply false, so the
   * wording follows the count against the scope's total instead of the mode
   * alone. With no filters set there is nothing to "match", so it says items.
   */
  const selectionSentence = (() => {
    const n = selectedProductIds.length;
    if (n === 0) return '';
    if (crossPageSelection?.kind === 'remainder') {
      // What is left of a run that stopped, said as three different things,
      // because they are three different things.
      return crossPageSelection.unconfirmed.length > 0 && !crossPageSelection.retrySafe
        ? t(
            '{n} items left from the last run and still selected. {unconfirmed} more could not be confirmed — check those before running this again.',
            { n: nf(n), unconfirmed: nf(crossPageSelection.unconfirmed.length) },
          )
        : t('{n} items left from the last run: {unconfirmed} unconfirmed, {notAttempted} never sent', {
            n: nf(n),
            unconfirmed: nf(crossPageSelection.unconfirmed.length),
            notAttempted: nf(crossPageSelection.notAttempted.length),
          });
    }
    if (crossPageSelection?.kind === 'edited') {
      return n === 1
        ? t('1 item selected across pages')
        : t('{n} items selected across pages', { n: nf(n) });
    }
    if (crossPageSelection) {
      const total = crossPageSelection.total;
      if (n < total) {
        return t('{n} of {total} matching items selected', { n: nf(n), total: nf(total) });
      }
      return hasActiveFilters
        ? t('All {n} matching items selected', { n: nf(n) })
        : t('All {n} items selected', { n: nf(n) });
    }
    return n === 1
      ? t('1 item selected on this page')
      : t('{n} items selected on this page', { n: nf(n) });
  })();

  // Only the LATEST request may paint rows, report an error, clear loading or
  // clamp the page. A filter change fires a fetch for the old page in the same
  // commit that resets to page 1; if that stale answer landed after the reset
  // it would clamp the list onto its own last page. The shared helper hands
  // every request a ticket and answers "am I still current?"; a stale caller
  // writes nothing. Unmounting takes a ticket too, so an answer that lands
  // after the page is gone writes nothing either. The ticket is necessary but
  // NOT sufficient: it only knows which request started last, so `stillMine`
  // below pairs it with the page and scope the reader is actually waiting for.
  const beginRequest = useLatestRequest();
  /*
   * A SECOND TICKET, FOR THE SELECTION SNAPSHOT ONLY. It must not share the
   * list's: taking a snapshot would then cancel the rows request, and a row
   * request would cancel a snapshot the reader is still waiting for. Every
   * scope change takes one, which is how an in-flight snapshot for the old
   * filters becomes obsolete before it can land.
   */
  const beginSelectionRequest = useLatestRequest();
  useEffect(() => () => void beginRequest(), [beginRequest]);
  // False until the first answer: the initial load shows its own line, a
  // later reload keeps the list, the metadata and the controls on screen.
  const [loadedOnce, setLoadedOnce] = useState(false);
  const fetchProducts = useCallback(async (force = false) => {
    // No company, no query: a session outside a company gets the stated
    // no-organization answer below, never a request whose empty result would
    // render as "this company has no products" (D-5.1 pattern).
    if (!accessToken || !scope?.organizationId) return false;
    const requestPage = page;
    const requestScope = scopeKey;
    const isCurrent = beginRequest();
    /*
     * A RESPONSE MAY WRITE ONLY IF IT IS STILL WANTED. Two conditions, both
     * required: it is the last request that started, AND it is still the page
     * and the scope the reader is waiting for. The second is what the ticket
     * alone cannot see. A click on page 10 changes the intent immediately,
     * but page 10's request does not start until the effect runs, so between
     * those two moments page 9 is still the latest request that started. A
     * page-9 failure landing there used to pass, roll the reader back and
     * discard the newer choice; now it is obsolete the instant page 10 is
     * chosen.
     */
    const stillMine = () =>
      isCurrent() && requestedPageRef.current === requestPage && scopeKeyRef.current === requestScope;
    setLoading(true);
    setError(null);
    try {
      const identity = categoryQueryIdentity(scope.organizationId, scope.storeId);
      const request = { filters: effectiveFilters, page: requestPage, limit: 25 };
      const response = await queryClient.fetchQuery({
        queryKey: queryKeys.products(identity, request),
        queryFn: () => fetchProductList(accessToken, request),
        staleTime: force ? 0 : 30_000,
      });
      // Superseded, or the reader moved on: a newer intent owns the screen.
      if (!stillMine()) return true;
      if (response) {
        const pages = Math.max(1, Number(response.totalPages) || 1);
        /*
         * OUT OF RANGE — a narrowed filter, rows archived meanwhile, a stale
         * link. This response has no rows for anybody: it is the empty answer
         * to a page that does not exist. Painting it would put an empty table
         * under a summary claiming a full page, so nothing here is applied.
         * The intent and the address move to the last real page and its own
         * request, started by the effect below, is what moves the screen.
         */
        if (requestPage > pages) {
          applyPage(pages, 'replace');
          return true;
        }
        // Rows, totals and the answered page change in the same commit, and
        // the answered page carries the scope those rows were fetched for.
        setCachedProducts(response.items);
        setProductsTenant(identity);
        setTotalPages(pages);
        setTotalItems(response.total || 0);
        answeredRef.current = { page: requestPage, scope: requestScope };
        setAnswered({ page: requestPage, scope: requestScope });
        setLoadedOnce(true);
      }
      // Whether the reload happened, for callers that just changed data and
      // must not confuse "could not reload" with "the change failed".
      return true;
    } catch (err: any) {
      if (!stillMine()) return false;
      // The rows on screen are still the last answered page of this scope, so
      // the request goes back to that page too, in state and in the address.
      // Replaced, not pushed: a failure is not a place Back should return to.
      // With no answered page for this scope there is nothing to go back to,
      // and the requested page stands. The effect below will not re-fetch the
      // page it is already displaying, so the error stays on screen.
      const last = answeredRef.current;
      if (last && last.scope === requestScope && last.page !== requestPage) {
        applyPage(last.page, 'replace');
      }
      setError(err.message || 'Failed to retrieve products');
      return false;
    } finally {
      // A clamp and a rollback both move the intent, so neither clears the
      // loading state here: the clamped page's request owns it, and the
      // effect below settles it when it finds the page already displayed.
      if (stillMine()) setLoading(false);
    }
  }, [accessToken, scope?.organizationId, scope?.storeId, effectiveFilters, page, scopeKey, applyPage, beginRequest, queryClient]);

  // Deep links from the dashboard: ?status=DRAFT, ?hasImages=false,
  // ?hasCategory=false pre-filter the list; ?new=1 opens the create modal.
  // (window.location instead of useSearchParams: avoids the Suspense
  // requirement for prerendered pages.)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const status = params.get('status');
    const hasImages = params.get('hasImages');
    const hasCategory = params.get('hasCategory');
    const lowStock = params.get('lowStock');
    const complete = params.get('complete');
    const deepLink: Partial<ProductFilterState> = {
      ...(status ? { status } : {}),
      ...(hasImages ? { hasImages } : {}),
      ...(hasCategory ? { hasCategory } : {}),
      ...(lowStock ? { trackInventory: 'low' } : {}),
      ...(complete ? { complete } : {}),
    };
    if (Object.keys(deepLink).length > 0) {
      setFilters((prev) => ({ ...prev, ...deepLink }));
      // The key those filters settle on. The reset effect below sees it as
      // the deep link arriving, not as the reader changing a filter, so the
      // page read just below survives it.
      deepLinkFiltersKeyRef.current = JSON.stringify({ ...DEFAULT_PRODUCT_FILTERS, ...deepLink, search: '' });
    }
    if (params.get('new') === '1') {
      setEditingProduct(null);
      setIsFormOpen(true);
    }
    // The page itself was read when the state was created. What is left is to
    // tidy an address that named a page it cannot mean — non-numeric or below
    // 1 — so the URL says the page 1 the list is showing. Above the last page
    // is clamped after the first fetch, the only moment the count is known.
    if (params.has('page') && pageFromUrl() === null) applyPage(1, 'replace');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Filter/sort changes reset to page 1 and replace the URL entry. The key
  // the page mounted with, and the one a deep link settles on, are not
  // changes. Selection is page-scoped: changing page or filters clears it
  // (prevents hidden selected rows across pages).
  useEffect(() => {
    if (lastFiltersKeyRef.current === null) {
      lastFiltersKeyRef.current = effectiveFiltersKey;
      return;
    }
    if (lastFiltersKeyRef.current === effectiveFiltersKey) return;
    lastFiltersKeyRef.current = effectiveFiltersKey;
    // Nothing needs to clear the answered page here: it carries the scope it
    // was fetched for, so it stops describing the screen the moment the scope
    // changes. The old rows stay on screen, dimmed, with no page label on
    // them, rather than being called page 1 of the new filter.
    //
    // A NEW SCOPE STARTS WITHOUT THE OLD SCOPE'S ERROR. A failed search that
    // the reader then clears would otherwise leave its banner over the list
    // it came back to: returning to a scope whose page is still on screen
    // needs no request, and only a request used to clear the error. This is
    // the one place that knows the scope CHANGED, so it is the one place that
    // may drop the error. The rollback after a failed page change never gets
    // here — the scope did not change — so its banner survives, which is the
    // whole point of rolling back.
    setError(null);
    if (deepLinkFiltersKeyRef.current === effectiveFiltersKey) {
      deepLinkFiltersKeyRef.current = null;
      return;
    }
    applyPage(1, 'replace');
  }, [effectiveFiltersKey, applyPage]);

  // Back and Forward: the page comes back from the URL, and nothing is pushed.
  useEffect(() => {
    const onPopState = () => applyPage(pageFromUrl() ?? 1, 'none');
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyPage]);

  /*
   * THE ONE WAY A SELECTION ENDS. Every part of it goes together: the ids, the
   * cross-page record and its ref, and any notice about a scope too large to
   * select. Clearing only the ids used to leave the cross-page record armed,
   * so the very next row the reader ticked inherited a scope it never had —
   * it would then outlive a page change and be described as "every item
   * matching these filters". Every caller that means "the selection is gone"
   * calls this, and nothing else clears a part of it.
   */
  /**
   * A hand edit turns a stopped run's remainder into an ordinary cross-page
   * selection. The sentence that counted the run's confirmed, unconfirmed and
   * never-sent ids goes, because an edited set is no longer those leftovers.
   * The scope stays: the ids still span pages, so the selection still
   * survives paging and still ends on Clear or a scope change.
   */
  const editRemainder = useCallback(() => {
    const held = matchingSelectionRef.current;
    if (held?.kind !== 'remainder') return;
    const record: CrossPageSelection = { kind: 'edited', scope: held.scope, total: held.total };
    matchingSelectionRef.current = record;
    setMatchingSelection(record);
  }, []);

  const resetSelection = useCallback(() => {
    // A snapshot still on its way is no longer wanted: the reader has just
    // said what the selection is. Taking a ticket here is what stops a late
    // answer from putting ids back after a Clear.
    beginSelectionRequest();
    setSelectedProductIds([]);
    setMatchingSelection(null);
    matchingSelectionRef.current = null;
    setSelectionTooLarge(null);
  }, [beginSelectionRequest]);

  /*
   * A FILTER EDIT DROPS THE SELECTION. Whatever was ticked was ticked under
   * the old filters; carrying it into new ones is how a bulk action reaches
   * products the reader never saw. This watches the raw filters, not the
   * debounced ones, so the selection goes the moment the reader starts
   * changing what they are looking at — including while a search is still
   * inside its debounce window, before the scope itself has changed.
   *
   * Taking a selection ticket here is what stops a snapshot already in flight
   * from landing afterwards and re-selecting the old scope's ids. Sort lives
   * in these filters too, so changing it ends the selection by the same rule.
   */
  useEffect(() => {
    beginSelectionRequest();
    resetSelection();
    setBulkResult(null);
  }, [filters, beginSelectionRequest, resetSelection]);

  /*
   * AND AGAIN WHEN THE EFFECTIVE SCOPE ACTUALLY MOVES.
   *
   * The edit above and the scope change are two different moments: a typed
   * search changes the filters at once but the effective scope only when the
   * debounce fires. Between them the old rows are still on screen, and a
   * selection taken there is a selection of the old list. When the new search
   * takes effect those ids describe nothing the reader can see, so the scope
   * change ends the selection in its own right — and spends any snapshot
   * still in flight, which is the one that would otherwise arrive holding the
   * old scope's ids.
   */
  useEffect(() => {
    beginSelectionRequest();
    resetSelection();
  }, [scopeKey, beginSelectionRequest, resetSelection]);

  /*
   * A PAGE CHANGE drops a PAGE selection only. An everything-that-matches
   * selection is the reason paging exists for it: it was taken for the scope,
   * not for the page, so it survives. Read from the ref rather than the state
   * so this does not re-run when the selection itself changes.
   */
  useEffect(() => {
    // Held only while it still describes the list on screen. A record left
    // over from another scope is not a reason to keep its ids selected.
    const held = matchingSelectionRef.current;
    if (held && held.scope === scopeKeyRef.current) return;
    setSelectedProductIds([]);
    setBulkResult(null);
  }, [page]);

  /*
   * AN EMPTIED CROSS-PAGE SELECTION IS NO SELECTION. Unticking the last id of
   * a matching or edited set by hand must not leave its record armed: the
   * next row ticked would inherit a cross-page scope it never had and outlive
   * a page change.
   */
  useEffect(() => {
    if (selectedProductIds.length > 0 || !matchingSelectionRef.current) return;
    matchingSelectionRef.current = null;
    setMatchingSelection(null);
  }, [selectedProductIds]);

  // "Select all N matching": pull every matching id across pages (same
  // filters the list uses) so the existing bulk actions apply to all of them
  const selectAllMatching = useCallback(async () => {
    if (!accessToken) return;
    const requestScope = scopeKey;
    const isCurrent = beginSelectionRequest();
    const params = new URLSearchParams();
    const f = effectiveFilters;
    if (f.search) params.append('search', f.search);
    if (f.status) params.append('status', f.status);
    if (f.categoryId) params.append('categoryId', f.categoryId);
    if (f.trackInventory === 'low') params.append('lowStock', 'true');
    else if (f.trackInventory) params.append('trackInventory', f.trackInventory);
    if (f.hasChildren) params.append('hasChildren', f.hasChildren);
    if (f.family) params.append('family', f.family);
    // The branch filter too: "select all N matching" must mean the N the
    // operator is LOOKING at, or a bulk action quietly reaches products the
    // filtered list never showed.
    if (f.storeId) params.append('storeId', f.storeId);
    // And its publication state on that branch, for the same reason: "all N
    // hidden here" must be exactly the N the list shows as hidden here.
    if (f.storeId && f.branchPublished) params.append('branchPublished', f.branchPublished);
    if (f.showArchived) params.append('includeArchived', 'true');
    if (f.minPrice) params.append('minPrice', f.minPrice);
    if (f.maxPrice) params.append('maxPrice', f.maxPrice);
    if (f.hasSalePrice) params.append('hasSalePrice', f.hasSalePrice);
    if (f.hasImages) params.append('hasImages', f.hasImages);
    if (f.hasCategory) params.append('hasCategory', f.hasCategory);
    if (f.sellable) params.append('sellable', f.sellable);
    if (f.complete) params.append('complete', f.complete);
    try {
      const res = await apiFetch(`/products/ids?${params.toString()}`, { method: 'GET', token: accessToken });
      /*
       * THE SNAPSHOT IS ONLY GOOD FOR THE SCOPE IT WAS TAKEN FOR. Between the
       * request and its answer the reader may have typed a new search, changed
       * a filter or a branch, or asked for a different snapshot. Applying it
       * then would select ids from a scope that is no longer on screen — the
       * exact confusion this whole feature exists to remove — so a superseded
       * answer writes nothing at all.
       */
      if (!isCurrent() || scopeKeyRef.current !== requestScope) return;
      const ids: string[] = res?.ids || [];
      const total = typeof res?.total === 'number' ? res.total : ids.length;
      /*
       * A TRUNCATED SNAPSHOT IS REFUSED, NOT TRIMMED. The server answers with
       * how many products match and whether it could return them all. If it
       * could not, selecting what came back would put a number on screen that
       * is not the number the filters match, and a bulk action would run on an
       * arbitrary part of the set. The reader is told to narrow the filters
       * instead; the selection they already had is left untouched.
       */
      if (res?.truncated) {
        setSelectionTooLarge({ scope: scopeKey, total, cap: ids.length });
        return;
      }
      setSelectionTooLarge(null);
      setSelectedProductIds(ids);
      const record: CrossPageSelection = { kind: 'matching', scope: scopeKey, total };
      matchingSelectionRef.current = record;
      setMatchingSelection(record);
    } catch (err: any) {
      if (!isCurrent() || scopeKeyRef.current !== requestScope) return;
      toast.error(err.message || t('Operation failed'));
    }
  }, [accessToken, effectiveFilters, scopeKey, beginSelectionRequest, toast, t]);

  /**
   * Step back from "everything that matches" to the rows in front of the
   * reader. The cross-page scope is released, so the selection becomes a page
   * selection again and behaves like one, including dying on the next page.
   */
  const selectThisPageOnly = useCallback(() => {
    beginSelectionRequest();
    matchingSelectionRef.current = null;
    setMatchingSelection(null);
    setSelectionTooLarge(null);
    setSelectedProductIds(products.map((p) => p.id));
  }, [products, beginSelectionRequest]);

  /*
   * WHEN TO ASK THE SERVER. Not "unless something armed a flag" — that was a
   * one-shot token, and an unrelated render in between could spend it on the
   * wrong run. The question is answered from what is on screen: if the rows
   * already displayed ARE this page of this scope, there is nothing to fetch.
   * That is true after a rollback (the failure put the intent back on the
   * page still displayed) and after Back onto the page already shown, and it
   * is false for every genuine navigation, every scope change and the first
   * load, because the answered page or its scope differs. No state to leak
   * across renders, unmounts or later actions.
   */
  useEffect(() => {
    const shown = answeredRef.current;
    if (shown && shown.scope === scopeKey && shown.page === page) {
      // Settle the loading state a discarded request left behind: whatever is
      // still in flight was for a page the reader has already left, and
      // `stillMine` will keep it from writing anything.
      setLoading(false);
      return;
    }
    fetchProducts();
  }, [fetchProducts, page, scopeKey]);

  const fetchSuggestions = useCallback(async () => {
    if (!accessToken) return;
    try {
      const listing = await familySuggestionsService.list(accessToken);
      setSuggestions(listing.suggestions);
    } catch {
      // A failed request is UNKNOWN, not "none" — showing an empty state here
      // would report that there is nothing to group when nobody asked.
      setSuggestions(null);
    }
  }, [accessToken]);

  useEffect(() => {
    fetchSuggestions();
  }, [fetchSuggestions]);

  // `/dashboard/products/groups` redirects here with this flag, so the old
  // link lands on the review rather than on a page that no longer exists.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (new URLSearchParams(window.location.search).get('suggestions') === 'open') setSuggestionsOpen(true);
  }, []);

  /**
   * P5-A2 family 4. Three different authorities live on this page, and the
   * single role guess they shared was wrong in both directions: it excluded
   * the ORGANIZATION_MANAGER that ADR 014 grants full catalogue authority, and
   * it gave a branch ADMIN organization-wide bulk mutations.
   *
   *   canManage ......... per-product edits (SUPER_ADMIN, manager, ADMIN)
   *   canBulkMutate ..... bulk status/category/inventory/pricing (D-4.1)
   *   canArchive ........ archive/restore/delete, one product or in bulk —
   *                       organization-administrator only, narrowing refused
   *                       (P5-A2 canonical family 7)
   *   canAssignStores ... bulk store re-assignment, refused when narrowed (D-4.2)
   */
  const canManage = canManageCatalogue(scope);
  /*
   * IS A FILTER THE REASON THE LIST IS EMPTY?
   *
   * Compared against the defaults rather than tracked by hand, so a filter
   * added later is included without anybody remembering to. This is the only
   * thing that separates "you have no items" from "your filters hid them".
   */
  const canBulkMutate = canBulkMutateCatalogue(scope);
  const canArchive = canArchiveCatalogueItem(scope);
  const canAssignStores = canBulkAssignStores(scope);

  // Deep link: /dashboard/products?edit=<id> opens the editor directly (the
  // item detail page links here). Fetch the product itself so it works even
  // when the item isn't on the current page of results.
  useEffect(() => {
    if (!accessToken || !canManage) return;
    const editId = new URLSearchParams(window.location.search).get('edit');
    if (!editId) return;
    window.history.replaceState({}, '', '/dashboard/products');
    apiFetch(`/products/${editId}`, { method: 'GET', token: accessToken })
      .then((r) => {
        if (r?.data) {
          setEditingProduct(r.data);
          setIsFormOpen(true);
        }
      })
      .catch(() => undefined);
  }, [accessToken, canManage]);

  /**
   * #282: MEMBERSHIP IS SENT ONLY WHEN THE FORM ACTUALLY OFFERED IT.
   *
   * `storeIds` replaces a product's whole company-wide membership, and the
   * endpoint refuses its mere PRESENCE from a branch-scoped actor — deliberately,
   * so nothing about sibling branches leaks. This screen used to restate the
   * product's current membership on every save, so a store-bound ADMIN could not
   * change a status, a name or a price: every edit came back as "Replacing store
   * membership is a company-wide operation."
   *
   * The keys are BUILT conditionally rather than set to `undefined`. Both
   * disappear from the JSON either way, but a body that never carries the key
   * is the thing being promised, and it is what the test can read.
   */
  const handleCreateOrUpdate = async (data: ProductFormSubmission) => {
    if (!accessToken) return;
    const method = editingProduct ? 'PATCH' : 'POST';
    const endpoint = editingProduct ? `/products/${editingProduct.id}` : '/products';
    const membership: { storeIds?: string[]; storePrices?: ProductStorePrice[] } = {};
    if (data.storeIds !== undefined) membership.storeIds = data.storeIds;
    if (data.storePrices !== undefined) membership.storePrices = data.storePrices;
    /*
     * THE CATEGORIES THE READER ACTUALLY TICKED.
     *
     * This body used to carry the legacy single-category key `categoryId`,
     * for which the form has no input — so the value on the wire was always
     * `null`. The endpoint resolves
     * `categoryIds ?? (categoryId !== undefined ? (categoryId ? [id] : []) : undefined)`,
     * and a `categoryId` that is PRESENT AND NULL is not "unspecified": it
     * resolves to the empty set, which REPLACES the item's categories with
     * nothing. So every save through this form cleared them, whatever field
     * was being edited, and a reassignment could never stick — the ticked
     * categories were computed by the form and then dropped here, before the
     * request was built.
     *
     * `categoryIds` is sent ONLY WHEN THE SET CHANGED. On create it is always
     * sent: there is no set to leave alone. On an existing item it is compared
     * with the COMPLETE set the item was opened with — archived categories it
     * still sits in included — as a set, so order never counts as a change. An
     * unchanged set sends neither `categoryIds` nor `categoryId`, which the
     * endpoint reads as "leave the categories alone". That matters beyond
     * bandwidth: the endpoint refuses an archived category anywhere in
     * `categoryIds`, so restating an unchanged set that holds one would turn a
     * price-only save into an error. A changed set is sent whole, and a reader
     * who unticked every category sends `[]`.
     *
     * `slug` is unchanged: the form has no input for it either, so it stays
     * `undefined` and `JSON.stringify` drops the key. That is a separate
     * question and is deliberately left alone.
     */
    const legacy = data as ProductFormSubmission & { slug?: string };
    const categoryChange: { categoryIds?: string[] } = {};
    if (!editingProduct || !sameIdSet((editingProduct.categories ?? []).map((c) => c.id), data.categoryIds)) {
      categoryChange.categoryIds = data.categoryIds;
    }

    try {
      await apiFetch(endpoint, {
        method,
        token: accessToken,
        body: JSON.stringify({
          name: data.name,
          slug: legacy.slug,
          description: data.description || null,
          metaTitle: data.metaTitle || null,
          metaDescription: data.metaDescription || null,
          ...membership,
          sku: data.sku || null,
          manufacturerCode: data.manufacturerCode || null,
          status: data.status,
          ...categoryChange,
          price: data.price,
          salePrice: data.salePrice,
          cost: data.cost,
          stockQuantity: data.stockQuantity,
          trackInventory: data.trackInventory,
        }),
      });

      toast.success(editingProduct ? 'Product updated' : 'Product created');
      setIsFormOpen(false);
      setEditingProduct(null);
      fetchProducts(true);
    } catch (err: any) {
      toast.error(err.message || 'Operation failed');
    }
  };

  const handleArchive = async () => {
    // The handler checks the capability as well as the control that opened it:
    // a control can be reached by other means, and the server refuses either
    // way — this only stops the panel making a request it knows will fail.
    if (!accessToken || !archiveTarget || !canArchive) return;
    try {
      const archived = archiveTarget;
      await apiFetch(`/products/${archived.id}/archive`, {
        method: 'PATCH',
        token: accessToken,
      });
      toast.undo(`"${archived.name}" archived`, t('Undo'), () => handleRestore(archived.id));
      setArchiveTarget(null);
      fetchProducts(true);
    } catch (err: any) {
      toast.error(err.message || 'Failed to archive product');
      setArchiveTarget(null);
    }
  };

  const handleRestore = async (id: string) => {
    if (!canArchive) return;
    if (!accessToken) return;
    try {
      await apiFetch(`/products/${id}/restore`, {
        method: 'PATCH',
        token: accessToken,
      });
      toast.success('Product restored');
      fetchProducts(true);
    } catch (err: any) {
      toast.error(err.message || 'Failed to restore product');
    }
  };


  const handleToggleSelect = useCallback(
    (id: string) => {
      // A tick is the reader stating the selection. Any snapshot still in
      // flight would overwrite that statement when it lands, so it is spent.
      beginSelectionRequest();
      // A remainder describes one run's leftovers by count. Edit the set and
      // that description stops being true, but the ids still span pages, so
      // it becomes a cross-page selection of exactly these ids.
      editRemainder();
      setSelectedProductIds((prev) =>
        prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
      );
    },
    [beginSelectionRequest, editRemainder],
  );

  const handleToggleSelectAll = useCallback(() => {
    beginSelectionRequest();
    editRemainder();
    const pageProductIds = products.map((p) => p.id);
    const allSelectedOnPage = pageProductIds.every((id) => selectedProductIds.includes(id));

    if (allSelectedOnPage) {
      setSelectedProductIds((prev) => prev.filter((id) => !pageProductIds.includes(id)));
    } else {
      setSelectedProductIds((prev) => {
        const newSelection = [...prev];
        pageProductIds.forEach((id) => {
          if (!newSelection.includes(id)) {
            newSelection.push(id);
          }
        });
        return newSelection;
      });
    }
  }, [products, selectedProductIds, beginSelectionRequest, editRemainder]);

  const handleBulkAction = async (action: BulkQuickAction | 'category' | 'inventory' | 'pricing' | 'stores', payload: any = {}) => {
    if (!accessToken || selectedProductIds.length === 0) return;
    // Authority again in the handler, not only on the control: a bulk call
    // reaches every product of the company, and store re-assignment
    // additionally requires an un-narrowed actor.
    if (!canBulkMutate) return;
    if (action === 'stores' && !canAssignStores) return;
    // Archival in bulk obeys the same predicate as archival of one product,
    // so 500 products cannot do what 1 is refused (P5-A2 canonical family 7).
    if ((action === 'archive' || action === 'restore') && !canArchive) return;
    /*
     * ONE RUN AT A TIME. Decided on a ref, before any await, because a second
     * click arrives long before the first run's state has rendered. Without
     * this, two runs send overlapping chunks for the same ids and the slower
     * one's answer overwrites the faster one's result.
     */
    if (bulkRunningRef.current) return;
    bulkRunningRef.current = true;
    setBulkRunning(action);
    /*
     * WHAT THIS RUN IS FOR. The ids it was given, the scope they were chosen
     * under, and a ticket for the selection as it stands now. A run may take
     * minutes; by the time it answers the reader may have cleared the
     * selection, edited it, or moved to another search entirely. Its results
     * are still worth showing, but they may not be installed as a selection
     * unless both of these still hold.
     */
    const runScope = scopeKey;
    const runIds = selectedProductIds;
    const selectionStillMine = beginSelectionRequest();
    setLoading(true);
    setError(null);
    setBulkResult(null);
    // A new run makes the previous run's report history, not "the last bulk
    // action". It goes now, and this run writes its own if it needs one.
    setRunReport(null);
    try {
      let endpoint = `/bulk/products/${action}`;
      let body: any = {};

      if (action === 'publish') {
        endpoint = '/bulk/products/status';
        body.status = 'PUBLISHED';
      } else if (action === 'draft') {
        endpoint = '/bulk/products/status';
        body.status = 'DRAFT';
      } else {
        body = { ...body, ...payload };
      }

      /*
       * SENT IN BOUNDED CHUNKS. The server walks the ids one at a time inside
       * one request, so a selection of thousands could pass the gateway's
       * timeout after writing part of the set — an outcome nobody could
       * report. Several bounded requests instead mean every id ends in a
       * known state, and the run says which ids were never sent.
       */
      const run = await runChunkedBulk({
        accessToken,
        endpoint,
        ids: runIds,
        body,
        onProgress: (sent, total) => setBulkProgress(total > 1 ? { sent, total } : null),
      });
      setBulkProgress(null);
      /*
       * The generic results panel knows only successes and failures. For a
       * run that stopped, the report below says everything it would — and the
       * unconfirmed and never-sent ids it cannot — so the panel is shown
       * beside it only when it has per-id failure details to add. Otherwise it
       * would read "0 successes, 0 failures" next to ids in doubt.
       */
      const stopped = run.unconfirmedIds.length > 0 || run.notAttemptedIds.length > 0;
      if (!stopped || run.failures.length > 0) {
        setBulkResult({
          successCount: run.successCount,
          failedCount: run.failedCount,
          successes: run.successes,
          failures: run.failures,
        });
      }
      const retrySafe = isRetrySafe(action);
      /*
       * THE REPORT IS ALWAYS KEPT, even when the selection may not be touched.
       * Its ids belong to the scope the run started in, and it says so, so a
       * reader who has since moved elsewhere can still see what happened and
       * which ids are in doubt.
       */
      if (run.unconfirmedIds.length > 0 || run.notAttemptedIds.length > 0 || run.failedCount > 0) {
        const nameOf = (id: string) => products.find((p) => p.id === id)?.name ?? null;
        setRunReport({
          scope: runScope,
          action,
          confirmed: run.successCount,
          failures: run.failures,
          unconfirmed: run.unconfirmedIds.map((id) => ({ id, name: nameOf(id) })),
          notAttempted: run.notAttemptedIds.length,
          retrySafe,
        });
      }
      /*
       * MAY THIS RUN STILL SPEAK FOR THE SELECTION? Only if the scope has not
       * moved and nobody has touched the selection since it started. A Clear
       * during the run, a ticked row, a new search — any of them means the
       * reader has said what the selection is, and a late completion does not
       * get to overrule that or drop old-scope ids into a new list.
       */
      const mayInstall = scopeKeyRef.current === runScope && selectionStillMine();

      if (run.unconfirmedIds.length > 0 || run.notAttemptedIds.length > 0) {
        /*
         * A PARTIAL RUN IS NOT A FINISHED ONE, AND NOT ALL OF ITS LEFTOVERS
         * ARE THE SAME.
         *
         * What the server confirmed stays confirmed. The chunk whose request
         * failed is UNCONFIRMED — it may have been applied before the answer
         * was lost — and the chunks after it were never sent.
         *
         * Which of those may be re-selected depends on the action. An
         * absolute write (status, category, stock, price, shops) lands the
         * same way twice, so the whole remainder is re-selected and running
         * the action again finishes the job. Archive and restore refuse a
         * repeat, so re-selecting the unconfirmed ids would make a second run
         * report real successes as failures: those ids are named for a person
         * to check and deliberately left OUT of the selection, which is what
         * stops an accidental re-run from touching them.
         */
        const remainder = retrySafe
          ? [...run.unconfirmedIds, ...run.notAttemptedIds]
          : [...run.notAttemptedIds];
        const record: CrossPageSelection = {
          kind: 'remainder',
          scope: scopeKey,
          total: remainder.length,
          action,
          unconfirmed: run.unconfirmedIds,
          notAttempted: run.notAttemptedIds,
          confirmed: run.successCount,
          failed: run.failedCount,
          retrySafe,
        };
        // The remainder is a cross-page selection like any other: it belongs
        // to the scope, so paging cannot quietly lose it — and it is installed
        // only while it still describes the list the reader is looking at.
        if (mayInstall) {
          if (remainder.length > 0) {
            beginSelectionRequest();
            setSelectedProductIds(remainder);
            matchingSelectionRef.current = record;
            setMatchingSelection(record);
            setSelectionTooLarge(null);
          } else {
            // Nothing may be retried — an archive whose unconfirmed ids must
            // be looked at by a person. The run still consumed the selection,
            // so leaving it ticked would invite exactly the second run that
            // must not happen. The report below keeps the ids.
            resetSelection();
          }
        }
        toast.error(
          t('{confirmed} confirmed, {failed} refused, {unconfirmed} unconfirmed, {notAttempted} never sent', {
            confirmed: nf(run.successCount),
            failed: nf(run.failedCount),
            unconfirmed: nf(run.unconfirmedIds.length),
            notAttempted: nf(run.notAttemptedIds.length),
          }),
        );
      } else {
        // Nothing left over. The selection this run consumed is cleared only
        // if it is still the selection the reader has.
        if (mayInstall) resetSelection();
        /*
         * "CONFIRMED", NOT "UPDATED". The server reports which ids it accepted,
         * not which ones actually changed: setting a published item to
         * published is accepted and alters nothing. Saying "updated" would
         * claim a change nobody verified.
         */
        if (run.failedCount > 0) {
          toast.error(t('{n} items confirmed, {failed} refused', { n: nf(run.successCount), failed: nf(run.failedCount) }));
        } else {
          toast.success(t('{n} items confirmed', { n: nf(run.successCount) }));
        }
      }
      await fetchProducts(true);
    } catch (err: any) {
      setError(err.message || `Bulk ${action} operation failed`);
      setLoading(false);
    } finally {
      // Released whatever happened, so a failure cannot lock the controls out.
      bulkRunningRef.current = false;
      setBulkRunning(null);
      setBulkProgress(null);
      setActiveBulkModal(null);
    }
  };

  /*
   * WEBSITE PUBLICATION (ADR 029): publish or hide the selection on ONE website.
   *
   * Sent in sequential chunks of at most 1,000 ids and combined into one
   * result. A failed request stops the run; what was not answered is shown
   * as "not attempted" and re-sent only from the panel's own button — the
   * operation is idempotent, so a retry cannot double-apply anything, but the
   * decision to retry is the person's.
   */
  const handleWebsitePublication = async (
    storeId: string,
    published: boolean,
    ids = selectedProductIds,
    /** The finished run an explicit retry continues; its history is kept. */
    base: BulkBranchPublicationRun | null = null,
  ) => {
    if (!accessToken || ids.length === 0) return;
    // Authority again in the handler, not only on the control (D-4.2 pattern).
    if (!canBulkMutate || !canAssignStores) return;
    // The same one-run-at-a-time guard as the bulk bar. The panel's "retry
    // the not attempted" button runs this without the dialog that otherwise
    // covers the bar, so without it a publication retry and a bar action
    // could send chunks side by side.
    if (bulkRunningRef.current) return;
    bulkRunningRef.current = true;
    setBulkRunning('websitePublication');
    const websiteName = stores.find((s) => s.id === storeId)?.name ?? '';
    setWebsiteProgress({ sent: 0, total: 0 });
    setBulkResult(null);
    setRunReport(null);
    try {
      const attempt = await runBulkBranchPublication({
        accessToken,
        ids,
        storeId,
        published,
        onProgress: (sent, total) => setWebsiteProgress({ sent, total }),
      });
      // A retry folds into the run it continues: only the retried ids' "not
      // attempted" entries give way; every earlier decision keeps its message.
      const run = base ? foldRetry(base, attempt) : attempt;
      setWebsiteRun({ run, websiteName, refreshFailed: false });
      const summary = t('Website publication: {updated} updated, {unchanged} unchanged, {skipped} skipped, {failed} failed', {
        updated: run.updatedCount,
        unchanged: run.unchangedCount,
        skipped: run.skippedParentCount,
        failed: run.failedCount,
      });
      if (run.failure) {
        toast.error(t('Website publication stopped: {notAttempted} not attempted', { notAttempted: run.notAttemptedCount }));
      } else if (run.failedCount > 0) {
        toast.error(summary);
      } else {
        toast.success(summary);
      }
      resetSelection();
      // The writes are done and reported above. Reloading the list is a
      // separate act: if it fails, the result stays and the failure is named
      // for what it is, never as the operation failing.
      let refreshed = false;
      try {
        refreshed = (await fetchProducts(true)) === true;
      } catch {
        refreshed = false;
      }
      if (!refreshed) {
        setWebsiteRun({ run, websiteName, refreshFailed: true });
        toast.error(t('The list could not be refreshed; the website publication itself completed.'));
      }
    } catch (err: any) {
      // Nothing above should throw — request failures are outcomes — but a
      // rejection must never escape to the dialog as an unhandled promise.
      toast.error(err?.message || t('Website publication could not be completed'));
    } finally {
      bulkRunningRef.current = false;
      setBulkRunning(null);
      setWebsiteProgress(null);
      setActiveBulkModal(null);
    }
  };

  const startEdit = (product: Product) => {
    setEditingProduct(product);
    setIsFormOpen(true);
    setManagingProductImages(null);
  };

  const startCreate = () => {
    setEditingProduct(null);
    setIsFormOpen(true);
    setManagingProductImages(null);
  };

  // The state b2ef800 promised and never wired: a session that names no
  // company is told so, instead of an empty table that reads as "this company
  // has no products" about a company nobody chose.
  if (scope && !scope.organizationId) {
    return <NoOrganizationContext what={t('The catalogue')} />;
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold text-slate-800">{t('Items')}</h2>
          <p className="text-xs text-slate-500 mt-1">{t('Everything your websites can show: products, dishes, services, gallery pieces')}</p>
        </div>
        {/* Named, because it is no longer the only Add Item on the page: the
            true-empty state offers one too, and addressing either by its label
            alone is ambiguous the moment the catalogue is empty. */}
        {canManage && (
          <Button data-testid="add-item" tooltip={t('Create a new item in the catalog')} onClick={startCreate}>
            {t('Add Item')}
          </Button>
        )}
      </div>

      {error && (
        <div role="alert" data-testid="list-error" className="p-4 bg-red-50 border border-red-200 text-red-700 text-xs rounded-md">
          {error}
        </div>
      )}

      {bulkResult && (
        <BulkResultPanel result={bulkResult} products={products} onDismiss={() => setBulkResult(null)} />
      )}

      {/*
         WHAT A STOPPED RUN LEFT IN DOUBT, ON SCREEN UNTIL SOMEBODY CLOSES IT.

         A toast lasts seconds and the bulk bar leaves with the selection, so
         neither can hold ids a person still has to reconcile. When archive or
         restore loses a chunk's answer, nothing may be re-selected on those
         ids' behalf — this is the only place their identity survives, so it
         names each one and says what was attempted.
       */}
      {runReport && (
        <div
          role="region"
          aria-label={t('Result of the last bulk action')}
          data-testid="run-report"
          className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-xs text-amber-900 space-y-2"
        >
          {/* Wraps rather than squeezing: at a phone width the column is
              narrow, and Dismiss must stay whole and reachable. */}
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
            <p className="font-bold min-w-0 break-words" data-testid="run-report-summary">
              {t('{action}: {confirmed} confirmed, {failed} refused, {unconfirmed} unconfirmed, {notAttempted} never sent', {
                action: runReport.action,
                confirmed: nf(runReport.confirmed),
                failed: nf(runReport.failures.length),
                unconfirmed: nf(runReport.unconfirmed.length),
                notAttempted: nf(runReport.notAttempted),
              })}
            </p>
            <button
              onClick={() => setRunReport(null)}
              data-testid="run-report-dismiss"
              className="font-bold text-primary hover:underline whitespace-nowrap"
            >
              {t('Dismiss')}
            </button>
          </div>
          {runReport.unconfirmed.length > 0 && (
            <div className="space-y-1" data-testid="run-report-unconfirmed">
              <p>
                {runReport.retrySafe
                  ? t(
                      'These {n} could not be confirmed. Running the same action again is safe and will settle them.',
                      { n: nf(runReport.unconfirmed.length) },
                    )
                  : t(
                      'These {n} could not be confirmed, and {action} cannot be safely repeated on them. Check each one before deciding what to do.',
                      { n: nf(runReport.unconfirmed.length), action: runReport.action },
                    )}
              </p>
              {/* Each id opens its Item, archived or not, so it can be checked
                  one by one. Ids break anywhere: an unbroken id is wider than
                  a phone's column. */}
              <ul className="max-h-40 overflow-y-auto pl-4 list-disc">
                {runReport.unconfirmed.map((item) => (
                  <li key={item.id} data-testid="run-report-unconfirmed-item" className="break-all">
                    <Link href={`/dashboard/products/${item.id}`} className="text-primary hover:underline">
                      {item.name ? `${item.name} (${item.id})` : item.id}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {websiteRun && (
        <BulkWebsitePublicationResult
          run={websiteRun.run}
          websiteName={websiteRun.websiteName}
          products={products}
          progress={websiteProgress}
          refreshFailed={websiteRun.refreshFailed}
          // Not offered while a bulk-bar action runs: one run at a time. Its
          // own retry in flight is shown by the panel's progress instead.
          onRetryNotAttempted={
            bulkRunning !== null && bulkRunning !== 'websitePublication'
              ? undefined
              : () =>
                  handleWebsitePublication(
                    websiteRun.run.storeId,
                    websiteRun.run.published,
                    websiteRun.run.notAttemptedIds,
                    websiteRun.run,
                  )
          }
          onDismiss={() => setWebsiteRun(null)}
        />
      )}

      <ProductFilters
        stores={stores}
        filters={filters}
        categories={categories}
        onChange={updateFilters}
        onReset={() => setFilters(DEFAULT_PRODUCT_FILTERS)}
      />

      <SuggestionsBanner
        suggestions={suggestions}
        canManage={canManage}
        open={suggestionsOpen}
        busyName={suggestionBusy}
        onToggle={() => setSuggestionsOpen((open) => !open)}
        // EXPLICIT: reviewing opens the modal with the suggestion's own
        // members. It never writes into the table's selection.
        onReview={(suggestion) => setReviewing(suggestion)}
        onDismiss={async (suggestion) => {
          if (!accessToken) return;
          setSuggestionBusy(suggestion.name);
          try {
            await familySuggestionsService.dismiss(accessToken, suggestion.name);
            toast.success(t('Suggestion dismissed — it will not come back'));
            // The suggestion is gone and the tile counts move with it.
            await fetchSuggestions();
          } catch (err: any) {
            toast.error(err?.message || t('Could not dismiss the suggestion'));
          } finally {
            setSuggestionBusy(null);
          }
        }}
      />

      {loading && (!loadedOnce || productsTenant !== tenantKey) ? (
        <div className="text-slate-500 text-sm">{t('Fetching product directory...')}</div>
      ) : (
        /* Bottom room for the FIXED bulk bar. Without it the bar sits over the
           last rows, and at a narrow width — where it wraps to two lines — a
           checkbox underneath it cannot be clicked at all, so a second item
           could not be selected. Proven by the 390px browser test.

           A RELOAD keeps everything mounted. Replacing the list with a line of
           text on every page change threw keyboard focus to the document body
           and took the page controls away mid-navigation. The rows that are
           still on screen are dimmed and marked busy, and the pagination stays
           where the reader's focus is. The summary and the current-page marker
           keep describing the rows on screen — "Page 8 of 20 · 480 items" —
           while the status line names the page on its way: "Loading page 9 of
           20…". Only when the answer is applied do rows, totals, summary and
           marker move, together. The pagination is not shown while no page is
           answered for the filters on screen (the first load, or a scope that
           has just changed under older rows): there is no page to describe. */
        <div className="space-y-4">
          {loading && (
            <p role="status" aria-live="polite" className="text-xs text-slate-500" data-testid="list-reloading">
              {answeredPage === null
                ? t('Loading page {page}…', { page })
                : t('Loading page {page} of {totalPages}…', { page, totalPages })}
            </p>
          )}
          <div
            aria-busy={loading || undefined}
            data-testid="list-body"
            className={loading ? 'space-y-4 opacity-60 transition-opacity' : 'space-y-4 transition-opacity'}
          >
          {/*
             WHAT IS SELECTED, IN WORDS, BEFORE ANYTHING RUNS.

             A count alone cannot tell "25" the page from "25" the whole
             filter, and the bulk bar below only ever shows a number. This
             line says which of the two it is whenever anything is selected —
             not only when the page happens to be full — and offers the other
             choice beside it. `role="status"` so the change of scope is
             announced rather than only seen.
           */}
          {/*
             ALWAYS MOUNTED, SO THE FIRST SELECTION IS ALSO ANNOUNCED. A live
             region that appears at the same moment as its text is not read
             out: assistive technology has nothing to compare against. This one
             is always in the tree and only its text changes. The visible line
             below is not itself a live region, because a region that contains
             buttons re-announces them every time the count changes.
           */}
          <div role="status" aria-live="polite" className="sr-only" data-testid="selection-announcement">
            {selectionSentence}
          </div>
          {canManage && selectedProductIds.length > 0 && (
            <div
              data-testid="selection-summary"
              data-selection-scope={crossPageSelection ? crossPageSelection.kind : 'page'}
              className={
                crossPageSelection
                  ? 'flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-2 text-xs text-emerald-800'
                  : 'flex flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-lg bg-slate-100 border border-line px-4 py-2 text-xs text-slate-600'
              }
            >
              <span className="font-semibold" data-testid="selection-scope-text">
                {selectionSentence}
              </span>
              {!crossPageSelection && !searchSettling && totalItems > selectedProductIds.length && (
                <button
                  onClick={selectAllMatching}
                  data-testid="select-all-matching"
                  className="font-bold text-primary hover:underline"
                >
                  {hasActiveFilters
                    ? t('Select all {n} matching these filters', { n: nf(totalItems) })
                    : t('Select all {n} items', { n: nf(totalItems) })}
                </button>
              )}
              {crossPageSelection?.kind === 'matching' && (
                <button
                  onClick={selectThisPageOnly}
                  data-testid="select-page-only"
                  className="font-bold text-primary hover:underline"
                >
                  {t('Select only this page')}
                </button>
              )}
              <button onClick={resetSelection} data-testid="clear-selection" className="font-bold text-primary hover:underline">
                {t('Clear selection')}
              </button>
            </div>
          )}
          {/*
             TOO MANY TO SELECT AT ONCE. The snapshot is refused rather than
             trimmed, so the reader is told the real number and what to do,
             instead of being handed an arbitrary part of it under a label
             that says "all".
           */}
          {canManage && tooLargeForScope && (
            <div
              role="alert"
              data-testid="selection-too-large"
              className="rounded-lg bg-amber-50 border border-amber-200 px-4 py-2 text-xs text-amber-900"
            >
              {t(
                '{total} items match these filters, more than the {cap} that can be selected at once. Narrow the filters and try again.',
                { total: nf(tooLargeForScope.total), cap: nf(tooLargeForScope.cap) },
              )}
            </div>
          )}
          <ProductTable
            products={products}
            canManage={canManage}
            canArchive={canArchive}
            filtered={hasActiveFilters}
            onAddItem={() => {
              setEditingProduct(null);
              setNewKind('item');
              setIsFormOpen(true);
            }}
            onClearFilters={() => setFilters(DEFAULT_PRODUCT_FILTERS)}
            onEdit={startEdit}
            onArchive={(id: string) => {
              const product = products.find((p) => p.id === id);
              if (product) setArchiveTarget(product);
            }}
            onRestore={handleRestore}
            selectedProductIds={selectedProductIds}
            onToggleSelect={handleToggleSelect}
            onToggleSelectAll={handleToggleSelectAll}
            branchFilterStoreId={effectiveFilters.storeId || null}
            websiteUrlForProduct={(product: Product) => {
              const store = (product.stores || []).find((s) => s.websiteUrl);
              return store
                ? buildWebsiteUrl(
                    {
                      websiteUrl: store.websiteUrl!,
                      websiteProductPath: store.websiteProductPath || '/products/{slug}',
                      websiteCategoryPath: '/categories/{slug}',
                    },
                    'product',
                    product.slug,
                  )
                : null;
            }}
          />

          </div>
          {answeredPage !== null && (
            <Pagination page={answeredPage} totalPages={totalPages} total={totalItems} onPageChange={goToPage} />
          )}
        </div>
      )}

      <BulkActionsBar
        count={selectedProductIds.length}
        busy={bulkRunning !== null}
        groupBlockedReason={
          selectionFullyLoaded
            ? reasonGroupingBlocked(
                products.filter((p) => selectedProductIds.includes(p.id)),
                t,
              )
            : t(
                'Grouping needs every selected item on screen. {n} are selected across pages — select them on one page to group them.',
                { n: nf(selectedProductIds.length) },
              )
        }
        canManage={canBulkMutate}
        canAssignStores={canAssignStores}
        canArchive={canArchive}
        onClear={() => {
          resetSelection();
          setBulkResult(null);
        }}
        onQuickAction={(action) => handleBulkAction(action)}
        onOpenModal={setActiveBulkModal}
      />

      <Modal
        open={isFormOpen && canManage}
        title={editingProduct ? `${t('Edit Item')}: ${editingProduct.name}` : t('New Item')}
        onClose={() => {
          setIsFormOpen(false);
          setEditingProduct(null);
        }}
        className="max-w-2xl"
      >
        {editingProduct && canManage && (
          <div className="flex items-center justify-between gap-3 flex-wrap mb-4 pb-4 border-b border-slate-100">
            <p className="text-xs text-slate-500">{t('Photos of this item:')}</p>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="secondary"
                tooltip={t('Upload and organize product photos')}
                onClick={() => setManagingProductImages(editingProduct)}
              >
                {t('Images')}
              </Button>
            </div>
          </div>
        )}
        {/* The first question, asked only when something NEW is being added. */}
        {!editingProduct && (
          <div className="flex gap-4 pb-4 mb-4 border-b border-slate-100" data-testid="new-kind-chooser">
            {(
              [
                ['item', t('A single item you sell')],
                ['card', t('A parent card with child products')],
              ] as const
            ).map(([kind, label]) => (
              <label key={kind} className="inline-flex items-center gap-2 text-xs font-medium text-slate-700">
                <input
                  type="radio"
                  name="new-kind"
                  data-testid={`new-kind-${kind}`}
                  checked={newKind === kind}
                  onChange={() => setNewKind(kind)}
                  className="text-primary focus:ring-primary"
                />
                {label}
              </label>
            ))}
            {newKind === 'card' && (
              <p className="text-[11px] text-slate-500 basis-full">
                {t('A card is never sold. Its child products carry the price and the stock.')}
              </p>
            )}
          </div>
        )}

        {!editingProduct && newKind === 'card' ? (
          <CreateParentCardForm
            candidates={cardCandidates}
            searching={cardSearching}
            onSearch={async (term) => {
              if (!accessToken) return;
              setCardSearching(true);
              try {
                // The SERVER decides what may be a child: `family=standalone`
                // leaves out anything already grouped and every existing card.
                const query = `search=${encodeURIComponent(term)}&family=standalone&limit=10`;
                const response = await apiFetch(`/products?${query}`, { token: accessToken });
                setCardCandidates(response?.items ?? []);
              } finally {
                setCardSearching(false);
              }
            }}
            onCancel={() => {
              setIsFormOpen(false);
              setCardCandidates([]);
            }}
            onCreate={async (input) => {
              const created = await familyService.createFamily(
                accessToken as string,
                input.name,
                input.members,
                { description: input.description, metaTitle: input.metaTitle, metaDescription: input.metaDescription },
              );
              setIsFormOpen(false);
              setCardCandidates([]);
              toast.success(t('Card created — its children are attached'));
              router.push(`/dashboard/products/${created.id}`);
              return created.id;
            }}
          />
        ) : (
        <ProductForm
          key={editingProduct?.id ?? 'new'}
          initialValues={editingProduct}
          categories={categories}
          stores={stores}
          // #282: the SAME predicate the bulk store-assignment control uses.
          // One capability, two surfaces — a branch-scoped actor is refused
          // whole-set membership replacement in both, and the single-item form
          // no longer offers what the bulk bar already hides.
          canAssignStores={canAssignStores}
          onSubmit={handleCreateOrUpdate}
          onCancel={() => {
            setIsFormOpen(false);
            setEditingProduct(null);
          }}
        />
        )}
      </Modal>

      {/* The image manager renders after the edit modal so it overlays it */}
      {managingProductImages && (
        <ProductImagesPanel
          product={managingProductImages}
          accessToken={accessToken || ''}
          canManage={canManage}
          onClose={() => setManagingProductImages(null)}
          onRefreshProducts={fetchProducts}
        />
      )}

      <ConfirmModal
        open={archiveTarget !== null}
        title={t('Archive Product')}
        message={
          <>
            Archive <span className="font-semibold">{archiveTarget?.name}</span>? It will disappear from
            the public catalogue but can be restored at any time.
          </>
        }
        confirmLabel="Archive"
        danger
        onConfirm={handleArchive}
        onCancel={() => setArchiveTarget(null)}
      />

      {activeBulkModal === 'category' && (
        <BulkCategoryModal
          categories={categories}
          onSubmit={(data: any) => handleBulkAction('category', data)}
          onClose={() => setActiveBulkModal(null)}
        />
      )}

      {activeBulkModal === 'inventory' && (
        <BulkInventoryModal
          onSubmit={(data: any) => handleBulkAction('inventory', data)}
          onClose={() => setActiveBulkModal(null)}
        />
      )}

      {activeBulkModal === 'pricing' && (
        <BulkPricingModal
          onSubmit={(data: any) => handleBulkAction('pricing', data)}
          onClose={() => setActiveBulkModal(null)}
        />
      )}

      {activeBulkModal === 'stores' && (
        <BulkStoresModal
          stores={stores}
          onSubmit={(data: any) => handleBulkAction('stores', data)}
          onClose={() => setActiveBulkModal(null)}
        />
      )}

      {activeBulkModal === 'websitePublication' && (
        <BulkWebsitePublicationModal
          stores={stores}
          selectedCount={selectedProductIds.length}
          selectedOnPage={products.filter((p) => selectedProductIds.includes(p.id))}
          initialStoreId={effectiveFilters.storeId || null}
          onRun={(storeId, published) => handleWebsitePublication(storeId, published)}
          onClose={() => setActiveBulkModal(null)}
        />
      )}

      {/* The SAME modal manual grouping opens — one preflight, one preview, one
          set of refusals — preseeded with the suggestion's own members and its
          proposed name, both still editable. */}
      {reviewing && (
        <GroupAsFamilyModal
          selected={reviewing.members.map(
            (m) =>
              (products.find((p) => p.id === m.id) ?? {
                id: m.id,
                name: m.name,
                price: m.price,
                status: m.status,
              }) as never,
          )}
          initialName={reviewing.name}
          initialLabels={Object.fromEntries(reviewing.members.map((m) => [m.id, m.label]))}
          onCancel={() => setReviewing(null)}
          onValidate={(name, members) => familyService.validateFamily(accessToken as string, name, members)}
          onConfirm={async (name, members) => {
            const created = await familyService.createFamily(accessToken as string, name, members);
            setReviewing(null);
            toast.success(t('Grouped — the new parent card is ready'));
            // Everything this changed, refetched: the suggestion is gone, the
            // items are now a family, and the counts move with them.
            await Promise.all([fetchSuggestions(), fetchProducts(true)]);
            return created.id;
          }}
        />
      )}

      {/* Never opened for a selection whose records are not all loaded: the
          bar blocks it, and this is the second lock on the same door. */}
      {activeBulkModal === 'group' && selectionFullyLoaded && (
        <GroupAsFamilyModal
          selected={products.filter((p) => selectedProductIds.includes(p.id))}
          onCancel={() => setActiveBulkModal(null)}
          /* Advisory: the backend answers, the interface only relays. */
          onValidate={(name, members) => familyService.validateFamily(accessToken as string, name, members)}
          onConfirm={async (name, members) => {
            const created = await familyService.createFamily(accessToken as string, name, members);
            setActiveBulkModal(null);
            resetSelection();
            toast.success(t('Grouped — the new parent card is ready'));
            // Straight to the family that was just made, which is the only
            // place its shape can actually be seen. This page reads its query
            // from `window.location` rather than the router (see the Suspense
            // note above), so navigation stays consistent with that.
            router.push(`/dashboard/products/${created.id}`);
            return created.id;
          }}
        />
      )}
</div>
  );
}
