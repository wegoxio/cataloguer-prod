import { describe, expect, it } from 'vitest';
import {
  projectPlanActions,
  surfaceIsHabitable,
  type InFlight,
  type PlanActionId,
  type PlanSurface,
} from './plan-actions';
import type { PlanLifecycle } from '../api/lifecycle.service';

/**
 * The projection, over every state an import can actually be in.
 *
 * The rule this file exists to keep is narrow and absolute: **no reachable
 * state renders nothing**. Either something can be done, or the screen says
 * plainly that nothing needs doing. The state that produced neither is the one
 * that stranded plan `bcdb9687…` — "Approved and ready to run", no controls, no
 * explanation, and no route forward from the page a person was looking at.
 *
 * Reachable is doing real work in that sentence. The cross product of every
 * lifecycle state, every proof, every in-flight request and every observed run
 * contains combinations the server cannot produce — a consumed approval with no
 * execution behind it, a proof held for a plan that was never approved. Those
 * are not tested for habitability, because forcing an action onto an impossible
 * state would be inventing a capability to satisfy a test. They are tested for
 * something stricter: that the projection NORMALISES them to the server's
 * answer and says so, rather than believing them.
 */

const LIFECYCLE_STATES = [
  'PREPARED',
  'APPROVED',
  'EXECUTING',
  'COMPLETED',
  'PARTIALLY_COMPLETED',
  'FAILED',
  'CANCELLED',
  'APPROVAL_SPENT',
] as const;

const IN_FLIGHTS: InFlight[] = ['NONE', 'PLANNING', 'APPROVING', 'STARTING', 'WITHDRAWING', 'CANCELLING'];

function lifecycle(over: Partial<PlanLifecycle> = {}): PlanLifecycle {
  return {
    planId: 'plan-1',
    planHash: 'a'.repeat(64),
    sourceId: 'source-1',
    importType: 'PRODUCTS',
    storeId: null,
    state: 'PREPARED',
    authority: 'PLAN',
    statusIsStale: false,
    storedStatus: 'DRAFT',
    mayApprove: true,
    mayExecute: false,
    approval: null,
    execution: null,
    ...over,
  };
}

/** A run this browser has seen, in the shape the machine holds it. */
const observed = (status: string, over: { resumable?: boolean; cancelRequested?: boolean } = {}) => ({
  status,
  resumable: over.resumable ?? false,
  cancelRequested: over.cancelRequested ?? false,
});

/**
 * Whether the server could ever emit this combination.
 *
 * Derived from the backend's own projection, deliberately restated here rather
 * than imported: if the two ever disagree, this file should fail rather than
 * quietly agree with a rule that has changed.
 */
function isReachable(state: (typeof LIFECYCLE_STATES)[number], proofHeld: boolean, run: string | null): boolean {
  // A proof exists only because THIS browser just approved, and approving is
  // what produces the APPROVED state. Any other state with a proof in hand is
  // the browser being out of date, not the server being wrong.
  if (proofHeld && state !== 'APPROVED') return false;
  // The lifecycle reports EXECUTING or a terminal state precisely when an
  // execution row exists, so a run observed under PREPARED can only be the
  // narrow window between `startExecution` answering and the refetch landing.
  if (run !== null && (state === 'PREPARED' || state === 'APPROVAL_SPENT')) return false;
  if (run === null && state === 'EXECUTING') return false;
  return true;
}

describe('every reachable state offers a way forward, or says none is needed', () => {
  const cases: { name: string; surface: PlanSurface }[] = [];

  for (const state of LIFECYCLE_STATES) {
    for (const proofHeld of [false, true]) {
      for (const run of [null, 'QUEUED', 'RUNNING', 'COMPLETED', 'ABANDONED']) {
        for (const inFlight of IN_FLIGHTS) {
          if (!isReachable(state, proofHeld, run)) continue;
          cases.push({
            name: `${state} proof=${proofHeld} run=${run ?? 'none'} inFlight=${inFlight}`,
            surface: projectPlanActions({
              lifecycle: lifecycle({ state }),
              proofHeld,
              inFlight,
              observedExecution: run ? observed(run, { resumable: run === 'ABANDONED' }) : null,
            }),
          });
        }
      }
    }
  }

  it('covers a meaningful number of reachable combinations', () => {
    // A guard against the loop above silently filtering everything out and the
    // invariant passing over an empty set.
    expect(cases.length).toBeGreaterThan(100);
  });

  it('never renders a state with no action and no explanation', () => {
    const uninhabitable = cases.filter((c) => !surfaceIsHabitable(c.surface));
    expect(uninhabitable.map((c) => c.name)).toEqual([]);
  });

  it('always says something, whatever the state', () => {
    for (const c of cases) {
      expect(c.surface.headline.length, c.name).toBeGreaterThan(0);
      expect(c.surface.detail.length, c.name).toBeGreaterThan(0);
    }
  });

  it('offers no unknown action', () => {
    const known: PlanActionId[] = [
      'APPROVE',
      'START',
      'WITHDRAW',
      'EDIT_MAPPING',
      'CANCEL_RUN',
      'RESUME_RUN',
      'VIEW_RESULTS',
    ];
    for (const c of cases) {
      for (const action of c.surface.actions) expect(known, c.name).toContain(action);
    }
  });
});

describe('a run outranks the authorisation that permitted it', () => {
  it('offers no withdrawal once an execution exists, even without a proof', () => {
    // The panel that offered Withdraw beside "nothing has been written" while
    // rows were being written.
    const surface = projectPlanActions({
      lifecycle: lifecycle({ state: 'APPROVED', mayExecute: true }),
      proofHeld: false,
      inFlight: 'NONE',
      observedExecution: observed('QUEUED'),
    });

    expect(surface.actions).not.toContain('WITHDRAW');
    expect(surface.actions).not.toContain('START');
    expect(surface.kind).toBe('IN_FLIGHT');
  });

  it('never claims nothing was written once a run exists', () => {
    for (const run of ['QUEUED', 'RUNNING', 'COMPLETED']) {
      const surface = projectPlanActions({
        lifecycle: lifecycle({ state: 'APPROVED', mayExecute: true }),
        proofHeld: false,
        inFlight: 'NONE',
        observedExecution: observed(run),
      });
      expect(`${surface.headline} ${surface.detail}`.toLowerCase()).not.toContain('nothing has been written');
    }
  });

  it('prefers a terminal answer from either source, so a fast runner is not reported as running', () => {
    // The machine holds QUEUED from the moment it started the run; the refetch
    // that follows can legitimately come back COMPLETED first.
    const machineFirst = projectPlanActions({
      lifecycle: lifecycle({ state: 'COMPLETED' }),
      proofHeld: false,
      inFlight: 'NONE',
      observedExecution: observed('QUEUED'),
    });
    expect(machineFirst.kind).toBe('TERMINAL');

    const serverBehind = projectPlanActions({
      lifecycle: lifecycle({ state: 'APPROVED', mayExecute: true }),
      proofHeld: false,
      inFlight: 'NONE',
      observedExecution: observed('COMPLETED'),
    });
    expect(serverBehind.kind).toBe('TERMINAL');
  });

  it('offers Continue for an abandoned run that reports itself resumable', () => {
    const surface = projectPlanActions({
      lifecycle: lifecycle({ state: 'APPROVED', mayExecute: true }),
      proofHeld: false,
      inFlight: 'NONE',
      observedExecution: observed('ABANDONED', { resumable: true }),
    });
    expect(surface.actions).toContain('RESUME_RUN');
  });
});

describe('an approved plan always has a next step', () => {
  it('offers Start when the proof is held', () => {
    const surface = projectPlanActions({
      lifecycle: lifecycle({ state: 'APPROVED', mayApprove: false, mayExecute: true }),
      proofHeld: true,
      inFlight: 'NONE',
      observedExecution: null,
    });
    expect(surface.actions).toEqual(['START']);
  });

  it('offers Withdraw when it is not — never an empty page', () => {
    // Exactly the state plan `bcdb9687…` is in. The old wizard route rendered
    // the words and no control at all.
    const surface = projectPlanActions({
      lifecycle: lifecycle({ state: 'APPROVED', mayApprove: false, mayExecute: true }),
      proofHeld: false,
      inFlight: 'NONE',
      observedExecution: null,
    });
    expect(surface.actions).toEqual(['WITHDRAW']);
    expect(surface.headline).toContain('one-time authorization is unavailable');
  });
});

describe('combinations the server cannot produce are normalised, not believed', () => {
  it('ignores a proof held over a plan the server reports as unapproved', () => {
    const surface = projectPlanActions({
      lifecycle: lifecycle({ state: 'PREPARED' }),
      proofHeld: true,
      inFlight: 'NONE',
      observedExecution: null,
    });

    // The server's answer wins: this is approvable, not runnable.
    expect(surface.actions).toContain('APPROVE');
    expect(surface.actions).not.toContain('START');
    // And the discarded proof is named rather than dropped in silence.
    expect(surface.normalized).toMatch(/proof was ignored/i);
  });

  it('ignores a proof held over a plan that has already run', () => {
    const surface = projectPlanActions({
      lifecycle: lifecycle({ state: 'COMPLETED' }),
      proofHeld: true,
      inFlight: 'NONE',
      observedExecution: null,
    });
    expect(surface.actions).not.toContain('START');
    expect(surface.normalized).toMatch(/already run/i);
  });

  it('names an unrecognised state instead of rendering an empty page', () => {
    const surface = projectPlanActions({
      lifecycle: lifecycle({ state: 'SOMETHING_NEW' as PlanLifecycle['state'] }),
      proofHeld: false,
      inFlight: 'NONE',
      observedExecution: null,
    });
    expect(surface.kind).toBe('BLOCKED');
    expect(surface.requiresNoAction).toBe(true);
    expect(surface.normalized).toMatch(/unrecognised/i);
  });
});

describe('an unread lifecycle fails closed and says so', () => {
  it('offers nothing, and explains that it is still reading', () => {
    const surface = projectPlanActions({
      lifecycle: null,
      proofHeld: true,
      inFlight: 'NONE',
      observedExecution: null,
    });
    expect(surface.actions).toEqual([]);
    expect(surface.requiresNoAction).toBe(true);
    expect(surface.headline).toMatch(/checking/i);
  });
});

describe('the client phase describes waiting, and decides nothing', () => {
  it('shows the wait instead of the controls while a request is out', () => {
    for (const inFlight of ['APPROVING', 'STARTING', 'WITHDRAWING'] as InFlight[]) {
      const surface = projectPlanActions({
        lifecycle: lifecycle({ state: 'APPROVED', mayExecute: true }),
        proofHeld: true,
        inFlight,
        observedExecution: null,
      });
      expect(surface.kind, inFlight).toBe('IN_FLIGHT');
      expect(surface.actions, inFlight).toEqual([]);
      expect(surface.requiresNoAction, inFlight).toBe(true);
    }
  });

  it('cannot turn an unapprovable plan into an approvable one', () => {
    // The phase is presentation. No value of it may add a capability the
    // server did not grant.
    for (const inFlight of IN_FLIGHTS) {
      const surface = projectPlanActions({
        lifecycle: lifecycle({ state: 'COMPLETED' }),
        proofHeld: false,
        inFlight,
        observedExecution: null,
      });
      expect(surface.actions, inFlight).not.toContain('APPROVE');
      expect(surface.actions, inFlight).not.toContain('START');
    }
  });
});

describe('a stale status column is reported, not hidden', () => {
  it('says which row the answer came from when the plan disagrees', () => {
    const surface = projectPlanActions({
      lifecycle: lifecycle({
        state: 'COMPLETED',
        authority: 'EXECUTION',
        statusIsStale: true,
        storedStatus: 'APPROVED',
      }),
      proofHeld: false,
      inFlight: 'NONE',
      observedExecution: null,
    });
    expect(surface.provenance).toMatch(/still says APPROVED/);
  });

  it('says nothing when there is nothing to explain', () => {
    const surface = projectPlanActions({
      lifecycle: lifecycle({ state: 'PREPARED' }),
      proofHeld: false,
      inFlight: 'NONE',
      observedExecution: null,
    });
    expect(surface.provenance).toBeNull();
  });
});
