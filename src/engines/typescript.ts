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
import { invokeMutationTool } from '../utils/exec-classify.js';
import { log, isVerbose } from '../utils/logger.js';
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
export class TypeScriptEngine extends BaseEngine {
  async run(filePath: string, options?: RunOptions): Promise<MutationResult> {
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
      const batchBudget = Math.floor(remaining / batchesLeft);
      if (batchBudget < MIN_BATCH_BUDGET_MS) break;
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
