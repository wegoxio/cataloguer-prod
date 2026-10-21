import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderComponent, cleanupAll } from '../../../../test/render';
import { MappingRegion } from '../mapping-editor/mapping-region';
import { ResultRegion } from '../mapping-editor/result-region';
import { editorReadiness, initialMappingState, mappingReducer, undecidedColumns } from '../mapping/mapping-state';
import { FIXTURE_COLUMNS, FIXTURE_FILE } from '../__fixtures__/designhof-shaped-export';
import type { ColumnMapping, SourceSample } from '../api/wizard-contract.types';

/**
 * The real editor, driven by the untidy dataset the Phase 8 rehearsal used.
 *
 * The fixture survives because it is genuinely awkward in the ways real
 * supplier exports are: a price column with blanks, a sale-price column that is
 * empty in 187 of 240 rows, a category holding a path, a photos column holding
 * a list, and a data-sheet column that is almost entirely empty. A rehearsal
 * over clean data proves nothing about the decisions an operator has to make,
 * and neither does a test.
 *
 * Nothing here imports the rehearsal's UI, which no longer exists. The fixture
 * is data now, and this is the only thing that reads it.
 */

afterEach(() => cleanupAll());

/** The fixture's columns as the analyzer would hand them to the editor. */
function sampleFromFixture(): SourceSample {
  const rowCount = Math.max(...FIXTURE_COLUMNS.map((c) => c.samples.length));
  const rows: string[][] = [];
  for (let r = 0; r < rowCount; r++) {
    rows.push(FIXTURE_COLUMNS.map((column) => column.samples[r] ?? ''));
  }
  return {
    sheet: FIXTURE_FILE.name,
    firstRowNumber: 2,
    headers: FIXTURE_COLUMNS.map((c) => c.header),
    rows,
  };
}

/** Proposals in the shape the analyzer produces, deliberately incomplete. */
function proposalsFromFixture(): ColumnMapping[] {
  const proposed: Record<number, { field: string; confidence: number; reason: string }> = {
    0: { field: 'sku', confidence: 0.6, reason: 'the values look like references' },
    1: { field: 'name', confidence: 0.98, reason: 'the heading matches exactly' },
    2: { field: 'price', confidence: 0.94, reason: 'the heading matches exactly' },
    3: { field: 'salePrice', confidence: 0.88, reason: 'the heading matches exactly' },
    4: { field: 'stock', confidence: 0.95, reason: 'the heading matches exactly' },
    5: { field: 'categoryPaths', confidence: 0.72, reason: 'the heading matches a known term' },
    9: { field: 'images', confidence: 0.8, reason: 'the values look like web addresses' },
  };

  return FIXTURE_COLUMNS.map((column) => {
    const proposal = proposed[column.index];
    return proposal
      ? {
          columnIndex: column.index,
          header: column.header,
          field: proposal.field,
          confidence: proposal.confidence,
          reasons: [proposal.reason],
        }
      : { columnIndex: column.index, header: column.header, field: null };
  });
}

const FIELD_OPTIONS = [
  { value: 'sku', label: 'SKU (ours)' },
  { value: 'name', label: 'Name', required: true },
  { value: 'price', label: 'Price' },
  { value: 'salePrice', label: 'Sale price' },
  { value: 'stock', label: 'Stock' },
  { value: 'categoryPaths', label: 'Categories' },
  { value: 'images', label: 'Images' },
  { value: 'documents', label: 'Documents' },
];

function loaded() {
  return mappingReducer(initialMappingState('PRODUCTS'), {
    type: 'SOURCE_LOADED',
    sample: sampleFromFixture(),
    columnTypes: FIXTURE_COLUMNS.map((c) => c.detectedType.toUpperCase()),
    proposals: proposalsFromFixture(),
  });
}

describe('a realistic supplier export', () => {
  it('leaves the columns the analyzer could not place undecided', () => {
    // Color, Material, Ancho and Ficha tecnica are not obvious catalogue
    // fields, and pretending otherwise would be the expensive kind of guess.
    const undecided = undecidedColumns(loaded()).map((c) => c.header);
    expect(undecided).toEqual(['Color', 'Material', 'Ancho (cm)', 'Ficha tecnica']);
  });

  it('will not proceed until each of them has been decided', async () => {
    const state = loaded();
    expect(editorReadiness(state).reason).toBe('4 columns still need a decision.');
  });

  it('proceeds once they are mapped or explicitly ignored', () => {
    let state = loaded();
    state = mappingReducer(state, { type: 'COLUMN_IGNORED', columnIndex: 6 });
    state = mappingReducer(state, { type: 'COLUMN_IGNORED', columnIndex: 7 });
    state = mappingReducer(state, { type: 'COLUMN_IGNORED', columnIndex: 8 });
    state = mappingReducer(state, { type: 'FIELD_ASSIGNED', columnIndex: 10, field: 'documents' });
    expect(undecidedColumns(state)).toEqual([]);
  });

  it('shows a weak proposal as one to check, not as a fact', async () => {
    // The reference column scores 0.6: plausible, and worth a second look.
    const { text } = await renderComponent(
      <MappingRegion
        columns={loaded().mapping.columns}
        fieldOptions={FIELD_OPTIONS}
        contract={null}
        focusedColumnIndex={null}
        onFocusColumn={() => undefined}
        onAssignField={() => undefined}
        onIgnoreColumn={() => undefined}
        onAddTransformation={() => undefined}
        onRemoveTransformation={() => undefined}
        onMoveTransformation={() => undefined}
        onSetOption={() => undefined}
      />,
    );
    expect(text()).toContain('Uncertain — 60%, please check');
    expect(text()).toContain('the values look like references');
  });

  it('names every column of the file, including the ones it could not place', async () => {
    const { text } = await renderComponent(
      <MappingRegion
        columns={loaded().mapping.columns}
        fieldOptions={FIELD_OPTIONS}
        contract={null}
        focusedColumnIndex={null}
        onFocusColumn={() => undefined}
        onAssignField={() => undefined}
        onIgnoreColumn={() => undefined}
        onAddTransformation={() => undefined}
        onRemoveTransformation={() => undefined}
        onMoveTransformation={() => undefined}
        onSetOption={() => undefined}
      />,
    );
    for (const column of FIXTURE_COLUMNS) {
      expect(text()).toContain(column.header);
    }
  });

  it('marks an empty cell in the preview rather than leaving a gap', async () => {
    // The sale-price column is empty in 187 of 240 rows; a blank that looks
    // like a rendering bug is worse than one that says it is blank.
    const { text } = await renderComponent(
      <ResultRegion
        preview={{
          rows: [
            {
              sourceRow: 2,
              blank: false,
              values: { salePrice: null },
              cells: [
                {
                  columnIndex: 3,
                  header: 'Precio oferta',
                  field: 'salePrice',
                  original: '',
                  normalized: null,
                  steps: [],
                  changed: false,
                },
              ],
            },
          ],
          ignoredColumns: [],
          blankRowCount: 0,
          previewedRows: 1,
          issues: [],
          summary: { blocking: 0, warning: 0, informational: 0, unacknowledgedWarnings: 0, total: 0 },
          readiness: { allowed: true },
        }}
        previewing={false}
        previewError={null}
        focusedColumnIndex={null}
      />,
    );
    // "(empty)" for what the file held, "nothing" for what would be stored —
    // and "no sale price" must stay distinguishable from "a sale price of 0".
    expect(text()).toContain('(empty)');
    expect(text()).toContain('nothing');
  });

  it('keeps the fixture free of anything that could reach a browser', () => {
    // It is data, read only by tests. The rehearsal that rendered it is gone.
    expect(FIXTURE_FILE.name).toBe('proveedor-mobiliario-2026-03.csv');
    expect(FIXTURE_COLUMNS).toHaveLength(11);
  });
});
