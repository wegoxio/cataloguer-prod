import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Does the gate refuse a bomb BEFORE allocating what the bomb declares?
 *
 * An earlier version of this claim compared "the gate stays under 64 MiB" with
 * "the reader spends 579 MiB", and those two numbers were never comparable:
 * they came from different processes doing different amounts of unrelated setup,
 * and were measured by watching RSS inside the test process — which proves very
 * little, since RSS does not shrink after a large allocation. A gate that
 * inflated 300 MiB and then threw would have looked identical to one that
 * refused from the central directory.
 *
 * This measures it properly. Each path runs in its own process and reports the
 * kernel's own peak for that process (getrusage ru_maxrss, via
 * `process.resourceUsage()`), so a peak that rises and falls cannot be missed
 * the way interval sampling would miss it.
 *
 * The control is what makes the numbers mean anything. `noop` loads the same
 * module graph under the same ts-node compile and reads the same file into the
 * same Buffer, then stops. Subtracting it leaves the cost attributable to the
 * code path itself rather than to the harness around it.
 */

const FIXTURES = path.join(__dirname, '..', '__fixtures__');
const PROBE = path.join(FIXTURES, 'allocation-probe.js');
const BOMB = path.join(FIXTURES, 'zip-bomb.xlsx');

/** What the bomb fixture declares as inflated content, in MiB. */
const BOMB_DECLARED_MIB = 300;

interface ProbeResult {
  outcome: string;
  peakRssMiB: number;
  exitCode: number | null;
}

/**
 * Run one path in a fresh process and collect its peak.
 *
 * `ts-node/register` is preloaded so the probe can require the TypeScript source
 * directly — this measures the real shipped gate, not a reimplementation of it.
 */
function probe(mode: 'noop' | 'gate' | 'reader', fixture: string): ProbeResult {
  const child = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', PROBE, mode, fixture], {
    cwd: path.join(__dirname, '..', '..', '..', '..', '..'),
    encoding: 'utf8',
    env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' },
    maxBuffer: 8 * 1024 * 1024,
  });

  // The child reports ru_maxrss for itself, in kilobytes. spawnSync exposes no
  // rusage of its own, and sampling from the parent would miss a peak that rises
  // and falls between polls.
  const stdout = `${child.stdout ?? ''}`;
  const peakKb = Number(/PEAK_RSS_KB=(\d+)/.exec(stdout)?.[1] ?? NaN);
  const outcome = /OUTCOME=([^\n]+)/.exec(stdout)?.[1] ?? `no-outcome(${(child.stderr ?? '').slice(0, 160)})`;
  return { outcome, peakRssMiB: peakKb / 1024, exitCode: child.status };
}

const hasFixtures = fs.existsSync(BOMB) && fs.existsSync(PROBE);
const d = hasFixtures ? describe : describe.skip;

d('archive bomb: refusal happens before allocation', () => {
  jest.setTimeout(300_000);

  it('the gate refuses the bomb having allocated almost nothing beyond the control', () => {
    const control = probe('noop', BOMB);
    const gate = probe('gate', BOMB);

    expect(control.outcome).toMatch(/^noop:/);
    expect(gate.outcome).toMatch(/^refused:/);
    expect(Number.isFinite(gate.peakRssMiB)).toBe(true);
    expect(Number.isFinite(control.peakRssMiB)).toBe(true);

    // The claim, stated as a number: the work the GATE did, on top of a process
    // that had already loaded the same code and read the same bytes.
    const attributable = gate.peakRssMiB - control.peakRssMiB;

    // eslint-disable-next-line no-console
    console.log(
      `gate ${gate.peakRssMiB.toFixed(0)} MiB, control ${control.peakRssMiB.toFixed(0)} MiB, ` +
        `attributable to the gate ${attributable.toFixed(0)} MiB, outcome ${gate.outcome}`,
    );

    // The bomb declares 300 MiB. A gate that decided from the central directory
    // cannot have materialized a meaningful fraction of it — well under the
    // 64 MiB per-entry ceiling, let alone the declared total.
    expect(attributable).toBeLessThan(64);
    expect(gate.peakRssMiB).toBeLessThan(BOMB_DECLARED_MIB);
  });

  it('the unguarded reader allocates dramatically more on exactly the same bytes', () => {
    // This contrast is the whole justification for the gate existing. Both runs
    // are measured the same way, from the same file, against the same control.
    const control = probe('noop', BOMB);
    const gate = probe('gate', BOMB);
    const reader = probe('reader', BOMB);

    // eslint-disable-next-line no-console
    console.log(
      `reader ${reader.peakRssMiB.toFixed(0)} MiB vs gate ${gate.peakRssMiB.toFixed(0)} MiB ` +
        `(control ${control.peakRssMiB.toFixed(0)} MiB) — reader attributable ` +
        `${(reader.peakRssMiB - control.peakRssMiB).toFixed(0)} MiB`,
    );

    expect(reader.peakRssMiB).toBeGreaterThan(gate.peakRssMiB * 2);
    // The operational point: the reader alone would not survive in the 512 MiB
    // serving container, and the accepted path sits far below it.
    expect(gate.peakRssMiB).toBeLessThan(512);
  });

  it('a legitimate high-compression workbook is still accepted, and just as cheaply', () => {
    // The gate must not be a compression-ratio tripwire. This fixture compresses
    // 10.2:1 legitimately and has to pass at the same cost as a refusal.
    const legit = path.join(FIXTURES, 'legit-high-compression.xlsx');
    const control = probe('noop', legit);
    const accepted = probe('gate', legit);

    expect(accepted.outcome).toBe('accepted');
    expect(accepted.peakRssMiB - control.peakRssMiB).toBeLessThan(64);
  });

  it('a macro workbook is refused without being opened', () => {
    const result = probe('gate', path.join(FIXTURES, 'macro.xlsm'));
    expect(result.outcome).toMatch(/^refused:ACTIVE_CONTENT/);
  });

  it('a traversal entry is refused', () => {
    const result = probe('gate', path.join(FIXTURES, 'traversal.xlsx'));
    expect(result.outcome).toMatch(/^refused:UNSAFE_ENTRY_NAME/);
  });
});
