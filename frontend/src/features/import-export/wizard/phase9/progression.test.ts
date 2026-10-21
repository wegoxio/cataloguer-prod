import { describe, expect, it } from 'vitest';
import { evaluateProgression, canBuildPlan, sectionDomId } from './progression';
import type { RelationshipQuestions } from './relationships-step';
import type { RelationshipOptions } from '../api/lifecycle.service';

/**
 * The wizard must never again say "answer the questions above" beside a form
 * whose every visible control has been answered.
 */

const questions = (over: Partial<RelationshipQuestions> = {}): RelationshipQuestions => ({
  needsStockDestination: false,
  needsStoreListing: true,
  categoryColumnIndex: null,
  categoryHeader: null,
  detectedPaths: [],
  ...over,
});

const options = (over: Partial<RelationshipOptions> = {}): RelationshipOptions =>
  ({
    storeId: 's1',
    stores: [{ id: 's1', name: 'Store B' }],
    stockDestinations: [{ id: 'l1', name: 'Store B custody', kind: 'STORE', proposed: true }],
    existingCategoryNames: [],
    ...over,
  }) as RelationshipOptions;

describe('the four states that are not "ready"', () => {
  it('reports loading while the options are still in flight', () => {
    expect(evaluateProgression({ optionsState: 'LOADING', questions: questions(), options: null, decisions: {} }))
      .toEqual({ kind: 'LOADING' });
  });

  it('stays fail-closed when the options could not be loaded', () => {
    expect(evaluateProgression({ optionsState: 'FAILED', questions: questions(), options: null, decisions: {} }))
      .toEqual({ kind: 'FAILED' });
  });

  it('separates "no locations exist" from "you have not chosen one"', () => {
    // The dead end: a stock column with an empty authorized set used to render
    // an unanswerable question and a generic refusal for ever.
    const state = evaluateProgression({
      optionsState: 'READY',
      questions: questions({ needsStockDestination: true }),
      options: options({ stockDestinations: [] }),
      decisions: { stores: { storeIds: [] } },
    });
    expect(state.kind).toBe('UNAVAILABLE');
    expect(state.kind === 'UNAVAILABLE' && state.requirement.label).toContain('no stock locations');
    expect(state.kind === 'UNAVAILABLE' && state.requirement.detail).toContain('removing the stock column');
  });

  it('names the specific missing decision rather than a generic sentence', () => {
    const state = evaluateProgression({
      optionsState: 'READY',
      questions: questions({ needsStockDestination: true }),
      options: options(),
      decisions: { stores: { storeIds: ['s1'] } },
    });
    expect(state.kind).toBe('INCOMPLETE');
    expect(state.kind === 'INCOMPLETE' && state.missing.map((m) => m.id)).toEqual(['stock']);
    expect(state.kind === 'INCOMPLETE' && state.missing[0].label).toContain('where the physical stock is held');
  });

  it('gives every missing requirement a section to move focus to', () => {
    const state = evaluateProgression({
      optionsState: 'READY',
      questions: questions({ needsStockDestination: true, categoryColumnIndex: 6, categoryHeader: 'categories' }),
      options: options(),
      decisions: {},
    });
    expect(state.kind).toBe('INCOMPLETE');
    const ids = state.kind === 'INCOMPLETE' ? state.missing.map((m) => m.id) : [];
    expect(ids).toEqual(['stock', 'stores', 'categories']);
    for (const id of ids) expect(sectionDomId(id)).toBe(`relationship-section-${id}`);
  });
});

describe('what counts as answered', () => {
  it('treats choosing a destination as the confirmation', () => {
    // No second checkbox. Selecting IS confirming - asking twice is what taught
    // people the first control did not count.
    const state = evaluateProgression({
      optionsState: 'READY',
      questions: questions({ needsStockDestination: true }),
      options: options(),
      decisions: { inventory: { defaultLocationId: 'l1' }, stores: { storeIds: ['s1'] } },
    });
    expect(state).toEqual({ kind: 'READY' });
    expect(canBuildPlan(state)).toBe(true);
  });


  it('separates "listed nowhere" from "not decided yet"', () => {
    const undecided = evaluateProgression({
      optionsState: 'READY', questions: questions(), options: options(), decisions: {},
    });
    expect(undecided.kind).toBe('INCOMPLETE');

    const deliberatelyNone = evaluateProgression({
      optionsState: 'READY', questions: questions(), options: options(), decisions: { stores: { storeIds: [] } },
    });
    expect(deliberatelyNone).toEqual({ kind: 'READY' });
  });

  it('requires the category column to be accepted or explicitly ignored', () => {
    const state = evaluateProgression({
      optionsState: 'READY',
      questions: questions({ categoryColumnIndex: 6, categoryHeader: 'categories' }),
      options: options(),
      decisions: { stores: { storeIds: [] } },
    });
    expect(state.kind).toBe('INCOMPLETE');
    expect(state.kind === 'INCOMPLETE' && state.missing[0].label).toContain('categories');
  });

  it('is ready when nothing is outstanding', () => {
    expect(
      evaluateProgression({
        optionsState: 'READY',
        questions: questions({ needsStockDestination: true, categoryColumnIndex: 6, categoryHeader: 'categories' }),
        options: options(),
        decisions: {
          inventory: { defaultLocationId: 'l1' },
          stores: { storeIds: ['s1'] },
          categories: { columnIndex: 6, pathSeparator: '>', createMissing: true },
        },
      }),
    ).toEqual({ kind: 'READY' });
  });
});
