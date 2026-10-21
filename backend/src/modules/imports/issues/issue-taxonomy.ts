/**
 * What can be wrong with an import, and how much it matters.
 *
 * The legacy importer had one answer to everything: it threw, and the user saw
 * a row number. That is the wrong shape for this problem, because almost
 * nothing about a spreadsheet is simply "valid" or "invalid" — most findings are
 * a judgement the person doing the import is better placed to make than we are.
 *
 * So findings carry a severity that means something operationally:
 *
 *  - **BLOCKING** — execution is refused. Reserved for things that would
 *    corrupt data or that we genuinely cannot act on. A blocking finding must
 *    always name something the user can actually change.
 *  - **WARNING** — execution proceeds, but only after the person has seen it
 *    and confirmed. This is where "six products share this name" lives: legal,
 *    common, and occasionally a disaster.
 *  - **INFORMATIONAL** — worth showing, never worth stopping for. "Forty rows
 *    were blank and will be skipped."
 *
 * Every finding carries an **anchor**: the exact sheet, row and column it came
 * from. A finding without one is not actionable — "a price was invalid" sends
 * someone hunting through eight hundred rows.
 */

export type IssueSeverity = 'BLOCKING' | 'WARNING' | 'INFORMATIONAL';

export type IssueCode =
  // Structural — the file itself
  | 'NO_TABLE_DETECTED'
  | 'HEADER_AMBIGUOUS'
  | 'DUPLICATE_HEADER'
  | 'RAGGED_ROWS'
  | 'BLANK_ROWS_SKIPPED'
  | 'MERGED_CELLS'
  | 'FORMULA_PRESENT'
  | 'EXTERNAL_LINK_PRESENT'
  // Mapping — the decisions made about the file
  | 'REQUIRED_FIELD_UNMAPPED'
  /** Neither of two alternative identity columns was mapped. */
  | 'IDENTITY_UNMAPPED'
  | 'COLUMN_UNMAPPED'
  | 'DUPLICATE_FIELD_MAPPING'
  | 'TRANSFORMATION_UNSUPPORTED'
  // Values — individual cells
  | 'VALUE_NOT_PARSEABLE'
  | 'VALUE_OUT_OF_RANGE'
  | 'VALUE_TOO_LONG'
  | 'REQUIRED_VALUE_BLANK'
  // Identity — which record a row refers to
  | 'DUPLICATE_IDENTITY_IN_FILE'
  | 'AMBIGUOUS_MATCH'
  | 'NO_IDENTIFIER'
  | 'NAME_COLLIDES_WITH_EXISTING'
  // Relationships
  | 'CATEGORY_PATH_UNRESOLVED'
  | 'PARENT_MISSING'
  | 'FAMILY_INCOMPLETE'
  /** A specification the mapping points at is missing, archived or a different type. */
  | 'SPECIFICATION_UNUSABLE'
  /** A language the mapping names is malformed or not in use here. */
  | 'LOCALE_UNKNOWN'
  // Target state
  | 'TARGET_CHANGED_SINCE_ANALYSIS'
  | 'PLAN_EXCEEDS_LIMIT'
  | 'STORE_NOT_PERMITTED'
  // Scope the import cannot infer — the questions only a person can answer
  /** A supplier-order import that does not say whose orders these are. */
  /** A line that does not say which order it belongs to. */
  | 'ORDER_UNIDENTIFIED'
  /** An import whose type needs a shop, run without one. */
  | 'STORE_REQUIRED'
  /** A recorded event with no date, which no report could ever place in time. */
  | 'EVENT_DATE_MISSING';

/** Where in the source a finding came from. */
export interface SourceAnchor {
  sheet?: string;
  /** 1-based, as the user sees it in their spreadsheet. */
  row?: number;
  /** The column's header text, which is what the user recognises. */
  column?: string;
  /** Spreadsheet-style reference, e.g. "Sheet1!C42", when a cell is meant. */
  cellRef?: string;
}

export interface Issue {
  code: IssueCode;
  severity: IssueSeverity;
  /** Plain sentence for the person doing the import. Never a stack trace. */
  message: string;
  anchor?: SourceAnchor;
  /** What to do about it, when there is something to do. */
  guidance?: string;
  /**
   * Set when the user has seen a WARNING and chosen to proceed. Blocking issues
   * can never be acknowledged — that is what makes them blocking.
   */
  acknowledged?: boolean;
}

/**
 * The default severity of each code.
 *
 * Held in one table rather than scattered across the call sites that raise
 * them, so "is a duplicate SKU blocking?" has exactly one answer and changing
 * it is a visible, reviewable edit.
 */
export const DEFAULT_SEVERITY: Record<IssueCode, IssueSeverity> = {
  NO_TABLE_DETECTED: 'BLOCKING',
  HEADER_AMBIGUOUS: 'WARNING',
  DUPLICATE_HEADER: 'WARNING',
  RAGGED_ROWS: 'INFORMATIONAL',
  BLANK_ROWS_SKIPPED: 'INFORMATIONAL',
  MERGED_CELLS: 'WARNING',
  FORMULA_PRESENT: 'INFORMATIONAL',
  EXTERNAL_LINK_PRESENT: 'WARNING',

  REQUIRED_FIELD_UNMAPPED: 'BLOCKING',
  IDENTITY_UNMAPPED: 'BLOCKING',
  COLUMN_UNMAPPED: 'INFORMATIONAL',
  DUPLICATE_FIELD_MAPPING: 'BLOCKING',
  TRANSFORMATION_UNSUPPORTED: 'BLOCKING',

  VALUE_NOT_PARSEABLE: 'WARNING',
  VALUE_OUT_OF_RANGE: 'WARNING',
  VALUE_TOO_LONG: 'WARNING',
  REQUIRED_VALUE_BLANK: 'BLOCKING',

  // A duplicate identity WITHIN one file is blocking: the second row would
  // overwrite the first, or the batch would fail halfway through. The database
  // cannot catch it until it is already too late.
  DUPLICATE_IDENTITY_IN_FILE: 'BLOCKING',
  AMBIGUOUS_MATCH: 'WARNING',
  NO_IDENTIFIER: 'WARNING',
  NAME_COLLIDES_WITH_EXISTING: 'WARNING',

  CATEGORY_PATH_UNRESOLVED: 'WARNING',
  PARENT_MISSING: 'BLOCKING',
  FAMILY_INCOMPLETE: 'WARNING',
  // A mapping pointing at a specification that cannot hold the values is not
  // "some rows will fail"; it is a mapping that cannot work at all.
  SPECIFICATION_UNUSABLE: 'BLOCKING',
  LOCALE_UNKNOWN: 'BLOCKING',

  TARGET_CHANGED_SINCE_ANALYSIS: 'BLOCKING',
  PLAN_EXCEEDS_LIMIT: 'BLOCKING',
  STORE_NOT_PERMITTED: 'BLOCKING',

  // All blocking, and all for the same reason: each names a decision the
  // import cannot make on somebody's behalf. Guessing a supplier, an order or
  // a shop would attribute real records to the wrong party, and a sale with an
  // invented date would sit in the wrong month of every report thereafter.
  ORDER_UNIDENTIFIED: 'BLOCKING',
  STORE_REQUIRED: 'BLOCKING',
  EVENT_DATE_MISSING: 'BLOCKING',
};

export function issue(
  code: IssueCode,
  message: string,
  extra: { anchor?: SourceAnchor; guidance?: string; severity?: IssueSeverity } = {},
): Issue {
  return {
    code,
    severity: extra.severity ?? DEFAULT_SEVERITY[code],
    message,
    ...(extra.anchor ? { anchor: extra.anchor } : {}),
    ...(extra.guidance ? { guidance: extra.guidance } : {}),
  };
}

export interface IssueSummary {
  blocking: number;
  warning: number;
  informational: number;
  /** Warnings still awaiting acknowledgement. */
  unacknowledgedWarnings: number;
  total: number;
}

export function summarize(issues: Issue[]): IssueSummary {
  const summary: IssueSummary = {
    blocking: 0,
    warning: 0,
    informational: 0,
    unacknowledgedWarnings: 0,
    total: issues.length,
  };
  for (const i of issues) {
    if (i.severity === 'BLOCKING') summary.blocking++;
    else if (i.severity === 'WARNING') {
      summary.warning++;
      if (!i.acknowledged) summary.unacknowledgedWarnings++;
    } else summary.informational++;
  }
  return summary;
}

/**
 * Whether this set of findings permits execution.
 *
 * Two gates, and they are different in kind. A blocking issue is a fact about
 * the data that no amount of confirming can change. An unacknowledged warning
 * is a decision nobody has made yet — the import is not wrong, it is merely
 * unreviewed, and proceeding without the review is how someone discovers
 * afterwards that six products quietly merged into one.
 */
export function canExecute(issues: Issue[]): { allowed: boolean; reason?: string } {
  const summary = summarize(issues);
  if (summary.blocking > 0) {
    return {
      allowed: false,
      reason:
        summary.blocking === 1
          ? 'One problem must be fixed before this import can run.'
          : `${summary.blocking} problems must be fixed before this import can run.`,
    };
  }
  if (summary.unacknowledgedWarnings > 0) {
    return {
      allowed: false,
      reason:
        summary.unacknowledgedWarnings === 1
          ? 'One warning still needs your confirmation.'
          : `${summary.unacknowledgedWarnings} warnings still need your confirmation.`,
    };
  }
  return { allowed: true };
}

/**
 * Acknowledge warnings by code.
 *
 * Blocking issues are deliberately unaffected. Allowing them to be
 * acknowledged would turn the severity into a suggestion, and the first time
 * anyone was in a hurry it would be waved through.
 */
export function acknowledge(issues: Issue[], codes: IssueCode[]): Issue[] {
  const wanted = new Set(codes);
  return issues.map((i) => (i.severity === 'WARNING' && wanted.has(i.code) ? { ...i, acknowledged: true } : i));
}

/**
 * Collapse repeated findings so the workspace stays readable.
 *
 * Eight hundred rows with an unparseable price is one problem, not eight
 * hundred. The first few anchors are kept because they are what someone
 * actually clicks; the count is what tells them the scale.
 */
export interface GroupedIssue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
  guidance?: string;
  count: number;
  /** The first few places it occurred; the rest are counted, not listed. */
  examples: SourceAnchor[];
  acknowledged: boolean;
}

export const MAX_EXAMPLES = 5;

export function groupIssues(issues: Issue[]): GroupedIssue[] {
  const groups = new Map<string, GroupedIssue>();

  for (const i of issues) {
    // Grouped by code AND column: an unparseable price and an unparseable
    // weight are different problems with different fixes, even though they
    // share a code.
    const key = `${i.code}::${i.anchor?.column ?? ''}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count++;
      if (existing.examples.length < MAX_EXAMPLES && i.anchor) existing.examples.push(i.anchor);
      // A group counts as acknowledged only when every member is: acknowledging
      // one row must not silence the other seven hundred.
      existing.acknowledged = existing.acknowledged && Boolean(i.acknowledged);
    } else {
      groups.set(key, {
        code: i.code,
        severity: i.severity,
        message: i.message,
        ...(i.guidance ? { guidance: i.guidance } : {}),
        count: 1,
        examples: i.anchor ? [i.anchor] : [],
        acknowledged: Boolean(i.acknowledged),
      });
    }
  }

  const order: Record<IssueSeverity, number> = { BLOCKING: 0, WARNING: 1, INFORMATIONAL: 2 };
  return [...groups.values()].sort((a, b) => order[a.severity] - order[b.severity] || b.count - a.count);
}

/** Human-readable anchor, for a report or a screen reader. */
export function describeAnchor(anchor?: SourceAnchor): string {
  if (!anchor) return '';
  const parts: string[] = [];
  if (anchor.sheet) parts.push(`sheet "${anchor.sheet}"`);
  if (anchor.row !== undefined) parts.push(`row ${anchor.row}`);
  if (anchor.column) parts.push(`column "${anchor.column}"`);
  if (parts.length === 0 && anchor.cellRef) return anchor.cellRef;
  return parts.join(', ');
}
