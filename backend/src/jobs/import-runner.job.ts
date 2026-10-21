import { DrainMode, DrainResult } from '../modules/imports/runner/import-runner.service';

/**
 * The import runner as an OPERATOR surface.
 *
 * A service method is not an operator surface. Somebody on call at two in the
 * morning needs a command they can run, an exit code their tooling can read,
 * and one line of fact they can paste into an incident — and none of that is
 * satisfied by "resolve a provider from the application context and call a
 * method", which is a program somebody has to write under pressure, unreviewed,
 * at exactly the wrong moment.
 *
 * So this file holds everything about the job EXCEPT the process: argument
 * parsing, the exit-code decision, and the fact line. It is pure, so all of it
 * is tested without spawning anything. `import-runner.main.ts` beside it is the
 * thin shell that boots Nest, wires signals, and exits.
 */

export const EXIT = {
  /** The pass completed. Work may or may not have been found; neither is an error. */
  OK: 0,
  /** The job itself broke — could not boot, could not reach the database. */
  FAILED: 1,
  /** The pass ran and one or more items failed. The queue is not healthy. */
  ITEMS_FAILED: 2,
  /** A signal arrived and the pass stopped cleanly between items. */
  TERMINATED: 3,
  /** The arguments were not usable. Nothing was attempted. */
  BAD_USAGE: 64,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export interface JobOptions {
  mode: DrainMode;
  maxItems: number;
  /**
   * How long the pass may keep CLAIMING work.
   *
   * Bounded on purpose. A scheduled job that runs until the queue is empty has
   * no upper bound on its own runtime, which makes it impossible to schedule
   * against and impossible to alert on. This one stops claiming at the
   * deadline and lets the next invocation continue — the leases and checkpoints
   * are what make that safe.
   */
  maxSeconds: number;
}

export const DEFAULT_JOB_OPTIONS: JobOptions = {
  mode: 'ALL',
  maxItems: 25,
  // Comfortably inside the configured import-runner timeout even if the last
  // item claimed runs long, and short enough that a stuck pass is noticed.
  maxSeconds: 540,
};

export class UsageError extends Error {}

/**
 * Read the arguments, or say exactly what is wrong with them.
 *
 * Unknown flags are REFUSED rather than ignored. A typo in a scheduled job's
 * arguments that silently falls back to the default is a job that has been
 * doing the wrong thing since somebody last edited it, and nobody finds out.
 */
export function parseJobArgs(argv: string[]): JobOptions {
  const options: JobOptions = { ...DEFAULT_JOB_OPTIONS };

  for (const arg of argv) {
    const [rawKey, rawValue] = splitFlag(arg);

    switch (rawKey) {
      case '--mode': {
        const mode = (rawValue ?? '').toUpperCase();
        if (mode !== 'ANALYSIS' && mode !== 'EXECUTION' && mode !== 'ALL') {
          throw new UsageError(`--mode must be analysis, execution or all (got "${rawValue ?? ''}")`);
        }
        options.mode = mode;
        break;
      }
      case '--max-items':
        options.maxItems = positiveInteger(rawKey, rawValue, 1000);
        break;
      case '--max-seconds':
        options.maxSeconds = positiveInteger(rawKey, rawValue, 3600);
        break;
      default:
        throw new UsageError(`Unknown argument "${arg}". Supported: --mode, --max-items, --max-seconds.`);
    }
  }

  return options;
}

function splitFlag(arg: string): [string, string | undefined] {
  const index = arg.indexOf('=');
  return index === -1 ? [arg, undefined] : [arg.slice(0, index), arg.slice(index + 1)];
}

function positiveInteger(key: string, raw: string | undefined, max: number): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new UsageError(`${key} must be a whole number between 1 and ${max} (got "${raw ?? ''}")`);
  }
  return value;
}

/**
 * What exit code this pass earned.
 *
 * The rule that matters: a pass in which items FAILED never exits 0, even
 * though the job itself worked perfectly. Monitoring watches exit codes, and a
 * job that succeeds while every import it touched fell over is monitoring that
 * lies. Termination outranks that, because a signalled pass was not given the
 * chance to finish and its counts are not a verdict on the queue.
 */
export function exitCodeFor(result: DrainResult, terminated: boolean): ExitCode {
  if (terminated) return EXIT.TERMINATED;
  if (result.analysesFailed > 0 || result.executionsFailed > 0) return EXIT.ITEMS_FAILED;
  return EXIT.OK;
}

/**
 * The single line of fact this job leaves behind.
 *
 * JSON on one line, because it is read by log tooling far more often than by a
 * person, and a person can still read it. It carries only counts and the
 * decision they produced — never an organization, a file name, a plan hash or
 * anything else that would put a customer's data in an operational log.
 */
export function describeRun(
  result: DrainResult,
  options: JobOptions,
  outcome: { terminated: boolean; exitCode: ExitCode; durationMs: number },
): string {
  return JSON.stringify({
    job: 'import-runner',
    mode: options.mode,
    analysesRun: result.analysesRun,
    analysesFailed: result.analysesFailed,
    executionsRun: result.executionsRun,
    executionsFailed: result.executionsFailed,
    reaped: result.reaped,
    skippedLeased: result.skippedLeased,
    stoppedEarly: result.stoppedEarly,
    terminated: outcome.terminated,
    durationMs: outcome.durationMs,
    exitCode: outcome.exitCode,
    // Said explicitly rather than inferred from zeroes. "Nothing to do" and
    // "everything was already claimed" both produce zero counts and mean very
    // different things.
    verdict: verdictFor(result, outcome.terminated),
  });
}

function verdictFor(result: DrainResult, terminated: boolean): string {
  if (terminated) return 'stopped on a signal between items';
  if (result.analysesFailed > 0 || result.executionsFailed > 0) return 'some items failed';

  const ran = result.analysesRun + result.executionsRun;
  if (ran > 0) return `${ran} item(s) completed`;
  if (result.skippedLeased > 0) return 'every waiting item was already claimed by another worker';
  return 'no work was waiting';
}

/** The runner surface this job needs, narrowed to what it actually calls. */
export interface DrainableRunner {
  drainOnce(options: {
    mode: DrainMode;
    maxItems: number;
    deadline: () => boolean;
    shouldStop: () => boolean;
  }): Promise<DrainResult>;
}

export interface JobRunOutcome {
  result: DrainResult;
  exitCode: ExitCode;
  terminated: boolean;
  line: string;
}

/**
 * Run one pass and decide what to say about it.
 *
 * The clock and the stop flag are injected so a test states them rather than
 * racing them, and so the deadline is a real deadline rather than a timer that
 * could fire inside an item.
 */
export async function runImportDrain(
  runner: DrainableRunner,
  options: JobOptions,
  clock: { now: () => number; stopRequested: () => boolean },
): Promise<JobRunOutcome> {
  const startedAt = clock.now();
  const deadlineAt = startedAt + options.maxSeconds * 1000;

  const result = await runner.drainOnce({
    mode: options.mode,
    maxItems: options.maxItems,
    deadline: () => clock.now() >= deadlineAt,
    shouldStop: clock.stopRequested,
  });

  // Termination is reported only when a signal actually arrived. A pass that
  // hit its DEADLINE stopped normally and its next invocation continues; saying
  // it was terminated would have somebody investigating a healthy schedule.
  const terminated = clock.stopRequested();
  const exitCode = exitCodeFor(result, terminated);

  return {
    result,
    exitCode,
    terminated,
    line: describeRun(result, options, { terminated, exitCode, durationMs: clock.now() - startedAt }),
  };
}
