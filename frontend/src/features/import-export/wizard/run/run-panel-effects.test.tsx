import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderComponent, cleanupAll } from '../../../../test/render';
import { RunPanel } from './run-panel';
import { initialRunState } from './run-machine';
import type { RowResult } from '../api/lifecycle.service';

/**
 * The row-by-row screen, rendered.
 *
 * `row-effects.test.ts` proves the wording matches the downloadable report.
 * This proves the wording reaches the screen — that each thing a row can touch
 * has its own column, that a row which did nothing says which nothing, and that
 * a row from before effects were recorded is labelled rather than left looking
 * empty.
 */

const actions = {
  createPlan: vi.fn(),
  approve: vi.fn(),
  execute: vi.fn(),
  cancel: vi.fn(),
  resume: vi.fn(),
  loadResults: vi.fn(),
    withdraw: vi.fn(),
    editMapping: vi.fn(),
  reportHref: null,
};

const row = (over: Partial<RowResult> = {}): RowResult => ({
  sourceTable: 'main',
  sourceRow: 2,
  outcome: 'CREATED',
  targetType: 'PRODUCT',
  targetId: null,
  matchedBy: null,
  reason: null,
  ...over,
});

/**
 * A finished run, as one actually exists.
 *
 * Rows are rendered by the shared plan surface now, and that surface describes
 * a PLAN. Rendering rows without one was a state the product cannot reach —
 * results belong to a run, a run belongs to a plan — and it stopped being
 * expressible when the results moved out of the host and into the surface.
 */
const renderRows = (rows: RowResult[]) =>
  renderComponent(
    <RunPanel
      state={{
        ...initialRunState(),
        phase: 'SETTLED',
        rows,
        resultsLoaded: true,
        plan: { id: 'plan-1', planHash: 'a'.repeat(64), readiness: { allowed: true }, outstanding: 0, alreadyExisted: false },
        lifecycle: {
          planId: 'plan-1',
          planHash: 'a'.repeat(64),
          sourceId: 'source-1',
          importType: 'PRODUCTS',
          storeId: null,
          state: 'COMPLETED',
          authority: 'EXECUTION',
          statusIsStale: false,
          storedStatus: 'APPROVED',
          mayApprove: false,
          mayExecute: false,
          approval: null,
          execution: { id: 'exec-1', status: 'COMPLETED', startedAt: 'x', finishedAt: 'y', cancelRequested: false },
        },
      }}
      readiness={{ allowed: true }}
      actions={actions}
    />,
  );

afterEach(() => cleanupAll());

describe('the row-by-row screen', () => {
  it('gives each thing a row can touch its own column', async () => {
    const view = await renderRows([row()]);
    const headings = Array.from(view.get('row-results').querySelectorAll('th[scope="col"]')).map((th) =>
      th.textContent?.trim(),
    );
    expect(headings).toEqual(['Row', 'Result', 'Product', 'Listed in shop', 'Categories', 'Stock', 'Detail']);
  });

  it('shows the shop listing as unpublished, named', async () => {
    const view = await renderRows([
      row({
        effects: {
          product: { state: 'CREATED', sku: 'P9ACC-004' },
          storeAssociation: { state: 'CREATED', storeName: 'Store B', published: false },
        },
      }),
    ]);
    expect(view.get('effect-store-2').textContent).toBe('created in Store B (unpublished)');
  });

  it('separates the category it created from the one it reused', async () => {
    const view = await renderRows([
      row({ effects: { categories: { state: 'CREATED', created: ['Aceptacion P9'], reused: ['Ropa'] } } }),
    ]);
    const text = view.get('effect-categories-2').textContent ?? '';
    expect(text).toContain('created: Aceptacion P9');
    expect(text).toContain('reused: Ropa');
  });

  it('names where the stock went and how much', async () => {
    const view = await renderRows([
      row({
        effects: {
          inventory: { state: 'CREATED', locationName: 'Store B custody', locationKind: 'STORE', quantity: 7 },
        },
      }),
    ]);
    expect(view.get('effect-stock-2').textContent).toBe('7 to Store B custody (store)');
  });

  it('says a declared zero moved nothing, rather than saying nothing', async () => {
    const view = await renderRows([row({ effects: { inventory: { state: 'ZERO_NO_MOVEMENT', quantity: 0 } } })]);
    expect(view.get('effect-stock-2').textContent).toBe('no stock movement (zero)');
  });

  it('reports a rolled-back row as rolled back, beside its blocked product', async () => {
    const view = await renderRows([
      row({
        outcome: 'FAILED',
        effects: {
          product: { state: 'BLOCKED' },
          storeAssociation: { state: 'ROLLED_BACK', storeName: 'Store B', published: false },
          categories: { state: 'ROLLED_BACK' },
          inventory: { state: 'ROLLED_BACK' },
        },
      }),
    ]);
    expect(view.get('effect-product-2').textContent).toBe('blocked');
    expect(view.get('effect-categories-2').textContent).toBe('rolled back');
    expect(view.get('effect-stock-2').textContent).toBe('rolled back');
  });

  it('labels rows from before effects were recorded, instead of showing blanks', async () => {
    const view = await renderRows([row({ effects: null })]);
    for (const id of ['effect-product-2', 'effect-store-2', 'effect-categories-2', 'effect-stock-2']) {
      expect(view.get(id).textContent).toBe('not recorded');
    }
    expect(view.find('legacy-effects-note')).not.toBeNull();
  });

  it('does not explain the legacy fallback when no row needs it', async () => {
    const view = await renderRows([row({ effects: { product: { state: 'CREATED' } } })]);
    expect(view.find('legacy-effects-note')).toBeNull();
  });

  it('shows no internal identifier a person has no use for', async () => {
    const view = await renderRows([
      row({
        targetId: '3d7eb696-0000-4000-8000-000000000001',
        effects: {
          product: { state: 'CREATED', sku: 'P9ACC-004' },
          storeAssociation: { state: 'CREATED', storeName: 'Store B', published: false },
          inventory: { state: 'CREATED', locationName: 'Store B custody', locationKind: 'STORE', quantity: 3 },
        },
      }),
    ]);
    // Names carry the meaning. A location UUID tells a shop owner nothing, and
    // would not help them notice it was the wrong branch.
    expect(view.get('row-results').textContent ?? '').not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });

  it('describes several rows independently', async () => {
    const view = await renderRows([
      row({ sourceRow: 2, effects: { categories: { state: 'CREATED', created: ['Aceptacion P9'] } } }),
      row({ sourceRow: 3, effects: { categories: { state: 'EXISTING', reused: ['Aceptacion P9'] } } }),
    ]);
    expect(view.get('effect-categories-2').textContent).toBe('created: Aceptacion P9');
    expect(view.get('effect-categories-3').textContent).toBe('reused: Aceptacion P9');
  });
});
