import { isFormulaLike, neutralizeCsvCell, neutralizeCsvRow, neutralizeCsvRows } from './formula-injection';

describe('CSV formula-injection neutralization', () => {
  it('recognizes every leader a spreadsheet treats as a formula', () => {
    for (const lead of ['=', '+', '-', '@', '\t', '\r']) {
      expect(isFormulaLike(`${lead}cmd`)).toBe(true);
    }
  });

  it('leaves ordinary catalogue text alone, including text that merely contains a leader', () => {
    for (const safe of ['Sofá Sabot', 'A=B', 'Mesa 2+2', 'x@y.com', '', 'MOBILIARIO > Sofás']) {
      expect(isFormulaLike(safe)).toBe(false);
      expect(neutralizeCsvCell(safe)).toBe(safe);
    }
  });

  it('prefixes a formula cell instead of stripping it, so the original text survives', () => {
    // The classic DDE payload. The point of the apostrophe is that the value is
    // still readable and recoverable — we never delete what the tenant stored.
    const attack = "=cmd|' /c calc'!A1";
    const safe = neutralizeCsvCell(attack) as string;
    expect(safe).toBe(`'${attack}`);
    expect(safe.slice(1)).toBe(attack);
  });

  it('neutralizes a negative number without corrupting its digits', () => {
    expect(neutralizeCsvCell('-12.50')).toBe("'-12.50");
  });

  it('passes non-strings through untouched', () => {
    expect(neutralizeCsvCell(42)).toBe(42);
    expect(neutralizeCsvCell(null)).toBeNull();
    expect(neutralizeCsvCell(undefined)).toBeUndefined();
    expect(neutralizeCsvCell(true)).toBe(true);
  });

  it('neutralizes every string field of a row and never mutates the input', () => {
    const row = { name: '=HYPERLINK("http://x")', slug: 'sofa', price: '100' };
    const out = neutralizeCsvRow(row);
    expect(out.name).toBe('\'=HYPERLINK("http://x")');
    expect(out.slug).toBe('sofa');
    expect(row.name).toBe('=HYPERLINK("http://x")');
  });

  it('handles a whole table', () => {
    const rows = [{ n: '@SUM(1)' }, { n: 'plain' }];
    expect(neutralizeCsvRows(rows)).toEqual([{ n: "'@SUM(1)" }, { n: 'plain' }]);
  });

  it('closes the import→export round trip: an imported hostile name cannot execute on export', () => {
    // Ingest permits tab and CR inside cells and never strips a leading `=`,
    // so the export boundary is where this must be stopped.
    const imported = '\t=1+1';
    expect(neutralizeCsvCell(imported)).toBe("'\t=1+1");
  });
});
