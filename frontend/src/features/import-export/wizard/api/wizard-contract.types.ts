/**
 * The wizard's contract with the backend.
 *
 * These types describe what the SERVER says, not what this build wishes were
 * true. Phase 8's wizard rendered its choices from a local fixture, which meant
 * the editor could offer an operation the backend would refuse at execution
 * time — after the person had built a whole mapping around it. Everything here
 * arrives over the wire from `GET /import/wizard/contract`.
 *
 * The fixtures still exist, but only as deterministic test data. Nothing in a
 * running wizard reads them.
 */

export type TransformationKind =
  | 'TRIM'
  | 'COLLAPSE_WHITESPACE'
  | 'UPPERCASE'
  | 'LOWERCASE'
  | 'STRIP_CHARACTERS'
  | 'REPLACE_LITERAL'
  | 'PAD_START'
  | 'PARSE_DECIMAL'
  | 'PARSE_INTEGER'
  | 'PARSE_BOOLEAN'
  | 'PARSE_DATE'
  | 'SPLIT_LIST'
  | 'MAP_VALUES'
  | 'DEFAULT_IF_BLANK';

export type OptionType = 'TEXT' | 'NUMBER' | 'CHOICE' | 'KEY_VALUE' | 'BOOLEAN';

export interface OptionSpec {
  name: string;
  type: OptionType;
  label: string;
  choices?: { value: string; label: string }[];
  default?: string | number | boolean;
  required?: boolean;
  help?: string;
}

export interface TransformationSpec {
  kind: TransformationKind;
  label: string;
  description: string;
  group: 'TEXT' | 'NUMBER' | 'DATE' | 'LIST' | 'VALUE';
  options: OptionSpec[];
  example: { before: string; after: string };
}

export type IssueSeverity = 'BLOCKING' | 'WARNING' | 'INFORMATIONAL';

export interface WizardContract {
  version: string;
  transformations: TransformationSpec[];
  supportedTransformations: TransformationKind[];
  issueSeverities: Record<string, IssueSeverity>;
}

export interface Transformation {
  kind: TransformationKind;
  options?: Record<string, unknown>;
}

export interface ColumnMapping {
  columnIndex: number;
  header: string;
  /** `null` means "ignore this column" — a decision, not an absence. */
  field: string | null;
  transformations?: Transformation[];
  reasons?: string[];
  confidence?: number;
  /** True once a person has looked at this column, whatever they decided. */
  reviewed?: boolean;
}

export interface TableMapping {
  sheet?: string;
  headerRow: number;
  columns: ColumnMapping[];
}

export interface SourceAnchor {
  sheet?: string;
  row?: number;
  column?: string;
  cellRef?: string;
}

export interface GroupedIssue {
  code: string;
  severity: IssueSeverity;
  message: string;
  guidance?: string;
  count: number;
  examples: SourceAnchor[];
  acknowledged: boolean;
}

export interface IssueSummary {
  blocking: number;
  warning: number;
  informational: number;
  unacknowledgedWarnings: number;
  total: number;
}

export type TransformValue = string | number | boolean | string[] | null;

export interface NormalizedCell {
  columnIndex: number;
  header: string;
  field: string | null;
  original: string;
  normalized: TransformValue;
  steps: string[];
  problem?: string;
  changed: boolean;
}

export interface NormalizedRow {
  sourceRow: number;
  cells: NormalizedCell[];
  values: Record<string, TransformValue>;
  blank: boolean;
}

export interface PreviewResponse {
  rows: NormalizedRow[];
  ignoredColumns: { columnIndex: number; header: string }[];
  blankRowCount: number;
  previewedRows: number;
  issues: GroupedIssue[];
  summary: IssueSummary;
  /** Whether the import may run, and the sentence explaining why not. */
  readiness: { allowed: boolean; reason?: string };
}

export interface SourceSample {
  sheet?: string;
  /** Spreadsheet row number of the first sampled row, so anchors are real. */
  firstRowNumber: number;
  headers: string[];
  rows: string[][];
}

export interface ShapeDrift {
  drifted: boolean;
  added: string[];
  removed: string[];
  reordered: boolean;
  retyped: { header: string; was: string; now: string }[];
}

export interface TemplateSummary {
  id: string;
  name: string;
  version: number;
  importType: string;
  updatedAt: string;
}

export interface AppliedTemplateResponse {
  template: { id: string; name: string; version: number };
  mapping: TableMapping;
  drift: ShapeDrift;
  droppedColumns: string[];
  issues: GroupedIssue[];
  summary: IssueSummary;
}
