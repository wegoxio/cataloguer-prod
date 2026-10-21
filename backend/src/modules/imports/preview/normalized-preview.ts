import { TargetField } from '../analysis/field-proposals';
import { Issue, IssueCode, SourceAnchor, issue } from '../issues/issue-taxonomy';
import { Transformation, TransformValue, applyTransformations, validateChain } from '../transform/transformations';
import { PREVIEW_MAX_TEXT_LENGTH, PREVIEW_PAGE_ROWS } from '../shared/import-limits';

/**
 * What the mapping actually does to the file, shown before anything is written.
 *
 * The mapping editor's whole job is to let someone answer one question with
 * confidence: *if I press go, what will end up in my catalogue?* Answering it
 * with a summary — "45 columns mapped, 841 rows ready" — is how the legacy
 * importer produced surprises. So the preview shows, per row and per column,
 * the original cell beside the value that would be stored, and the steps that
 * turned one into the other.
 *
 * This module is deliberately pure. It takes rows and a mapping and returns a
 * description; it reads no database, writes nothing, and has no opinion about
 * matching or execution. That makes the same code usable for the live preview
 * in the editor and for the validation pass immediately before execution, which
 * is what makes those two agree.
 */

/** What a column has been told to become. `null` field means "ignore this column". */
export interface ColumnMapping {
  columnIndex: number;
  header: string;
  field: TargetField | null;
  /** Ordered; each step sees the previous step's output. */
  transformations?: Transformation[];
  /** Why this mapping exists — carried from the proposal or written by a person. */
  reasons?: string[];
  confidence?: number;
  /** True once a person has looked at this column, whatever they decided. */
  reviewed?: boolean;
}

export interface TableMapping {
  sheet?: string;
  /** 1-based row number of the header, as the user sees it. */
  headerRow: number;
  columns: ColumnMapping[];
}

/** One cell, before and after. */
export interface NormalizedCell {
  columnIndex: number;
  header: string;
  field: TargetField | null;
  original: string;
  normalized: TransformValue;
  /** What each transformation step did, in order. */
  steps: string[];
  /** Set when a transformation could not be applied. */
  problem?: string;
  changed: boolean;
}

export interface NormalizedRow {
  /** 1-based, as the user sees it in their spreadsheet. */
  sourceRow: number;
  cells: NormalizedCell[];
  /** Field → value, which is what execution will actually consume. */
  values: Partial<Record<TargetField, TransformValue>>;
  issues: Issue[];
  /** True when nothing in the row carries any content. */
  blank: boolean;
}

export interface PreviewResult {
  rows: NormalizedRow[];
  issues: Issue[];
  /** Columns the mapping ignores, so the editor can say so out loud. */
  ignoredColumns: { columnIndex: number; header: string }[];
  /** Rows that were entirely blank and will be skipped. */
  blankRowCount: number;
  /** How many source rows the preview covered, which may be fewer than exist. */
  previewedRows: number;
}

/**
 * Fields an import cannot proceed without, per import type.
 *
 * Kept deliberately small. Every entry here is a column someone must find in
 * their file before they can do anything at all, so a long list turns into a
 * wall the first time a real export does not match our expectations.
 */
export const REQUIRED_FIELDS: Record<string, TargetField[]> = {
  PRODUCTS: ['name'],
  CATEGORIES: ['name'],
  // A sale with no date cannot be placed in any period, which is the only
  // thing a historical sales import is for.
  //
  // Identity is NOT here, because either of two columns satisfies it. See
  // `IDENTITY_ALTERNATIVES` below.
  HISTORICAL_STORE_SALES: ['occurredAt', 'quantity'],
};

/**
 * Fields of which AT LEAST ONE must be mapped.
 *
 * A historical sale has to say what was sold, and a customer's export says so
 * with a SKU, or with a name, or with both. Demanding `name` unconditionally
 * refused a file that identified every row perfectly well by SKU — which is
 * exactly what the approved Phase 9 acceptance fixture does, and it could not
 * be approved.
 *
 * The compiler has always tolerated this: `itemText: text(values.name) ?? sku`
 * falls back deliberately, so a SKU-only file compiles correctly. The preview
 * validator disagreed with it, and a validator that refuses what the compiler
 * would happily run is a wall in front of working behaviour.
 */
export const IDENTITY_ALTERNATIVES: Record<string, TargetField[]> = {
  HISTORICAL_STORE_SALES: ['name', 'sku'],
};

/**
 * Validate the mapping itself, before a single row is considered.
 *
 * These are the problems that make the whole mapping wrong rather than one
 * cell — a missing required field, the same target claimed twice, an operation
 * this version cannot perform. Reporting them per row would produce eight
 * hundred copies of one finding.
 */
export function validateMapping(mapping: TableMapping, importType: string): Issue[] {
  const issues: Issue[] = [];
  const anchor: SourceAnchor = { sheet: mapping.sheet };

  const mapped = mapping.columns.filter((c) => c.field !== null);

  // Same target claimed twice. Blocking, because there is no sensible answer to
  // "which of these two columns is the price?" — and silently picking one is how
  // an import writes the wrong number into every product.
  const byField = new Map<TargetField, ColumnMapping[]>();
  for (const column of mapped) {
    const list = byField.get(column.field!) ?? [];
    list.push(column);
    byField.set(column.field!, list);
  }
  for (const [field, columns] of byField) {
    if (columns.length > 1) {
      issues.push(
        issue(
          'DUPLICATE_FIELD_MAPPING',
          `${columns.map((c) => `"${c.header}"`).join(' and ')} are both mapped to ${field}.`,
          {
            anchor,
            guidance: 'Choose one column for this field and ignore the other.',
          },
        ),
      );
    }
  }

  for (const field of REQUIRED_FIELDS[importType] ?? []) {
    if (!byField.has(field)) {
      issues.push(
        issue('REQUIRED_FIELD_UNMAPPED', `Nothing is mapped to ${field}, which this import cannot run without.`, {
          anchor,
          guidance: `Pick the column in your file that holds the ${field}.`,
        }),
      );
    }
  }

  // Identity, satisfied by EITHER column. Blocking when neither is mapped,
  // because a sale that cannot say what was sold is not a record of anything —
  // and the compiler would otherwise write an empty `itemText`.
  const alternatives = IDENTITY_ALTERNATIVES[importType];
  if (alternatives && !alternatives.some((field) => byField.has(field))) {
    issues.push(
      issue(
        'IDENTITY_UNMAPPED',
        'Map either Internal SKU (Catalog) or Name so each historical sale identifies what was sold.',
        {
          anchor,
          guidance: 'Pick the column in your file that holds the product SKU, or the one that holds its name.',
        },
      ),
    );
  }

  for (const column of mapping.columns) {
    const errors = validateChain(column.transformations ?? []);
    for (const error of errors) {
      issues.push(
        issue('TRANSFORMATION_UNSUPPORTED', `Column "${column.header}": ${error}`, {
          anchor: { ...anchor, column: column.header },
          guidance: 'Remove the step, or update the importer before running this plan.',
        }),
      );
    }
  }

  // Every column must have been looked at — mapped or explicitly ignored. This
  // is informational, not blocking: it drives the editor's "3 columns still
  // need a decision" counter rather than refusing the import.
  const undecided = mapping.columns.filter((c) => c.field === null && !c.reviewed);
  for (const column of undecided) {
    issues.push(
      issue('COLUMN_UNMAPPED', `Column "${column.header}" is not mapped to anything and will be ignored.`, {
        anchor: { ...anchor, column: column.header },
        guidance: 'Map it to a field, or mark it as ignored to confirm that is intentional.',
      }),
    );
  }

  // Duplicate headers make every later reference ambiguous — "which Precio?"
  const seenHeaders = new Map<string, number>();
  for (const column of mapping.columns) {
    const key = column.header.trim().toLowerCase();
    if (key === '') continue;
    const count = (seenHeaders.get(key) ?? 0) + 1;
    seenHeaders.set(key, count);
    if (count === 2) {
      issues.push(
        issue('DUPLICATE_HEADER', `More than one column is called "${column.header}".`, {
          anchor: { ...anchor, column: column.header },
          guidance: 'Rename one of them in your file so they can be told apart.',
        }),
      );
    }
  }

  return issues;
}

export interface PreviewOptions {
  importType: string;
  /** How many rows to show. The editor previews a sample, not the whole file. */
  limit?: number;
  /** Longest a text value may be before it is flagged. */
  maxTextLength?: number;
}

/** Re-exported so existing callers keep their name; the value lives in `import-limits.ts`. */
export const DEFAULT_PREVIEW_ROWS = PREVIEW_PAGE_ROWS;
export const DEFAULT_MAX_TEXT_LENGTH = PREVIEW_MAX_TEXT_LENGTH;

/**
 * Apply a mapping to source rows and describe the result.
 *
 * `rows` are raw cell values as the adapter produced them, with `firstRowNumber`
 * naming the spreadsheet row the first entry came from — so every anchor points
 * at a row the user can actually find, rather than at a zero-based index into
 * an array they never see.
 */
export function buildNormalizedPreview(
  rows: string[][],
  firstRowNumber: number,
  mapping: TableMapping,
  options: PreviewOptions,
): PreviewResult {
  const limit = options.limit ?? DEFAULT_PREVIEW_ROWS;
  const maxTextLength = options.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;

  const mappingIssues = validateMapping(mapping, options.importType);
  const normalizedRows: NormalizedRow[] = [];
  const rowIssues: Issue[] = [];
  let blankRowCount = 0;
  let previewed = 0;

  for (const [index, raw] of rows.entries()) {
    const sourceRow = firstRowNumber + index;
    const blank = raw.every((cell) => (cell ?? '').trim() === '');
    if (blank) {
      blankRowCount++;
      continue;
    }
    if (previewed >= limit) continue;
    previewed++;

    const cells: NormalizedCell[] = [];
    const values: Partial<Record<TargetField, TransformValue>> = {};

    for (const column of mapping.columns) {
      const original = raw[column.columnIndex] ?? '';
      const chain = column.transformations ?? [];
      const result = applyTransformations(original, chain);

      const cell: NormalizedCell = {
        columnIndex: column.columnIndex,
        header: column.header,
        field: column.field,
        original,
        normalized: result.value,
        steps: result.steps,
        changed: !valuesEqual(original, result.value),
      };

      if (result.problems.length > 0) {
        cell.problem = result.problems[0].message;
        // A value that could not be transformed is a WARNING, not a failure:
        // the row can still be imported without that field, and the person is
        // better placed than we are to decide whether that is acceptable.
        rowIssues.push(
          issue('VALUE_NOT_PARSEABLE', `${result.problems[0].message}`, {
            anchor: { sheet: mapping.sheet, row: sourceRow, column: column.header },
            guidance: 'Correct the value in your file, or leave it blank to skip this field for this row.',
          }),
        );
      }

      if (column.field) {
        values[column.field] = result.value;
        const problem = checkValue(column.field, result.value, maxTextLength);
        if (problem) {
          rowIssues.push(
            issue(problem.code, problem.message, {
              anchor: { sheet: mapping.sheet, row: sourceRow, column: column.header },
              ...(problem.guidance ? { guidance: problem.guidance } : {}),
            }),
          );
        }
      }

      cells.push(cell);
    }

    normalizedRows.push({ sourceRow, cells, values, issues: [], blank: false });
  }

  const issues = [...mappingIssues, ...rowIssues];
  if (blankRowCount > 0) {
    issues.push(
      issue('BLANK_ROWS_SKIPPED', `${blankRowCount} blank row(s) will be skipped.`, {
        anchor: { sheet: mapping.sheet },
      }),
    );
  }

  return {
    rows: normalizedRows,
    issues,
    ignoredColumns: mapping.columns
      .filter((c) => c.field === null)
      .map((c) => ({ columnIndex: c.columnIndex, header: c.header })),
    blankRowCount,
    previewedRows: previewed,
  };
}

/**
 * Per-field sanity, beyond whether the value parsed.
 *
 * These are the checks that catch a mapping which is syntactically fine and
 * semantically wrong: a negative price, a stock of -5, a name longer than the
 * column can hold. None of them is about the transformation succeeding — a
 * negative price parses perfectly.
 */
function checkValue(
  field: TargetField,
  value: TransformValue,
  maxTextLength: number,
): { code: IssueCode; message: string; guidance?: string } | null {
  if (value === null) return null;

  if ((field === 'price' || field === 'salePrice' || field === 'cost') && typeof value === 'number') {
    if (value < 0) {
      return {
        code: 'VALUE_OUT_OF_RANGE',
        message: `A ${field} of ${value} is negative.`,
        guidance: 'Prices cannot be below zero. Correct the value or leave the cell blank.',
      };
    }
  }

  if ((field === 'stock' || field === 'leadTimeDays' || field === 'quantity') && typeof value === 'number') {
    if (value < 0) {
      return {
        code: 'VALUE_OUT_OF_RANGE',
        message: `A ${field} of ${value} is negative.`,
        guidance: 'Use zero rather than a negative number.',
      };
    }
    if (!Number.isInteger(value)) {
      return {
        code: 'VALUE_NOT_PARSEABLE',
        message: `A ${field} of ${value} is not a whole number.`,
        guidance: 'Use a whole number.',
      };
    }
  }

  if (typeof value === 'string' && value.length > maxTextLength) {
    return {
      code: 'VALUE_TOO_LONG',
      message: `This ${field} is ${value.length} characters long.`,
      guidance: `Shorten it to ${maxTextLength} characters or fewer.`,
    };
  }

  if (field === 'name' && typeof value === 'string' && value.trim() === '') {
    return {
      code: 'REQUIRED_VALUE_BLANK',
      message: 'This row has no name.',
      guidance: 'Every product needs a name. Fill it in, or remove the row.',
    };
  }

  return null;
}

/** Whether the transformation actually altered anything the user would see. */
function valuesEqual(original: string, normalized: TransformValue): boolean {
  if (Array.isArray(normalized)) return normalized.join(', ') === original;
  if (normalized === null) return original.trim() === '';
  return String(normalized) === original;
}
