/**
 * Reads a generated CSV of N rows through the real delimited adapter and the
 * real batch planner, in its OWN process, and reports the kernel's peak.
 *
 * Its own process for the same reason the archive probe uses one: RSS inside a
 * test process cannot tell a peak that rose and fell from one that never
 * happened, and `process.resourceUsage().maxRSS` is the kernel's own high-water
 * mark for the whole process.
 *
 * `noop` is the control. It pays exactly the same cost — the same ts-node
 * compile, the same module graph, the same generated buffer — and then stops.
 * Subtracting it leaves what the parse and the plan actually cost, rather than
 * what the harness around them costs.
 *
 * Usage: node -r ts-node/register/transpile-only large-file-probe.js <mode> <rows>
 */

const mode = process.argv[2];
/**
 * TOTAL rows in the file, header included — which is what the adapter counts.
 * A file at the ceiling therefore carries one fewer product than the ceiling.
 */
const totalRows = Number(process.argv[3]);

/** A file of exactly `totalRows` lines, built in memory so nothing touches a disk. */
function buildCsv(count) {
  const parts = ['sku,nombre,precio,categoria'];
  for (let i = 1; i <= count - 1; i++) {
    parts.push(`SKU-${i},Producto numero ${i},${(10 + (i % 90)).toFixed(2)},Hogar > Cocina`);
  }
  return Buffer.from(parts.join('\n'), 'utf8');
}

function report(outcome, extra) {
  const peakBytes = process.resourceUsage().maxRSS * 1024;
  process.stdout.write(
    JSON.stringify({
      outcome,
      peakRssMiB: Math.round((peakBytes / (1024 * 1024)) * 10) / 10,
      ...extra,
    }),
  );
}

try {
  const { DelimitedAdapter } = require('../delimited-adapter');
  const { planBatches } = require('../../execution/batch-planner');
  const { JOB_ADAPTER_LIMITS, MAX_BATCH_ROWS } = require('../../shared/import-limits');

  const buffer = buildCsv(totalRows);

  if (mode === 'noop') {
    // The control: everything above, nothing below.
    report('noop', { bytes: buffer.length });
    process.exit(0);
  }

  const adapter = new DelimitedAdapter();
  const census = adapter.census(buffer, JOB_ADAPTER_LIMITS);
  // A delimited file has exactly one table, and the adapter numbers it 1 — the
  // same index its census reports, rather than a zero-based array position.
  const sheetIndex = census.sheets[0].index;
  const range = adapter.readRange(
    buffer,
    { sheetIndex, maxRows: JOB_ADAPTER_LIMITS.maxRows, maxCells: JOB_ADAPTER_LIMITS.maxCells },
    JOB_ADAPTER_LIMITS,
  );

  if (mode === 'parse') {
    report('parsed', {
      bytes: buffer.length,
      rowsRead: range.rowsRead,
      cellsRead: range.cellsRead,
      truncated: range.truncated,
      censusRows: census.sheets[0] ? census.sheets[0].rowCount : 0,
    });
    process.exit(0);
  }

  if (mode === 'plan') {
    // One planned unit per data row, which is the shape a products import has.
    const units = [];
    for (let i = 1; i < range.rows.length; i++) {
      units.push({ kind: 'ROW', sourceRows: [i + 1], mutations: null });
    }
    const batches = planBatches('a'.repeat(64), units, MAX_BATCH_ROWS);

    let planned = 0;
    let lastRow = 0;
    let contiguous = true;
    for (const batch of batches) {
      for (const unit of batch.units) {
        for (const row of unit.sourceRows) {
          if (row !== lastRow + 1 && lastRow !== 0) contiguous = false;
          lastRow = row;
          planned++;
        }
      }
    }

    report('planned', {
      bytes: buffer.length,
      rowsRead: range.rowsRead,
      truncated: range.truncated,
      batches: batches.length,
      plannedRows: planned,
      contiguous,
      lastRow,
    });
    process.exit(0);
  }

  report('unknown-mode', {});
  process.exit(2);
} catch (error) {
  report('threw', { message: error && error.message ? String(error.message).slice(0, 300) : 'unknown' });
  process.exit(1);
}
