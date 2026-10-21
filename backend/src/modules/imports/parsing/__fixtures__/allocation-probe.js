/*
 * Peak-RSS probe for one code path, run as an isolated child process.
 *
 * Measuring allocation in the test process is not evidence: RSS never shrinks
 * after a large allocation, so a gate that refuses cheaply looks identical to
 * one that allocated and freed. The parent samples THIS process's RSS while it
 * runs exactly one path, so "refused before allocating" becomes observable.
 *
 * Usage: node allocation-probe.js <noop|gate|reader> <fixture-path>
 *
 * `noop` pays every cost the `gate` run pays EXCEPT the gate's own work: same
 * ts-node compile, same module graph, same file read into a Buffer. Subtracting
 * it is what makes "the gate itself spends X" a real number instead of a
 * measurement of the test harness.
 */
const path = require('path');

const [mode, fixturePath] = process.argv.slice(2);

async function main() {
  const fs = require('fs');
  const buffer = fs.readFileSync(fixturePath);

  if (mode === 'noop') {
    // Load the module and hold the bytes, then stop. Whatever this costs is
    // harness overhead, not archive handling.
    require('../archive-gate');
    process.stdout.write(`OUTCOME=noop:${buffer.length}\n`);
    return;
  }

  if (mode === 'gate') {
    // Compiled by ts-node via the parent; require the TS source through the
    // registered compiler so the probe measures the real shipped code.
    const { openArchive, JOB_ARCHIVE_BUDGET } = require('../archive-gate');
    try {
      openArchive(buffer, JOB_ARCHIVE_BUDGET);
      process.stdout.write('OUTCOME=accepted\n');
    } catch (err) {
      process.stdout.write(`OUTCOME=refused:${err.code || 'ERROR'}\n`);
    }
    return;
  }

  if (mode === 'reader') {
    // The unguarded value reader, for contrast. This is the path the gate
    // exists to keep an untrusted archive away from.
    const readXlsxFile = require('read-excel-file/node');
    const os = require('os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p9-probe-'));
    const file = path.join(dir, 'probe.xlsx');
    fs.writeFileSync(file, buffer);
    try {
      await readXlsxFile(file, { getSheets: true });
      process.stdout.write('OUTCOME=accepted\n');
    } catch (err) {
      process.stdout.write(`OUTCOME=threw:${String(err.message).slice(0, 40)}\n`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    return;
  }

  process.stdout.write('OUTCOME=unknown-mode\n');
}

/**
 * Peak RSS as the OS accounted it for THIS process (getrusage ru_maxrss, in
 * kilobytes). Self-reported, but it is the kernel's number rather than a
 * sampled guess, and a process cannot understate a peak it already reached.
 */
function reportPeak() {
  const maxRssKb = process.resourceUsage().maxRSS;
  process.stdout.write(`PEAK_RSS_KB=${maxRssKb}\n`);
}

main().then(
  () => {
    reportPeak();
    process.exit(0);
  },
  (err) => {
    process.stdout.write(`OUTCOME=crashed:${String(err.message).slice(0, 60)}\n`);
    reportPeak();
    process.exit(1);
  },
);
