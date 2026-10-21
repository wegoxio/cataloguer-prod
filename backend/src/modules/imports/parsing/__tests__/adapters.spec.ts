import * as fs from 'fs';
import * as path from 'path';
import { DelimitedAdapter, decodeText, detectDelimiter } from '../delimited-adapter';
import { XlsxAdapter } from '../xlsx-adapter';
import { JOB_LIMITS, PREVIEW_LIMITS, SourceRejected, assertWithinLimits, selectAdapter } from '../source-adapter';
import { buildWooShapedCsv, WOO_SHAPED_COLUMN_COUNT, WOO_SHAPED_DATA_ROWS } from '../__fixtures__/woo-shaped-export.csv';

const fixture = (n: string) => fs.readFileSync(path.join(__dirname, '..', '__fixtures__', n));

describe('delimiter detection', () => {
  it('prefers the delimiter that yields a CONSISTENT field count, not the most frequent character', () => {
    // The trap: commas inside a quoted description outnumber the real
    // semicolon delimiter. Frequency picks ','; consistency picks ';'.
    const sample = [
      'name;description;price',
      'Sofa;"Comfortable, roomy, and soft";100',
      'Mesa;"Wide, low, and heavy";200',
    ].join('\n');
    expect(detectDelimiter(sample)).toBe(';');
  });

  it('detects tabs', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });

  it('falls back to comma for a single-column file', () => {
    expect(detectDelimiter('justonecolumn\nvalue')).toBe(',');
  });
});

describe('text decoding', () => {
  it('decodes UTF-8 and strips a BOM', () => {
    const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ID,Tipo', 'utf8')]);
    const { text, encoding } = decodeText(buf);
    expect(text).toBe('ID,Tipo');
    expect(encoding).toBe('utf-8');
  });

  it('falls back to windows-1252 and REPORTS it, so mojibake is traceable to a decision', () => {
    const latin = Buffer.from([0x53, 0x6f, 0x66, 0xe1]); // "Sofá" in cp1252
    const { text, encoding } = decodeText(latin);
    expect(encoding).toBe('windows-1252');
    expect(text).toBe('Sofá');
  });
});

describe('limit assertions name the FIRST limit reached', () => {
  it('tells a wide file about its width, not its length', () => {
    try {
      assertWithinLimits({ rows: 10, columns: 500 }, JOB_LIMITS);
      fail('expected rejection');
    } catch (e) {
      expect((e as SourceRejected).code).toBe('TOO_MANY_COLUMNS');
    }
  });

  it('stops a wide file on the CELL budget before the row ceiling', () => {
    // 100k rows x 45 cols = 4.5M cells. Measured peak RSS for this shape was
    // 484 MiB streamed — beyond a 512 MiB container. The cell budget is what
    // must stop it, not the row count, which is still under the limit.
    try {
      assertWithinLimits({ rows: 100_000, columns: 45 }, JOB_LIMITS);
      fail('expected rejection');
    } catch (e) {
      expect((e as SourceRejected).code).toBe('TOO_MANY_CELLS');
      expect((e as Error).message).toMatch(/wide file reaches that limit at fewer rows/i);
    }
  });

  it('ACCEPTS 100k narrow rows, which measured 98 MiB streamed', () => {
    expect(() => assertWithinLimits({ rows: 100_000, columns: 8 }, JOB_LIMITS)).not.toThrow();
  });

  it('rejects on rows only when the shape is narrow enough to get there', () => {
    try {
      assertWithinLimits({ rows: 250_000, columns: 4 }, JOB_LIMITS);
      fail('expected rejection');
    } catch (e) {
      expect((e as SourceRejected).code).toBe('TOO_MANY_ROWS');
    }
  });
});

describe('adapter selection is by content, not filename', () => {
  const adapters = [new DelimitedAdapter(), new XlsxAdapter()];

  it('routes a real CSV to the delimited adapter', () => {
    expect(selectAdapter(adapters, Buffer.from('a,b\n1,2'), 'x.csv').kind).toBe('CSV');
  });

  it('routes a workbook to the XLSX adapter even when misnamed .csv', () => {
    expect(selectAdapter(adapters, fixture('clean-multisheet.xlsx'), 'lying.csv').kind).toBe('XLSX');
  });

  it('refuses a format no adapter claims, with export guidance', () => {
    const pdf = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3', 'binary');
    try {
      selectAdapter(adapters, pdf, 'report.pdf');
      fail('expected rejection');
    } catch (e) {
      expect((e as SourceRejected).code).toBe('UNSUPPORTED_FORMAT');
      expect((e as Error).message).toMatch(/\.csv, \.tsv or \.xlsx/);
    }
  });
});

describe('delimited adapter', () => {
  const adapter = new DelimitedAdapter();

  it('censuses a small file', () => {
    const c = adapter.census(Buffer.from('name,price\nSofa,100\nMesa,200'), JOB_LIMITS);
    expect(c.kind).toBe('CSV');
    expect(c.sheets[0].rowCount).toBe(3);
    expect(c.sheets[0].columnCount).toBe(2);
    expect(c.totalCells).toBe(6);
  });

  it('reads a bounded range and reports truncation honestly', () => {
    const csv = ['h1,h2', ...Array.from({ length: 100 }, (_, i) => `a${i},b${i}`)].join('\n');
    const r = adapter.readRange(
      Buffer.from(csv),
      { sheetIndex: 1, fromRow: 2, maxRows: 10, maxCells: 1000 },
      JOB_LIMITS,
    );
    expect(r.rowsRead).toBe(10);
    expect(r.truncated).toBe(true);
    expect(r.rows[0]).toEqual(['a0', 'b0']);
  });

  describe('against a WooCommerce-shaped export', () => {
    // The real DesignHof export is git-ignored customer data and the repository
    // forbids any test from reading it, so this fixture reproduces its awkward
    // SHAPE — BOM, a quoted multi-line header cell, 45 columns, ragged rows,
    // blank SKUs, duplicate names — with invented values.
    const buf = () => buildWooShapedCsv();

    it('censuses the full width despite the BOM and the multi-line header cell', () => {
      const c = adapter.census(buf(), JOB_LIMITS);
      expect(c.sheets[0].columnCount).toBe(WOO_SHAPED_COLUMN_COUNT);
      expect(c.sheets[0].rowCount).toBe(WOO_SHAPED_DATA_ROWS + 1); // + header
      expect(c.encoding).toBe('utf-8');
      expect(c.delimiter).toBe(',');
    });

    it('keeps the quoted newline inside ONE header cell instead of splitting rows', () => {
      const r = adapter.readRange(buf(), { sheetIndex: 1, toRow: 1, maxRows: 1, maxCells: 200 }, JOB_LIMITS);
      expect(r.rows[0]).toHaveLength(WOO_SHAPED_COLUMN_COUNT);
      const gtin = r.rows[0].find((c) => typeof c === 'string' && c.includes('GTIN'));
      expect(gtin).toContain('\n');
    });

    it('reads a ragged row without inventing cells for the missing columns', () => {
      const all = adapter.readRange(buf(), { sheetIndex: 1, maxRows: 500, maxCells: 100_000 }, JOB_LIMITS);
      const ragged = all.rows.filter((row) => row.length < WOO_SHAPED_COLUMN_COUNT);
      expect(ragged.length).toBe(4);
    });

    it('surfaces the identity problem: every SKU is blank, so matching cannot use it', () => {
      const all = adapter.readRange(buf(), { sheetIndex: 1, fromRow: 2, maxRows: 500, maxCells: 100_000 }, JOB_LIMITS);
      const skus = all.rows.map((r) => r[2]);
      expect(skus.every((s) => s === null)).toBe(true);
      // The source system's own id is the only stable key such a file carries.
      const ids = all.rows.map((r) => r[0]).filter(Boolean);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('surfaces duplicate names, so name-matching is provably ambiguous', () => {
      const all = adapter.readRange(buf(), { sheetIndex: 1, fromRow: 2, maxRows: 500, maxCells: 100_000 }, JOB_LIMITS);
      const names = all.rows.map((r) => r[4]).filter(Boolean) as string[];
      const dupes = names.filter((n) => names.indexOf(n) !== names.lastIndexOf(n));
      expect(dupes.length).toBeGreaterThan(0);
    });
  });
});

describe('xlsx adapter', () => {
  const adapter = new XlsxAdapter();

  it('censuses sheets, formulas and merges through the gate', () => {
    const c = adapter.census(fixture('clean-multisheet.xlsx'), JOB_LIMITS);
    expect(c.kind).toBe('XLSX');
    expect(c.sheets.map((s) => s.name)).toEqual(['Products', 'Notes']);
    expect(c.sheets[0].formulas.map((f) => f.formula)).toContain('B2*2');
    expect(c.sheets[0].merged[0].ref).toBe('A1:B1');
  });

  it('refuses a macro workbook before any parsing', () => {
    expect(() => adapter.census(fixture('macro.xlsm'), JOB_LIMITS)).toThrow(/macros/i);
  });

  it('refuses a zip bomb before any parsing', () => {
    expect(() => adapter.census(fixture('zip-bomb.xlsx'), JOB_LIMITS)).toThrow();
  });

  it('reads values with the formula cell resolved to its CACHED value', async () => {
    const r = await adapter.readRangeAsync(
      fixture('clean-multisheet.xlsx'),
      { sheetIndex: 1, maxRows: 100, maxCells: 10_000 },
      JOB_LIMITS,
    );
    expect(r.rows[0]).toEqual(['Nombre', 'Precio', 'Calculado', 'Categoria']);
    // B2*2 was never evaluated; 2400 is the value the workbook already held.
    expect(r.rows[1]).toEqual(['Sofa Sabot', 1200, 2400, 'MOBILIARIO > Sofas']);
  });

  it('leaves no temporary file behind, observed in an isolated scratch directory', async () => {
    // The scratch root is isolated on purpose: counting entries in the shared
    // os.tmpdir() races other parallel suites and makes the assertion flaky.
    const os = await import('os');
    const fsp = await import('fs/promises');
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'p9-scratch-'));
    try {
      const isolated = new XlsxAdapter(undefined, scratch);
      await isolated.readRangeAsync(
        fixture('clean-multisheet.xlsx'),
        { sheetIndex: 1, maxRows: 10, maxCells: 100 },
        JOB_LIMITS,
      );
      expect(fs.readdirSync(scratch)).toEqual([]);
    } finally {
      await fsp.rm(scratch, { recursive: true, force: true });
    }
  });

  it('applies the tighter preview budget', () => {
    expect(PREVIEW_LIMITS.maxCells).toBeLessThan(JOB_LIMITS.maxCells);
    expect(() => adapter.census(fixture('legit-high-compression.xlsx'), PREVIEW_LIMITS)).toThrow(SourceRejected);
  });
});
