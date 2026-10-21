import {
  AssumptionChecker,
  AssumptionResult,
  ExecutionPreconditions,
  TargetAssumption,
  checkBeforeExecution,
  evaluatePreconditions,
} from '../pre-execution-check';
import { issue } from '../../issues/issue-taxonomy';

/**
 * The check immediately before anything is written.
 *
 * An approval is good for seventy-two hours, and in that time somebody else may
 * have deleted a product, archived a category, or created the very SKU this
 * import was going to create. Validating only at plan time would apply
 * decisions that were correct about a catalogue that no longer exists.
 */

const assume = (over: Partial<TargetAssumption> = {}): TargetAssumption => ({
  kind: 'RECORD_EXISTS',
  subject: 'The product "Camiseta azul"',
  key: 'product:abc',
  ...over,
});

function checkerReturning(results: AssumptionResult[]): AssumptionChecker {
  return { check: async () => results };
}

describe('re-checking what the plan assumed', () => {
  it('allows a plan whose assumptions all still hold', async () => {
    const assumptions = [assume(), assume({ kind: 'IDENTIFIER_FREE', key: 'sku:A-1' })];
    const verdict = await checkBeforeExecution(
      assumptions,
      checkerReturning(assumptions.map((assumption) => ({ assumption, holds: true }))),
    );
    expect(verdict).toEqual({ allowed: true, issues: [], stale: [] });
  });

  it('does not call the database when there is nothing to check', async () => {
    const checker = { check: jest.fn() };
    const verdict = await checkBeforeExecution([], checker as unknown as AssumptionChecker);
    expect(verdict.allowed).toBe(true);
    expect(checker.check).not.toHaveBeenCalled();
  });

  it('BLOCKS when a record the plan would update has vanished', async () => {
    // Updating something that is gone would create a new record instead, which
    // is a different act from the one that was approved.
    const assumption = assume();
    const verdict = await checkBeforeExecution([assumption], checkerReturning([{ assumption, holds: false }]));

    expect(verdict.allowed).toBe(false);
    expect(verdict.issues[0].severity).toBe('BLOCKING');
    expect(verdict.issues[0].message).toMatch(/no longer exists/);
    expect(verdict.issues[0].message).toMatch(/would create a new record instead/);
  });

  it('BLOCKS when an identifier the plan would create has been taken', async () => {
    const assumption = assume({ kind: 'IDENTIFIER_FREE', subject: 'The SKU "A-1"', key: 'sku:A-1' });
    const verdict = await checkBeforeExecution([assumption], checkerReturning([{ assumption, holds: false }]));

    expect(verdict.allowed).toBe(false);
    expect(verdict.issues[0].message).toMatch(/collide with the existing record/);
    expect(verdict.issues[0].guidance).toMatch(/propose updating the existing record/);
  });

  it('BLOCKS when something the plan attaches to is no longer usable', async () => {
    // The person approved a plan that said the product would be in that
    // category; silently dropping the attachment is not that plan.
    const assumption = assume({
      kind: 'REFERENCE_USABLE',
      subject: 'The category "Camisetas"',
      key: 'category:xyz',
    });
    const verdict = await checkBeforeExecution(
      [assumption],
      checkerReturning([{ assumption, holds: false, actual: 'it has been archived' }]),
    );

    expect(verdict.allowed).toBe(false);
    expect(verdict.issues[0].message).toContain('it has been archived');
  });

  it('only WARNS when the number of affected records changed', async () => {
    // The import is still the one they approved; it merely touches two fewer
    // records because somebody deleted them.
    const assumption = assume({ kind: 'SCALE_UNCHANGED', subject: 'This import', expectedCount: 412 });
    const verdict = await checkBeforeExecution(
      [assumption],
      checkerReturning([{ assumption, holds: false, actual: '410' }]),
    );

    expect(verdict.allowed).toBe(true);
    expect(verdict.issues[0].severity).toBe('WARNING');
    expect(verdict.issues[0].message).toContain('412');
    expect(verdict.issues[0].message).toContain('410');
  });

  it('anchors a finding to the first row that depended on it', async () => {
    const assumption = assume({ sourceRows: [42, 9, 17] });
    const verdict = await checkBeforeExecution([assumption], checkerReturning([{ assumption, holds: false }]));
    expect(verdict.issues[0].anchor).toEqual({ row: 9 });
  });

  it('reports every stale assumption, not just the first', async () => {
    const a = assume({ key: 'product:a' });
    const b = assume({ kind: 'IDENTIFIER_FREE', key: 'sku:B' });
    const verdict = await checkBeforeExecution(
      [a, b],
      checkerReturning([
        { assumption: a, holds: false },
        { assumption: b, holds: false },
      ]),
    );
    expect(verdict.issues).toHaveLength(2);
    expect(verdict.stale).toHaveLength(2);
  });

  it('NEVER repairs a stale plan', async () => {
    // Quietly adjusting an approved plan would mean the thing that runs is not
    // the thing anybody approved, which is what the approval exists to prevent.
    const assumption = assume();
    const verdict = await checkBeforeExecution([assumption], checkerReturning([{ assumption, holds: false }]));
    expect(verdict.issues[0].guidance).toMatch(/build the import again/i);
  });
});

describe('everything that must be true before a row is written', () => {
  const ok = (over: Partial<ExecutionPreconditions> = {}): ExecutionPreconditions => ({
    authorized: true,
    approvalValid: true,
    sourceAvailable: true,
    planIssues: [],
    targetVerdict: { allowed: true, issues: [], stale: [] },
    ...over,
  });

  it('permits a run when every precondition holds', () => {
    expect(evaluatePreconditions(ok())).toEqual({ allowed: true, issues: [] });
  });

  it('refuses an unauthorized caller FIRST, saying nothing about the catalogue', () => {
    // Someone who may not run this import should be refused before we tell them
    // anything about the state of the data.
    const outcome = evaluatePreconditions(
      ok({
        authorized: false,
        approvalValid: false,
        sourceAvailable: false,
        planIssues: [issue('REQUIRED_FIELD_UNMAPPED', 'Name is not mapped.')],
      }),
    );
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toBe('You do not have permission to run this import.');
    expect(outcome.issues).toEqual([]);
  });

  it('refuses an approval that no longer stands, in its own words', () => {
    const outcome = evaluatePreconditions(ok({ approvalValid: false, approvalProblem: 'This approval has expired.' }));
    expect(outcome.reason).toBe('This approval has expired.');
  });

  it('has a sentence ready when nothing explained the approval failure', () => {
    const outcome = evaluatePreconditions(ok({ approvalValid: false }));
    expect(outcome.reason).toMatch(/approved again/);
  });

  it('refuses when the source has gone, telling the person what to do', () => {
    const outcome = evaluatePreconditions(ok({ sourceAvailable: false }));
    expect(outcome.reason).toMatch(/Upload it again/);
  });

  it('RE-CHECKS the plan rather than trusting the finding from analysis time', () => {
    // Between the two moments a transformation could have changed meaning
    // across a deploy. A blocking finding that appeared since is exactly what
    // this second pass exists to catch.
    const outcome = evaluatePreconditions(ok({ planIssues: [issue('REQUIRED_VALUE_BLANK', 'Row 4 has no name.')] }));
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toMatch(/re-checking this import just before running it/);
    expect(outcome.issues).toHaveLength(1);
  });

  it('counts the problems when there are several', () => {
    const outcome = evaluatePreconditions(
      ok({
        planIssues: [
          issue('REQUIRED_VALUE_BLANK', 'Row 4 has no name.'),
          issue('DUPLICATE_FIELD_MAPPING', 'Two columns are price.'),
        ],
      }),
    );
    expect(outcome.reason).toMatch(/^2 problems/);
  });

  it('lets a plan through when its findings are only warnings', () => {
    const outcome = evaluatePreconditions(
      ok({ planIssues: [issue('NAME_COLLIDES_WITH_EXISTING', 'Six products share this name.')] }),
    );
    expect(outcome.allowed).toBe(true);
  });

  it('refuses when the catalogue drifted, and says to build it again', () => {
    const outcome = evaluatePreconditions(
      ok({
        targetVerdict: {
          allowed: false,
          issues: [issue('TARGET_CHANGED_SINCE_ANALYSIS', 'The product no longer exists.')],
          stale: [],
        },
      }),
    );
    expect(outcome.allowed).toBe(false);
    expect(outcome.reason).toMatch(/changed since this import was approved/);
    expect(outcome.issues).toHaveLength(1);
  });

  it('carries a target WARNING into an allowed run, rather than dropping it', () => {
    // The person approved a plan with a stated scale; a changed scale is worth
    // recording against the run even though it does not stop it.
    const warning = issue('TARGET_CHANGED_SINCE_ANALYSIS', 'It would now affect 410.', { severity: 'WARNING' });
    const outcome = evaluatePreconditions(ok({ targetVerdict: { allowed: true, issues: [warning], stale: [] } }));
    expect(outcome.allowed).toBe(true);
    expect(outcome.issues).toEqual([warning]);
  });

  it('never leaks an internal detail into the refusal', () => {
    const refusals = [
      evaluatePreconditions(ok({ authorized: false })),
      evaluatePreconditions(ok({ approvalValid: false })),
      evaluatePreconditions(ok({ sourceAvailable: false })),
      evaluatePreconditions(ok({ planIssues: [issue('REQUIRED_VALUE_BLANK', 'x')] })),
    ];
    for (const refusal of refusals) {
      expect(refusal.reason).not.toMatch(/null|undefined|Error|stack|SQL|bucket|token/i);
      expect(refusal.reason?.endsWith('.')).toBe(true);
    }
  });
});
