'use client';

import React from 'react';
import { lifecycleService } from '../api/lifecycle.service';
import type { ImportType } from '../api/lifecycle.service';
import type { TableMapping, SourceSample } from '../api/wizard-contract.types';
import { initialRunState, runReducer, shouldPoll } from './run-machine';
import type { RunState } from './run-machine';
import type { RunActions } from './run-panel';

/**
 * The wizard's side of the lifecycle: the calls, and when to make them.
 *
 * The reducer beside this file holds every rule; this holds only the plumbing,
 * which is deliberate — the rules are the part worth testing without a DOM, and
 * plumbing that also decides things is plumbing nobody can test.
 *
 * Polling is chained rather than scheduled on an interval. An interval fires
 * whether or not the previous request came back, so a slow status call under a
 * short interval piles up requests against a server that is already busy
 * importing; chaining the next poll to the previous answer keeps exactly one
 * in flight.
 */

export type LifecycleClient = Pick<
  typeof lifecycleService,
  | 'createPlan'
  | 'approvePlan'
  | 'startExecution'
  | 'executionStatus'
  | 'cancel'
  | 'resume'
  | 'rowResults'
  | 'reportSummary'
  | 'reportCsvPath'
  | 'planLifecycle'
>;

export interface RunInputs {
  token: string;
  sourceId: string;
  importType: ImportType;
  mapping: TableMapping;
  sample: SourceSample | null;
  columnTypes: string[];
  relationships?: unknown;
  storeId?: string;
  acknowledgedIssueCodes: string[];
}

export interface RunOptions {
  service?: LifecycleClient;
  pollIntervalMs?: number;
  /** Injected so tests drive the clock instead of waiting on it. */
  schedule?: (fn: () => void, ms: number) => unknown;
  unschedule?: (handle: unknown) => void;
}

const FALLBACK = 'The import could not be prepared. Nothing in your catalogue has changed.';

function messageFrom(error: unknown, fallback = FALLBACK): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useImportRun(
  inputs: RunInputs,
  {
    service = lifecycleService,
    pollIntervalMs = 2000,
    schedule = (fn, ms) => setTimeout(fn, ms),
    unschedule = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  }: RunOptions = {},
): { run: RunState; actions: RunActions; dispatch: React.Dispatch<Parameters<typeof runReducer>[1]> } {
  const [run, dispatch] = React.useReducer(runReducer, undefined, initialRunState);

  // The inputs change on every keystroke in the editor. Held in a ref so the
  // callbacks below stay stable — recreating them would restart the poll chain
  // on every edit, and a poll chain that restarts is a poll chain that can run
  // twice.
  const latest = React.useRef(inputs);
  latest.current = inputs;

  // Ids the callbacks need without depending on them. Same reason as `latest`.
  /**
   * Requests already in flight.
   *
   * A ref, not state: the second click of a double-click arrives before React
   * has re-rendered, so a state flag would still read false and mint a second
   * single-use proof.
   */
  const inFlight = React.useRef({ approve: false, execute: false, results: false });
  const planIdRef = React.useRef<string | null>(null);
  planIdRef.current = run.plan?.id ?? null;
  const proofRef = React.useRef<string | null>(null);
  proofRef.current = run.proof;
  const resultsLoadedRef = React.useRef(false);
  resultsLoadedRef.current = run.resultsLoaded;
  const executionIdRef = React.useRef<string | null>(null);
  /*
    The run this plan has, from whichever source knows about it.

    The machine's execution is TRANSIENT: it exists only if this tab started
    the run. The lifecycle's is durable and survives a reload, a new tab and a
    different day. Reading only the machine is why View results, Stop and
    Continue were silent no-ops on a reopened plan — the action was offered
    from the server's answer and the handler looked somewhere else.

    The machine wins when both are present: it is the run just started, and for
    the width of one round trip the lifecycle still describes the previous one.
  */
  executionIdRef.current = run.execution?.id ?? run.lifecycle?.execution?.id ?? null;

  const createPlan = React.useCallback(() => {
    const current = latest.current;
    if (!current.sample) return;
    dispatch({ type: 'PLAN_REQUESTED' });
    void service
      .createPlan(current.token, {
        sourceId: current.sourceId,
        importType: current.importType,
        mapping: current.mapping,
        relationships: current.relationships,
        sample: current.sample,
        columnTypes: current.columnTypes,
        storeId: current.storeId,
        acknowledgedIssueCodes: current.acknowledgedIssueCodes,
      })
      .then((plan) => {
        dispatch({ type: 'PLAN_CREATED', plan });
        // Ask what this plan's state REALLY is before anything is offered.
        //
        // Plans are content-addressed: identical bytes and identical decisions
        // resolve to the same plan, deliberately. So "just prepared" can mean
        // "found the one from two days ago" — already run, behind an approval
        // already spent. The plan row cannot say so, because nothing advances
        // its status column; that is how an Approve button ended up on a
        // finished import.
        //
        // Its own promise, NOT chained into the outer catch: a lifecycle that
        // fails to load must leave the panel offering nothing, not report the
        // plan itself as failed.
        void service
          .planLifecycle(current.token, plan.id)
          .then((lifecycle) => dispatch({ type: 'LIFECYCLE_OBSERVED', lifecycle }))
          .catch(() => {
            // Fails CLOSED: no approval control while the lifecycle is
            // unknown, rather than assuming the hopeful answer.
          });
      })
      .catch((error) => dispatch({ type: 'FAILED', message: messageFrom(error) }));
  }, [service]);

  const approve = React.useCallback(() => {
    const planId = planIdRef.current;
    // FAIL VISIBLY. This returned silently, and a plan opened for review never
    // reached the machine — so the button rendered, the handler ran, and
    // nothing happened at all: no request, no state change, no error. A person
    // pressing it had no way to tell it from a slow network.
    if (!planId) {
      dispatch({
        type: 'FAILED',
        message: 'This import could not be approved because the plan is not loaded. Reopen it and try again.',
      });
      return;
    }
    // One approval per press. A second click while the first is in flight
    // would mint a second single-use proof and leave one of them stranded.
    if (inFlight.current.approve) return;
    inFlight.current.approve = true;
    dispatch({ type: 'APPROVAL_REQUESTED' });
    void service
      .approvePlan(latest.current.token, planId)
        .then((approval) => {
          dispatch({ type: 'APPROVAL_GRANTED', approval });
          // Re-ask the server what may be done now.
          //
          // The lifecycle fetched when the plan was prepared said "not
          // executable" — correctly, nothing was approved then. Keeping that
          // answer after approving would leave Start importing hidden behind a
          // fact that is no longer true. The server is asked again rather than
          // inferred from, because approving is exactly the moment its answer
          // changes.
          void service
            .planLifecycle(latest.current.token, planId)
            .then((lifecycle) => dispatch({ type: 'LIFECYCLE_OBSERVED', lifecycle }))
            .catch(() => {
              // Fails CLOSED, as everywhere else.
            });
        })
      .catch((error) =>
        dispatch({
          type: 'FAILED',
          message: messageFrom(error, 'This import could not be approved. Nothing in your catalogue has changed.'),
        }),
      )
      // Released whichever way it ended, so a failure can be retried.
      .finally(() => {
        inFlight.current.approve = false;
      });
  }, [service]);

  const execute = React.useCallback(() => {
    const planId = planIdRef.current;
    const proof = proofRef.current;
    if (!planId || !proof) {
      dispatch({
        type: 'FAILED',
        message: !planId
          ? 'This import could not be started because the plan is not loaded. Reopen it and try again.'
          : 'This import could not be started because its approval is no longer held. Approve it again.',
      });
      return;
    }
    if (inFlight.current.execute) return;
    inFlight.current.execute = true;
    dispatch({ type: 'EXECUTION_REQUESTED' });
    void service
      .startExecution(latest.current.token, planId, proof)
        .then((execution) => {
          dispatch({ type: 'EXECUTION_STARTED', executionId: execution.id });
          // Re-ask at once. Starting a run changes what may be done with this
          // plan, and the answer fetched before it is wrong in the one way that
          // matters: it still says `mayExecute`, which is what left a recovery
          // panel on screen claiming nothing had been written while a run was
          // already writing.
          //
          // It also covers the fast case. This runner finishes in seconds, so
          // the refetch can legitimately come back COMPLETED before any poll,
          // and terminal is a perfectly good first answer.
          void service
            .planLifecycle(latest.current.token, planId)
            .then((lifecycle) => dispatch({ type: 'LIFECYCLE_OBSERVED', lifecycle }))
            .catch(() => {
              // Fails closed: the execution held in state already outranks the
              // recovery panel, with or without this.
            });
        })
      .catch((error) =>
        dispatch({
          type: 'FAILED',
          // Deliberately does NOT promise nothing changed. If the request
          // reached the server and the answer was lost, work may have started,
          // and the status below is what settles it.
          message: messageFrom(error, 'The import could not be started. Check its status before trying again.'),
        }),
      )
      .finally(() => {
        inFlight.current.execute = false;
      });
  }, [service]);

  const cancel = React.useCallback(() => {
    const executionId = executionIdRef.current;
    // FAIL VISIBLY. A silent return here is indistinguishable from a button
    // that does not work — the exact report that opened this correction.
    if (!executionId) {
      dispatch({
        type: 'FAILED',
        message: 'This import could not be stopped because its run is not loaded. Reopen it from your imports and try again.',
      });
      return;
    }
    dispatch({ type: 'CANCEL_REQUESTED' });
    void service
      .cancel(latest.current.token, executionId)
      .then((result) => dispatch({ type: 'CANCEL_ACKNOWLEDGED', notice: result.notice }))
      .catch((error) =>
        dispatch({ type: 'FAILED', message: messageFrom(error, 'The request to stop could not be sent.') }),
      );
  }, [service]);

  const resume = React.useCallback(() => {
    const executionId = executionIdRef.current;
    if (!executionId) {
      dispatch({
        type: 'FAILED',
        message: 'This import could not be continued because its run is not loaded. Reopen it from your imports and try again.',
      });
      return;
    }
    dispatch({ type: 'RESUME_REQUESTED' });
    void service
      .resume(latest.current.token, executionId)
      .then((result) => dispatch({ type: 'EXECUTION_STARTED', executionId: result.id }))
      .catch((error) =>
        dispatch({ type: 'FAILED', message: messageFrom(error, 'This import could not be continued.') }),
      );
  }, [service]);

  const loadResults = React.useCallback(() => {
    const executionId = executionIdRef.current;
    if (!executionId) {
      dispatch({
        type: 'FAILED',
        message: 'These results could not be opened because the run they belong to is not loaded. Reopen this import from your imports list.',
      });
      return;
    }
    // One read per press, and only while there is something to read.
    //
    // Pressing this five times sent five pairs of requests, every one
    // answering 200 onto a screen with nowhere to put them. The rows of a
    // finished run do not change, so a second read cannot say anything new.
    if (inFlight.current.results || resultsLoadedRef.current) return;
    inFlight.current.results = true;
    dispatch({ type: 'RESULTS_REQUESTED' });
    const token = latest.current.token;
    void Promise.all([service.rowResults(token, executionId), service.reportSummary(token, executionId)])
      .then(([rows, report]) => dispatch({ type: 'RESULTS_LOADED', rows, report }))
      .catch((error) =>
        dispatch({ type: 'FAILED', message: messageFrom(error, 'The results could not be loaded.') }),
      )
      .finally(() => {
        inFlight.current.results = false;
      });
  }, [service]);

  // The poll chain. One request in flight, and it stops as soon as the run
  // reaches a state that will not change on its own.
  const polling = shouldPoll(run);
  const executionId = run.execution?.id ?? null;
  React.useEffect(() => {
    if (!polling || !executionId) return;
    let cancelled = false;
    let handle: unknown = null;

    const tick = () => {
      void service
        .executionStatus(latest.current.token, executionId)
        .then((status) => {
          if (cancelled) return;
          dispatch({ type: 'STATUS_OBSERVED', status });
        })
        .catch(() => {
          // A failed poll is not a failed import. The run keeps going on the
          // server whether or not this tab can see it, so the next tick simply
          // tries again rather than reporting a failure that did not happen.
        })
        .finally(() => {
          if (!cancelled) handle = schedule(tick, pollIntervalMs);
        });
    };

    tick();
    return () => {
      cancelled = true;
      if (handle !== null) unschedule(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling, executionId, service, pollIntervalMs]);

  const actions: RunActions = React.useMemo(
    () => ({
      createPlan,
      approve,
      execute,
      cancel,
      resume,
      loadResults,
      /*
        Withdrawal and editing are the WIZARD's to own: one needs the plan id
        from the URL as well as from this machine, the other has to reach the
        mapping editor. This hook can do neither, so it supplies handlers that
        SAY so rather than no-ops.

        A silently-returning handler is the exact failure this correction is
        about. A default that cannot work must still be visible when reached.
      */
      withdraw: () =>
        dispatch({
          type: 'FAILED',
          message:
            'Withdrawing an approval is not available here. Open this import from your imports list and try again.',
        }),
      editMapping: () =>
        dispatch({
          type: 'FAILED',
          message: 'Editing the mapping is not available here. Open this import from your imports list.',
        }),
      /*
        The downloadable report, for whichever run this plan HAS.

        Read from the machine first and the lifecycle second, exactly as the
        handlers do. Reading only the machine meant a reopened plan showed its
        rows and its report and then offered no way to download them, because
        the id the link needed lived on the server and nowhere else.
      */
      reportHref: (() => {
        const id = run.execution?.id ?? run.lifecycle?.execution?.id ?? null;
        return id ? service.reportCsvPath(id) : null;
      })(),
    }),
    [createPlan, approve, execute, cancel, resume, loadResults, dispatch, run.execution, run.lifecycle, service],
  );

  return { run, actions, dispatch };
}
