import { describe, expect, it } from 'vitest';
import { describeRun, initialRunState, isTerminal, runReducer, shouldPoll, supersedes } from './run-machine';
import type { RunState } from './run-machine';
import type { Approval, CreatedPlan, ExecutionStatus } from '../api/lifecycle.service';

/**
 * The rules of a run, tested as rules.
 *
 * These are properties about a SEQUENCE — what an edit does to an approval,
 * what an out-of-order status does to a finished run — and a sequence is far
 * easier to state here than to reconstruct through a screen. Everything the
 * panel draws is derived from this, so a rule proven here is a rule the screen
 * cannot break on its own.
 */

const plan = (over: Partial<CreatedPlan> = {}): CreatedPlan => ({
  id: 'plan-1',
  planHash: 'a'.repeat(64),
  readiness: { allowed: true },
  outstanding: 0,
  alreadyExisted: false,
  ...over,
});

const approval = (over: Partial<Approval> = {}): Approval => ({
  approvalId: 'approval-1',
  proof: 'the-secret-proof',
  expiresAt: '2026-09-01T10:00:00.000Z',
  notice: 'This import may be run once.',
  ...over,
});

const status = (over: Partial<ExecutionStatus> = {}): ExecutionStatus => ({
  id: 'exec-1',
  planId: 'plan-1',
  status: 'RUNNING',
  batchesCompleted: 1,
  batchesTotal: 4,
  rows: { created: 0, updated: 0, skipped: 0, failed: 0 },
  cancelRequested: false,
  resumable: false,
  failureReason: null,
  startedAt: '2026-08-26T09:00:00.000Z',
  finishedAt: null,
  checkpoints: [],
  ...over,
});

/** Fold a list of actions over a fresh state. */
const run = (...actions: Parameters<typeof runReducer>[1][]): RunState =>
  actions.reduce(runReducer, initialRunState());

describe('preparing and approving', () => {
  it('does not advance past a plan the server says is not ready', () => {
    const state = run(
      { type: 'PLAN_REQUESTED' },
      { type: 'PLAN_CREATED', plan: plan({ readiness: { allowed: false, reason: 'Two columns need a decision.' } }) },
    );

    expect(state.phase).toBe('IDLE');
    expect(state.error).toBe('Two columns need a decision.');
  });

  it('holds the proof in memory and never in the approval it shows', () => {
    const state = run(
      { type: 'PLAN_CREATED', plan: plan() },
      { type: 'APPROVAL_GRANTED', approval: approval() },
    );

    expect(state.proof).toBe('the-secret-proof');
    // The rendered half must not carry it: anything on screen is in a
    // screenshot, and for its lifetime this authorises a catalogue-wide write.
    expect(JSON.stringify(state.approval)).not.toContain('the-secret-proof');
  });

  it('spends the proof when execution starts', () => {
    const state = run(
      { type: 'PLAN_CREATED', plan: plan() },
      { type: 'APPROVAL_GRANTED', approval: approval() },
      { type: 'EXECUTION_STARTED', executionId: 'exec-1' },
    );

    expect(state.phase).toBe('RUNNING');
    expect(state.proof).toBeNull();
  });

  it('drops the proof when starting fails, since we cannot know whether it was spent', () => {
    const state = run(
      { type: 'PLAN_CREATED', plan: plan() },
      { type: 'APPROVAL_GRANTED', approval: approval() },
      { type: 'FAILED', message: 'The import could not be started.' },
    );

    expect(state.proof).toBeNull();
  });

  it('retracts the plan on an edit made before it was approved', () => {
    const state = run({ type: 'PLAN_CREATED', plan: plan() }, { type: 'PLAN_INVALIDATED' });

    expect(state.phase).toBe('IDLE');
    expect(state.plan).toBeNull();
    expect(state.approval).toBeNull();
    expect(state.proof).toBeNull();
  });

  it('REFUSES to retract an approved plan, keeping the single-use proof', () => {
    // The defect this closes. `PLAN_INVALIDATED` is dispatched from an effect
    // watching the editor's state, and it used to fire on re-renders that
    // changed nothing — including in the window between an approval and the
    // lifecycle refetch that follows it. It took the proof with it, and since
    // the proof exists in exactly one place and is never persisted, the run
    // became unstartable while the server still reported the plan APPROVED.
    const state = run(
      { type: 'PLAN_CREATED', plan: plan() },
      { type: 'APPROVAL_GRANTED', approval: approval() },
      { type: 'PLAN_INVALIDATED' },
    );

    expect(state.phase).toBe('APPROVED');
    expect(state.plan).not.toBeNull();
    expect(state.approval).not.toBeNull();
    expect(state.proof).not.toBeNull();
  });

  it('releases an approved plan only when the approval was actually withdrawn', () => {
    // The explicit counterpart. Withdrawal is audited on the server and asked
    // for by a person, which is the only thing that may drop an authorisation.
    const state = run(
      { type: 'PLAN_CREATED', plan: plan() },
      { type: 'APPROVAL_GRANTED', approval: approval() },
      { type: 'PLAN_RELEASED' },
    );

    expect(state.phase).toBe('IDLE');
    expect(state.plan).toBeNull();
    expect(state.approval).toBeNull();
    expect(state.proof).toBeNull();
  });

  it('does NOT retract anything once a run exists', () => {
    // Editing after a run has started is about the NEXT import. Dropping the
    // run's status here would hide a write in progress.
    const state = run(
      { type: 'PLAN_CREATED', plan: plan() },
      { type: 'APPROVAL_GRANTED', approval: approval() },
      { type: 'EXECUTION_STARTED', executionId: 'exec-1' },
      { type: 'PLAN_INVALIDATED' },
    );

    expect(state.execution?.id).toBe('exec-1');
    expect(state.phase).toBe('RUNNING');
  });

  it('says a re-submitted plan is the same import rather than a second one', () => {
    const state = run({ type: 'PLAN_CREATED', plan: plan({ alreadyExisted: true }) });
    expect(state.plan?.alreadyExisted).toBe(true);
    expect(state.phase).toBe('PLANNED');
  });
});

describe('watching a run', () => {
  it('ignores a status snapshot that knows less than the one it holds', () => {
    const ahead = status({ batchesCompleted: 3 });
    const behind = status({ batchesCompleted: 1 });

    const state = runReducer(
      run({ type: 'EXECUTION_STARTED', executionId: 'exec-1' }, { type: 'STATUS_OBSERVED', status: ahead }),
      { type: 'STATUS_OBSERVED', status: behind },
    );

    expect(state.execution?.batchesCompleted).toBe(3);
  });

  it('never moves a finished run back to running', () => {
    const finished = status({ status: 'COMPLETED', batchesCompleted: 4 });
    const stale = status({ status: 'RUNNING', batchesCompleted: 4 });

    expect(supersedes(finished, stale)).toBe(false);
    expect(supersedes(null, stale)).toBe(true);
  });

  it('accepts a snapshot of a DIFFERENT run, because that is the one just resumed', () => {
    const previous = status({ id: 'exec-1', batchesCompleted: 5 });
    const resumed = status({ id: 'exec-2', batchesCompleted: 0 });
    expect(supersedes(previous, resumed)).toBe(true);
  });

  it('stops polling once a run has settled', () => {
    const settled = runReducer(run({ type: 'EXECUTION_STARTED', executionId: 'exec-1' }), {
      type: 'STATUS_OBSERVED',
      status: status({ status: 'COMPLETED' }),
    });

    expect(settled.phase).toBe('SETTLED');
    expect(shouldPoll(settled)).toBe(false);
  });

  it('keeps polling while a cancellation is being honoured', () => {
    const cancelling = runReducer(run({ type: 'EXECUTION_STARTED', executionId: 'exec-1' }), {
      type: 'STATUS_OBSERVED',
      status: status({ cancelRequested: true }),
    });

    expect(cancelling.phase).toBe('CANCELLING');
    // Work continues until the batch in flight commits, so the screen must
    // keep asking. Treating "stop" as terminal is how somebody concludes a
    // write did not happen when it did.
    expect(shouldPoll(cancelling)).toBe(true);
  });

  it('offers to continue an interrupted run, and only when it is safe', () => {
    const resumable = runReducer(run({ type: 'EXECUTION_STARTED', executionId: 'exec-1' }), {
      type: 'STATUS_OBSERVED',
      status: status({ status: 'ABANDONED', resumable: true }),
    });
    expect(resumable.phase).toBe('RESUMABLE');

    const notResumable = runReducer(run({ type: 'EXECUTION_STARTED', executionId: 'exec-1' }), {
      type: 'STATUS_OBSERVED',
      status: status({ status: 'ABANDONED', resumable: false }),
    });
    expect(notResumable.phase).toBe('SETTLED');
  });

  it('treats every ending as terminal except abandonment', () => {
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('PARTIALLY_COMPLETED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    // Abandoned is not an ending. It is a run whose worker vanished, and the
    // checkpoints make continuing it safe.
    expect(isTerminal('ABANDONED')).toBe(false);
  });
});

describe('what it says', () => {
  it('promises nothing has changed before a run starts', () => {
    expect(describeRun(run({ type: 'PLAN_CREATED', plan: plan() }))).toMatch(/nothing has been changed yet/i);
  });

  it('says stopping, not stopped, while the batch in flight finishes', () => {
    const state = runReducer(run({ type: 'EXECUTION_STARTED', executionId: 'exec-1' }), {
      type: 'STATUS_OBSERVED',
      status: status({ cancelRequested: true, batchesCompleted: 2, batchesTotal: 5 }),
    });

    expect(describeRun(state)).toMatch(/stopping after the batch that is running now/i);
    expect(describeRun(state)).not.toMatch(/stopped/i);
  });

  it('accounts for the rows when a run finishes partway', () => {
    const state = runReducer(run({ type: 'EXECUTION_STARTED', executionId: 'exec-1' }), {
      type: 'STATUS_OBSERVED',
      status: status({
        status: 'PARTIALLY_COMPLETED',
        rows: { created: 12, updated: 3, skipped: 0, failed: 2 },
      }),
    });

    const sentence = describeRun(state);
    expect(sentence).toMatch(/12 added/);
    expect(sentence).toMatch(/3 updated/);
    expect(sentence).toMatch(/2 could not be imported/);
    // Never "left unchanged: 0" — a zero the person did not ask about is
    // noise that hides the numbers that matter.
    expect(sentence).not.toMatch(/0 left unchanged/);
  });

  it('says plainly when a run changed nothing', () => {
    const state = runReducer(run({ type: 'EXECUTION_STARTED', executionId: 'exec-1' }), {
      type: 'STATUS_OBSERVED',
      status: status({ status: 'COMPLETED', rows: { created: 0, updated: 0, skipped: 0, failed: 0 } }),
    });

    expect(describeRun(state)).toMatch(/no rows were changed/i);
  });
});
