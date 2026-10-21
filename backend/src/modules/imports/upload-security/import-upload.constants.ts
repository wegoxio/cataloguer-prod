/**
 * Constants shared by the two CSV import routes (#172). These are security
 * invariants intentionally fixed in code — only the byte limit and concurrency
 * permit count are operator-tunable (via validated env).
 */

/** DI token for the single per-container import-concurrency semaphore. */
export const IMPORT_CONCURRENCY_SEMAPHORE = 'IMPORT_CONCURRENCY_SEMAPHORE';

/**
 * Declared multipart MIME values a browser may send for a genuine `.csv`.
 * Treated as advisory (client-supplied), one layer among several.
 * `application/vnd.ms-excel` is included because several browsers label `.csv`
 * that way; it does NOT permit real Excel binaries — the extension gate does.
 */
export const CSV_MIME_ALLOWLIST: readonly string[] = [
  'text/csv',
  'application/csv',
  'text/plain',
  'application/vnd.ms-excel',
  'application/octet-stream', // some OSes omit a specific type
];

/**
 * C0 control bytes permitted inside a CSV: tab, LF, CR. Every other C0 control
 * (and NUL) marks the payload as binary, not text — rejected before parsing.
 */
export const ALLOWED_CONTROL_CODES: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0d]);

/** Max DATA records for a supplier-order import (mirrors the manual-entry cap). */
export const SUPPLIER_IMPORT_MAX_ROWS = 200;
