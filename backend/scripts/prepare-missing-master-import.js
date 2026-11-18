const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const readXlsxFile = require('read-excel-file/node').default;

const downloads = 'C:/Users/wilfr/Downloads';
const auditCsv =
  'C:/dev/projects/cataloguer-audits/designhof-product-reconciliation/reconciliation-h1-transit-2026-11-18/remaining-master-missing.csv';
const masterFile = path.join(downloads, 'DesignHof_WordPress_Master_Item_Type (1).xlsx');
const baselineFile = path.join(downloads, 'precios listos.xlsx');
const changesFile = path.join(downloads, 'H1 CAMBIO DE PRECIOS+.xlsx');
const outDir = path.join(__dirname, '../src/jobs/data');
const auditOutDir =
  'C:/dev/projects/cataloguer-audits/designhof-product-reconciliation/missing-master-import-2026-11-18';

function money(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number(value.toFixed(2));
  let normalized = String(value)
    .trim()
    .replace(/\s/g, '')
    .replace(/[^0-9,.-]/g, '');
  if (!normalized) return null;
  if (normalized.includes(',') && normalized.includes('.'))
    normalized = normalized.replace(/\./g, '').replace(',', '.');
  else if (normalized.includes(',')) normalized = normalized.replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : null;
}

function text(value) {
  if (value === null || value === undefined) return '';
  let current = String(value).trim();
  const badCharacters = (candidate) => (candidate.match(/[\u00c3\u00c2\u00e2\ufffd]/g) || []).length;
  for (let attempt = 0; attempt < 3 && badCharacters(current); attempt += 1) {
    const repaired = Buffer.from(current, 'latin1').toString('utf8');
    if (repaired.includes('\ufffd') || badCharacters(repaired) >= badCharacters(current)) break;
    current = repaired;
  }
  return current;
}

function yes(value) {
  return /^(si|yes|true|1)$/i.test(
    text(value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, ''),
  );
}

function uniqueTexts(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

async function sheet(file, name) {
  const sheets = await readXlsxFile(file, { getSheets: true });
  const selected = name ? sheets.find((candidate) => candidate.sheet === name) : sheets[0];
  if (!selected) throw new Error(`No se encontró la hoja ${name || '(primera)'} en ${file}`);
  return selected.data;
}

async function main() {
  const csv = Papa.parse(fs.readFileSync(auditCsv, 'utf8'), { header: true, skipEmptyLines: true }).data;
  if (csv.length !== 63) throw new Error(`Se esperaban 63 ausentes y llegaron ${csv.length}`);
  const wanted = new Set(csv.map((row) => text(row.catalog_code)));

  const rows = await sheet(masterFile, 'Product Master');
  const headers = rows[0].map(text);
  const objects = rows.slice(1).map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
  const selected = objects.filter((row) => wanted.has(text(row.CATALOG_CODE)));
  if (selected.length !== 63) throw new Error(`El maestro resolvió ${selected.length}/63 productos`);

  const products = selected.map((row) => {
    const catalogCode = text(row.CATALOG_CODE);
    const wordpressId = text(row.WORDPRESS_ID);
    const originalName = text(row.PRODUCT_NAME);
    return {
      catalogCode,
      sourceSystem: 'designhof-wordpress',
      externalId: wordpressId || `catalog:${catalogCode}`,
      wordpressId: wordpressId || null,
      supplierProductCode: text(row.SUPPLIER_PRODUCT_CODE) || null,
      name: originalName || (wordpressId === '4659' ? 'Neolith COR-TEN Satinado' : `Producto ${catalogCode}`),
      description: text(row.DESCRIPTION_ES) || null,
      itemType: text(row.ITEM_TYPE),
      published: yes(row.PUBLISHED),
      categories: uniqueTexts(text(row.CATEGORIES).split(/\s*[|,;>]\s*/)),
      price: money(row.NORMAL_PRICE_SOURCE) ?? 0,
      salePrice: money(row.SALE_PRICE_SOURCE),
      sourceStock: money(row.STOCK_QUANTITY_SOURCE),
      manualReview: originalName ? [] : ['Nombre ausente en el maestro; se aplicó el nombre de respaldo'],
    };
  });
  if (new Set(products.map((product) => product.externalId)).size !== 63) throw new Error('Hay externalId duplicados');
  if (products.some((product) => !product.wordpressId)) throw new Error('Los 63 productos deben tener WORDPRESS_ID');

  const baselineRows = await sheet(baselineFile);
  const baseline = baselineRows
    .slice(1)
    .map((row) => ({ code: text(row[0]).toUpperCase(), price: money(row[1]), name: text(row[2]) }))
    .filter((row) => row.code && row.price !== null);

  const changeRows = await sheet(changesFile, 'H1 PRECIOS');
  const changeCandidates = new Map();
  for (const [offset, row] of changeRows.slice(1).entries()) {
    for (const [codeIndex, priceIndex] of [
      [0, 1],
      [3, 4],
    ]) {
      const code = text(row[codeIndex]).toUpperCase();
      const price = money(row[priceIndex]);
      if (!code || price === null) continue;
      const candidates = changeCandidates.get(code) || [];
      candidates.push({ price, row: offset + 2, list: codeIndex === 0 ? 'H1 NEW IN' : 'H1 PRECIOS NUEVOS' });
      changeCandidates.set(code, candidates);
    }
  }
  const conflicts = [];
  const changes = [];
  for (const [code, candidates] of changeCandidates) {
    const prices = [...new Set(candidates.map((candidate) => candidate.price))];
    if (prices.length > 1) conflicts.push({ code, prices, occurrences: candidates });
    else changes.push({ code, price: prices[0] });
  }
  if (!changes.length) throw new Error('No se extrajeron cambios de precio');

  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(auditOutDir, { recursive: true });
  const write = (name, value) => fs.writeFileSync(path.join(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write('designhof-missing-master-2026-11-18.json', products);
  write('h1-price-baseline-2026-11-18.json', baseline);
  write('h1-price-changes-2026-11-18.json', changes);
  write('h1-price-change-conflicts-2026-11-18.json', conflicts);
  const sourceIds = products.map((product) => ({
    wordpressId: product.wordpressId,
    catalogCode: product.catalogCode,
    name: product.name,
    published: product.published,
    itemType: product.itemType,
    categories: product.categories.join(' | '),
    manualReview: product.manualReview.join(' | '),
  }));
  fs.writeFileSync(path.join(auditOutDir, 'source-product-ids.csv'), Papa.unparse(sourceIds));
  fs.writeFileSync(
    path.join(auditOutDir, 'preparation-summary.json'),
    `${JSON.stringify(
      {
        products: products.length,
        wordpressIds: products.filter((product) => product.wordpressId).length,
        published: products.filter((product) => product.published).length,
        draft: products.filter((product) => !product.published).length,
        manualReview: products
          .filter((product) => product.manualReview.length)
          .map((product) => ({
            catalogCode: product.catalogCode,
            wordpressId: product.wordpressId,
            name: product.name,
            reasons: product.manualReview,
          })),
        baselinePrices: baseline.length,
        authoritativePriceChanges: changes.length,
        conflictingPriceChanges: conflicts,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    JSON.stringify(
      {
        products: products.length,
        wordpressIds: products.filter((product) => product.wordpressId).length,
        fallbackIds: products.filter((product) => !product.wordpressId).length,
        manualReview: products.filter((product) => product.manualReview.length).map((product) => product.catalogCode),
        baseline: baseline.length,
        changes: changes.length,
        conflicts,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
