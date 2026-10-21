'use client';

import React from 'react';
import type { RowResult } from '../api/lifecycle.service';
import type { RunState } from './run-machine';
import { describeEffects } from './row-effects';

/**
 * The ANSWER a finished import gives, rendered wherever it was asked for.
 *
 * These three — the report headline with its repair guidance, the row-by-row
 * table, and the link to the downloadable report — used to live inside
 * `RunPanel`. That made them available on the route where a plan had just been
 * built and nowhere else. The plan-review route offered a View results button,
 * sent the request, got 200 back with the rows in it, and had nothing to put
 * them in. Package B's operator pressed it and watched nothing happen.
 *
 * The previous correction consolidated the ACTIONS onto one surface and left
 * the answers behind, which is the same defect one level up. Both are shared
 * now, so a route cannot offer a question it has no way to answer.
 */

export function PlanResults({
  rows,
  report,
  reportHref,
}: {
  rows: RowResult[];
  report: RunState['report'];
  /** Null until a run exists; the link is never invented. */
  reportHref: string | null;
}) {
  if (rows.length === 0 && !report && !reportHref) return null;
  return (
    <div data-testid="plan-results">
      {report ? <Repair report={report} /> : null}
      {rows.length > 0 ? <RowTable rows={rows} /> : null}
      {reportHref ? (
        <a
          href={reportHref}
          className="mt-2 inline-block rounded border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-600"
          data-testid="download-report"
        >
          Download the report
        </a>
      ) : null}
    </div>
  );
}

function Repair({ report }: { report: NonNullable<RunState['report']> }) {
  return (
    <div className="mt-3 rounded border border-slate-200 p-3 text-xs" data-testid="run-report">
      <p className="font-semibold text-slate-800">{report.headline}</p>
      {report.repair.length > 0 ? (
        <>
          {/* Forward repair, never "undo". Rows that were written are written;
              telling somebody to roll back an import that has no rollback is
              worse than telling them nothing. */}
          <p className="mt-1 text-slate-600">What to do next:</p>
          <ul className="ml-4 mt-0.5 list-disc text-slate-600">
            {report.repair.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
/**
 * What happened to each row, thing by thing.
 *
 * The verdict column alone is what let a run be read as a success while it
 * created six products, listed none of them in the shop and filed none of them
 * under a category. So the four things a row can touch each get their own
 * column, and each one says what it did or explicitly why it did nothing.
 *
 * Same phrases as the downloadable report, by shared contract, so comparing the
 * screen against the spreadsheet is a comparison and not a translation.
 */
/** Outcomes in the words a shop owner uses, not the ones the database uses. */
const OUTCOME_WORDS: Record<string, string> = {
  CREATED: 'Added',
  UPDATED: 'Updated',
  SKIPPED: 'Left unchanged',
  FAILED: 'Not imported',
};

function RowTable({ rows }: { rows: RowResult[] }) {
  return (
    <div className="mt-3 overflow-x-auto" data-testid="row-results">
      <table className="w-full min-w-[52rem] text-left text-xs">
        <caption className="sr-only">
          What happened to each row of your file: whether the product was written, whether it was listed in a shop,
          which categories it was filed under, and where its stock went.
        </caption>
        <thead>
          <tr className="border-b border-slate-200 text-slate-500">
            <th scope="col" className="py-1.5 pr-3 font-semibold">
              Row
            </th>
            <th scope="col" className="py-1.5 pr-3 font-semibold">
              Result
            </th>
            <th scope="col" className="py-1.5 pr-3 font-semibold">
              Product
            </th>
            <th scope="col" className="py-1.5 pr-3 font-semibold">
              Listed in shop
            </th>
            <th scope="col" className="py-1.5 pr-3 font-semibold">
              Categories
            </th>
            <th scope="col" className="py-1.5 pr-3 font-semibold">
              Stock
            </th>
            <th scope="col" className="py-1.5 font-semibold">
              Detail
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const effects = describeEffects(row.effects);
            return (
              <tr key={`${row.sourceTable}-${row.sourceRow}`} className="border-b border-slate-100 align-top">
                <th scope="row" className="py-1.5 pr-3 font-mono font-normal text-slate-500">
                  {row.sourceRow}
                </th>
                <td className="py-1.5 pr-3 text-slate-700">{OUTCOME_WORDS[row.outcome] ?? row.outcome}</td>
                <td className="py-1.5 pr-3 text-slate-600" data-testid={`effect-product-${row.sourceRow}`}>
                  {effects.product}
                </td>
                <td className="py-1.5 pr-3 text-slate-600" data-testid={`effect-store-${row.sourceRow}`}>
                  {effects.store}
                </td>
                <td className="py-1.5 pr-3 text-slate-600" data-testid={`effect-categories-${row.sourceRow}`}>
                  {effects.categories}
                </td>
                <td className="py-1.5 pr-3 text-slate-600" data-testid={`effect-stock-${row.sourceRow}`}>
                  {effects.stock}
                </td>
                <td className="py-1.5 text-slate-600">{row.reason ?? matchedPhrase(row)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.some((row) => !row.effects) ? (
        // Honest about the gap rather than silently showing four dashes. These
        // rows were imported before the run started recording what it touched,
        // and the answer is genuinely unavailable rather than empty.
        <p className="mt-2 text-xs text-slate-500" data-testid="legacy-effects-note">
          Some rows were imported before this system recorded what each row changed, so their details read “not
          recorded”. Those imports were not affected — only what we can now show about them.
        </p>
      ) : null}
    </div>
  );
}
function matchedPhrase(row: RowResult): string {
  if (!row.matchedBy) return '';
  return `Matched on ${row.matchedBy}.`;
}