import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@mikro-orm/nestjs';
import { EntityRepository } from '@mikro-orm/postgresql';
import * as Papa from 'papaparse';
import { Product } from '../../products/entities/product.entity';
import { confidentGroups, GroupingOptions } from './family-grouping';
import { validateAndDecodeCsv, UploadedCsvFile } from '../upload-security/csv-upload.validator';
import { ProductFieldDefinition } from '../../products/entities/product-field-definition.entity';
import { StoreFieldSetting } from '../../products/entities/store-field-setting.entity';
import { normalizeFieldKey } from '../../products/fields/product-field.util';
import { TenantScope } from '../../auth/tenancy/tenant-scope';
import {
  manufacturerCodeMatchKey,
  normalizeManufacturerCode,
  resolveByManufacturerCode,
} from '../../products/shared/manufacturer-code.util';

/**
 * A group the user approved on the preview screen.
 *
 * Members carry the item name rather than a row index: rows are committed in
 * chunks, so an index is only meaningful within one chunk and a group straddling
 * a chunk boundary would be lost. Names survive chunking and make the whole step
 * idempotent.
 */
export type ImportType = 'products' | 'categories';

/** Field definitions + ES/EN header guesses per import target. */
const FIELDS: Record<ImportType, { key: string; required: boolean; guesses: string[] }[]> = {
  products: [
    {
      key: 'name',
      required: true,
      guesses: [
        'nombre',
        'producto',
        'name',
        'product',
        'titulo',
        'título',
        'articulo',
        'artículo',
        'item',
        'detalle',
        'descripcion corta',
      ],
    },
    { key: 'price', required: false, guesses: ['precio', 'precio normal', 'price', 'regular price', 'pvp'] },
    {
      key: 'salePrice',
      required: false,
      guesses: ['precio oferta', 'precio rebajado', 'oferta', 'sale price', 'sale', 'descuento'],
    },
    {
      key: 'images',
      required: false,
      guesses: [
        'imagen',
        'imagenes',
        'imágenes',
        'images',
        'image',
        'photos',
        'photo',
        'foto',
        'fotos',
        'url imagen',
        'picture',
        'pictures',
        'gallery',
        'galeria',
        'galería',
      ],
    },
    { key: 'sku', required: false, guesses: ['sku', 'codigo', 'código', 'code', 'referencia'] },
    // The SUPPLIER's reference (P5-W1). Its guesses are deliberately disjoint
    // from the SKU's: a header that could mean either must map to the SKU, the
    // identity column, rather than being quietly claimed by this one.
    {
      key: 'manufacturerCode',
      required: false,
      guesses: [
        'codigo fabricante',
        'código fabricante',
        'codigo de fabricante',
        'código de fabricante',
        'codigo proveedor',
        'código proveedor',
        'referencia fabricante',
        'referencia proveedor',
        'manufacturer code',
        'manufacturer part number',
        'mpn',
        'supplier code',
        'supplier reference',
        'vendor code',
      ],
    },
    { key: 'stock', required: false, guesses: ['inventario', 'stock', 'cantidad', 'existencias', 'qty', 'quantity'] },
    { key: 'description', required: false, guesses: ['descripcion', 'descripción', 'description', 'detalle'] },
    {
      key: 'category',
      required: false,
      guesses: ['categoria', 'categoría', 'category', 'categorias', 'categories', 'rubro'],
    },
  ],
  categories: [
    { key: 'name', required: true, guesses: ['nombre', 'categoria', 'categoría', 'name', 'category'] },
    { key: 'description', required: false, guesses: ['descripcion', 'descripción', 'description'] },
  ],
};

/**
 * The preview reads up to 5,000 data rows — DesignHof's real file alone is
 * 841, and the old cap of 500 silently dropped 341 of them. Still bounded,
 * because a preview response carries every row to the browser.
 *
 */
const PREVIEW_MAX_ROWS = 5000;

@Injectable()
export class GenericImportService {
  constructor(
    @InjectRepository(Product)
    private readonly productRepository: EntityRepository<Product>,
  ) {}

  /**
   * Recognizes the target branch's importable fields among a preview's
   * headers, and proposes the rest (B4a3). READ-ONLY: one settings query,
   * no definition, value or mapping is ever created here.
   *
   * The branch comes from the canonical TenantScope alone. No resolved store
   * (or a non-product type) recognizes nothing — empty arrays, not an error.
   * Canonical columns stay authoritative: a header the canonical mapping
   * claimed is never offered as a field. Matching is deterministic:
   * `normalizeFieldKey(header)` must EQUAL the definition's key — the same
   * normalizer that mints key identity — and two headers normalizing to one
   * key are reported as an ambiguity, mapped to nothing, chosen never.
   * Every array is sorted by column index, key as the tie-breaker.
   */
  async recognizeFields(
    scope: TenantScope | undefined,
    type: ImportType,
    headers: string[],
    canonicalMapping: Record<string, number | null>,
  ): Promise<{
    fieldMappings: {
      definitionId: string;
      key: string;
      label: string;
      type: string;
      unit: string | null;
      columnIndex: number;
    }[];
    fieldProposals: { header: string; columnIndex: number; normalizedKey: string }[];
    fieldAmbiguities: { key: string; columnIndexes: number[] }[];
  }> {
    const none = { fieldMappings: [], fieldProposals: [], fieldAmbiguities: [] };
    if (type !== 'products') return none;
    const storeId = scope?.storeId ?? null;
    const organizationId = scope?.organizationId ?? null;
    if (!storeId || !organizationId) return none;

    const em = this.productRepository.getEntityManager();
    const settings = await em.find(
      StoreFieldSetting,
      { store: storeId, active: true, importable: true },
      { populate: ['definition'] as never },
    );
    const importableByKey = new Map<string, ProductFieldDefinition>();
    for (const setting of settings) {
      const definition = setting.definition as unknown as ProductFieldDefinition;
      if (!definition.archivedAt) importableByKey.set(definition.key, definition);
    }

    const canonicalColumns = new Set(
      Object.values(canonicalMapping ?? {}).filter((index): index is number => typeof index === 'number' && index >= 0),
    );
    const columnsByKey = new Map<string, number[]>();
    for (let index = 0; index < headers.length; index++) {
      if (canonicalColumns.has(index)) continue;
      const header = String(headers[index] ?? '').trim();
      // Blank headers are ignored outright; a header with no ASCII form has
      // no key to propose, so it is skipped the same way.
      if (!header) continue;
      let key: string;
      try {
        key = normalizeFieldKey(header);
      } catch {
        continue;
      }
      columnsByKey.set(key, [...(columnsByKey.get(key) ?? []), index]);
    }

    const fieldMappings: {
      definitionId: string;
      key: string;
      label: string;
      type: string;
      unit: string | null;
      columnIndex: number;
    }[] = [];
    const fieldProposals: { header: string; columnIndex: number; normalizedKey: string }[] = [];
    const fieldAmbiguities: { key: string; columnIndexes: number[] }[] = [];
    for (const [key, columnIndexes] of columnsByKey) {
      if (columnIndexes.length > 1) {
        fieldAmbiguities.push({ key, columnIndexes: [...columnIndexes].sort((a, b) => a - b) });
        continue;
      }
      const columnIndex = columnIndexes[0];
      const definition = importableByKey.get(key);
      if (definition) {
        fieldMappings.push({
          definitionId: definition.id,
          key: definition.key,
          label: definition.label,
          type: definition.type,
          unit: definition.unit ?? null,
          columnIndex,
        });
      } else {
        fieldProposals.push({ header: String(headers[columnIndex]).trim(), columnIndex, normalizedKey: key });
      }
    }

    fieldMappings.sort((a, b) => a.columnIndex - b.columnIndex || a.key.localeCompare(b.key));
    fieldProposals.sort((a, b) => a.columnIndex - b.columnIndex || a.normalizedKey.localeCompare(b.normalizedKey));
    fieldAmbiguities.sort((a, b) => a.columnIndexes[0] - b.columnIndexes[0] || a.key.localeCompare(b.key));
    return { fieldMappings, fieldProposals, fieldAmbiguities };
  }

  /**
   * What each manufacturer code in a preview would MATCH, before anything is
   * written (P5-W1).
   *
   * The wizard's whole promise is that the operator sees the consequence
   * before approving it, and "this code matches three products" is exactly the
   * consequence that must not first surface as a mystery mid-commit. This is
   * READ-ONLY: it resolves, it reports, it writes nothing.
   *
   * Bounded by construction — one query per DISTINCT code, not per row, and
   * codes are compared on the same normalized key the commit uses, so a
   * preview and its commit can never disagree about what a row means.
   *
   * Tenancy is the resolved scope's company and nothing else. Without one the
   * answer is empty rather than widened: an unscoped read here would report
   * another company's products as matches for this file.
   */
  async manufacturerCodeMatchPreview(
    scope: TenantScope | undefined,
    type: ImportType,
    mapping: Record<string, number | null>,
    rows: string[][],
  ): Promise<{
    manufacturerCodeColumn: number | null;
    manufacturerCodeMatches: {
      code: string;
      outcome: 'NONE' | 'UNIQUE' | 'AMBIGUOUS';
      productIds: string[];
      /** 1-based spreadsheet row numbers, matching the row-error channel. */
      rowNumbers: number[];
    }[];
    manufacturerCodeAmbiguities: number;
  }> {
    const none = { manufacturerCodeColumn: null, manufacturerCodeMatches: [], manufacturerCodeAmbiguities: 0 };
    if (type !== 'products') return none;
    const organizationId = scope?.organizationId ?? null;
    if (!organizationId) return none;
    const column = mapping['manufacturerCode'];
    if (column === null || column === undefined || column < 0) return none;

    // One entry per distinct code, remembering every row that used it so the
    // operator is pointed at the actual lines to fix.
    const byKey = new Map<string, { code: string; rowNumbers: number[] }>();
    for (let i = 0; i < rows.length; i++) {
      const key = manufacturerCodeMatchKey(rows[i]?.[column]);
      if (key === null) continue;
      const entry = byKey.get(key);
      if (entry) entry.rowNumbers.push(i + 2);
      else byKey.set(key, { code: normalizeManufacturerCode(rows[i][column]) as string, rowNumbers: [i + 2] });
    }
    if (byKey.size === 0) return { ...none, manufacturerCodeColumn: column };

    const em = this.productRepository.getEntityManager();
    const matches: {
      code: string;
      outcome: 'NONE' | 'UNIQUE' | 'AMBIGUOUS';
      productIds: string[];
      rowNumbers: number[];
    }[] = [];
    for (const { code, rowNumbers } of byKey.values()) {
      const match = await resolveByManufacturerCode(em, organizationId, code);
      if (match.outcome === 'BLANK') continue;
      matches.push({
        code: match.code,
        outcome: match.outcome,
        productIds:
          match.outcome === 'UNIQUE' ? [match.productId] : match.outcome === 'AMBIGUOUS' ? match.productIds : [],
        rowNumbers,
      });
    }
    matches.sort((a, b) => a.code.localeCompare(b.code));
    return {
      manufacturerCodeColumn: column,
      manufacturerCodeMatches: matches,
      manufacturerCodeAmbiguities: matches.filter((m) => m.outcome === 'AMBIGUOUS').length,
    };
  }

  /** Validates a CSV upload and parses it into rows + a guessed column mapping. */
  preview(type: ImportType, file: UploadedCsvFile, grouping?: GroupingOptions) {
    const fields = FIELDS[type];
    if (!fields) throw new BadRequestException(`Unknown import type '${type}'`);

    // Type/content validation (extension, MIME, UTF-8, BOM, NUL/binary) BEFORE
    // any parsing; Excel is rejected here (#172).
    const csvText = validateAndDecodeCsv(file);

    // header:false → record[0] is the header line. Parse at most one row beyond
    // the data cap so an over-limit file is rejected (not silently truncated).
    const parsed = Papa.parse<string[]>(csvText, {
      skipEmptyLines: true,
      preview: PREVIEW_MAX_ROWS + 2,
    });
    const table = parsed.data;
    if (!table.length) throw new BadRequestException('The file has no rows');

    // Data records = everything after the header. The overflow probe row proves
    // the file exceeded the cap.
    if (table.length - 1 > PREVIEW_MAX_ROWS) {
      throw new BadRequestException(
        `El archivo tiene demasiadas filas (máximo ${PREVIEW_MAX_ROWS}). Divídelo e impórtalo por partes.`,
      );
    }

    const headers = table[0].map((h) => String(h ?? '').trim());
    const rows = table
      .slice(1)
      .map((r) => headers.map((_, i) => String(r[i] ?? '').trim()))
      .filter((r) => r.some((cell) => cell !== ''));

    const lower = headers.map((h) => h.toLowerCase());
    const mapping: Record<string, number | null> = {};
    // TWO PASSES, and a column is CLAIMED once (P5-W1).
    //
    // The single pass this replaces let an earlier field take a column by
    // SUBSTRING while a later field matched the very same column EXACTLY, so
    // both ended up mapped to it. That was harmless while no two canonical
    // fields shared vocabulary; it stops being harmless the moment "código
    // fabricante" exists, because `sku`'s guess "codigo" is a substring of it
    // and `sku` is listed first — the supplier's reference would have been
    // read as the internal identity.
    //
    // Exact matches are therefore settled for every field first, and only then
    // do substring fallbacks compete for what is left. A file whose headers
    // match exactly maps exactly as it always did.
    const claimed = new Set<number>();
    for (const field of fields) {
      const idx = lower.findIndex((h, i) => !claimed.has(i) && field.guesses.includes(h));
      mapping[field.key] = idx >= 0 ? idx : null;
      if (idx >= 0) claimed.add(idx);
    }
    for (const field of fields) {
      if (mapping[field.key] !== null) continue;
      const idx = lower.findIndex((h, i) => !claimed.has(i) && field.guesses.some((g) => h.includes(g)));
      mapping[field.key] = idx >= 0 ? idx : null;
      if (idx >= 0) claimed.add(idx);
    }

    // Supplier files list each colour as its own row; offer to file them together
    const nameIdx = mapping['name'];
    const skuIdx = mapping['sku'];
    const groupProposals =
      type === 'products' && nameIdx !== null && nameIdx !== undefined && nameIdx >= 0
        ? confidentGroups(
            rows.map((r) => ({
              name: r[nameIdx] ?? '',
              // The SKU column corroborates families (same stem, different suffix)
              sku: skuIdx !== null && skuIdx !== undefined && skuIdx >= 0 ? (r[skuIdx] ?? null) : null,
            })),
            // Phase 2: this company's learned vocabulary and dismissals apply
            grouping,
          )
        : [];

    return {
      headers,
      rows,
      totalRows: rows.length,
      // Over-limit files are now rejected outright (#172), never truncated
      truncated: false,
      fileRows: table.length - 1,
      mapping,
      fields: fields.map((f) => ({ key: f.key, required: f.required })),
      groupProposals,
    };
  }
}
