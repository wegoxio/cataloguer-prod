import { NestFactory } from '@nestjs/core';
import { INestApplicationContext, Logger } from '@nestjs/common';
import { AppModule } from '../app.module';
import { ImportRunnerService } from '../modules/imports/runner/import-runner.service';
import { EXIT, ExitCode, UsageError, parseJobArgs, runImportDrain } from './import-runner.job';

/**
 * `node dist/jobs/import-runner.main --mode=all`
 *
 * The import queues have no consumer inside the API. They cannot have one: a
 * hundred-thousand-row workbook does not parse inside an HTTP timeout, the
 * serving container has a strict memory budget, and request-serving resources
 * instant its request ends — so work begun in a request stops mid-batch on a
 * container nobody is watching.
 *
 * This is the consumer, and it is deliberately a committed, reviewed program
 * rather than something written at rollout time. It boots the application
 * CONTEXT and never an HTTP listener: a job that opened a port would be a
 * second, unmonitored copy of the API, reachable or not depending on how it was
 * deployed.
 *
 * Everything worth testing lives in `import-runner.job.ts` beside this. What is
 * left here is the part that can only be proven by running it: booting Nest,
 * catching signals, and exiting.
 */

async function main(): Promise<void> {
  let options;
  try {
    options = parseJobArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      finish(EXIT.BAD_USAGE);
      return;
    }
    throw error;
  }

  const logger = new Logger('ImportRunnerJob');
  let context: INestApplicationContext | null = null;

  // A signal sets a flag; it never kills the pass. The item in flight finishes
  // and commits, which is the whole point of having checkpoints — and Docker
  // gives a job ten seconds after SIGTERM, which is not enough to finish a batch
  // but is plenty to stop claiming the next one.
  let stopRequested = false;
  const requestStop = (signal: string) => {
    if (stopRequested) return;
    stopRequested = true;
    logger.log(`${signal} received; finishing the item in flight and stopping.`);
  };
  process.on('SIGTERM', () => requestStop('SIGTERM'));
  process.on('SIGINT', () => requestStop('SIGINT'));

  try {
    context = await NestFactory.createApplicationContext(AppModule, {
      // The job's own logs, not the API's request logs.
      logger: ['error', 'warn', 'log'],
      abortOnError: false,
    });

    const runner = context.get(ImportRunnerService, { strict: false });
    const outcome = await runImportDrain(runner, options, {
      now: () => Date.now(),
      stopRequested: () => stopRequested,
    });

    // One line of fact, on stdout, whatever happened. Written before the
    // context closes so a slow shutdown cannot swallow it.
    process.stdout.write(`${outcome.line}\n`);
    await closeQuietly(context, logger);
    finish(outcome.exitCode);
  } catch (error) {
    // A failure to BOOT or to reach the database is the job breaking, which is
    // a different thing from an import failing, and it gets its own code.
    logger.error(`The import runner could not complete: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.stdout.write(
      `${JSON.stringify({ job: 'import-runner', exitCode: EXIT.FAILED, verdict: 'the job itself failed' })}\n`,
    );
    if (context) await closeQuietly(context, logger);
    finish(EXIT.FAILED);
  }
}

/**
 * Close the context without letting shutdown noise change the verdict.
 *
 * The pass is already over and its exit code is already earned. A connection
 * that objects to being closed must not turn a healthy run into a failed one.
 */
async function closeQuietly(context: INestApplicationContext, logger: Logger): Promise<void> {
  try {
    await context.close();
  } catch (error) {
    logger.warn(`Shutting down was not clean: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}

/**
 * Set the exit code rather than calling `process.exit`.
 *
 * `process.exit` truncates pending writes, which on a job whose entire output
 * is one line means losing exactly the thing operators read. Setting the code
 * lets the loop drain and Node exit on its own.
 */
function finish(code: ExitCode): void {
  process.exitCode = code;
}

void main();
