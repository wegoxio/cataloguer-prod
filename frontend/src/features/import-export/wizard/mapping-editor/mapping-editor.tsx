'use client';

import React from 'react';
import { EditorShell, type RegionDescriptor } from './editor-shell';
import { MappingRegion, type FieldOption } from './mapping-region';
import { IssuesRegion } from './issues-region';
import { ResultRegion } from './result-region';
import { SourceRegion, type DetectedTable } from './source-region';
import {
  MappingState,
  editorReadiness,
  mappingForRequest,
  mappingReducer,
  outstandingWarnings,
  undecidedColumns,
  type MappingAction,
} from '../mapping/mapping-state';
import type { SourceAnchor, TableMapping, WizardContract } from '../api/wizard-contract.types';

/**
 * The mapping editor, wired together.
 *
 * The container's only real job is keeping the preview honest. Every edit
 * invalidates the last answer, and this is what asks for a new one — debounced,
 * because someone typing a separator into a text box would otherwise fire a
 * request per keystroke, and cancelled-by-sequence, because a slow response to
 * an old mapping arriving after a fast response to a new one would put a
 * confidently wrong preview on screen.
 *
 * Nothing here recomputes what the server computes. A client-side preview would
 * be a second opinion that can disagree with the one that actually runs.
 */

export interface MappingEditorProps {
  state: MappingState;
  dispatch: (action: MappingAction) => void;
  fieldOptions: FieldOption[];
  /** Asks the server what the current mapping would produce. */
  requestPreview: (mapping: TableMapping) => Promise<void>;
  /**
   * Bumped by Retry.
   *
   * A failed preview leaves a terminal error that deliberately stops the
   * automatic request, so pressing Retry has to say "ask again" explicitly —
   * nothing else about the mapping has changed, and without this the effect
   * would have no reason to re-run.
   */
  previewAttempt?: number;
  fileName?: string | null;
  sheets?: string[];
  tables?: DetectedTable[];
  activeTableId?: string | null;
  onSelectSheet?: (sheet: string) => void;
  onSelectTable?: (tableId: string) => void;
  footer?: React.ReactNode;
}

/** How long to wait after the last edit before asking the server. */
export const PREVIEW_DEBOUNCE_MS = 400;

export function MappingEditor({
  state,
  dispatch,
  fieldOptions,
  requestPreview,
  previewAttempt = 0,
  fileName = null,
  sheets = [],
  tables = [],
  activeTableId = null,
  onSelectSheet,
  onSelectTable,
  footer,
}: MappingEditorProps) {
  const mapping = mappingForRequest(state);
  // Serialised so the effect fires on a real change to what would be written,
  // not on every re-render that happens to produce a new object.
  const mappingKey = JSON.stringify(mapping);
  const hasSample = state.sample !== null;

  const sequence = React.useRef(0);

    /**
     * Ask for a preview when one is NEEDED — not merely when the mapping changes.
     *
     * Keying this on `mappingKey` alone left the wizard stuck. Restoring saved
     * work clears the preview deliberately (a preview describes a mapping
     * somebody reviewed, and a restored one has not been), but a restored
     * mapping serialises IDENTICALLY to the proposals already on screen. The
     * key did not change, the effect did not run, and no preview was ever
     * requested: `previewing` false, `previewError` null, and the editor
     * reporting "Waiting for the preview." for as long as anyone cared to look.
     * There was no unresolved promise — there was a request nobody made.
     *
     * The condition is about the STATE, not about the change: a mapping and a
     * sample exist, no preview is held, nothing is in flight, and no failure is
     * waiting for somebody to press Retry. `previewAttempt` is in the key so
     * that Retry asks again even when nothing else has moved.
     */
    const needsPreview =
      hasSample &&
      mapping.columns.length > 0 &&
      state.preview === null &&
      !state.previewing &&
      state.previewError === null;

    React.useEffect(() => {
      if (!needsPreview) return undefined;

      const ticket = ++sequence.current;
      const timer = setTimeout(() => {
        void requestPreview(mapping).finally(() => {
          // A response for a mapping that has since been edited is not an
          // answer to the question on screen. Dropping it here is what stops a
          // slow old response overwriting a fast new one.
          if (ticket !== sequence.current) return;
        });
      }, PREVIEW_DEBOUNCE_MS);

      return () => clearTimeout(timer);
      // `mapping` is derived from `mappingKey`; depending on the object itself
      // would re-run this on every render.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mappingKey, needsPreview, previewAttempt]);

  const goToAnchor = (anchor: SourceAnchor) => {
    const column = state.mapping.columns.find((c) => c.header === anchor.column);
    if (column) dispatch({ type: 'COLUMN_FOCUSED', columnIndex: column.columnIndex });
    // The result region is where a person can see the offending value beside
    // what it would become, which is what they actually came to look at.
    dispatch({ type: 'REGION_FOCUSED', region: 'RESULT' });
  };

  const regions: RegionDescriptor[] = [
    {
      id: 'SOURCE',
      label: 'Your file',
      content: (
        <SourceRegion
          fileName={fileName}
          sheets={sheets}
          activeSheet={state.mapping.sheet ?? null}
          onSelectSheet={onSelectSheet ?? (() => undefined)}
          tables={tables}
          activeTableId={activeTableId}
          onSelectTable={onSelectTable ?? (() => undefined)}
          sample={state.sample}
          headerRow={state.mapping.headerRow}
          onHeaderRowChange={(headerRow) => dispatch({ type: 'HEADER_ROW_CHANGED', headerRow })}
          focusedColumnIndex={state.focusedColumnIndex}
          onFocusColumn={(columnIndex) => dispatch({ type: 'COLUMN_FOCUSED', columnIndex })}
        />
      ),
    },
    {
      id: 'MAPPING',
      label: 'Mapping',
      badge: badgeForUndecided(state),
      content: (
        <MappingRegion
          columns={state.mapping.columns}
          fieldOptions={fieldOptions}
          contract={state.contract}
          focusedColumnIndex={state.focusedColumnIndex}
          onFocusColumn={(columnIndex) => dispatch({ type: 'COLUMN_FOCUSED', columnIndex })}
          onAssignField={(columnIndex, field) => dispatch({ type: 'FIELD_ASSIGNED', columnIndex, field })}
          onIgnoreColumn={(columnIndex) => dispatch({ type: 'COLUMN_IGNORED', columnIndex })}
          onAddTransformation={(columnIndex, kind) =>
            dispatch({ type: 'TRANSFORMATION_ADDED', columnIndex, kind, options: defaultOptionsFor(state.contract, kind) })
          }
          onRemoveTransformation={(columnIndex, at) => dispatch({ type: 'TRANSFORMATION_REMOVED', columnIndex, at })}
          onMoveTransformation={(columnIndex, from, to) =>
            dispatch({ type: 'TRANSFORMATION_MOVED', columnIndex, from, to })
          }
          onSetOption={(columnIndex, at, option, value) =>
            dispatch({ type: 'TRANSFORMATION_OPTION_SET', columnIndex, at, option, value })
          }
        />
      ),
    },
    {
      id: 'ISSUES',
      label: 'Issues',
      badge: badgeForIssues(state),
      content: (
        <IssuesRegion
          issues={state.preview?.issues ?? []}
          acknowledged={state.acknowledged}
          onAcknowledge={(code) => dispatch({ type: 'ISSUE_ACKNOWLEDGED', code })}
          onUnacknowledge={(code) => dispatch({ type: 'ISSUE_UNACKNOWLEDGED', code })}
          onGoToAnchor={goToAnchor}
        />
      ),
    },
    {
      id: 'RESULT',
      label: 'Result',
      content: (
        <ResultRegion
          preview={state.preview}
          previewing={state.previewing}
          previewError={state.previewError}
          focusedColumnIndex={state.focusedColumnIndex}
        />
      ),
    },
  ];

  return (
    <EditorShell
      regions={regions}
      active={state.focusedRegion}
      onActivate={(region) => dispatch({ type: 'REGION_FOCUSED', region })}
      footer={footer ?? <ReadinessBar state={state} />}
    />
  );
}

/**
 * The one sentence that matters: may this run, and if not, why.
 *
 * Sticky and always present, because "can I press the button yet?" should never
 * require scrolling past four panels to answer.
 */
export function ReadinessBar({ state }: { state: MappingState }) {
  const readiness = editorReadiness(state);
  return (
    <div className="flex flex-wrap items-center justify-between gap-2" data-testid="readiness">
      <p
        className={readiness.allowed ? 'text-sm font-semibold text-emerald-700' : 'text-sm text-slate-700'}
        // Announced when it changes, so a keyboard user working through the
        // issue list hears the moment the import becomes runnable.
        role="status"
        aria-live="polite"
      >
        {readiness.allowed ? 'Ready to continue.' : readiness.reason}
      </p>
    </div>
  );
}

function badgeForUndecided(state: MappingState): RegionDescriptor['badge'] {
  const count = undecidedColumns(state).length;
  if (count === 0) return undefined;
  return { text: `${count} to decide`, tone: 'warning' };
}

function badgeForIssues(state: MappingState): RegionDescriptor['badge'] {
  const blocking = (state.preview?.issues ?? []).filter((i) => i.severity === 'BLOCKING').length;
  if (blocking > 0) {
    return { text: blocking === 1 ? '1 to fix' : `${blocking} to fix`, tone: 'blocking' };
  }
  const warnings = outstandingWarnings(state).length;
  if (warnings > 0) {
    return { text: warnings === 1 ? '1 warning' : `${warnings} warnings`, tone: 'warning' };
  }
  return undefined;
}

/**
 * A new step arrives with the defaults the server declared.
 *
 * Otherwise a required choice — the decimal separator, the date order — starts
 * empty, the first preview fails on every row, and the person's introduction to
 * the step is a wall of errors they did not cause.
 */
export function defaultOptionsFor(contract: WizardContract | null, kind: string): Record<string, unknown> {
  const spec = contract?.transformations.find((t) => t.kind === kind);
  if (!spec) return {};
  const options: Record<string, unknown> = {};
  for (const option of spec.options) {
    if (option.default !== undefined) options[option.name] = option.default;
  }
  return options;
}

/** Convenience for a page that wants the reducer without assembling it. */
export function useMappingEditor(initial: MappingState): [MappingState, React.Dispatch<MappingAction>] {
  return React.useReducer(mappingReducer, initial);
}
