import { Issue, issue } from '../issues/issue-taxonomy';
import { Transformation } from '../transform/transformations';

/**
 * The parts of a mapping that are not "this column becomes that field".
 *
 * A spreadsheet row is flat; a catalogue is not. Somewhere between the two,
 * somebody has to say that column D holds a category PATH rather than a name,
 * that rows sharing a value in column B are variants of one product, that
 * column M is a technical sheet rather than a photograph, and that the price in
 * column H is the organization's list price rather than one particular shop's.
 *
 * None of that can be inferred safely, and every one of those guesses is
 * expensive when wrong:
 *
 *  - guess a family wrongly and unrelated products merge into one card;
 *  - guess a category separator wrongly and "Ropa > Camisetas" becomes a single
 *    category with a chevron in its name;
 *  - guess a store allocation wrongly and one shop's prices appear in another's;
 *  - guess publication wrongly and a draft catalogue goes live.
 *
 * So these are decisions, recorded explicitly, hashed into the plan, and shown
 * to the approver. The rule running through all of them: **nothing is implied.**
 * A row that does not say it belongs to a store does not go to a store; a
 * product whose row says nothing about publication is not published.
 */

/** How rows become a parent and its variants. */
export interface FamilyRule {
  /** Column whose shared value groups rows into one family. */
  groupByColumnIndex: number;
  /** Column naming the variant, e.g. "Talla M". Required: a variant needs a name. */
  optionLabelColumnIndex: number;
  /**
   * How the parent is identified among the grouped rows.
   *
   * `EXPLICIT_COLUMN` — a column says which row is the parent.
   * `SYNTHESIZE` — no row is the parent; one is created from the shared values.
   *
   * There is deliberately no "first row wins". Row order in an export is not
   * meaningful, and a family whose parent depends on sort order would change
   * identity between two exports of the same catalogue.
   */
  parentIdentification: 'EXPLICIT_COLUMN' | 'SYNTHESIZE';
  parentFlagColumnIndex?: number;
}

/** How a cell becomes one or more category paths. */
export interface CategoryRule {
  columnIndex: number;
  /** Separator BETWEEN levels, e.g. ">" in "Ropa > Camisetas". */
  pathSeparator: string;
  /** Separator between whole paths when a cell holds several. */
  listSeparator?: string;
  /**
   * Whether a path that does not exist yet may be created.
   *
   * Off by default. An import that silently invents categories turns a typo in
   * one row into a permanent branch of somebody's catalogue.
   */
  createMissing: boolean;
}

/** A column that fills an activated specification. */
export interface SpecificationRule {
  columnIndex: number;
  /** The field definition's key, which must already exist and be active. */
  definitionKey: string;
  /** Stated rather than inferred; a mismatch is refused, not coerced. */
  expectedType: 'TEXT' | 'NUMBER' | 'BOOLEAN' | 'SELECT' | 'DATE' | 'URL';
  /** For NUMBER definitions carrying a unit. Must match the definition's. */
  unit?: string;
  transformations?: Transformation[];
}

/** A column holding product image links. */
export interface AssetRule {
  columnIndex: number;
  target: 'GALLERY_IMAGE';
  listSeparator?: string;
}

/** A column naming other products this one relates to. */
export interface RelationRule {
  columnIndex: number;
  type: 'RELATED' | 'ACCESSORY' | 'SIMILAR' | 'REPLACEMENT';
  /** Which identifier the cell holds, so the lookup is not a guess. */
  matchBy: 'SKU' | 'MANUFACTURER_CODE' | 'EXTERNAL_ID';
  listSeparator?: string;
}

/** A column holding a translated field. */
export interface LocalizationRule {
  columnIndex: number;
  /** BCP-47-ish, matching the schema's constraint. */
  locale: string;
  field: 'name' | 'description' | 'metaTitle' | 'metaDescription';
}

/**
 * How commercial values reach stores.
 *
 * The default — and the only shape that needs no extra decision — is that the
 * import sets ORGANIZATION-level values and touches no store. Store allocation
 * is opt-in, per store, and never copies.
 */
export interface StoreRule {
  /** Stores this import may write to. Empty means organization level only. */
  storeIds: string[];
  /**
   * Columns carrying per-store values, keyed by store.
   *
   * Absent for a store means that store's price, stock and publication are left
   * exactly as they are. This is the point: a store the import does not
   * mention is a store the import does not change.
   */
  perStoreColumns?: Record<
    string,
    {
      price?: number;
      stock?: number;
      /**
       * A shop's DAMAGED units, when the file breaks them out.
       *
       * A subset of that shop's `stock`, never an addition. Without this column
       * a file that separates damage has nowhere to put it, and the damage
       * silently becomes sellable — which is the one flattening this whole
       * model exists to prevent.
       */
      damagedStock?: number;
      published?: number;
    }
  >;
  /**
   * Whether an organization-level price may be copied into a store that has
   * none.
   *
   * ALWAYS false, and present as a field only so the answer is visible in the
   * stored plan. Copying would make one shop's prices appear in another's the
   * moment somebody added a store.
   */
  copyOrganizationValuesToStores: false;
}

/**
 * Where imported stock physically goes.
 *
 * This rule exists because custody is a DECISION, and the only wrong answer is
 * an automatic one. A file that says a company holds forty of something,
 * without saying where they are, has not told us enough to write a ledger
 * entry: units are in a place, and picking the place on somebody's behalf means
 * a stocktake later finds forty units in a warehouse nobody sent them to.
 *
 * So an import that declares organization-level totals must name where the
 * unallocated remainder lives, and one that does not is refused with that
 * sentence rather than quietly defaulted. Absent altogether, the import simply
 * proposes no stock — which is the right behaviour for the many imports that
 * are only about names and prices.
 */
export interface InventoryRule {
  /**
   * The location unallocated units belong to — typically the main warehouse.
   *
   * Validated against the organization's own locations before a plan is
   * created, so a plan can never name somewhere that does not exist or belongs
   * to somebody else.
   */
  defaultLocationId?: string;
  /**
   * The column holding company-wide DAMAGED units, when the file has one.
   *
   * A subset of the mapped `stock` total. Absent, the import states nothing
   * about damage and every unit is proposed as good — which is correct for the
   * many files that do not track it, and wrong to assume for the ones that do,
   * which is why this is a column somebody points at rather than a guess.
   */
  damagedColumnIndex?: number;
}

export interface RelationshipPlan {
  family?: FamilyRule;
  categories?: CategoryRule;
  specifications?: SpecificationRule[];
  assets?: AssetRule[];
  relations?: RelationRule[];
  localization?: LocalizationRule[];
  stores?: StoreRule;
  inventory?: InventoryRule;
}

/** What the organization actually has, for validating a plan against reality. */
export interface CatalogueVocabulary {
  /** Active field definitions, by key. */
  definitions: Map<string, { type: string; unit?: string | null; options?: string[] | null; archived: boolean }>;
  /** Store ids the caller may write to, already narrowed by tenant scope. */
  allowedStoreIds: Set<string>;
  /** Locales the organization recognises, including its default. */
  locales: Set<string>;
}

const LOCALE_PATTERN = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$/;

/**
 * Check a relationship plan against the catalogue it will be applied to.
 *
 * Every finding here is about a decision that cannot be repaired at row level.
 * A specification pointing at a definition that does not exist is not "some
 * rows will fail" — it is a mapping that cannot work at all, and reporting it
 * once at plan time is the difference between one clear message and eight
 * hundred identical row errors.
 */
export function validateRelationshipPlan(
  plan: RelationshipPlan,
  vocabulary: CatalogueVocabulary,
  columnHeaders: string[],
): Issue[] {
  const issues: Issue[] = [];
  const columnName = (index: number) => columnHeaders[index] ?? `column ${index + 1}`;
  const withinFile = (index: number | undefined) => index !== undefined && index >= 0 && index < columnHeaders.length;

  if (plan.family) {
    const { family } = plan;
    if (!withinFile(family.groupByColumnIndex) || !withinFile(family.optionLabelColumnIndex)) {
      issues.push(
        issue('PARENT_MISSING', 'The family grouping refers to a column that is not in this file.', {
          guidance: 'Choose the column whose shared value identifies a family.',
        }),
      );
    }
    if (family.parentIdentification === 'EXPLICIT_COLUMN' && !withinFile(family.parentFlagColumnIndex)) {
      issues.push(
        issue('PARENT_MISSING', 'No column says which row of each family is the parent.', {
          guidance:
            'Pick the column that marks the parent row, or choose to create the parent from the shared values instead.',
        }),
      );
    }
    if (family.groupByColumnIndex === family.optionLabelColumnIndex) {
      // If the grouping value and the variant name are the same column, every
      // row is its own family of one — which is not a family at all.
      issues.push(
        issue(
          'FAMILY_INCOMPLETE',
          `Column "${columnName(family.groupByColumnIndex)}" is used both to group the family and to name each variant.`,
          {
            severity: 'BLOCKING',
            guidance: 'Variants need a name that differs from the value that groups them.',
          },
        ),
      );
    }
  }

  if (plan.categories) {
    const { categories } = plan;
    if (!withinFile(categories.columnIndex)) {
      issues.push(
        issue('CATEGORY_PATH_UNRESOLVED', 'The category mapping refers to a column that is not in this file.'),
      );
    }
    if (categories.pathSeparator.trim() === '') {
      issues.push(
        issue('CATEGORY_PATH_UNRESOLVED', 'No separator was given for category paths.', {
          severity: 'BLOCKING',
          guidance: 'Say what separates the levels, for example ">" in "Ropa > Camisetas".',
        }),
      );
    }
    if (categories.listSeparator && categories.listSeparator === categories.pathSeparator) {
      // Otherwise "A > B" is both one two-level path and two one-level ones.
      issues.push(
        issue(
          'CATEGORY_PATH_UNRESOLVED',
          'The separator between levels and the separator between paths are the same character.',
          {
            severity: 'BLOCKING',
            guidance: 'Use different characters, or leave the path separator blank if each cell holds one path.',
          },
        ),
      );
    }
  }

  for (const spec of plan.specifications ?? []) {
    const definition = vocabulary.definitions.get(spec.definitionKey);
    if (!definition) {
      issues.push(
        issue('SPECIFICATION_UNUSABLE', `There is no specification called "${spec.definitionKey}".`, {
          severity: 'BLOCKING',
          anchor: { column: columnName(spec.columnIndex) },
          guidance: 'Create the specification first, or map this column to something else.',
        }),
      );
      continue;
    }
    if (definition.archived) {
      issues.push(
        issue('SPECIFICATION_UNUSABLE', `The specification "${spec.definitionKey}" has been archived.`, {
          severity: 'BLOCKING',
          anchor: { column: columnName(spec.columnIndex) },
          guidance: 'Restore it, or map this column to a different specification.',
        }),
      );
      continue;
    }
    if (definition.type !== spec.expectedType) {
      // Refused rather than coerced. A NUMBER definition fed text would either
      // reject every row or, worse, store something that parsed by accident.
      issues.push(
        issue(
          'SPECIFICATION_UNUSABLE',
          `"${spec.definitionKey}" holds ${definition.type} values, but this mapping treats it as ${spec.expectedType}.`,
          {
            severity: 'BLOCKING',
            anchor: { column: columnName(spec.columnIndex) },
            guidance: 'Change the clean-up steps so the column produces the right kind of value.',
          },
        ),
      );
      continue;
    }
    if (spec.unit && definition.unit && spec.unit !== definition.unit) {
      // A silent unit mismatch is the quietest way to be wrong: 5 kg stored
      // where the catalogue says grams reads perfectly and means nothing.
      issues.push(
        issue(
          'SPECIFICATION_UNUSABLE',
          `"${spec.definitionKey}" is measured in ${definition.unit}, but this mapping says ${spec.unit}.`,
          {
            severity: 'BLOCKING',
            anchor: { column: columnName(spec.columnIndex) },
            guidance: 'Convert the values, or map to a specification that uses these units.',
          },
        ),
      );
    }
  }

  for (const rule of plan.localization ?? []) {
    if (!LOCALE_PATTERN.test(rule.locale)) {
      issues.push(
        issue('LOCALE_UNKNOWN', `"${rule.locale}" is not a language code this catalogue understands.`, {
          severity: 'BLOCKING',
          anchor: { column: columnName(rule.columnIndex) },
          guidance: 'Use a code such as "es", "en" or "pt-BR".',
        }),
      );
      continue;
    }
    if (vocabulary.locales.size > 0 && !vocabulary.locales.has(rule.locale)) {
      issues.push(
        issue('LOCALE_UNKNOWN', `This catalogue does not use the language "${rule.locale}" yet.`, {
          severity: 'WARNING',
          anchor: { column: columnName(rule.columnIndex) },
          guidance: 'Add the language to your catalogue first, or the translations will not be shown.',
        }),
      );
    }
  }

  // The same locale and field mapped twice is two columns claiming one value.
  const localeClaims = new Map<string, number>();
  for (const rule of plan.localization ?? []) {
    const key = `${rule.locale}:${rule.field}`;
    localeClaims.set(key, (localeClaims.get(key) ?? 0) + 1);
  }
  for (const [key, count] of localeClaims) {
    if (count > 1) {
      issues.push(
        issue('DUPLICATE_FIELD_MAPPING', `Two columns both provide the ${key.split(':')[1]} in ${key.split(':')[0]}.`, {
          guidance: 'Choose one of them.',
        }),
      );
    }
  }

  if (plan.stores) {
    for (const storeId of plan.stores.storeIds) {
      if (!vocabulary.allowedStoreIds.has(storeId)) {
        // Indistinguishable from a store that does not exist: confirming one
        // exists in a company the caller cannot see is itself a disclosure.
        issues.push(
          issue('STORE_NOT_PERMITTED', 'One of the selected shops is not available to you.', {
            guidance: 'Choose a shop you have access to.',
          }),
        );
      }
    }
    for (const storeId of Object.keys(plan.stores.perStoreColumns ?? {})) {
      if (!plan.stores.storeIds.includes(storeId)) {
        issues.push(
          issue('STORE_NOT_PERMITTED', 'A shop has per-shop columns but was not selected for this import.', {
            guidance: 'Select the shop, or remove its columns.',
          }),
        );
      }
    }
  }

  return issues;
}

/**
 * Every column the relationship plan consumes.
 *
 * Used by the editor to mark those columns as decided: a column feeding the
 * category rule has had a decision made about it just as surely as one bound to
 * a field, and asking about it again would be noise.
 */
export function columnsClaimedByRelationships(plan: RelationshipPlan): number[] {
  const claimed = new Set<number>();
  if (plan.family) {
    claimed.add(plan.family.groupByColumnIndex);
    claimed.add(plan.family.optionLabelColumnIndex);
    if (plan.family.parentFlagColumnIndex !== undefined) claimed.add(plan.family.parentFlagColumnIndex);
  }
  if (plan.categories) claimed.add(plan.categories.columnIndex);
  for (const spec of plan.specifications ?? []) claimed.add(spec.columnIndex);
  for (const asset of plan.assets ?? []) claimed.add(asset.columnIndex);
  for (const relation of plan.relations ?? []) claimed.add(relation.columnIndex);
  for (const rule of plan.localization ?? []) claimed.add(rule.columnIndex);
  for (const columns of Object.values(plan.stores?.perStoreColumns ?? {})) {
    for (const index of Object.values(columns)) {
      if (typeof index === 'number') claimed.add(index);
    }
  }
  return [...claimed].sort((a, b) => a - b);
}

/**
 * Split a category cell into paths, each path into levels.
 *
 * Empty levels are dropped rather than becoming a category with a blank name:
 * "Ropa >> Camisetas" is a typo, not a three-level path with an unnamed middle.
 */
export function parseCategoryPaths(value: string, rule: CategoryRule): string[][] {
  const cells = rule.listSeparator ? value.split(rule.listSeparator) : [value];
  const paths: string[][] = [];
  for (const cell of cells) {
    const levels = cell
      .split(rule.pathSeparator)
      .map((level) => level.trim())
      .filter((level) => level !== '');
    if (levels.length > 0) paths.push(levels);
  }
  return paths;
}

export interface FamilyGroup {
  key: string;
  parentRow?: number;
  childRows: number[];
}

/**
 * Group rows into families, and say which groups are wrong.
 *
 * The failure this exists to surface is a family with no parent and a family
 * with several. Both are ambiguous, and both are common in real exports —
 * somebody marks two rows as the parent, or forgets to mark any. Neither can be
 * resolved by picking one, so both are reported for correction.
 */
export function groupFamilies(rows: { sourceRow: number; groupValue: string; isParent: boolean }[]): {
  groups: FamilyGroup[];
  issues: Issue[];
} {
  const byKey = new Map<string, { sourceRow: number; isParent: boolean }[]>();
  for (const row of rows) {
    const key = row.groupValue.trim();
    if (key === '') continue; // a row with no grouping value is standalone
    const list = byKey.get(key) ?? [];
    list.push({ sourceRow: row.sourceRow, isParent: row.isParent });
    byKey.set(key, list);
  }

  const groups: FamilyGroup[] = [];
  const issues: Issue[] = [];

  for (const [key, members] of byKey) {
    const parents = members.filter((m) => m.isParent);
    if (parents.length > 1) {
      issues.push(
        issue('FAMILY_INCOMPLETE', `${parents.length} rows are marked as the main product for "${key}".`, {
          severity: 'BLOCKING',
          anchor: { row: Math.min(...parents.map((p) => p.sourceRow)) },
          guidance: 'A family has exactly one main product. Unmark the others.',
        }),
      );
      continue;
    }
    if (members.length === 1 && parents.length === 0) {
      // A lone row that named a family but is not one. Treated as standalone
      // rather than as a broken family, which is what it almost always is.
      continue;
    }
    groups.push({
      key,
      parentRow: parents[0]?.sourceRow,
      childRows: members.filter((m) => !m.isParent).map((m) => m.sourceRow),
    });
  }

  return { groups, issues };
}
