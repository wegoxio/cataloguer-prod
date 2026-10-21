import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderReportCsv, describeEffects, REPORT_COLUMNS } from '../import-report';
import { RowOutcome } from '../../entities/import-row-result.entity';
import type { ReportRow } from '../import-report';

/**
 * The downloadable report carries the same facts as the screen.
 *
 * A report that said only "created" is what let a run create products, list
 * none of them in the shop it was scoped to, file none of them under a
 * category, and be read as a success by everybody who opened it.
 *
 * Category paths are user-controlled text arriving from a spreadsheet and
 * leaving in one, so they are exactly the values a formula-injection payload
 * would travel in.
 */

const row = (over: Partial<ReportRow> = {}): ReportRow => ({
  sourceTable: 'main',
  sourceRow: 2,
  outcome: RowOutcome.CREATED,
  ...over,
});

/**
 * The phrasing contract, read from the file the browser is also tested against.
 *
 * Deliberately not a copy of the strings. A report and a screen that describe
 * the same run in different words is the exact failure this feature exists to
 * prevent, so both sides assert against one file and neither can drift alone.
 */
const CONTRACT = JSON.parse(
  readFileSync(join(__dirname, '..', '../../../../test/fixtures/row-effect-phrases.json'), 'utf8'),
) as {
  cases: {
    name: string;
    effects: ReportRow['effects'];
    expect: { product: string; store: string; categories: string; stock: string };
  }[];
};

describe('the report and the screen agree, phrase for phrase', () => {
  it.each(CONTRACT.cases.map((c) => [c.name, c] as const))('%s', (_name, testCase) => {
    const [product, store, categories, stock] = describeEffects(row({ effects: testCase.effects }));
    expect({ product, store, categories, stock }).toEqual(testCase.expect);
  });

  it('covers every case the shared contract defines', () => {
    // Guards against a case being added to the fixture for the browser and
    // silently never exercised here.
    expect(CONTRACT.cases.length).toBeGreaterThanOrEqual(8);
  });
});

describe('the report describes each effect', () => {
  it('names all four effect columns', () => {
    expect(REPORT_COLUMNS).toContain('Product');
    expect(REPORT_COLUMNS).toContain('Listed in shop');
    expect(REPORT_COLUMNS).toContain('Categories');
    expect(REPORT_COLUMNS).toContain('Stock');
  });

  it('states the shop listing as unpublished, by name', () => {
    const csv = renderReportCsv([
      row({
        effects: {
          product: { state: 'CREATED' },
          storeAssociation: { state: 'CREATED', storeName: 'Store B', published: false },
        },
      }),
    ]);
    expect(csv).toContain('created in Store B (unpublished)');
  });

  it('separates categories it created from categories it reused', () => {
    const csv = renderReportCsv([
      row({
        effects: {
          categories: { state: 'CREATED', created: ['Aceptacion P9'], reused: ['Ropa'] },
        },
      }),
    ]);
    expect(csv).toContain('created: Aceptacion P9');
    expect(csv).toContain('reused: Ropa');
  });

  it('names the destination and the quantity for stock that moved', () => {
    const csv = renderReportCsv([
      row({
        effects: {
          inventory: { state: 'CREATED', locationName: 'Store B custody', locationKind: 'STORE', quantity: 7 },
        },
      }),
    ]);
    expect(csv).toContain('7 to Store B custody (store)');
  });

  it('says a zero quantity moved nothing, rather than saying nothing', () => {
    const csv = renderReportCsv([row({ effects: { inventory: { state: 'ZERO_NO_MOVEMENT', quantity: 0 } } })]);
    expect(csv).toContain('no stock movement (zero)');
  });

  it('distinguishes not-requested from not-recorded', () => {
    const requested = renderReportCsv([row({ effects: { inventory: { state: 'NOT_REQUESTED' } } })]);
    expect(requested).toContain('not requested');

    // A row written before effects existed. It must not claim every effect was
    // "not requested" — that is a fact the run never recorded.
    const legacy = renderReportCsv([row({ effects: null })]);
    expect(legacy).toContain('not recorded');
    expect(legacy).not.toContain('not requested');
  });

  it('renders a rolled-back row as rolled back, not as success', () => {
    const csv = renderReportCsv([
      row({
        outcome: RowOutcome.BLOCKED,
        effects: {
          product: { state: 'BLOCKED' },
          categories: { state: 'ROLLED_BACK' },
          inventory: { state: 'ROLLED_BACK' },
        },
      }),
    ]);
    expect(csv).toContain('rolled back');
    expect(csv).toContain('blocked');
  });

  it('neutralizes a formula hidden in a category path', () => {
    // The payload arrives as catalogue text and leaves in a spreadsheet. This
    // is the exact route by which an import becomes a code-execution vector.
    const csv = renderReportCsv([
      row({
        effects: { categories: { state: 'CREATED', created: ["=cmd|'/c calc'!A1"] } },
      }),
    ]);
    expect(csv).not.toMatch(/,=cmd/);
    expect(csv).not.toMatch(/^=cmd/m);
  });

  it('carries no internal identifier the person does not need', () => {
    const csv = renderReportCsv([
      row({
        effects: {
          storeAssociation: { state: 'CREATED', storeName: 'Store B', published: false },
          inventory: { state: 'CREATED', locationName: 'Store B custody', locationKind: 'STORE', quantity: 3 },
        },
      }),
    ]);
    // Names are enough. A location or store UUID proves nothing to a reader and
    // invites nobody to notice it is the wrong branch.
    expect(csv).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });
});
