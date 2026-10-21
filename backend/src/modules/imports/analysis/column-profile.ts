import { Cell } from './table-detection';

/**
 * What a column actually contains.
 *
 * The profile exists so a person mapping a column sees evidence rather than a
 * guess: how full it is, what the values look like, whether they are unique,
 * and which real values are in there. A confidence figure with no examples
 * behind it is not reviewable, and every proposal downstream cites a profile.
 *
 * Inference is deliberately conservative. A column of `1`/`0` could be a boolean
 * or a quantity, and guessing boolean would silently turn "1 in stock" into
 * "in stock: yes". Where the evidence is genuinely ambiguous the profile says
 * so and the mapper decides.
 */

export type InferredType =
  | 'EMPTY'
  | 'TEXT'
  | 'INTEGER'
  | 'DECIMAL'
  | 'BOOLEAN'
  | 'DATE'
  | 'URL'
  | 'URL_LIST'
  | 'PATH_LIST'
  | 'MIXED';

export interface ColumnProfile {
  index: number;
  header: string;
  inferredType: InferredType;
  /** 0–1. How consistently the values match `inferredType`. */
  typeConfidence: number;
  filledCount: number;
  blankCount: number;
  /** Distinct non-blank values, capped — a census, not a set to hold. */
  distinctCount: number;
  /** True when every non-blank value is distinct: a candidate identifier. */
  unique: boolean;
  /** Up to five real values, for the mapper to recognize the column by. */
  samples: string[];
  minLength: number;
  maxLength: number;
  /** Decimal separator observed, when the column is numeric-looking. */
  decimalSeparator?: '.' | ',' | 'mixed';
  notes: string[];
}

const DISTINCT_CAP = 10_000;

const BOOLEAN_WORDS = new Set(['true', 'false', 'yes', 'no', 'y', 'n', 'si', 'sí', 'verdadero', 'falso']);

const blank = (c: Cell): boolean => c === null || c === undefined || String(c).trim() === '';

const isUrl = (s: string): boolean => /^https?:\/\/[^\s,]+$/i.test(s);
const isUrlList = (s: string): boolean => {
  const parts = s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 1 && parts.every(isUrl);
};
/** `A > B > C` or a comma-separated list of such paths. */
const isPathList = (s: string): boolean => s.includes('>') && /[^>]+>[^>]+/.test(s);

const isIsoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(s);
const isSlashDate = (s: string): boolean => /^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s);

/**
 * Numeric recognition, aware that a decimal separator is a locale choice.
 *
 * `1.234` is one thousand two hundred and thirty-four in Spanish and one point
 * two three four in English, and no amount of staring at one value resolves it.
 * So the separator is REPORTED, per column, and the mapper declares it — which
 * is what the legacy importer already demanded and is the right call.
 */
function numericShape(s: string): { numeric: boolean; integer: boolean; separator?: '.' | ',' } {
  const t = s
    .trim()
    .replace(/^[€$£]\s?/, '')
    .replace(/\s/g, '');
  if (!/^-?[\d.,]+$/.test(t) || !/\d/.test(t)) return { numeric: false, integer: false };

  const dots = (t.match(/\./g) || []).length;
  const commas = (t.match(/,/g) || []).length;

  if (dots === 0 && commas === 0) return { numeric: true, integer: true };
  if (dots > 0 && commas > 0) {
    // Whichever appears last is the decimal separator; the other groups digits.
    const sep = t.lastIndexOf('.') > t.lastIndexOf(',') ? '.' : ',';
    return { numeric: true, integer: false, separator: sep };
  }
  const sep = dots > 0 ? '.' : ',';
  const count = dots > 0 ? dots : commas;
  // A single separator with exactly three trailing digits is ambiguous —
  // "1,234" is a thousands group as often as a decimal — so it is reported as
  // an integer-shaped value with a separator rather than silently divided.
  const tail = t.split(sep).pop() ?? '';
  if (count === 1 && tail.length === 3) return { numeric: true, integer: true, separator: sep };
  return { numeric: true, integer: false, separator: sep };
}

export function profileColumn(index: number, header: string, values: Cell[]): ColumnProfile {
  const notes: string[] = [];
  const nonBlank = values.filter((v) => !blank(v)).map((v) => String(v).trim());
  const blankCount = values.length - nonBlank.length;

  if (nonBlank.length === 0) {
    return {
      index,
      header,
      inferredType: 'EMPTY',
      typeConfidence: 1,
      filledCount: 0,
      blankCount,
      distinctCount: 0,
      unique: false,
      samples: [],
      minLength: 0,
      maxLength: 0,
      notes: ['the column is empty in every row'],
    };
  }

  const distinct = new Set<string>();
  for (const v of nonBlank) {
    if (distinct.size >= DISTINCT_CAP) break;
    distinct.add(v);
  }

  const tally: Record<InferredType, number> = {
    EMPTY: 0,
    TEXT: 0,
    INTEGER: 0,
    DECIMAL: 0,
    BOOLEAN: 0,
    DATE: 0,
    URL: 0,
    URL_LIST: 0,
    PATH_LIST: 0,
    MIXED: 0,
  };
  const separators = new Set<'.' | ','>();

  for (const v of nonBlank) {
    const lower = v.toLowerCase();
    if (isUrlList(v)) {
      tally.URL_LIST++;
      continue;
    }
    if (isUrl(v)) {
      tally.URL++;
      continue;
    }
    if (isPathList(v)) {
      tally.PATH_LIST++;
      continue;
    }
    if (isIsoDate(v) || isSlashDate(v)) {
      tally.DATE++;
      continue;
    }
    if (BOOLEAN_WORDS.has(lower)) {
      tally.BOOLEAN++;
      continue;
    }
    const n = numericShape(v);
    if (n.numeric) {
      if (n.separator) separators.add(n.separator);
      if (n.integer) tally.INTEGER++;
      else tally.DECIMAL++;
      continue;
    }
    tally.TEXT++;
  }

  // Integers and decimals are the same column; the presence of any decimal
  // decides. Merging them before ranking avoids a column of mostly-whole
  // prices being typed INTEGER because 90% of rows lack cents.
  const numericTotal = tally.INTEGER + tally.DECIMAL;
  const merged: [InferredType, number][] = [
    [tally.DECIMAL > 0 ? 'DECIMAL' : 'INTEGER', numericTotal],
    ['TEXT', tally.TEXT],
    ['BOOLEAN', tally.BOOLEAN],
    ['DATE', tally.DATE],
    ['URL_LIST', tally.URL_LIST],
    ['URL', tally.URL],
    ['PATH_LIST', tally.PATH_LIST],
  ];
  merged.sort((a, b) => b[1] - a[1]);

  const [topType, topCount] = merged[0];
  const confidence = topCount / nonBlank.length;
  const inferred: InferredType = confidence >= 0.8 ? topType : 'MIXED';

  if (inferred === 'MIXED') {
    notes.push('values do not agree on a single type; map it as text or split the column');
  }
  if (blankCount > 0) {
    const pct = Math.round((blankCount / values.length) * 100);
    notes.push(`${pct}% of rows leave this blank`);
  }

  // A column of 1s and 0s is the classic silent-miscast: "1" as a boolean turns
  // a quantity into a yes. Say so rather than choose.
  if ((inferred === 'INTEGER' || inferred === 'DECIMAL') && distinct.size <= 2) {
    const vals = [...distinct].sort();
    if (vals.every((v) => v === '0' || v === '1')) {
      notes.push('only 0 and 1 appear — this may be a yes/no column rather than a quantity');
    }
  }

  const lengths = nonBlank.map((v) => v.length);
  const unique = distinct.size === nonBlank.length && nonBlank.length > 1;
  if (unique) notes.push('every value is distinct — this column can identify a row');

  let decimalSeparator: ColumnProfile['decimalSeparator'];
  if (separators.size === 1) decimalSeparator = [...separators][0];
  else if (separators.size > 1) {
    decimalSeparator = 'mixed';
    notes.push('both . and , appear as separators; declare which one means decimals');
  }

  return {
    index,
    header,
    inferredType: inferred,
    typeConfidence: Number(confidence.toFixed(2)),
    filledCount: nonBlank.length,
    blankCount,
    distinctCount: distinct.size,
    unique,
    samples: [...distinct].slice(0, 5),
    minLength: Math.min(...lengths),
    maxLength: Math.max(...lengths),
    decimalSeparator,
    notes,
  };
}

/** Profile every column of a table. */
export function profileTable(headers: string[], dataRows: Cell[][]): ColumnProfile[] {
  const width = Math.max(headers.length, ...dataRows.map((r) => r.length), 0);
  const profiles: ColumnProfile[] = [];
  for (let c = 0; c < width; c++) {
    profiles.push(
      profileColumn(
        c,
        headers[c] ?? '',
        dataRows.map((r) => r[c] ?? null),
      ),
    );
  }
  return profiles;
}
