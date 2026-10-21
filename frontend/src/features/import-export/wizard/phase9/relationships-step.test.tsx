import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderComponent, click, cleanupAll } from '../../../../test/render';
import { RelationshipsStep, questionsFor } from './relationships-step';
import type { RelationshipDecisions } from './relationships-step';
import type { RelationshipOptions } from '../api/lifecycle.service';

/**
 * The decisions a mapping cannot make, asked once each.
 *
 * Nothing is confirmed twice. An earlier version asked for a selection and then
 * a separate tick meaning the same thing, which taught operators that the first
 * control did not count - and left the plan permanently unbuildable when that
 * tick scrolled out of view.
 */

const STORE_B = 'store-b';
const CUSTODY = 'loc-store-b';
const WAREHOUSE = 'loc-warehouse';

const options: RelationshipOptions = {
  storeId: STORE_B,
  stores: [{ id: STORE_B, name: 'Store B' }],
  stockDestinations: [
    { id: CUSTODY, name: 'Store B custody', kind: 'STORE', proposed: true },
    { id: WAREHOUSE, name: 'Main warehouse', kind: 'WAREHOUSE', proposed: false },
  ],
  existingCategoryNames: ['Ropa'],
} as RelationshipOptions;

const columns = [
  { columnIndex: 0, header: 'sku', field: 'sku' },
  { columnIndex: 5, header: 'stock', field: 'stock' },
  { columnIndex: 6, header: 'categories', field: 'categoryPaths' },
];
// Positional: the mapping addresses columns by index, so the category column
// has to actually be at index 6.
const rows = [
  ['P9ACC-001', '', '', '', '', '5', 'Ropa'],
  ['P9ACC-002', '', '', '', '', '3', 'Aceptacion P9'],
];

const mount = async (value: RelationshipDecisions = {}, onChange = vi.fn()) => {
  const view = await renderComponent(
    <RelationshipsStep
      questions={questionsFor(columns, rows)}
      options={options}
      storeId={STORE_B}
      value={value}
      onChange={onChange}
    />,
  );
  return { view, onChange };
};

afterEach(() => cleanupAll());

describe('where the stock is held', () => {
  it('offers every destination the server returned', async () => {
    const { view } = await mount();
    expect(view.find(`destination-${CUSTODY}`)).not.toBeNull();
    expect(view.find(`destination-${WAREHOUSE}`)).not.toBeNull();
  });

  it('marks the suggestion without selecting it', async () => {
    const { view } = await mount();
    expect(view.get('section-stock').textContent).toContain('suggested');
    // A suggestion applied on somebody behalf is not a decision they made.
    expect((view.get(`destination-${CUSTODY}`) as HTMLInputElement).checked).toBe(false);
  });

  it('treats choosing as confirming', async () => {
    const { view, onChange } = await mount();
    await click(view.get(`destination-${WAREHOUSE}`));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ inventory: { defaultLocationId: WAREHOUSE } }),
    );
  });

  it('says there is nothing further to confirm once chosen', async () => {
    const { view } = await mount({ inventory: { defaultLocationId: WAREHOUSE } });
    expect(view.get('destination-note').textContent).toContain('nothing else to confirm');
  });

  it('asks for a choice while none is made', async () => {
    const { view } = await mount();
    expect(view.get('destination-note').textContent).toContain('only a suggestion');
  });

  it('explains a company with no locations rather than blocking silently', async () => {
    const view = await renderComponent(
      <RelationshipsStep
        questions={questionsFor(columns, rows)}
        options={{ ...options, stockDestinations: [] }}
        storeId={STORE_B}
        value={{}}
        onChange={vi.fn()}
      />,
    );
    expect(view.get('no-destinations').textContent).toContain('no stock locations yet');
  });
});

describe('listing in this shop', () => {
  it('says plainly that a listing arrives unpublished', async () => {
    const { view } = await mount();
    const text = view.get('section-stores').textContent ?? '';
    expect(text).toContain('unpublished draft');
    expect(text).toContain('not visible to customers');
  });

  it('records listing here as one click', async () => {
    const { view, onChange } = await mount();
    await click(view.get('list-here'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ stores: { storeIds: [STORE_B] } }));
  });

  it('separates "list nowhere" from "not decided"', async () => {
    // An explicit empty list is an answer. undefined would not be.
    const { view, onChange } = await mount();
    await click(view.get('list-nowhere'));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ stores: { storeIds: [] } }));
  });

  it('starts with neither option chosen', async () => {
    const { view } = await mount();
    expect((view.get('list-here') as HTMLInputElement).checked).toBe(false);
    expect((view.get('list-nowhere') as HTMLInputElement).checked).toBe(false);
  });
});

describe('categories', () => {
  it('separates what would be created from what would be reused', async () => {
    const { view } = await mount();
    expect(view.get('categories-existing').textContent).toContain('Ropa');
    expect(view.get('categories-new').textContent).toContain('Aceptacion P9');
  });

  it('requires an explicit choice rather than a lone tick', async () => {
    const { view } = await mount();
    expect(view.find('categories-accept')).not.toBeNull();
    expect(view.find('categories-ignore')).not.toBeNull();
  });

  it('records acceptance with the column and separator it will use', async () => {
    const { view, onChange } = await mount();
    await click(view.get('categories-accept'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ categories: { columnIndex: 6, pathSeparator: '>', createMissing: true } }),
    );
  });
});

describe('reachability', () => {
  it('gives every section the id its missing-requirement points at', async () => {
    await mount();
    for (const id of ['stores', 'stock', 'categories']) {
      expect(document.getElementById(`relationship-section-${id}`)).not.toBeNull();
    }
  });

  it('makes each section focusable so a requirement can move focus to it', async () => {
    await mount();
    for (const id of ['stores', 'stock', 'categories']) {
      expect(document.getElementById(`relationship-section-${id}`)?.getAttribute('tabindex')).toBe('-1');
    }
  });
});

describe('what this release deliberately does not offer', () => {
  it('has no multi-store selection', async () => {
    // Approved store sets are not yet indivisible at execution, so offering a
    // multi-select would let an approved [A, B] silently become [A].
    const { view } = await mount();
    expect(view.find('list-in-store-a')).toBeNull();
    expect(view.get('section-stores').textContent).not.toContain('shops');
  });

  it('has no percentage or split allocation', async () => {
    // Nothing on this path turns a split into per-row placements, so a split
    // control would produce a plan the executor cannot run.
    const { view } = await mount();
    const text = view.get('section-stock').textContent ?? '';
    expect(text).not.toContain('%');
    expect(text).not.toContain('Allocated');
  });
});
