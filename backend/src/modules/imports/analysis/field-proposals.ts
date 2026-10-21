import { ColumnProfile } from './column-profile';

/**
 * Proposing which Cataloguer field a source column means.
 *
 * A proposal is never a decision. Everything here produces a suggestion, a
 * confidence and — most importantly — the REASONS behind it, because a mapper
 * who cannot see why a column was matched cannot sensibly disagree with it.
 * The legacy importer guesses silently from header text alone and offers no
 * explanation, which is why a wrong guess there is invisible until the
 * catalogue is wrong.
 *
 * Two independent signals are combined:
 *
 *  - the HEADER, matched against known names and their Spanish equivalents;
 *  - the DATA, via the column profile, which can contradict a header.
 *
 * Disagreement between them lowers confidence rather than being resolved. A
 * column called "Precio" holding URLs is not a price, and the honest output is
 * a low-confidence proposal that says the values do not look like prices.
 */

export type TargetField =
  | 'name'
  | 'sku'
  | 'manufacturerCode'
  | 'externalId'
  | 'description'
  | 'shortDescription'
  | 'price'
  | 'salePrice'
  | 'cost'
  | 'stock'
  | 'categoryPaths'
  | 'images'
  | 'documents'
  | 'published'
  | 'parent'
  | 'optionLabel'
  | 'locale'
  | 'leadTimeDays'
  /**
   * When something happened — a sale's date, an order's date.
   *
   * Separate from every other field because it is BUSINESS time, not record
   * time: a historical sales file describes sales that happened last March, and
   * recording them as happening today would make every report wrong.
   */
  | 'occurredAt'
  /**
   * How many were sold, ordered or received.
   *
   * Deliberately not `stock`. A quantity is an EVENT — five were sold — while
   * stock is a STATE — five are on the shelf. Conflating them is how an import
   * of last year's sales silently rewrites this year's inventory.
   */
  | 'quantity'
  /** The reference the source system gave an order, used to group its lines. */
  | 'orderNumber';

export interface FieldProposal {
  columnIndex: number;
  header: string;
  field: TargetField | null;
  confidence: number;
  reasons: string[];
  /** Other fields this column could plausibly be, best first. */
  alternatives: TargetField[];
}

/**
 * Header vocabulary, English and Spanish.
 *
 * Spanish is first-class rather than translated at the edge: the catalogue's
 * canonical content locale is Spanish, and the exports that actually arrive
 * carry Spanish headings. Terms are matched normalized (lowercased, accents
 * folded) so "Categorías" and "categorias" are the same word.
 */
const HEADER_TERMS: Record<TargetField, string[]> = {
  name: ['name', 'nombre', 'title', 'titulo', 'producto', 'product', 'descripcion corta del producto'],
  sku: ['sku', 'codigo interno', 'internal code', 'referencia interna'],
  manufacturerCode: [
    'manufacturer code',
    'codigo de fabricante',
    'codigo fabricante',
    'supplier code',
    'codigo proveedor',
    'mpn',
    'model',
    'modelo',
    'referencia',
  ],
  externalId: ['id', 'external id', 'id externo', 'post id', 'identificador'],
  description: ['description', 'descripcion', 'descripcion larga', 'long description', 'detalle'],
  shortDescription: ['short description', 'descripcion corta', 'resumen', 'excerpt'],
  price: ['price', 'precio', 'regular price', 'precio normal', 'pvp', 'precio venta'],
  salePrice: ['sale price', 'precio rebajado', 'precio oferta', 'discount price', 'precio descuento'],
  cost: ['cost', 'coste', 'costo', 'purchase price', 'precio compra', 'unit cost', 'costo unitario'],
  stock: ['stock', 'inventario', 'quantity', 'cantidad', 'existencias', 'qty', 'unidades'],
  categoryPaths: ['categories', 'categorias', 'category', 'categoria', 'familia', 'rubro'],
  images: ['images', 'imagenes', 'image', 'imagen', 'fotos', 'photos', 'gallery', 'galeria'],
  documents: ['documents', 'documentos', 'ficha tecnica', 'datasheet', 'manual', 'pdf'],
  published: ['published', 'publicado', 'status', 'estado', 'activo', 'visible'],
  parent: ['parent', 'superior', 'padre', 'grupo', 'family', 'familia padre'],
  optionLabel: ['variant', 'variante', 'version', 'version label', 'etiqueta', 'acabado'],
  locale: ['locale', 'idioma', 'language', 'lang'],
  leadTimeDays: ['lead time', 'plazo', 'plazo de entrega', 'delivery days', 'dias de entrega'],
  // The date terms are deliberately narrow. A bare "fecha" in a product export
  // is as likely to be a created-at as a sale date, and proposing the wrong one
  // would silently backdate every record.
  occurredAt: [
    'date',
    'fecha',
    'fecha de venta',
    'sale date',
    'sold at',
    'order date',
    'fecha de pedido',
    'fecha del pedido',
    'invoice date',
    'fecha factura',
  ],
  // Qualified terms only, so these never outrank `stock` on a plain "cantidad"
  // column in a product export — an exact match wins, and "cantidad" is stock's.
  quantity: [
    'quantity sold',
    'cantidad vendida',
    'unidades vendidas',
    'sold quantity',
    'ordered quantity',
    'cantidad pedida',
    'qty ordered',
    'received quantity',
    'cantidad recibida',
  ],
  orderNumber: [
    'order number',
    'numero de pedido',
    'n pedido',
    'order id',
    'order ref',
    'referencia pedido',
    'purchase order',
    'orden de compra',
    'invoice number',
    'numero de factura',
  ],
};

/** Types a field's data should plausibly have, used to corroborate or contradict. */
const EXPECTED_TYPES: Partial<Record<TargetField, ColumnProfile['inferredType'][]>> = {
  price: ['DECIMAL', 'INTEGER'],
  salePrice: ['DECIMAL', 'INTEGER'],
  cost: ['DECIMAL', 'INTEGER'],
  stock: ['INTEGER'],
  leadTimeDays: ['INTEGER'],
  images: ['URL', 'URL_LIST'],
  documents: ['URL', 'URL_LIST'],
  categoryPaths: ['PATH_LIST', 'TEXT'],
  name: ['TEXT'],
  description: ['TEXT'],
  shortDescription: ['TEXT'],
  published: ['BOOLEAN', 'INTEGER', 'TEXT'],
  quantity: ['INTEGER'],
  occurredAt: ['DATE', 'TEXT'],
  orderNumber: ['TEXT', 'INTEGER'],
};

/** Lowercase, strip accents, collapse whitespace and punctuation. */
export function normalizeHeader(header: string): string {
  return (header || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[_\-/]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function headerScore(normalized: string, terms: string[]): { score: number; matched?: string } {
  let best = { score: 0, matched: undefined as string | undefined };
  for (const term of terms) {
    if (normalized === term) return { score: 1, matched: term };
    // A term contained in the header is good evidence, but weaker — "precio
    // rebajado" contains "precio", so exact matches must outrank containment or
    // every sale-price column would be proposed as price.
    if (normalized.includes(term) && term.length >= 3) {
      const ratio = term.length / normalized.length;
      const score = 0.5 + ratio * 0.3;
      if (score > best.score) best = { score, matched: term };
    }
  }
  return best;
}

/**
 * Propose a field for one column.
 *
 * Confidence is header evidence adjusted by whether the data agrees. The
 * adjustment is capped so data can never *create* a proposal the header did not
 * suggest — a column of numbers is not a price just because prices are numbers.
 */
export function proposeField(profile: ColumnProfile): FieldProposal {
  const normalized = normalizeHeader(profile.header);
  const reasons: string[] = [];

  if (!normalized) {
    return {
      columnIndex: profile.index,
      header: profile.header,
      field: null,
      confidence: 0,
      reasons: ['the column has no heading'],
      alternatives: [],
    };
  }

  const scored: { field: TargetField; score: number; matched?: string }[] = [];
  for (const field of Object.keys(HEADER_TERMS) as TargetField[]) {
    const { score, matched } = headerScore(normalized, HEADER_TERMS[field]);
    if (score > 0) scored.push({ field, score, matched });
  }
  if (scored.length === 0) {
    return {
      columnIndex: profile.index,
      header: profile.header,
      field: null,
      confidence: 0,
      reasons: [`"${profile.header}" does not match a field we know`],
      alternatives: [],
    };
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0];
  let confidence = top.score;

  if (top.score === 1) reasons.push(`the heading is exactly "${top.matched}"`);
  else reasons.push(`the heading contains "${top.matched}"`);

  // An empty column cannot corroborate ANY field, whether or not we hold an
  // expectation for it. This matters for the case that actually arrives: a
  // real export can carry a SKU heading over 841 blank cells, and a confident
  // proposal there would send a mapper to an identifier that does not exist.
  if (profile.inferredType === 'EMPTY') {
    confidence *= 0.6;
    reasons.push('the column is empty, so the values cannot confirm it');
  }

  // Corroborate or contradict with the data.
  const expected = EXPECTED_TYPES[top.field];
  if (expected && profile.inferredType !== 'EMPTY') {
    if (expected.includes(profile.inferredType)) {
      confidence = Math.min(1, confidence + 0.15);
      reasons.push(`the values look like ${describeType(profile.inferredType)}, which fits`);
    } else {
      // Disagreement is reported, never resolved.
      confidence *= 0.5;
      reasons.push(
        `the values look like ${describeType(profile.inferredType)}, which does not fit a ${top.field} column`,
      );
    }
  }

  // A unique column proposed as an identifier is more convincing than one with
  // repeats — and a "sku" column with duplicates is worth doubting out loud.
  if ((top.field === 'sku' || top.field === 'externalId') && profile.filledCount > 0) {
    if (profile.unique) {
      confidence = Math.min(1, confidence + 0.1);
      reasons.push('every value is distinct, as an identifier should be');
    } else {
      confidence *= 0.7;
      reasons.push('values repeat, which an identifier normally would not');
    }
  }

  return {
    columnIndex: profile.index,
    header: profile.header,
    field: top.field,
    confidence: Number(Math.min(1, confidence).toFixed(2)),
    reasons,
    alternatives: scored.slice(1, 4).map((s) => s.field),
  };
}

function describeType(t: ColumnProfile['inferredType']): string {
  switch (t) {
    case 'DECIMAL':
    case 'INTEGER':
      return 'numbers';
    case 'URL':
    case 'URL_LIST':
      return 'web addresses';
    case 'PATH_LIST':
      return 'category paths';
    case 'DATE':
      return 'dates';
    case 'BOOLEAN':
      return 'yes/no values';
    case 'TEXT':
      return 'text';
    case 'EMPTY':
      return 'nothing';
    default:
      return 'a mix of things';
  }
}

/**
 * Propose mappings for a whole table, refusing to map two columns to the same
 * field.
 *
 * A duplicate mapping is a real hazard rather than a cosmetic one: "Precio
 * normal" and "Precio rebajado" both contain "precio", and mapping both to
 * `price` would silently overwrite one with the other. The higher-confidence
 * column keeps the field; the loser is proposed as its best remaining
 * alternative, with the collision stated.
 */
export function proposeTableMapping(profiles: ColumnProfile[]): FieldProposal[] {
  const proposals = profiles.map(proposeField);
  const claimed = new Map<TargetField, FieldProposal>();

  const ranked = [...proposals].sort((a, b) => b.confidence - a.confidence);
  for (const proposal of ranked) {
    if (!proposal.field) continue;
    const holder = claimed.get(proposal.field);
    if (!holder) {
      claimed.set(proposal.field, proposal);
      continue;
    }
    const taken = proposal.field;
    const next = proposal.alternatives.find((alt) => !claimed.has(alt));
    proposal.reasons.push(`"${holder.header}" is a better match for ${taken}, so this column is not mapped there`);
    proposal.field = next ?? null;
    proposal.confidence = next ? Number((proposal.confidence * 0.6).toFixed(2)) : 0;
    if (next) {
      claimed.set(next, proposal);
      proposal.reasons.push(`proposed as ${next} instead`);
    }
  }

  return proposals;
}
