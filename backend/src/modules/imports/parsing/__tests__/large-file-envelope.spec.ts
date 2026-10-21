import { spawnSync } from 'child_process';
import * as path from 'path';
import { JOB_ADAPTER_LIMITS, MAX_BATCH_ROWS } from '../../shared/import-limits';

/**
 * The published 200,000-row ceiling, actually read.
 *
 * A limit nobody has exercised is a hope. `import-limits.spec.ts` asserts the
 * NUMBER; this asserts that the parser and the planner really accept a file of
 * that size, and does it where the answer means something: in its own process,
 * against the kernel's own peak, with a control that pays the identical setup
 * cost so the difference is attributable to the work rather than the harness.
 *
 * It is deliberately NOT a database test. Putting two hundred thousand rows
 * through PostgreSQL would measure PostgreSQL, take minutes, and prove nothing
 * about the importer's own envelope — the end-to-end behaviour is proven at
 * 2,600 rows in `runner/large-import.pg.spec.ts`, which is many times the
 * preview page and the batch ceiling.
 *
 * The pilot import container has a bounded memory allocation.
 * The envelope asserted here is well inside it, with room for the rest of the
 * application, because a job sized to its own best case dies on its first real
 * customer file.
 */

const PROBE = path.join(__dirname, '..', '__fixtures__', 'large-file-probe.js');

/** Headroom the job must retain beyond the parse, so the ceiling is not the cliff. */
const JOB_MEMORY_MIB = 2048;
const ATTRIBUTABLE_BUDGET_MIB = 900;

interface ProbeResult {
  outcome: string;
  peakRssMiB: number;
  bytes?: number;
  rowsRead?: number;
  cellsRead?: number;
  truncated?: boolean;
  censusRows?: number;
  batches?: number;
  plannedRows?: number;
  contiguous?: boolean;
  lastRow?: number;
  message?: string;
}

function probe(mode: 'noop' | 'parse' | 'plan', rows: number): ProbeResult {
  const run = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', PROBE, mode, String(rows)], {
    cwd: path.join(__dirname, '..', '..', '..', '..', '..'),
    encoding: 'utf8',
    timeout: 600_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  const line = (run.stdout ?? '').trim().split('\n').pop() ?? '';
  if (!line.startsWith('{')) {
    throw new Error(`probe ${mode} produced no result: ${(run.stderr ?? '').slice(-800)}`);
  }
  return JSON.parse(line) as ProbeResult;
}

describe('the published row ceiling, against the real parser', () => {
  jest.setTimeout(900_000);

  const ROWS = JOB_ADAPTER_LIMITS.maxRows;

  let control: ProbeResult;
  let parsed: ProbeResult;

  beforeAll(() => {
    control = probe('noop', ROWS);
    parsed = probe('parse', ROWS);
  });

  it('reads a file of exactly the published maximum without truncating it', () => {
    expect(parsed.outcome).toBe('parsed');
    expect(parsed.truncated).toBe(false);
    // The ceiling counts rows in the FILE, header included — so a file at the
    // limit carries one fewer product than the limit. Worth pinning rather than
    // rounding: an off-by-one in a published maximum is how a customer's export
    // gets refused for a reason nobody can explain.
    expect(parsed.rowsRead).toBe(ROWS);
    expect(parsed.censusRows).toBe(ROWS);
  });

  it('REFUSES one row past the ceiling, saying what to do about it', () => {
    const overflowing = probe('parse', ROWS + 1);

    expect(overflowing.outcome).toBe('threw');
    // A refusal a person can act on, naming both numbers.
    expect(overflowing.message).toMatch(/200[,.]001/);
    expect(overflowing.message).toMatch(/200[,.]000/);
    expect(overflowing.message).toMatch(/split it/i);
  });

  it('is a file of real size, not a degenerate one', () => {
    // Roughly 9 MB of CSV. A ceiling proven with a file of empty rows would
    // prove nothing about a customer's export.
    expect(parsed.bytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(parsed.cellsRead).toBeGreaterThanOrEqual((ROWS - 1) * 4);
  });

  it('stays inside the documented resource envelope', () => {
    const attributable = Math.round((parsed.peakRssMiB - control.peakRssMiB) * 10) / 10;

    // Reported whichever way it goes, so a regression is visible as a number
    // rather than as a pass or a fail alone.
    expect({ controlMiB: control.peakRssMiB, parsedMiB: parsed.peakRssMiB, attributableMiB: attributable }).toEqual(
      expect.objectContaining({ attributableMiB: expect.any(Number) }),
    );

    expect(attributable).toBeLessThan(ATTRIBUTABLE_BUDGET_MIB);
    // And the whole process, not merely its attributable share, fits the job's
    // allocation with the rest of the application still to load.
    expect(parsed.peakRssMiB).toBeLessThan(JOB_MEMORY_MIB * 0.75);
  });
});

describe('the planner at the published ceiling', () => {
  jest.setTimeout(900_000);

  const ROWS = JOB_ADAPTER_LIMITS.maxRows;

  it('plans every row into contiguous batches, none dropped and none doubled', () => {
    const planned = probe('plan', ROWS);

    expect(planned.outcome).toBe('planned');
    expect(planned.truncated).toBe(false);
    // One unit per DATA row: the file's rows minus its header.
    expect(planned.plannedRows).toBe(ROWS - 1);

    // Contiguous and complete: the rows tile the file from the first to the
    // last, so nothing was skipped in the middle either.
    expect(planned.contiguous).toBe(true);
    expect(planned.lastRow).toBe(ROWS);

    // And the batch ceiling really applied, rather than the file happening to
    // fit in one batch.
    expect(planned.batches).toBeGreaterThanOrEqual(Math.ceil((ROWS - 1) / MAX_BATCH_ROWS));
  });
});
