import { Issue, issue } from '../issues/issue-taxonomy';

/**
 * The check immediately before anything is written.
 *
 * A plan is built against the catalogue as it was, reviewed by a person, and
 * approved. Then time passes — minutes usually, but the approval is good for
 * seventy-two hours — and in that time somebody else may have deleted a
 * product, archived a category, or created the very SKU this import was going
 * to create.
 *
 * Validating only at plan time would mean the import applies decisions that
 * were correct about a catalogue that no longer exists. So the plan records
 * what it ASSUMED, and every assumption is re-checked here, against the
 * database, in the moment before execution.
 *
 * The check is deliberately narrow. It does not re-derive the plan — that would
 * produce a different plan, which nobody approved. It asks only whether the
 * facts the approved plan depended on are still facts.
 */

export type AssumptionKind =
  /** A record the plan intends to UPDATE. It must still exist. */
  | 'RECORD_EXISTS'
  /** An identifier the plan intends to CREATE. It must still be free. */
  | 'IDENTIFIER_FREE'
  /** A category, store or definition the plan will attach things to. */
  | 'REFERENCE_USABLE'
  /** A count the plan reported to the approver, e.g. "412 products will change". */
  | 'SCALE_UNCHANGED';

export interface TargetAssumption {
  kind: AssumptionKind;
  /** What the assumption is about, in words the person would recognise. */
  subject: string;
  /** Opaque to this module; the checker interprets it. */
  key: string;
  /** Only for SCALE_UNCHANGED. */
  expectedCount?: number;
  /** Source rows that depend on this assumption, for an anchored finding. */
  sourceRows?: number[];
}

export interface AssumptionResult {
  assumption: TargetAssumption;
  holds: boolean;
  /** What is true now, when it differs from what was assumed. */
  actual?: string;
}

/** Whatever can answer these questions against the live database. */
export interface AssumptionChecker {
  check(assumptions: TargetAssumption[]): Promise<AssumptionResult[]>;
}

export interface PreExecutionVerdict {
  allowed: boolean;
  issues: Issue[];
  /** Assumptions that no longer hold, for the operator log. */
  stale: AssumptionResult[];
}

/**
 * How much each kind of drift matters.
 *
 * The distinction is between drift that would make the import do something
 * DIFFERENT from what was approved, and drift that merely makes it do less.
 *
 *  - A record that has vanished would turn an approved UPDATE into a CREATE.
 *    That is a different act, and it is blocking.
 *  - An identifier that is now taken would turn an approved CREATE into either
 *    a collision or an unintended UPDATE. Also blocking.
 *  - A reference that has become unusable — an archived category — would
 *    silently drop an attachment. Blocking, because the person approved a plan
 *    that said the product would be in that category.
 *  - A changed COUNT is a warning rather than a block. The person was told
 *    "412 products will change"; if it is now 410 because two were deleted, the
 *    import is still the one they approved, but they should know.
 */
const SEVERITY: Record<AssumptionKind, 'BLOCKING' | 'WARNING'> = {
  RECORD_EXISTS: 'BLOCKING',
  IDENTIFIER_FREE: 'BLOCKING',
  REFERENCE_USABLE: 'BLOCKING',
  SCALE_UNCHANGED: 'WARNING',
};

const MESSAGE: Record<AssumptionKind, (r: AssumptionResult) => string> = {
  RECORD_EXISTS: (r) =>
    `${r.assumption.subject} no longer exists. This import was approved to update it, and updating something that is gone would create a new record instead.`,
  IDENTIFIER_FREE: (r) =>
    `${r.assumption.subject} has been used since this import was approved. Creating it again would collide with the existing record.`,
  REFERENCE_USABLE: (r) =>
    `${r.assumption.subject} can no longer be used${r.actual ? ` (${r.actual})` : ''}. The rows that referred to it would lose that connection.`,
  SCALE_UNCHANGED: (r) =>
    `This import was approved as affecting ${r.assumption.expectedCount} record(s); it would now affect ${r.actual ?? 'a different number'}.`,
};

const GUIDANCE: Record<AssumptionKind, string> = {
  RECORD_EXISTS: 'Build the import again so it can decide afresh what to do with these rows.',
  IDENTIFIER_FREE: 'Build the import again; it will then propose updating the existing record instead of creating one.',
  REFERENCE_USABLE: 'Restore it, or build the import again and choose a different one.',
  SCALE_UNCHANGED: 'Check that the new number is what you expect before continuing.',
};

/**
 * Re-check every assumption and decide whether execution may proceed.
 *
 * Note what this does NOT do: it never repairs. A stale assumption sends the
 * person back to build the plan again, because the alternative — quietly
 * adjusting an approved plan — would mean the thing that runs is not the thing
 * anybody approved, which is exactly what the approval exists to prevent.
 */
export async function checkBeforeExecution(
  assumptions: TargetAssumption[],
  checker: AssumptionChecker,
): Promise<PreExecutionVerdict> {
  if (assumptions.length === 0) return { allowed: true, issues: [], stale: [] };

  const results = await checker.check(assumptions);
  const stale = results.filter((r) => !r.holds);
  if (stale.length === 0) return { allowed: true, issues: [], stale: [] };

  const issues = stale.map((result) =>
    issue('TARGET_CHANGED_SINCE_ANALYSIS', MESSAGE[result.assumption.kind](result), {
      severity: SEVERITY[result.assumption.kind],
      guidance: GUIDANCE[result.assumption.kind],
      ...(result.assumption.sourceRows?.length ? { anchor: { row: Math.min(...result.assumption.sourceRows) } } : {}),
    }),
  );

  return {
    allowed: !issues.some((i) => i.severity === 'BLOCKING'),
    issues,
    stale,
  };
}

/**
 * Everything that must be true before a single row is written.
 *
 * Gathered in one place because the order matters and each check is cheap
 * relative to what follows. Authority is checked first: a caller who may not
 * run this import should be refused before we tell them anything about the
 * state of the catalogue.
 */
export interface ExecutionPreconditions {
  /** The caller may run this import type against this organization. */
  authorized: boolean;
  /** The approval proof verified, was unexpired, unconsumed and matches the plan. */
  approvalValid: boolean;
  approvalProblem?: string;
  /** The source is still readable — within retention, still in storage. */
  sourceAvailable: boolean;
  sourceProblem?: string;
  /** Findings from the plan itself, recomputed rather than trusted. */
  planIssues: Issue[];
  /** The target-state re-check. */
  targetVerdict: PreExecutionVerdict;
}

export interface PreconditionOutcome {
  allowed: boolean;
  /** One sentence for the person. Never a stack trace, never a code. */
  reason?: string;
  issues: Issue[];
}

export function evaluatePreconditions(preconditions: ExecutionPreconditions): PreconditionOutcome {
  // Authority first, and its refusal says nothing about the catalogue.
  if (!preconditions.authorized) {
    return { allowed: false, reason: 'You do not have permission to run this import.', issues: [] };
  }

  if (!preconditions.approvalValid) {
    return {
      allowed: false,
      reason: preconditions.approvalProblem ?? 'This import needs to be approved again before it can run.',
      issues: [],
    };
  }

  if (!preconditions.sourceAvailable) {
    return {
      allowed: false,
      reason: preconditions.sourceProblem ?? 'The uploaded file is no longer available. Upload it again to continue.',
      issues: [],
    };
  }

  // The plan's own findings, recomputed here rather than trusted from analysis
  // time. Between the two moments the transformations could have changed
  // meaning across a deploy, and a blocking finding that appeared since is
  // exactly what this second pass exists to catch.
  const blocking = preconditions.planIssues.filter((i) => i.severity === 'BLOCKING');
  if (blocking.length > 0) {
    return {
      allowed: false,
      reason:
        blocking.length === 1
          ? 'A problem was found when re-checking this import just before running it.'
          : `${blocking.length} problems were found when re-checking this import just before running it.`,
      issues: preconditions.planIssues,
    };
  }

  if (!preconditions.targetVerdict.allowed) {
    return {
      allowed: false,
      reason: 'Your catalogue has changed since this import was approved, so it needs to be built again.',
      issues: preconditions.targetVerdict.issues,
    };
  }

  // Warnings from the target check survive into the report even when they do
  // not stop the run; the person approved a plan with a stated scale, and a
  // changed scale is worth recording against the run.
  return { allowed: true, issues: preconditions.targetVerdict.issues };
}
