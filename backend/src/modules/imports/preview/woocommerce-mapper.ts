import * as Papa from 'papaparse';

/**
 * Pure translation layer from WooCommerce's standard product CSV export
 * (wp-admin > Products > Export) to Catalog's domain shape.
 * No database access: the caller applies the result. (The legacy
 * ImportsService that used to do so was retired in P5-B3 after a
 * zero-consumer proof.)
 */

export interface WooVariation {
  rowNum: number;
  name: string;
  sku: string | null;
  price: number;
  salePrice: number | null;
  stockQuantity: number;
  trackInventory: boolean;
  published: boolean;
  attributes: Record<string, string>;
}

export interface WooProduct {
  rowNum: number;
  name: string;
  slug: string;
  sku: string | null;
  description?: string;
  metaDescription?: string;
  published: boolean;
  price: number;
  salePrice: number | null;
  stockQuantity: number;
  trackInventory: boolean;
  categoryPath: string[];
  imageUrls: string[];
  variations: WooVariation[];
}

export interface WooParseResult {
  products: WooProduct[];
  errors: { row: number; message: string }[];
}

export function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function stripHtml(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = parseFloat(raw.replace(',', '.'));
  return isNaN(value) ? null : value;
}

/**
 * WooCommerce localizes export headers to the site language. Spanish sites
 * (our main market) produce "Nombre"/"Precio normal"/… — map them to the
 * canonical English names the parser reads. Keys are lowercase.
 */
const HEADER_ALIASES: Record<string, string> = {
  tipo: 'type',
  nombre: 'name',
  publicado: 'published',
  'descripción corta': 'short description',
  descripción: 'description',
  inventario: 'stock',
  'precio rebajado': 'sale price',
  'precio normal': 'regular price',
  categorías: 'categories',
  imágenes: 'images',
  superior: 'parent',
};
for (let i = 1; i <= 10; i++) {
  HEADER_ALIASES[`nombre del atributo ${i}`] = `attribute ${i} name`;
  HEADER_ALIASES[`valor(es) del atributo ${i}`] = `attribute ${i} value(s)`;
}

/** Case-insensitive column access; Woo headers vary in casing across versions/locales. */
function makeGetter(row: Record<string, string>) {
  const lookup = new Map<string, string>();
  for (const [key, value] of Object.entries(row)) {
    const normalized = key.trim().toLowerCase();
    const cleanValue = typeof value === 'string' ? value.trim() : value;
    lookup.set(normalized, cleanValue);
    const alias = HEADER_ALIASES[normalized];
    // Spanish header fills the English slot unless the file already has it
    if (alias && !lookup.has(alias)) {
      lookup.set(alias, cleanValue);
    }
  }
  return (column: string): string => lookup.get(column.toLowerCase()) ?? '';
}

function parseAttributes(get: (column: string) => string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (let i = 1; i <= 10; i++) {
    const name = get(`Attribute ${i} name`);
    const value = get(`Attribute ${i} value(s)`);
    if (name && value) {
      attributes[name] = value;
    }
  }
  return attributes;
}

export function parseWooCommerceCsv(csvText: string): WooParseResult {
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  const errors: { row: number; message: string }[] = [];
  const products: WooProduct[] = [];
  // Woo variations reference their parent by `id:<ID>` or by SKU
  const byWooId = new Map<string, WooProduct>();
  const bySku = new Map<string, WooProduct>();
  const pendingVariations: { rowNum: number; parentRef: string; variation: WooVariation }[] = [];

  parsed.data.forEach((row, index) => {
    const rowNum = index + 2; // 1-based + header row
    const get = makeGetter(row);

    const type = (get('Type') || 'simple').toLowerCase();
    const name = get('Name');
    const published = get('Published') === '1';
    const price = parseNumber(get('Regular price'));
    const salePrice = parseNumber(get('Sale price'));
    const stock = parseNumber(get('Stock'));
    const sku = get('SKU') || null;

    if (type === 'variation') {
      const parentRef = get('Parent');
      if (!parentRef) {
        errors.push({ row: rowNum, message: 'Variation row has no Parent reference' });
        return;
      }
      const variation: WooVariation = {
        rowNum,
        name: name || Object.values(parseAttributes(get)).join(', ') || 'Variation',
        sku,
        price: price ?? salePrice ?? 0,
        salePrice: salePrice !== null && price !== null && salePrice < price ? salePrice : null,
        stockQuantity: stock !== null && stock >= 0 ? Math.floor(stock) : 0,
        trackInventory: stock !== null,
        published,
        attributes: parseAttributes(get),
      };
      pendingVariations.push({ rowNum, parentRef, variation });
      return;
    }

    if (type !== 'simple' && type !== 'variable') {
      errors.push({ row: rowNum, message: `Unsupported product type "${type}" (row skipped)` });
      return;
    }

    if (!name) {
      errors.push({ row: rowNum, message: 'Name is required' });
      return;
    }

    const slug = slugify(name);
    if (!slug) {
      errors.push({ row: rowNum, message: `Could not derive a slug from name "${name}"` });
      return;
    }

    const description = stripHtml(get('Description'));
    const shortDescription = stripHtml(get('Short description'));
    // First category path wins: "Clothing > Shirts, Sale" -> ["Clothing", "Shirts"]
    const categoryPath = (get('Categories').split(',')[0] || '')
      .split('>')
      .map((part) => part.trim())
      .filter(Boolean);
    const imageUrls = get('Images')
      .split(',')
      .map((url) => url.trim())
      .filter((url) => /^https?:\/\//i.test(url));

    const product: WooProduct = {
      rowNum,
      name,
      slug,
      sku,
      description: description || undefined,
      metaDescription: shortDescription ? shortDescription.slice(0, 300) : undefined,
      published,
      price: price ?? 0,
      salePrice: salePrice !== null && price !== null && salePrice < price ? salePrice : null,
      stockQuantity: stock !== null && stock >= 0 ? Math.floor(stock) : 0,
      trackInventory: stock !== null,
      categoryPath,
      imageUrls,
      variations: [],
    };

    products.push(product);
    const wooId = get('ID');
    if (wooId) byWooId.set(wooId, product);
    if (sku) bySku.set(sku, product);
  });

  // Attach variations to their parents
  for (const { rowNum, parentRef, variation } of pendingVariations) {
    const idRef = parentRef.startsWith('id:') ? parentRef.slice(3).trim() : null;
    const parent = (idRef && byWooId.get(idRef)) || bySku.get(parentRef) || null;
    if (!parent) {
      errors.push({ row: rowNum, message: `Parent "${parentRef}" not found for variation` });
      continue;
    }
    parent.variations.push(variation);
  }

  // Variable parents without their own price inherit the cheapest variation price
  for (const product of products) {
    if (product.price === 0 && product.variations.length > 0) {
      const prices = product.variations.map((v) => v.price).filter((p) => p > 0);
      if (prices.length > 0) product.price = Math.min(...prices);
    }
  }

  return { products, errors };
}
