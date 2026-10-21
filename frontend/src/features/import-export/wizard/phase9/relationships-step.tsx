'use client';

import React from 'react';
import { mayCollect } from './relationship-contract';
import type { RelationshipOptions, StockDestination } from '../api/lifecycle.service';
// Runtime import in one direction only; progression's use of this file is
// type-only and erases at compile time, so there is no cycle at run time.
import { sectionDomId } from './progression';

/**
 * The decisions a mapping cannot make for you.
 *
 * Mapping says which column means "stock". It does not say WHERE that stock is
 * held, whether these products should be listed in the shop the import is
 * scoped to, or whether a text column may create categories. Those are three
 * separate decisions about somebody's catalogue, and this step is where they
 * are made.
 *
 * They were never asked before. The request carried a `relationships` object
 * that the wizard threaded through and never populated, so the compiler
 * received nothing: positive-stock rows were blocked at execution for want of a
 * destination, and the store pivot and category were silently never created —
 * a row reported as CREATED while doing less than the operator expected.
 *
 * Three rules shape this screen.
 *
 * Each decision is confirmed SEPARATELY. They have different consequences —
 * one moves stock, one changes what a shop lists, one can create catalogue
 * structure — and a single "looks right" checkbox over all three is how people
 * agree to things they did not read.
 *
 * Nothing is pre-confirmed. The scoped shop's custody is PROPOSED, visibly, and
 * still has to be chosen. A proposal that arrives already accepted is an
 * inference wearing a checkbox.
 *
 * Nothing here is a list this file knows. Destinations, shops and existing
 * categories all arrive from the server, scoped to the caller's own
 * organization.
 */

export interface RelationshipDecisions {
  inventory?: {
    /**
     * Where this file's stock is held.
     *
     * One place. Splitting a row's stock across several locations is a real
     * requirement and is not built end to end yet, so it is not offered here —
     * a control producing a plan the executor could not run would be worse than
     * its absence.
     */
    defaultLocationId?: string;
  };
  /**
   * Whether these products are listed in the shop this import is scoped to.
   *
   * `undefined` means undecided and blocks the plan. An empty array is a real
   * answer — "list them nowhere" — and does not. A suggestion is never written
   * here on the operator's behalf.
   */
  stores?: { storeIds: string[] };
  categories?: { columnIndex: number; pathSeparator: string; createMissing: boolean };
}

/** What the mapping implies this step must ask about. */
export interface RelationshipQuestions {
  /** A stock column is mapped, so custody must be decided. */
  needsStockDestination: boolean;
  /**
   * Whether to ask about listing these products in the scoped shop.
   *
   * Gated on the import TYPE, not merely on a shop being scoped. Historical
   * sales must name a shop — that is `plan.storeId`, the scope the records
   * belong to — and being asked to list products in it was a Products question
   * put to a file about things already sold.
   */
  needsStoreListing: boolean;
  /** The column mapped to category paths, when there is one. */
  categoryColumnIndex: number | null;
  categoryHeader: string | null;
  /** Distinct category paths seen in the sample. */
  detectedPaths: string[];
}

const PATH_SEPARATOR = '>';

/** What the mapping and the sample say this step has to ask. */
export function questionsFor(
  columns: { columnIndex: number; header: string; field: string | null }[],
  rows: string[][],
  /**
   * The import type, which decides whether these questions apply at all.
   *
   * Defaulted to PRODUCTS so an omitted argument keeps the old behaviour rather
   * than silently asking nothing — a caller that forgot it should ask too much,
   * not too little. Every real caller passes it.
   */
  importType: string = 'PRODUCTS',
): RelationshipQuestions {
  // Nothing is asked of a type with no catalogue to arrange. A file recording
  // things already sold has no product to list, no category to file it under
  // and no stock to place.
  const needsStockDestination = mayCollect(importType, 'inventory') && columns.some((c) => c.field === 'stock');
  const category = mayCollect(importType, 'categories')
    ? columns.find((c) => c.field === 'categoryPaths' || c.field === 'category')
    : undefined;

  const paths: string[] = [];
  if (category) {
    for (const row of rows) {
      const cell = (row[category.columnIndex] ?? '').trim();
      if (!cell) continue;
      for (const piece of cell.split(',')) {
        const path = piece.trim();
        if (path && !paths.includes(path)) paths.push(path);
      }
    }
  }

  return {
    needsStockDestination,
    needsStoreListing: mayCollect(importType, 'stores'),
    categoryColumnIndex: category ? category.columnIndex : null,
    categoryHeader: category ? category.header : null,
    detectedPaths: paths,
  };
}

/** Every question this step asked has an answer. */
export function isComplete(
  questions: RelationshipQuestions,
  confirmed: { stock: boolean; stores: boolean; categories: boolean },
): boolean {
  if (questions.needsStockDestination && !confirmed.stock) return false;
  if (questions.categoryColumnIndex !== null && !confirmed.categories) return false;
  // Store association is asked whenever the import is scoped to a shop; the
  // caller confirms it or the products are simply not listed there.
  return true;
}

/**
 * Where products are listed, and where their stock physically is.
 *
 * These are grouped on screen and kept apart in the data, because they are not
 * the same question and conflating them is how a product ends up on sale in a
 * shop that holds none of it. A listing is commercial; an allocation is
 * physical. One product can be listed in three shops while all of its stock
 * sits in a warehouse.
 *
 * Nothing here is confirmed twice. Selecting a shop, or editing an allocation,
 * IS the decision — an earlier version asked for a selection and then a
 * separate tick that meant the same thing, which taught operators that the
 * first control did not count and left the plan permanently unbuildable when
 * the tick scrolled out of view.
 */
/**
 * Where the stock is held, and whether these products are listed in this shop.
 *
 * Nothing is confirmed twice. Selecting a destination, or ticking a shop, IS the
 * decision — an earlier version asked for a selection and then a separate tick
 * meaning the same thing, which taught operators that the first control did not
 * count and left the plan permanently unbuildable when the tick scrolled out of
 * view.
 *
 * One destination and one shop, because that is what the server accepts today.
 * Splitting stock across several locations, and listing in several shops, are
 * both wanted and both partly built; offering either here would produce a plan
 * the executor could not run.
 */
export function RelationshipsStep({
  questions,
  options,
  storeId,
  value,
  onChange,
}: {
  questions: RelationshipQuestions;
  options: RelationshipOptions | null;
  storeId: string | null;
  value: RelationshipDecisions;
  onChange: (next: RelationshipDecisions) => void;
}) {
  const destinations = options?.stockDestinations ?? [];
  const chosenId = value.inventory?.defaultLocationId ?? null;
  const scopedStore = options?.stores.find((s) => s.id === storeId) ?? null;
  const listed = (value.stores?.storeIds ?? []).includes(storeId ?? '');
  const decided = value.stores !== undefined;

  const existing = new Set((options?.existingCategoryNames ?? []).map((n) => n.toLowerCase()));
  const newPaths = questions.detectedPaths.filter((p) => !existing.has(p.toLowerCase()));
  const knownPaths = questions.detectedPaths.filter((p) => existing.has(p.toLowerCase()));

  return (
    <div className="space-y-4" data-testid="relationships-step">
      <div>
        <h3 className="text-sm font-bold text-slate-800">Before we build the plan</h3>
        <p className="mt-1 text-xs text-slate-600">
          These decisions are not in your file, so we ask them here. Nothing is applied until you review and approve
          the plan.
        </p>
      </div>

      {/* ---- where the stock is held --------------------------------------- */}
      {questions.needsStockDestination ? (
        <section
          id={sectionDomId('stock')}
          tabIndex={-1}
          className="card space-y-3 bg-white p-4"
          data-testid="section-stock"
          aria-labelledby="stock-heading"
        >
          <h4 id="stock-heading" className="text-xs font-bold text-slate-800">
            Where is the physical stock held?
          </h4>

          {destinations.length === 0 ? (
            <p role="alert" className="text-xs text-amber-800" data-testid="no-destinations">
              This company has no stock locations yet. An inventory location must be created before stock can be
              imported. You can still import this file without stock by removing the stock column from the mapping.
            </p>
          ) : (
            <>
              <p className="text-xs text-slate-600">
                This file has a stock column, so every unit needs somewhere to live. Rows with zero create no
                movement.
              </p>
              <fieldset className="space-y-1">
                <legend className="sr-only">Stock destination</legend>
                {destinations.map((d: StockDestination) => (
                  <label key={d.id} className="flex items-start gap-2 text-xs text-slate-700">
                    <input
                      type="radio"
                      name="stock-destination"
                      checked={chosenId === d.id}
                      onChange={() => onChange({ ...value, inventory: { defaultLocationId: d.id } })}
                      className="mt-0.5"
                      data-testid={`destination-${d.id}`}
                    />
                    <span>
                      <span className="font-medium">{d.name}</span>{' '}
                      <span className="text-slate-500">({d.kind === 'WAREHOUSE' ? 'warehouse' : 'shop custody'})</span>
                      {d.proposed ? (
                        <span className="ml-1 rounded bg-sky-100 px-1 text-[10px] text-sky-800">suggested</span>
                      ) : null}
                    </span>
                  </label>
                ))}
              </fieldset>
              <p className="text-[11px] text-slate-500" data-testid="destination-note">
                {chosenId
                  ? 'Choosing a destination is the decision — there is nothing else to confirm.'
                  : 'A suggestion is only a suggestion. Choose where the stock is held to continue.'}
              </p>
            </>
          )}
        </section>
      ) : null}

      {/* ---- listing in this shop ------------------------------------------ */}
      {questions.needsStoreListing && storeId ? (
        <section
          id={sectionDomId('stores')}
          tabIndex={-1}
          className="card space-y-3 bg-white p-4"
          data-testid="section-stores"
          aria-labelledby="stores-heading"
        >
          <h4 id="stores-heading" className="text-xs font-bold text-slate-800">
            Should these products be listed in this shop?
          </h4>
          <p className="text-xs text-slate-600">
            Listing a product in {scopedStore ? <span className="font-medium">{scopedStore.name}</span> : 'this shop'}{' '}
            adds it to that shop&rsquo;s catalogue as an{' '}
            <span className="font-medium">unpublished draft</span>. It is not visible to customers until you publish
            it separately.
          </p>
          <fieldset className="space-y-1">
            <legend className="sr-only">Whether to list these products in this shop</legend>
            <label className="flex items-start gap-2 text-xs text-slate-800">
              <input
                type="radio"
                name="store-listing"
                checked={decided && listed}
                onChange={() => onChange({ ...value, stores: { storeIds: [storeId] } })}
                className="mt-0.5"
                data-testid="list-here"
              />
              <span>List them in {scopedStore?.name ?? 'this shop'}, unpublished.</span>
            </label>
            <label className="flex items-start gap-2 text-xs text-slate-800">
              <input
                type="radio"
                name="store-listing"
                checked={decided && !listed}
                onChange={() => onChange({ ...value, stores: { storeIds: [] } })}
                className="mt-0.5"
                data-testid="list-nowhere"
              />
              <span>Don&rsquo;t list them anywhere — create them for the company only.</span>
            </label>
          </fieldset>
        </section>
      ) : null}

      {/* ---- categories ---------------------------------------------------- */}
      {questions.categoryColumnIndex !== null ? (
        <section
          id={sectionDomId('categories')}
          tabIndex={-1}
          className="card space-y-3 bg-white p-4"
          data-testid="section-categories"
          aria-labelledby="categories-heading"
        >
          <h4 id="categories-heading" className="text-xs font-bold text-slate-800">
            Use &ldquo;{questions.categoryHeader}&rdquo; as categories?
          </h4>

          {questions.detectedPaths.length === 0 ? (
            <p className="text-xs text-slate-600">That column is empty in everything we read. Nothing would change.</p>
          ) : (
            <>
              <p className="text-xs text-slate-600">
                We read {questions.detectedPaths.length} category
                {questions.detectedPaths.length === 1 ? ' path' : ' paths'} in this column, separated by{' '}
                <code className="rounded bg-slate-100 px-1">{PATH_SEPARATOR}</code>.
              </p>
              {knownPaths.length ? (
                <p className="text-xs text-slate-600" data-testid="categories-existing">
                  <span className="font-medium">Will be reused:</span> {knownPaths.join(', ')}
                </p>
              ) : null}
              {newPaths.length ? (
                <p className="text-xs text-amber-800" data-testid="categories-new">
                  <span className="font-medium">Will be created:</span> {newPaths.join(', ')}
                </p>
              ) : null}
            </>
          )}

          <fieldset className="space-y-1">
            <legend className="sr-only">How to treat the category column</legend>
            <label className="flex items-start gap-2 text-xs text-slate-800">
              <input
                type="radio"
                name="category-decision"
                checked={value.categories !== undefined}
                onChange={() =>
                  onChange({
                    ...value,
                    categories: {
                      columnIndex: questions.categoryColumnIndex as number,
                      pathSeparator: PATH_SEPARATOR,
                      createMissing: newPaths.length > 0,
                    },
                  })
                }
                className="mt-0.5"
                data-testid="categories-accept"
              />
              <span>
                {newPaths.length
                  ? `Assign these categories, creating the ${newPaths.length} that do not exist yet.`
                  : 'Assign these categories.'}
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs text-slate-800">
              <input
                type="radio"
                name="category-decision"
                checked={value.categories === undefined}
                onChange={() => onChange({ ...value, categories: undefined })}
                className="mt-0.5"
                data-testid="categories-ignore"
              />
              <span>Ignore this column. No category is created or assigned.</span>
            </label>
          </fieldset>
        </section>
      ) : null}
    </div>
  );
}
