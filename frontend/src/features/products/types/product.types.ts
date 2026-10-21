import type { CategoryRef } from '../../categories/types/category.types';

export interface Product {
  id: string;
  name: string;
  slug: string;
  description?: string;
  metaTitle?: string | null;
  metaDescription?: string | null;
  stores?: { id: string; name: string; slug: string; websiteUrl?: string | null; websiteProductPath?: string | null }[];
  storePrices?: { store: string | { id: string }; price: number; salePrice?: number | null }[];
  /** P0-06: per-branch link rows (published, price, stock). */
  branchLinks?: {
    store: string | { id: string };
    published?: boolean;
    price?: number | null;
    salePrice?: number | null;
    stockQuantity?: number;
    trackInventory?: boolean;
    /** Days THIS branch needs to deliver. Null = not stated, not zero. */
    leadTimeDays?: number | null;
  }[];
  sku?: string;
  /**
   * The SUPPLIER's reference (P5-W1). A different identity from `sku`:
   * never unique, never derived from it, and never shown to customers.
   */
  manufacturerCode?: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  saleMode?: 'DIRECT' | 'ON_REQUEST';
  /** Every folder the item is filed under. */
  categories?: CategoryRef[];
  optionLabel?: string | null;
  /** Set when this item is a child of a parent product. */
  parent?: { id: string; name: string } | string | null;
  /** Set when this item IS a parent: its child products. */
  children?: { id: string; name: string; optionLabel?: string | null }[];
  price?: number;
  salePrice?: number | null;
  cost?: number | null;
  stockQuantity?: number;
  trackInventory?: boolean;
}

export interface BulkResult {
  successCount: number;
  failedCount: number;
  successes: string[];
  failures: { id: string; message: string }[];
}

/**
 * One product's outcome in a bulk per-website publication (ADR 029), as the
 * server reports it. `NOT_ATTEMPTED` is CLIENT-ONLY: the selection is sent in
 * sequential chunks of at most 1,000 ids, and when a chunk's request fails the
 * ids of that chunk and of every later chunk were never sent (or their answer
 * never arrived). They are shown as such, and re-sent only when the person
 * asks — never implicitly.
 */
export type BranchPublicationOutcome = 'UPDATED' | 'UNCHANGED' | 'SKIPPED_PARENT' | 'FAILED' | 'NOT_ATTEMPTED';

export interface BranchPublicationItemOutcome {
  id: string;
  outcome: BranchPublicationOutcome;
  message?: string;
  /** UPDATED / UNCHANGED only: a global Draft stays off the website until published globally. */
  globalStatus?: 'DRAFT' | 'PUBLISHED';
}

/** The server's answer for ONE chunk. */
export interface BulkBranchPublicationResult {
  storeId: string;
  published: boolean;
  updatedCount: number;
  unchangedCount: number;
  skippedParentCount: number;
  failedCount: number;
  outcomes: BranchPublicationItemOutcome[];
}

/**
 * The request that stopped a run. Structured, not a sentence: the panel
 * renders it through `t()`, so the language is the reader's, not the code's.
 * `chunkIndex` is 1-based.
 */
export interface BranchPublicationRequestFailure {
  chunkIndex: number;
  chunkCount: number;
  message: string;
}

/** The combined result of a whole run — every chunk, plus what was never attempted. */
export interface BulkBranchPublicationRun extends BulkBranchPublicationResult {
  notAttemptedCount: number;
  /** In selection order; what an explicit retry re-sends. */
  notAttemptedIds: string[];
  /** The request failure that stopped the run (or its retry), when one did. */
  failure: BranchPublicationRequestFailure | null;
  chunksSent: number;
  chunksTotal: number;
}

/** Progress of the run currently in flight — separate from any finished run. */
export interface BranchPublicationProgress {
  sent: number;
  total: number;
}

export interface ProductFilterState {
  search: string;
  status: string;
  categoryId: string;
  trackInventory: string;
  hasChildren: string;
  /** '' | 'parent' | 'child' | 'standalone' — the hierarchy role. */
  family: string;
  /**
   * Which BRANCH the item belongs to. The backend has accepted this since
   * P0-06 and the panel never asked: "what does Norte actually sell?" was
   * unanswerable from the catalogue list (Phase 8).
   */
  storeId: string;
  /**
   * '' | 'true' | 'false' — published or hidden ON the `storeId` website
   * (ADR 029). Meaningless without a branch, so the control only appears once
   * one is chosen and is cleared when the branch is.
   */
  branchPublished: string;
  showArchived: boolean;
  minPrice: string;
  maxPrice: string;
  hasSalePrice: string;
  hasImages: string;
  hasCategory: string;
  /** '' | 'true' | 'false' — sellable NOW per the AVAILABLE ledger (Phase 8). */
  sellable: string;
  /** '' | 'true' | 'false' — the publication guard's completeness (Phase 8). */
  complete: string;
  sortBy: string;
  sortDirection: 'asc' | 'desc';
}

export const DEFAULT_PRODUCT_FILTERS: ProductFilterState = {
  search: '',
  status: '',
  categoryId: '',
  trackInventory: '',
  hasChildren: '',
  family: '',
  storeId: '',
  branchPublished: '',
  showArchived: false,
  minPrice: '',
  maxPrice: '',
  hasSalePrice: '',
  hasImages: '',
  hasCategory: '',
  sellable: '',
  complete: '',
  sortBy: 'createdAt',
  sortDirection: 'desc',
};

/** The option label of a product or family member. */
export const labelOf = (item: { optionLabel?: string | null }): string | null => item.optionLabel ?? null;
