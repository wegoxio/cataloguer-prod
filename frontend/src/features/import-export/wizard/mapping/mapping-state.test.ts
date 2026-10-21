import { describe, expect, it } from 'vitest';
import {
  MappingState,
  chainIsSupported,
  editorReadiness,
  initialMappingState,
  mappedColumns,
  mappingForRequest,
  mappingReducer,
  outstandingWarnings,
  undecidedColumns,
} from './mapping-state';
import type { ColumnMapping, GroupedIssue, PreviewResponse, WizardContract } from '../api/wizard-contract.types';

/**
 * The editor's decisions, tested as decisions.
 *
 * Everything here is about the two failures that cost real money: proceeding
 * with a column nobody looked at, and approving a plan that has changed since
 * it was shown.
 */

const SAMPLE = {
  sheet: 'Productos',
  firstRowNumber: 2,
  headers: ['Nombre', 'Precio', 'Notas'],
  rows: [['Camiseta', '19,99', 'interno']],
};

const PROPOSALS: ColumnMapping[] = [
  { columnIndex: 0, header: 'Nombre', field: 'name', confidence: 0.95, reasons: ['header matches exactly'] },
  { columnIndex: 1, header: 'Precio', field: 'price', confidence: 0.9, reasons: ['header matches exactly'] },
  { columnIndex: 2, header: 'Notas', field: null, confidence: 0, reasons: ['nothing recognisable'] },
];

const CONTRACT: WizardContract = {
  version: '1.0.0',
  transformations: [],
  supportedTransformations: ['TRIM', 'PARSE_DECIMAL'],
  issueSeverities: {},
};

const preview = (issues: GroupedIssue[] = []): PreviewResponse => ({
  rows: [],
  ignoredColumns: [],
  blankRowCount: 0,
  previewedRows: 1,
  issues,
  summary: {
    blocking: issues.filter((i) => i.severity === 'BLOCKING').length,
    warning: issues.filter((i) => i.severity === 'WARNING').length,
    informational: issues.filter((i) => i.severity === 'INFORMATIONAL').length,
    unacknowledgedWarnings: issues.filter((i) => i.severity === 'WARNING').length,
    total: issues.length,
  },
  readiness: issues.some((i) => i.severity === 'BLOCKING')
    ? { allowed: false, reason: 'One problem must be fixed before this import can run.' }
    : { allowed: true },
});

const warning = (code: string): GroupedIssue => ({
  code,
  severity: 'WARNING',
  message: 'Six products share this name.',
  count: 6,
  examples: [],
  acknowledged: false,
});

/** A state with a source loaded, every column decided and a clean preview. */
function readyState(): MappingState {
  let state = initialMappingState('PRODUCTS');
  state = mappingReducer(state, { type: 'CONTRACT_LOADED', contract: CONTRACT });
  state = mappingReducer(state, {
    type: 'SOURCE_LOADED',
    sample: SAMPLE,
    columnTypes: ['TEXT', 'DECIMAL', 'TEXT'],
    proposals: PROPOSALS,
  });
  state = mappingReducer(state, { type: 'COLUMN_IGNORED', columnIndex: 2 });
  state = mappingReducer(state, { type: 'FIELD_ASSIGNED', columnIndex: 0, field: 'name' });
  state = mappingReducer(state, { type: 'FIELD_ASSIGNED', columnIndex: 1, field: 'price' });
  return mappingReducer(state, { type: 'PREVIEW_SUCCEEDED', preview: preview() });
}

describe('loading a source', () => {
  it('adopts the proposals and moves attention to the mapping', () => {
    const state = mappingReducer(initialMappingState('PRODUCTS'), {
      type: 'SOURCE_LOADED',
      sample: SAMPLE,
      columnTypes: ['TEXT', 'DECIMAL', 'TEXT'],
      proposals: PROPOSALS,
    });
    expect(state.mapping.columns).toHaveLength(3);
    expect(state.focusedRegion).toBe('MAPPING');
    expect(state.mapping.sheet).toBe('Productos');
  });

  it('keeps the confidence and reasons behind each proposal', () => {
    // The person has to be able to tell a confident guess from a shot in the
    // dark, and why. A field with no explanation is one they cannot check.
    const state = mappingReducer(initialMappingState('PRODUCTS'), {
      type: 'SOURCE_LOADED',
      sample: SAMPLE,
      columnTypes: [],
      proposals: PROPOSALS,
    });
    expect(state.mapping.columns[0].confidence).toBe(0.95);
    expect(state.mapping.columns[0].reasons).toEqual(['header matches exactly']);
  });

  it('counts an unproposed column as still needing a decision', () => {
    const state = mappingReducer(initialMappingState('PRODUCTS'), {
      type: 'SOURCE_LOADED',
      sample: SAMPLE,
      columnTypes: [],
      proposals: PROPOSALS,
    });
    expect(undecidedColumns(state).map((c) => c.header)).toEqual(['Notas']);
  });
});

describe('every column needs a decision', () => {
  it('treats assigning a field as having looked', () => {
    const state = mappingReducer(readyState(), { type: 'FIELD_ASSIGNED', columnIndex: 2, field: 'description' });
    expect(undecidedColumns(state)).toEqual([]);
  });

  it('treats ignoring as a decision, not as absence', () => {
    // Silence is not a decision. A column nobody looked at is how a price
    // column silently goes missing.
    const state = mappingReducer(readyState(), { type: 'COLUMN_IGNORED', columnIndex: 2 });
    const notas = state.mapping.columns.find((c) => c.columnIndex === 2);
    expect(notas).toMatchObject({ field: null, reviewed: true });
    expect(undecidedColumns(state)).toEqual([]);
  });

  it('drops the transformations when a column is ignored', () => {
    // Keeping them would resurrect them if the column were mapped again later,
    // which is not what "ignore" means to the person who clicked it.
    let state = readyState();
    state = mappingReducer(state, { type: 'TRANSFORMATION_ADDED', columnIndex: 1, kind: 'TRIM' });
    state = mappingReducer(state, { type: 'COLUMN_IGNORED', columnIndex: 1 });
    expect(state.mapping.columns.find((c) => c.columnIndex === 1)?.transformations).toEqual([]);
  });

  it('refuses to proceed while any column is undecided, naming it when there is one', () => {
    let state = initialMappingState('PRODUCTS');
    state = mappingReducer(state, {
      type: 'SOURCE_LOADED',
      sample: SAMPLE,
      columnTypes: [],
      proposals: PROPOSALS,
    });
    state = mappingReducer(state, { type: 'PREVIEW_SUCCEEDED', preview: preview() });
    expect(editorReadiness(state)).toEqual({
      allowed: false,
      reason: 'One column still needs a decision: "Notas".',
    });
  });
});

describe('transformations', () => {
  it('appends in the order they are added', () => {
    let state = readyState();
    state = mappingReducer(state, { type: 'TRANSFORMATION_ADDED', columnIndex: 1, kind: 'TRIM' });
    state = mappingReducer(state, {
      type: 'TRANSFORMATION_ADDED',
      columnIndex: 1,
      kind: 'PARSE_DECIMAL',
      options: { decimalSeparator: ',' },
    });
    expect(state.mapping.columns[1].transformations?.map((t) => t.kind)).toEqual(['TRIM', 'PARSE_DECIMAL']);
  });

  it('reorders, because trim-then-parse is a different mapping from the reverse', () => {
    let state = readyState();
    state = mappingReducer(state, { type: 'TRANSFORMATION_ADDED', columnIndex: 1, kind: 'TRIM' });
    state = mappingReducer(state, { type: 'TRANSFORMATION_ADDED', columnIndex: 1, kind: 'PARSE_DECIMAL' });
    state = mappingReducer(state, { type: 'TRANSFORMATION_MOVED', columnIndex: 1, from: 1, to: 0 });
    expect(state.mapping.columns[1].transformations?.map((t) => t.kind)).toEqual(['PARSE_DECIMAL', 'TRIM']);
  });

  it('ignores a move that refers to a step that is not there', () => {
    let state = readyState();
    state = mappingReducer(state, { type: 'TRANSFORMATION_ADDED', columnIndex: 1, kind: 'TRIM' });
    const before = state.mapping.columns[1].transformations;
    state = mappingReducer(state, { type: 'TRANSFORMATION_MOVED', columnIndex: 1, from: 5, to: 0 });
    expect(state.mapping.columns[1].transformations).toEqual(before);
  });

  it('clamps a move that would land outside the chain', () => {
    let state = readyState();
    state = mappingReducer(state, { type: 'TRANSFORMATION_ADDED', columnIndex: 1, kind: 'TRIM' });
    state = mappingReducer(state, { type: 'TRANSFORMATION_ADDED', columnIndex: 1, kind: 'PARSE_DECIMAL' });
    state = mappingReducer(state, { type: 'TRANSFORMATION_MOVED', columnIndex: 1, from: 0, to: 99 });
    expect(state.mapping.columns[1].transformations?.map((t) => t.kind)).toEqual(['PARSE_DECIMAL', 'TRIM']);
  });

  it('sets one option without disturbing the others', () => {
    let state = readyState();
    state = mappingReducer(state, {
      type: 'TRANSFORMATION_ADDED',
      columnIndex: 1,
      kind: 'PARSE_DECIMAL',
      options: { decimalSeparator: ',' },
    });
    state = mappingReducer(state, {
      type: 'TRANSFORMATION_OPTION_SET',
      columnIndex: 1,
      at: 0,
      option: 'somethingElse',
      value: true,
    });
    expect(state.mapping.columns[1].transformations?.[0].options).toEqual({
      decimalSeparator: ',',
      somethingElse: true,
    });
  });

  it('removes a step by position', () => {
    let state = readyState();
    state = mappingReducer(state, { type: 'TRANSFORMATION_ADDED', columnIndex: 1, kind: 'TRIM' });
    state = mappingReducer(state, { type: 'TRANSFORMATION_ADDED', columnIndex: 1, kind: 'PARSE_DECIMAL' });
    state = mappingReducer(state, { type: 'TRANSFORMATION_REMOVED', columnIndex: 1, at: 0 });
    expect(state.mapping.columns[1].transformations?.map((t) => t.kind)).toEqual(['PARSE_DECIMAL']);
  });

  it('knows when a chain names something this server cannot run', () => {
    const state = mappingReducer(readyState(), { type: 'CONTRACT_LOADED', contract: CONTRACT });
    expect(chainIsSupported(state, [{ kind: 'TRIM' }])).toBe(true);
    expect(chainIsSupported(state, [{ kind: 'PARSE_DATE' }])).toBe(false);
  });

  it('assumes support before the contract has arrived', () => {
    // Refusing before we know would grey out the whole editor on a slow load.
    const state = initialMappingState('PRODUCTS');
    expect(chainIsSupported(state, [{ kind: 'PARSE_DATE' }])).toBe(true);
  });
});

describe('changing the plan retracts an approval', () => {
  const approved = () => mappingReducer(readyState(), { type: 'APPROVAL_GRANTED', token: 'proof-1' });

  it('holds the approval while nothing changes', () => {
    expect(approved().approvalToken).toBe('proof-1');
  });

  it.each([
    ['assigning a field', { type: 'FIELD_ASSIGNED', columnIndex: 0, field: 'description' } as const],
    ['ignoring a column', { type: 'COLUMN_IGNORED', columnIndex: 0 } as const],
    ['adding a transformation', { type: 'TRANSFORMATION_ADDED', columnIndex: 0, kind: 'TRIM' } as const],
    ['removing a transformation', { type: 'TRANSFORMATION_REMOVED', columnIndex: 0, at: 0 } as const],
    ['moving the header row', { type: 'HEADER_ROW_CHANGED', headerRow: 3 } as const],
  ])('retracts it when %s', (_label, action) => {
    // The approval attests to a specific plan. Changing the plan after it must
    // retract it, or the attestation describes something that no longer exists.
    expect(mappingReducer(approved(), action).approvalToken).toBeNull();
  });

  it('also retracts it when a warning is accepted or un-accepted', () => {
    const accepted = mappingReducer(approved(), { type: 'ISSUE_ACKNOWLEDGED', code: 'NAME_COLLIDES_WITH_EXISTING' });
    expect(accepted.approvalToken).toBeNull();
  });

  it('never restores an approval from saved progress', () => {
    // Whatever was approved before the tab closed was approved against a target
    // state we can no longer vouch for, and re-approving is cheap.
    const restored = mappingReducer(approved(), { type: 'RESTORED', state: { approvalToken: 'stale' } });
    expect(restored.approvalToken).toBeNull();
  });
});

describe('the preview never lags behind the mapping', () => {
  it('drops a preview as soon as the mapping changes', () => {
    // A stale preview beside a changed mapping is how someone approves what
    // they were shown rather than what they built.
    const state = mappingReducer(readyState(), { type: 'FIELD_ASSIGNED', columnIndex: 0, field: 'description' });
    expect(state.preview).toBeNull();
    expect(editorReadiness(state)).toEqual({ allowed: false, reason: 'Waiting for the preview.' });
  });

  it('drops it on failure rather than leaving the previous answer on screen', () => {
    const state = mappingReducer(readyState(), { type: 'PREVIEW_FAILED', message: 'The preview could not be built.' });
    expect(state.preview).toBeNull();
    expect(editorReadiness(state).reason).toBe('The preview could not be built.');
  });

  it('says it is working rather than looking ready', () => {
    const state = mappingReducer(readyState(), { type: 'PREVIEW_STARTED' });
    expect(editorReadiness(state)).toEqual({ allowed: false, reason: 'Checking your mapping…' });
  });

  it('keeps the preview while warnings are being worked through', () => {
    // Clearing it here would make the issue list unreadable exactly while
    // someone is using it.
    let state = mappingReducer(readyState(), { type: 'PREVIEW_SUCCEEDED', preview: preview([warning('W1')]) });
    state = mappingReducer(state, { type: 'ISSUE_ACKNOWLEDGED', code: 'W1' });
    expect(state.preview).not.toBeNull();
  });
});

describe('warnings', () => {
  const withWarning = () =>
    mappingReducer(readyState(), { type: 'PREVIEW_SUCCEEDED', preview: preview([warning('W1'), warning('W2')]) });

  it('blocks until each one is accepted', () => {
    const state = withWarning();
    expect(outstandingWarnings(state)).toHaveLength(2);
    expect(editorReadiness(state).reason).toBe('2 warnings still need your confirmation.');
  });

  it('accepts them one at a time', () => {
    let state = mappingReducer(withWarning(), { type: 'ISSUE_ACKNOWLEDGED', code: 'W1' });
    expect(outstandingWarnings(state).map((i) => i.code)).toEqual(['W2']);
    state = mappingReducer(state, { type: 'ISSUE_ACKNOWLEDGED', code: 'W2' });
    expect(editorReadiness(state)).toEqual({ allowed: true });
  });

  it('lets an acceptance be taken back', () => {
    let state = mappingReducer(withWarning(), { type: 'ISSUE_ACKNOWLEDGED', code: 'W1' });
    state = mappingReducer(state, { type: 'ISSUE_UNACKNOWLEDGED', code: 'W1' });
    expect(outstandingWarnings(state)).toHaveLength(2);
  });

  it('forgets acceptances when the mapping changes', () => {
    // They attach to findings produced by the previous mapping; carrying them
    // forward would silently accept a warning the person never saw.
    let state = mappingReducer(withWarning(), { type: 'ISSUE_ACKNOWLEDGED', code: 'W1' });
    state = mappingReducer(state, { type: 'FIELD_ASSIGNED', columnIndex: 0, field: 'description' });
    expect(state.acknowledged).toEqual([]);
  });

  it('does not double-count an acceptance', () => {
    let state = mappingReducer(withWarning(), { type: 'ISSUE_ACKNOWLEDGED', code: 'W1' });
    state = mappingReducer(state, { type: 'ISSUE_ACKNOWLEDGED', code: 'W1' });
    expect(state.acknowledged).toEqual(['W1']);
  });

  it('never lets a blocking issue be accepted away', () => {
    const blocking: GroupedIssue = {
      code: 'DUPLICATE_FIELD_MAPPING',
      severity: 'BLOCKING',
      message: 'Two columns are mapped to price.',
      count: 1,
      examples: [],
      acknowledged: false,
    };
    let state = mappingReducer(readyState(), { type: 'PREVIEW_SUCCEEDED', preview: preview([blocking]) });
    state = mappingReducer(state, { type: 'ISSUE_ACKNOWLEDGED', code: 'DUPLICATE_FIELD_MAPPING' });
    expect(editorReadiness(state).allowed).toBe(false);
  });
});

describe('applying a saved mapping', () => {
  it('sends the person to the issues when the file has drifted', () => {
    const state = mappingReducer(readyState(), {
      type: 'TEMPLATE_APPLIED',
      mapping: { headerRow: 1, columns: PROPOSALS },
      drift: { drifted: true, added: [], removed: ['Coste'], reordered: false, retyped: [] },
      template: { id: 't1', name: 'Mensual', version: 2 },
    });
    expect(state.focusedRegion).toBe('ISSUES');
    expect(state.drift?.removed).toEqual(['Coste']);
    expect(state.appliedTemplate?.name).toBe('Mensual');
  });

  it('goes straight to the mapping when nothing moved', () => {
    const state = mappingReducer(readyState(), {
      type: 'TEMPLATE_APPLIED',
      mapping: { headerRow: 1, columns: PROPOSALS },
      drift: { drifted: false, added: [], removed: [], reordered: false, retyped: [] },
      template: { id: 't1', name: 'Mensual', version: 2 },
    });
    expect(state.focusedRegion).toBe('MAPPING');
  });

  it('retracts any approval, since the plan just changed wholesale', () => {
    const state = mappingReducer(
      mappingReducer(readyState(), { type: 'APPROVAL_GRANTED', token: 'proof-1' }),
      {
        type: 'TEMPLATE_APPLIED',
        mapping: { headerRow: 1, columns: PROPOSALS },
        drift: { drifted: false, added: [], removed: [], reordered: false, retyped: [] },
        template: { id: 't1', name: 'Mensual', version: 2 },
      },
    );
    expect(state.approvalToken).toBeNull();
  });
});

describe('what gets sent', () => {
  it('omits empty chains and unset flags rather than sending noise', () => {
    const request = mappingForRequest(readyState());
    expect(request.columns[0]).toEqual({
      columnIndex: 0,
      header: 'Nombre',
      field: 'name',
      reasons: ['header matches exactly'],
      reviewed: true,
    });
  });

  it('carries the sheet and header row', () => {
    const request = mappingForRequest(readyState());
    expect(request.sheet).toBe('Productos');
    expect(request.headerRow).toBe(1);
  });

  it('includes ignored columns, because ignoring is a decision the server records', () => {
    const request = mappingForRequest(readyState());
    expect(request.columns.find((c) => c.header === 'Notas')).toMatchObject({ field: null, reviewed: true });
  });
});

describe('a mapping that would do nothing', () => {
  it('is refused rather than run', () => {
    let state = readyState();
    state = mappingReducer(state, { type: 'COLUMN_IGNORED', columnIndex: 0 });
    state = mappingReducer(state, { type: 'COLUMN_IGNORED', columnIndex: 1 });
    state = mappingReducer(state, { type: 'PREVIEW_SUCCEEDED', preview: preview() });
    expect(mappedColumns(state)).toEqual([]);
    expect(editorReadiness(state).reason).toBe('Nothing is mapped, so this import would do nothing.');
  });
});

describe('before a file is chosen', () => {
  it('says so plainly instead of showing an empty editor', () => {
    expect(editorReadiness(initialMappingState('PRODUCTS'))).toEqual({
      allowed: false,
      reason: 'Choose a file to import.',
    });
  });
});
