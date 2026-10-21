import readXlsxFile from 'read-excel-file/node';
import { detectFormat } from '../upload-security/content-signature';
import { ArchiveBudget, JOB_ARCHIVE_BUDGET, openArchive } from './archive-gate';
import { censusWorkbook } from './workbook-census';
import {
  AdapterLimits,
  RangeResult,
  ReadRangeOptions,
  SourceAdapter,
  SourceCensus,
  SourceKind,
  SourceRejected,
  assertWithinLimits,
} from './source-adapter';

/**
 * XLSX adapter — two stages, deliberately.
 *
 * Stage one is our archive gate. The accepted value reader inflates whatever it
 * is given: measured, it expanded a 300 kB bomb to 579 MiB in 454 ms, which is
 * fatal on a 512 MiB container. So the gate reads the package directory,
 * refuses on budget, and censuses macros, external links and media BEFORE the
 * reader is handed anything.
 *
 * Stage two is `read-excel-file`, which the spike proved returns cached values
 * without ever evaluating a formula and without fetching an external reference.
 * What it does not return — formula text, merged ranges, sheet extents — comes
 * from our own census of the same parts the gate already opened.
 *
 * The reader needs a file path, so the buffer is written to a private temp file
 * with a restrictive mode and removed in a `finally`. Nothing else on the
 * request path touches disk.
 */

export class XlsxAdapter implements SourceAdapter {
  readonly kind: SourceKind = 'XLSX';

  /**
   * `tempRoot` exists so a test can isolate the scratch directory. Sharing
   * os.tmpdir() with parallel workers makes "did we clean up?" unobservable.
   */
  constructor(
    private readonly budget: ArchiveBudget = JOB_ARCHIVE_BUDGET,
    private readonly tempRoot?: string,
  ) {}

  sniff(buffer: Buffer, fileName: string): number {
    if (detectFormat(buffer) !== 'ZIP_CONTAINER') return 0;
    const lower = (fileName || '').toLowerCase();
    if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return 0.95;
    // A zip container that is not named like a workbook may still be one; the
    // census will reject it if it has no worksheet parts.
    return 0.5;
  }

  census(buffer: Buffer, limits: AdapterLimits): SourceCensus {
    const archive = openArchive(buffer, this.budget);
    if (archive.worksheetEntries.length === 0) {
      throw new SourceRejected(
        'UNSUPPORTED_FORMAT',
        'This archive does not contain a spreadsheet. Upload a .xlsx workbook, or export the data as .csv.',
      );
    }
    if (archive.worksheetEntries.length > limits.maxSheets) {
      throw new SourceRejected(
        'TOO_MANY_SHEETS',
        `This workbook has ${archive.worksheetEntries.length} sheets; we can analyze up to ${limits.maxSheets}.`,
      );
    }

    const wb = censusWorkbook(buffer, archive, limits.maxPartBytes);

    let totalCells = 0;
    for (const s of wb.sheets) {
      assertWithinLimits({ rows: s.rowCount, columns: s.maxColumn }, limits);
      totalCells += s.rowCount * s.maxColumn;
    }
    if (totalCells > limits.maxCells) {
      throw new SourceRejected(
        'TOO_MANY_CELLS',
        `This workbook holds about ${totalCells.toLocaleString()} cells across its sheets; we can analyze up to ${limits.maxCells.toLocaleString()}.`,
      );
    }

    return {
      kind: 'XLSX',
      sheets: wb.sheets.map((s) => ({
        index: s.index,
        name: s.name,
        rowCount: s.rowCount,
        columnCount: s.maxColumn,
        merged: s.merged,
        formulas: s.formulas.map((f) => ({
          ref: f.ref,
          formula: f.formula ?? '',
          cachedValueMissing: Boolean(f.formulaWithoutValue),
        })),
        blankRows: s.blankRows,
      })),
      mediaEntries: wb.mediaEntries,
      activeContent: archive.activeContent,
      totalCells,
    };
  }

  /**
   * Read one sheet's values.
   *
   * Async in the adapter contract's spirit but exposed synchronously would be a
   * lie — the reader is promise-based — so this returns a promise and the
   * analyzer awaits it. The gate runs again here rather than trusting a census
   * the caller may have taken minutes ago against different bytes.
   */
  async readRangeAsync(buffer: Buffer, options: ReadRangeOptions, limits: AdapterLimits): Promise<RangeResult> {
    openArchive(buffer, this.budget);

    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const crypto = await import('crypto');

    const root = this.tempRoot ?? os.tmpdir();
    const dir = await fs.mkdtemp(path.join(root, 'cataloguer-xlsx-'));
    const file = path.join(dir, `${crypto.randomUUID()}.xlsx`);
    try {
      await fs.writeFile(file, buffer, { mode: 0o600 });
      // `getSheets` is supported at runtime (verified against 9.3.10) but is
      // absent from the shipped typings, which only describe the single-sheet
      // overload. The cast is narrow and named rather than an `any` leak.
      type SheetsReader = (
        path: string,
        options: { getSheets: true },
      ) => Promise<{ sheet: string; data: unknown[][] }[]>;
      const readSheets = readXlsxFile as unknown as SheetsReader;
      const sheets = await readSheets(file, { getSheets: true });

      const chosen = sheets[options.sheetIndex - 1];
      if (!chosen) {
        throw new SourceRejected('UNREADABLE', `This workbook has no sheet ${options.sheetIndex}.`);
      }

      const from = options.fromRow ?? 1;
      const to = options.toRow ?? Number.MAX_SAFE_INTEGER;
      const rows: (string | number | boolean | null)[][] = [];
      let cells = 0;
      let truncated = false;

      for (let i = from - 1; i < chosen.data.length && i <= to - 1; i++) {
        const raw = chosen.data[i] ?? [];
        if (rows.length >= options.maxRows || cells + raw.length > options.maxCells) {
          truncated = true;
          break;
        }
        const row = raw.map((c) => normalizeCell(c, limits.maxCellChars, i + 1));
        rows.push(row);
        cells += row.length;
      }

      return { rows, truncated, rowsRead: rows.length, cellsRead: cells };
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  readRange(): RangeResult {
    throw new SourceRejected('UNREADABLE', 'Workbook ranges are read asynchronously; call readRangeAsync.');
  }
}

function normalizeCell(value: unknown, maxChars: number, rowNumber: number): string | number | boolean | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  if (s.length > maxChars) {
    throw new SourceRejected(
      'CELL_TOO_LARGE',
      `A cell in row ${rowNumber} holds more than ${maxChars.toLocaleString()} characters.`,
    );
  }
  return s;
}
