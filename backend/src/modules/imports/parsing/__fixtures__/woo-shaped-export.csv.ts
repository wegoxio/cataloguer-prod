/**
 * A deterministic CSV that reproduces the SHAPE of a real WooCommerce export
 * without carrying any customer data.
 *
 * The real DesignHof export is git-ignored on purpose and the repository
 * forbids any source or test from reading it, so the awkward properties that
 * actually break parsers are encoded here instead, each one deliberate:
 *
 *  - a UTF-8 BOM before the first header;
 *  - a quoted header cell containing NEWLINES ("GTIN\n UPC\n EAN o ISBN"),
 *    which naive line-splitting turns into three phantom rows;
 *  - Spanish headers with accents;
 *  - 45 columns, matching the real width that made the 500-row commit cap
 *    unreachable under a 100 kB body limit;
 *  - RAGGED rows that stop short of the header width;
 *  - a category cell holding several `>`-delimited paths separated by commas;
 *  - several image URLs in one comma-separated cell;
 *  - blank SKUs on every row, which is the real export's defining difficulty:
 *    identity has to come from the source system's own id, not a SKU;
 *  - duplicate product names, so name-matching is provably ambiguous;
 *  - prices present on only some rows.
 *
 * Values are invented. Only the shape is borrowed.
 */

const HEADERS = [
  'ID',
  'Tipo',
  'SKU',
  '"GTIN\n UPC\n EAN o ISBN"', // the quoted multi-line header cell
  'Nombre',
  'Publicado',
  '"¿Está destacado?"',
  '"Visibilidad en el catálogo"',
  '"Descripción corta"',
  'Descripción',
  '"Día en que empieza el precio rebajado"',
  '"Día en que termina el precio rebajado"',
  '"Estado del impuesto"',
  '"Clase de impuesto"',
  '¿Existencias?',
  'Inventario',
  '"Cantidad de bajo inventario"',
  '"¿Permitir reservas de productos agotados?"',
  '"¿Vendido individualmente?"',
  '"Peso (kg)"',
  '"Longitud (cm)"',
  '"Anchura (cm)"',
  '"Altura (cm)"',
  '"¿Permitir valoraciones de clientes?"',
  '"Nota de compra"',
  '"Precio rebajado"',
  '"Precio normal"',
  'Categorías',
  'Etiquetas',
  '"Clase de envío"',
  'Imágenes',
  '"Límite de descargas"',
  '"Días de caducidad de la descarga"',
  'Superior',
  '"Productos agrupados"',
  '"Ventas dirigidas"',
  '"Ventas cruzadas"',
  '"URL externa"',
  '"Texto del botón"',
  'Posición',
  'Marcas',
  '"Nombre del atributo 1"',
  '"Valor(es) del atributo 1"',
  '"Atributo visible 1"',
  '"Atributo global 1"',
];

export const WOO_SHAPED_COLUMN_COUNT = HEADERS.length; // 45

const CATEGORIES = '"MOBILIARIO, MOBILIARIO > Sillas, MOBILIARIO > Sillas > Sillas Stock"';
const IMAGES = '"https://example.test/img/a.png, https://example.test/img/b.png"';

/** One full-width row. `price` empty models the real export's partial pricing. */
function fullRow(id: number, name: string, price: string): string {
  const cells = new Array(HEADERS.length).fill('');
  cells[0] = String(id);
  cells[1] = 'simple';
  cells[2] = ''; // SKU is blank on every row, exactly as in the real export
  cells[4] = name;
  cells[5] = '1';
  cells[26] = price;
  cells[27] = CATEGORIES;
  cells[30] = IMAGES;
  return cells.join(',');
}

/** A short row: real exports contain rows that stop before the header width. */
function raggedRow(id: number, name: string): string {
  return [String(id), 'simple', '', '', name].join(',');
}

export function buildWooShapedCsv(): Buffer {
  const lines: string[] = [HEADERS.join(',')];

  // Six duplicate-name pairs, so name matching is demonstrably ambiguous.
  for (let i = 1; i <= 6; i++) {
    lines.push(fullRow(1000 + i, 'Silla Repetida', '120'));
    lines.push(fullRow(2000 + i, 'Silla Repetida', ''));
  }
  // Ordinary priced and unpriced rows.
  for (let i = 1; i <= 20; i++) {
    lines.push(fullRow(3000 + i, `Silla Modelo ${i}`, i % 2 === 0 ? String(100 + i) : ''));
  }
  // Ragged rows.
  for (let i = 1; i <= 4; i++) {
    lines.push(raggedRow(4000 + i, `Silla Corta ${i}`));
  }

  const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
  return Buffer.concat([BOM, Buffer.from(lines.join('\n'), 'utf8')]);
}

export const WOO_SHAPED_DATA_ROWS = 6 * 2 + 20 + 4; // 36
