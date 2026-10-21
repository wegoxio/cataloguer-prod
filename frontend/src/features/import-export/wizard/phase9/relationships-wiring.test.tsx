import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderComponent, click, flush, cleanupAll } from '../../../../test/render';
import { Phase9ImportWizard } from './import-wizard';

/**
 * The relationships step, wired into the wizard.
 *
 * Two properties matter here and neither can be seen from the component alone:
 * a plan cannot be built until the questions are answered, and the answers
 * actually reach `createPlan`. The second is the one that failed in production
 * — the request has always carried a `relationships` field, and the wizard has
 * always sent it empty.
 */

const SOURCE = '11111111-1111-1111-1111-111111111111';
const STORE = '22222222-2222-2222-2222-222222222222';
const CUSTODY = '33333333-3333-3333-3333-333333333333';

const SAMPLE = {
  headers: ['sku', 'name', 'stock'],
  rows: [
    ['P9ACC-001', 'Widget Alfa', '7'],
    ['P9ACC-003', 'Widget Gamma', '0'],
  ],
  firstRowNumber: 2,
};

const completedAnalysis = {
  id: 'analysis-1',
  sourceId: SOURCE,
  status: 'COMPLETED',
  tables: { sample: SAMPLE, columnTypes: [] },
  proposals: [
    { columnIndex: 0, header: 'sku', field: 'sku' },
    { columnIndex: 1, header: 'name', field: 'name' },
    { columnIndex: 2, header: 'stock', field: 'stock' },
  ],
  findings: [],
  rowsAnalyzed: 2,
  failureReason: null,
};

type PlanBody = { relationships?: unknown; storeId?: string };
const planResult = () => ({
  id: 'plan-1',
  planHash: 'a'.repeat(64),
  readiness: { allowed: true },
  outstanding: 0,
  alreadyExisted: false,
});

function client(createPlan = vi.fn(async (_token: string, _body: PlanBody) => planResult())) {
  return {
    startAnalysis: vi.fn(async () => ({ id: 'analysis-1', status: 'COMPLETED' })),
    getAnalysis: vi.fn(async () => completedAnalysis),
    relationshipOptions: vi.fn(async () => ({
      storeId: STORE,
      stockDestinations: [
        { id: CUSTODY, name: 'Branch custody', kind: 'STORE', storeId: STORE, isDefault: false, proposed: true },
      ],
      stores: [{ id: STORE, name: 'The Branch' }],
      existingCategoryNames: [],
    })),
    createPlan,
  } as never;
}

const open = async (lifecycle: unknown) =>
  renderComponent(
    <Phase9ImportWizard
      availability="ALLOWED"
      token="token"
      location={{ sourceId: SOURCE, importType: 'PRODUCTS' }}
      sourceStatus="AVAILABLE"
      storage={null}
      storeId={STORE}
      lifecycle={lifecycle as never}
      pollIntervalMs={1}
    />,
  );

const settle = async () => {
  await flush();
  await flush();
  await flush();
};

afterEach(cleanupAll);

describe('a plan cannot be built until the questions are answered', () => {
  it('names the decisions that are missing, instead of a generic sentence', async () => {
    const { get, find } = await open(client());
    await settle();

    expect(get('relationships-step')).not.toBeNull();
    const outstanding = get('relationships-outstanding').textContent ?? '';
    // The old copy - "Answer the questions above" - named nothing and pointed
    // nowhere, which is how an operator ended up stuck in front of a form whose
    // every visible control was answered.
    expect(outstanding).not.toContain('Answer the questions above');
    expect(outstanding).toContain('where the physical stock is held');
    expect(find('goto-stock')).not.toBeNull();
    expect(find('run-panel')).toBeNull();
  });

  it('offers the run panel once every decision is made - choosing IS confirming', async () => {
    const { get, find } = await open(client());
    await settle();

    // One click per decision. There is no second tick restating the first.
    await click(get(`destination-${CUSTODY}`));
    await settle();
    await click(get('list-nowhere'));
    await settle();

    expect(find('relationships-outstanding')).toBeNull();
    expect(find('run-panel')).not.toBeNull();
  });
});

describe('the answers reach the plan', () => {
  // Forwarding the confirmed decisions all the way into `createPlan` is proven
  // where it can be proven end to end: the real-PostgreSQL lifecycle suite
  // sends a plan WITH a destination and gets 201, sends the same file WITHOUT
  // one and gets 400, and refuses another shop's custody. Driving the button
  // here would require satisfying the mapping editor's own review gate, which
  // is a different rule and would make this test fail for reasons that have
  // nothing to do with relationships.

  it('asks the server for options scoped to this shop, holding no list of its own', async () => {
    const lifecycle = client();
    await open(lifecycle);
    await settle();

    expect((lifecycle as unknown as { relationshipOptions: ReturnType<typeof vi.fn> }).relationshipOptions).toHaveBeenCalledWith(
      'token',
      STORE,
    );
  });
});

describe('options are required, and fail closed', () => {
  const failing = () =>
    ({
      startAnalysis: vi.fn(async () => ({ id: 'analysis-1', status: 'COMPLETED' })),
      getAnalysis: vi.fn(async () => completedAnalysis),
      relationshipOptions: vi.fn(async () => {
        throw new Error('Network error');
      }),
      createPlan: vi.fn(async (_t: string, _b: PlanBody) => planResult()),
    }) as never;

  it('names the failure and refuses to prepare a plan', async () => {
    const { get, find } = await open(failing());
    await settle();

    const card = get('relationship-options-failed');
    expect(card.getAttribute('role')).toBe('alert');
    expect(card.textContent).toContain(
      'The available stores, categories and stock locations could not be loaded',
    );
    expect(card.textContent).toContain('No plan can be prepared until they are available');
    expect(find('run-panel')).toBeNull();
  });

  it('shows no misleading empty choices when the request failed', async () => {
    const { find } = await open(failing());
    await settle();

    // The step is not rendered at all, so nobody can read empty pickers as
    // "this company has nothing".
    expect(find('relationships-step')).toBeNull();
    expect(find('section-stock')).toBeNull();
  });

  it('offers Retry, and recovers when the retry succeeds', async () => {
    let attempts = 0;
    const lifecycle = {
      startAnalysis: vi.fn(async () => ({ id: 'analysis-1', status: 'COMPLETED' })),
      getAnalysis: vi.fn(async () => completedAnalysis),
      relationshipOptions: vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Network error');
        return {
          storeId: STORE,
          stockDestinations: [
            { id: CUSTODY, name: 'Branch custody', kind: 'STORE', storeId: STORE, isDefault: false, proposed: true },
          ],
          stores: [{ id: STORE, name: 'The Branch' }],
          existingCategoryNames: [],
        };
      }),
      createPlan: vi.fn(async (_t: string, _b: PlanBody) => planResult()),
    } as never;

    const { get, find } = await open(lifecycle);
    await settle();
    expect(find('relationship-options-failed')).not.toBeNull();

    await click(get('retry-relationship-options'));
    await settle();

    expect(find('relationship-options-failed')).toBeNull();
    expect(find('relationships-step')).not.toBeNull();
  });

  it('a LEGITIMATE empty location set reads as configuration, not failure', async () => {
    const empty = {
      startAnalysis: vi.fn(async () => ({ id: 'analysis-1', status: 'COMPLETED' })),
      getAnalysis: vi.fn(async () => completedAnalysis),
      relationshipOptions: vi.fn(async () => ({
        storeId: STORE,
        stockDestinations: [],
        stores: [{ id: STORE, name: 'The Branch' }],
        existingCategoryNames: [],
      })),
      createPlan: vi.fn(async (_t: string, _b: PlanBody) => planResult()),
    } as never;

    const { get, find } = await open(empty);
    await settle();

    // Loaded successfully — so no error card — but nothing to choose.
    expect(find('relationship-options-failed')).toBeNull();
    expect(get('no-destinations').textContent).toContain('An inventory location must be created');

    // Its own state, not another unanswered question. The operator cannot
    // answer this one here, so presenting it as outstanding work would be the
    // dead end this replaces.
    expect(get('relationships-unavailable').textContent).toContain('no stock locations yet');
    expect(find('relationships-outstanding')).toBeNull();
    expect(find('run-panel')).toBeNull();
  });
});
