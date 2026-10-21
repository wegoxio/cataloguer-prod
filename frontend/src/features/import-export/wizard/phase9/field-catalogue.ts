import type { FieldOption } from '../mapping-region-types';
import type { ImportType } from '../mapping/mapping-state';

/**
 * The fields each import type can fill, stated once.
 *
 * There used to be exactly one catalogue — the products one — and the route
 * handed it to every import type unconditionally. A historical-sales plan
 * therefore opened its mapping editor offering `Stock`, `Categories` and
 * `Images`, none of which that import can write, and offering neither
 * `Quantity` nor `Occurred at`, both of which it requires. The mapping had been
 * built correctly all the same, because the SERVER proposed those two fields
 * during analysis; the dropdown was simply unable to express what was already
 * stored, so the first person to open it saw a mapping it could not show them.
 *
 * Two rules govern what is in this table, and both are load-bearing.
 *
 * **A field appears only where the compiler consumes it.** Offering a field the
 * runner ignores is worse than omitting it: somebody maps their images column,
 * sees it accepted, approves, and gets a catalogue with no images and no
 * finding explaining why. The audit behind these lists is exact — every
 * `values.X` read by `plan-compiler.ts` and the appliers, per compiled type —
 * and `field-catalogue.contract.test.ts` re-derives it from the backend source
 * on every run, so this table cannot quietly drift away from the code that
 * honours it.
 *
 * **`required` means the backend refuses without it**, mirroring
 * `REQUIRED_FIELDS` in `normalized-preview.ts`. It is a claim about the server,
 * not a nudge from the editor, so a field marked here and not there would be a
 * wall in front of a working import.
 */

/** Shared entries, so a field means the same thing wherever it is offered. */
const NAME: FieldOption = { value: 'name', label: 'Name' };

const SKU: FieldOption = {
  value: 'sku',
  label: 'Internal SKU (Catalog)',
  // "SKU (ours)" begged the question "ours as opposed to whose?" beside a
  // column of supplier codes. It is this catalogue's own unique identity for
  // a product, and it says so.
  help: 'Cataloguer’s unique product identity. Unique within your company.',
};

const MANUFACTURER_CODE: FieldOption = {
  value: 'manufacturerCode',
  label: 'Manufacturer code',
  // Deliberately NOT folded into a supplier-SKU field. They are different
  // columns with different rules — `sku` is unique per company, this is not —
  // and merging them would change what identifies a product.
  help: 'The manufacturer’s own code for the item. Not unique, and not the same as a supplier’s SKU.',
};

const EXTERNAL_ID: FieldOption = {
  value: 'externalId',
  label: 'Id from the other system',
  help: 'The identifier the system you are migrating from used for this product.',
};

const DESCRIPTION: FieldOption = { value: 'description', label: 'Description' };
const SHORT_DESCRIPTION: FieldOption = { value: 'shortDescription', label: 'Short description' };
const PRICE: FieldOption = { value: 'price', label: 'Price' };
const SALE_PRICE: FieldOption = { value: 'salePrice', label: 'Sale price' };
const COST: FieldOption = { value: 'cost', label: 'Cost' };
const CATEGORY_PATHS: FieldOption = { value: 'categoryPaths', label: 'Categories' };
const OPTION_LABEL: FieldOption = { value: 'optionLabel', label: 'Option name' };
const PUBLISHED: FieldOption = { value: 'published', label: 'Published' };

const QUANTITY: FieldOption = {
  value: 'quantity',
  label: 'Quantity',
  // Named apart from stock on purpose, and the help says why in the words of
  // the mistake it prevents. A quantity is an EVENT — five were sold — while
  // stock is a STATE — five are on the shelf.
  help: 'How many were sold or ordered. This is an amount that happened, not the stock on hand.',
};

const OCCURRED_AT: FieldOption = {
  value: 'occurredAt',
  label: 'Occurred at',
  help: 'When it happened, as the source system recorded it — not the day you are importing.',
};

const ORDER_NUMBER: FieldOption = {
  value: 'orderNumber',
  label: 'Order number',
  help: 'The reference the source system gave the order. Lines sharing one are treated as one order.',
};

/** Mark an option required for this type, without editing the shared entry. */
const required = (option: FieldOption): FieldOption => ({ ...option, required: true });

/**
 * The catalogue, per import type.
 *
 * Ordered as somebody looks for them: identity first, then description, then
 * commercial values, then everything that attaches.
 */
export const FIELD_CATALOGUE: Record<ImportType, FieldOption[]> = {
  /**
   * Products.
   *
   * `stock` and `categoryPaths` are here even though `buildProductRow` does not
   * read them: they are consumed through the inventory and category
   * relationship intents, which is still the compiler honouring the mapping.
   *
   * `images`, `documents`, `parent`, `locale` and `leadTimeDays` were offered
   * here and are now gone. Not one of them is read as a mapped value anywhere
   * in the runner. Images and documents arrive through asset RULES that carry
   * their own column index, `parent` through the family rule's flag column, and
   * `locale` through a localization rule — all configured elsewhere, none of
   * them satisfied by picking the field in this dropdown. A person who mapped
   * their image column here got silence.
   */
  PRODUCTS: [
    required(NAME),
    SKU,
    MANUFACTURER_CODE,
    EXTERNAL_ID,
    DESCRIPTION,
    SHORT_DESCRIPTION,
    PRICE,
    SALE_PRICE,
    COST,
    { value: 'stock', label: 'Stock' },
    CATEGORY_PATHS,
    OPTION_LABEL,
    PUBLISHED,
  ],

  /**
   * Categories.
   *
   * Three fields, and `name` doubles as the path when no explicit path column
   * is mapped — `compileCategories` falls back from `categoryPaths` to `name`.
   */
  CATEGORIES: [required(NAME), CATEGORY_PATHS, DESCRIPTION],

  /**
   * Historical store sales.
   *
   * `occurredAt` and `quantity` are required outright. Identity is required as
   * a PAIR — `name` or `sku`, either will do — which no single flag can express,
   * so neither is marked here and the server's `IDENTITY_UNMAPPED` finding is
   * what states it. Marking both required would refuse the SKU-only file that
   * is the approved acceptance fixture; marking neither and saying nothing
   * would let a file with no identity at all reach approval.
   *
   * Nothing here writes stock. That is the guarantee the whole import type
   * exists for, and it is enforced in the database — `imported_historical_sales`
   * carries `CHECK (stock_deducted = false)` — not by this list.
   */
  HISTORICAL_STORE_SALES: [
    required(OCCURRED_AT),
    required(QUANTITY),
    SKU,
    NAME,
    OPTION_LABEL,
    PRICE,
    SALE_PRICE,
    ORDER_NUMBER,
    EXTERNAL_ID,
  ],
};

/**
 * The catalogue for a type.
 *
 * Unknown types get an EMPTY catalogue rather than the products one. A type
 * this table has not been taught is a type whose fields nobody has decided, and
 * defaulting to products is the precise mistake this module exists to end.
 */
export function fieldCatalogueFor(importType: ImportType): FieldOption[] {
  return FIELD_CATALOGUE[importType] ?? [];
}

/** Just the field names, for membership checks. */
export function supportedFields(importType: ImportType): string[] {
  return fieldCatalogueFor(importType).map((option) => option.value);
}

/**
 * Fields a stored mapping uses that this type cannot express.
 *
 * Returned rather than dropped. A mapping editor that silently omitted an
 * unsupported field would show a column as unmapped when the plan says it is
 * mapped, and the first save would quietly rewrite the plan to agree with the
 * screen. The caller blocks on a non-empty result.
 */
export function unsupportedFields(
  importType: ImportType,
  columns: { field?: string | null; header?: string }[] | undefined,
): { field: string; header: string }[] {
  const supported = new Set(supportedFields(importType));
  return (columns ?? [])
    .filter((column) => column.field != null && !supported.has(column.field))
    .map((column) => ({ field: column.field as string, header: column.header ?? '' }));
}
