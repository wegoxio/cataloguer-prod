import React from 'react';
import { act } from 'react';
import { renderComponent } from '../../../../test/render';
import { useImportRun, type LifecycleClient } from './use-import-run';
import type { PlanLifecycle } from '../api/lifecycle.service';
import type { RunState } from './run-machine';
import type { RunActions } from './run-panel';

/**
 * The run hook, driven directly.
 *
 * These cases are about what a HANDLER does when the machine holds nothing —
 * which no rendered surface can express, because the surface offers the control
 * from the server's answer and knows nothing about the machine's internals.
 */

export async function renderHook({
  service,
  lifecycle,
}: {
  service: Partial<LifecycleClient>;
  lifecycle: PlanLifecycle;
}) {
  let latest: { run: RunState; actions: RunActions } | null = null;

  function Probe() {
    const { run, actions, dispatch } = useImportRun(
      {
        token: 't',
        sourceId: 'source-1',
        importType: 'PRODUCTS',
        mapping: { sheet: 'main', headerRow: 1, columns: [] } as never,
        sample: null as never,
        columnTypes: [],
        storeId: undefined,
        acknowledgedIssueCodes: [],
        relationships: {},
      } as never,
      { service: service as LifecycleClient, pollIntervalMs: 100_000 },
    );
    // The server's answer, as the plan-review route supplies it.
    React.useEffect(() => {
      dispatch({ type: 'LIFECYCLE_OBSERVED', lifecycle });
    }, [dispatch]);
    latest = { run, actions };
    return null;
  }

  // Rendered through the shared harness so the root is registered for
  // `cleanupAll`. A probe that mounts its own root survives the test that
  // created it, keeps re-rendering, and pollutes everything after it — which
  // is exactly what these cases then reported as failures elsewhere.
  await renderComponent(<Probe />);
  // One more flush, so the LIFECYCLE_OBSERVED effect has dispatched and the
  // refs the handlers read have been rewritten by the resulting render.
  await act(async () => {});

  return {
    actions: () => latest!.actions,
    state: () => latest!.run,
    act: async (fn: () => void) => { await act(async () => { fn(); }); await act(async () => {}); },
  };
}
