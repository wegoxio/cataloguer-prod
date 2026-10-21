'use client';

import React from 'react';
import type { RunAction, RunState } from './run-machine';
import { describeRun, proofIsHeld } from './run-machine';
import type { PlanLifecycle, RowResult } from '../api/lifecycle.service';
import { describeEffects } from './row-effects';
import { projectPlanActions, type InFlight } from './plan-actions';
import { PlanSurfaceView } from './plan-surface';

/**
 * The client phase, reduced to the one thing it is still allowed to say.
 *
 * A phase describes a request THIS browser has sent and not yet had answered.
 * That is a real fact and worth rendering — a spinner beats a screen that looks
 * idle while a write is being authorised. It is not a capability, and since
 * this correction it decides none.
 */
function inFlightOf(state: RunState): InFlight {
  switch (state.phase) {
    case 'PLANNING':
      return 'PLANNING';
    case 'APPROVING':
      return 'APPROVING';
    case 'STARTING':
      return 'STARTING';
    case 'CANCELLING':
      return 'CANCELLING';
    default:
      return 'NONE';
  }
}

/**
 * The half of the wizard that writes.
 *
 * Everything above it is reversible — a mapping can be changed, a preview
 * rebuilt, a file replaced. Past the approve button nothing is, so this panel
 * is written to be read rather than clicked through: the plan's identity is on
 * screen before approval, the count of what will change is a sentence rather
 * than a badge, and the progress a person watches is the server's committed
 * batches, not a bar this component animates.
 *
 * Nothing here renders the approval proof. It is a bearer credential for a
 * catalogue-wide write, and a value on screen is a value in a screenshot.
 */

export interface RunActions {
  createPlan: () => void;
  approve: () => void;
  execute: () => void;
  cancel: () => void;
  resume: () => void;
  loadResults: () => void;
  /** Withdraw an approval this browser can no longer spend. */
  withdraw: () => void;
  /** Explicit intent to change the decisions. Never automatic. */
  editMapping: () => void;
  reportHref: string | null;
}

export function RunPanel({
  state,
  readiness,
  actions,
}: {
  state: RunState;
  readiness: { allowed: boolean; reason?: string };
  actions: RunActions;
  dispatch?: React.Dispatch<RunAction>;
}) {
  // What may be done, decided in ONE place.
  //
  // This used to be two booleans read straight off the lifecycle and then
  // `&&`-ed with the client's own phase at each button. The phase and the
  // server disagreed — which is a normal thing for them to do, since one
  // describes this tab and the other describes the plan — and every
  // disagreement rendered as a missing control rather than an explanation.
  const surface = projectPlanActions({
    lifecycle: state.lifecycle,
    proofHeld: proofIsHeld(state),
    inFlight: inFlightOf(state),
    // The machine can know a run exists, and what became of it, before the
    // lifecycle is re-read. It outranks the server's last answer for exactly
    // that window — including when the run was abandoned and can be resumed.
    observedExecution: state.execution
      ? {
          status: state.execution.status,
          resumable: state.execution.resumable,
          cancelRequested: state.execution.cancelRequested,
        }
      : null,
    results: { loaded: state.resultsLoaded, loading: state.resultsLoading },
  });

  return (
    <section className="card bg-white p-4" aria-labelledby="run-heading" data-testid="run-panel">
      <h2 id="run-heading" className="text-sm font-bold text-slate-800">
        Import
      </h2>

      {/*
        The narration of a run THIS tab is watching.

        Only while the machine actually holds an execution. It used to render
        unconditionally from the machine alone, which meant a reopened plan
        whose run had finished days ago was announced as "Nothing has been
        changed yet." — a third status line, disagreeing with the other two.
        What has happened to the plan is the surface's to say; this says how far
        the run in front of you has got.
      */}
      {state.execution ? (
        <p
          className="mt-1 text-xs text-slate-600"
          role="status"
          aria-live="polite"
          data-testid="run-status"
        >
          {describeRun(state)}
        </p>
      ) : null}

      {state.error ? (
        <p className="mt-2 rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-900" role="alert" data-testid="run-error">
          {state.error}
        </p>
      ) : null}

      {state.plan ? (
        <dl className="mt-3 grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-xs" data-testid="plan-identity">
          <dt className="text-slate-500">Import reference</dt>
          {/* The hash is shown because it is what the approval attests to. If
              the plan is questioned later, this is the string that settles
              which plan was approved. */}
          <dd className="font-mono text-slate-700">{state.plan.planHash.slice(0, 16)}</dd>
          {state.plan.alreadyExisted ? (
            <>
              <dt className="text-slate-500">Note</dt>
              <dd className="text-slate-700">
                These exact decisions were already prepared, so this is the same import rather than a second one.
              </dd>
            </>
          ) : null}
          {state.approval ? (
            <>
              <dt className="text-slate-500">Approved until</dt>
              <dd className="text-slate-700">{state.approval.expiresAt}</dd>
            </>
          ) : null}
        </dl>
      ) : null}

      {state.approval?.notice ? (
        <p className="mt-2 text-xs text-slate-600" data-testid="approval-notice">
          {state.approval.notice}
        </p>
      ) : null}

      {state.cancelNotice ? (
        <p className="mt-2 text-xs text-amber-900" data-testid="cancel-notice">
          {state.cancelNotice}
        </p>
      ) : null}

      {state.execution ? <Progress state={state} /> : null}

      {/*
        What the server says about this plan is no longer explained here.

        There used to be a `LifecycleNotice` beside the buttons: one component
        describing the state, another deciding the controls, from the same
        lifecycle by two different rules. They could disagree, and did — the
        notice read APPROVED from the server while the buttons read IDLE from
        the client, so the screen explained a state it then offered no way out
        of. The projection now produces the words AND the actions together, in
        `PlanSurfaceView` below, so they cannot come apart.
      */}

      {/*
        Before a plan exists there is nothing for the shared surface to describe.
        This one button belongs to the EDITOR stage — it builds the plan the
        surface will then govern — so it stays here rather than in a projection
        about a plan that does not exist yet.
      */}
      {!state.plan ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!readiness.allowed}
            onClick={actions.createPlan}
            className="rounded bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white disabled:bg-slate-300 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
            data-testid="prepare-import"
          >
            {/* Not "Confirm import". Nothing is imported by this button: it builds
                a plan to be read. Calling it a confirmation invites somebody to
                click it believing the decision has already been made. */}
            Review import plan
          </button>
        </div>
      ) : (
        /*
          One plan, one surface. The same component the review screen renders,
          from the same projection, with the same handlers — so this route can
          never offer more or less than that one does.
        */
        <div className="mt-3">
          <PlanSurfaceView
            surface={surface}
            handlers={{
              approve: actions.approve,
              start: actions.execute,
              withdraw: actions.withdraw,
              editMapping: actions.editMapping,
              cancelRun: actions.cancel,
              resumeRun: actions.resume,
              viewResults: actions.loadResults,
            }}
            results={{
              rows: state.rows,
              report: state.report,
              reportHref: actions.reportHref,
              loading: state.resultsLoading,
            }}
            ids={{
              APPROVE: 'approve-import',
              START: 'start-import',
              CANCEL_RUN: 'cancel-import',
              RESUME_RUN: 'resume-import',
              VIEW_RESULTS: 'show-results',
            }}
          />
        </div>
      )}

      {!readiness.allowed && state.phase === 'IDLE' && readiness.reason ? (
        <p className="mt-2 text-xs text-slate-500" data-testid="run-blocked-reason">
          {readiness.reason}
        </p>
      ) : null}

      {/* Results are rendered by the shared surface above, not here. Keeping a
          second copy is what let one route answer and the other stay blank. */}
    </section>
  );
}

function Progress({ state }: { state: RunState }) {
  const execution = state.execution!;
  const last = execution.checkpoints[execution.checkpoints.length - 1];
  const settled =
    execution.rows.created + execution.rows.updated + execution.rows.skipped + execution.rows.failed;
  return (
    <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-2 text-xs" data-testid="run-progress">
      {/* Rows are what an operator counted in their file; batches are only how
          we grouped them. A six-row file reported as "1 of 6 batches committed"
          described a run that had exactly ONE batch, and invited the reading
          that five sixths of the work was still to come. Rows lead now, and
          batches are named as the grouping they are. */}
      <p className="text-slate-700" data-testid="rows-progress">
        {settled} {settled === 1 ? 'row' : 'rows'} processed
        {execution.rows.created ? ` · ${execution.rows.created} added` : ''}
        {execution.rows.updated ? ` · ${execution.rows.updated} updated` : ''}
        {execution.rows.skipped ? ` · ${execution.rows.skipped} skipped` : ''}
        {execution.rows.failed ? ` · ${execution.rows.failed} blocked` : ''}.
      </p>
      <p className="mt-0.5 text-slate-600" data-testid="batches-progress">
        {execution.batchesTotal === 1 && execution.batchesCompleted === 1
          ? 'Committed in a single batch.'
          : `Committed in ${execution.batchesCompleted} of ${execution.batchesTotal || '?'} batches.`}
      </p>
      {last ? (
        // The checkpoint, not a percentage. It is the thing that makes a
        // resume safe, and it is the only claim here we can actually stand
        // behind: rows up to this number are written and will not be redone.
        <p className="mt-0.5 text-slate-600" data-testid="last-checkpoint">
          Rows up to {last.lastRow} are saved. If this import is interrupted it continues from there.
        </p>
      ) : null}
    </div>
  );
}






