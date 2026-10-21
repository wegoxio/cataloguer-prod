import { AdapterLimits } from '../parsing/source-adapter';

/**
 * Every limit an import is subject to, in one place.
 *
 * They were scattered — a `@Max()` in a DTO, an object literal in the runner, a
 * constant beside the preview, budgets in the archive gate — and scattered
 * limits are how a system acquires a ceiling nobody chose. The 500-row figure
 * the discovery report complained about was exactly that: not a decision, but
 * the arithmetic consequence of a 100 kB Express default nobody had noticed.
 *
 * So each number here is stated with what it protects and what it costs. A
 * limit whose reason is not written down is a limit the next person raises
 * because it was in their way, and the failure it was preventing arrives some
 * months later wearing a different hat.
 *
 * The distinction that matters most in this file: the PREVIEW is a page and the
 * ANALYSIS is a census. The preview shows a person twenty-five rows so the
 * editor stays responsive; it never bounds what a plan covers or what an
 * execution writes. Those read the whole file.
 */

/* --------------------------------------------------------------- the source */

/**
 * Largest file a signed upload ticket will admit: 100 MiB.
 *
 * Signed INTO the ticket as `content-length`, so an upload larger than this is
 * refused by storage rather than by us — which matters because refusing it
 * ourselves would mean having already received it.
 */
export const MAX_SOURCE_BYTES = 100 * 1024 * 1024;

/**
 * How long a source stays readable: 90 days.
 *
 * Enforced on OUR clock, not the provider's lifecycle schedule, so "expired" is
 * a promise we keep rather than one we hope has been applied.
 */
export const SOURCE_RETENTION_DAYS = 90;

/* -------------------------------------------------------------- the parser */

/**
 * What the analysis and execution jobs may read from one source.
 *
 * `maxRows` is the published ceiling: **200,000 rows in the file, header
 * included** — so a file at the limit carries 199,999 products. That off-by-one
 * is stated rather than rounded because it is the difference between a customer
 * understanding a refusal and not: `large-file-envelope.spec.ts` reads a file of
 * exactly this size and proves one row more is refused, by name and with both
 * numbers in the message.
 *
 * `maxCells` bounds the same file by AREA, because 200,000 rows that are also
 * 500 columns wide is a hundred million cells and a different problem entirely
 * — the row count alone would admit it.
 *
 * These are JOB limits. The serving container never parses a file.
 */
export const JOB_ADAPTER_LIMITS: AdapterLimits = {
  maxRows: 200_000,
  maxCells: 4_000_000,
  maxColumns: 512,
  maxSheets: 32,
  maxCellChars: 32_768,
  maxPartBytes: 64 * 1024 * 1024,
};

/**
 * Rows the analysis PROFILES to propose a mapping: 200.
 *
 * A census of the whole file is taken regardless — this bounds only the sample
 * the column profiler reasons over, because inferring "this column holds
 * prices" does not get more certain after two hundred examples, and doing it
 * over two hundred thousand costs real time for no better answer.
 */
export const ANALYSIS_SAMPLE_ROWS = 200;

/* -------------------------------------------------------------- the editor */

/**
 * Rows the editor previews: 25.
 *
 * A PAGE, and nothing more. It bounds what a person is shown while mapping and
 * has no bearing on what a plan covers or an execution writes — both of which
 * re-read the whole file. `plan-compiler.ts` passes the full row count
 * explicitly for exactly this reason: using the default there would have
 * imported the first twenty-five rows of a nine-hundred-row export and reported
 * success.
 */
export const PREVIEW_PAGE_ROWS = 25;

/** Longest single value the preview will show without flagging it: 2,000 characters. */
export const PREVIEW_MAX_TEXT_LENGTH = 2_000;

/**
 * Columns any mapping may carry: 512.
 *
 * Matches the parser's own column ceiling. A mapping that could name more
 * columns than the parser will read would be a mapping with unreachable
 * entries.
 */
export const MAX_MAPPING_COLUMNS = 512;

/** Sample rows a client may send with a plan or preview request: 200. */
export const MAX_SAMPLE_ROWS = 200;

/* ------------------------------------------------------------- execution */

/**
 * Rows per batch, as a CEILING rather than a target: 200.
 *
 * The real batch size is computed per run from measured cost — see
 * `BatchBudget`. A product row costs ten statements, so at a 40 ms round trip
 * only about 74 rows fit the safe window, and the adaptive size will be far
 * below this number on a slow database. What this ceiling protects is the
 * mutation payload, not the clock.
 */
export const MAX_BATCH_ROWS = 200;

/** Smallest batch the budget will ever propose: one row. Progress must always be possible. */
export const MIN_BATCH_ROWS = 1;

/** Row results a client may request in one page: 1,000. */
export const MAX_ROW_RESULTS_PAGE = 1_000;

/* ------------------------------------------------------------------ totals */

/**
 * The numbers a person is told, and the shape of the promise.
 *
 * Exported as data so the documentation and the tests read the same values
 * rather than two copies that drift.
 */
export const PUBLISHED_IMPORT_LIMITS = {
  maxSourceBytes: MAX_SOURCE_BYTES,
  maxRows: JOB_ADAPTER_LIMITS.maxRows,
  maxCells: JOB_ADAPTER_LIMITS.maxCells,
  maxSheets: JOB_ADAPTER_LIMITS.maxSheets,
  maxColumns: JOB_ADAPTER_LIMITS.maxColumns,
  maxCellChars: JOB_ADAPTER_LIMITS.maxCellChars,
  sourceRetentionDays: SOURCE_RETENTION_DAYS,
} as const;

/**
 * The version of the pipeline that read a file and built a plan.
 *
 * One constant for what used to be three `'p9-1'` literals scattered across the
 * lifecycle service. It is part of the plan hash — a plan built by a parser
 * that has since changed is a different plan over the same bytes — so a literal
 * that could be bumped in the insert and forgotten in the hash is a way for an
 * approval to survive a change to how the file is read.
 *
 * Bumping this deliberately invalidates every future hash, which is the point.
 */
export const IMPORT_PIPELINE_VERSION = 'p9-1';
