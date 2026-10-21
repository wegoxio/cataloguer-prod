'use client';

import React from 'react';
import { cn } from '../../../../lib/cn';

/**
 * The editors for everything a column-to-field mapping cannot say.
 *
 * These are the decisions that turn a flat file into a catalogue: which rows
 * are child products of one parent, how a category path is written, whether a link
 * is a photograph or a datasheet, and which shop a price belongs to.
 *
 * Two principles shape every control here.
 *
 * **Nothing is pre-selected that would act.** The category "create missing"
 * switch is off, no store is chosen, publication is never a default. A person
 * who clicks straight through must end up with the cautious import, not the
 * far-reaching one.
 *
 * **Every choice says what it will do**, in the same words the preview and the
 * report will use. "Create categories that do not exist yet" is a decision
 * somebody can weigh; "createMissing" is not.
 */

export interface ColumnChoice {
  index: number;
  header: string;
}

export interface StoreChoice {
  id: string;
  name: string;
}

export interface SpecificationChoice {
  key: string;
  label: string;
  type: string;
  unit?: string | null;
}

export interface FamilyRuleValue {
  groupByColumnIndex: number;
  optionLabelColumnIndex: number;
  parentIdentification: 'EXPLICIT_COLUMN' | 'SYNTHESIZE';
  parentFlagColumnIndex?: number;
}

export interface CategoryRuleValue {
  columnIndex: number;
  pathSeparator: string;
  listSeparator?: string;
  createMissing: boolean;
}

export interface StoreRuleValue {
  storeIds: string[];
  copyOrganizationValuesToStores: false;
}

/** A labelled column chooser, used by nearly every editor here. */
function ColumnSelect({
  id,
  label,
  columns,
  value,
  onChange,
  allowNone = false,
  help,
}: {
  id: string;
  label: string;
  columns: ColumnChoice[];
  value: number | undefined;
  onChange: (index: number | undefined) => void;
  allowNone?: boolean;
  help?: string;
}) {
  const helpId = help ? `${id}-help` : undefined;
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-slate-700">
        {label}
      </label>
      <select
        id={id}
        aria-describedby={helpId}
        value={value === undefined ? '' : String(value)}
        onChange={(event) => onChange(event.target.value === '' ? undefined : Number(event.target.value))}
        className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
      >
        {allowNone ? <option value="">None</option> : <option value="">Choose a column…</option>}
        {columns.map((column) => (
          <option key={column.index} value={column.index}>
            {column.header || `Column ${column.index + 1}`}
          </option>
        ))}
      </select>
      {help ? (
        <p id={helpId} className="mt-1 text-xs text-slate-500">
          {help}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Parents and children: which rows are children of one parent.
 *
 * The parent question is asked explicitly because there is no safe default.
 * "The first row wins" would make a family's identity depend on how the export
 * happened to be sorted, so the choice is between a column that says so and
 * building a parent from what the children share.
 */
export function FamilyEditor({
  columns,
  value,
  onChange,
}: {
  columns: ColumnChoice[];
  value: FamilyRuleValue | null;
  onChange: (next: FamilyRuleValue | null) => void;
}) {
  const enabled = value !== null;

  const emit = (next: FamilyRuleValue) => onChange(next);

  return (
    <fieldset className="space-y-3" data-testid="family-editor">
      <legend className="text-sm font-bold text-slate-800">Product families</legend>

      <div className="flex items-start gap-2">
        <input
          id="family-enabled"
          type="checkbox"
          checked={enabled}
          onChange={() =>
            onChange(
              enabled
                ? null
                : { groupByColumnIndex: columns[0]?.index ?? 0, optionLabelColumnIndex: columns[0]?.index ?? 0, parentIdentification: 'SYNTHESIZE' },
            )
          }
          className="mt-0.5"
        />
        <label htmlFor="family-enabled" className="text-xs text-slate-700">
          Some rows in this file are child products of the same parent
        </label>
      </div>

      {enabled && value ? (
        <div className="space-y-3 rounded bg-slate-50 p-3">
          <ColumnSelect
            id="family-group"
            label="Rows are children of the same parent when this column matches"
            columns={columns}
            value={value.groupByColumnIndex}
            onChange={(index) => index !== undefined && emit({ ...value, groupByColumnIndex: index })}
          />
          <ColumnSelect
            id="family-option-label"
            label="This column names each child"
            columns={columns}
            value={value.optionLabelColumnIndex}
            onChange={(index) => index !== undefined && emit({ ...value, optionLabelColumnIndex: index })}
            help="For example “Talla M” or “Rojo”. It must be a different column from the one above."
          />

          <fieldset>
            <legend className="text-xs font-medium text-slate-700">Which row is the main product?</legend>
            <div className="mt-1 space-y-1">
              <div className="flex items-start gap-2">
                <input
                  id="parent-explicit"
                  type="radio"
                  name="parent-identification"
                  checked={value.parentIdentification === 'EXPLICIT_COLUMN'}
                  onChange={() => emit({ ...value, parentIdentification: 'EXPLICIT_COLUMN' })}
                  className="mt-0.5"
                />
                <label htmlFor="parent-explicit" className="text-xs text-slate-700">
                  A column in my file marks it
                </label>
              </div>
              <div className="flex items-start gap-2">
                <input
                  id="parent-synthesize"
                  type="radio"
                  name="parent-identification"
                  checked={value.parentIdentification === 'SYNTHESIZE'}
                  onChange={() =>
                    emit({ ...value, parentIdentification: 'SYNTHESIZE', parentFlagColumnIndex: undefined })
                  }
                  className="mt-0.5"
                />
                <label htmlFor="parent-synthesize" className="text-xs text-slate-700">
                  Create the parent product from what the children share
                </label>
              </div>
            </div>
          </fieldset>

          {value.parentIdentification === 'EXPLICIT_COLUMN' ? (
            <ColumnSelect
              id="family-parent-flag"
              label="Column that marks the main product"
              columns={columns}
              value={value.parentFlagColumnIndex}
              onChange={(index) => emit({ ...value, parentFlagColumnIndex: index })}
              allowNone
            />
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}

/** Categories: how a path is written, and whether missing ones may be created. */
export function CategoryEditor({
  columns,
  value,
  onChange,
}: {
  columns: ColumnChoice[];
  value: CategoryRuleValue | null;
  onChange: (next: CategoryRuleValue | null) => void;
}) {
  const enabled = value !== null;

  return (
    <fieldset className="space-y-3" data-testid="category-editor">
      <legend className="text-sm font-bold text-slate-800">Categories</legend>

      <div className="flex items-start gap-2">
        <input
          id="categories-enabled"
          type="checkbox"
          checked={enabled}
          onChange={() =>
            onChange(
              enabled
                ? null
                : // createMissing starts OFF. A person clicking straight
                  // through gets the cautious import.
                  { columnIndex: columns[0]?.index ?? 0, pathSeparator: '>', createMissing: false },
            )
          }
          className="mt-0.5"
        />
        <label htmlFor="categories-enabled" className="text-xs text-slate-700">
          A column in this file holds categories
        </label>
      </div>

      {enabled && value ? (
        <div className="space-y-3 rounded bg-slate-50 p-3">
          <ColumnSelect
            id="category-column"
            label="Category column"
            columns={columns}
            value={value.columnIndex}
            onChange={(index) => index !== undefined && onChange({ ...value, columnIndex: index })}
          />

          <div>
            <label htmlFor="path-separator" className="block text-xs font-medium text-slate-700">
              What separates the levels of a path?
            </label>
            <input
              id="path-separator"
              type="text"
              value={value.pathSeparator}
              onChange={(event) => onChange({ ...value, pathSeparator: event.target.value })}
              aria-describedby="path-separator-help"
              className="mt-1 w-24 rounded border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
            />
            <p id="path-separator-help" className="mt-1 text-xs text-slate-500">
              For example “&gt;” in “Ropa &gt; Camisetas”. Without it the whole cell becomes one category name.
            </p>
          </div>

          <div>
            <label htmlFor="list-separator" className="block text-xs font-medium text-slate-700">
              What separates several categories in one cell?
            </label>
            <input
              id="list-separator"
              type="text"
              value={value.listSeparator ?? ''}
              onChange={(event) => onChange({ ...value, listSeparator: event.target.value || undefined })}
              aria-describedby="list-separator-help"
              className="mt-1 w-24 rounded border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
            />
            <p id="list-separator-help" className="mt-1 text-xs text-slate-500">
              Leave blank if each cell holds one category. It must differ from the level separator.
            </p>
          </div>

          <div className="flex items-start gap-2">
            <input
              id="create-missing"
              type="checkbox"
              checked={value.createMissing}
              onChange={(event) => onChange({ ...value, createMissing: event.target.checked })}
              className="mt-0.5"
            />
            <label htmlFor="create-missing" className="text-xs text-slate-700">
              Create categories that do not exist yet
              <span className="mt-0.5 block text-slate-500">
                Leave this off to import only into categories you already have. A typo in one row would otherwise
                become a permanent category.
              </span>
            </label>
          </div>
        </div>
      ) : null}
    </fieldset>
  );
}

/**
 * Shops: which shops this import touches, and what it leaves alone.
 *
 * The sentence about untouched shops is not reassurance copy — it is the actual
 * behaviour, and it is what stops someone selecting every shop "to be safe".
 */
export function StoreEditor({
  stores,
  value,
  onChange,
}: {
  stores: StoreChoice[];
  value: StoreRuleValue;
  onChange: (next: StoreRuleValue) => void;
}) {
  const toggle = (id: string) => {
    const next = value.storeIds.includes(id)
      ? value.storeIds.filter((s) => s !== id)
      : [...value.storeIds, id];
    onChange({ ...value, storeIds: next });
  };

  return (
    <fieldset className="space-y-2" data-testid="store-editor">
      <legend className="text-sm font-bold text-slate-800">Shops</legend>

      <p className="text-xs text-slate-600">
        By default this import sets company-wide values and changes no shop. Choose a shop only if this file carries
        that shop&rsquo;s own prices or stock.
      </p>

      {stores.length === 0 ? (
        <p className="text-xs text-slate-500">You have no shops available for this import.</p>
      ) : (
        <div className="space-y-1">
          {stores.map((store) => {
            const id = `store-${store.id}`;
            return (
              <div key={store.id} className="flex items-start gap-2">
                <input
                  id={id}
                  type="checkbox"
                  checked={value.storeIds.includes(store.id)}
                  onChange={() => toggle(store.id)}
                  className="mt-0.5"
                />
                <label htmlFor={id} className="text-xs text-slate-700">
                  {store.name}
                </label>
              </div>
            );
          })}
        </div>
      )}

      {value.storeIds.length === 0 ? (
        <p className="text-xs font-medium text-emerald-800" data-testid="stores-untouched">
          No shop will be changed by this import.
        </p>
      ) : (
        <p className="text-xs text-slate-600" data-testid="stores-selected">
          Only the {value.storeIds.length === 1 ? 'shop' : `${value.storeIds.length} shops`} you selected will change.
          Every other shop keeps its current prices, stock and visibility.
        </p>
      )}

      {/* Publication is never a side effect. Said out loud because the legacy
          importer's most damaging surprise was a catalogue going live. */}
      <p className="text-xs text-slate-500">
        Nothing is published by this import unless a column you mapped says so.
      </p>
    </fieldset>
  );
}

export interface LocationChoice {
  id: string;
  name: string;
}

export interface InventoryRuleValue {
  defaultLocationId?: string;
  /** The column holding company-wide damaged units, when the file has one. */
  damagedColumnIndex?: number;
}

/**
 * Where imported stock physically goes.
 *
 * This exists because custody is a DECISION and the only wrong answer is an
 * automatic one. A file saying a company holds forty of something, without
 * saying where they are, has not said enough to write a ledger entry — and
 * choosing on somebody's behalf means a stocktake later finds forty units in a
 * warehouse nobody sent them to.
 *
 * So the import refuses those rows rather than defaulting them, and this is
 * where the person answers instead. Left unanswered, an import that carries no
 * stock column is entirely unaffected: this only matters when a file declares
 * quantities it does not break down by shop.
 */
export function InventoryDestinationEditor({
  locations,
  columns = [],
  value,
  onChange,
}: {
  locations: LocationChoice[];
  /** Source columns, so a damaged count can be pointed at one. */
  columns?: ColumnChoice[];
  value: InventoryRuleValue;
  onChange: (next: InventoryRuleValue) => void;
}) {
  return (
    <fieldset className="space-y-2" data-testid="inventory-destination-editor">
      <legend className="text-sm font-bold text-slate-800">Where the stock is held</legend>

      <p className="text-xs text-slate-600">
        If your file gives a total without saying which shop holds it, choose where those units are. Stock is recorded
        in your inventory, so it has to be somewhere.
      </p>

      {locations.length === 0 ? (
        <p className="text-xs text-slate-500" data-testid="no-locations">
          You have no stock locations set up yet, so stock cannot be imported. Everything else in this file still can.
        </p>
      ) : (
        <>
          <label htmlFor="stock-destination" className="sr-only">
            Where unallocated stock is held
          </label>
          <select
            id="stock-destination"
            value={value.defaultLocationId ?? ''}
            onChange={(event) =>
              onChange(event.target.value === '' ? {} : { defaultLocationId: event.target.value })
            }
            className="rounded border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
          >
            <option value="">Do not import stock</option>
            {locations.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </select>

          {value.defaultLocationId ? (
            <p className="text-xs text-slate-600" data-testid="destination-chosen">
              Units your file does not assign to a shop will be recorded here.
            </p>
          ) : (
            // The honest description of what happens, not a warning. Most
            // imports are about names and prices and want exactly this.
            <p className="text-xs font-medium text-emerald-800" data-testid="destination-none">
              No stock will be changed by this import.
            </p>
          )}

          {value.defaultLocationId && columns.length > 0 ? (
            <div className="pt-1">
              <label htmlFor="damaged-column" className="block text-xs font-medium text-slate-700">
                Which column counts damaged units?
              </label>
              <select
                id="damaged-column"
                value={value.damagedColumnIndex ?? ''}
                onChange={(event) =>
                  onChange({
                    ...value,
                    damagedColumnIndex: event.target.value === '' ? undefined : Number(event.target.value),
                  })
                }
                className="mt-1 rounded border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
              >
                <option value="">None — all stock is in good condition</option>
                {columns.map((column) => (
                  <option key={column.index} value={column.index}>
                    {column.header}
                  </option>
                ))}
              </select>
              {/* Said out loud, because it is the thing people get wrong: a
                  damaged count is PART of the total, not extra. A file saying
                  "40, of which 6 damaged" holds forty things. */}
              <p className="mt-1 text-xs text-slate-500" data-testid="damaged-note">
                Damaged units are counted inside the total, not added to it. They are recorded as not for sale.
              </p>
            </div>
          ) : null}
        </>
      )}
    </fieldset>
  );
}

export interface SpecificationRuleValue {
  columnIndex: number;
  definitionKey: string;
  expectedType: string;
  unit?: string;
}

/** Specifications: binding a column to an activated field definition. */
export function SpecificationEditor({
  columns,
  specifications,
  value,
  onChange,
}: {
  columns: ColumnChoice[];
  specifications: SpecificationChoice[];
  value: SpecificationRuleValue[];
  onChange: (next: SpecificationRuleValue[]) => void;
}) {
  const add = () => {
    const spec = specifications[0];
    if (!spec) return;
    onChange([
      ...value,
      { columnIndex: columns[0]?.index ?? 0, definitionKey: spec.key, expectedType: spec.type, unit: spec.unit ?? undefined },
    ]);
  };

  return (
    <fieldset className="space-y-3" data-testid="specification-editor">
      <legend className="text-sm font-bold text-slate-800">Specifications</legend>

      {specifications.length === 0 ? (
        <p className="text-xs text-slate-500">
          This catalogue has no specifications yet. Create them first to import their values.
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {value.map((rule, index) => {
              const spec = specifications.find((s) => s.key === rule.definitionKey);
              const selectId = `spec-${index}`;
              return (
                <li key={index} className="rounded bg-slate-50 p-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <ColumnSelect
                      id={`spec-column-${index}`}
                      label="Column"
                      columns={columns}
                      value={rule.columnIndex}
                      onChange={(columnIndex) =>
                        columnIndex !== undefined &&
                        onChange(value.map((r, i) => (i === index ? { ...r, columnIndex } : r)))
                      }
                    />
                    <div>
                      <label htmlFor={selectId} className="block text-xs font-medium text-slate-700">
                        Specification
                      </label>
                      <select
                        id={selectId}
                        value={rule.definitionKey}
                        onChange={(event) => {
                          const chosen = specifications.find((s) => s.key === event.target.value);
                          if (!chosen) return;
                          // The type and unit come from the DEFINITION, never
                          // from the person: a mismatch is refused rather than
                          // negotiated, so there is nothing to type here.
                          onChange(
                            value.map((r, i) =>
                              i === index
                                ? { ...r, definitionKey: chosen.key, expectedType: chosen.type, unit: chosen.unit ?? undefined }
                                : r,
                            ),
                          );
                        }}
                        className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                      >
                        {specifications.map((s) => (
                          <option key={s.key} value={s.key}>
                            {s.label}
                            {s.unit ? ` (${s.unit})` : ''}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <p className="mt-1 text-xs text-slate-500">
                    Values must be {spec?.type.toLowerCase() ?? rule.expectedType.toLowerCase()}
                    {spec?.unit ? ` in ${spec.unit}` : ''}. Anything else is reported rather than converted.
                  </p>

                  <button
                    type="button"
                    onClick={() => onChange(value.filter((_, i) => i !== index))}
                    className="mt-2 rounded border border-slate-300 px-2 py-1 text-xs text-rose-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            onClick={add}
            className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
          >
            Add a specification column
          </button>
        </>
      )}
    </fieldset>
  );
}

export interface AssetRuleValue {
  columnIndex: number;
  target: 'GALLERY_IMAGE';
  listSeparator?: string;
}

/** Product images imported directly into each product gallery. */
export function AssetEditor({
  columns,
  value,
  onChange,
}: {
  columns: ColumnChoice[];
  value: AssetRuleValue[];
  onChange: (next: AssetRuleValue[]) => void;
}) {
  return (
    <fieldset className="space-y-3" data-testid="asset-editor">
      <legend className="text-sm font-bold text-slate-800">Product images</legend>

      <p className="text-xs text-slate-600">
        Existing photographs keep their order. This import adds to the gallery rather than rearranging it.
      </p>

      <ul className="space-y-2">
        {value.map((rule, index) => (
          <li key={index} className="rounded bg-slate-50 p-3 space-y-2">
            <ColumnSelect
              id={`asset-column-${index}`}
              label="Column"
              columns={columns}
              value={rule.columnIndex}
              onChange={(columnIndex) =>
                columnIndex !== undefined && onChange(value.map((r, i) => (i === index ? { ...r, columnIndex } : r)))
              }
            />

            <button
              type="button"
              onClick={() => onChange(value.filter((_, i) => i !== index))}
              className="rounded border border-slate-300 px-2 py-1 text-xs text-rose-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={() => onChange([...value, { columnIndex: columns[0]?.index ?? 0, target: 'GALLERY_IMAGE' }])}
        className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
      >
        Add a product image column
      </button>
    </fieldset>
  );
}

export interface RelationRuleValue {
  columnIndex: number;
  type: string;
  matchBy: string;
  listSeparator?: string;
}

const RELATION_TYPES = [
  { value: 'RELATED', label: 'Related products' },
  { value: 'ACCESSORY', label: 'Accessories' },
  { value: 'SIMILAR', label: 'Similar products' },
  { value: 'REPLACEMENT', label: 'Replacements' },
];

const MATCH_BY = [
  { value: 'SKU', label: 'Our SKU' },
  { value: 'MANUFACTURER_CODE', label: 'The manufacturer’s code' },
  { value: 'EXTERNAL_ID', label: 'The id from the other system' },
];

/** Related products: which identifier the cell holds, so the lookup is not a guess. */
export function RelationEditor({
  columns,
  value,
  onChange,
}: {
  columns: ColumnChoice[];
  value: RelationRuleValue[];
  onChange: (next: RelationRuleValue[]) => void;
}) {
  return (
    <fieldset className="space-y-3" data-testid="relation-editor">
      <legend className="text-sm font-bold text-slate-800">Related products</legend>

      <ul className="space-y-2">
        {value.map((rule, index) => (
          <li key={index} className="grid gap-2 rounded bg-slate-50 p-3 sm:grid-cols-3">
            <ColumnSelect
              id={`relation-column-${index}`}
              label="Column"
              columns={columns}
              value={rule.columnIndex}
              onChange={(columnIndex) =>
                columnIndex !== undefined && onChange(value.map((r, i) => (i === index ? { ...r, columnIndex } : r)))
              }
            />
            <div>
              <label htmlFor={`relation-type-${index}`} className="block text-xs font-medium text-slate-700">
                Relationship
              </label>
              <select
                id={`relation-type-${index}`}
                value={rule.type}
                onChange={(event) =>
                  onChange(value.map((r, i) => (i === index ? { ...r, type: event.target.value } : r)))
                }
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
              >
                {RELATION_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor={`relation-match-${index}`} className="block text-xs font-medium text-slate-700">
                The column holds
              </label>
              <select
                id={`relation-match-${index}`}
                value={rule.matchBy}
                onChange={(event) =>
                  onChange(value.map((r, i) => (i === index ? { ...r, matchBy: event.target.value } : r)))
                }
                className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
              >
                {MATCH_BY.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={() => onChange([...value, { columnIndex: columns[0]?.index ?? 0, type: 'RELATED', matchBy: 'SKU' }])}
        className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
      >
        Add a related-products column
      </button>
    </fieldset>
  );
}

export interface LocalizationRuleValue {
  columnIndex: number;
  locale: string;
  field: string;
}

const TRANSLATABLE_FIELDS = [
  { value: 'name', label: 'Name' },
  { value: 'description', label: 'Description' },
  { value: 'metaTitle', label: 'Page title' },
  { value: 'metaDescription', label: 'Page description' },
];

/** Translations: a column holding one field in one language. */
export function LocalizationEditor({
  columns,
  locales,
  defaultLocale,
  value,
  onChange,
}: {
  columns: ColumnChoice[];
  locales: string[];
  defaultLocale: string;
  value: LocalizationRuleValue[];
  onChange: (next: LocalizationRuleValue[]) => void;
}) {
  const others = locales.filter((l) => l !== defaultLocale);

  return (
    <fieldset className="space-y-3" data-testid="localization-editor">
      <legend className="text-sm font-bold text-slate-800">Translations</legend>

      <p className="text-xs text-slate-600">
        Columns mapped to a field above are stored in {defaultLocale}, this catalogue&rsquo;s main language. Use this
        only for columns holding another language.
      </p>

      {others.length === 0 ? (
        <p className="text-xs text-slate-500">This catalogue uses only {defaultLocale}.</p>
      ) : (
        <>
          <ul className="space-y-2">
            {value.map((rule, index) => (
              <li key={index} className="grid gap-2 rounded bg-slate-50 p-3 sm:grid-cols-3">
                <ColumnSelect
                  id={`locale-column-${index}`}
                  label="Column"
                  columns={columns}
                  value={rule.columnIndex}
                  onChange={(columnIndex) =>
                    columnIndex !== undefined &&
                    onChange(value.map((r, i) => (i === index ? { ...r, columnIndex } : r)))
                  }
                />
                <div>
                  <label htmlFor={`locale-lang-${index}`} className="block text-xs font-medium text-slate-700">
                    Language
                  </label>
                  <select
                    id={`locale-lang-${index}`}
                    value={rule.locale}
                    onChange={(event) =>
                      onChange(value.map((r, i) => (i === index ? { ...r, locale: event.target.value } : r)))
                    }
                    className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                  >
                    {others.map((locale) => (
                      <option key={locale} value={locale}>
                        {locale}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor={`locale-field-${index}`} className="block text-xs font-medium text-slate-700">
                    Field
                  </label>
                  <select
                    id={`locale-field-${index}`}
                    value={rule.field}
                    onChange={(event) =>
                      onChange(value.map((r, i) => (i === index ? { ...r, field: event.target.value } : r)))
                    }
                    className="mt-1 w-full rounded border border-slate-300 px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                  >
                    {TRANSLATABLE_FIELDS.map((f) => (
                      <option key={f.value} value={f.value}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>
              </li>
            ))}
          </ul>

          <button
            type="button"
            onClick={() =>
              onChange([...value, { columnIndex: columns[0]?.index ?? 0, locale: others[0], field: 'name' }])
            }
            className="rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
          >
            Add a translated column
          </button>
        </>
      )}
    </fieldset>
  );
}

/** All of them, in the order somebody works through them. */
export function RelationshipEditors({ children }: { children: React.ReactNode }) {
  return (
    <div className={cn('space-y-6')} data-testid="relationship-editors">
      {children}
    </div>
  );
}
