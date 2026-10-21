import { ArchiveCensus, ArchiveEntry, inflateEntry } from './archive-gate';

/**
 * The metadata layer the value reader does not provide.
 *
 * `read-excel-file` returns cell VALUES — correctly, and without ever
 * evaluating a formula. What it does not return is the evidence a person needs
 * in order to map a sheet honestly: which cells were formulas, what those
 * formulas said, which cells were merged, and where the real header row is.
 * Those all live in the worksheet XML, which the archive gate has already
 * proven safe to open, so reading them costs one more pass over parts we have
 * already budgeted.
 *
 * Formula TEXT is captured deliberately. A formula's cached value is what we
 * import, but a mapper who cannot see that a column was computed cannot judge
 * whether importing that number is right. We show the expression and never
 * execute it.
 */

export interface CellCensus {
  ref: string;
  row: number;
  column: number;
  /** Formula source text, verbatim and never evaluated. */
  formula?: string;
  /** True when the cell carried a formula but no cached value. */
  formulaWithoutValue?: boolean;
}

export interface MergedRange {
  ref: string;
  fromRow: number;
  toRow: number;
  fromColumn: number;
  toColumn: number;
}

export interface SheetCensus {
  /** 1-based index in the workbook's declared sheet order. */
  index: number;
  name: string;
  entryName: string;
  dimension: string | null;
  rowCount: number;
  maxColumn: number;
  formulas: CellCensus[];
  merged: MergedRange[];
  /** Rows that are entirely empty, useful for finding table boundaries. */
  blankRows: number[];
}

export interface WorkbookCensus {
  sheets: SheetCensus[];
  totalFormulas: number;
  totalMergedRanges: number;
  mediaEntries: string[];
}

/** `B12` → { row: 12, column: 2 } (1-based). */
export function parseCellRef(ref: string): { row: number; column: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!m) return null;
  let column = 0;
  for (const ch of m[1]) column = column * 26 + (ch.charCodeAt(0) - 64);
  return { row: Number(m[2]), column };
}

/**
 * Sheet display names live in `xl/workbook.xml` in declaration order; the
 * worksheet parts are named `sheet1.xml`, `sheet2.xml`, … in that same order in
 * every writer we accept. Relationship-id resolution would be more precise, but
 * it buys nothing here and costs another part read — if the names cannot be
 * read at all we fall back to positional labels rather than failing the import.
 */
export function readSheetNames(buffer: Buffer, census: ArchiveCensus, maxBytes: number): string[] {
  const wb = census.entries.find((e) => e.name === 'xl/workbook.xml');
  if (!wb) return [];
  let xml: string;
  try {
    xml = inflateEntry(buffer, wb, maxBytes).toString('utf8');
  } catch {
    return [];
  }
  const names: string[] = [];
  const re = /<sheet\b[^>]*\bname\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) names.push(decodeXmlText(m[1]));
  return names;
}

function decodeXmlText(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Census one worksheet part.
 *
 * Parsing is by scanning tags rather than building a DOM: a worksheet is the
 * largest part in the package, and we only need four things from it. A DOM
 * would hold the whole sheet in memory a second time for no benefit.
 */
export function censusSheet(
  buffer: Buffer,
  entry: ArchiveEntry,
  index: number,
  name: string,
  maxBytes: number,
): SheetCensus {
  const xml = inflateEntry(buffer, entry, maxBytes).toString('utf8');

  const dimension = /<dimension\b[^>]*\bref\s*=\s*"([^"]*)"/.exec(xml)?.[1] ?? null;

  const merged: MergedRange[] = [];
  const mergeRe = /<mergeCell\b[^>]*\bref\s*=\s*"([^"]*)"/g;
  let mm: RegExpExecArray | null;
  while ((mm = mergeRe.exec(xml)) !== null) {
    const [fromRef, toRef] = mm[1].split(':');
    const from = parseCellRef(fromRef);
    const to = parseCellRef(toRef ?? fromRef);
    if (from && to) {
      merged.push({
        ref: mm[1],
        fromRow: from.row,
        toRow: to.row,
        fromColumn: from.column,
        toColumn: to.column,
      });
    }
  }

  const formulas: CellCensus[] = [];
  const blankRows: number[] = [];
  let rowCount = 0;
  let maxColumn = 0;

  // One pass over <row> elements; each row's cells are inspected in place.
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml)) !== null) {
    const attrs = rm[1] ?? rm[3] ?? '';
    const inner = rm[2] ?? '';
    const rowNum = Number(/\br\s*=\s*"(\d+)"/.exec(attrs)?.[1] ?? rowCount + 1);
    rowCount = Math.max(rowCount, rowNum);

    if (!inner.trim()) {
      blankRows.push(rowNum);
      continue;
    }

    let hasValue = false;
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cm: RegExpExecArray | null;
    while ((cm = cellRe.exec(inner)) !== null) {
      const cAttrs = cm[1] ?? cm[3] ?? '';
      const cInner = cm[2] ?? '';
      const ref = /\br\s*=\s*"([A-Z]+\d+)"/.exec(cAttrs)?.[1];
      const pos = ref ? parseCellRef(ref) : null;
      if (pos) maxColumn = Math.max(maxColumn, pos.column);

      const f = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(cInner);
      const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cInner);
      if (v || (cInner && /<is\b/.test(cInner))) hasValue = true;

      if (f && pos && ref) {
        formulas.push({
          ref,
          row: pos.row,
          column: pos.column,
          formula: decodeXmlText(f[1]),
          formulaWithoutValue: !v,
        });
      }
    }
    if (!hasValue) blankRows.push(rowNum);
  }

  return {
    index,
    name,
    entryName: entry.name,
    dimension,
    rowCount,
    maxColumn,
    formulas,
    merged,
    blankRows,
  };
}

/** Census every worksheet in an already-gated archive. */
export function censusWorkbook(buffer: Buffer, census: ArchiveCensus, maxBytesPerPart: number): WorkbookCensus {
  const names = readSheetNames(buffer, census, Math.min(maxBytesPerPart, 4 * 1024 * 1024));
  const sheets: SheetCensus[] = [];

  // Worksheet parts are ordered by their numeric suffix, which matches the
  // declaration order the names come from.
  const ordered = [...census.worksheetEntries].sort((a, b) => sheetNumber(a) - sheetNumber(b));

  ordered.forEach((entryName, i) => {
    const entry = census.entries.find((e) => e.name === entryName);
    if (!entry) return;
    sheets.push(censusSheet(buffer, entry, i + 1, names[i] ?? `Sheet${i + 1}`, maxBytesPerPart));
  });

  return {
    sheets,
    totalFormulas: sheets.reduce((n, s) => n + s.formulas.length, 0),
    totalMergedRanges: sheets.reduce((n, s) => n + s.merged.length, 0),
    mediaEntries: census.mediaEntries,
  };
}

function sheetNumber(entryName: string): number {
  return Number(/sheet(\d+)\.xml$/.exec(entryName)?.[1] ?? 0);
}
