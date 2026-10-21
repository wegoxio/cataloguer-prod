import type { RelationshipOptions } from '../api/lifecycle.service';
import type { RelationshipDecisions, RelationshipQuestions } from './relationships-step';

/**
 * Whether this import can proceed to a plan, and if not, exactly what is missing.
 *
 * This replaces a boolean. The boolean said only "not yet", and rendered a
 * sentence — "Answer the questions above to build the plan" — beside a form
 * whose every visible control had been answered. It was true and useless, and
 * an operator sat in front of it with no way to discover that a second
 * confirmation checkbox, below the fold, was the thing standing in the way.
 *
 * Two rules follow from that, and they are the point of this module:
 *
 *  1. **Every refusal names its cause and points at it.** A missing requirement
 *     carries the id of the section that satisfies it, so the UI can move focus
 *     there rather than leaving somebody to hunt.
 *  2. **Choosing IS confirming.** There is no separate "yes I meant it" tick.
 *     Selecting a destination, or editing an allocation, is itself the decision;
 *     asking twice taught people that the first control did not count.
 *
 * The states are distinct on purpose. "Still loading", "the request failed",
 * "loaded and this company has nowhere to put stock", and "loaded but you have
 * not chosen yet" need four different sentences and lead to four different
 * actions. Collapsing them is what produced the original dead end.
 */

export type ProgressionState =
  | { kind: 'LOADING' }
  | { kind: 'FAILED' }
  /** Loaded successfully, but the company has no option that would satisfy a requirement. */
  | { kind: 'UNAVAILABLE'; requirement: MissingRequirement }
  | { kind: 'INCOMPLETE'; missing: MissingRequirement[] }
  | { kind: 'READY' };

export interface MissingRequirement {
  /** Stable id; also the DOM id of the section that satisfies it. */
  id: 'stock' | 'stores' | 'categories';
  /** What is missing, in the operator's words, not the model's. */
  label: string;
  /** Why it blocks, when that is not obvious from the label. */
  detail?: string;
}

export interface ProgressionInput {
  optionsState: 'LOADING' | 'FAILED' | 'READY';
  questions: RelationshipQuestions;
  options: RelationshipOptions | null;
  decisions: RelationshipDecisions;
}

/** The DOM id a section must carry to be reachable from its requirement. */
export const sectionDomId = (id: MissingRequirement['id']): string => `relationship-section-${id}`;

export function evaluateProgression(input: ProgressionInput): ProgressionState {
  const { optionsState, questions, options, decisions } = input;

  if (optionsState === 'LOADING') return { kind: 'LOADING' };
  if (optionsState === 'FAILED') return { kind: 'FAILED' };

  const missing: MissingRequirement[] = [];

  // ---- stock custody -------------------------------------------------------
  if (questions.needsStockDestination) {
    const destinations = options?.stockDestinations ?? [];
    if (destinations.length === 0) {
      // Loaded, and genuinely empty. This is a configuration task, not a
      // failure and not something the operator can answer here — which is why
      // it is its own state rather than another unanswered question.
      return {
        kind: 'UNAVAILABLE',
        requirement: {
          id: 'stock',
          label: 'This company has no stock locations yet.',
          detail:
            'An inventory location must be created before stock can be imported. You can still import this file without stock by removing the stock column from the mapping.',
        },
      };
    }
    if (!hasStockDecision(decisions)) {
      missing.push({
        id: 'stock',
        label: 'Choose where the physical stock is held.',
        detail: 'This file has a stock column, so every unit needs somewhere to live.',
      });
    }
  }

  // ---- store listing -------------------------------------------------------
  // This import is scoped to one shop, so the only question is whether these
  // products are listed in it. Undecided and "deliberately not" are different
  // answers and only the first one blocks: a suggestion is never accepted on
  // the operator's behalf, so an untouched control is undecided, not "no".
  //
  // Asked only when there is a shop to answer about. An import with no scoped
  // shop cannot list anything, and demanding a decision somebody has no control
  // to make would be the same dead end as the empty-locations case.
  const scopedStore = (options?.stores ?? []).some((store) => store.id === options?.storeId);
  //
  // Gated on the import TYPE as well as on a scoped shop, from the same
  // contract the rendered questions use. Readiness demanding an answer the step
  // no longer asks for is a dead end; readiness demanding one it should never
  // have asked for is how a Products question came to gate a historical-sales
  // import.
  if (questions.needsStoreListing && scopedStore && decisions.stores === undefined) {
    missing.push({
      id: 'stores',
      label: 'Decide whether these products are listed in this shop.',
      detail: 'List them here, or choose not to list them anywhere.',
    });
  }

  // ---- categories ----------------------------------------------------------
  if (questions.categoryColumnIndex !== null && decisions.categories === undefined) {
    missing.push({
      id: 'categories',
      label: `Decide how the “${questions.categoryHeader ?? 'category'}” column is used.`,
      detail: 'Accept it as category paths, or choose to ignore the column.',
    });
  }

  return missing.length > 0 ? { kind: 'INCOMPLETE', missing } : { kind: 'READY' };
}

/**
 * Stock is decided when somewhere has been named for it.
 *
 * One destination, which is what this wizard sends and what the server accepts.
 * Splitting stock across several locations is real and wanted, but it is not
 * built end to end yet, so it is not offered here — a control that produced a
 * plan the executor could not run would be worse than its absence.
 */
function hasStockDecision(decisions: RelationshipDecisions): boolean {
  return Boolean(decisions.inventory?.defaultLocationId);
}

/** True when a plan may be built. The single question the wizard asks. */
export const canBuildPlan = (state: ProgressionState): boolean => state.kind === 'READY';
