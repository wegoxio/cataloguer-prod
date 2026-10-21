import { Cell, detectTables, scoreHeaderRow, splitIntoBlocks } from '../table-detection';
import { profileColumn, profileTable } from '../column-profile';
import { buildWooShapedCsv } from '../../parsing/__fixtures__/woo-shaped-export.csv';
import { DelimitedAdapter } from '../../parsing/delimited-adapter';
import { JOB_LIMITS } from '../../parsing/source-adapter';

const rows = (...r: Cell[][]): Cell[][] => r;

describe('table detection', () => {
  it('finds a header that is NOT the first row', () => {
    // The failure this prevents: the legacy importer assumes row 1 is the
    // header, so a report title silently becomes a product name.
    const sheet = rows(
      ['Informe de inventario — marzo', null, null],
      [null, null, null],
      ['SKU', 'Nombre', 'Precio'],
      ['A-1', 'Silla', '100'],
      ['A-2', 'Mesa', '200'],
    );
    const [table] = detectTables(sheet);
    expect(table.headerRow).toBe(3);
    expect(table.headers).toEqual(['SKU', 'Nombre', 'Precio']);
    expect(table.firstDataRow).toBe(4);
  });

  it('scores a real header above a data row', () => {
    const sheet = rows(['SKU', 'Nombre', 'Precio'], ['A-1', 'Silla', '100']);
    expect(scoreHeaderRow(sheet, 0).score).toBeGreaterThan(scoreHeaderRow(sheet, 1).score);
  });

  it('explains why a row was chosen, rather than asserting it', () => {
    const sheet = rows(['SKU', 'Nombre', 'Precio'], ['A-1', 'Silla', '100'], ['A-2', 'Mesa', '200']);
    const c = scoreHeaderRow(sheet, 0);
    expect(c.reasons).toContain('cells are text, not values');
    expect(c.reasons).toContain('every heading is distinct');
    expect(c.reasons).toContain('rows below share its width');
  });

  it('separates two tables in one sheet instead of merging them', () => {
    // Silently merging unrelated tables is the outcome that must never happen.
    const sheet = rows(
      ['SKU', 'Nombre'],
      ['A-1', 'Silla'],
      [null, null],
      [null, null],
      ['Proveedor', 'Teléfono'],
      ['Maderas SA', '555'],
    );
    const tables = detectTables(sheet);
    expect(tables).toHaveLength(2);
    expect(tables[0].headers).toEqual(['SKU', 'Nombre']);
    expect(tables[1].headers).toEqual(['Proveedor', 'Teléfono']);
  });

  it('treats a single blank line as cosmetic, not as a table break', () => {
    const sheet = rows(['SKU', 'Nombre'], ['A-1', 'Silla'], [null, null], ['A-2', 'Mesa']);
    expect(detectTables(sheet)).toHaveLength(1);
  });

  it('splits blocks on a run of blank rows', () => {
    const sheet = rows(['a'], [null], [null], ['b']);
    expect(splitIntoBlocks(sheet)).toEqual([
      { start: 0, end: 0 },
      { start: 3, end: 3 },
    ]);
  });

  it('returns nothing for a sheet with no table in it', () => {
    expect(detectTables(rows([null, null], [null, null]))).toEqual([]);
  });
});

describe('column profiling', () => {
  it('reports an empty column as empty rather than guessing a type', () => {
    const p = profileColumn(0, 'SKU', [null, '', null]);
    expect(p.inferredType).toBe('EMPTY');
    expect(p.notes).toContain('the column is empty in every row');
  });

  it('recognizes integers, decimals and text', () => {
    expect(profileColumn(0, 'qty', ['1', '2', '3']).inferredType).toBe('INTEGER');
    expect(profileColumn(0, 'price', ['1.50', '2.75', '3']).inferredType).toBe('DECIMAL');
    expect(profileColumn(0, 'name', ['Silla', 'Mesa']).inferredType).toBe('TEXT');
  });

  it('does not type a mostly-whole price column as INTEGER', () => {
    // 9 whole prices and one with cents is still a price column.
    const values = ['100', '200', '300', '400', '500', '600', '700', '800', '900', '99.95'];
    expect(profileColumn(0, 'Precio', values).inferredType).toBe('DECIMAL');
  });

  it('REPORTS the decimal separator instead of resolving an ambiguity it cannot', () => {
    // 1.234 is 1234 in Spanish and 1.234 in English. Nothing in the value says which.
    const p = profileColumn(0, 'Precio', ['1.234', '5.678']);
    expect(p.decimalSeparator).toBe('.');
    expect(p.inferredType).toBe('INTEGER'); // three trailing digits: grouping-shaped
  });

  it('agrees on one separator when the values agree, even in grouped form', () => {
    // Both are Spanish-style: comma decimals, dot grouping. Nothing conflicts.
    const p = profileColumn(0, 'Precio', ['1.234,50', '2,5']);
    expect(p.decimalSeparator).toBe(',');
  });

  it('flags a column whose rows genuinely DISAGREE about the separator', () => {
    // 1.50 is a dot decimal, 2,50 a comma decimal. One of them is wrong, and
    // the column cannot say which — so it asks rather than silently dividing.
    const p = profileColumn(0, 'Precio', ['1.50', '2,50']);
    expect(p.decimalSeparator).toBe('mixed');
    expect(p.notes.join(' ')).toMatch(/declare which one means decimals/);
  });

  it('warns that a 0/1 column may be yes-no rather than a quantity', () => {
    // Casting this to boolean silently turns "1 in stock" into "in stock: yes".
    const p = profileColumn(0, 'Inventario', ['1', '0', '1', '0']);
    expect(p.notes.join(' ')).toMatch(/may be a yes\/no column rather than a quantity/);
  });

  it('recognizes a list of image URLs in one cell', () => {
    const p = profileColumn(0, 'Imágenes', ['https://a.test/1.png, https://a.test/2.png']);
    expect(p.inferredType).toBe('URL_LIST');
  });

  it('recognizes category paths', () => {
    const p = profileColumn(0, 'Categorías', ['MOBILIARIO > Sillas', 'MOBILIARIO > Mesas > Altas']);
    expect(p.inferredType).toBe('PATH_LIST');
  });

  it('marks a column whose values are all distinct as a possible identifier', () => {
    const p = profileColumn(0, 'ID', ['1', '2', '3']);
    expect(p.unique).toBe(true);
    expect(p.notes.join(' ')).toMatch(/can identify a row/);
  });

  it('calls a genuinely inconsistent column MIXED instead of picking a winner', () => {
    const p = profileColumn(0, 'raro', ['Silla', '100', 'https://a.test/x', '2024-01-01', 'true']);
    expect(p.inferredType).toBe('MIXED');
    expect(p.notes.join(' ')).toMatch(/do not agree on a single type/);
  });

  it('carries real sample values, so a proposal can be recognized rather than trusted', () => {
    const p = profileColumn(0, 'Nombre', ['Silla', 'Mesa', 'Sofá']);
    expect(p.samples).toEqual(expect.arrayContaining(['Silla', 'Mesa', 'Sofá']));
    expect(p.samples.length).toBeLessThanOrEqual(5);
  });

  it('reports how empty a column is', () => {
    const p = profileColumn(0, 'Precio', ['100', null, null, null]);
    expect(p.blankCount).toBe(3);
    expect(p.notes.join(' ')).toMatch(/75% of rows leave this blank/);
  });
});

describe('against the WooCommerce-shaped fixture', () => {
  const adapter = new DelimitedAdapter();
  const read = () =>
    adapter.readRange(buildWooShapedCsv(), { sheetIndex: 1, maxRows: 500, maxCells: 100_000 }, JOB_LIMITS).rows;

  it('finds the header on row 1 and the data beneath it', () => {
    const [table] = detectTables(read());
    expect(table.headerRow).toBe(1);
    expect(table.headers[0]).toBe('ID');
    expect(table.confidence).toBeGreaterThan(0.5);
  });

  it('profiles the SKU column as empty — the fact that decides how matching works', () => {
    const all = read();
    const [table] = detectTables(all);
    const data = all.slice(table.firstDataRow - 1);
    const profiles = profileTable(table.headers, data);
    expect(profiles[2].header).toBe('SKU');
    expect(profiles[2].inferredType).toBe('EMPTY');
  });

  it('profiles the id column as a unique identifier', () => {
    const all = read();
    const [table] = detectTables(all);
    const profiles = profileTable(table.headers, all.slice(table.firstDataRow - 1));
    expect(profiles[0].header).toBe('ID');
    expect(profiles[0].unique).toBe(true);
  });

  it('recognizes the category-path and image-list columns', () => {
    const all = read();
    const [table] = detectTables(all);
    const profiles = profileTable(table.headers, all.slice(table.firstDataRow - 1));
    expect(profiles[27].inferredType).toBe('PATH_LIST');
    expect(profiles[30].inferredType).toBe('URL_LIST');
  });
});
