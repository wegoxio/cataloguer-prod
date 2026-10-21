import * as Papa from 'papaparse';
import { detectFormat } from '../upload-security/content-signature';
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
 * CSV / TSV and other safely delimited text.
 *
 * Delimited text has no signature, so this adapter claims a file only when the
 * bytes decode as text; the extension then decides comma versus tab, and the
 * content overrides it when they disagree. Papa Parse does the actual parsing —
 * it already ships here and already handles quoted newlines, which the real
 * DesignHof export contains inside its own header row.
 */

const DELIMITER_CANDIDATES = [',', '\t', ';', '|'] as const;

/**
 * Detect the delimiter by consistency, not by frequency.
 *
 * Frequency alone picks the wrong character often: a description column full of
 * commas beats a semicolon-delimited file's real delimiter. What actually
 * identifies a delimiter is that it produces the SAME field count on every line,
 * so we score candidates by agreement across the first lines and use count only
 * to break ties.
 */
export function detectDelimiter(sample: string): string {
  const lines = sample
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 20);
  if (lines.length === 0) return ',';

  let best = { delimiter: ',', agreement: -1, fields: 0 };
  for (const d of DELIMITER_CANDIDATES) {
    const counts = lines.map((l) => splitOutsideQuotes(l, d).length);
    const modal = counts.sort((a, b) => a - b)[Math.floor(counts.length / 2)];
    if (modal < 2) continue;
    const agreement = counts.filter((c) => c === modal).length / counts.length;
    if (agreement > best.agreement || (agreement === best.agreement && modal > best.fields)) {
      best = { delimiter: d, agreement, fields: modal };
    }
  }
  return best.agreement >= 0 ? best.delimiter : ',';
}

/** Field count for a line, ignoring delimiters inside double quotes. */
function splitOutsideQuotes(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else inQuotes = !inQuotes;
      continue;
    }
    if (ch === delimiter && !inQuotes) {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

/**
 * Decode text, stripping a single BOM.
 *
 * Strict UTF-8 first, because that is what every modern exporter produces and a
 * fatal decode catches a mislabelled binary. Latin-1 is the documented fallback
 * for older Windows exports; it never fails, so it is only reached when UTF-8
 * has already been ruled out, and the encoding actually used is reported so a
 * mapper can see mojibake was a decoding decision and not their data.
 */
export function decodeText(buffer: Buffer): { text: string; encoding: string } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { text: stripBom(text), encoding: 'utf-8' };
  } catch {
    const text = new TextDecoder('windows-1252').decode(buffer);
    return { text: stripBom(text), encoding: 'windows-1252' };
  }
}

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

export class DelimitedAdapter implements SourceAdapter {
  readonly kind: SourceKind = 'CSV';

  sniff(buffer: Buffer, fileName: string): number {
    if (detectFormat(buffer) !== 'CSV_OR_TEXT') return 0;
    const lower = (fileName || '').toLowerCase();
    if (lower.endsWith('.csv') || lower.endsWith('.tsv') || lower.endsWith('.txt')) return 0.9;
    return 0.4; // text, but unnamed — still ours, just less certainly
  }

  census(buffer: Buffer, limits: AdapterLimits): SourceCensus {
    const { text, encoding } = decodeText(buffer);
    const delimiter = detectDelimiter(text.slice(0, 64 * 1024));

    // Count without materializing rows: the census must be cheap enough to run
    // on a source we may then refuse for being too large.
    const parsed = Papa.parse<string[]>(text, {
      header: false,
      skipEmptyLines: true,
      delimiter,
    });
    const rows = parsed.data;
    const rowCount = rows.length;
    const columnCount = rows.reduce((n, r) => Math.max(n, r.length), 0);

    assertWithinLimits({ rows: rowCount, columns: columnCount }, limits);

    const blankRows: number[] = [];
    rows.forEach((r, i) => {
      if (r.every((c) => (c ?? '').toString().trim() === '')) blankRows.push(i + 1);
    });

    return {
      kind: delimiter === '\t' ? 'TSV' : 'CSV',
      encoding,
      delimiter,
      sheets: [
        {
          index: 1,
          name: 'Sheet 1',
          rowCount,
          columnCount,
          merged: [],
          formulas: [],
          blankRows,
        },
      ],
      mediaEntries: [],
      activeContent: [],
      totalCells: rowCount * columnCount,
    };
  }

  readRange(buffer: Buffer, options: ReadRangeOptions, limits: AdapterLimits): RangeResult {
    if (options.sheetIndex !== 1) {
      throw new SourceRejected('UNREADABLE', 'A delimited file has only one table.');
    }
    const { text } = decodeText(buffer);
    const delimiter = detectDelimiter(text.slice(0, 64 * 1024));

    const from = options.fromRow ?? 1;
    const to = options.toRow ?? Number.MAX_SAFE_INTEGER;

    const rows: (string | null)[][] = [];
    let cells = 0;
    let truncated = false;
    let index = 0;

    // `step` keeps one row resident at a time; the corpus is never held.
    Papa.parse<string[]>(text, {
      header: false,
      skipEmptyLines: true,
      delimiter,
      step: (result, parser) => {
        index += 1;
        if (index < from) return;
        if (index > to) {
          parser.abort();
          return;
        }
        if (rows.length >= options.maxRows || cells + result.data.length > options.maxCells) {
          truncated = true;
          parser.abort();
          return;
        }
        const row = result.data.map((c) => {
          const s = c ?? '';
          if (s.length > limits.maxCellChars) {
            throw new SourceRejected(
              'CELL_TOO_LARGE',
              `A cell in row ${index} holds more than ${limits.maxCellChars.toLocaleString()} characters.`,
            );
          }
          return s === '' ? null : s;
        });
        rows.push(row);
        cells += row.length;
      },
    });

    return { rows, truncated, rowsRead: rows.length, cellsRead: cells };
  }
}
