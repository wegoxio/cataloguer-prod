import {
  REPORT_COLUMNS,
  ReportRow,
  buildReport,
  describeOutcome,
  describeRowRanges,
  headlineFor,
  renderReportCsv,
  repairInstructions,
  rowsNeedingAttention,
  summarizeRows,
} from '../import-report';
import { RowOutcome } from '../../entities/import-row-result.entity';

/**
 * The document someone opens three weeks later when a price is wrong.
 *
 * It has to be complete, specific enough to act on, and safe to open — the
 * import is exactly the path by which a hostile value gets in, and the report
 * is exactly the document that carries it back out.
 */

const row = (over: Partial<ReportRow> = {}): ReportRow => ({
  sourceTable: 'Productos',
  sourceRow: 2,
  outcome: RowOutcome.CREATED,
  ...over,
});

describe('every row appears', () => {
  it('counts each outcome separately', () => {
    const rows = [
      row({ outcome: RowOutcome.CREATED }),
      row({ outcome: RowOutcome.UPDATED, sourceRow: 3 }),
      row({ outcome: RowOutcome.SKIPPED, sourceRow: 4 }),
      row({ outcome: RowOutcome.BLOCKED, sourceRow: 5 }),
      row({ outcome: RowOutcome.FAILED, sourceRow: 6 }),
      row({ outcome: RowOutcome.UNRESOLVED, sourceRow: 7 }),
    ];
    expect(summarizeRows(rows)).toEqual({
      created: 1,
      updated: 1,
      skipped: 1,
      blocked: 1,
      failed: 1,
      unresolved: 1,
      total: 6,
    });
  });

  it('separates what reached the catalogue from what did not', () => {
    // A report listing only successes is how a partially applied import passes
    // for a complete one.
    const rows = [
      row({ outcome: RowOutcome.CREATED }),
      row({ outcome: RowOutcome.FAILED, sourceRow: 3 }),
      row({ outcome: RowOutcome.BLOCKED, sourceRow: 4 }),
      row({ outcome: RowOutcome.UNRESOLVED, sourceRow: 5 }),
      // Skipped is a decision that was honoured, not a failure.
      row({ outcome: RowOutcome.SKIPPED, sourceRow: 6 }),
    ];
    expect(rowsNeedingAttention(rows).map((r) => r.sourceRow)).toEqual([3, 4, 5]);
  });
});

describe('the headline states a partial result as a partial result', () => {
  it('says so when everything landed', () => {
    expect(headlineFor(summarizeRows([row(), row({ sourceRow: 3 })]))).toBe('All 2 rows were imported.');
  });

  it('names the rows needing attention when some did not', () => {
    // Bounded execution commits durable batches by design, so "partly
    // imported" is a first-class outcome rather than a failure to dress up.
    const summary = summarizeRows([row(), row({ outcome: RowOutcome.FAILED, sourceRow: 3 })]);
    expect(headlineFor(summary)).toBe('1 of 2 rows were imported. 1 did not reach your catalogue and needs attention.');
  });

  it('does not claim success when nothing was applied', () => {
    const summary = summarizeRows([row({ outcome: RowOutcome.FAILED }), row({ outcome: RowOutcome.BLOCKED })]);
    expect(headlineFor(summary)).toMatch(/^Nothing was imported\./);
  });

  it('distinguishes a deliberate skip from a failure', () => {
    const summary = summarizeRows([row(), row({ outcome: RowOutcome.SKIPPED, sourceRow: 3 })]);
    expect(headlineFor(summary)).toContain('deliberately skipped');
    expect(headlineFor(summary)).not.toContain('attention');
  });

  it('handles an empty run without pretending it succeeded', () => {
    expect(headlineFor(summarizeRows([]))).toMatch(/no rows to import/);
  });
});

describe('what happened, in words', () => {
  it('says what the row did rather than naming a status code', () => {
    expect(describeOutcome(row({ outcome: RowOutcome.CREATED }))).toBe('Added to your catalogue.');
    expect(describeOutcome(row({ outcome: RowOutcome.UPDATED }))).toBe('An existing record was updated.');
  });

  it('carries the reason into the sentence when there is one', () => {
    expect(describeOutcome(row({ outcome: RowOutcome.FAILED, reason: 'the price is not a number' }))).toBe(
      'Could not be imported: the price is not a number.',
    );
  });

  it('is still a whole sentence when no reason was recorded', () => {
    expect(describeOutcome(row({ outcome: RowOutcome.FAILED }))).toBe('Could not be imported.');
  });

  it('says explicitly that a blocked row was refused BEFORE anything was written', () => {
    // The difference between "we tried and failed" and "we never started"
    // decides whether the person needs to check their catalogue.
    expect(describeOutcome(row({ outcome: RowOutcome.BLOCKED }))).toMatch(/before anything was written/);
  });
});

describe('repair is forward, and specific', () => {
  const mixed = [
    row({ sourceRow: 2, outcome: RowOutcome.CREATED }),
    row({ sourceRow: 3, outcome: RowOutcome.FAILED, reason: 'the price is not a number' }),
    row({ sourceRow: 4, outcome: RowOutcome.FAILED, reason: 'the price is not a number' }),
    row({ sourceRow: 9, outcome: RowOutcome.UNRESOLVED, reason: 'two products share this code' }),
  ];

  it('says nothing when there is nothing to repair', () => {
    expect(repairInstructions([row(), row({ sourceRow: 3 })])).toEqual([]);
  });

  it('names exactly which rows need doing again', () => {
    expect(repairInstructions(mixed)[0]).toContain('3–4, 9');
  });

  it('says the rest does NOT need repeating', () => {
    // "Fix your file and import it again" would re-apply rows that already
    // succeeded, updating records that were already correct and adding noise to
    // every audit trail that touches them.
    const instructions = repairInstructions(mixed).join(' ');
    expect(instructions).toContain('does not need to be repeated');
    expect(instructions).toContain('ONLY them');
  });

  it('never offers an undo', () => {
    // There is none. The import committed durable batches by design, and a
    // rollback would have to guess which later edits were the customer's own.
    const instructions = repairInstructions(mixed).join(' ').toLowerCase();
    expect(instructions).not.toMatch(/undo|roll ?back|revert|reverse/);
  });

  it('groups by reason so a common cause reads as one line', () => {
    const instructions = repairInstructions(mixed);
    expect(instructions.some((i) => i.startsWith('2 rows: the price is not a number'))).toBe(true);
    expect(instructions.some((i) => i.startsWith('1 row: two products share this code'))).toBe(true);
  });

  it('puts the most common cause first', () => {
    const instructions = repairInstructions(mixed);
    const reasons = instructions.filter((i) => /^\d+ rows?:/.test(i));
    expect(reasons[0]).toContain('2 rows');
  });

  it('still says something when no reason was recorded', () => {
    const instructions = repairInstructions([row({ outcome: RowOutcome.FAILED })]);
    expect(instructions.some((i) => i.includes('No reason was recorded'))).toBe(true);
  });
});

describe('row ranges read like a person would write them', () => {
  it('collapses runs', () => {
    expect(describeRowRanges([2, 3, 4, 5, 6, 7])).toBe('2–7');
  });

  it('keeps gaps apart', () => {
    expect(describeRowRanges([2, 3, 4, 7, 12, 13])).toBe('2–4, 7, 12–13');
  });

  it('sorts and de-duplicates whatever it is handed', () => {
    expect(describeRowRanges([9, 2, 3, 2, 4])).toBe('2–4, 9');
  });

  it('stops before becoming a wall of numbers', () => {
    const scattered = Array.from({ length: 40 }, (_, i) => i * 2 + 2);
    const described = describeRowRanges(scattered);
    expect(described).toMatch(/and \d+ more$/);
    expect(described.split(',').length).toBeLessThanOrEqual(13);
  });

  it('handles one row and none', () => {
    expect(describeRowRanges([5])).toBe('5');
    expect(describeRowRanges([])).toBe('');
  });
});

describe('the CSV is safe to open', () => {
  it('neutralizes a formula that arrived through the import', () => {
    // The import is exactly the path by which such a value gets in, and this
    // report is exactly the document that carries it back out.
    const csv = renderReportCsv([row({ outcome: RowOutcome.FAILED, reason: "=cmd|'/c calc'!A1 is not a number" })]);
    expect(csv).toContain("'=cmd");
    expect(csv).not.toMatch(/(^|,|")=cmd/);
  });

  it('neutralizes every leading character a spreadsheet would evaluate', () => {
    for (const dangerous of ['=SUM(A1)', '+1+1', '-1+1', '@SUM(A1)', '\tx', '\rx']) {
      const csv = renderReportCsv([row({ outcome: RowOutcome.FAILED, reason: dangerous })]);
      expect(csv).toContain(`'${dangerous}`);
    }
  });

  it('leaves an ordinary value exactly as it was', () => {
    // Stored data keeps the tenant's bytes; a round trip must not mutate a real
    // value.
    const csv = renderReportCsv([row({ reason: 'Camiseta azul' })]);
    expect(csv).toContain('Camiseta azul');
    expect(csv).not.toContain("'Camiseta");
  });

  it('carries a header row naming every column', () => {
    const csv = renderReportCsv([row()]);
    expect(csv.split(/\r?\n/)[0]).toBe(REPORT_COLUMNS.join(','));
  });

  it('includes the target so a wrong record can be found', () => {
    const csv = renderReportCsv([
      row({
        outcome: RowOutcome.UPDATED,
        targetType: 'product',
        targetId: '3d7eb696-0000-4000-8000-000000000000',
        matchProvenance: 'INTERNAL_SKU',
      }),
    ]);
    expect(csv).toContain('3d7eb696-0000-4000-8000-000000000000');
    // The provenance is what makes a wrong match explainable rather than
    // merely wrong.
    expect(csv).toContain('INTERNAL_SKU');
  });

  it('includes rows that failed as well as rows that worked', () => {
    const csv = renderReportCsv([row(), row({ sourceRow: 3, outcome: RowOutcome.FAILED, reason: 'no name' })]);
    const lines = csv.trim().split(/\r?\n/);
    expect(lines).toHaveLength(3);
    expect(csv).toContain('FAILED');
  });

  it('produces a header and nothing else for an empty run', () => {
    expect(renderReportCsv([]).trim()).toBe(REPORT_COLUMNS.join(','));
  });
});

describe('the assembled report', () => {
  it('carries the summary, the headline, the repair steps and every row', () => {
    const report = buildReport([
      row(),
      row({ sourceRow: 3, outcome: RowOutcome.FAILED, reason: 'the price is not a number' }),
    ]);
    expect(report.summary.total).toBe(2);
    expect(report.headline).toContain('1 of 2');
    expect(report.repair.length).toBeGreaterThan(0);
    expect(report.rows).toHaveLength(2);
  });

  it('offers no repair steps when nothing needs repairing', () => {
    expect(buildReport([row()]).repair).toEqual([]);
  });
});
