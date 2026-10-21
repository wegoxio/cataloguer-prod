import * as Papa from 'papaparse';
import { neutralizeCsvCell } from '../../../common/csv/formula-injection';
import { RowOutcome } from '../entities/import-row-result.entity';
import type { RowEffects } from './import-executor';

/**
 * The report an import leaves behind.
 *
 * This is not a receipt. It is the document someone opens three weeks later
 * when a price is wrong and they need to know what happened to row 412 — so it
 * has to be complete, downloadable, and specific enough to act on without
 * anyone rerunning anything.
 *
 * Two properties do most of the work:
 *
 *  - **Every row appears**, including the ones that were skipped and the ones
 *    that failed. A report listing only successes is how a partially applied
 *    import passes for a complete one.
 *  - **A failure carries what to do next**, not just what went wrong. "Row 412:
 *    price is not a number" is a diagnosis; "correct the price and import just
 *    these rows again" is a repair, and repair is what the person needs.
 *
 * The repair is always FORWARD. There is no undo: the import committed durable
 * batches by design, and a rollback that tried to unpick them would have to
 * guess which later edits were the customer's own. Saying "fix these rows and
 * import them again" is honest; offering an undo button that half-works is not.
 */

export interface ReportRow {
  sourceTable: string;
  /** 1-based, as the person sees it in their spreadsheet. */
  sourceRow: number;
  outcome: RowOutcome;
  targetType?: string | null;
  targetId?: string | null;
  /** Which identifier decided the match, so a wrong match is explainable. */
  matchProvenance?: string | null;
  reason?: string | null;
  /** What happened to each thing this row touched. */
  effects?: RowEffects | null;
}

export interface ReportSummary {
  created: number;
  updated: number;
  skipped: number;
  blocked: number;
  failed: number;
  unresolved: number;
  total: number;
}

export function summarizeRows(rows: ReportRow[]): ReportSummary {
  const summary: ReportSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    blocked: 0,
    failed: 0,
    unresolved: 0,
    total: rows.length,
  };
  for (const row of rows) {
    switch (row.outcome) {
      case RowOutcome.CREATED:
        summary.created++;
        break;
      case RowOutcome.UPDATED:
        summary.updated++;
        break;
      case RowOutcome.SKIPPED:
        summary.skipped++;
        break;
      case RowOutcome.BLOCKED:
        summary.blocked++;
        break;
      case RowOutcome.FAILED:
        summary.failed++;
        break;
      case RowOutcome.UNRESOLVED:
        summary.unresolved++;
        break;
    }
  }
  return summary;
}

/** Outcomes that mean the row did NOT reach the catalogue. */
const NOT_APPLIED = new Set([RowOutcome.BLOCKED, RowOutcome.FAILED, RowOutcome.UNRESOLVED]);

export function rowsNeedingAttention(rows: ReportRow[]): ReportRow[] {
  return rows.filter((r) => NOT_APPLIED.has(r.outcome));
}

/**
 * What the person should do next, in their words.
 *
 * Written as a whole sentence rather than a status, because the audience is
 * someone who has just been told their import half-worked and needs to know
 * whether that is a problem.
 */
/**
 * A reason, finished as a sentence.
 *
 * Reasons come from several places and some already end in punctuation, so a
 * blindly appended full stop produces "is not a number.." in the report the
 * customer opens.
 */
function asSentence(reason: string): string {
  return /[.!?]$/.test(reason.trim()) ? reason.trim() : `${reason.trim()}.`;
}

export function describeOutcome(row: ReportRow): string {
  switch (row.outcome) {
    case RowOutcome.CREATED:
      return 'Added to your catalogue.';
    case RowOutcome.UPDATED:
      return 'An existing record was updated.';
    case RowOutcome.SKIPPED:
      return row.reason ? `Not imported: ${asSentence(row.reason)}` : 'Not imported.';
    case RowOutcome.BLOCKED:
      return row.reason
        ? `Refused before anything was written: ${asSentence(row.reason)}`
        : 'Refused before anything was written.';
    case RowOutcome.FAILED:
      return row.reason ? `Could not be imported: ${asSentence(row.reason)}` : 'Could not be imported.';
    case RowOutcome.UNRESOLVED:
      return row.reason
        ? `Needed a decision that was never made: ${asSentence(row.reason)}`
        : 'Needed a decision that was never made.';
    default:
      return 'Unknown outcome.';
  }
}

/**
 * How to put right whatever did not land.
 *
 * Deliberately forward-only, and deliberately specific about WHICH rows: "fix
 * your file and import it again" would re-apply the rows that already
 * succeeded, and the second pass would update records that were already
 * correct — noise in every audit trail that touches them.
 */
export function repairInstructions(rows: ReportRow[]): string[] {
  const attention = rowsNeedingAttention(rows);
  if (attention.length === 0) return [];

  const instructions: string[] = [];
  const rowNumbers = attention.map((r) => r.sourceRow).sort((a, b) => a - b);

  instructions.push(
    `${attention.length} row${attention.length === 1 ? '' : 's'} did not reach your catalogue: ${describeRowRanges(rowNumbers)}.`,
  );
  instructions.push('Everything else was imported and does not need to be repeated.');
  instructions.push(
    'Correct those rows in your file, then import a file containing ONLY them. Importing the whole file again would update records that are already correct.',
  );

  // Grouped so the person sees "37 rows have no price", not 37 lines.
  const byReason = new Map<string, number[]>();
  for (const row of attention) {
    const key = row.reason ?? 'No reason was recorded.';
    const list = byReason.get(key) ?? [];
    list.push(row.sourceRow);
    byReason.set(key, list);
  }
  for (const [reason, list] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
    instructions.push(`${list.length} row${list.length === 1 ? '' : 's'}: ${reason} (${describeRowRanges(list)})`);
  }

  return instructions;
}

/**
 * "2–7, 12, 40–44" rather than nineteen numbers.
 *
 * A person reads ranges; a list of individual rows is something they scan past.
 */
export function describeRowRanges(rows: number[], maxRanges = 12): string {
  if (rows.length === 0) return '';
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let previous = sorted[0];

  for (const row of sorted.slice(1)) {
    if (row === previous + 1) {
      previous = row;
      continue;
    }
    ranges.push(start === previous ? String(start) : `${start}–${previous}`);
    start = row;
    previous = row;
  }
  ranges.push(start === previous ? String(start) : `${start}–${previous}`);

  if (ranges.length <= maxRanges) return ranges.join(', ');
  const shown = ranges.slice(0, maxRanges).join(', ');
  return `${shown} and ${ranges.length - maxRanges} more`;
}

export const REPORT_COLUMNS = [
  'Table',
  'Row',
  'Outcome',
  'What happened',
  'Record type',
  'Record id',
  'Matched by',
  'Reason',
  // The four effects, in the order the wizard asked for them. A row that says
  // only "created" is what let a run create products, list none of them and
  // file none of them while reporting success.
  'Product',
  'Listed in shop',
  'Categories',
  'Stock',
] as const;

/**
 * One effect, in a sentence a person can check.
 *
 * States are rendered as words rather than the enum: `ZERO_NO_MOVEMENT` means
 * nothing to somebody reading a spreadsheet, and "no stock movement (zero)"
 * means exactly what happened.
 */
export function describeEffects(row: ReportRow): [string, string, string, string] {
  const e = row.effects;
  // Legacy rows carry no effects at all. They say so, rather than claiming
  // every effect was NOT_REQUESTED — which would be a fact this run never
  // recorded.
  if (!e) return ['not recorded', 'not recorded', 'not recorded', 'not recorded'];

  const product = e.product ? word(e.product.state) : 'not recorded';

  const store = !e.storeAssociation
    ? 'not recorded'
    : e.storeAssociation.state === 'NOT_REQUESTED'
      ? 'not requested'
      : `${word(e.storeAssociation.state)}${e.storeAssociation.storeName ? ` in ${e.storeAssociation.storeName}` : ''} (unpublished)`;

  let categories = 'not recorded';
  if (e.categories) {
    if (e.categories.state === 'NOT_REQUESTED') categories = 'not requested';
    else {
      const parts: string[] = [];
      if (e.categories.created?.length) parts.push(`created: ${e.categories.created.join('; ')}`);
      if (e.categories.reused?.length) parts.push(`reused: ${e.categories.reused.join('; ')}`);
      if (e.categories.blocked?.length) parts.push(`not applied: ${e.categories.blocked.join('; ')}`);
      categories = parts.length ? parts.join(' | ') : word(e.categories.state);
    }
  }

  let stock = 'not recorded';
  if (e.inventory) {
    if (e.inventory.state === 'NOT_REQUESTED') stock = 'not requested';
    else if (e.inventory.state === 'ZERO_NO_MOVEMENT') stock = 'no stock movement (zero)';
    else if (e.inventory.state === 'CREATED')
      stock = `${e.inventory.quantity ?? 0} to ${e.inventory.locationName ?? 'the chosen location'}${
        e.inventory.locationKind ? ` (${e.inventory.locationKind.toLowerCase()})` : ''
      }`;
    else stock = word(e.inventory.state);
  }

  return [product, store, categories, stock];
}

function word(state: string): string {
  return state.toLowerCase().replace(/_/g, ' ');
}

/**
 * The report as a CSV the person can open.
 *
 * Every cell goes through the export-boundary neutralization. This matters more
 * here than almost anywhere else in the product: the reason column contains
 * text that came from the customer's own file, so a product name someone typed
 * as `=cmd|'/c calc'!A1` would arrive in this report and execute when the
 * report was opened. The import is exactly the path by which such a value gets
 * in, and the report is exactly the document that carries it back out.
 */
export function renderReportCsv(rows: ReportRow[]): string {
  const body = rows.map((row) => [
    row.sourceTable,
    String(row.sourceRow),
    row.outcome,
    describeOutcome(row),
    row.targetType ?? '',
    row.targetId ?? '',
    row.matchProvenance ?? '',
    row.reason ?? '',
    ...describeEffects(row),
  ]);

  return Papa.unparse({
    fields: [...REPORT_COLUMNS],
    // Cell by cell rather than row by row: these rows are positional arrays
    // matching `fields`, not the keyed objects the row helper expects.
    data: body.map((cells) => cells.map((cell) => neutralizeCsvCell(cell))),
  });
}

export interface ImportReport {
  summary: ReportSummary;
  /** One sentence naming the outcome, for the top of the screen. */
  headline: string;
  repair: string[];
  rows: ReportRow[];
}

export function buildReport(rows: ReportRow[]): ImportReport {
  const summary = summarizeRows(rows);
  return {
    summary,
    headline: headlineFor(summary),
    repair: repairInstructions(rows),
    rows,
  };
}

/**
 * The sentence at the top.
 *
 * A partial result is stated as a partial result. Bounded execution commits
 * durable batches by design, so "partly imported" is a first-class outcome
 * rather than a failure to dress up — and dressing it up is how someone
 * believes their catalogue is complete when it is not.
 */
export function headlineFor(summary: ReportSummary): string {
  const applied = summary.created + summary.updated;
  const notApplied = summary.blocked + summary.failed + summary.unresolved;

  if (summary.total === 0) return 'Nothing was imported: the file had no rows to import.';
  if (notApplied === 0 && summary.skipped === 0) {
    return `All ${summary.total} rows were imported.`;
  }
  if (applied === 0) {
    return `Nothing was imported. ${notApplied} row${notApplied === 1 ? '' : 's'} could not be processed.`;
  }
  if (notApplied === 0) {
    return `${applied} of ${summary.total} rows were imported; ${summary.skipped} were deliberately skipped.`;
  }
  return `${applied} of ${summary.total} rows were imported. ${notApplied} did not reach your catalogue and ${notApplied === 1 ? 'needs' : 'need'} attention.`;
}
