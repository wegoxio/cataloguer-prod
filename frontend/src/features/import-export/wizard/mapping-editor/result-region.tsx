'use client';

import React from 'react';
import { cn } from '../../../../lib/cn';
import type { NormalizedCell, NormalizedRow, PreviewResponse, TransformValue } from '../api/wizard-contract.types';

/**
 * What would actually be written, beside what the file says.
 *
 * This region exists because a summary is not an answer. "45 columns mapped,
 * 841 rows ready" is exactly the kind of reassurance that lets someone import a
 * price column into the cost field, and the legacy importer's surprises were
 * all of that shape. So the original cell and the stored value sit next to each
 * other, and the steps between them are shown on demand.
 *
 * The values here come from the SERVER, computed by the same function that will
 * run at validation time before execution. A client-side reimplementation would
 * be a second opinion that can disagree with the one that matters.
 */

export function ResultRegion({
  preview,
  previewing,
  previewError,
  focusedColumnIndex,
}: {
  preview: PreviewResponse | null;
  previewing: boolean;
  previewError: string | null;
  focusedColumnIndex: number | null;
}) {
  if (previewError) {
    return (
      <div className="rounded border border-rose-300 bg-rose-50 p-3" role="alert" data-testid="result-error">
        <p className="text-sm font-semibold text-rose-900">{previewError}</p>
        <p className="mt-1 text-xs text-rose-800">
          Nothing has been changed in your catalogue. Adjust the mapping and it will be checked again.
        </p>
      </div>
    );
  }

  if (previewing) {
    // `aria-busy` and a sentence, rather than a spinner alone: a spinner tells
    // a screen-reader user nothing at all.
    return (
      <p className="py-6 text-center text-sm text-slate-600" aria-busy="true" data-testid="result-loading">
        Working out what this mapping would produce…
      </p>
    );
  }

  if (!preview) {
    return (
      <p className="py-6 text-center text-sm text-slate-500" data-testid="result-empty">
        Map at least one column to see what would be imported.
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="result-region">
      <ResultSummary preview={preview} />

      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left text-xs">
          <caption className="sr-only">
            Each row of your file, showing the original value and what would be stored.
          </caption>
          <thead>
            <tr className="border-b border-slate-200 text-slate-500">
              <th scope="col" className="py-1.5 pr-3 font-semibold">
                Row
              </th>
              <th scope="col" className="py-1.5 pr-3 font-semibold">
                Column
              </th>
              <th scope="col" className="py-1.5 pr-3 font-semibold">
                In your file
              </th>
              <th scope="col" className="py-1.5 font-semibold">
                Would be stored as
              </th>
            </tr>
          </thead>
          <tbody>
            {preview.rows.map((row) => (
              <RowCells key={row.sourceRow} row={row} focusedColumnIndex={focusedColumnIndex} />
            ))}
          </tbody>
        </table>
      </div>

      {preview.ignoredColumns.length > 0 ? (
        // Said out loud rather than left as absence: a column that quietly
        // vanishes from the preview looks like a column that was never there.
        <p className="text-xs text-slate-500" data-testid="ignored-columns">
          Not imported: {preview.ignoredColumns.map((c) => c.header).join(', ')}.
        </p>
      ) : null}
    </div>
  );
}

function ResultSummary({ preview }: { preview: PreviewResponse }) {
  return (
    <p className="text-xs text-slate-600" data-testid="result-summary">
      Showing {preview.previewedRows} row{preview.previewedRows === 1 ? '' : 's'} of your file
      {preview.blankRowCount > 0 ? (
        <>
          {' '}
          · {preview.blankRowCount} blank row{preview.blankRowCount === 1 ? '' : 's'} will be skipped
        </>
      ) : null}
      .
    </p>
  );
}

function RowCells({ row, focusedColumnIndex }: { row: NormalizedRow; focusedColumnIndex: number | null }) {
  // Only mapped columns are shown: an ignored column has no "would be stored
  // as" value, and a row of blanks would drown the ones that matter.
  const mapped = row.cells.filter((cell) => cell.field !== null);
  if (mapped.length === 0) return null;

  return (
    <>
      {mapped.map((cell, index) => (
        <tr
          key={`${row.sourceRow}-${cell.columnIndex}`}
          className={cn(
            'border-b border-slate-100 align-top',
            focusedColumnIndex === cell.columnIndex && 'bg-sky-50',
          )}
        >
          {index === 0 ? (
            <th scope="row" rowSpan={mapped.length} className="py-1.5 pr-3 font-mono font-normal text-slate-500">
              {row.sourceRow}
            </th>
          ) : null}
          <td className="py-1.5 pr-3 text-slate-600">{cell.header}</td>
          <td className="py-1.5 pr-3 font-mono text-slate-500">{cell.original || <Blank />}</td>
          <td className="py-1.5">
            <StoredValue cell={cell} />
          </td>
        </tr>
      ))}
    </>
  );
}

function StoredValue({ cell }: { cell: NormalizedCell }) {
  if (cell.problem) {
    return (
      <div>
        <span className="font-semibold text-amber-800">Not imported</span>
        <p className="text-slate-600">{cell.problem}</p>
      </div>
    );
  }

  return (
    <div>
      <span className={cn('font-mono', cell.changed ? 'font-semibold text-slate-900' : 'text-slate-600')}>
        {formatValue(cell.normalized)}
      </span>
      {cell.steps.length > 0 ? (
        // The steps are why the two columns differ. Without them a changed
        // value looks like the importer doing something arbitrary.
        <details className="mt-0.5">
          <summary className="cursor-pointer text-slate-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600">
            {cell.steps.length} change{cell.steps.length === 1 ? '' : 's'}
          </summary>
          <ul className="ml-3 mt-0.5 list-disc text-slate-500">
            {cell.steps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function Blank() {
  return <span className="italic text-slate-400">(empty)</span>;
}

/**
 * A stored value as the person would recognise it.
 *
 * `null` is rendered as "nothing" rather than as an empty cell, because an
 * empty cell is indistinguishable from a rendering bug — and the difference
 * between "no price" and "a price of zero" is one somebody has to be able to
 * see.
 */
export function formatValue(value: TransformValue): React.ReactNode {
  if (value === null) return <span className="italic text-slate-400">nothing</span>;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="italic text-slate-400">nothing</span>;
    return value.join(' · ');
  }
  return String(value);
}
