// The DTOs below use class-validator decorators, which need the metadata
// polyfill loaded before the module graph is evaluated.
import 'reflect-metadata';
import {
  ANALYSIS_SAMPLE_ROWS,
  JOB_ADAPTER_LIMITS,
  MAX_BATCH_ROWS,
  MAX_MAPPING_COLUMNS,
  MAX_ROW_RESULTS_PAGE,
  MAX_SAMPLE_ROWS,
  MAX_SOURCE_BYTES,
  MIN_BATCH_ROWS,
  PREVIEW_MAX_TEXT_LENGTH,
  PREVIEW_PAGE_ROWS,
  PUBLISHED_IMPORT_LIMITS,
  SOURCE_RETENTION_DAYS,
} from '../../shared/import-limits';
import { DEFAULT_PREVIEW_ROWS, DEFAULT_MAX_TEXT_LENGTH, buildNormalizedPreview } from '../../preview/normalized-preview';
import { DEFAULT_BATCH_ROWS, planBatches, PlannedUnit } from '../../execution/batch-planner';
import { MAX_COLUMNS, MAX_SAMPLE_ROWS as DTO_MAX_SAMPLE_ROWS } from '../../wizard/wizard.dto';
import { BatchBudget, SAFE_BATCH_WINDOW_MS } from '../../execution/batch-budget';
import { JOB_ARCHIVE_BUDGET, PREVIEW_ARCHIVE_BUDGET } from '../../parsing/archive-gate';
import { SOURCE_RETENTION_DAYS as STORAGE_RETENTION_DAYS } from '../../storage/import-source-storage.service';

/**
 * The limits, pinned.
 *
 * The discovery report's complaint was not that 500 rows was too few. It was
 * that nobody had DECIDED 500 — it was the arithmetic consequence of an Express
 * default nobody had noticed, and a ceiling nobody chose is a ceiling nobody can
 * defend or raise.
 *
 * So every number is asserted here against the single module that declares it,
 * and the relationships between them are asserted too, because most of the ways
 * these can be wrong are relationships: a preview page larger than the file a
 * plan covers, a mapping able to name more columns than the parser will read, a
 * batch ceiling below the smallest batch the budget can propose.
 *
 * The most important of them has its own section: a PAGE never bounds a PLAN.
 */

describe('the published limits', () => {
  it('states the source ceiling as 100 MiB', () => {
    expect(MAX_SOURCE_BYTES).toBe(100 * 1024 * 1024);
  });

  it('states the row ceiling as 200,000', () => {
    // The published maximum. Not a guess: `import-limits.pg.spec` reads a file
    // of exactly this many rows end to end through the real parser.
    expect(JOB_ADAPTER_LIMITS.maxRows).toBe(200_000);
  });

  it('bounds the same file by AREA as well as by rows', () => {
    // 200,000 rows that are also 500 columns wide is a hundred million cells
    // and a completely different problem. The row count alone would admit it.
    expect(JOB_ADAPTER_LIMITS.maxCells).toBe(4_000_000);
    expect(JOB_ADAPTER_LIMITS.maxCells).toBeLessThan(JOB_ADAPTER_LIMITS.maxRows * JOB_ADAPTER_LIMITS.maxColumns);
  });

  it('states the sheet, column and cell-size ceilings', () => {
    expect(JOB_ADAPTER_LIMITS.maxSheets).toBe(32);
    expect(JOB_ADAPTER_LIMITS.maxColumns).toBe(512);
    expect(JOB_ADAPTER_LIMITS.maxCellChars).toBe(32_768);
  });

  it('keeps retention in ONE place, so the promise and the enforcement agree', () => {
    expect(SOURCE_RETENTION_DAYS).toBe(90);
    expect(STORAGE_RETENTION_DAYS).toBe(SOURCE_RETENTION_DAYS);
  });

  it('publishes exactly the numbers it enforces', () => {
    // The documentation reads this object. Two copies of a limit is how a
    // document comes to describe a previous release.
    expect(PUBLISHED_IMPORT_LIMITS).toEqual({
      maxSourceBytes: MAX_SOURCE_BYTES,
      maxRows: JOB_ADAPTER_LIMITS.maxRows,
      maxCells: JOB_ADAPTER_LIMITS.maxCells,
      maxSheets: JOB_ADAPTER_LIMITS.maxSheets,
      maxColumns: JOB_ADAPTER_LIMITS.maxColumns,
      maxCellChars: JOB_ADAPTER_LIMITS.maxCellChars,
      sourceRetentionDays: SOURCE_RETENTION_DAYS,
    });
  });
});

describe('the archive gate', () => {
  it('bounds a job by expanded BYTES, not by ratio', () => {
    expect(JOB_ARCHIVE_BUDGET.maxTotalInflatedBytes).toBe(256 * 1024 * 1024);
    expect(JOB_ARCHIVE_BUDGET.maxEntryInflatedBytes).toBe(64 * 1024 * 1024);
    expect(JOB_ARCHIVE_BUDGET.maxEntries).toBe(512);
  });

  it('treats compression ratio as an ANOMALY signal, far above anything legitimate', () => {
    // Measured on real fixtures: a legitimate 40,000-row workbook compresses
    // 10.2:1 and the bomb is 1023:1. A flat 10:1 cap would reject the real
    // file, so the ratio never rejects on its own.
    expect(JOB_ARCHIVE_BUDGET.ratioAnomalyThreshold).toBe(100);
    expect(JOB_ARCHIVE_BUDGET.ratioAnomalyThreshold).toBeGreaterThan(10.2);
  });

  it('gives a PREVIEW a much smaller budget than a job', () => {
    // A preview runs while somebody waits; a job does not.
    expect(PREVIEW_ARCHIVE_BUDGET.maxTotalInflatedBytes).toBeLessThan(JOB_ARCHIVE_BUDGET.maxTotalInflatedBytes);
    expect(PREVIEW_ARCHIVE_BUDGET.deadlineMs).toBeLessThan(JOB_ARCHIVE_BUDGET.deadlineMs);
  });
});

describe('one source of truth', () => {
  it('has the preview read its page size from the shared module', () => {
    expect(DEFAULT_PREVIEW_ROWS).toBe(PREVIEW_PAGE_ROWS);
    expect(DEFAULT_MAX_TEXT_LENGTH).toBe(PREVIEW_MAX_TEXT_LENGTH);
  });

  it('has the batch planner read its ceiling from the shared module', () => {
    expect(DEFAULT_BATCH_ROWS).toBe(MAX_BATCH_ROWS);
  });

  it('has the request DTOs read their bounds from the shared module', () => {
    expect(MAX_COLUMNS).toBe(MAX_MAPPING_COLUMNS);
    expect(DTO_MAX_SAMPLE_ROWS).toBe(MAX_SAMPLE_ROWS);
  });

  it('never lets a mapping name more columns than the parser will read', () => {
    // A mapping with entries the parser can never reach would be a mapping
    // whose later columns silently do nothing.
    expect(MAX_MAPPING_COLUMNS).toBeLessThanOrEqual(JOB_ADAPTER_LIMITS.maxColumns);
  });

  it('never lets a client send more sample rows than the analysis profiles', () => {
    expect(MAX_SAMPLE_ROWS).toBeLessThanOrEqual(ANALYSIS_SAMPLE_ROWS);
  });

  it('pages row results well below the row ceiling, since a report is read not processed', () => {
    expect(MAX_ROW_RESULTS_PAGE).toBe(1_000);
    expect(MAX_ROW_RESULTS_PAGE).toBeLessThan(JOB_ADAPTER_LIMITS.maxRows);
  });
});

describe('the batch ceiling versus the adaptive size', () => {
  it('is a CEILING, and the measured size sits under it', () => {
    // 40 ms round trip, ten statements a row: about 74 rows fit the safe
    // window. The ceiling protects the payload; the clock is protected by the
    // budget, and on a slow database the budget wins by a wide margin.
    const budget = new BatchBudget(SAFE_BATCH_WINDOW_MS, 10 * 40);
    const rows = budget.nextBatchRows();

    expect(rows).toBeLessThan(MAX_BATCH_ROWS);
    expect(rows).toBeGreaterThanOrEqual(MIN_BATCH_ROWS);
    expect(budget.projectedMs(rows)).toBeLessThanOrEqual(SAFE_BATCH_WINDOW_MS);
  });

  it('never proposes zero, so progress is always possible', () => {
    // Even against an absurdly slow database, one row at a time still finishes.
    const budget = new BatchBudget(SAFE_BATCH_WINDOW_MS, 10_000_000);
    expect(budget.nextBatchRows()).toBe(MIN_BATCH_ROWS);
  });

  it('caps at the ceiling however fast the database is', () => {
    const budget = new BatchBudget(SAFE_BATCH_WINDOW_MS, 0.001);
    expect(budget.nextBatchRows()).toBeLessThanOrEqual(MAX_BATCH_ROWS);
  });
});

/**
 * The property the whole section exists for.
 *
 * A page is what somebody is shown. A plan is what will be written. If the
 * first ever bounded the second, an import would quietly do a quarter of what
 * was approved and report success — which is precisely the defect the compiler
 * shipped with until the resume case caught it.
 */
describe('a preview page never bounds a plan', () => {
  const rows = (count: number): string[][] =>
    Array.from({ length: count }, (_, i) => [`SKU-${i + 1}`, `Producto ${i + 1}`]);

  const mapping = {
    sheet: 'main',
    headerRow: 1,
    columns: [
      { columnIndex: 0, header: 'sku', field: 'sku' as const, reviewed: true },
      { columnIndex: 1, header: 'nombre', field: 'name' as const, reviewed: true },
    ],
  };

  it('shows one page by default, however long the file is', () => {
    const preview = buildNormalizedPreview(rows(900), 2, mapping, { importType: 'PRODUCTS' });

    expect(preview.previewedRows).toBe(PREVIEW_PAGE_ROWS);
    expect(preview.rows).toHaveLength(PREVIEW_PAGE_ROWS);
  });

  it('covers EVERY row when the caller states the file’s length', () => {
    // What the plan compiler does. Getting this wrong imported the first
    // twenty-five rows of a nine-hundred-row export and called it a success.
    const all = rows(900);
    const preview = buildNormalizedPreview(all, 2, mapping, { importType: 'PRODUCTS', limit: all.length });

    expect(preview.previewedRows).toBe(900);
    expect(preview.rows[0].sourceRow).toBe(2);
    expect(preview.rows[899].sourceRow).toBe(901);
  });

  it('plans batches across the WHOLE file, not one page of it', () => {
    const all = rows(900);
    const preview = buildNormalizedPreview(all, 2, mapping, { importType: 'PRODUCTS', limit: all.length });

    const units: PlannedUnit[] = preview.rows.map((row) => ({
      kind: 'ROW',
      sourceRows: [row.sourceRow],
      mutations: {},
    }));
    const batches = planBatches('a'.repeat(64), units, MAX_BATCH_ROWS);

    // Every row lands in exactly one batch, and there is more than one batch —
    // so the ceiling is really being applied rather than the file fitting.
    expect(batches.length).toBeGreaterThan(1);
    const planned = batches.flatMap((batch) => batch.units.flatMap((unit) => unit.sourceRows));
    expect(planned).toHaveLength(900);
    expect(new Set(planned).size).toBe(900);
    expect(Math.min(...planned)).toBe(2);
    expect(Math.max(...planned)).toBe(901);
  });
});
