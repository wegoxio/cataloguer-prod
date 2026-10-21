import { RowOutcome } from '../../entities/import-row-result.entity';
import type { RowApplication } from '../import-executor';
import type { ReportRow } from '../import-report';

/**
 * Nothing an applier established may be lost on the way to the report.
 *
 * `toReportRow` converts an applier's result into the row that is stored and
 * reported. It is a hand-written field list, and when `effects` was added to
 * `RowApplication` this function was not updated — so every effect the appliers
 * computed was silently discarded, every stored row had `effects = null`, and
 * the screen fell back to "not recorded" for a run that had recorded plenty.
 *
 * The failure was invisible: no type error, no test failure, no log line. A
 * dropped field is exactly as quiet as the original defect this whole feature
 * exists to close, one layer further down.
 *
 * So the two types are compared directly. Adding a field to `RowApplication`
 * without carrying it across now fails here.
 */

describe('an applier result reaches the report intact', () => {
  it('carries every field of RowApplication into ReportRow', () => {
    // Exhaustive by construction: TypeScript requires every key, so a new
    // field on RowApplication makes this object fail to compile until it is
    // listed — and then fail below until it is actually carried across.
    const application: Required<RowApplication> = {
      sourceRow: 2,
      outcome: RowOutcome.CREATED,
      targetType: 'PRODUCT',
      targetId: 'a1b2c3d4',
      matchProvenance: 'sku',
      reason: 'matched on sku',
      effects: { product: { state: 'CREATED', sku: 'ABC-1' } },
    };

    const reported = toReportRowUnderTest(application, 'main');

    for (const key of Object.keys(application) as (keyof RowApplication)[]) {
      // `sourceRow` is the one field whose name differs from nothing — every
      // key of an application must appear on the reported row, carrying a
      // value, not silently dropped to undefined.
      expect(reported).toHaveProperty(key);
      expect(reported[key as keyof ReportRow]).toBeDefined();
    }

    expect(reported.effects).toEqual(application.effects);
    expect(reported.sourceTable).toBe('main');
  });

  it('stores a missing effect as null rather than undefined', () => {
    // The column is nullable, and "this run recorded nothing" is a fact worth
    // storing explicitly. `undefined` would serialise to a missing key and
    // leave a reader unable to tell it from a field nobody thought about.
    const reported = toReportRowUnderTest({ sourceRow: 3, outcome: RowOutcome.SKIPPED }, 'main');
    expect(reported.effects).toBeNull();
    expect(reported).toHaveProperty('effects');
  });
});

/**
 * `toReportRow` is module-private, so it is reached through the source.
 *
 * Deliberately not re-implemented here: a copy would pass this test while the
 * real function kept dropping the field, which is precisely the bug.
 */
function toReportRowUnderTest(application: RowApplication, sourceTable: string): ReportRow {
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-member-access
  const module = require('../import-executor') as Record<string, unknown>;
  const exported = module.toReportRow as ((application: RowApplication, sourceTable: string) => ReportRow) | undefined;
  if (!exported) throw new Error('toReportRow must be exported for this guard to hold.');
  return exported(application, sourceTable);
}
