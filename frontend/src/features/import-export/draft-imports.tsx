'use client';

import React from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { lifecycleService, type DraftImport } from './wizard/api/lifecycle.service';
import { encodeWizardLocation } from './wizard/mapping/wizard-location';
import { loadProgress, type ProgressStorage } from './wizard/mapping/progress-store';

/**
 * The imports this company has started, and how to get back to one.
 *
 * `Save and exit` existed for a release with nowhere to return to: it wrote a
 * draft to browser storage and navigated to a page that said nothing about it.
 * A save action with no reopening surface is not a feature, it is a promise the
 * product does not keep.
 *
 * The honest split, stated on screen rather than implied:
 *
 *  - the SOURCE and its reading are on the server, so they appear here on any
 *    device, for anybody in the company who may import;
 *  - the MAPPING DECISIONS are in this browser's storage and nowhere else.
 *
 * So a row can offer to resume a file while telling you plainly that the
 * half-finished mapping you made on another machine is not coming with it.
 * Reopening the SAME source is still the right thing — it costs a re-map, not a
 * duplicate upload, and duplicating the upload is what people do when a product
 * hides the file they already sent.
 */

/**
 * What a row from a NEWER server looks like.
 *
 * Deliberately inert: named, never openable, offering no action. Guessing that
 * an unrecognised stage is safe to open is how a build would route somebody
 * into a screen it does not understand.
 */
const UNKNOWN_STAGE = {
  label: 'Not available in this version',
  open: 'NONE' as const,
  action: '',
  detail: 'This import is in a state this page does not recognise yet. Reload the page to pick up the latest version.',
};

const STAGES: Record<DraftImport['stage'], { label: string; open: 'NONE' | 'MAPPING' | 'PLAN'; action: string; detail: string }> = {
  UPLOADING: {
    label: 'Waiting for the file',
    open: 'NONE',
    action: '',
    detail: 'The upload has not finished, so there is nothing to open yet.',
  },
  READING: { label: 'Reading the file', open: 'MAPPING', action: 'Resume', detail: 'We are still reading this file.' },
  MAPPING_IN_PROGRESS: {
    label: 'Mapping in progress',
    open: 'MAPPING',
    action: 'Resume',
    detail: 'The columns have been read. The mapping decisions are saved in this browser.',
  },
  PLAN_REVIEW: {
    label: 'Ready to review',
    open: 'PLAN',
    action: 'Resume',
    detail: 'A plan is prepared and waiting to be approved.',
  },
  APPROVED_PENDING: {
    label: 'Approved, not started',
    open: 'PLAN',
    action: 'Open',
    detail: 'Approved and waiting to run. Open it to start it, or to withdraw the approval.',
  },
  /*
    Every stage below HAS a plan, and every one of them is openable.

    They were all `open: 'NONE'` with no action. That made a finished import
    unreachable from the only page that lists it — the results had moved onto
    the plan surface and there was no way to get there. `bcdb9687…` ran
    correctly and its operator could not open it.

    RECOVERY was worse than COMPLETED: the plan surface offers `Continue this
    import` for a partial run, and nothing could reach the surface to press it.

    The listing decides only REACHABILITY. What may be done once the plan is
    open is the shared projection's answer, not this table's — so a link here
    can never grant an action, and an inert row can never hide one.
  */
  ACTIVE: {
    label: 'Importing',
    open: 'PLAN',
    action: 'View progress',
    detail: 'This import is running. Open it to watch it, or to stop it.',
  },
  COMPLETED: {
    label: 'Imported',
    open: 'PLAN',
    action: 'View results',
    detail: 'This import has run. Open it to see what each row did.',
  },
  RECOVERY: {
    label: 'Needs attention',
    open: 'PLAN',
    action: 'View results',
    detail: 'This run did not finish cleanly. Open it to see how far it got, and to continue it if it can be.',
  },
  CANCELLED: {
    label: 'Cancelled',
    open: 'PLAN',
    action: 'View results',
    detail: 'This import was cancelled. Anything written before it stopped is kept.',
  },
};


/**
 * What a run did, in one line.
 *
 * Zero counts are omitted rather than printed: "0 added, 0 updated, 1 left
 * unchanged" reads as three facts when it is one. A run that touched nothing at
 * all says so explicitly, because a blank line would be indistinguishable from
 * a summary that failed to load.
 */
function summarise(item: DraftImport): string {
  const parts: string[] = [];
  if (item.rowsCreated) parts.push(`${item.rowsCreated} added`);
  if (item.rowsUpdated) parts.push(`${item.rowsUpdated} updated`);
  if (item.rowsSkipped) parts.push(`${item.rowsSkipped} left unchanged`);
  if (item.rowsFailed) parts.push(`${item.rowsFailed} could not be imported`);
  return parts.length ? parts.join(', ') : 'No rows were changed';
}

export function DraftImports({
  token,
  storage = typeof window === 'undefined' ? null : window.localStorage,
  now = () => Date.now(),
  lifecycle = lifecycleService,
}: {
  token: string;
  storage?: ProgressStorage | null;
  now?: () => number;
  lifecycle?: Pick<typeof lifecycleService, 'listSources' | 'cancelSource'>;
}) {
  const activityQuery = useQuery({
    queryKey: ['imports', 'activity'],
    enabled: Boolean(token),
    queryFn: () => lifecycle.listSources(token, { limit: 20 }),
  });
  const state = activityQuery.isPending ? 'LOADING' : activityQuery.isError ? 'FAILED' : 'READY';
  const items = activityQuery.data?.items ?? [];

  if (state === 'LOADING') {
    return (
      <section className="card bg-white p-4" data-testid="draft-imports-loading">
        <p className="text-xs text-slate-600">Looking for imports you have started…</p>
      </section>
    );
  }

  if (state === 'FAILED') {
    return (
      <section className="card bg-white p-4" data-testid="draft-imports-failed">
        <p className="text-xs text-amber-900">We could not load your imports just now. Reload to try again.</p>
      </section>
    );
  }

  if (items.length === 0) return null;

  return (
    <section className="card space-y-3 bg-white p-4" aria-labelledby="drafts-heading" data-testid="draft-imports">
      <div>
        {/*
          Not "Draft imports" any more, because it is not one. This list has
          always carried finished, failed and cancelled imports as well as
          unfinished ones; they were simply unopenable, so the title was wrong in
          a way nobody could act on. Now that every import with a plan can be
          opened, the title says what the list actually is.
        */}
        <h2 id="drafts-heading" className="text-sm font-bold text-slate-800">
          Import activity
        </h2>
        <p className="mt-1 text-xs text-slate-600">
          Every import you have started: unfinished ones you can pick up, and finished ones you can open to see what
          they did. The files themselves are kept on our servers;{' '}
          <span className="font-medium">the mapping decisions you make are saved in this browser only.</span>
        </p>
      </div>

      <ul className="space-y-2" data-testid="draft-list">
        {items.map((item) => {
          // A stage this build has never heard of must not take the page down
          // with it. Version skew is normal — the server deploys separately and
          // can be ahead — and an unguarded lookup here threw `Cannot read
          // properties of undefined (reading 'label')`, which killed the whole
          // listing and every unrelated import on it. The unknown row degrades
          // to something readable and inert instead.
          const stage = STAGES[item.stage] ?? UNKNOWN_STAGE;
          const saved = storage ? loadProgress(storage, item.sourceId, now()) : null;
          /*
            A PLAN stage with no plan has nowhere to go.

            Cancelling a source before a plan was ever built leaves exactly
            that, and a link built from the source alone would open the mapping
            editor under a label promising results — a destination this row
            cannot honour. It says so instead.
          */
          const reachable = stage.open === 'MAPPING' || (stage.open === 'PLAN' && Boolean(item.planId));
          return (
            <li
              key={item.sourceId}
              className="flex flex-wrap items-center justify-between gap-3 rounded border border-slate-200 p-3"
              data-testid={`draft-${item.sourceId}`}
            >
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-slate-800">{item.fileName}</p>
                <p className="text-xs text-slate-600">
                  {item.importType ? `${item.importType.toLowerCase().replace(/_/g, ' ')} · ` : ''}
                  <span data-testid={`draft-stage-${item.sourceId}`}>{stage.label}</span>
                  {' · '}
                  {/* When it last DID something, not when the file was uploaded.
                      A run watched five minutes ago should not be dated by a
                      file chosen last week. */}
                  {new Date(item.activityAt ?? item.updatedAt).toLocaleString()}
                </p>

                {/*
                  What the run did, where the run exists.

                  This is the whole of what the retired history page promised
                  and never delivered: rows in, and what happened to each of
                  them. It reads the execution's own counters, so it cannot
                  disagree with the row-by-row table the link opens.
                */}
                {item.executionId ? (
                  <p className="text-xs text-slate-600" data-testid={`draft-summary-${item.sourceId}`}>
                    {summarise(item)}
                  </p>
                ) : null}
                <p className="text-xs text-slate-500" data-testid={`draft-detail-${item.sourceId}`}>
                  {stage.detail}
                  {stage.open === 'PLAN' && !item.planId ? (
                    <span data-testid={`draft-no-plan-${item.sourceId}`}>
                      {' '}
                      No plan was ever built for this file, so there is nothing to open.
                    </span>
                  ) : null}
                  {stage.open === 'MAPPING' && !saved ? (
                    // Said plainly, because the alternative is somebody
                    // uploading the same file again to get their work back.
                    <span data-testid={`draft-local-missing-${item.sourceId}`}>
                      {' '}
                      This source is available, but its unfinished mapping was saved in another browser or has expired.
                      You can map it again.
                    </span>
                  ) : null}
                </p>
              </div>

              <div className="flex shrink-0 gap-2">
                {reachable ? (
                  <Link
                    href={`/dashboard/import-export/wizard${encodeWizardLocation({
                      sourceId: item.sourceId,
                      // A plan to review, when there is one. The stage and the
                      // destination are computed from the same field so they
                      // cannot disagree — saying one thing and doing another is
                      // exactly what was rejected.
                      ...(stage.open === 'PLAN' && item.planId ? { planId: item.planId } : {}),
                      ...(item.importType ? { importType: item.importType as never } : {}),
                    })}`}
                    className="rounded bg-sky-700 px-3 py-1.5 text-xs font-semibold text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                    data-testid={`draft-resume-${item.sourceId}`}
                  >
                    {/* The verb belongs to the stage. "Resume" over a finished
                        import is a promise the destination cannot keep. */}
                    {stage.action}
                  </Link>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
