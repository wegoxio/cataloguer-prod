/**
 * Declarative transformations applied to a source value before it is mapped.
 *
 * Every real import needs some cleaning: prices arrive as `"1.234,50 €"`, SKUs
 * carry stray whitespace, a "Yes/No" column has to become a boolean. The
 * tempting answer is a small expression language. The correct answer is a fixed
 * list of named operations, because:
 *
 *  - a transformation is stored in a plan, hashed into an approval, and re-run
 *    days later by a different process. Anything whose meaning could drift
 *    between those moments makes the approval a lie.
 *  - an expression evaluator on tenant-supplied strings is a code-execution
 *    surface reachable by anyone who can upload a spreadsheet.
 *  - a person approving an import has to understand what it will do. "Trim
 *    whitespace, then parse as a decimal with a comma separator" is reviewable.
 *    An expression is not.
 *
 * So: a closed set, each operation total (never throws), each returning both a
 * value and an explanation. A transformation that cannot be applied does not
 * fail the row — it reports why, and the issue workspace decides what that
 * means.
 *
 * Determinism is the load-bearing property. The same input and the same
 * configuration must produce the same output on any machine at any time, so
 * nothing here reads a clock, a locale, the environment or a random source.
 */

export type TransformationKind =
  | 'TRIM'
  | 'COLLAPSE_WHITESPACE'
  | 'UPPERCASE'
  | 'LOWERCASE'
  | 'STRIP_CHARACTERS'
  | 'REPLACE_LITERAL'
  | 'PAD_START'
  | 'PARSE_DECIMAL'
  | 'PARSE_INTEGER'
  | 'PARSE_BOOLEAN'
  | 'PARSE_DATE'
  | 'SPLIT_LIST'
  | 'MAP_VALUES'
  | 'DEFAULT_IF_BLANK';

export interface Transformation {
  kind: TransformationKind;
  /** Configuration for this operation. Shape depends on `kind`. */
  options?: Record<string, unknown>;
}

/** The result of one operation, or of a whole chain. */
export interface TransformResult {
  value: TransformValue;
  /** What each step did, in order — shown beside original vs normalized. */
  steps: string[];
  /** Why a step could not be applied. Never thrown; the workspace decides. */
  problems: TransformProblem[];
}

export interface TransformProblem {
  kind: TransformationKind;
  message: string;
}

export type TransformValue = string | number | boolean | string[] | null;

/** Decimal separator, stated rather than guessed from a locale. */
export type DecimalSeparator = ',' | '.';

const asText = (value: TransformValue): string => {
  if (value === null) return '';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
};

/**
 * True/false words we accept, in English and Spanish.
 *
 * Listed rather than inferred. A column of `Sí`/`No` is extremely common in
 * these exports, and treating any non-empty string as `true` would silently
 * publish every product whose "Published" column said `No`.
 */
const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'si', 'sí', 'verdadero', 'x', 'on']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'falso', 'off', '']);

const OPERATIONS: Record<
  TransformationKind,
  (value: TransformValue, options: Record<string, unknown>) => OperationOutcome
> = {
  TRIM: (value) => {
    const text = asText(value);
    const next = text.trim();
    return next === text ? unchanged(next) : changed(next, 'trimmed surrounding whitespace');
  },

  COLLAPSE_WHITESPACE: (value) => {
    const text = asText(value);
    const next = text.replace(/\s+/g, ' ').trim();
    return next === text ? unchanged(next) : changed(next, 'collapsed repeated whitespace');
  },

  UPPERCASE: (value) => {
    const text = asText(value);
    const next = text.toUpperCase();
    return next === text ? unchanged(next) : changed(next, 'converted to upper case');
  },

  LOWERCASE: (value) => {
    const text = asText(value);
    const next = text.toLowerCase();
    return next === text ? unchanged(next) : changed(next, 'converted to lower case');
  },

  STRIP_CHARACTERS: (value, options) => {
    const text = asText(value);
    const characters = typeof options.characters === 'string' ? options.characters : '';
    if (!characters) return unchanged(text);
    const set = new Set(characters.split(''));
    const next = text
      .split('')
      .filter((c) => !set.has(c))
      .join('');
    return next === text ? unchanged(next) : changed(next, `removed the characters ${JSON.stringify(characters)}`);
  },

  REPLACE_LITERAL: (value, options) => {
    const text = asText(value);
    const search = typeof options.search === 'string' ? options.search : '';
    const replacement = typeof options.replacement === 'string' ? options.replacement : '';
    if (!search) return unchanged(text);
    // Literal, never a regular expression: a tenant-supplied pattern is both a
    // denial-of-service surface and impossible for an approver to reason about.
    const next = text.split(search).join(replacement);
    return next === text
      ? unchanged(next)
      : changed(next, `replaced ${JSON.stringify(search)} with ${JSON.stringify(replacement)}`);
  },

  PAD_START: (value, options) => {
    const text = asText(value);
    const length = typeof options.length === 'number' ? options.length : 0;
    const fill = typeof options.fill === 'string' && options.fill.length > 0 ? options.fill : '0';
    if (length <= text.length) return unchanged(text);
    const next = text.padStart(length, fill);
    return changed(next, `padded to ${length} characters with ${JSON.stringify(fill)}`);
  },

  PARSE_DECIMAL: (value, options) => {
    const text = asText(value).trim();
    if (text === '') return unchanged(null);
    const separator: DecimalSeparator = options.decimalSeparator === ',' ? ',' : '.';
    // Strip everything that is not a digit, a separator or a leading sign.
    // Currency symbols, thin spaces and non-breaking spaces all appear in real
    // exports and none of them carry meaning for the number.
    const sign = /^\s*-/.test(text) ? -1 : 1;
    const grouping = separator === ',' ? '.' : ',';
    const digitsOnly = text.replace(/[^0-9.,]/g, '');
    const withoutGrouping = digitsOnly.split(grouping).join('');
    const normalized = separator === ',' ? withoutGrouping.replace(',', '.') : withoutGrouping;
    const parsed = Number(normalized);
    if (normalized === '' || Number.isNaN(parsed)) {
      return failed(null, `"${text}" is not a number`);
    }
    const result = sign * Math.abs(parsed);
    return changed(result, `read as the number ${result} using "${separator}" as the decimal separator`);
  },

  PARSE_INTEGER: (value) => {
    const text = asText(value).trim();
    if (text === '') return unchanged(null);
    // Strip only what carries no numeric meaning — currency symbols, spaces.
    // Separators are deliberately left in place: stripping them would turn
    // "12.5" into 125, and a stock quantity silently multiplied by ten is far
    // worse than a refusal the mapper can see.
    const cleaned = text.replace(/[^0-9.,-]/g, '');
    const negative = /^-/.test(cleaned);
    const digits = cleaned.replace(/^-/, '');

    if (/^\d+$/.test(digits)) {
      const parsed = Number(digits) * (negative ? -1 : 1);
      return changed(parsed, `read as the whole number ${parsed}`);
    }

    // A separator followed by exactly three digits, repeatedly, is grouping
    // rather than a fraction — "1,234,567" is an integer. Anything else is a
    // decimal, and a decimal is not a whole number.
    if (/^\d{1,3}([.,]\d{3})+$/.test(digits)) {
      const parsed = Number(digits.replace(/[.,]/g, '')) * (negative ? -1 : 1);
      return changed(parsed, `read as the whole number ${parsed}, treating the separators as grouping`);
    }

    return failed(null, `"${text}" is not a whole number`);
  },

  PARSE_BOOLEAN: (value) => {
    const text = asText(value).trim().toLowerCase();
    if (TRUE_WORDS.has(text)) return changed(true, `"${text}" read as yes`);
    if (FALSE_WORDS.has(text)) return changed(false, `"${text}" read as no`);
    // Deliberately NOT defaulting. A column that says "Pendiente" is not a no,
    // and guessing here silently publishes or unpublishes products.
    return failed(null, `"${text}" is neither a yes nor a no`);
  },

  PARSE_DATE: (value, options) => {
    const text = asText(value).trim();
    if (text === '') return unchanged(null);
    const order = options.order === 'MDY' ? 'MDY' : options.order === 'YMD' ? 'YMD' : 'DMY';
    const parsed = parseDateParts(text, order);
    if (!parsed) return failed(null, `"${text}" is not a date this importer recognises`);
    return changed(parsed, `read as ${parsed} using ${order} order`);
  },

  SPLIT_LIST: (value, options) => {
    const text = asText(value);
    const separator = typeof options.separator === 'string' && options.separator.length > 0 ? options.separator : ',';
    if (text.trim() === '') return unchanged([]);
    const parts = text
      .split(separator)
      .map((p) => p.trim())
      .filter((p) => p !== '');
    return changed(parts, `split on ${JSON.stringify(separator)} into ${parts.length} value(s)`);
  },

  MAP_VALUES: (value, options) => {
    const text = asText(value).trim();
    const mapping = isStringRecord(options.mapping) ? options.mapping : {};
    // Case-insensitive lookup, because a mapping table written by hand will not
    // match the casing in the file and failing on that helps nobody.
    const key = Object.keys(mapping).find((k) => k.toLowerCase() === text.toLowerCase());
    if (key === undefined) {
      if (options.passThroughUnmapped === true) return unchanged(text);
      return failed(null, `"${text}" is not one of the values you mapped`);
    }
    return changed(mapping[key], `"${text}" mapped to "${mapping[key]}"`);
  },

  DEFAULT_IF_BLANK: (value, options) => {
    const text = asText(value);
    if (text.trim() !== '') return unchanged(value);
    const fallback = typeof options.value === 'string' ? options.value : '';
    return changed(fallback, `blank, so used the default ${JSON.stringify(fallback)}`);
  },
};

interface OperationOutcome {
  value: TransformValue;
  step?: string;
  problem?: string;
}

const unchanged = (value: TransformValue): OperationOutcome => ({ value });
const changed = (value: TransformValue, step: string): OperationOutcome => ({ value, step });
const failed = (value: TransformValue, problem: string): OperationOutcome => ({ value, problem });

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === 'string')
  );
}

/**
 * Dates without a library and without a locale.
 *
 * `new Date("03/04/2026")` is ambiguous and resolves differently depending on
 * where the process runs, which is intolerable for a value that will be written
 * to a customer's sales history. The separator order is therefore always stated
 * explicitly by the mapping, never inferred, and the result is an ISO date
 * string rather than a `Date` so no timezone can shift it.
 */
function parseDateParts(text: string, order: 'DMY' | 'MDY' | 'YMD'): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return validDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const parts = text.split(/[/.\-\s]+/).filter((p) => p !== '');
  if (parts.length < 3) return null;
  const [a, b, c] = parts.slice(0, 3).map((p) => Number(p));
  if ([a, b, c].some((n) => !Number.isInteger(n))) return null;

  if (order === 'YMD') return validDate(a, b, c);
  if (order === 'MDY') return validDate(c, a, b);
  return validDate(c, b, a);
}

function validDate(year: number, month: number, day: number): string | null {
  if (year < 1900 || year > 2200) return null;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;
  // Reject a day that does not exist in that month, rather than letting it roll
  // forward into the next one — 31 February must be an error, not 3 March.
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day > daysInMonth) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Every operation a mapping may name. Anything else is rejected, not ignored. */
export const SUPPORTED_TRANSFORMATIONS = Object.keys(OPERATIONS) as TransformationKind[];

/**
 * Apply a chain of transformations to one source value.
 *
 * Steps run in the declared order and each sees the previous one's output, so
 * `TRIM` then `PARSE_DECIMAL` is a different mapping from the reverse — which is
 * why the order is stored and hashed rather than normalized away.
 *
 * A failing step stops the chain. Continuing would apply later operations to a
 * value the earlier one already reported it could not produce, and the second
 * error would bury the first.
 */
export function applyTransformations(value: TransformValue, chain: Transformation[]): TransformResult {
  const steps: string[] = [];
  const problems: TransformProblem[] = [];
  let current = value;

  for (const transformation of chain) {
    const operation = OPERATIONS[transformation.kind];
    if (!operation) {
      // An unknown operation is never skipped silently. A plan naming something
      // this version cannot perform must not appear to have been carried out.
      problems.push({
        kind: transformation.kind,
        message: `This version of the importer does not know the operation "${transformation.kind}".`,
      });
      break;
    }

    const outcome = operation(current, transformation.options ?? {});
    current = outcome.value;
    if (outcome.step) steps.push(outcome.step);
    if (outcome.problem) {
      problems.push({ kind: transformation.kind, message: outcome.problem });
      break;
    }
  }

  return { value: current, steps, problems };
}

/**
 * Whether a chain is one this version can execute at all.
 *
 * Checked when a plan is built and again before execution, because a plan
 * approved by one deployment may be executed by another.
 */
export function validateChain(chain: Transformation[]): string[] {
  const errors: string[] = [];
  for (const [index, transformation] of chain.entries()) {
    if (!OPERATIONS[transformation.kind]) {
      errors.push(`Step ${index + 1} names an unknown operation "${transformation.kind}".`);
    }
  }
  return errors;
}
