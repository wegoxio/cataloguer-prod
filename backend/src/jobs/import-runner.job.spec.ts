import {
  DEFAULT_JOB_OPTIONS,
  EXIT,
  UsageError,
  describeRun,
  exitCodeFor,
  parseJobArgs,
  runImportDrain,
} from './import-runner.job';
import type { DrainableRunner, JobOptions } from './import-runner.job';
import type { DrainResult } from '../modules/imports/runner/import-runner.service';

/**
 * The job's decisions, tested as decisions.
 *
 * Everything an operator actually depends on is here: what the arguments mean,
 * what the exit code says, and what the one line of output claims. None of it
 * needs a process, a database or a container — which is the point of keeping
 * the shell in `import-runner.main.ts` down to booting, signals and exiting.
 */

const drain = (over: Partial<DrainResult> = {}): DrainResult => ({
  analysesRun: 0,
  executionsRun: 0,
  analysesFailed: 0,
  executionsFailed: 0,
  reaped: 0,
  skippedLeased: 0,
  stoppedEarly: false,
  ...over,
});

/** A runner that records what it was asked and answers with a fixed result. */
function fakeRunner(result: DrainResult = drain()) {
  const calls: unknown[] = [];
  const runner: DrainableRunner & { calls: unknown[] } = {
    calls,
    drainOnce: (options) => {
      calls.push({ mode: options.mode, maxItems: options.maxItems });
      return Promise.resolve(result);
    },
  };
  return runner;
}

describe('reading the arguments', () => {
  it('drains both queues with bounded defaults when told nothing', () => {
    expect(parseJobArgs([])).toEqual(DEFAULT_JOB_OPTIONS);
    // Bounded on purpose. A pass with no upper bound on its own runtime cannot
    // be scheduled against and cannot be alerted on.
    expect(DEFAULT_JOB_OPTIONS.maxSeconds).toBeGreaterThan(0);
    expect(DEFAULT_JOB_OPTIONS.maxItems).toBeGreaterThan(0);
  });

  it('accepts each queue separately, so the two can be scheduled apart', () => {
    expect(parseJobArgs(['--mode=analysis']).mode).toBe('ANALYSIS');
    expect(parseJobArgs(['--mode=execution']).mode).toBe('EXECUTION');
    expect(parseJobArgs(['--mode=ALL']).mode).toBe('ALL');
  });

  it('REFUSES an unknown argument rather than ignoring it', () => {
    // A typo in a scheduled job's arguments that silently falls back to the
    // default is a job that has been doing the wrong thing since somebody last
    // edited it, and nobody finds out.
    expect(() => parseJobArgs(['--modes=all'])).toThrow(UsageError);
    expect(() => parseJobArgs(['--max-item=5'])).toThrow(UsageError);
  });

  it('refuses a mode it cannot act on, and names what it accepts', () => {
    expect(() => parseJobArgs(['--mode=everything'])).toThrow(/analysis, execution or all/);
  });

  it('refuses bounds that are not usable numbers', () => {
    for (const bad of ['--max-items=0', '--max-items=-1', '--max-items=abc', '--max-items=1.5', '--max-items=99999']) {
      expect(() => parseJobArgs([bad])).toThrow(UsageError);
    }
    expect(() => parseJobArgs(['--max-seconds=0'])).toThrow(UsageError);
  });
});

describe('what the exit code says', () => {
  it('exits 0 when there was simply nothing to do', () => {
    expect(exitCodeFor(drain(), false)).toBe(EXIT.OK);
  });

  it('exits 0 when everything it claimed completed', () => {
    expect(exitCodeFor(drain({ analysesRun: 2, executionsRun: 1 }), false)).toBe(EXIT.OK);
  });

  it('NEVER exits 0 when an item failed, however healthy the job itself was', () => {
    // Monitoring watches exit codes. A job that succeeds while every import it
    // touched fell over is monitoring that lies.
    expect(exitCodeFor(drain({ analysesFailed: 1 }), false)).toBe(EXIT.ITEMS_FAILED);
    expect(exitCodeFor(drain({ executionsRun: 5, executionsFailed: 1 }), false)).toBe(EXIT.ITEMS_FAILED);
  });

  it('reports termination above item failures, because a signalled pass is not a verdict', () => {
    expect(exitCodeFor(drain({ executionsFailed: 3 }), true)).toBe(EXIT.TERMINATED);
  });

  it('keeps a distinct code for the job itself breaking', () => {
    // Boot failure and item failure are different problems with different
    // responses, so they must not share a code.
    expect(EXIT.FAILED).not.toBe(EXIT.ITEMS_FAILED);
    expect(EXIT.FAILED).not.toBe(EXIT.OK);
    expect(EXIT.BAD_USAGE).not.toBe(EXIT.FAILED);
  });
});

describe('the line it leaves behind', () => {
  const options: JobOptions = { mode: 'ALL', maxItems: 25, maxSeconds: 540 };

  const parse = (result: DrainResult, terminated = false) =>
    JSON.parse(describeRun(result, options, { terminated, exitCode: exitCodeFor(result, terminated), durationMs: 12 }));

  it('distinguishes an empty queue from a fully claimed one', () => {
    // Both produce zero counts and mean very different things: one is idle,
    // the other is saturated.
    expect(parse(drain()).verdict).toMatch(/no work was waiting/i);
    expect(parse(drain({ skippedLeased: 4 })).verdict).toMatch(/already claimed by another worker/i);
  });

  it('says plainly when items failed', () => {
    const line = parse(drain({ executionsRun: 2, executionsFailed: 1 }));
    expect(line.verdict).toMatch(/some items failed/i);
    expect(line.exitCode).toBe(EXIT.ITEMS_FAILED);
  });

  it('counts what completed', () => {
    expect(parse(drain({ analysesRun: 1, executionsRun: 2 })).verdict).toMatch(/3 item\(s\) completed/);
  });

  it('carries no customer data at all', () => {
    // An operational log is read by people who have no business seeing a
    // tenant's file names, plan hashes or organization ids.
    const line = describeRun(drain({ analysesRun: 1 }), options, {
      terminated: false,
      exitCode: EXIT.OK,
      durationMs: 5,
    });
    const parsed = JSON.parse(line) as Record<string, unknown>;
    for (const key of Object.keys(parsed)) {
      expect(key).not.toMatch(/organization|tenant|source|plan|file|email|hash|key/i);
    }
    // And it is ONE line, so log tooling reads it as one event.
    expect(line).not.toContain('\n');
  });
});

describe('running a pass', () => {
  it('passes the caller’s bounds straight through to the runner', async () => {
    const runner = fakeRunner();
    await runImportDrain(
      runner,
      { mode: 'EXECUTION', maxItems: 3, maxSeconds: 60 },
      { now: () => 0, stopRequested: () => false },
    );

    expect(runner.calls).toEqual([{ mode: 'EXECUTION', maxItems: 3 }]);
  });

  it('gives the runner a deadline it can check between items', async () => {
    let observed: (() => boolean) | null = null;
    const runner: DrainableRunner = {
      drainOnce: (options) => {
        observed = options.deadline;
        return Promise.resolve(drain());
      },
    };

    let now = 1_000;
    await runImportDrain(
      runner,
      { mode: 'ALL', maxItems: 5, maxSeconds: 10 },
      { now: () => now, stopRequested: () => false },
    );

    expect(observed!()).toBe(false);
    now = 1_000 + 10_000;
    expect(observed!()).toBe(true);
  });

  it('does NOT call a deadline a termination', async () => {
    // A pass that ran out of time stopped normally, and its next invocation
    // continues. Reporting it as terminated would have somebody investigating
    // a perfectly healthy schedule.
    const runner = fakeRunner(drain({ stoppedEarly: true, analysesRun: 2 }));
    const outcome = await runImportDrain(
      runner,
      { mode: 'ALL', maxItems: 5, maxSeconds: 1 },
      { now: () => 0, stopRequested: () => false },
    );

    expect(outcome.terminated).toBe(false);
    expect(outcome.exitCode).toBe(EXIT.OK);
    expect(JSON.parse(outcome.line).stoppedEarly).toBe(true);
  });

  it('reports a signalled pass as terminated, with what it managed to finish', async () => {
    const runner = fakeRunner(drain({ analysesRun: 1, stoppedEarly: true }));
    const outcome = await runImportDrain(
      runner,
      { mode: 'ALL', maxItems: 5, maxSeconds: 60 },
      { now: () => 0, stopRequested: () => true },
    );

    expect(outcome.exitCode).toBe(EXIT.TERMINATED);
    // The work it DID finish is still reported. A signalled pass committed
    // real batches, and pretending otherwise would send somebody looking for
    // imports that already ran.
    expect(JSON.parse(outcome.line).analysesRun).toBe(1);
  });

  it('measures how long the pass took from the injected clock', async () => {
    let now = 100;
    const runner: DrainableRunner = {
      drainOnce: () => {
        now = 2_600;
        return Promise.resolve(drain());
      },
    };

    const outcome = await runImportDrain(
      runner,
      { mode: 'ALL', maxItems: 5, maxSeconds: 60 },
      { now: () => now, stopRequested: () => false },
    );
    expect(JSON.parse(outcome.line).durationMs).toBe(2_500);
  });
});
