import { profileColumn, profileTable, ColumnProfile } from '../column-profile';
import { normalizeHeader, proposeField, proposeTableMapping } from '../field-proposals';
import { detectTables } from '../table-detection';
import { buildWooShapedCsv } from '../../parsing/__fixtures__/woo-shaped-export.csv';
import { DelimitedAdapter } from '../../parsing/delimited-adapter';
import { JOB_LIMITS } from '../../parsing/source-adapter';

const col = (header: string, values: (string | null)[]): ColumnProfile => profileColumn(0, header, values);

describe('header normalization', () => {
  it('folds accents, case and punctuation so Spanish headings match', () => {
    expect(normalizeHeader('Categorías')).toBe('categorias');
    expect(normalizeHeader('PRECIO_NORMAL')).toBe('precio normal');
    expect(normalizeHeader('  Descripción corta  ')).toBe('descripcion corta');
  });
});

describe('field proposals', () => {
  it('proposes a field and SAYS WHY, rather than asserting a match', () => {
    const p = proposeField(col('Nombre', ['Silla', 'Mesa']));
    expect(p.field).toBe('name');
    expect(p.confidence).toBeGreaterThan(0.8);
    expect(p.reasons.join(' ')).toMatch(/heading is exactly "nombre"/);
  });

  it('lets the data corroborate a header', () => {
    const p = proposeField(col('Precio', ['10.50', '20.00']));
    expect(p.field).toBe('price');
    expect(p.reasons.join(' ')).toMatch(/values look like numbers, which fits/);
  });

  it('lets the data CONTRADICT a header instead of resolving it silently', () => {
    // A column called Precio holding web addresses is not a price. The honest
    // output is a low-confidence proposal that says so.
    const p = proposeField(col('Precio', ['https://a.test/1.png', 'https://a.test/2.png']));
    expect(p.field).toBe('price');
    expect(p.confidence).toBeLessThan(0.6);
    expect(p.reasons.join(' ')).toMatch(/does not fit a price column/);
  });

  it('never invents a proposal from data alone', () => {
    // Numbers are not a price just because prices are numbers.
    const p = proposeField(col('Columna 7', ['10', '20', '30']));
    expect(p.field).toBeNull();
    expect(p.reasons.join(' ')).toMatch(/does not match a field we know/);
  });

  it('reports an unheaded column rather than guessing', () => {
    const p = proposeField(col('', ['a', 'b']));
    expect(p.field).toBeNull();
    expect(p.reasons).toContain('the column has no heading');
  });

  it('prefers the exact heading over one that merely contains the word', () => {
    // "precio rebajado" contains "precio"; without exact-match precedence every
    // sale-price column would be proposed as price.
    const exact = proposeField(col('Precio', ['1']));
    const contains = proposeField(col('Precio rebajado', ['1']));
    expect(exact.field).toBe('price');
    expect(contains.field).toBe('salePrice');
  });

  it('doubts an identifier column whose values repeat', () => {
    const p = proposeField(col('SKU', ['A-1', 'A-1', 'A-2']));
    expect(p.field).toBe('sku');
    expect(p.reasons.join(' ')).toMatch(/values repeat, which an identifier normally would not/);
  });

  it('is more confident about an identifier whose values are all distinct', () => {
    const repeated = proposeField(col('SKU', ['A-1', 'A-1']));
    const distinct = proposeField(col('SKU', ['A-1', 'A-2']));
    expect(distinct.confidence).toBeGreaterThan(repeated.confidence);
  });

  it('says an empty column cannot confirm its own heading', () => {
    const p = proposeField(col('Precio', [null, null]));
    expect(p.reasons.join(' ')).toMatch(/the column is empty, so the values cannot confirm it/);
  });

  it('keeps manufacturer code separate from SKU', () => {
    // Conflating them would let a supplier's code overwrite internal identity.
    expect(proposeField(col('Código de fabricante', ['X1'])).field).toBe('manufacturerCode');
    expect(proposeField(col('SKU', ['X1'])).field).toBe('sku');
  });
});

describe('whole-table mapping', () => {
  it('REFUSES to map two columns to the same field', () => {
    // Both headings contain "precio". Mapping both to price would silently
    // overwrite one with the other.
    const profiles = [
      profileColumn(0, 'Precio normal', ['100', '200']),
      profileColumn(1, 'Precio rebajado', ['80', '150']),
    ];
    const mapped = proposeTableMapping(profiles);
    const fields = mapped.map((m) => m.field);
    expect(new Set(fields.filter(Boolean)).size).toBe(fields.filter(Boolean).length);
    expect(fields).toContain('price');
    expect(fields).toContain('salePrice');
  });

  it('explains the collision on the column that lost the field', () => {
    const profiles = [
      profileColumn(0, 'Nombre', ['Silla', 'Mesa']),
      profileColumn(1, 'Nombre del producto', ['Silla', 'Mesa']),
    ];
    const mapped = proposeTableMapping(profiles);
    const loser = mapped.find((m) => m.field !== 'name');
    expect(loser?.reasons.join(' ')).toMatch(/is a better match for name/);
  });

  it('leaves a column unmapped rather than forcing it somewhere wrong', () => {
    const profiles = [profileColumn(0, 'Notas internas del almacén', ['x'])];
    expect(proposeTableMapping(profiles)[0].field).toBeNull();
  });
});

describe('against the WooCommerce-shaped fixture', () => {
  const adapter = new DelimitedAdapter();
  const rows = adapter.readRange(
    buildWooShapedCsv(),
    { sheetIndex: 1, maxRows: 500, maxCells: 100_000 },
    JOB_LIMITS,
  ).rows;
  const [table] = detectTables(rows);
  const profiles = profileTable(table.headers, rows.slice(table.firstDataRow - 1));
  const mapping = proposeTableMapping(profiles);
  const fieldFor = (header: string) => mapping.find((m) => m.header === header)?.field;

  it('maps the Spanish headings a real export carries', () => {
    expect(fieldFor('Nombre')).toBe('name');
    expect(fieldFor('Categorías')).toBe('categoryPaths');
    expect(fieldFor('Imágenes')).toBe('images');
    expect(fieldFor('ID')).toBe('externalId');
  });

  it('separates the two price columns instead of collapsing them', () => {
    const priced = mapping.filter((m) => m.field === 'price' || m.field === 'salePrice');
    expect(priced.map((m) => m.field).sort()).toEqual(['price', 'salePrice']);
  });

  it('still proposes SKU from its heading, but with low confidence because it is empty', () => {
    const sku = mapping.find((m) => m.header === 'SKU');
    expect(sku?.field).toBe('sku');
    expect(sku?.confidence).toBeLessThan(0.8);
    expect(sku?.reasons.join(' ')).toMatch(/empty/);
  });

  it('maps every column at most once', () => {
    const used = mapping.map((m) => m.field).filter(Boolean);
    expect(new Set(used).size).toBe(used.length);
  });
});
