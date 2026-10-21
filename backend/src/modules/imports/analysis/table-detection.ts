export type Cell = string | number | boolean | null;

/**
 * Finding the actual table inside a sheet.
 *
 * Real exports do not begin at A1 with a header. They begin with a title, a
 * blank line, a "generated on" stamp, sometimes a second table further down.
 * Assuming row 1 is the header — which the legacy importer does — silently maps
 * a report title onto a product name and imports garbage confidently.
 *
 * The heuristic scores candidate rows rather than picking the first non-empty
 * one, because the signal that distinguishes a header from a data row is not
 * "is it first" but "does it look unlike the rows beneath it": headers are
 * text, they are distinct from one another, they are dense, and the rows below
 * them are consistently the same width.
 */

export interface HeaderCandidate {
  rowIndex: number; // 1-based within the sheet
  score: number;
  reasons: string[];
  columnCount: number;
}

export interface DetectedTable {
  /** 1-based row holding the header. */
  headerRow: number;
  /** 1-based first and last data rows, inclusive. */
  firstDataRow: number;
  lastDataRow: number;
  headers: string[];
  columnCount: number;
  rowCount: number;
  confidence: number;
  reasons: string[];
}

const isBlank = (c: Cell): boolean => c === null || c === undefined || String(c).trim() === '';
const isBlankRow = (row: Cell[]): boolean => row.every(isBlank);

/** A header cell is text that is not purely numeric. */
const looksLikeHeaderCell = (c: Cell): boolean => {
  if (isBlank(c)) return false;
  if (typeof c === 'number' || typeof c === 'boolean') return false;
  const s = String(c).trim();
  if (/^-?[\d.,]+$/.test(s)) return false; // a number written as text
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return false; // a date
  return true;
};

/**
 * Score one row as a possible header.
 *
 * Each component is a property a header has and a data row usually does not.
 * They are summed rather than multiplied so a single imperfect signal — one
 * numeric column heading, say — cannot veto an otherwise obvious header.
 */
export function scoreHeaderRow(rows: Cell[][], index: number): HeaderCandidate {
  const row = rows[index] ?? [];
  const reasons: string[] = [];
  let score = 0;

  const filled = row.filter((c) => !isBlank(c));
  const columnCount = filled.length;
  if (columnCount < 2) {
    return { rowIndex: index + 1, score: 0, reasons: ['fewer than two filled cells'], columnCount };
  }

  const textish = filled.filter(looksLikeHeaderCell).length;
  const textRatio = textish / filled.length;
  score += textRatio * 40;
  if (textRatio > 0.8) reasons.push('cells are text, not values');

  // Headers name distinct things; a data row repeats values freely.
  const distinct = new Set(filled.map((c) => String(c).trim().toLowerCase())).size;
  const distinctRatio = distinct / filled.length;
  score += distinctRatio * 25;
  if (distinctRatio === 1) reasons.push('every heading is distinct');

  // A header is dense: few gaps between its first and last filled cell.
  const firstFilled = row.findIndex((c) => !isBlank(c));
  const lastFilled = row.length - 1 - [...row].reverse().findIndex((c) => !isBlank(c));
  const span = lastFilled - firstFilled + 1;
  const density = span > 0 ? filled.length / span : 0;
  score += density * 15;
  if (density > 0.9) reasons.push('no gaps across the row');

  // The rows beneath should agree on width. This is the strongest signal that
  // a row heads a TABLE rather than merely being some text.
  const below = rows.slice(index + 1, index + 11).filter((r) => !isBlankRow(r));
  if (below.length > 0) {
    const widths = below.map((r) => r.filter((c) => !isBlank(c)).length);
    const agreeing = widths.filter((w) => Math.abs(w - columnCount) <= Math.max(1, columnCount * 0.2)).length;
    const agreement = agreeing / below.length;
    score += agreement * 20;
    if (agreement > 0.7) reasons.push('rows below share its width');
  } else {
    reasons.push('nothing below it');
  }

  return { rowIndex: index + 1, score: Math.round(score), reasons, columnCount };
}

/**
 * Detect the tables in a sheet.
 *
 * A blank-row run of two or more separates tables: one blank line is usually
 * cosmetic, two is a deliberate break. This is the rule that keeps a second
 * table further down the sheet from being read as more rows of the first —
 * which would silently merge unrelated data, exactly what must never happen.
 */
export function detectTables(rows: Cell[][], options: { maxTables?: number } = {}): DetectedTable[] {
  const maxTables = options.maxTables ?? 20;
  const blocks = splitIntoBlocks(rows);
  const tables: DetectedTable[] = [];

  for (const block of blocks) {
    if (tables.length >= maxTables) break;
    const table = detectTableInBlock(rows, block.start, block.end);
    if (table) tables.push(table);
  }
  return tables;
}

interface Block {
  start: number; // 0-based inclusive
  end: number; // 0-based inclusive
}

export function splitIntoBlocks(rows: Cell[][], blankRunSeparates = 2): Block[] {
  const blocks: Block[] = [];
  let start: number | null = null;
  let blankRun = 0;

  rows.forEach((row, i) => {
    if (isBlankRow(row)) {
      blankRun += 1;
      if (start !== null && blankRun >= blankRunSeparates) {
        blocks.push({ start, end: i - blankRun });
        start = null;
      }
      return;
    }
    blankRun = 0;
    if (start === null) start = i;
  });

  if (start !== null) blocks.push({ start, end: rows.length - 1 });
  return blocks.filter((b) => b.end >= b.start);
}

function detectTableInBlock(rows: Cell[][], start: number, end: number): DetectedTable | null {
  // Only the first few rows of a block can plausibly be its header; scanning
  // further would let a mid-table row that happens to be textual win.
  const limit = Math.min(start + 5, end);
  let best: HeaderCandidate | null = null;
  for (let i = start; i <= limit; i++) {
    if (isBlankRow(rows[i] ?? [])) continue;
    const candidate = scoreHeaderRow(rows, i);
    if (!best || candidate.score > best.score) best = candidate;
  }
  if (!best || best.score === 0) return null;

  const headerIndex = best.rowIndex - 1;
  const headerRow = rows[headerIndex] ?? [];
  const headers = headerRow.map((c) => (isBlank(c) ? '' : String(c).trim()));

  let firstData = headerIndex + 1;
  while (firstData <= end && isBlankRow(rows[firstData] ?? [])) firstData += 1;
  if (firstData > end) return null;

  return {
    headerRow: best.rowIndex,
    firstDataRow: firstData + 1,
    lastDataRow: end + 1,
    headers,
    columnCount: headers.filter((h) => h !== '').length,
    rowCount: end - firstData + 1,
    // Score is out of 100 by construction; expose it as a 0–1 confidence so the
    // editor can show the same number everywhere.
    confidence: Math.min(1, best.score / 100),
    reasons: best.reasons,
  };
}
