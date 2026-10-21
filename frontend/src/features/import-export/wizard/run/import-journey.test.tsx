import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { renderComponent, click, cleanupAll, flush, select } from '../../../../test/render';
import { PREVIEW_DEBOUNCE_MS } from '../mapping-editor/mapping-editor';
import { Phase9ImportWizard } from '../phase9/import-wizard';
import { wizardService } from '../api/wizard.service';
import type { AnalysisSummary, ExecutionStatus } from '../api/lifecycle.service';

/**
 * The whole journey, driven through the components a person actually uses.
 *
 * Not a unit test of the reducer — that is beside this file — but the wiring
 * between it and the lifecycle routes: does opening a source start an analysis,
 * does a finished analysis become an editable mapping, does approving produce a
 * proof that is spent exactly once, does the screen keep telling the truth
 * while the run goes on.
 *
 * The server is a scripted fake rather than a mock library. Every method
 * records what it was called with, so a test can assert on the REQUEST — which
 * is where the tenancy and single-use properties actually live — and not only
 * on what came back.
 */

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const NOW = 1_800_000_000_000;

const CONTRACT = {
  version: '1.0.0',
  supportedTransformations: ['TRIM'],
  issueSeverities: {},
  transformations: [],
};

const ANALYSIS: AnalysisSummary = {
  id: 'analysis-1',
  sourceId: SOURCE_ID,
  status: 'COMPLETED',
  tables: {
    sheet: 'Productos',
    headerRow: 1,
    headers: ['Nombre', 'Precio'],
    sample: {
      headers: ['Nombre', 'Precio'],
      rows: [['Silla de roble', '120,50']],
      firstRowNumber: 2,
      sheet: 'Productos',
    },
    columnTypes: ['TEXT', 'DECIMAL'],
  },
  proposals: [
    { columnIndex: 0, header: 'Nombre', field: 'name', confidence: 0.94, reasons: ['The heading matches "nombre".'] },
    { columnIndex: 1, header: 'Precio', field: 'price', confidence: 0.9, reasons: ['The heading matches "precio".'] },
  ],
  findings: [],
  rowsAnalyzed: 1,
  failureReason: null,
};

const RUNNING: ExecutionStatus = {
  id: 'exec-1',
  planId: 'plan-1',
  status: 'RUNNING',
  batchesCompleted: 1,
  batchesTotal: 2,
  rows: { created: 3, updated: 0, skipped: 0, failed: 0 },
  cancelRequested: false,
  resumable: false,
  failureReason: null,
  startedAt: '2026-08-26T09:00:00.000Z',
  finishedAt: null,
  checkpoints: [{ batchIndex: 0, firstRow: 2, lastRow: 4, committedAt: '2026-08-26T09:00:01.000Z' }],
};

const FINISHED: ExecutionStatus = {
  ...RUNNING,
  status: 'COMPLETED',
  batchesCompleted: 2,
  rows: { created: 6, updated: 0, skipped: 0, failed: 0 },
  finishedAt: '2026-08-26T09:00:05.000Z',
};

/** A scripted lifecycle server that remembers everything it was asked. */
function fakeLifecycle(script: Partial<Record<string, unknown>> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = <T,>(method: string, args: unknown[], result: T): Promise<T> => {
    calls.push({ method, args });
    return Promise.resolve(result);
  };

  let statuses: ExecutionStatus[] = (script.statuses as ExecutionStatus[]) ?? [RUNNING, FINISHED];
  // How many approvals this fake has issued, so the lifecycle it reports can
  // advance the way the server's does.
  let approvalsMinted = 0;

  const service = {
    calls,
    // The relationships step needs these, and the wizard fails closed without
    // them. A stub that omitted them would be testing a client the product does
    // not have.
    relationshipOptions: async () => ({
      storeId: null,
      stockDestinations: [],
      stores: [],
      existingCategoryNames: [],
    }),
    startAnalysis: (token: string, sourceId: string) =>
      record('startAnalysis', [token, sourceId], { id: 'analysis-1', status: 'QUEUED' }),
    getAnalysis: (token: string, id: string) =>
      record('getAnalysis', [token, id], (script.analysis as AnalysisSummary) ?? ANALYSIS),
    createPlan: (token: string, body: unknown) =>
      record('createPlan', [token, body], {
        id: 'plan-1',
        planHash: 'abcdef0123456789'.repeat(4),
        readiness: { allowed: true },
        outstanding: 0,
        alreadyExisted: false,
        ...(script.plan as object),
      }),
    /**
     * What the server says the plan's state is.
     *
     * The fake must answer this, because the panel fails CLOSED without it —
     * deliberately. A plan whose lifecycle is unknown is not approvable, since
     * assuming the hopeful answer is exactly how an Approve button appeared on
     * an import that had already run.
     */
    planLifecycle: (token: string, planId: string) =>
      record('planLifecycle', [token, planId], {
        planId,
        planHash: 'abcdef0123456789'.repeat(4),
        sourceId: 'source-1',
        importType: 'PRODUCTS',
        storeId: null,
        /*
          The state ADVANCES once an approval has been minted, because that is
          what the real endpoint does.

          This fake used to answer `PREPARED` with `mayExecute: true` for ever —
          a pair the server cannot produce, since it derives both from a single
          projection. The old panel read the boolean and never noticed; the
          consolidated one reads the state, and a fixture describing an
          impossible server is worse than no fixture at all.
        */
        state: approvalsMinted > 0 ? 'APPROVED' : 'PREPARED',
        authority: approvalsMinted > 0 ? 'APPROVAL' : 'PLAN',
        statusIsStale: false,
        storedStatus: approvalsMinted > 0 ? 'APPROVED' : 'DRAFT',
        mayApprove: approvalsMinted === 0,
        mayExecute: approvalsMinted > 0,
        approval: null,
        execution: null,
        ...(script.lifecycle as object),
      }),
    approvePlan: (token: string, planId: string) => {
      // Minting is what advances the lifecycle this fake reports next.
      approvalsMinted++;
      return record('approvePlan', [token, planId], {
        approvalId: 'approval-1',
        proof: 'single-use-proof',
        expiresAt: '2026-08-29T09:00:00.000Z',
        notice: 'This import may be run once.',
      });
    },
    startExecution: (token: string, planId: string, proof: string) =>
      record('startExecution', [token, planId, proof], { id: 'exec-1', status: 'QUEUED' }),
    executionStatus: (token: string, id: string) => {
      calls.push({ method: 'executionStatus', args: [token, id] });
      const next = statuses.length > 1 ? (statuses.shift() as ExecutionStatus) : statuses[0];
      return Promise.resolve(next);
    },
    cancel: (token: string, id: string) =>
      record('cancel', [token, id], {
        requested: true,
        notice: 'The batch that is running now will finish first.',
      }),
    resume: (token: string, id: string) => record('resume', [token, id], { id: 'exec-2', status: 'QUEUED', resumedFromBatch: 1 }),
    rowResults: (token: string, id: string) =>
      record('rowResults', [token, id], [
        {
          sourceTable: 'Productos',
          sourceRow: 2,
          outcome: 'CREATED',
          targetType: 'product',
          targetId: 'product-1',
          matchedBy: null,
          reason: null,
        },
      ]),
    reportSummary: (token: string, id: string) =>
      record('reportSummary', [token, id], {
        headline: '6 products were added.',
        repair: ['Nothing needs fixing.'],
        blocking: 0,
        warning: 0,
        informational: 0,
        unacknowledgedWarnings: 0,
        total: 0,
      }),
    reportCsvPath: (id: string) => `/import/lifecycle/executions/${id}/report.csv`,
    setStatuses: (next: ExecutionStatus[]) => {
      statuses = next;
    },
  };

  return service;
}

/**
 * Let a chain of effects settle.
 *
 * One flush is one microtask, and this journey is several deep: a dispatch
 * schedules an effect, the effect issues a request, the answer dispatches
 * again. Flushing once would leave the screen mid-chain and make a passing
 * assertion an accident of timing.
 */
const settle = async (times = 6): Promise<void> => {
  for (let i = 0; i < times; i++) {
    // The preview is debounced and the run's status is polled on a timer, so
    // settling means advancing the clock as well as draining microtasks.
    await act(async () => {
      vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 10);
    });
    await flush();
  }
};

const bootstrap = (over: Record<string, unknown> = {}) => ({
  availability: 'ALLOWED' as const,
  token: 'token',
  location: { sourceId: SOURCE_ID, importType: 'PRODUCTS' as const },
  sourceStatus: 'AVAILABLE' as const,
  storage: null,
  now: () => NOW,
  pollIntervalMs: 1,
  ...over,
});

afterEach(() => {
  cleanupAll();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(wizardService, 'getContract').mockResolvedValue(CONTRACT as never);
  vi.spyOn(wizardService, 'preview').mockResolvedValue({
    rows: [],
    ignoredColumns: [],
    blankRowCount: 0,
    previewedRows: 1,
    issues: [],
    summary: { blocking: 0, warning: 0, informational: 0, unacknowledgedWarnings: 0, total: 0 },
    readiness: { allowed: true },
  } as never);
});

describe('reading the file', () => {
  it('starts an analysis for the source the link names, and nothing else', async () => {
    const lifecycle = fakeLifecycle();
    await renderComponent(<Phase9ImportWizard {...bootstrap({ lifecycle })} />);
    await flush();

    const started = lifecycle.calls.filter((c) => c.method === 'startAnalysis');
    expect(started).toHaveLength(1);
    expect(started[0].args[1]).toBe(SOURCE_ID);
  });

  it('turns a finished analysis into an editable mapping', async () => {
    const lifecycle = fakeLifecycle();
    const { text, get } = await renderComponent(<Phase9ImportWizard {...bootstrap({ lifecycle })} />);
    await settle();

    expect(text()).toContain('Nombre');
    expect(text()).toContain('Precio');
    // The proposal's REASON travels with it. A mapper who cannot see why a
    // column was matched cannot sensibly disagree with it, which is the whole
    // difference between this and the legacy importer's silent guess.
    expect(get('column-0').textContent).toMatch(/matches "nombre"/i);
  });

  it('says it is reading while the analysis is still running', async () => {
    const lifecycle = fakeLifecycle({ analysis: { ...ANALYSIS, status: 'RUNNING' } });
    const { get } = await renderComponent(<Phase9ImportWizard {...bootstrap({ lifecycle })} />);
    await flush();

    expect(get('analysis-status').textContent).toMatch(/reading your file/i);
  });

  it('shows the reason a file could not be read, in the person’s terms', async () => {
    const lifecycle = fakeLifecycle({
      analysis: {
        ...ANALYSIS,
        status: 'FAILED',
        failureReason: 'This file has changed since it was uploaded. Upload it again to continue.',
      },
    });
    const { get } = await renderComponent(<Phase9ImportWizard {...bootstrap({ lifecycle })} />);
    await flush();

    expect(get('analysis-status').textContent).toContain('Upload it again');
  });

  it('reads nothing at all for someone who may not import', async () => {
    const lifecycle = fakeLifecycle();
    await renderComponent(<Phase9ImportWizard {...bootstrap({ lifecycle, availability: 'FORBIDDEN' })} />);
    await flush();

    expect(lifecycle.calls).toHaveLength(0);
  });
});

describe('preparing, approving and running', () => {
  /** A wizard whose file is read, mapped and previewed — ready to prepare. */
  const readyWizard = async (lifecycle: ReturnType<typeof fakeLifecycle>) => {
    const rendered = await renderComponent(<Phase9ImportWizard {...bootstrap({ lifecycle })} />);
    await settle();
    return rendered;
  };

  it('PROBE diagnostic', async () => {
    const lifecycle = fakeLifecycle();
    const view = await readyWizard(lifecycle);
    await click(view.get('prepare-import'));
    await settle();
    console.log('PROBE calls', JSON.stringify(lifecycle.calls.map((c) => c.method)));
    console.log('PROBE panel', (view.container.querySelector('[data-testid="run-panel"]')?.textContent ?? '').slice(0, 300));
  });

  it('offers nothing to run while a column is still undecided', async () => {
    // A column the analysis could not place. Nothing may run until somebody
    // says what it is or says to leave it out — silence is not a decision, and
    // an unnoticed column is how a price column goes missing.
    const lifecycle = fakeLifecycle({
      analysis: {
        ...ANALYSIS,
        proposals: [
          ...(ANALYSIS.proposals as object[]),
          { columnIndex: 2, header: 'Notas internas', field: null, confidence: 0, reasons: [] },
        ],
      },
    });
    const { find, get } = await renderComponent(<Phase9ImportWizard {...bootstrap({ lifecycle })} />);
    await settle();

    expect(find('prepare-import')?.hasAttribute('disabled')).toBe(true);
    expect(get('run-blocked-reason').textContent).toMatch(/needs a decision: "Notas internas"/i);
  });

  it('lets the import be prepared once every column has been decided', async () => {
    const lifecycle = fakeLifecycle();
    const { get } = await readyWizard(lifecycle);
    expect(get('prepare-import').hasAttribute('disabled')).toBe(false);
  });

  it('creates a plan for the source and mapping on screen', async () => {
    const lifecycle = fakeLifecycle();
    const { get } = await readyWizard(lifecycle);

    await click(get('prepare-import'));
    await settle();

    const created = lifecycle.calls.find((c) => c.method === 'createPlan');
    expect(created).toBeTruthy();
    const body = created!.args[1] as { sourceId: string; importType: string; mapping: { columns: unknown[] } };
    expect(body.sourceId).toBe(SOURCE_ID);
    expect(body.importType).toBe('PRODUCTS');
    expect(body.mapping.columns).toHaveLength(2);
  });

  it('shows the plan’s identity before anybody approves it', async () => {
    const lifecycle = fakeLifecycle();
    const { get } = await readyWizard(lifecycle);
    await click(get('prepare-import'));
    await settle();

    // The hash is what the approval attests to. If the import is questioned
    // later, this is the string that settles which plan was approved.
    expect(get('plan-identity').textContent).toContain('abcdef0123456789');
    expect(get('plan-surface-headline').textContent).toMatch(/nothing has been changed yet/i);
  });

  it('never puts the proof on screen', async () => {
    const lifecycle = fakeLifecycle();
    const { get, text } = await readyWizard(lifecycle);
    await click(get('prepare-import'));
    await settle();
    await click(get('approve-import'));
    await settle();

    expect(text()).not.toContain('single-use-proof');
    expect(get('approval-notice').textContent).toContain('may be run once');
  });

  it('presents the server’s proof when starting, and only then', async () => {
    const lifecycle = fakeLifecycle();
    const { get } = await readyWizard(lifecycle);

    await click(get('prepare-import'));
    await settle();
    expect(lifecycle.calls.some((c) => c.method === 'startExecution')).toBe(false);

    await click(get('approve-import'));
    await settle();
    await click(get('start-import'));
    await settle();

    const started = lifecycle.calls.filter((c) => c.method === 'startExecution');
    expect(started).toHaveLength(1);
    expect(started[0].args[2]).toBe('single-use-proof');
  });

  it('reports progress in ROWS, names batches as the grouping, and says what a checkpoint means', async () => {
    const lifecycle = fakeLifecycle({ statuses: [RUNNING] });
    const { get } = await readyWizard(lifecycle);
    await click(get('prepare-import'));
    await settle();
    await click(get('approve-import'));
    await settle();
    await click(get('start-import'));
    await settle();

    // Rows lead. Reporting a small file as "1 of 6 batches" described a run
    // with exactly one batch and read as though most of the work remained.
    expect(get('rows-progress').textContent).toMatch(/rows? processed/i);
    // Batches are still reported, named as the grouping they are.
    expect(get('batches-progress').textContent).toContain('Committed in 1 of 2 batches');
    expect(get('last-checkpoint').textContent).toMatch(/rows up to 4 are saved/i);
  });

  it('asks to stop without claiming it has stopped', async () => {
    const cancelling = { ...RUNNING, cancelRequested: true };
    const lifecycle = fakeLifecycle({ statuses: [RUNNING] });
    const { get, find } = await readyWizard(lifecycle);
    await click(get('prepare-import'));
    await settle();
    await click(get('approve-import'));
    await settle();
    await click(get('start-import'));
    await settle();

    lifecycle.setStatuses([cancelling]);
    await click(get('cancel-import'));
    await settle();

    expect(lifecycle.calls.some((c) => c.method === 'cancel')).toBe(true);
    expect(get('cancel-notice').textContent).toContain('will finish first');
    expect(get('run-status').textContent).toMatch(/stopping after the batch/i);
    // Still no "stopped" anywhere: work continues until the batch commits.
    expect(find('resume-import')).toBeNull();
  });

  it('offers to continue an interrupted run from where it stopped', async () => {
    const abandoned = { ...RUNNING, status: 'ABANDONED' as const, resumable: true };
    const lifecycle = fakeLifecycle({ statuses: [abandoned] });
    const { get } = await readyWizard(lifecycle);
    await click(get('prepare-import'));
    await settle();
    await click(get('approve-import'));
    await settle();
    await click(get('start-import'));
    await settle();

    expect(get('run-status').textContent).toMatch(/continue it from where it stopped/i);
    await click(get('resume-import'));
    await settle();

    expect(lifecycle.calls.some((c) => c.method === 'resume')).toBe(true);
  });

  it('shows row results and the report only once the run has settled', async () => {
    const lifecycle = fakeLifecycle({ statuses: [FINISHED] });
    const { get } = await readyWizard(lifecycle);
    await click(get('prepare-import'));
    await settle();
    await click(get('approve-import'));
    await settle();
    await click(get('start-import'));
    await settle();

    expect(get('run-status').textContent).toMatch(/finished/i);
    await click(get('show-results'));
    await settle();

    expect(get('row-results').textContent).toContain('Added');
    expect(get('run-report').textContent).toContain('6 products were added');
    // The download is a link the browser navigates, never a blob this page
    // assembles — the response carries the attachment disposition.
    expect(get('download-report').getAttribute('href')).toContain('/report.csv');
  });

  /*
    The exact sequence that stranded plan `bcdb9687…`.

    Approving is followed by a lifecycle refetch, and React re-renders in
    between. The retraction effect used to key on the identity of the editor's
    state objects rather than their values, so an ordinary re-render in that
    window discarded the plan, the approval and the single-use proof — leaving
    the server reporting APPROVED and the screen offering nothing at all.
  */
  it('keeps an UNAPPROVED plan through re-renders that change no decision', async () => {
    // The value comparison, pinned on its own.
    //
    // Once a plan is approved the reducer refuses to retract it, so that guard
    // hides this one. Before approval there is no such protection: a retraction
    // keyed on object identity discards the prepared plan on any re-render, and
    // the screen falls back to "Review import plan" as though nothing had been
    // built. This is the case where only the value comparison saves it.
    const lifecycle = fakeLifecycle();
    const rendered = await readyWizard(lifecycle);
    await click(rendered.get('prepare-import'));
    await settle();

    expect(rendered.get('plan-identity').textContent).toContain('abcdef0123456789');
    const plansBefore = lifecycle.calls.filter((c) => c.method === 'createPlan').length;

    // Re-renders and refetches, with nothing edited.
    await settle();
    await settle();
    await flush();

    // Still the same prepared plan, and no second one was built to replace a
    // plan that was never lost.
    expect(rendered.get('plan-identity').textContent).toContain('abcdef0123456789');
    expect(rendered.find('prepare-import')).toBeNull();
    expect(rendered.container.querySelector('[data-plan-action="APPROVE"]')).not.toBeNull();
    expect(lifecycle.calls.filter((c) => c.method === 'createPlan').length).toBe(plansBefore);
  });

  it('keeps Start and the proof through re-renders and refetches after approving', async () => {
    const lifecycle = fakeLifecycle();
    const rendered = await readyWizard(lifecycle);
    await click(rendered.get('prepare-import'));
    await settle();
    await click(rendered.get('approve-import'));
    await settle();
    expect(rendered.find('start-import')).toBeTruthy();

    const approvalsBefore = lifecycle.calls.filter((c) => c.method === 'approvePlan').length;

    // Several rounds of exactly the thing that used to destroy it: re-renders
    // and the refetches they carry, with nothing edited.
    await settle();
    await settle();
    await flush();

    // Still runnable, and still the SAME approval — no second proof was minted
    // to paper over a lost one.
    expect(rendered.find('start-import')).toBeTruthy();
    expect(rendered.container.querySelector('[data-plan-action="START"]')).not.toBeNull();
    expect(lifecycle.calls.filter((c) => c.method === 'approvePlan').length).toBe(approvalsBefore);

    // And the proof is genuinely still in hand: starting spends it.
    await click(rendered.get('start-import'));
    await settle();
    const started = lifecycle.calls.filter((c) => c.method === 'startExecution');
    expect(started).toHaveLength(1);
    expect(started[0].args[2]).toBe('single-use-proof');
  });

  it('never leaves an approved plan with no action at all', async () => {
    // The invariant, driven through the real component rather than asserted on
    // the projection alone: whatever happens after approval, the screen offers
    // something.
    const lifecycle = fakeLifecycle();
    const rendered = await readyWizard(lifecycle);
    await click(rendered.get('prepare-import'));
    await settle();
    await click(rendered.get('approve-import'));
    await settle();

    for (let i = 0; i < 3; i++) {
      await settle();
      await flush();
      const actions = rendered.container.querySelectorAll('[data-plan-action]');
      const status = rendered.find('plan-surface-headline');
      expect(actions.length > 0 || status !== null).toBe(true);
    }
  });

  it('mints one approval however fast the button is pressed twice', async () => {
    const lifecycle = fakeLifecycle();
    const rendered = await readyWizard(lifecycle);
    await click(rendered.get('prepare-import'));
    await settle();

    // Both presses land before the first request answers.
    const button = rendered.get('approve-import');
    button.click();
    button.click();
    await settle();

    expect(lifecycle.calls.filter((c) => c.method === 'approvePlan')).toHaveLength(1);
  });

  it('keeps an approved plan and its proof when the mapping is edited', async () => {
    const lifecycle = fakeLifecycle();
    const rendered = await readyWizard(lifecycle);
    await click(rendered.get('prepare-import'));
    await settle();
    await click(rendered.get('approve-import'));
    await settle();
    expect(rendered.find('start-import')).toBeTruthy();

    // An edit to an APPROVED plan no longer retracts it silently. The approval
    // is a single-use proof held in memory and nowhere else, and discarding it
    // left the plan APPROVED on the server with no way to run it from anywhere.
    // Changing it now goes through withdrawal, which is explicit and audited.
    await select(rendered.get('column-1').querySelector('select'), '');
    await flush();

    expect(rendered.find('start-import')).toBeTruthy();
    expect(rendered.container.querySelector('[data-plan-action="START"]')).not.toBeNull();
  });
});
