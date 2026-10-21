import { approvalState, mayApprove, mayExecute, projectPlanLifecycle, statusIsStale } from '../plan-lifecycle';

/**
 * Every shape an import can be found in — including the one production is in.
 *
 * The defect this closes was not exotic. A plan sat at APPROVED while its
 * execution had COMPLETED and its approval had been consumed, and the wizard
 * offered an Approve button on work that had already happened. So the shape
 * that actually exists in the database is a test here by name, not a footnote.
 */

const NOW = new Date('2026-08-29T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

const approval = (over: Partial<Parameters<typeof approvalState>[0]> = {}) => ({
  expires_at: ahead(86_400_000),
  consumed_at: null,
  revoked_at: null,
  ...over,
});

const project = (
  plan: string,
  app: ReturnType<typeof approval> | null,
  executions: { status: string; finished_at: Date | null }[],
) => projectPlanLifecycle({ plan: { status: plan }, approval: app, executions, now: NOW });

describe('the state an approval is in', () => {
  it('is NONE when nobody approved anything', () => {
    expect(approvalState(null, NOW)).toBe('NONE');
  });

  it('is CONSUMED once it has been spent', () => {
    expect(approvalState(approval({ consumed_at: ago(60_000) }), NOW)).toBe('CONSUMED');
  });

  it('is EXPIRED once its window has closed', () => {
    expect(approvalState(approval({ expires_at: ago(1) }), NOW)).toBe('EXPIRED');
  });

  it('reports REVOKED even when it also expired', () => {
    // Revocation is a decision somebody made; expiry is a clock. Telling
    // somebody their approval "ran out" when it was withdrawn is a different
    // fact and leads them to a different action.
    const both = approval({ expires_at: ago(1), revoked_at: ago(2) });
    expect(approvalState(both, NOW)).toBe('REVOKED');
  });

  it('is ACTIVE while it is still usable', () => {
    expect(approvalState(approval(), NOW)).toBe('ACTIVE');
  });
});

describe('the shape production is actually in', () => {
  it('reads a COMPLETED execution as completed, though the plan still says APPROVED', () => {
    // Plan d5ec89ac-a010-49b2-8975-453d6d6e716f, execution 2d438ba3…, approval
    // consumed 2026-08-27 21:52:22. Nothing advanced the plan's column, and
    // reading it produced an Approve button on a finished import.
    const result = project('APPROVED', approval({ consumed_at: ago(172_800_000) }), [
      { status: 'COMPLETED', finished_at: ago(172_800_000) },
    ]);
    expect(result.state).toBe('COMPLETED');
    expect(result.approval).toBe('CONSUMED');
    expect(result.authority).toBe('EXECUTION');
    expect(mayApprove(result.state)).toBe(false);
    expect(mayExecute(result.state)).toBe(false);
  });

  it('names that disagreement without repairing it', () => {
    // Read-time reporting only. Rewriting rows while answering a GET is a
    // mutation nobody asked for, and the backfill it implies is a migration
    // with its own authorization.
    const result = project('APPROVED', approval({ consumed_at: ago(1000) }), [
      { status: 'COMPLETED', finished_at: ago(1000) },
    ]);
    expect(statusIsStale({ status: 'APPROVED' }, result.state)).toBe(true);
  });
});

describe('the execution is what counts', () => {
  it.each([
    ['COMPLETED', 'COMPLETED'],
    ['PARTIALLY_COMPLETED', 'PARTIALLY_COMPLETED'],
    ['FAILED', 'FAILED'],
    ['CANCELLED', 'CANCELLED'],
  ])('a %s execution makes the plan %s whatever its column says', (execution, expected) => {
    for (const column of ['DRAFT', 'READY', 'APPROVED', 'EXECUTING', 'STALE']) {
      expect(project(column, approval(), [{ status: execution, finished_at: ago(1) }]).state).toBe(expected);
    }
  });

  it.each(['QUEUED', 'RUNNING'])('a %s execution is EXECUTING, and offers nothing else', (status) => {
    const result = project('APPROVED', approval({ consumed_at: ago(1) }), [{ status, finished_at: null }]);
    expect(result.state).toBe('EXECUTING');
    expect(mayApprove(result.state)).toBe(false);
    expect(mayExecute(result.state)).toBe(false);
  });

  it('treats an abandoned lease as a partial that can be resumed', () => {
    // Work was committed and more remains. Neither running nor finished, and
    // calling it FAILED would invite somebody to start again over rows that
    // are already in their catalogue.
    expect(
      project('EXECUTING', approval({ consumed_at: ago(1) }), [{ status: 'ABANDONED', finished_at: null }]).state,
    ).toBe('PARTIALLY_COMPLETED');
  });

  it('reads the NEWEST execution, not the first', () => {
    // Resume mints a second row. The newest says where the work got to.
    const result = projectPlanLifecycle({
      plan: { status: 'APPROVED' },
      approval: approval({ consumed_at: ago(1) }),
      executions: [
        { status: 'COMPLETED', finished_at: ago(10) },
        { status: 'ABANDONED', finished_at: null },
      ],
      now: NOW,
    });
    expect(result.state).toBe('COMPLETED');
  });
});

describe('with no execution at all', () => {
  it('is PREPARED when nothing has been approved', () => {
    const result = project('READY', null, []);
    expect(result.state).toBe('PREPARED');
    expect(mayApprove(result.state)).toBe(true);
  });

  it('is APPROVED, and executable, while the approval is live', () => {
    const result = project('APPROVED', approval(), []);
    expect(result.state).toBe('APPROVED');
    expect(mayExecute(result.state)).toBe(true);
    expect(mayApprove(result.state)).toBe(false);
  });

  it.each([
    ['consumed', { consumed_at: ago(1) }],
    ['expired', { expires_at: ago(1) }],
  ])('offers nothing when the approval is %s', (_name, over) => {
    // Never an Approve button. This is the trap: identical decisions rebuild
    // the same plan hash, and if a spent approval resolved to "approvable" the
    // operator would press it forever.
    const result = project('APPROVED', approval(over), []);
    expect(result.state).toBe('APPROVAL_SPENT');
    expect(mayApprove(result.state)).toBe(false);
    expect(mayExecute(result.state)).toBe(false);
  });

  it('is CANCELLED when the plan itself was cancelled', () => {
    expect(project('CANCELLED', null, []).state).toBe('CANCELLED');
  });
});

describe('what the wizard may offer', () => {
  it('permits approval in exactly one state', () => {
    const states = [
      'PREPARED',
      'APPROVED',
      'EXECUTING',
      'COMPLETED',
      'PARTIALLY_COMPLETED',
      'FAILED',
      'CANCELLED',
      'APPROVAL_SPENT',
    ] as const;
    expect(states.filter(mayApprove)).toEqual(['PREPARED']);
    expect(states.filter(mayExecute)).toEqual(['APPROVED']);
  });

  it('never offers a rerun from a terminal state', () => {
    // Deliberate: product-stock reruns are unsafe until stock is a target
    // balance rather than a movement, so no terminal state offers one.
    for (const state of ['COMPLETED', 'PARTIALLY_COMPLETED', 'FAILED', 'CANCELLED'] as const) {
      expect(mayApprove(state)).toBe(false);
      expect(mayExecute(state)).toBe(false);
    }
  });
});

describe('an approval that was withdrawn', () => {
  it('returns the plan to PREPARED, approvable again', () => {
    // Revocation withdraws the AUTHORISATION, not the plan: the mapping, the
    // decisions and the hash are untouched and nothing was written. Treating
    // it as terminal is what turned a lost proof into a trap — an approval
    // that could not be spent, could not be cleared, and blocked re-approval
    // for ever, with expiry making it worse rather than better.
    const result = project('APPROVED', approval({ revoked_at: ago(60_000) }), []);
    expect(result.state).toBe('PREPARED');
    expect(result.approval).toBe('REVOKED');
    expect(mayApprove(result.state)).toBe(true);
    expect(mayExecute(result.state)).toBe(false);
  });

  it('does not call the stored APPROVED column stale for that', () => {
    // The column says APPROVED and the projection says PREPARED. That is the
    // projection doing its job, not drift worth reporting.
    const result = project('APPROVED', approval({ revoked_at: ago(1) }), []);
    expect(statusIsStale({ status: 'APPROVED' }, result.state)).toBe(false);
  });

  it('still lets the EXECUTION decide when one exists', () => {
    // Revoked after a run finished: the run is what happened, and it outranks
    // anything about the authorisation that permitted it.
    const result = project('APPROVED', approval({ revoked_at: ago(1) }), [
      { status: 'COMPLETED', finished_at: ago(2) },
    ]);
    expect(result.state).toBe('COMPLETED');
    expect(result.authority).toBe('EXECUTION');
    expect(mayApprove(result.state)).toBe(false);
  });

  it('is not reached by an expired approval, which stays terminal', () => {
    // Expiry is a clock running out, not a decision. Re-approving is fine, but
    // it must come from a deliberate withdrawal rather than from waiting.
    expect(project('APPROVED', approval({ expires_at: ago(1) }), []).state).toBe('APPROVAL_SPENT');
  });
});
