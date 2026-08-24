/**
 * Mutation testing engine for TypeScript/JavaScript files (StrykerJS).
 *
 * This module is the ENGINE and nothing else: it sequences one run — plan
 * batches → write config → build argv → invoke → classify failure → parse
 * report — and owns the filesystem and subprocess work that sequencing needs.
 * Every phase's substance lives in a dedicated module under
 * `engines/typescript/`, mirroring how `handler.ts` sits over `src/audit/`:
 *
 *   batches.ts   — line-batch planning and result folding (pure)
 *   config.ts    — the Stryker overlay config and runner resolution
 *   args.ts      — argv construction (pure)
 *   failures.ts  — failed-invocation classification (pure) and the dry-run shape
 *   report.ts    — mutant status classification and scoring (pure)
 *
 * The helpers are re-exported here because that is the surface the test suite
 * and callers already import; the split moved where they live, not what the
 * module offers.
 */
import { existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { BaseEngine, RunOptions, MutationResult } from './base.js';
import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';
import { log, warn, isVerbose } from '../utils/logger.js';
import { buildVitestRelatedCommand } from '../utils/shell-quote.js';
import { DEFAULT_TIMEOUT_MS } from '../utils/constants.js';
import { harvestIncrementalFile, seedIncrementalFile } from '../utils/incremental-cache.js';
import { MIN_BATCH_BUDGET_MS, planLineBatches, mergeBatchResults } from './typescript/batches.js';
import { STRIKER_JSON_REPORT, resolveRunner, prepareStrykerConfig } from './typescript/config.js';
import { buildMutateArg, buildStrykerArgs } from './typescript/args.js';
import {
  StrykerTimeoutError,
  classifyStrykerFailure,
  dryRunResult,
} from './typescript/failures.js';
import { type StrykerJsonReport, scoreStrykerReport } from './typescript/report.js';

export { planLineBatches, mergeBatchResults } from './typescript/batches.js';
export { writeStrykerRuntimeConfig, prepareStrykerConfig } from './typescript/config.js';
export { buildStrykerArgs } from './typescript/args.js';
export {
  StrykerTimeoutError,
  classifyStrykerFailure,
  dryRunResult,
} from './typescript/failures.js';

/**
 * Mutation testing engine for TypeScript/JavaScript files.
 *
 * Invokes the StrykerJS CLI (via `npx stryker run`) inside the sandbox
 * working directory so the real workspace tree is never touched.
 */
/**
 * Substrings identifying a StrykerJS failure in its INITIAL (dry) test run,
 * i.e. before a single mutant was introduced.
 *
 * A dry run fails because the runner could not execute the project's existing,
 * passing suite — not because the code under test is weak. That distinction is
 * what makes an automatic retry on a different runner safe: nothing about the
 * mutation result is being papered over, because no mutant ran.
 *
 * Sourced from the two messages {@link classifyStrykerFailure} raises for that
 * phase.
 */
const DRY_RUN_FAILURE_MARKERS = [
  'There were failed tests in the initial test run',
  'ran zero tests in its dry run',
] as const;

/**
 * Whether a failed run should be retried on Stryker's built-in command runner.
 *
 * The native `@stryker-mutator/vitest-runner` pins `pool: 'threads'`
 * unconditionally, so a suite that is perfectly healthy under `npm test` can
 * still fail its dry run there — `process.chdir()`, for one, throws
 * "not supported in workers" under `worker_threads`. Without this retry the
 * whole audit aborts on a confusing "failed tests in the initial test run",
 * which is a poor default for a runner we chose on the project's behalf.
 *
 * Deliberately narrow:
 *   - Only when the runner was DETECTED. `testRunnerTrusted` marks a runner the
 *     operator named in their own config; overriding that would be ignoring an
 *     explicit instruction.
 *   - Only from the native vitest runner. Nothing else has a cheaper fallback.
 *   - Only on a DRY-RUN failure. Retrying an ordinary failure would double the
 *     cost of every genuinely broken run.
 */
function shouldFallBackToCommandRunner(error: unknown, options?: RunOptions): boolean {
  if (resolveRunner(options) !== 'vitest') return false;
  if (options?.testRunnerTrusted === true) return false;
  const message = error instanceof Error ? error.message : String(error);
  return DRY_RUN_FAILURE_MARKERS.some((marker) => message.includes(marker));
}

/**
 * Fail fast when StrykerJS is not installed in the workspace being audited.
 *
 * `npx --no-install stryker` does NOT fail when StrykerJS is absent, because
 * `stryker` is frequently on PATH as stryker-cli — a bootstrapper that asks
 * whether to install Stryker and then waits for an answer:
 *
 *     Stryker is currently not installed.
 *     ? Do you want to install Stryker locally? (Use arrow keys)
 *
 * A sandbox has no one to answer it. The prompt blocks until the audit
 * deadline, and the run is then reported as a TIMEOUT with advice to narrow
 * the target file — advice that cannot possibly help, because no scope is
 * small enough to make an interactive prompt answer itself. Every audit of one
 * real workspace failed this way, at five minutes each, before the cause was
 * found.
 *
 * There is no ENOENT to classify here, so this has to be checked before the
 * process is spawned rather than recovered from afterwards.
 *
 * Container runs are exempt: the image supplies StrykerJS, and the workspace
 * copy is not where it lives.
 *
 * @internal Exported for testing only.
 */
export function assertStrykerInstalled(options?: RunOptions): void {
  if (options?.executor?.kind === 'container') return;
  const workDir = options?.workDir ?? process.cwd();
  if (existsSync(join(workDir, 'node_modules', '@stryker-mutator', 'core', 'package.json'))) return;
  throw new MutationToolStartupError(
    'StrykerJS',
    'StrykerJS is not installed in this workspace. Install it with: ' +
      'npm install --save-dev @stryker-mutator/core (or the equivalent for your package ' +
      'manager). A global `stryker` on PATH is stryker-cli, which prompts for an install ' +
      'and hangs where nothing can answer it.',
    'NOT_INSTALLED',
  );
}

export class TypeScriptEngine extends BaseEngine {
  /**
   * Runs the audit, retrying once on the command runner when the native vitest
   * runner fails the dry run. See {@link shouldFallBackToCommandRunner}.
   */
  async run(filePath: string, options?: RunOptions): Promise<MutationResult> {
    assertStrykerInstalled(options);
    try {
      return await this.dispatch(filePath, options);
    } catch (error: unknown) {
      if (!shouldFallBackToCommandRunner(error, options)) throw error;
      // `commandRunnerCommand` is populated upstream only when the runner
      // already resolved to 'command', so it is absent on this path and has to
      // be built here. An unsafe Windows path yields undefined, in which case
      // there is no command to fall back TO and the original error stands.
      const command = options?.commandRunnerCommand ?? buildVitestRelatedCommand(filePath);
      if (command === undefined) throw error;
      warn(
        `StrykerJS's native vitest runner could not complete its initial test run for ${filePath}; ` +
          'retrying once with the built-in command runner. Pin a runner with ' +
          '{"stryker": {"testRunner": "vitest" | "command"}} to skip this retry.',
      );
      return await this.dispatch(filePath, {
        ...options,
        testRunner: 'command',
        commandRunnerCommand: command,
      });
    }
  }

  private async dispatch(filePath: string, options?: RunOptions): Promise<MutationResult> {
    const resolvedRunner = resolveRunner(options);
    if (resolvedRunner === 'command' && !options?.dryRun) {
      let totalLines = 0;
      try {
        totalLines = readFileSync(join(options?.workDir ?? process.cwd(), filePath), 'utf-8').split(
          '\n',
        ).length;
      } catch {
        // Keep the zero default and fall back to a single run.
      }
      const requestedRanges =
        options?.lineRanges ?? (options?.lineScope ? [options.lineScope] : undefined);
      // The SAME fallback `runBatched` applies below. Passing a bare
      // `options?.timeoutMs` would let the planner size batches against
      // `undefined` (unbounded) while the loop spends DEFAULT_TIMEOUT_MS, so
      // the two would disagree about the budget on every call that omits it.
      const batches = planLineBatches(
        totalLines,
        requestedRanges,
        options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
      // Stryker disable next-line EqualityOperator: the planner invariant returns either zero or at least two batches.
      if (batches.length > 1) return this.runBatched(filePath, batches, options ?? {});
    }
    return this.runOnce(filePath, options);
  }

  private async runBatched(
    filePath: string,
    batches: { start: number; end: number }[],
    options: RunOptions,
  ): Promise<MutationResult> {
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const completed: MutationResult[] = [];
    let firstTimeout: Error | undefined;

    for (let index = 0; index < batches.length; index++) {
      const remaining = deadline - Date.now();
      const batchesLeft = batches.length - index;
      // Viability is per-batch, not per-average: this batch only has to fund
      // its OWN start-up. Testing the average share against the floor instead
      // made a certified plan abort itself, because `planLineBatches` caps the
      // count at `floor(budget / MIN_BATCH_BUDGET_MS)` measured against the
      // FULL budget while this loop measures what is LEFT. The two agree only
      // at zero elapsed time, so a plan that used the whole budget lost its
      // first batch to a single millisecond ("0 of 3 planned batches") and
      // every later batch to whatever the previous one overran by — a 20-batch
      // default-timeout run reported "1 of 20" as a partial audit.
      //
      // Flooring the slice at one whole start-up cannot overrun the deadline:
      // the guard below only admits a batch while `remaining` still covers
      // MIN_BATCH_BUDGET_MS, and the floored slice never exceeds `remaining`.
      if (remaining < MIN_BATCH_BUDGET_MS) break;
      const batchBudget = Math.max(MIN_BATCH_BUDGET_MS, Math.floor(remaining / batchesLeft));
      try {
        completed.push(
          await this.runOnce(filePath, {
            ...options,
            lineScope: undefined,
            lineRanges: [batches[index]],
            timeoutMs: batchBudget,
          }),
        );
      } catch (error: unknown) {
        // Only a genuine, typed timeout may be swallowed to keep batching.
        // Matching on the words "timed out" anywhere in the message also caught
        // Stryker exit-1 configuration errors whose stderr happens to mention a
        // test-runner timeout, silently discarding that batch and blaming the
        // time budget for a config bug that raising timeoutMs will never fix.
        if (!(error instanceof StrykerTimeoutError)) throw error;
        firstTimeout ??= error;
      }
    }

    if (completed.length === 0 && firstTimeout) throw firstTimeout;
    // A run that measured NOTHING has no score to report. `mergeBatchResults`
    // reduces over an empty array to totalMutants 0 / killed 0, and
    // `formatMutationScore(0, 0)` is '100.00%' by the documented
    // zero-denominator convention — so returning here reported a flawless audit
    // for a run in which not one mutant was ever generated.
    //
    // This is reachable without any timeout at all: `reserveEngineBudget`
    // (handler.ts) admits any remaining budget >= 1000ms, so with >= 2 batches
    // and ~1s left the very first `batchBudget` is ~500ms, below
    // MIN_BATCH_BUDGET_MS, and the loop breaks before invoking Stryker once —
    // leaving `firstTimeout` undefined and the guard above unarmed.
    if (completed.length === 0) {
      throw new Error(
        `Time budget exhausted before any mutation batch could run for ${filePath} ` +
          `(0 of ${batches.length} planned batches completed). No mutants were generated, so there is no ` +
          'score to report — raise timeoutMs or narrow the audit scope.',
      );
    }
    return mergeBatchResults(
      filePath,
      completed,
      batches.length,
      completed.length === batches.length,
      // The batches together span whatever was REQUESTED: the whole file when no
      // line scope was given, otherwise only the caller's ranges. Each individual
      // batch is line-scoped, but that is an implementation detail of batching
      // and must not make a whole-file audit look like a partial one.
      options.lineRanges?.length || options.lineScope ? 'scoped' : 'whole-file',
    );
  }

  private async runOnce(filePath: string, options?: RunOptions): Promise<MutationResult> {
    const resolvedRunner = resolveRunner(options);
    const cwd = options?.workDir ?? process.cwd();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const effectiveRanges =
      options?.lineRanges ?? (options?.lineScope ? [options.lineScope] : undefined);
    const mutateArg = buildMutateArg(filePath, effectiveRanges);
    const runtimeConfig = prepareStrykerConfig(cwd, options);
    const args = buildStrykerArgs(resolvedRunner, mutateArg, runtimeConfig, options);

    // ── Reset the JSON report so a read below can only be THIS invocation's ──
    // The report path is fixed, and `parseReport` guards it with nothing but
    // `existsSync`, which cannot tell this run's output from:
    //   * the previous BATCH's output — `runBatched` calls `runOnce` N times
    //     against the same cwd, so a batch that exits without rewriting the file
    //     would have the prior batch's report re-parsed, and `mergeBatchResults`
    //     SUMS totals and CONCATENATES vulnerabilities: double-counted mutants
    //     and duplicate (line, mutator) entries that then collide as
    //     suppression/verify keys; or
    //   * a report the audited workspace shipped — `ALWAYS_EXCLUDE`
    //     (utils/sandbox.ts) does not exclude `reports/`, so a project that has
    //     run Stryker itself copies its own mutation.json into the sandbox.
    // Deleting first makes a missing report afterwards an honest error.
    // The PHP engine defends against exactly this (engines/php.ts, `rmSync` of
    // the Infection log before the run).
    const reportPath = join(cwd, STRIKER_JSON_REPORT);
    try {
      rmSync(reportPath, { force: true });
    } catch {
      // Best-effort: an undeletable stale report is no worse than today's
      // behaviour, and every other guard here still applies.
    }

    // Incremental state is seeded from / harvested to a host-side cache around
    // the run — without that the sandbox teardown discards Stryker's
    // incremental file and the whole option is a no-op. See
    // utils/incremental-cache.ts.
    const incrementalCachePath = options?.incremental ? options.incrementalCachePath : undefined;
    if (incrementalCachePath) seedIncrementalFile(incrementalCachePath, cwd);

    if (isVerbose()) {
      log(`TypeScriptEngine: ${args.join(' ')}`);
    }

    try {
      await invokeMutationTool('StrykerJS', args[0], args.slice(1), {
        cwd,
        timeoutMs,
        signal: options?.signal,
        executor: options?.executor,
      });
    } catch (error: unknown) {
      // Throws for every failure except the recoverable non-zero exits (mutants
      // survived / score under `thresholds.break`), which fall through to
      // parseReport. The report-existence check is sound only because the stale
      // report was removed above, before Stryker was launched.
      classifyStrykerFailure(error, filePath, existsSync(reportPath));
    }

    // Preserve the incremental state before the caller tears the sandbox down.
    // Reached on both terminal paths that produced a run (clean exit and the
    // expected non-zero "mutants survived" exit); a run that threw above has no
    // state worth keeping.
    if (incrementalCachePath) harvestIncrementalFile(incrementalCachePath, cwd);

    // ── Dry run: nothing to parse ──
    // Reaching this point without a startup error means the suite ran clean,
    // so report that instead of trying (and failing) to parse a report.
    if (options?.dryRun) return dryRunResult(filePath);

    // ── Parse the JSON report ──
    return this.parseReport(cwd, filePath, effectiveRanges ? 'scoped' : 'whole-file');
  }

  /**
   * Read and parse the Stryker JSON report from the filesystem.
   * Extracted as a separate method for testability.
   *
   * Only the read lives here; the scoring rules are `scoreStrykerReport`.
   *
   * @param scopeKind — whether the run this report came from enumerated the
   *   whole file or only the caller's line ranges. Defaults to `'whole-file'`,
   *   which is what a bare `parseReport(workDir, filePath)` describes.
   * @internal
   */
  parseReport(
    workDir: string,
    filePath: string,
    scopeKind: 'whole-file' | 'scoped' = 'whole-file',
  ): MutationResult {
    const reportPath = join(workDir, STRIKER_JSON_REPORT);
    if (!existsSync(reportPath)) {
      throw new Error(
        `Stryker JSON report not found at ${reportPath}. The mutation run may have failed before the report was written.`,
      );
    }

    let raw: StrykerJsonReport;
    try {
      const jsonText = readFileSync(reportPath, 'utf-8');
      raw = JSON.parse(jsonText) as StrykerJsonReport;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse Stryker JSON report: ${message}`);
    }

    return scoreStrykerReport(raw, filePath, scopeKind);
  }
}
