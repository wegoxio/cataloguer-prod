import * as fs from 'fs';
import * as path from 'path';
import { JOB_ARCHIVE_BUDGET, censusArchive } from '../archive-gate';
import { censusWorkbook, parseCellRef, readSheetNames } from '../workbook-census';

const fixture = (n: string) => fs.readFileSync(path.join(__dirname, '..', '__fixtures__', n));
const MAX = 8 * 1024 * 1024;

describe('workbook census', () => {
  it('translates cell references to 1-based coordinates', () => {
    expect(parseCellRef('A1')).toEqual({ row: 1, column: 1 });
    expect(parseCellRef('B12')).toEqual({ row: 12, column: 2 });
    expect(parseCellRef('AA3')).toEqual({ row: 3, column: 27 });
    expect(parseCellRef('nonsense')).toBeNull();
  });

  it('reads sheet display names in declaration order', () => {
    const buf = fixture('clean-multisheet.xlsx');
    const arch = censusArchive(buf, JOB_ARCHIVE_BUDGET);
    expect(readSheetNames(buf, arch, MAX)).toEqual(['Products', 'Notes']);
  });

  describe('a clean multi-sheet workbook', () => {
    const buf = fixture('clean-multisheet.xlsx');
    const arch = censusArchive(buf, JOB_ARCHIVE_BUDGET);
    const wb = censusWorkbook(buf, arch, MAX);

    it('censuses every sheet with its real name and position', () => {
      expect(wb.sheets.map((s) => [s.index, s.name])).toEqual([
        [1, 'Products'],
        [2, 'Notes'],
      ]);
    });

    it('surfaces formula TEXT the value reader hides, without evaluating it', () => {
      const products = wb.sheets[0];
      const byRef = Object.fromEntries(products.formulas.map((f) => [f.ref, f.formula]));
      expect(byRef['C2']).toBe('B2*2');
      expect(byRef['C3']).toBe('SUM(B2:B3)');
      // A mapper must be able to see that a column was computed before deciding
      // to import its cached number.
      expect(products.formulas).toHaveLength(3);
    });

    it('flags an external reference in a formula as such', () => {
      const products = wb.sheets[0];
      const external = products.formulas.find((f) => f.ref === 'C4');
      expect(external?.formula).toContain('[1]Ext!A1');
    });

    it('reports merged ranges as coordinates, not just text', () => {
      const products = wb.sheets[0];
      expect(products.merged).toEqual([{ ref: 'A1:B1', fromRow: 1, toRow: 1, fromColumn: 1, toColumn: 2 }]);
    });

    it('records the declared dimension and the observed extent', () => {
      const products = wb.sheets[0];
      expect(products.dimension).toBe('A1:D4');
      expect(products.rowCount).toBe(4);
      expect(products.maxColumn).toBe(4);
    });

    it('totals formulas and merges across the workbook', () => {
      expect(wb.totalFormulas).toBe(3);
      expect(wb.totalMergedRanges).toBe(1);
    });
  });

  it('censuses a large sheet without holding a DOM of it', () => {
    const buf = fixture('legit-high-compression.xlsx');
    const arch = censusArchive(buf, JOB_ARCHIVE_BUDGET);
    const before = process.memoryUsage().rss;
    const wb = censusWorkbook(buf, arch, MAX);
    const grewMiB = (process.memoryUsage().rss - before) / 1048576;

    expect(wb.sheets[0].rowCount).toBe(40000);
    expect(wb.sheets[0].formulas).toEqual([]);
    expect(grewMiB).toBeLessThan(128);
  });

  it('carries the media census forward from the archive gate', () => {
    const buf = fixture('with-image.xlsx');
    const arch = censusArchive(buf, JOB_ARCHIVE_BUDGET);
    expect(censusWorkbook(buf, arch, MAX).mediaEntries).toEqual(['xl/media/image1.png']);
  });
});
