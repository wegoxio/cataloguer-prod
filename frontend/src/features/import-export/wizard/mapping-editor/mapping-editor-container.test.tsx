import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderComponent, cleanupAll, flush } from '../../../../test/render';
import { MappingEditor, PREVIEW_DEBOUNCE_MS, ReadinessBar, defaultOptionsFor } from './mapping-editor';
import { initialMappingState, mappingReducer, type MappingState } from '../mapping/mapping-state';
import type { PreviewResponse, WizardContract } from '../api/wizard-contract.types';

/**
 * Wiring the four regions to one state.
 *
 * The container's real job is keeping the preview honest, so that is what is
 * tested: that it does not fire on every keystroke, and that a slow answer to
 * an old mapping cannot land on top of a fast answer to a new one.
 */

afterEach(() => {
  cleanupAll();
  vi.useRealTimers();
});

const CONTRACT: WizardContract = {
  version: '1.0.0',
  supportedTransformations: ['PARSE_DECIMAL'],
  issueSeverities: {},
  transformations: [
    {
      kind: 'PARSE_DECIMAL',
      label: 'Read as a number with decimals',
      description: 'Reads a price.',
      group: 'NUMBER',
      options: [
        {
          name: 'decimalSeparator',
          type: 'CHOICE',
          label: 'Decimal separator',
          required: true,
          default: ',',
          choices: [
            { value: ',', label: 'Comma' },
            { value: '.', label: 'Full stop' },
          ],
        },
        { name: 'noDefault', type: 'TEXT', label: 'Something optional' },
      ],
      example: { before: '1,5', after: '1.5' },
    },
  ],
};

const emptyPreview: PreviewResponse = {
  rows: [],
  ignoredColumns: [],
  blankRowCount: 0,
  previewedRows: 0,
  issues: [],
  summary: { blocking: 0, warning: 0, informational: 0, unacknowledgedWarnings: 0, total: 0 },
  readiness: { allowed: true },
};

function loaded(): MappingState {
  let state = initialMappingState('PRODUCTS');
  state = mappingReducer(state, { type: 'CONTRACT_LOADED', contract: CONTRACT });
  state = mappingReducer(state, {
    type: 'SOURCE_LOADED',
    sample: { sheet: 'Productos', firstRowNumber: 2, headers: ['Nombre'], rows: [['Camiseta']] },
    columnTypes: ['TEXT'],
    proposals: [{ columnIndex: 0, header: 'Nombre', field: 'name', reviewed: true }],
  });
  return state;
}

const FIELD_OPTIONS = [{ value: 'name', label: 'Name' }];

describe('asking the server for a preview', () => {
  it('waits for the person to stop editing rather than firing per keystroke', async () => {
    vi.useFakeTimers();
    const requestPreview = vi.fn().mockResolvedValue(undefined);

    await renderComponent(
      <MappingEditor
        state={loaded()}
        dispatch={() => undefined}
        fieldOptions={FIELD_OPTIONS}
        requestPreview={requestPreview}
      />,
    );

    expect(requestPreview).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1);
    expect(requestPreview).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(requestPreview).toHaveBeenCalledTimes(1);
  });

  it('does not ask before a file has been chosen', async () => {
    vi.useFakeTimers();
    const requestPreview = vi.fn().mockResolvedValue(undefined);
    await renderComponent(
      <MappingEditor
        state={initialMappingState('PRODUCTS')}
        dispatch={() => undefined}
        fieldOptions={FIELD_OPTIONS}
        requestPreview={requestPreview}
      />,
    );
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 3);
    expect(requestPreview).not.toHaveBeenCalled();
  });

  it('sends the mapping as the server expects it', async () => {
    vi.useFakeTimers();
    const requestPreview = vi.fn().mockResolvedValue(undefined);
    await renderComponent(
      <MappingEditor
        state={loaded()}
        dispatch={() => undefined}
        fieldOptions={FIELD_OPTIONS}
        requestPreview={requestPreview}
      />,
    );
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 1);
    expect(requestPreview).toHaveBeenCalledWith({
      sheet: 'Productos',
      headerRow: 1,
      columns: [{ columnIndex: 0, header: 'Nombre', field: 'name', reviewed: true }],
    });
  });

  it('asks again when the mapping actually changes', async () => {
    vi.useFakeTimers();
    const requestPreview = vi.fn().mockResolvedValue(undefined);
    const state = loaded();
    const { rerender } = await renderComponent(
      <MappingEditor
        state={state}
        dispatch={() => undefined}
        fieldOptions={FIELD_OPTIONS}
        requestPreview={requestPreview}
      />,
    );
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 1);
    expect(requestPreview).toHaveBeenCalledTimes(1);

    const changed = mappingReducer(state, { type: 'FIELD_ASSIGNED', columnIndex: 0, field: 'price' });
    await rerender(
      <MappingEditor
        state={changed}
        dispatch={() => undefined}
        fieldOptions={FIELD_OPTIONS}
        requestPreview={requestPreview}
      />,
    );
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 1);
    expect(requestPreview).toHaveBeenCalledTimes(2);
  });

  it('does NOT ask again when nothing that would be written changed', async () => {
    // Re-rendering for a focus change or a region switch must not cost a round
    // trip; the editor re-renders constantly as someone moves around it.
    vi.useFakeTimers();
    const requestPreview = vi.fn().mockResolvedValue(undefined);
    const state = loaded();
    const { rerender } = await renderComponent(
      <MappingEditor
        state={state}
        dispatch={() => undefined}
        fieldOptions={FIELD_OPTIONS}
        requestPreview={requestPreview}
      />,
    );
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 1);

    const refocused = mappingReducer(state, { type: 'COLUMN_FOCUSED', columnIndex: 0 });
    await rerender(
      <MappingEditor
        state={refocused}
        dispatch={() => undefined}
        fieldOptions={FIELD_OPTIONS}
        requestPreview={requestPreview}
      />,
    );
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 3);
    expect(requestPreview).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending request when another edit lands first', async () => {
    // Two edits in quick succession should produce ONE call, for the later
    // mapping — not two, of which the earlier could answer last.
    vi.useFakeTimers();
    const requestPreview = vi.fn().mockResolvedValue(undefined);
    const state = loaded();
    const { rerender } = await renderComponent(
      <MappingEditor
        state={state}
        dispatch={() => undefined}
        fieldOptions={FIELD_OPTIONS}
        requestPreview={requestPreview}
      />,
    );
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS / 2);

    const changed = mappingReducer(state, { type: 'FIELD_ASSIGNED', columnIndex: 0, field: 'price' });
    await rerender(
      <MappingEditor
        state={changed}
        dispatch={() => undefined}
        fieldOptions={FIELD_OPTIONS}
        requestPreview={requestPreview}
      />,
    );
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS + 1);

    expect(requestPreview).toHaveBeenCalledTimes(1);
    expect(requestPreview).toHaveBeenCalledWith(
      expect.objectContaining({ columns: [expect.objectContaining({ field: 'price' })] }),
    );
  });
});

describe('a new clean-up step', () => {
  it('arrives with the defaults the server declared', () => {
    // Otherwise a required choice starts empty, the first preview fails on
    // every row, and the person's introduction to the step is a wall of errors
    // they did not cause.
    expect(defaultOptionsFor(CONTRACT, 'PARSE_DECIMAL')).toEqual({ decimalSeparator: ',' });
  });

  it('carries nothing for an option with no default', () => {
    expect(defaultOptionsFor(CONTRACT, 'PARSE_DECIMAL')).not.toHaveProperty('noDefault');
  });

  it('carries nothing at all for an operation the server did not describe', () => {
    expect(defaultOptionsFor(CONTRACT, 'PARSE_DATE')).toEqual({});
    expect(defaultOptionsFor(null, 'PARSE_DECIMAL')).toEqual({});
  });
});

describe('the readiness bar', () => {
  it('announces changes politely, so a keyboard user hears the moment it opens', async () => {
    const { container } = await renderComponent(<ReadinessBar state={loaded()} />);
    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-live')).toBe('polite');
  });

  it('says what is missing rather than merely being disabled', async () => {
    const { text } = await renderComponent(<ReadinessBar state={loaded()} />);
    expect(text()).toContain('Waiting for the preview.');
  });

  it('says so plainly once everything is in order', async () => {
    const ready = mappingReducer(loaded(), { type: 'PREVIEW_SUCCEEDED', preview: emptyPreview });
    const { text } = await renderComponent(<ReadinessBar state={ready} />);
    expect(text()).toContain('Ready to continue.');
  });
});

describe('the region badges', () => {
  it('counts the columns still needing a decision', async () => {
    let state = initialMappingState('PRODUCTS');
    state = mappingReducer(state, {
      type: 'SOURCE_LOADED',
      sample: { firstRowNumber: 2, headers: ['A', 'B'], rows: [['1', '2']] },
      columnTypes: [],
      proposals: [
        { columnIndex: 0, header: 'A', field: null },
        { columnIndex: 1, header: 'B', field: null },
      ],
    });
    const { text } = await renderComponent(
      <MappingEditor
        state={state}
        dispatch={() => undefined}
        fieldOptions={FIELD_OPTIONS}
        requestPreview={async () => undefined}
      />,
    );
    await flush();
    expect(text()).toContain('2 to decide');
  });

  it('shows what must be FIXED ahead of what merely needs confirming', async () => {
    const withBoth = mappingReducer(loaded(), {
      type: 'PREVIEW_SUCCEEDED',
      preview: {
        ...emptyPreview,
        issues: [
          { code: 'B1', severity: 'BLOCKING', message: 'x', count: 1, examples: [], acknowledged: false },
          { code: 'W1', severity: 'WARNING', message: 'y', count: 1, examples: [], acknowledged: false },
        ],
      },
    });
    const { text } = await renderComponent(
      <MappingEditor
        state={withBoth}
        dispatch={() => undefined}
        fieldOptions={FIELD_OPTIONS}
        requestPreview={async () => undefined}
      />,
    );
    await flush();
    // A blocking problem outranks a warning: it is the thing that has to happen
    // first, and showing "1 warning" beside it would understate the situation.
    expect(text()).toContain('1 to fix');
    expect(text()).not.toContain('1 warning');
  });

  it('shows no badge when there is nothing outstanding', async () => {
    const clean = mappingReducer(loaded(), { type: 'PREVIEW_SUCCEEDED', preview: emptyPreview });
    const { text } = await renderComponent(
      <MappingEditor
        state={clean}
        dispatch={() => undefined}
        fieldOptions={FIELD_OPTIONS}
        requestPreview={async () => undefined}
      />,
    );
    await flush();
    expect(text()).not.toContain('to decide');
    expect(text()).not.toContain('to fix');
  });
});

describe('following a finding to its place', () => {
  it('focuses the offending column and shows the result region', async () => {
    // Where a person can see the value beside what it would become, which is
    // what they actually came to look at.
    const dispatch = vi.fn();
    const state = mappingReducer(loaded(), {
      type: 'PREVIEW_SUCCEEDED',
      preview: {
        ...emptyPreview,
        issues: [
          {
            code: 'VALUE_NOT_PARSEABLE',
            severity: 'WARNING',
            message: 'Not a number.',
            count: 1,
            examples: [{ sheet: 'Productos', row: 2, column: 'Nombre' }],
            acknowledged: false,
          },
        ],
      },
    });

    const { container } = await renderComponent(
      <MappingEditor
        state={state}
        dispatch={dispatch}
        fieldOptions={FIELD_OPTIONS}
        requestPreview={async () => undefined}
      />,
    );

    const anchor = Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Productos · row 2 · Nombre'),
    );
    anchor?.click();
    await flush();

    expect(dispatch).toHaveBeenCalledWith({ type: 'COLUMN_FOCUSED', columnIndex: 0 });
    expect(dispatch).toHaveBeenCalledWith({ type: 'REGION_FOCUSED', region: 'RESULT' });
  });
});
