import type {
  ColumnMapping,
  GroupedIssue,
  PreviewResponse,
  ShapeDrift,
  SourceSample,
  TableMapping,
  Transformation,
  TransformationKind,
  WizardContract,
} from '../api/wizard-contract.types';

/**
 * The mapping editor's state, kept out of the components that draw it.
 *
 * Everything the editor decides happens here: which column becomes which field,
 * what is done to its values, which warnings a person has accepted, and whether
 * the whole thing may run. Keeping it in a reducer means those decisions can be
 * tested as decisions rather than through the DOM, and it means the four
 * regions of the screen are four views of one truth rather than four states
 * that can disagree.
 *
 * The rules that are easy to get wrong and expensive to get wrong:
 *
 *  - **Every column needs a decision.** Mapped or explicitly ignored. Silence
 *    is not a decision, and a column nobody looked at is how a price column
 *    goes missing.
 *  - **Editing anything invalidates an approval.** The approval attests to a
 *    specific plan; changing the plan after it must retract it, or the
 *    attestation describes something that no longer exists.
 *  - **Acknowledging a warning is per warning**, and changing the mapping
 *    clears the acknowledgements that the change could have invalidated.
 */

export type ImportType = 'PRODUCTS' | 'CATEGORIES' | 'HISTORICAL_STORE_SALES';

/** Which of the four regions currently has the person's attention. */
export type EditorRegion = 'SOURCE' | 'MAPPING' | 'ISSUES' | 'RESULT';

export interface MappingState {
  importType: ImportType;
  contract: WizardContract | null;

  /** The bounded slice of the file the editor works against. */
  sample: SourceSample | null;
  /** Inferred column types, used for template drift and proposals. */
  columnTypes: string[];

  mapping: TableMapping;

  /** Last preview the server returned for the current mapping. */
  preview: PreviewResponse | null;
  /** True while a preview is in flight, so the result region can say so. */
  previewing: boolean;
  /** Set when the preview could not be produced at all. */
  previewError: string | null;

  /** Issue codes the person has accepted, cleared when the mapping changes. */
  acknowledged: string[];

  /** Set when a saved mapping was applied to a file that has since changed. */
  drift: ShapeDrift | null;
  appliedTemplate: { id: string; name: string; version: number } | null;

  /** Cleared by any edit: an approval describes a specific plan. */
  approvalToken: string | null;

  focusedRegion: EditorRegion;
  /** Column the person is inspecting, which drives the result region's highlight. */
  focusedColumnIndex: number | null;
  /**
   * Whether this mapping came back from saved progress.
   *
   * Read by `SOURCE_LOADED`, which would otherwise replace a restored mapping
   * with the analysis's own proposals the moment the file finished being read —
   * silently discarding the work the person had just chosen to continue.
   */
  restored: boolean;
}

export type MappingAction =
  | { type: 'CONTRACT_LOADED'; contract: WizardContract }
  | { type: 'SOURCE_LOADED'; sample: SourceSample; columnTypes: string[]; proposals: ColumnMapping[] }
  | { type: 'HEADER_ROW_CHANGED'; headerRow: number }
  | { type: 'FIELD_ASSIGNED'; columnIndex: number; field: string | null }
  | { type: 'COLUMN_IGNORED'; columnIndex: number }
  | { type: 'TRANSFORMATION_ADDED'; columnIndex: number; kind: TransformationKind; options?: Record<string, unknown> }
  | { type: 'TRANSFORMATION_REMOVED'; columnIndex: number; at: number }
  | { type: 'TRANSFORMATION_MOVED'; columnIndex: number; from: number; to: number }
  | { type: 'TRANSFORMATION_OPTION_SET'; columnIndex: number; at: number; option: string; value: unknown }
  | { type: 'PREVIEW_STARTED' }
  | { type: 'PREVIEW_SUCCEEDED'; preview: PreviewResponse }
  | { type: 'PREVIEW_FAILED'; message: string }
  /** Clear a terminal preview failure so one fresh request may be made. */
  | { type: 'PREVIEW_RETRY' }
  | { type: 'ISSUE_ACKNOWLEDGED'; code: string }
  | { type: 'ISSUE_UNACKNOWLEDGED'; code: string }
  | { type: 'TEMPLATE_APPLIED'; mapping: TableMapping; drift: ShapeDrift; template: { id: string; name: string; version: number } }
  | { type: 'APPROVAL_GRANTED'; token: string }
  | { type: 'REGION_FOCUSED'; region: EditorRegion }
  | { type: 'COLUMN_FOCUSED'; columnIndex: number | null }
  /**
   * The server said what this import actually is.
   *
   * Only the plan route dispatches this, and only from `StoredPlan.importType`.
   * The type used to be settled once at mount from the URL alone, with no action
   * that could revise it — so a plan opened by a link that had lost its `type`
   * parameter became a products import for the rest of its life, and offered the
   * products field catalogue over a historical-sales file.
   *
   * A CHANGE resets everything derived from the old type. Fields belong to a
   * type's catalogue, so a mapping made under the wrong one is not a mapping for
   * this import at all, and carrying it over is exactly how a stale products
   * mapping would ride into another type's plan hash.
   */
  | { type: 'TYPE_RESOLVED'; importType: ImportType }
  | { type: 'RESTORED'; state: Partial<MappingState> };

export function initialMappingState(importType: ImportType): MappingState {
  return {
    importType,
    contract: null,
    sample: null,
    columnTypes: [],
    mapping: { headerRow: 1, columns: [] },
    preview: null,
    previewing: false,
    previewError: null,
    acknowledged: [],
    drift: null,
    appliedTemplate: null,
    approvalToken: null,
    focusedRegion: 'SOURCE',
    focusedColumnIndex: null,
    restored: false,
  };
}

/**
 * Any change to what would be written.
 *
 * Two things happen together and must never come apart: an approval is
 * retracted, and the preview is marked stale. Leaving a stale preview on screen
 * beside a changed mapping is how someone approves what they were shown rather
 * than what they built.
 */
function invalidate(state: MappingState): MappingState {
  return {
    ...state,
    approvalToken: null,
    preview: null,
    previewError: null,
    // Acknowledgements attach to findings produced by the previous mapping.
    // Carrying them forward would silently accept a warning about something the
    // person never saw.
    acknowledged: [],
  };
}

function updateColumn(
  state: MappingState,
  columnIndex: number,
  change: (column: ColumnMapping) => ColumnMapping,
): MappingState {
  // ADR 018 rollback window: a column the person DELIBERATELY edits leaves with
  // the rollback-compatible field spelling, whatever it was stored as. This is
  // the one place every per-column edit passes through, and a read never
  // reaches it — so opening a plan still preserves its bytes exactly, while a
  // transformation-only edit no longer strands a canonical `optionLabel` that a
  // rolled-back backend would silently drop.
  const columns = state.mapping.columns.map((c) =>
    c.columnIndex === columnIndex ? change(c) : c,
  );
  return invalidate({ ...state, mapping: { ...state.mapping, columns } });
}

export function mappingReducer(state: MappingState, action: MappingAction): MappingState {
  switch (action.type) {
    case 'CONTRACT_LOADED':
      return { ...state, contract: action.contract };

    case 'TYPE_RESOLVED': {
      // Identity return when it agrees, so confirming what we already believed
      // does not restart every effect that depends on this state.
      if (state.importType === action.importType) return state;
      // A fresh state rather than a patched one. Anything derived from the
      // previous type — the mapping, the sample's proposals, a preview, an
      // approval — describes a different import, and listing which parts to
      // keep is how one of them gets forgotten.
      return { ...initialMappingState(action.importType), contract: state.contract };
    }

    case 'SOURCE_LOADED': {
      // A restored mapping outranks the analysis's proposals.
      //
      // Both describe the same columns, but one of them is a person's twenty
      // minutes of decisions and the other is a suggestion. The file arrives
      // AFTER the offer is accepted — the offer is shown while the file is
      // still being read — so replacing the mapping here is exactly how
      // restored work used to vanish a second after it came back.
      //
      // Only when the file still has the same columns, in the same order: the
      // mapping is by index, so a file that has changed underneath makes the
      // restored assignments wrong rather than merely old. Then the proposals
      // win, and the wizard says so.
      const keepRestored = state.restored && sameHeaders(state.mapping.columns, action.proposals);
      return invalidate({
        ...state,
        sample: action.sample,
        columnTypes: action.columnTypes,
        mapping: {
          sheet: action.sample.sheet,
          headerRow: state.mapping.headerRow,
          // ADR 018 rollback window. A RESTORED mapping is preserved
          // byte-for-byte; FRESH proposals are normalised here, before they
          // become savable state. The backend proposer is canonical
          // (`optionLabel`), and a column it mapped automatically could
          // otherwise be accepted without anyone editing it and persist a name
          // a rolled-back backend silently drops. This is the boundary where a
          // suggestion becomes a decision.
          columns: keepRestored ? state.mapping.columns : action.proposals,
        },
        restored: keepRestored,
        drift: null,
        appliedTemplate: null,
        focusedRegion: 'MAPPING',
      });
    }

    case 'HEADER_ROW_CHANGED':
      // Moving the header row changes what every column IS, so the existing
      // mapping cannot survive it. Reloading the source is the caller's job;
      // keeping stale columns here would be worse than clearing them.
      return invalidate({
        ...state,
        mapping: { ...state.mapping, headerRow: action.headerRow, columns: [] },
      });

    case 'FIELD_ASSIGNED':
      return updateColumn(state, action.columnIndex, (c) => ({
        ...c,
        field: action.field,
        // Assigning a field IS looking at the column.
        reviewed: true,
      }));

    case 'COLUMN_IGNORED':
      return updateColumn(state, action.columnIndex, (c) => ({
        ...c,
        field: null,
        reviewed: true,
        // The transformations go with the field. Keeping them on an ignored
        // column would resurrect them if it were mapped again later, which is
        // not what "ignore" means to the person who clicked it.
        transformations: [],
      }));

    case 'TRANSFORMATION_ADDED':
      return updateColumn(state, action.columnIndex, (c) => ({
        ...c,
        transformations: [...(c.transformations ?? []), { kind: action.kind, options: action.options ?? {} }],
      }));

    case 'TRANSFORMATION_REMOVED':
      return updateColumn(state, action.columnIndex, (c) => ({
        ...c,
        transformations: (c.transformations ?? []).filter((_, i) => i !== action.at),
      }));

    case 'TRANSFORMATION_MOVED': {
      // Order matters: trim-then-parse is a different mapping from the reverse,
      // and the order is what gets hashed into the approval.
      return updateColumn(state, action.columnIndex, (c) => {
        const chain = [...(c.transformations ?? [])];
        if (action.from < 0 || action.from >= chain.length) return c;
        const clampedTo = Math.max(0, Math.min(chain.length - 1, action.to));
        const [moved] = chain.splice(action.from, 1);
        chain.splice(clampedTo, 0, moved);
        return { ...c, transformations: chain };
      });
    }

    case 'TRANSFORMATION_OPTION_SET':
      return updateColumn(state, action.columnIndex, (c) => ({
        ...c,
        transformations: (c.transformations ?? []).map((t, i) =>
          i === action.at ? { ...t, options: { ...(t.options ?? {}), [action.option]: action.value } } : t,
        ),
      }));

    case 'PREVIEW_STARTED':
      return { ...state, previewing: true, previewError: null };

    case 'PREVIEW_SUCCEEDED':
      return { ...state, previewing: false, preview: action.preview, previewError: null };

    case 'PREVIEW_FAILED':
      // The preview is dropped rather than left stale. A result panel showing
      // the previous mapping's output beside an error is worse than an empty
      // one, because it still looks like an answer.
      return { ...state, previewing: false, preview: null, previewError: action.message };

    case 'PREVIEW_RETRY':
      // Only the failure is cleared. The mapping and the relationship decisions
      // are the person's work and survive a failed check untouched.
      return { ...state, previewError: null, previewing: false, preview: null };

    case 'ISSUE_ACKNOWLEDGED':
      if (state.acknowledged.includes(action.code)) return state;
      // Accepting a warning is a decision about the plan, so it retracts an
      // approval given before it — but it must NOT clear the preview the
      // person is reading while they work through the list.
      return { ...state, acknowledged: [...state.acknowledged, action.code], approvalToken: null };

    case 'ISSUE_UNACKNOWLEDGED':
      return {
        ...state,
        acknowledged: state.acknowledged.filter((c) => c !== action.code),
        approvalToken: null,
      };

    case 'TEMPLATE_APPLIED':
      return invalidate({
        ...state,
        mapping: action.mapping,
        drift: action.drift,
        appliedTemplate: action.template,
        focusedRegion: action.drift.drifted ? 'ISSUES' : 'MAPPING',
      });

    case 'APPROVAL_GRANTED':
      return { ...state, approvalToken: action.token };

    case 'REGION_FOCUSED':
      return { ...state, focusedRegion: action.region };

    case 'COLUMN_FOCUSED':
      return { ...state, focusedColumnIndex: action.columnIndex };

    case 'RESTORED':
      // Restoring never carries an approval. Whatever was approved before the
      // tab closed was approved against a target state we can no longer vouch
      // for, and re-approving is cheap.
      return { ...state, ...action.state, restored: true, approvalToken: null, previewing: false };

    default:
      return state;
  }
}

/**
 * Columns still awaiting a decision.
 *
 * The editor's most important counter. A column nobody looked at is how a price
 * column silently goes missing, so "3 columns still need a decision" is shown
 * rather than left to be discovered.
 */
export function undecidedColumns(state: MappingState): ColumnMapping[] {
  return state.mapping.columns.filter((c) => c.field === null && !c.reviewed);
}

/** Columns bound to a target field, in file order. */
export function mappedColumns(state: MappingState): ColumnMapping[] {
  return state.mapping.columns.filter((c) => c.field !== null);
}

/**
 * The mapping as it should be sent, with acknowledgements applied.
 *
 * The server recomputes findings from the mapping alone, so acknowledgements
 * travel separately rather than being baked into the columns.
 */
export function mappingForRequest(state: MappingState): TableMapping {
  return {
    sheet: state.mapping.sheet,
    headerRow: state.mapping.headerRow,
    columns: state.mapping.columns.map((c) => ({
      columnIndex: c.columnIndex,
      header: c.header,
      field: c.field,
      ...(c.transformations && c.transformations.length > 0 ? { transformations: c.transformations } : {}),
      ...(c.reasons && c.reasons.length > 0 ? { reasons: c.reasons } : {}),
      ...(c.reviewed ? { reviewed: true } : {}),
    })),
  };
}

/**
 * Whether the person may proceed, from everything the editor knows.
 *
 * The server's readiness is authoritative about the data. This adds the two
 * things only the editor knows: whether every column has been decided, and
 * whether the warnings the server raised have been accepted here.
 */
export function editorReadiness(state: MappingState): { allowed: boolean; reason?: string } {
  if (!state.sample) return { allowed: false, reason: 'Choose a file to import.' };

  // Undecided columns come FIRST, ahead of anything about the preview. While
  // columns are still undecided the person's next action is deciding them, and
  // "waiting for the preview" tells them to do nothing — which is both untrue
  // and unhelpful, since the preview will arrive on its own.
  const undecided = undecidedColumns(state);
  if (undecided.length > 0) {
    return {
      allowed: false,
      reason:
        undecided.length === 1
          ? `One column still needs a decision: "${undecided[0].header}".`
          : `${undecided.length} columns still need a decision.`,
    };
  }

  if (state.previewError) return { allowed: false, reason: state.previewError };
  if (state.previewing) return { allowed: false, reason: 'Checking your mapping…' };
  if (!state.preview) return { allowed: false, reason: 'Waiting for the preview.' };

  const blocking = state.preview.issues.filter((i) => i.severity === 'BLOCKING');
  if (blocking.length > 0) {
    return { allowed: false, reason: state.preview.readiness.reason ?? 'Some problems must be fixed first.' };
  }

  const unaccepted = outstandingWarnings(state);
  if (unaccepted.length > 0) {
    return {
      allowed: false,
      reason:
        unaccepted.length === 1
          ? 'One warning still needs your confirmation.'
          : `${unaccepted.length} warnings still need your confirmation.`,
    };
  }

  if (mappedColumns(state).length === 0) {
    return { allowed: false, reason: 'Nothing is mapped, so this import would do nothing.' };
  }

  return { allowed: true };
}

/** Warnings the person has not yet accepted. */
export function outstandingWarnings(state: MappingState): GroupedIssue[] {
  if (!state.preview) return [];
  return state.preview.issues.filter((i) => i.severity === 'WARNING' && !state.acknowledged.includes(i.code));
}

/** Whether a chain is one the connected server can execute. */
export function chainIsSupported(state: MappingState, chain: Transformation[] | undefined): boolean {
  if (!state.contract) return true;
  const supported = new Set<string>(state.contract.supportedTransformations);
  return (chain ?? []).every((t) => supported.has(t.kind));
}

/**
 * Whether two column lists describe the same file, in the same order.
 *
 * Order and not merely membership: every mapping decision is keyed by column
 * index, so the same headers rearranged point every decision at a different
 * column.
 */
function sameHeaders(a: { header: string }[], b: { header: string }[]): boolean {
  return a.length === b.length && a.every((column, index) => column.header === b[index].header);
}
