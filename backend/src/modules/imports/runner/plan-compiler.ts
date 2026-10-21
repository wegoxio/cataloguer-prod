import { NormalizedRow, TableMapping, buildNormalizedPreview } from '../preview/normalized-preview';
import { PlannedUnit } from '../execution/batch-planner';
import { RelationshipPlan, groupFamilies, parseCategoryPaths } from '../relationships/relationship-plan';
import { MatchLookups, RowIdentity, matchRow } from '../matching/record-matching';

/**
 * The system these identities came from. One value for now: every plan-based
 * import is a spreadsheet somebody mapped, whatever produced the spreadsheet.
 * The column exists so a real connector can be told apart later.
 */
export const SOURCE_SYSTEM = 'manual-spreadsheet';
import { ProductMutation } from '../appliers/products.applier';
import { CategoryMutation } from '../appliers/categories.applier';
import { HistoricalSaleRow } from '../appliers/historical-sales.applier';
import { StoreAllocation } from '../inventory/inventory-proposal';
import { Issue, issue } from '../issues/issue-taxonomy';
import type { RowRelationships } from './product-relationships.applier';

/**
 * Turning an approved plan back into work.
 *
 * A plan stores DECISIONS — which column means what, which rows form a family,
 * which shop the file describes — and deliberately not the data those decisions
 * apply to. The rows are re-read from the source at execution time and the
 * units are rebuilt here.
 *
 * That is the more expensive design and it is the correct one. Storing the
 * compiled units would mean the thing that runs was frozen at approval time,
 * and a source whose bytes changed underneath would go unnoticed; recompiling
 * from bytes whose hash is verified means the run either sees exactly the file
 * that was approved or refuses. It also keeps a plan small: a hundred-thousand
 * row workbook does not become a hundred-thousand row JSON column.
 *
 * Nothing here writes. The compiler produces units and findings; every
 * mutation belongs to an applier, inside a batch transaction.
 */

export interface CompileContext {
  organizationId: string;
  importType: string;
  mapping: TableMapping;
  relationships: RelationshipPlan;
  /** The shop the plan named, for the types that require one. */
  storeId: string | null;
  /**
   * Shops this import may write to at all.
   *
   * Narrowed to the plan's own shop when it named one. Checked here as well as
   * at plan time because a plan outlives the moment it was built: a shop can be
   * archived, moved to another company, or taken out of somebody's reach
   * between approving an import and running it.
   */
  allowedStoreIds: Set<string>;
  /** Rows as read from the source, first row number included. */
  rows: string[][];
  firstRowNumber: number;
  lookups: MatchLookups;
}

export interface CompiledPlan {
  sourceTable: string;
  units: PlannedUnit[];
  /** Findings the compilation itself produced, which join the run's report. */
  issues: Issue[];
}

/** One product row and whatever it said about stock, kept together. */
export interface ProductRowPlan {
  product: ProductMutation;
  /**
   * What the row declared about stock, if anything.
   *
   * Deliberately NOT `ProductMutation.fields.stock`: that field exists only so
   * a mapping asking the products applier to write stock can be refused by
   * name. Stock reaches the ledger through a proposal, never through a product
   * column.
   */
  inventory?: {
    organizationTotal?: number;
    organizationDamaged?: number;
    allocations?: StoreAllocation[];
    defaultLocationId?: string | null;
  };
  /**
   * Everything the row said BESIDES the product — its categories,
   * specifications, files, links and translations.
   *
   * Parsed here and resolved at apply time, because every one of them needs
   * the database to say what it points at: a category that may or may not
   * exist, a definition that may have been archived, a related product that
   * may match two records.
   */
  relationships?: RowRelationships;
  /**
   * The children's own plans, mirroring `product.children`.
   *
   * Carried separately because a child has its own categories, specifications
   * and translations, and `ProductMutation.children` holds only the product
   * half. Dropping it is how a family import writes the parent's
   * specifications and silently loses every variant's.
   */
  children?: ProductRowPlan[];
}

/** A plan and every child under it, in the order they will be written. */
export function allRowPlans(plan: ProductRowPlan): ProductRowPlan[] {
  return [plan, ...(plan.children ?? [])];
}

export function compilePlan(context: CompileContext): CompiledPlan {
  // `limit` is the whole file, not the editor's sample. The default exists so
  // the preview shown while mapping stays cheap; using it here would silently
  // import the first twenty-five rows of a nine-hundred-row export and report
  // success.
  const preview = buildNormalizedPreview(context.rows, context.firstRowNumber, context.mapping, {
    importType: context.importType,
    limit: context.rows.length,
  });

  const rows = preview.rows.filter((row) => !row.blank);

  switch (context.importType) {
    case 'PRODUCTS':
      return compileProducts(rows, context);
    case 'CATEGORIES':
      return compileCategories(rows, context);
    case 'HISTORICAL_STORE_SALES':
      return compileHistoricalSales(rows, context);
    default:
      return { sourceTable: tableName(context), units: [], issues: [] };
  }
}

function tableName(context: CompileContext): string {
  return context.mapping.sheet ?? 'main';
}

/* ------------------------------------------------------------------ products */

function compileProducts(rows: NormalizedRow[], context: CompileContext): CompiledPlan {
  const issues: Issue[] = [];
  const plans = new Map<number, ProductRowPlan>();

  // Said out loud, once, rather than left as absence. A plan naming a shop
  // this import may not reach has its per-shop values dropped — and a person
  // who chose that shop deserves to know it was not written to, rather than
  // discovering later that one shop's prices never changed.
  const unreachable = (context.relationships.stores?.storeIds ?? []).filter(
    (storeId) => !context.allowedStoreIds.has(storeId),
  );
  if (unreachable.length > 0) {
    issues.push(
      issue(
        'STORE_NOT_PERMITTED',
        unreachable.length === 1
          ? 'One of the shops this import was built for is not available to it, so that shop was not changed.'
          : `${unreachable.length} of the shops this import was built for are not available to it, so they were not changed.`,
        {
          severity: 'WARNING',
          guidance: 'Build the import again for the shops you can reach.',
        },
      ),
    );
  }

  for (const row of rows) {
    plans.set(row.sourceRow, buildProductRow(row, context));
  }

  const family = context.relationships.family;
  if (!family) {
    // Every row stands alone. This is the common case: most exports are one
    // product per line, and treating them as one-member families would make
    // every unit a FAMILY for no benefit.
    return {
      sourceTable: tableName(context),
      units: [...plans.values()].map((plan) => ({
        kind: 'ROW' as const,
        sourceRows: [plan.product.sourceRow],
        applier: 'PRODUCTS',
        mutations: [plan],
      })),
      issues,
    };
  }

  const grouped = groupFamilies(
    rows.map((row) => ({
      sourceRow: row.sourceRow,
      groupValue: String(cellAt(row, family.groupByColumnIndex) ?? ''),
      isParent:
        family.parentIdentification === 'EXPLICIT_COLUMN' && family.parentFlagColumnIndex !== undefined
          ? isTruthy(cellAt(row, family.parentFlagColumnIndex))
          : false,
    })),
  );
  issues.push(...grouped.issues);

  const units: PlannedUnit[] = [];
  const claimed = new Set<number>();

  for (const group of grouped.groups) {
    const parentRow = group.parentRow;
    const childRows = group.childRows.filter((r) => r !== parentRow);

    // A family with no parent row is SYNTHESIZED from the first member's shared
    // values rather than skipped — but only when the plan said to. Inventing a
    // parent the plan did not ask for would put a product in the catalogue that
    // nobody's file describes.
    if (parentRow === undefined && family.parentIdentification !== 'SYNTHESIZE') {
      issues.push(
        issue('FAMILY_INCOMPLETE', `No row is marked as the main product for "${group.key}".`, {
          severity: 'BLOCKING',
          anchor: { row: Math.min(...group.childRows) },
          guidance: 'Mark one row as the main product, or choose to create one from the shared values.',
        }),
      );
      continue;
    }

    const anchorRow = parentRow ?? group.childRows[0];
    const anchor = plans.get(anchorRow);
    if (!anchor) continue;

    const children = childRows.map((r) => plans.get(r)).filter((p): p is ProductRowPlan => p !== undefined);

    const parentPlan: ProductRowPlan = {
      ...anchor,
      product: {
        ...anchor.product,
        // A SYNTHESIZED parent is built from a member's shared values, so its
        // variant label is cleared: a parent called "Camiseta — Talla M" is
        // the bug this line exists to prevent. An explicitly marked parent
        // keeps whatever its own row said.
        ...(parentRow === undefined
          ? { fields: { ...anchor.product.fields, optionLabel: null, name: familyName(anchor, group.key) } }
          : {}),
        children: children.map((c) => c.product),
      },
      children,
    };

    units.push({
      kind: 'FAMILY',
      sourceRows: [anchorRow, ...childRows].sort((a, b) => a - b),
      applier: 'PRODUCTS',
      mutations: [parentPlan],
    });

    claimed.add(anchorRow);
    for (const r of childRows) claimed.add(r);
  }

  for (const [sourceRow, plan] of plans) {
    if (claimed.has(sourceRow)) continue;
    units.push({ kind: 'ROW', sourceRows: [sourceRow], applier: 'PRODUCTS', mutations: [plan] });
  }

  units.sort((a, b) => a.sourceRows[0] - b.sourceRows[0]);
  return { sourceTable: tableName(context), units, issues };
}

/**
 * What to call a parent nobody's row describes.
 *
 * The grouping value, which is the one thing every member of the family agrees
 * on. Taking a member's own name would put "Camiseta azul talla M" at the head
 * of a family whose other members are red and large.
 */
function familyName(anchor: ProductRowPlan, groupKey: string): string {
  return groupKey.trim() || anchor.product.fields.name || 'Sin nombre';
}

function buildProductRow(row: NormalizedRow, context: CompileContext): ProductRowPlan {
  const values = row.values as Record<string, unknown>;

  const identity: RowIdentity = {
    externalId: text(values.externalId),
    sku: text(values.sku),
    manufacturerCode: text(values.manufacturerCode),
    name: text(values.name),
    categoryKey: firstCategoryKey(values, context),
  };
  const match = matchRow(identity, context.lookups);

  const product: ProductMutation = {
    sourceRow: row.sourceRow,
    targetId: match.decision === 'UPDATE' ? match.targetId : null,
    matchProvenance: match.provenance,
    /*
     * WHAT THIS FILE CALLS THE ROW, kept so the applier can record it.
     *
     * The external id when the file has one. Failing that, the SKU — because a
     * family card gives its SKU up at commit (a card is never ordered, sold or
     * received, so a sellable item's identifier has no business on one), and
     * without a durable record of what the file called it, the next run of the
     * same file could not find it again. `matchRow` consults the recorded
     * identity before anything else, and falls back to it when a SKU it is
     * given matches no product.
     */
    externalIdentity: identity.externalId
      ? { sourceSystem: SOURCE_SYSTEM, externalId: identity.externalId }
      : identity.sku
        ? { sourceSystem: SOURCE_SYSTEM, externalId: identity.sku }
        : null,
    fields: pruneUndefined({
      name: text(values.name) ?? undefined,
      sku: text(values.sku),
      manufacturerCode: text(values.manufacturerCode),
      description: text(values.description),
      shortDescription: text(values.shortDescription),
      price: number(values.price),
      salePrice: number(values.salePrice),
      cost: number(values.cost),
      optionLabel: text(values.optionLabel),
      published: values.published === undefined ? undefined : Boolean(values.published),
    }),
  };

  const storeValues = buildStoreValues(row, context);
  if (storeValues.length > 0) product.storeValues = storeValues;

  const inventory = buildInventoryIntent(row, context);
  const relationships = buildRowRelationships(row, context);

  return {
    product,
    ...(inventory ? { inventory } : {}),
    ...(relationships ? { relationships } : {}),
  };
}

/**
 * What the row says about everything that is not the product itself.
 *
 * Parsed, never resolved: whether a category exists, whether a specification's
 * definition is still active, which product a code refers to — all of those are
 * questions for the database at apply time, inside the row's own transaction.
 * Answering them here would mean answering them against a catalogue that may
 * have changed by the time the row is written.
 */
function buildRowRelationships(row: NormalizedRow, context: CompileContext): RowRelationships | undefined {
  const rules = context.relationships;
  const result: RowRelationships = {};

  const categoryRule = rules.categories;
  if (categoryRule) {
    const raw = text(cellAt(row, categoryRule.columnIndex));
    const paths = raw ? parseCategoryPaths(raw, categoryRule) : [];
    if (paths.length > 0) {
      result.categoryPaths = paths;
      result.createMissingCategories = categoryRule.createMissing;
    }
  }

  const specifications = (rules.specifications ?? [])
    .map((rule) => ({ rule, value: text(cellAt(row, rule.columnIndex)) }))
    // A blank cell says nothing about the specification. Writing an empty
    // value would erase whatever the product already had.
    .filter((entry): entry is { rule: typeof entry.rule; value: string } => entry.value !== null)
    .map(({ rule, value }) => ({
      definitionKey: rule.definitionKey,
      expectedType: rule.expectedType,
      ...(rule.unit === undefined ? {} : { unit: rule.unit }),
      value,
    }));
  if (specifications.length > 0) result.specifications = specifications;

  const assets = (rules.assets ?? []).flatMap((rule) => {
    const raw = text(cellAt(row, rule.columnIndex));
    if (!raw) return [];
    const urls = rule.listSeparator ? raw.split(rule.listSeparator) : [raw];
    return urls
      .map((url) => url.trim())
      .filter((url) => url !== '')
      .map((url) => ({
        url,
        target: rule.target,
      }));
  });
  if (assets.length > 0) result.assets = assets;

  const relations = (rules.relations ?? []).flatMap((rule) => {
    const raw = text(cellAt(row, rule.columnIndex));
    if (!raw) return [];
    const values = (rule.listSeparator ? raw.split(rule.listSeparator) : [raw])
      .map((v) => v.trim())
      .filter((v) => v !== '');
    return values.length > 0 ? [{ type: rule.type, matchBy: rule.matchBy, values }] : [];
  });
  if (relations.length > 0) result.relations = relations;

  const translations = (rules.localization ?? [])
    .map((rule) => ({ rule, value: text(cellAt(row, rule.columnIndex)) }))
    .filter((entry): entry is { rule: typeof entry.rule; value: string } => entry.value !== null)
    .map(({ rule, value }) => ({ locale: rule.locale, field: rule.field, value }));
  if (translations.length > 0) result.translations = translations;

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Per-shop commercial values, for the shops the plan actually named.
 *
 * A shop the plan does not mention gets nothing — not a copy of the
 * organization price, not a blank. `copyOrganizationValuesToStores` is typed as
 * `false` precisely so this cannot drift: one shop's prices appearing in
 * another's is the failure the whole per-store model exists to prevent.
 */
function buildStoreValues(row: NormalizedRow, context: CompileContext): NonNullable<ProductMutation['storeValues']> {
  const rule = context.relationships.stores;
  if (!rule || rule.storeIds.length === 0) return [];

  const values: NonNullable<ProductMutation['storeValues']> = [];
  for (const storeId of rule.storeIds) {
    // A shop outside what this import may reach is dropped, exactly as an
    // inventory allocation for it would be. The narrowing used to guard stock
    // only, which meant a plan built for one shop could still write another
    // shop's PRICES — the same cross-shop leak, through the other door.
    if (!context.allowedStoreIds.has(storeId)) continue;

    // Naming a shop IS the instruction. This used to require a price or
    // publication column, so a plan saying "list these products in Store B"
    // with no per-shop columns listed them nowhere at all — every row reported
    // CREATED and the shop stayed empty. That was half of the reported defect.
    //
    // A listing carrying no commercial values is a real and useful thing: the
    // product belongs to the shop, unpublished, at the organization's price
    // until somebody decides otherwise.
    const columns = rule.perStoreColumns?.[storeId];

    const price = columns?.price === undefined ? undefined : number(cellAt(row, columns.price));
    const published = columns?.published === undefined ? undefined : isTruthy(cellAt(row, columns.published));

    values.push({
      storeId,
      ...(price === undefined ? {} : { price }),
      ...(published === undefined ? {} : { published }),
    });
  }
  return values;
}

/**
 * What the row said about stock, if anything.
 *
 * `undefined` — the file was silent — is carefully distinct from `0`, which is
 * somebody stating that they hold none. The first must change nothing; the
 * second is a decision, and dropping it would leave stale stock on a product
 * whose owner has told us it is empty.
 */
function buildInventoryIntent(row: NormalizedRow, context: CompileContext): ProductRowPlan['inventory'] | undefined {
  const total = number((row.values as Record<string, unknown>).stock);
  const rule = context.relationships.stores;

  const allocations: StoreAllocation[] = [];
  for (const storeId of rule?.storeIds ?? []) {
    if (!context.allowedStoreIds.has(storeId)) continue;
    const columns = rule?.perStoreColumns?.[storeId];
    if (!columns || columns.stock === undefined) continue;

    const quantity = number(cellAt(row, columns.stock));
    if (quantity === undefined) continue;

    // Damaged units are a SUBSET of the shop's stock, so the good count is
    // what is left after them. A file that separates damage and has it posted
    // as sellable anyway is the failure the split exists to prevent.
    const damaged =
      columns.damagedStock === undefined ? 0 : Math.max(0, number(cellAt(row, columns.damagedStock)) ?? 0);
    const good = quantity - damaged;

    // Condition is stated, never assumed. A file that does not break stock
    // into good and damaged is declaring good stock, which is what the column
    // header says it is.
    if (good > 0 || damaged === 0) allocations.push({ storeId, quantity: Math.max(0, good), condition: 'GOOD' });
    if (damaged > 0) allocations.push({ storeId, quantity: damaged, condition: 'DAMAGED' });
  }

  const damagedColumn = context.relationships.inventory?.damagedColumnIndex;
  const organizationDamaged = damagedColumn === undefined ? undefined : number(cellAt(row, damagedColumn));

  if (total === undefined && allocations.length === 0) return undefined;

  return {
    ...(total === undefined ? {} : { organizationTotal: total }),
    ...(organizationDamaged === undefined ? {} : { organizationDamaged }),
    ...(allocations.length > 0 ? { allocations } : {}),
    // Where unallocated units live is a CUSTODY decision, taken in the wizard
    // and carried in the plan. Left unset, the classifier refuses any row whose
    // total exceeds its allocations — which is the behaviour we want: nobody
    // should discover later that forty units were quietly assigned to a
    // warehouse on their behalf.
    defaultLocationId: context.relationships.inventory?.defaultLocationId ?? null,
  };
}

/* ---------------------------------------------------------------- categories */

function compileCategories(rows: NormalizedRow[], context: CompileContext): CompiledPlan {
  const rule = context.relationships.categories;
  const units: PlannedUnit[] = [];

  for (const row of rows) {
    const raw = text(
      (row.values as Record<string, unknown>).categoryPaths ?? (row.values as Record<string, unknown>).name,
    );
    const paths = raw && rule ? parseCategoryPaths(raw, rule) : raw ? [[raw]] : [];

    const mutations: CategoryMutation[] = paths.map((path) => ({
      sourceRow: row.sourceRow,
      path,
      createMissing: rule?.createMissing ?? false,
      description: text((row.values as Record<string, unknown>).description),
    }));

    // A row naming no category still produces one unit, so it gets one outcome
    // and appears in the report. A row that simply vanished would look like a
    // row we never read.
    units.push({
      kind: 'ROW',
      sourceRows: [row.sourceRow],
      applier: 'CATEGORIES',
      mutations:
        mutations.length > 0
          ? mutations
          : [{ sourceRow: row.sourceRow, path: [], createMissing: rule?.createMissing ?? false }],
    });
  }

  return { sourceTable: tableName(context), units, issues: [] };
}

/* ----------------------------------------------------------- supplier orders */

/* -------------------------------------------------------- historical sales */

function compileHistoricalSales(rows: NormalizedRow[], context: CompileContext): CompiledPlan {
  const issues: Issue[] = [];

  if (!context.storeId) {
    return {
      sourceTable: tableName(context),
      units: [],
      issues: [
        issue('STORE_REQUIRED', 'Historical sales belong to one shop, and this import does not name one.', {
          severity: 'BLOCKING',
          guidance: 'Choose which shop this file describes.',
        }),
      ],
    };
  }

  const units: PlannedUnit[] = [];
  for (const row of rows) {
    const values = row.values as Record<string, unknown>;
    const occurredAt = date(values.occurredAt);
    if (!occurredAt) {
      issues.push(
        issue('EVENT_DATE_MISSING', 'This sale does not say when it happened.', {
          severity: 'BLOCKING',
          anchor: { row: row.sourceRow },
          guidance: 'Map the column holding the sale date.',
        }),
      );
      continue;
    }

    const sku = text(values.sku);
    const matched = sku ? context.lookups.bySku(sku) : null;

    /*
      A sale must say WHAT was sold.

      Either column satisfies it — `itemText` falls back from name to sku — but
      neither leaves an empty identity, and a row saying something was sold
      without saying what is not a record of anything. The preview raises
      `IDENTITY_UNMAPPED` for the same condition at MAPPING time; this catches
      the per-ROW case a mapping check cannot see, so the two cannot disagree
      about what is runnable.
    */
    const identity = text(values.name) ?? sku;
    if (!identity) {
      issues.push(
        issue('IDENTITY_UNMAPPED', 'This sale does not say what was sold.', {
          severity: 'BLOCKING',
          anchor: { row: row.sourceRow },
          guidance: 'Give the row a SKU or a name, or leave it out of the file.',
        }),
      );
      continue;
    }

    const sale: HistoricalSaleRow = {
      sourceRow: row.sourceRow,
      storeId: context.storeId,
      productId: matched?.id ?? null,
      // Kept whether or not it matched: an unmatched sale is still a sale that
      // happened, and discarding its text would lose the only record of what
      // was sold.
      // Never empty: the guard above refused the row that would produce one.
      itemText: identity,
      variantText: text(values.optionLabel),
      quantity: number(values.quantity) ?? 1,
      unitPrice: number(values.price),
      lineTotal: number(values.salePrice),
      occurredAt,
      externalRef: text(values.externalId),
      customerReference: text(values.orderNumber),
    };

    units.push({
      kind: 'ROW',
      sourceRows: [row.sourceRow],
      applier: 'HISTORICAL_STORE_SALES',
      mutations: [sale],
    });
  }

  return { sourceTable: tableName(context), units, issues };
}

/* -------------------------------------------------------------------- values */

function cellAt(row: NormalizedRow, columnIndex: number): unknown {
  return row.cells.find((cell) => cell.columnIndex === columnIndex)?.normalized ?? null;
}

function isTruthy(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  const text = String(value ?? '')
    .trim()
    .toLowerCase();
  return text === 'true' || text === 'yes' || text === 'si' || text === 'sí' || text === '1';
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : null;
  const asText = String(value).trim();
  return asText === '' ? null : asText;
}

function number(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const asNumber = typeof value === 'number' ? value : Number(String(value).trim());
  return Number.isFinite(asNumber) ? asNumber : undefined;
}

function date(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const raw = text(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function firstCategoryKey(values: Record<string, unknown>, context: CompileContext): string | null {
  const rule = context.relationships.categories;
  const raw = text(values.categoryPaths);
  if (!raw) return null;
  if (!rule) return raw;
  const paths = parseCategoryPaths(raw, rule);
  return paths.length > 0 ? paths[0].join(' > ') : null;
}

/**
 * Drop keys whose value is `undefined`.
 *
 * The appliers read absence as "do not change this field", so an explicit
 * `undefined` and a missing key must not be distinguishable — one of them
 * would otherwise overwrite a description with nothing.
 */
function pruneUndefined<T extends Record<string, unknown>>(fields: T): T {
  const out = {} as T;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}
