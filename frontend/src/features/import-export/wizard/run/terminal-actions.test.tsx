import { afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderComponent, cleanupAll } from '../../../../test/render';
import { RunPanel, type RunActions } from './run-panel';
import { initialRunState, type RunState } from './run-machine';
import type { PlanLifecycle, RowResult } from '../api/lifecycle.service';

/**
 * Every terminal control, PRESSED.
 *
 * The suite this replaces asserted that a control was OFFERED — that the
 * projection listed it and the button rendered. That is not the same claim, and
 * the difference shipped: View results was offered on the plan-review route,
 * rendered, sent a real request that answered 200, and displayed nothing,
 * because the surface that renders rows lives in one host and not the other.
 *
 * So each control here is clicked, and each is required either to call its
 * handler or to produce something visible. A control that does neither is a
 * control that does not work, whatever the projection says about it.
 */

const PLAN = { id: 'plan-1', planHash: 'a'.repeat(64), readiness: { allowed: true }, outstanding: 0, alreadyExisted: false };

const lifecycle = (over: Partial<PlanLifecycle> = {}): PlanLifecycle => ({
  planId: 'plan-1',
  planHash: PLAN.planHash,
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
  execution: { id: 'exec-1', status: 'COMPLETED', startedAt: '2026-08-31T17:37:21Z', finishedAt: '2026-08-31T17:38:25Z', cancelRequested: false },
  ...over,
});

const ROW: RowResult = {
  sourceTable: 'main',
  sourceRow: 2,
  outcome: 'UPDATED',
  targetType: 'product',
  targetId: 'product-1',
  matchedBy: 'INTERNAL_SKU',
  reason: null,
  effects: {
    product: { state: 'UPDATED', sku: 'P9ACC-003' },
    storeAssociation: { state: 'CREATED', storeName: 'Tutienda QA – Store B', published: false },
    categories: { state: 'EXISTING', reused: ['Aceptacion P9'] },
    inventory: { state: 'ZERO_NO_MOVEMENT', quantity: 0 },
  },
} as unknown as RowResult;

const actions = (): RunActions => ({
  createPlan: vi.fn(), approve: vi.fn(), execute: vi.fn(), cancel: vi.fn(),
  resume: vi.fn(), loadResults: vi.fn(), withdraw: vi.fn(), editMapping: vi.fn(),
  reportHref: '/api/v1/import/lifecycle/executions/exec-1/report.csv',
});

const panel = (state: Partial<RunState>, a: RunActions) =>
  renderComponent(
    <RunPanel
      state={{ ...initialRunState(), plan: PLAN, ...state } as RunState}
      readiness={{ allowed: true }}
      actions={a}
    />,
  );

const press = async (view: Awaited<ReturnType<typeof panel>>, action: string) => {
  const el = view.container.querySelector(`[data-plan-action="${action}"]`) as HTMLElement | null;
  expect(el, `no control for ${action}`).not.toBeNull();
  el!.click();
  await new Promise((r) => setTimeout(r, 0));
};

afterEach(() => cleanupAll());

describe('terminal controls call their handlers when pressed', () => {
  it('View results calls loadResults', async () => {
    const a = actions();
    const view = await panel({ lifecycle: lifecycle() }, a);
    await press(view, 'VIEW_RESULTS');
    expect(a.loadResults).toHaveBeenCalledTimes(1);
  });

  it('Continue this import calls resume, on a partial run', async () => {
    const a = actions();
    const view = await panel({ lifecycle: lifecycle({ state: 'PARTIALLY_COMPLETED' }) }, a);
    await press(view, 'RESUME_RUN');
    expect(a.resume).toHaveBeenCalledTimes(1);
  });

  it('Stop this import calls cancel, on a running one', async () => {
    const a = actions();
    const view = await panel({ lifecycle: lifecycle({ state: 'EXECUTING' }) }, a);
    await press(view, 'CANCEL_RUN');
    expect(a.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('the answer is visible where the control was pressed', () => {
  it('renders rows and the report once results are loaded', async () => {
    const a = actions();
    const view = await panel(
      { lifecycle: lifecycle(), rows: [ROW], report: { headline: 'Finished. 1 updated.', repair: [], total: 0, blocking: 0, warning: 0, informational: 0, unacknowledgedWarnings: 0 } as never },
      a,
    );
    expect(view.find('row-results')).not.toBeNull();
    expect(view.get('row-results').textContent ?? '').toContain('Updated');
    expect(view.find('run-report')).not.toBeNull();
  });

  it('offers the report download on a terminal run', async () => {
    const a = actions();
    const view = await panel({ lifecycle: lifecycle() }, a);
    expect(view.find('download-report')).not.toBeNull();
    expect(view.get('download-report').getAttribute('href')).toContain('/report.csv');
  });

  it('offers no download while the run is still going', async () => {
    const a = actions();
    const view = await panel({ lifecycle: lifecycle({ state: 'EXECUTING' }) }, a);
    expect(view.find('download-report')).toBeNull();
  });
});

describe('the shared results surface renders on BOTH hosts', () => {
  it('renders rows, report and download from the surface, not the host', async () => {
    // `PlanResults` is rendered by `PlanSurfaceView`, so any host that renders
    // the surface gets the answers. Asserted through the surface directly so
    // the claim is about the shared component and not about one host.
    const { PlanSurfaceView } = await import('./plan-surface');
    const view = await renderComponent(
      <PlanSurfaceView
        surface={{
          kind: 'TERMINAL',
          headline: 'This import has run. Your catalogue has been updated.',
          detail: 'x',
          actions: [],
          requiresNoAction: true,
          provenance: null,
          normalized: null,
        }}
        handlers={{
          approve: vi.fn(), start: vi.fn(), withdraw: vi.fn(), editMapping: vi.fn(),
          cancelRun: vi.fn(), resumeRun: vi.fn(), viewResults: vi.fn(),
        }}
        results={{
          rows: [ROW],
          report: { headline: 'Finished. 1 updated.', repair: [], total: 0, blocking: 0, warning: 0, informational: 0, unacknowledgedWarnings: 0 } as never,
          reportHref: '/api/v1/import/lifecycle/executions/exec-1/report.csv',
        }}
      />,
    );
    expect(view.find('row-results')).not.toBeNull();
    expect(view.get('row-results').textContent ?? '').toContain('Updated');
    expect(view.find('run-report')).not.toBeNull();
    expect(view.get('download-report').getAttribute('href')).toContain('/report.csv');
  });

  it('shows a reading status instead of the answers while the read is out', async () => {
    const { PlanSurfaceView } = await import('./plan-surface');
    const view = await renderComponent(
      <PlanSurfaceView
        surface={{ kind: 'TERMINAL', headline: 'h', detail: 'd', actions: [], requiresNoAction: true, provenance: null, normalized: null }}
        handlers={{
          approve: vi.fn(), start: vi.fn(), withdraw: vi.fn(), editMapping: vi.fn(),
          cancelRun: vi.fn(), resumeRun: vi.fn(), viewResults: vi.fn(),
        }}
        results={{ rows: [], report: null, reportHref: null, loading: true }}
      />,
    );
    expect(view.find('results-loading')).not.toBeNull();
    expect(view.find('row-results')).toBeNull();
  });
});

describe('View results is not offered once it has been answered', () => {
  it('disappears when the results are loaded', async () => {
    const a = actions();
    const view = await panel({ lifecycle: lifecycle(), resultsLoaded: true, rows: [ROW] }, a);
    expect(view.container.querySelector('[data-plan-action="VIEW_RESULTS"]')).toBeNull();
    // ...and the answer is on screen in its place.
    expect(view.find('row-results')).not.toBeNull();
  });

  it('disappears while the read is in flight', async () => {
    const a = actions();
    const view = await panel({ lifecycle: lifecycle(), resultsLoading: true }, a);
    expect(view.container.querySelector('[data-plan-action="VIEW_RESULTS"]')).toBeNull();
    expect(view.find('results-loading')).not.toBeNull();
  });
});

describe('a run this browser never saw', () => {
  /**
   * The reopened-plan case, against the REAL hook.
   *
   * `View results`, `Stop` and `Continue` all read an execution id. That id
   * used to come only from the run machine, which holds one solely if THIS tab
   * started the run — so a plan reopened from the imports list offered all
   * three from the server's answer and every one returned silently: no
   * request, no state change, no error.
   */
  const lifecycleWithRun = (state: PlanLifecycle['state'], executionId: string | null) =>
    lifecycle({
      state,
      execution: executionId
        ? { id: executionId, status: state, startedAt: 'x', finishedAt: null, cancelRequested: false }
        : null,
    });

  it('reads the execution id from the LIFECYCLE when the machine has none', async () => {
    const { renderHook } = await import('./hook-harness');
    const calls: string[] = [];
    const service = {
      reportCsvPath: (id: string) => `/api/v1/import/lifecycle/executions/${id}/report.csv`,
      rowResults: async (_t: string, id: string) => { calls.push(`rows:${id}`); return []; },
      reportSummary: async (_t: string, id: string) => {
        calls.push(`report:${id}`);
        return { headline: 'h', repair: [], total: 0, blocking: 0, warning: 0, informational: 0, unacknowledgedWarnings: 0 };
      },
    };
    const h = await renderHook({ service, lifecycle: lifecycleWithRun('COMPLETED', 'exec-from-server') });
    await h.act(() => h.actions().loadResults());
    // A real request, using the id only the server knew about.
    expect(calls).toContain('rows:exec-from-server');
    expect(calls).toContain('report:exec-from-server');
  });

  it('names the failure when NO source has an execution id', async () => {
    const { renderHook } = await import('./hook-harness');
    const h = await renderHook({ service: { reportCsvPath: (id: string) => `/x/${id}` }, lifecycle: lifecycleWithRun('COMPLETED', null) });
    await h.act(() => h.actions().loadResults());
    expect(h.state().error ?? '').toMatch(/not loaded/i);
  });

  it('names the failure for Stop, rather than returning silently', async () => {
    const { renderHook } = await import('./hook-harness');
    const h = await renderHook({ service: { reportCsvPath: (id: string) => `/x/${id}` }, lifecycle: lifecycleWithRun('EXECUTING', null) });
    await h.act(() => h.actions().cancel());
    expect(h.state().error ?? '').toMatch(/could not be stopped/i);
  });

  it('names the failure for Continue, rather than returning silently', async () => {
    const { renderHook } = await import('./hook-harness');
    const h = await renderHook({ service: { reportCsvPath: (id: string) => `/x/${id}` }, lifecycle: lifecycleWithRun('PARTIALLY_COMPLETED', null) });
    await h.act(() => h.actions().resume());
    expect(h.state().error ?? '').toMatch(/could not be continued/i);
  });

  it('issues one read however many times View results is pressed', async () => {
    const { renderHook } = await import('./hook-harness');
    let rows = 0;
    const service = {
      reportCsvPath: (id: string) => `/api/v1/import/lifecycle/executions/${id}/report.csv`,
      rowResults: async () => { rows++; return []; },
      reportSummary: async () => ({ headline: 'h', repair: [], total: 0, blocking: 0, warning: 0, informational: 0, unacknowledgedWarnings: 0 }),
    };
    const h = await renderHook({ service, lifecycle: lifecycleWithRun('COMPLETED', 'exec-1') });
    await h.act(() => {
      h.actions().loadResults();
      h.actions().loadResults();
      h.actions().loadResults();
    });
    expect(rows).toBe(1);
    // And once answered, asking again reads nothing further.
    await h.act(() => h.actions().loadResults());
    expect(rows).toBe(1);
  });
});

describe('what opening a listing row actually gets you', () => {
  /**
   * The listing decides REACHABILITY; this decides capability.
   *
   * The two were conflated: the listing refused a link to any stage it judged
   * uneditable, which made a live run unwatchable and a partial run
   * unresumable. Opening is not editing, and these assert what each stage
   * offers once opened.
   */
  it('ACTIVE opens to something you can watch and stop', async () => {
    const a = actions();
    const view = await panel({ lifecycle: lifecycle({ state: 'EXECUTING' }) }, a);
    expect(view.get('plan-surface-headline').textContent ?? '').toMatch(/is running/i);
    await press(view, 'CANCEL_RUN');
    expect(a.cancel).toHaveBeenCalledTimes(1);
    // And never an offer to approve or start it a second time.
    expect(view.container.querySelector('[data-plan-action="APPROVE"]')).toBeNull();
    expect(view.container.querySelector('[data-plan-action="START"]')).toBeNull();
  });

  it('RECOVERY opens to something you can inspect and continue', async () => {
    const a = actions();
    const view = await panel({ lifecycle: lifecycle({ state: 'PARTIALLY_COMPLETED' }) }, a);
    expect(view.get('plan-surface-headline').textContent ?? '').toMatch(/partly ran/i);
    // Both: read what happened, and continue from where it stopped.
    expect(view.container.querySelector('[data-plan-action="VIEW_RESULTS"]')).not.toBeNull();
    await press(view, 'RESUME_RUN');
    expect(a.resume).toHaveBeenCalledTimes(1);
  });

  it('CANCELLED opens to what it managed to write, and offers no restart', async () => {
    const a = actions();
    const view = await panel({ lifecycle: lifecycle({ state: 'CANCELLED' }) }, a);
    expect(view.get('plan-surface-headline').textContent ?? '').toMatch(/was stopped/i);
    expect(view.container.querySelector('[data-plan-action="VIEW_RESULTS"]')).not.toBeNull();
    expect(view.container.querySelector('[data-plan-action="START"]')).toBeNull();
    expect(view.container.querySelector('[data-plan-action="APPROVE"]')).toBeNull();
  });
});
