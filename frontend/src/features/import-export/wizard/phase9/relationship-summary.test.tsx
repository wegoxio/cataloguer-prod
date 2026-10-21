import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../../test/render';
import { RelationshipSummary } from './relationship-summary';
import type { RelationshipOptions } from '../api/lifecycle.service';

/**
 * What the approver is actually attesting to.
 *
 * The approval binds a plan hash, and the relationship decisions are inside it
 * — so somebody approving is attesting to a custody location, a shop listing
 * and a category rule whether or not they can see them. They could not: the
 * decisions were made two steps earlier and never restated.
 */

const options: RelationshipOptions = {
  storeId: 'store-1',
  stockDestinations: [
    { id: 'loc-1', name: 'Branch custody', kind: 'STORE', storeId: 'store-1', isDefault: false, proposed: true },
    { id: 'loc-2', name: 'Main warehouse', kind: 'WAREHOUSE', storeId: null, isDefault: true, proposed: false },
  ],
  stores: [{ id: 'store-1', name: 'The Branch' }],
  existingCategoryNames: [],
};

afterEach(cleanupAll);

describe('the summary beside the approval', () => {
  it('names the destination rather than showing an id', async () => {
    const { get } = await renderComponent(
      <RelationshipSummary decisions={{ inventory: { defaultLocationId: 'loc-1' } }} options={options} />,
    );
    const text = get('summary-stock').textContent ?? '';
    expect(text).toContain('Branch custody');
    expect(text).toContain('shop custody');
    expect(text).not.toContain('loc-1');
  });

  it('repeats that only positive quantities move stock', async () => {
    const { get } = await renderComponent(
      <RelationshipSummary decisions={{ inventory: { defaultLocationId: 'loc-2' } }} options={options} />,
    );
    expect(get('summary-stock').textContent).toContain('Only rows with a positive quantity');
  });

  it('says plainly when no stock moves at all', async () => {
    const { get } = await renderComponent(<RelationshipSummary decisions={{}} options={options} />);
    expect(get('summary-stock').textContent).toContain('moves no stock');
  });

  it('names the shop and insists the listing is a draft', async () => {
    const { get } = await renderComponent(
      <RelationshipSummary decisions={{ stores: { storeIds: ['store-1'] } }} options={options} />,
    );
    const text = get('summary-stores').textContent ?? '';
    expect(text).toContain('The Branch');
    expect(text).toContain('drafts');
    expect(text).toContain('not published and not visible to customers');
  });

  it('says when nothing will be listed', async () => {
    const { get } = await renderComponent(<RelationshipSummary decisions={{}} options={options} />);
    expect(get('summary-stores').textContent).toContain('not be listed in any shop');
  });

  it('distinguishes assigning categories from creating them', async () => {
    const assigning = await renderComponent(
      <RelationshipSummary
        decisions={{ categories: { columnIndex: 1, pathSeparator: '>', createMissing: false } }}
        options={options}
      />,
    );
    expect(assigning.get('summary-categories').textContent).toContain('Nothing new will be created');
    cleanupAll();

    const creating = await renderComponent(
      <RelationshipSummary
        decisions={{ categories: { columnIndex: 1, pathSeparator: '>', createMissing: true } }}
        options={options}
      />,
    );
    expect(creating.get('summary-categories').textContent).toContain('will be created');
  });

  it('says when no categories are assigned', async () => {
    const { get } = await renderComponent(<RelationshipSummary decisions={{}} options={options} />);
    expect(get('summary-categories').textContent).toContain('No categories will be assigned');
  });
});
