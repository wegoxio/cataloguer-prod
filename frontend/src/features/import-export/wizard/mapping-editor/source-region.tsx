'use client';

import React from 'react';
import { cn } from '../../../../lib/cn';
import type { SourceSample } from '../api/wizard-contract.types';

/**
 * The file as it actually is, before anything is decided about it.
 *
 * Two jobs. First, showing the raw grid — because the single most common
 * question while mapping is "what is actually in that column?", and answering
 * it by leaving the wizard to open the spreadsheet is how people lose their
 * place. Second, letting someone correct the structural guesses: which sheet,
 * which table, and above all which row is the header.
 *
 * The header row is the highest-leverage correction in the whole wizard. Get it
 * wrong and every column is mis-identified at once — a title row read as
 * headers turns the real headers into the first row of data. It is offered
 * prominently, not hidden behind an "advanced" disclosure.
 */

export interface DetectedTable {
  id: string;
  sheet?: string;
  label: string;
  headerRow: number;
  firstDataRow: number;
  lastRow: number;
  columnCount: number;
}

export function SourceRegion({
  fileName,
  sheets,
  activeSheet,
  onSelectSheet,
  tables,
  activeTableId,
  onSelectTable,
  sample,
  headerRow,
  onHeaderRowChange,
  focusedColumnIndex,
  onFocusColumn,
}: {
  fileName: string | null;
  sheets: string[];
  activeSheet: string | null;
  onSelectSheet: (sheet: string) => void;
  tables: DetectedTable[];
  activeTableId: string | null;
  onSelectTable: (tableId: string) => void;
  sample: SourceSample | null;
  headerRow: number;
  onHeaderRowChange: (row: number) => void;
  focusedColumnIndex: number | null;
  onFocusColumn: (columnIndex: number | null) => void;
}) {
  if (!sample) {
    return (
      <p className="py-6 text-center text-sm text-slate-500" data-testid="source-empty">
        Choose a file to import. Nothing is changed in your catalogue until you approve a plan.
      </p>
    );
  }

  return (
    <div className="space-y-3" data-testid="source-region">
      {fileName ? <p className="truncate text-xs text-slate-500">{fileName}</p> : null}

      {sheets.length > 1 ? (
        <div>
          <label htmlFor="sheet-select" className="block text-xs font-medium text-slate-700">
            Sheet
          </label>
          <select
            id="sheet-select"
            value={activeSheet ?? ''}
            onChange={(event) => onSelectSheet(event.target.value)}
            className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
          >
            {sheets.map((sheet) => (
              <option key={sheet} value={sheet}>
                {sheet}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {tables.length > 1 ? (
        <fieldset>
          {/* Several tables on one sheet is normal in the files people actually
              send. Combining them silently would produce nonsense, so the
              choice is explicit. */}
          <legend className="text-xs font-medium text-slate-700">
            This sheet holds more than one table. Which one are you importing?
          </legend>
          <div className="mt-1 space-y-1">
            {tables.map((table) => {
              const id = `table-${table.id}`;
              return (
                <div key={table.id} className="flex items-start gap-2">
                  <input
                    id={id}
                    type="radio"
                    name="detected-table"
                    checked={activeTableId === table.id}
                    onChange={() => onSelectTable(table.id)}
                    className="mt-0.5"
                  />
                  <label htmlFor={id} className="text-xs text-slate-700">
                    <span className="font-medium">{table.label}</span>{' '}
                    <span className="text-slate-500">
                      — rows {table.firstDataRow}–{table.lastRow}, {table.columnCount} columns
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <div>
        <label htmlFor="header-row" className="block text-xs font-medium text-slate-700">
          Which row holds the column names?
        </label>
        <input
          id="header-row"
          type="number"
          min={1}
          value={headerRow}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isInteger(value) && value >= 1) onHeaderRowChange(value);
          }}
          aria-describedby="header-row-help"
          className="mt-1 w-24 rounded border border-slate-300 px-2 py-1 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
        />
        <p id="header-row-help" className="mt-1 text-xs text-slate-500">
          Changing this re-reads the file, so any mapping you have built will start again.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left text-xs">
          <caption className="sr-only">The first rows of your file, exactly as they are.</caption>
          <thead>
            <tr className="border-b border-slate-200">
              <th scope="col" className="py-1.5 pr-2 font-semibold text-slate-500">
                Row
              </th>
              {sample.headers.map((header, index) => (
                <th
                  key={index}
                  scope="col"
                  className={cn(
                    'py-1.5 pr-3 font-semibold text-slate-700',
                    focusedColumnIndex === index && 'bg-sky-50',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => onFocusColumn(focusedColumnIndex === index ? null : index)}
                    aria-pressed={focusedColumnIndex === index}
                    className="text-left hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
                  >
                    {header || <span className="italic text-slate-400">(no heading)</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sample.rows.slice(0, 10).map((row, rowIndex) => (
              <tr key={rowIndex} className="border-b border-slate-100">
                <th scope="row" className="py-1 pr-2 font-mono font-normal text-slate-400">
                  {sample.firstRowNumber + rowIndex}
                </th>
                {sample.headers.map((_header, columnIndex) => (
                  <td
                    key={columnIndex}
                    className={cn(
                      'max-w-[14rem] truncate py-1 pr-3 font-mono text-slate-600',
                      focusedColumnIndex === columnIndex && 'bg-sky-50',
                    )}
                    title={row[columnIndex] ?? ''}
                  >
                    {row[columnIndex] || <span className="italic text-slate-300">(empty)</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sample.rows.length > 10 ? (
        <p className="text-xs text-slate-500">
          Showing the first 10 of {sample.rows.length} sampled rows. The whole file is imported, not just these.
        </p>
      ) : null}
    </div>
  );
}
