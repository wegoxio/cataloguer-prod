/**
 * CSV formula-injection neutralization.
 *
 * A spreadsheet treats a cell beginning `=`, `+`, `-`, `@`, a tab or a carriage
 * return as a formula, so a product name a tenant typed — or that arrived
 * through an import — can execute in whoever opens the export. Quoting does NOT
 * prevent this: Excel and LibreOffice unquote first, then evaluate.
 *
 * The neutralization is the OWASP-recommended one: prefix the cell with a single
 * apostrophe, which spreadsheets consume as "treat the rest as text". It is
 * applied at the export boundary only, so stored data keeps the tenant's exact
 * bytes and a round-trip through import → export never mutates a real value.
 *
 * We deliberately do NOT strip characters. Removing a leading `-` would corrupt
 * negative numbers, and removing `=` would silently change a name DesignHof
 * chose. Prefixing is reversible and visible.
 */

/** Characters that make a spreadsheet treat the rest of the cell as a formula. */
const FORMULA_LEADERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * True when `value` would be interpreted as a formula by a spreadsheet.
 * Numbers are safe: a bare `-12.5` is only dangerous as a *string* cell, and we
 * only ever receive strings here, so the caller decides numeric provenance.
 */
export function isFormulaLike(value: string): boolean {
  return value.length > 0 && FORMULA_LEADERS.has(value[0]);
}

/**
 * Neutralize one cell. Non-strings pass through untouched so callers can hand us
 * already-typed values without stringifying them first.
 */
export function neutralizeCsvCell<T>(value: T): T | string {
  if (typeof value !== 'string') return value;
  return isFormulaLike(value) ? `'${value}` : value;
}

/**
 * Neutralize every string cell of a row object. Returns a new object; the input
 * is never mutated, because export rows are often the same entities the request
 * is still using.
 */
export function neutralizeCsvRow<T extends Record<string, unknown>>(row: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row)) out[key] = neutralizeCsvCell(row[key]);
  return out;
}

/** Neutralize a whole table of row objects. */
export function neutralizeCsvRows<T extends Record<string, unknown>>(rows: T[]): Record<string, unknown>[] {
  return rows.map(neutralizeCsvRow);
}
