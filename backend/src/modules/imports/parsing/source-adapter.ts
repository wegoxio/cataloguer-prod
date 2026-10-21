import { ActiveContentFinding } from './archive-gate';
import { MergedRange } from './workbook-census';

/**
 * The contract every accepted document format implements.
 *
 * Adapters exist so that "which formats do we support" is a list of registered
 * implementations rather than a chain of `if (extension === …)`. Each adapter
 * answers three questions and nothing else: is this mine, what tables does it
 * contain, and what are the values in a chosen range. Deciding what those values
 * MEAN is the analyzer's job, and mutating anything is the executor's — an
 * adapter never reaches either.
 */

export type SourceKind = 'CSV' | 'TSV' | 'XLSX';

export interface SheetSummary {
  index: number;
  name: string;
  rowCount: number;
  columnCount: number;
  merged: MergedRange[];
  /** Formula census: expression text only, never evaluated. */
  formulas: { ref: string; formula: string; cachedValueMissing: boolean }[];
  blankRows: number[];
}

export interface SourceCensus {
  kind: SourceKind;
  sheets: SheetSummary[];
  /** Embedded binary payloads (images and the like), by package path. */
  mediaEntries: string[];
  /** Present only when the document carried something we refuse to open. */
  activeContent: ActiveContentFinding[];
  /** Encoding actually used to decode text sources. */
  encoding?: string;
  /** Delimiter actually detected for delimited text. */
  delimiter?: string;
  totalCells: number;
}

export interface ReadRangeOptions {
  sheetIndex: number;
  /** 1-based, inclusive. Omit for "from the first row". */
  fromRow?: number;
  /** 1-based, inclusive. Omit for "to the last row". */
  toRow?: number;
  /** Hard ceiling on rows returned, regardless of range. */
  maxRows: number;
  /** Hard ceiling on cells returned. */
  maxCells: number;
}

export interface RangeResult {
  rows: (string | number | boolean | null)[][];
  /** True when the range was cut short by `maxRows`/`maxCells`. */
  truncated: boolean;
  rowsRead: number;
  cellsRead: number;
}

export interface SourceAdapter {
  readonly kind: SourceKind;
  /**
   * Confidence in [0,1] that this adapter owns the bytes. Adapters decide from
   * CONTENT; the filename is only ever a tie-break, because it is client-supplied.
   */
  sniff(buffer: Buffer, fileName: string): number;
  census(buffer: Buffer, limits: AdapterLimits): SourceCensus;
  readRange(buffer: Buffer, options: ReadRangeOptions, limits: AdapterLimits): RangeResult;
}

export interface AdapterLimits {
  maxRows: number;
  maxCells: number;
  maxColumns: number;
  maxSheets: number;
  maxCellChars: number;
  maxPartBytes: number;
}

export const PREVIEW_LIMITS: AdapterLimits = {
  maxRows: 5_000,
  maxCells: 250_000,
  maxColumns: 200,
  maxSheets: 5,
  maxCellChars: 32 * 1024,
  maxPartBytes: 16 * 1024 * 1024,
};

export const JOB_LIMITS: AdapterLimits = {
  maxRows: 100_000,
  maxCells: 2_000_000,
  maxColumns: 200,
  maxSheets: 20,
  maxCellChars: 32 * 1024,
  maxPartBytes: 64 * 1024 * 1024,
};

export class SourceRejected extends Error {
  constructor(
    readonly code:
      | 'UNSUPPORTED_FORMAT'
      | 'TOO_MANY_ROWS'
      | 'TOO_MANY_CELLS'
      | 'TOO_MANY_COLUMNS'
      | 'TOO_MANY_SHEETS'
      | 'CELL_TOO_LARGE'
      | 'UNREADABLE',
    message: string,
  ) {
    super(message);
    this.name = 'SourceRejected';
  }
}

/**
 * Assert a shape against the budgets, naming the FIRST limit reached.
 *
 * Which limit fired matters to the person holding the file: "too many columns"
 * and "too much data" lead to different fixes, and a single generic "file too
 * large" would send them to the wrong one. Rows are checked last on purpose —
 * a wide file should be told about its width, not its length.
 */
export function assertWithinLimits(
  shape: { rows: number; columns: number; sheets?: number },
  limits: AdapterLimits,
): void {
  if (shape.sheets !== undefined && shape.sheets > limits.maxSheets) {
    throw new SourceRejected(
      'TOO_MANY_SHEETS',
      `This file has ${shape.sheets} sheets; we can analyze up to ${limits.maxSheets}. Split it and try again.`,
    );
  }
  if (shape.columns > limits.maxColumns) {
    throw new SourceRejected(
      'TOO_MANY_COLUMNS',
      `This file has ${shape.columns} columns; we can analyze up to ${limits.maxColumns}. Remove columns you do not need and try again.`,
    );
  }
  const cells = shape.rows * shape.columns;
  if (cells > limits.maxCells) {
    throw new SourceRejected(
      'TOO_MANY_CELLS',
      `This file holds about ${cells.toLocaleString()} cells; we can analyze up to ${limits.maxCells.toLocaleString()}. ` +
        `A wide file reaches that limit at fewer rows — split it into smaller files and import them in turn.`,
    );
  }
  if (shape.rows > limits.maxRows) {
    throw new SourceRejected(
      'TOO_MANY_ROWS',
      `This file has ${shape.rows.toLocaleString()} rows; we can analyze up to ${limits.maxRows.toLocaleString()}. Split it and try again.`,
    );
  }
}

/** Registry: first adapter with the highest confidence wins. */
export function selectAdapter(adapters: SourceAdapter[], buffer: Buffer, fileName: string): SourceAdapter {
  let best: { adapter: SourceAdapter; score: number } | null = null;
  for (const adapter of adapters) {
    const score = adapter.sniff(buffer, fileName);
    if (score > 0 && (!best || score > best.score)) best = { adapter, score };
  }
  if (!best) {
    throw new SourceRejected(
      'UNSUPPORTED_FORMAT',
      'We could not recognize this file. Upload a .csv, .tsv or .xlsx file — most systems can export one of these.',
    );
  }
  return best.adapter;
}
