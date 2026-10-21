'use client';

import React from 'react';
import type { PlanActionId, PlanSurface } from './plan-actions';
import { PlanResults } from './plan-results';
import type { RowResult } from '../api/lifecycle.service';
import type { RunState } from './run-machine';

/**
 * The plan's status and its actions, rendered once.
 *
 * There used to be two of these. `RunPanel` served a plan this browser had just
 * built; `PlanReview` served one loaded from the server by URL. They described
 * the same states in different words and — the part that mattered — offered
 * different controls: the recovery panel for a lost approval proof existed only
 * on the second. A person who prepared and approved in one sitting therefore
 * reached a screen that said "Approved and ready to run" and offered nothing at
 * all, while the identical server state on the other path offered a way out.
 *
 * So both hosts render THIS, from the same projection, with the same handlers.
 * A capability cannot exist on one route and not the other, because there is
 * only one place capabilities are rendered.
 *
 * The `ids` map is the one concession to history: the two hosts carry different
 * `data-testid` vocabularies and a large body of tests reads them. Ids are
 * presentation, not behaviour, so they are allowed to differ — and every button
 * additionally carries `data-plan-action`, which is identical on both routes
 * and is what the lifecycle tests assert on, so no test can accidentally cover
 * one path while believing it covers both.
 */

export interface PlanSurfaceHandlers {
  approve: () => void;
  start: () => void;
  withdraw: () => void;
  editMapping: () => void;
  cancelRun: () => void;
  resumeRun: () => void;
  viewResults: () => void;
}

/** Host-specific `data-testid`s. Presentation only; behaviour is shared. */
export type PlanSurfaceIds = Partial<Record<PlanActionId, string>>;

const LABELS: Record<PlanActionId, string> = {
  APPROVE: 'Approve this import',
  START: 'Start importing',
  WITHDRAW: 'Withdraw approval',
  EDIT_MAPPING: 'Edit mapping',
  CANCEL_RUN: 'Stop this import',
  RESUME_RUN: 'Continue this import',
  VIEW_RESULTS: 'View results',
};

/** Actions that write, or authorise a write. Styled as the primary control. */
const PRIMARY: PlanActionId[] = ['APPROVE', 'START', 'RESUME_RUN'];

export function PlanSurfaceView({
  surface,
  handlers,
  ids = {},
  results,
}: {
  surface: PlanSurface;
  handlers: PlanSurfaceHandlers;
  ids?: PlanSurfaceIds;
  /**
   * What a finished run did, when it has been read.
   *
   * Rendered HERE rather than by each host, for the same reason the actions
   * are: a screen that can ask "what happened?" must be able to show the
   * answer, and leaving that to the host is what made View results inert on
   * one of the two routes.
   */
  results?: { rows: RowResult[]; report: RunState['report']; reportHref: string | null; loading?: boolean };
}) {
  const onAction = (action: PlanActionId) => {
    switch (action) {
      case 'APPROVE':
        return handlers.approve();
      case 'START':
        return handlers.start();
      case 'WITHDRAW':
        return handlers.withdraw();
      case 'EDIT_MAPPING':
        return handlers.editMapping();
      case 'CANCEL_RUN':
        return handlers.cancelRun();
      case 'RESUME_RUN':
        return handlers.resumeRun();
      case 'VIEW_RESULTS':
        return handlers.viewResults();
      default:
        // Unreachable: `PlanActionId` is closed and every member is handled.
        // Kept so a future action added to the union fails loudly in review
        // rather than becoming a button that does nothing.
        throw new Error(`No handler for plan action "${String(action)}"`);
    }
  };

  return (
    <div
      className={`card space-y-2 p-3 ${surface.kind === 'ACTIONABLE' ? 'bg-white' : 'bg-slate-50'}`}
      data-testid="plan-surface"
      data-surface-kind={surface.kind}
      role={surface.kind === 'ACTIONABLE' ? undefined : 'status'}
    >
      <p className="text-xs font-semibold text-slate-800" data-testid="plan-surface-headline">
        {surface.headline}
      </p>
      <p className="text-xs text-slate-600" data-testid="plan-surface-detail">
        {surface.detail}
      </p>

      {/*
        Which row the answer came from, when the plan's stored status disagrees
        with it. Kept because the disagreement is real and permanent: nothing
        advances that column after a run.
      */}
      {surface.provenance ? (
        <p className="text-[11px] text-slate-500" data-testid="lifecycle-authority">
          {surface.provenance}
        </p>
      ) : null}

      {/*
        A contradiction between the server's answer and what this browser holds,
        said out loud. It is never load-bearing — the server has already won by
        the time this renders — but a proof silently discarded is how somebody
        concludes the page is broken rather than that it disagreed with them.
      */}
      {surface.normalized ? (
        <p className="text-[11px] text-slate-500" data-testid="plan-surface-normalized">
          {surface.normalized}
        </p>
      ) : null}

      {/*
        Why editing is safe, said next to the control that does it. Editing
        never rewrites the plan on screen: it prepares a different one, and the
        one being looked at is left exactly as it is.
      */}
      {surface.actions.includes('EDIT_MAPPING') ? (
        <p className="text-xs text-slate-600" data-testid="plan-review-edit-note">
          Editing the mapping prepares a different plan. This one is left exactly as it is.
        </p>
      ) : null}

      {results?.loading ? (
        <p className="text-xs text-slate-600" role="status" data-testid="results-loading">
          Reading what this import did…
        </p>
      ) : null}

      {results && !results.loading ? (
        <PlanResults
          rows={results.rows}
          report={results.report}
          /*
            The download is offered only once the run has ENDED. A report
            fetched mid-run describes a run that is still writing, and a
            spreadsheet that says "this is what happened" while more is
            happening is worse than no spreadsheet. The rule lives here so both
            hosts inherit it rather than each remembering it.
          */
          reportHref={surface.kind === 'TERMINAL' ? results.reportHref : null}
        />
      ) : null}

      {surface.actions.length > 0 ? (
        <div className="flex flex-wrap gap-2 pt-1" data-testid="plan-surface-actions">
          {surface.actions.map((action) => (
            <button
              key={action}
              type="button"
              onClick={() => onAction(action)}
              data-testid={ids[action] ?? `plan-action-${action.toLowerCase()}`}
              data-plan-action={action}
              className={
                PRIMARY.includes(action)
                  ? 'rounded bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600'
                  : 'rounded border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600'
              }
            >
              {LABELS[action]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
