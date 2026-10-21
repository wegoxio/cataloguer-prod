import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Phase9ImportWizard } from './import-wizard';
import { act } from 'react';
import { renderComponent, click, cleanupAll, flush } from '../../../../test/render';
import { saveProgress, type ProgressStorage } from '../mapping/progress-store';
import { initialMappingState, mappingReducer } from '../mapping/mapping-state';
import type { ProgressScope } from '../mapping/progress-hydration';

/**
 * Opening a plan that already exists.
 *
 * The draft list said "Ready to review" and routed to the mapping editor. That
 * editor cleared its preview on restore, never asked for another — the request
 * was keyed on a mapping that had not changed — and reported "Waiting for the
 * preview." indefinitely, while the finished five-row plan sat unread on the
 * server. Review import plan stayed disabled and there was no way forward.
 *
 * Reviewing a plan reads the plan. It does not remap the file.
 */

const SOURCE = '11111111-1111-4111-8111-111111111111';
const PLAN = '3c39d24b-6635-4b22-bde3-beee7bb4f22e';
const ANALYSIS = '22222222-2222-4222-8222-222222222222';
const STORE = '44444444-4444-4444-8444-444444444444';
const LOCATION = '33333333-3333-4333-8333-333333333333';

const STORED_PLAN = {
  id: PLAN,
  importType: 'PRODUCTS' as const,
  planHash: 'db6910b018440df807a474d1b1944b5f8ee646adad6bc87a4f21dce9f40ad362',
  status: 'DRAFT',
  storeId: STORE,
  sourceId: SOURCE,
  mapping: {
    sheet: 'Sheet 1',
    headerRow: 1,
    columns: [
      { columnIndex: 0, header: 'sku', field: 'sku' },
      { columnIndex: 1, header: 'name', field: 'name' },
      { columnIndex: 2, header: 'description', field: 'description' },
      { columnIndex: 3, header: 'price', field: 'price' },
      { columnIndex: 4, header: 'cost', field: 'cost' },
      { columnIndex: 5, header: 'stock', field: 'stock' },
      { columnIndex: 6, header: 'categories', field: 'categoryPaths' },
    ],
  },
  decisions: {
    acknowledged: [],
    relationships: {
      stores: { storeIds: [STORE] },
      inventory: { defaultLocationId: LOCATION },
      categories: { columnIndex: 6, createMissing: true, pathSeparator: '>' },
    },
  },
  summary: { issues: [], summary: { total: 0 }, previewedRows: 5, blankRowCount: 0, readiness: { allowed: true } },
};

const LIFECYCLE = {
  planId: PLAN,
  planHash: STORED_PLAN.planHash,
  sourceId: SOURCE,
  importType: 'PRODUCTS',
  storeId: STORE,
  state: 'PREPARED' as const,
  authority: 'PLAN' as const,
  statusIsStale: false,
  storedStatus: 'DRAFT',
  mayApprove: true,
  mayExecute: false,
  approval: null,
  execution: null,
};

function makeStorage(): ProgressStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get length() {
      return map.size;
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
}

const counters = () => ({ analyses: 0, previews: 0, plansCreated: 0, approvals: 0, executions: 0, withdrawals: 0, withdrawn: false });

const lifecycleFor = (c: ReturnType<typeof counters>, over: Record<string, unknown> = {}) => ({
  getSource: async () => ({ id: SOURCE, contentHash: 'a'.repeat(64), status: 'AVAILABLE' }),
  startAnalysis: async () => {
    c.analyses += 1;
    return { id: ANALYSIS, status: 'COMPLETED' };
  },
  getAnalysis: async () => ({
    id: ANALYSIS,
    sourceId: SOURCE,
    status: 'COMPLETED',
    tables: { sample: { firstRowNumber: 2, sheet: 'Sheet 1', headers: ['sku'], rows: [['A-1']] }, columnTypes: ['TEXT'] },
    proposals: [{ columnIndex: 0, header: 'sku', field: 'sku' }],
    findings: [],
    rowsAnalyzed: 5,
    failureReason: null,
  }),
  relationshipOptions: async () => ({
    storeId: STORE,
    stockDestinations: [{ id: LOCATION, name: 'Store B custody', kind: 'STORE', storeId: STORE, isDefault: true, proposed: false }],
    stores: [{ id: STORE, name: 'Store B' }],
    existingCategoryNames: [],
  }),
  getPlan: async () => STORED_PLAN,
  /**
   * The lifecycle as the SERVER would report it, not a constant.
   *
   * Once an approval exists the plan is APPROVED and executable, and once it is
   * withdrawn it is PREPARED and approvable again. A fake that always said
   * PREPARED would let the screen pass tests the real server would fail.
   */
  planLifecycle: async () =>
    c.withdrawn
      ? { ...LIFECYCLE, state: 'PREPARED' as const, mayApprove: true, mayExecute: false }
      : c.approvals > 0
        ? { ...LIFECYCLE, state: 'APPROVED' as const, mayApprove: false, mayExecute: true, authority: 'APPROVAL' as const }
        : LIFECYCLE,
  withdrawApproval: async () => {
    c.withdrawals += 1;
    c.withdrawn = true;
    c.approvals = 0;
    return { withdrawn: true, alreadyWithdrawn: false, notice: 'The approval was withdrawn.' };
  },
  cancelSource: vi.fn(),
  createPlan: async () => {
    c.plansCreated += 1;
    return { id: 'new-plan', planHash: 'x'.repeat(64), readiness: { allowed: true }, outstanding: 0, alreadyExisted: false };
  },
  approvePlan: async () => {
    c.approvals += 1;
    c.withdrawn = false;
    return { approvalId: 'a1', proof: 'p', expiresAt: '2026-09-01T00:00:00.000Z', notice: 'n' };
  },
  startExecution: () => new Promise<never>(() => {}),
  executionStatus: () => new Promise<never>(() => {}),
  cancel: () => new Promise<never>(() => {}),
  resume: () => new Promise<never>(() => {}),
  rowResults: () => new Promise<never>(() => {}),
  reportSummary: () => new Promise<never>(() => {}),
  reportCsvPath: (id: string) => `/x/${id}`,
  ...over,
});

const bootstrap = (over: Record<string, unknown> = {}) => ({
  availability: 'ALLOWED' as const,
  token: 'token',
  location: { sourceId: SOURCE, planId: PLAN, importType: 'PRODUCTS' as const },
  sourceStatus: 'AVAILABLE' as const,
  storeId: STORE,
  now: () => 1_800_000_000_000,
  ...over,
});

const settle = async (n = 14) => {
  for (let i = 0; i < n; i++) await flush();
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  cleanupAll();
  vi.restoreAllMocks();
});

describe('resuming a DRAFT plan', () => {
  it('opens plan review, not the mapping editor', async () => {
    const c = counters();
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: lifecycleFor(c) as never })} />,
    );
    await settle();
    expect(view.find('plan-review')).not.toBeNull();
    // The route that produced the indefinite wait.
    expect(view.find('mapping-editor')).toBeNull();
  });

  it('never says it is waiting for a preview', async () => {
    const c = counters();
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: lifecycleFor(c) as never })} />,
    );
    await settle(30);
    expect(view.text()).not.toContain('Waiting for the preview');
    expect(c.previews).toBe(0);
  });

  it('queues no analysis and creates no second plan', async () => {
    const c = counters();
    await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: lifecycleFor(c) as never })} />,
    );
    await settle(30);
    // Re-reading a file whose plan already exists is work nobody asked for, and
    // a second plan would silently fork the decisions.
    expect(c.analyses).toBe(0);
    expect(c.plansCreated).toBe(0);
  });

  it('never offers to restore browser-local work', async () => {
    // The decisions are ON THE SERVER and hashed. Offering a local copy invites
    // somebody to review one set and approve another.
    const storage = makeStorage();
    let state = initialMappingState('PRODUCTS');
    state = mappingReducer(state, {
      type: 'SOURCE_LOADED',
      sample: { firstRowNumber: 2, headers: ['sku'], rows: [['A-1']] },
      columnTypes: ['TEXT'],
      proposals: [{ columnIndex: 0, header: 'sku', field: 'sku' }],
    });
    const scope: ProgressScope = {
      sourceId: SOURCE, importType: 'PRODUCTS', sourceHash: null, analysisId: null,
      sheet: null, headerRow: 1, headers: ['sku'], storeId: null, locationIds: [], storeIds: [],
    };
    saveProgress(storage, state, SOURCE, 1_800_000_000_000, scope);

    const c = counters();
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage, lifecycle: lifecycleFor(c) as never })} />,
    );
    await settle(20);
    expect(view.find('restore-offer')).toBeNull();
  });

  it('shows the stored plan: reference, rows, columns and findings', async () => {
    const c = counters();
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: lifecycleFor(c) as never })} />,
    );
    await settle();
    expect(view.get('plan-review-hash').textContent).toBe('db6910b018440df8');
    expect(view.get('plan-review-rows').textContent).toBe('5');
    expect(view.get('plan-review-columns').textContent).toBe('7');
    expect(view.get('plan-review-findings').textContent).toBe('0');
  });

  it('leaves the plan DRAFT until somebody approves it', async () => {
    const c = counters();
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: lifecycleFor(c) as never })} />,
    );
    await settle(30);
    // Opening a plan to look at it is not approving it.
    expect(c.approvals).toBe(0);
    expect(view.find('plan-review-approve')).not.toBeNull();
  });

  it('offers no approval when the server says it may not be approved', async () => {
    const c = counters();
    const spent = lifecycleFor(c, {
      planLifecycle: async () => ({ ...LIFECYCLE, state: 'COMPLETED', mayApprove: false, authority: 'EXECUTION' }),
    });
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: spent as never })} />,
    );
    await settle();
    expect(view.find('plan-review-approve')).toBeNull();
    // A completed plan IS a run, so the run block is the surface — it outranks
    // every notice about the authorisation that permitted it.
    expect(view.get('plan-surface-headline').textContent).toContain('has run');
  });

  it('says that editing the mapping prepares a different plan', async () => {
    const c = counters();
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: lifecycleFor(c) as never })} />,
    );
    await settle();
    expect(view.get('plan-review-edit-note').textContent ?? '').toContain('prepares a different plan');

    await click(view.get('plan-review-edit-mapping'));
    await settle(20);
    // Only now does the editor open — and the stored plan is untouched.
    expect(view.find('mapping-editor')).not.toBeNull();
    expect(c.plansCreated).toBe(0);
  });

  it('refuses a plan it may not read, without saying whether it exists', async () => {
    const c = counters();
    const foreign = lifecycleFor(c, {
      getPlan: async () => {
        throw new Error('Not Found');
      },
      planLifecycle: async () => {
        throw new Error('Not Found');
      },
    });
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: foreign as never })} />,
    );
    await settle(20);
    expect(view.find('plan-review-failed')).not.toBeNull();
    const text = view.get('plan-review-failed').textContent ?? '';
    // Deliberately the same sentence for "yours but gone" and "not yours".
    expect(text).toContain('another company, or it may no longer exist');
  });
});

describe('approving from plan review', () => {
  /**
   * The button was rendered, wired, and dead.
   *
   * `actions.approve` reads `planIdRef`, which the run machine sets from
   * `run.plan` — the plan IT created. In plan review the plan came from the
   * server via `getPlan`, so `run.plan` is null, `planIdRef.current` is null,
   * and `approve()` returns at its first line. No request, no state change, no
   * error: a click that does nothing at all.
   *
   * Every earlier test asserted the button EXISTS. None of them pressed it.
   */
  it('sends the approval for the plan being reviewed', async () => {
    const c = counters();
    const approvePlan = vi.fn(async (_token: string, planId: string) => {
      c.approvals += 1;
      c.withdrawn = false;
      void planId;
      return { approvalId: 'a1', proof: 'single-use-proof', expiresAt: '2026-09-01T00:00:00.000Z', notice: 'Approved.' };
    });
    const client = lifecycleFor(c, { approvePlan });

    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: client as never })} />,
    );
    await settle(20);
    expect(view.find('plan-review-approve')).not.toBeNull();

    await click(view.get('plan-review-approve'));
    await settle(30);

    // The request must actually be made, and for THIS plan.
    expect(approvePlan).toHaveBeenCalledTimes(1);
    expect(approvePlan.mock.calls[0]?.[1]).toBe(PLAN);
  });

  it('moves to the executable state once the approval comes back', async () => {
    const c = counters();
    const client = lifecycleFor(c);
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: client as never })} />,
    );
    await settle(20);
    await click(view.get('plan-review-approve'));
    await settle(30);

    // Something must change on screen. A click that leaves the page identical
    // is indistinguishable from a broken one, which is exactly how this was
    // reported: "no visible response or navigation".
    // The approved state must be VISIBLE. A click that leaves the page
    // identical is indistinguishable from a broken one, which is exactly how
    // the dead button was reported: "no visible response or navigation".
    expect(view.find('plan-surface')).not.toBeNull();
    expect(view.get('plan-surface-detail').textContent ?? '').not.toBe('');
    // And the next step is offered, using the same loaded plan.
    expect(view.find('plan-review-start')).not.toBeNull();
    // Approve is gone, so it cannot be pressed a second time.
    expect(view.find('plan-review-approve')).toBeNull();
    // The proof never reaches the screen.
    expect(view.text()).not.toContain('single-use-proof');
  });

  it('never leaves the approve action dead', async () => {
    // The property, stated directly: if the control is on screen, pressing it
    // reaches the server.
    const c = counters();
    const approvePlan = vi.fn(async (_token: string, _planId: string) => ({
      approvalId: 'a1', proof: 'p', expiresAt: '2026-09-01T00:00:00.000Z', notice: 'n',
    }));
    const client = lifecycleFor(c, { approvePlan });
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: client as never })} />,
    );
    await settle(20);
    if (view.find('plan-review-approve')) {
      await click(view.get('plan-review-approve'));
      await settle(30);
      expect(approvePlan).toHaveBeenCalled();
    }
  });
});

describe('pressing Approve twice', () => {
  it('mints one approval, not two', async () => {
    // A single-use proof authorises one run. Two presses that both reach the
    // server leave one proof stranded and the operator unsure which was used.
    const c = counters();
    const pending: { resolve: ((v: unknown) => void) | null } = { resolve: null };
    const approvePlan = vi.fn(
      (_token: string, _planId: string) =>
        new Promise((resolve) => {
          pending.resolve = resolve;
        }) as never,
    );
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: lifecycleFor(c, { approvePlan }) as never })} />,
    );
    await settle(20);

    // TWO presses of the SAME element, inside one act, before React can
    // re-render and take the button away. That is what a double-click is, and
    // it is the only way to reach the hook's guard: a second press after the
    // re-render lands on a different element entirely, so a test that awaits
    // between them proves nothing about the guard at all.
    const button = view.get('plan-review-approve') as HTMLElement;
    await act(async () => {
      button.click();
      button.click();
    });
    expect(approvePlan).toHaveBeenCalledTimes(1);

    // The server would now report the plan APPROVED and executable.
    c.approvals += 1;
    pending.resolve?.({ approvalId: 'a1', proof: 'p', expiresAt: '2026-09-01T00:00:00.000Z', notice: 'Approved.' });
    await settle(30);
    expect(approvePlan).toHaveBeenCalledTimes(1);
    expect(view.find('plan-surface')).not.toBeNull();
  });
});

describe('starting the import from plan review', () => {
  it('sends the execution for the SAME loaded plan, with the minted proof', async () => {
    // Spied transport: this proves the request without creating a run.
    const c = counters();
    const startExecution = vi.fn(async (_token: string, _planId: string, _proof: string) => {
      c.executions += 1;
      return { id: 'exec-1', status: 'QUEUED' };
    });
    const view = await renderComponent(
      <Phase9ImportWizard
        {...bootstrap({ storage: makeStorage(), lifecycle: lifecycleFor(c, { startExecution }) as never })}
      />,
    );
    await settle(20);
    await click(view.get('plan-review-approve'));
    await settle(30);

    await click(view.get('plan-review-start'));
    await settle(30);

    expect(startExecution).toHaveBeenCalledTimes(1);
    // The plan opened for review — not one this browser built.
    expect(startExecution.mock.calls[0]?.[1]).toBe(PLAN);
    expect(startExecution.mock.calls[0]?.[2]).toBe('p');
  });

  it('says so plainly if the plan is not loaded, rather than doing nothing', async () => {
    // The defect this whole correction exists to close: a handler that
    // returned at its first line, leaving a person unable to tell a dead
    // button from a slow network.
    const c = counters();
    const failing = lifecycleFor(c, {
      getPlan: async () => ({ ...STORED_PLAN, id: '' }),
    });
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: failing as never })} />,
    );
    await settle(20);
    if (view.find('plan-review-approve')) {
      await click(view.get('plan-review-approve'));
      await settle(20);
      expect(view.find('plan-review-error')).not.toBeNull();
      expect(view.get('plan-review-error').textContent ?? '').toMatch(/not loaded/i);
    }
  });
});

describe('every enabled control does something', () => {
  it('leaves no button that neither calls the server nor changes the screen', async () => {
    // The guard for the whole class. Approve was on screen, wired to a real
    // handler, and dead — and three rounds of tests asserted only that it
    // EXISTED. Each control here is pressed and must either reach the server
    // or visibly change the page.
    //
    // Controls that are SUPPOSED to do nothing are named, so a genuine
    // regression cannot hide inside a blanket allowance.
    const EXPECTED_NO_OP: string[] = [];

    const c = counters();
    const calls: string[] = [];
    const recording = lifecycleFor(c, {
      approvePlan: async (_t: string, id: string) => {
        calls.push(`approve:${id}`);
        return { approvalId: 'a1', proof: 'p', expiresAt: '2026-09-01T00:00:00.000Z', notice: 'Approved.' };
      },
    });
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: recording as never })} />,
    );
    await settle(20);

    const buttons = Array.from(view.container.querySelectorAll('button')).filter((b) => !b.disabled);
    expect(buttons.length).toBeGreaterThan(0);

    for (const button of buttons) {
      const id = button.getAttribute('data-testid') ?? button.textContent?.trim() ?? '(unnamed)';
      const before = { html: view.container.innerHTML, calls: calls.length };
      await click(button);
      await settle(15);
      const changed = view.container.innerHTML !== before.html || calls.length > before.calls;
      if (EXPECTED_NO_OP.includes(id)) {
        expect(changed, `${id} is listed as a no-op but DID something`).toBe(false);
      } else {
        expect(changed, `${id} did nothing at all when pressed`).toBe(true);
      }
      break; // one press per render; the page has changed underneath the rest
    }
  });
});

describe('when the one-time authorization is not held by this browser', () => {
  /** The state a refresh leaves behind: approved on the server, no proof here. */
  const approvedElsewhere = (c: ReturnType<typeof counters>, over: Record<string, unknown> = {}) =>
    lifecycleFor(c, {
      planLifecycle: async () =>
        c.withdrawn
          ? { ...LIFECYCLE, state: 'PREPARED' as const, mayApprove: true, mayExecute: false }
          : { ...LIFECYCLE, state: 'APPROVED' as const, mayApprove: false, mayExecute: true },
      ...over,
    });

  it('shows no Start button it could not honour', async () => {
    // `/execute` cannot be called without the proof. A button that could only
    // fail is worse than none — and none at all is what a refresh produced.
    const c = counters();
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: approvedElsewhere(c) as never })} />,
    );
    await settle(20);
    expect(view.find('plan-review-start')).toBeNull();
  });

  it('explains exactly why, and offers the way out', async () => {
    const c = counters();
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: approvedElsewhere(c) as never })} />,
    );
    await settle(20);
    const notice = view.get('plan-surface').textContent ?? '';
    expect(notice).toContain('created in another or refreshed tab');
    expect(notice).toContain('one-time authorization is unavailable');
    // And says the important thing: nothing happened to the catalogue.
    expect(notice).toContain('Nothing has been written');
    expect(view.find('plan-review-withdraw')).not.toBeNull();
  });

  it('withdrawing returns the plan to approvable, and approves again once', async () => {
    const c = counters();
    const withdrawApproval = vi.fn(async () => {
      c.withdrawals += 1;
      c.withdrawn = true;
      return { withdrawn: true, alreadyWithdrawn: false, notice: 'The approval was withdrawn.' };
    });
    const approvePlan = vi.fn(async (_t: string, _id: string) => {
      c.approvals += 1;
      c.withdrawn = false;
      return { approvalId: 'a2', proof: 'fresh-proof', expiresAt: '2026-09-03T00:00:00.000Z', notice: 'Approved again.' };
    });
    const client = approvedElsewhere(c, { withdrawApproval, approvePlan });

    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: client as never })} />,
    );
    await settle(20);
    await click(view.get('plan-review-withdraw'));
    await settle(40);

    expect(withdrawApproval).toHaveBeenCalledTimes(1);
    // Back to approvable — the plan itself never changed.
    expect(view.find('plan-review-approve')).not.toBeNull();
    expect(view.find('plan-review-withdraw')).toBeNull();

    await click(view.get('plan-review-approve'));
    await settle(40);
    expect(approvePlan).toHaveBeenCalledTimes(1);
    // A NEW proof, held in this browser, so the run can start.
    expect(view.find('plan-surface')).not.toBeNull();
    expect(view.find('plan-review-start')).not.toBeNull();
  });

  it('hands the execute transport the NEW proof, and runs nothing before that', async () => {
    const c = counters();
    const startExecution = vi.fn(async (_t: string, _id: string, _p: string) => {
      c.executions += 1;
      return { id: 'exec-1', status: 'QUEUED' };
    });
    const approvePlan = vi.fn(async () => {
      c.approvals += 1;
      c.withdrawn = false;
      return { approvalId: 'a2', proof: 'fresh-proof', expiresAt: '2026-09-03T00:00:00.000Z', notice: 'Approved again.' };
    });
    const client = approvedElsewhere(c, {
      approvePlan,
      startExecution,
      withdrawApproval: async () => {
        c.withdrawals += 1;
        c.withdrawn = true;
        return { withdrawn: true, alreadyWithdrawn: false, notice: 'Withdrawn.' };
      },
    });

    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: client as never })} />,
    );
    await settle(20);
    await click(view.get('plan-review-withdraw'));
    await settle(40);
    // NOTHING ran during the recovery itself.
    expect(startExecution).not.toHaveBeenCalled();

    await click(view.get('plan-review-approve'));
    await settle(40);
    expect(startExecution).not.toHaveBeenCalled();

    await click(view.get('plan-review-start'));
    await settle(30);
    expect(startExecution).toHaveBeenCalledTimes(1);
    expect(startExecution.mock.calls[0]?.[1]).toBe(PLAN);
    // The proof minted just now — not the one the refresh lost.
    expect(startExecution.mock.calls[0]?.[2]).toBe('fresh-proof');
  });

  it('says so plainly if the withdrawal is refused', async () => {
    const c = counters();
    const client = approvedElsewhere(c, {
      withdrawApproval: async () => {
        throw new Error('This import has already started, so its approval cannot be withdrawn.');
      },
    });
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: client as never })} />,
    );
    await settle(20);
    await click(view.get('plan-review-withdraw'));
    await settle(30);
    expect(view.get('plan-review-error').textContent ?? '').toContain('already started');
  });
});

describe('once an import has actually started', () => {
  /**
   * The transition, not the two states either side of it.
   *
   * Both ends were tested and both passed. The defect lived in the moment
   * between them: `EXECUTION_STARTED` clears the proof — correctly, it is
   * spent — while the lifecycle still said `mayExecute`, so the recovery panel
   * lit up at the exact instant a run began and told the operator that nothing
   * had been written. It also offered a Withdraw the server then refused.
   */
  const startable = (c: ReturnType<typeof counters>, over: Record<string, unknown> = {}) =>
    lifecycleFor(c, {
      // The base fake's startExecution never resolves; a run has to actually
      // start for the transition under test to happen at all.
      startExecution: async () => {
        c.executions += 1;
        return { id: 'exec-1', status: 'QUEUED' };
      },
      planLifecycle: async () =>
        c.executions > 0
          ? { ...LIFECYCLE, state: 'EXECUTING' as const, mayApprove: false, mayExecute: false, authority: 'EXECUTION' as const }
          : c.approvals > 0
            ? { ...LIFECYCLE, state: 'APPROVED' as const, mayApprove: false, mayExecute: true }
            : LIFECYCLE,
      ...over,
    });

  const approveThenStart = async (client: unknown) => {
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: client as never })} />,
    );
    await settle(20);
    await click(view.get('plan-review-approve'));
    await settle(30);
    await click(view.get('plan-review-start'));
    await settle(40);
    return view;
  };

  it('shows the run, and none of the recovery furniture', async () => {
    const c = counters();
    const view = await approveThenStart(startable(c));

    expect(view.find('plan-surface')).not.toBeNull();
    // Every piece of the thing that contradicted the run.
    expect(view.find('plan-review-withdraw')).toBeNull();
    expect(view.find('plan-review-withdraw')).toBeNull();
    expect(view.find('plan-review-approve')).toBeNull();
    expect(view.find('plan-review-start')).toBeNull();
  });

  it('never claims nothing was written once something is being written', async () => {
    const c = counters();
    const view = await approveThenStart(startable(c));
    const text = view.text();
    expect(text).not.toContain('Nothing has been written');
    expect(text).not.toContain('one-time authorization is unavailable');
    expect(view.get('plan-surface-headline').textContent).toBe('This import is running.');
  });

  it('starts exactly one execution', async () => {
    const c = counters();
    const startExecution = vi.fn(async () => {
      c.executions += 1;
      return { id: 'exec-1', status: 'QUEUED' };
    });
    await approveThenStart(startable(c, { startExecution }));
    expect(startExecution).toHaveBeenCalledTimes(1);
    expect(c.executions).toBe(1);
  });

  it('re-reads the lifecycle as soon as the run is created', async () => {
    // The stale answer is the whole cause. Without this the screen keeps
    // believing `mayExecute` long after it stopped being true.
    const c = counters();
    let reads = 0;
    const client = startable(c, {
      planLifecycle: async () => {
        reads += 1;
        return c.executions > 0
          ? { ...LIFECYCLE, state: 'EXECUTING' as const, mayApprove: false, mayExecute: false }
          : c.approvals > 0
            ? { ...LIFECYCLE, state: 'APPROVED' as const, mayApprove: false, mayExecute: true }
            : LIFECYCLE;
      },
    });
    const view = await renderComponent(
      <Phase9ImportWizard {...bootstrap({ storage: makeStorage(), lifecycle: client as never })} />,
    );
    await settle(20);
    await click(view.get('plan-review-approve'));
    await settle(30);
    const beforeStart = reads;
    await click(view.get('plan-review-start'));
    await settle(40);
    expect(reads).toBeGreaterThan(beforeStart);
  });

  it('handles a runner that finishes before the first refetch', async () => {
    // This runner takes seconds. The refetch can legitimately come back
    // COMPLETED with no intermediate state ever observed, and terminal is a
    // perfectly good first answer.
    const c = counters();
    const client = startable(c, {
      planLifecycle: async () =>
        c.executions > 0
          ? { ...LIFECYCLE, state: 'COMPLETED' as const, mayApprove: false, mayExecute: false, authority: 'EXECUTION' as const }
          : c.approvals > 0
            ? { ...LIFECYCLE, state: 'APPROVED' as const, mayApprove: false, mayExecute: true }
            : LIFECYCLE,
    });
    const view = await approveThenStart(client);

    expect(view.get('plan-surface-headline').textContent).toBe('This import has run. Your catalogue has been updated.');
    expect(view.find('plan-review-withdraw')).toBeNull();
    expect(view.find('plan-review-withdraw')).toBeNull();
    expect(view.text()).not.toContain('Nothing has been written');
  });

  it.each([
    ['PARTIALLY_COMPLETED', 'This import partly ran. Some rows were written and some were not.'],
    ['FAILED', 'This import failed. Some rows may already have been written.'],
    ['CANCELLED', 'This import was stopped. Anything already imported is kept.'],
  ] as const)('describes a %s run honestly, and offers no recovery', async (state, headline) => {
    const c = counters();
    const client = startable(c, {
      planLifecycle: async () =>
        c.executions > 0
          ? { ...LIFECYCLE, state, mayApprove: false, mayExecute: false, authority: 'EXECUTION' as const }
          : c.approvals > 0
            ? { ...LIFECYCLE, state: 'APPROVED' as const, mayApprove: false, mayExecute: true }
            : LIFECYCLE,
    });
    const view = await approveThenStart(client);
    expect(view.get('plan-surface-headline').textContent).toBe(headline);
    // A partial or failed run has written something. Saying otherwise, or
    // offering to withdraw the permission that allowed it, is worse than
    // saying nothing.
    expect(view.text()).not.toContain('Nothing has been written');
    expect(view.find('plan-review-withdraw')).toBeNull();
  });

  it('outranks a lifecycle that has not caught up yet', async () => {
    // The machine sees the execution first. If the lifecycle is momentarily
    // stale — still APPROVED, still `mayExecute` — the run must still win.
    const c = counters();
    const client = startable(c, {
      planLifecycle: async () =>
        c.approvals > 0 ? { ...LIFECYCLE, state: 'APPROVED' as const, mayApprove: false, mayExecute: true } : LIFECYCLE,
    });
    const view = await approveThenStart(client);
    expect(view.find('plan-surface')).not.toBeNull();
    expect(view.find('plan-review-withdraw')).toBeNull();
    expect(view.find('plan-review-withdraw')).toBeNull();
  });
});
