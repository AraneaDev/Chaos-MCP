/**
 * Interpreting a failed StrykerJS invocation, and the shape of a dry run.
 *
 * `classifyStrykerFailure` is deliberately free of filesystem access — the
 * caller passes `reportExists` — so its whole decision matrix is assertable
 * from plain arguments.
 */
import { type MutationResult } from '../base.js';
import { ExecFailureError } from '../../utils/exec-error.js';
import { MutationToolStartupError } from '../../utils/exec-classify.js';
import { log, isVerbose } from '../../utils/logger.js';

/**
 * A StrykerJS invocation that exceeded its own time budget.
 *
 * `invokeMutationTool` classifies the raw `ExecFailureError` (`code === 'TIMEOUT'`)
 * into a {@link MutationToolStartupError}, but that class carries only `tool` and
 * a message — the machine-readable code is dropped. `TypeScriptEngine.runOnce`
 * re-establishes the discriminator here, so `TypeScriptEngine.runBatched`
 * can recognise a genuine timeout by TYPE rather than by sniffing prose. That
 * matters because `runOnce` also throws
 * `StrykerJS configuration or internal error (exit 1): <stderr>`, and Stryker's
 * stderr routinely contains test-runner text such as `Test timed out in 5000ms`;
 * a substring match on "timed out" silently dropped those real config failures
 * and reported the run as `time_budget_exhausted`.
 */
export class StrykerTimeoutError extends Error {
  readonly code = 'TIMEOUT';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'StrykerTimeoutError';
  }
}

/**
 * Interpret a failed StrykerJS invocation.
 *
 * Returns normally for the recoverable cases — a non-zero exit where the JSON
 * report was still written and the caller should go on and parse it. Every other
 * case throws.
 *
 * The branches are ordered most-specific-first and that order is load-bearing:
 * it decides which message a user sees.
 *
 * @param reportExists — whether this run's JSON report is on disk. The caller
 *   computes it (so this function stays free of filesystem access and its whole
 *   decision matrix is assertable from plain arguments), and it is only sound
 *   because `runOnce` deletes any pre-existing report BEFORE launching Stryker —
 *   otherwise a stale report from a previous batch would make a genuine config
 *   error look recoverable.
 */
export function classifyStrykerFailure(
  error: unknown,
  filePath: string,
  reportExists: boolean,
): void {
  // Startup-class failures (not-installed / timeout / signal crash) are
  // wrapped in MutationToolStartupError by the helper. Surface verbatim.
  if (error instanceof MutationToolStartupError) {
    // Re-establish the TIMEOUT discriminator that the wrapper drops. This is
    // the only point where a timeout is still distinguishable: the messages
    // MutationToolStartupError can carry are a CLOSED set authored in
    // exec-classify.ts, and only the TIMEOUT branch renders
    // `${tool} timed out after ${ms}ms.`. The other three begin with
    // "<tool> is not installed", "<tool> produced more output" and
    // "<tool> crashed unexpectedly" — so tool-controlled text (stderr, which
    // only ever appears *after* the crash prefix) cannot forge this.
    // runBatched keys on the resulting type, never on the prose.
    if (error.message.startsWith(`${error.tool} timed out after `)) {
      throw new StrykerTimeoutError(error.message, { cause: error });
    }
    throw new Error(error.message);
  }

  // Per-tool exit-code logic. The shared helper has already classified
  // the standard startup failures; anything reaching here is a non-zero
  // exit code that Stryker-specific behaviour must interpret.
  if (!(error instanceof ExecFailureError)) {
    if (error instanceof Error) throw error;
    throw new Error(`Stryker execution failed: ${String(error)}`);
  }

  // ── Stryker exit-code semantics, verified against @stryker-mutator/core@9.6.1 ──
  // Exit code 1 is OVERLOADED. It is both the generic failure code AND the code
  // Stryker deliberately sets for "mutation score below thresholds.break":
  // `MutationTestReportHelper.determineExitCode()` calls `objectUtils.setExitCode(1)`
  // on that branch (dist/src/reporters/mutation-test-report-helper.js:114-122),
  // and `grep -rn "setExitCode" dist/src/` has exactly that one call site.
  //
  // There is NO exit code 2 anywhere in Stryker. This code used to comment that
  // "2 = threshold not reached" and treat every exit 1 as a config error, so any
  // audited project with the standard CI gate `thresholds: { break: 80 }` had a
  // completely successful run reported as
  // `StrykerJS configuration or internal error (exit 1):` with an EMPTY message
  // (`--logLevel off` leaves stderr blank) and its whole survivor report thrown away.
  //
  // The report's presence is what separates the two meanings, and the ordering
  // makes that safe: `reportAll` calls `onMutationTestReportReady` (:105) before
  // `determineExitCode` (:112), and `JsonReporter.wrapUp()` awaits the file
  // write — so on the threshold-break path the JSON report IS already on disk.
  if (error.exit === 1) {
    // Checked FIRST: a dry run that executes zero tests is almost always
    // "nothing covers this file", not a broken config — say so instead of
    // dumping the raw Stryker stack trace. This is a real failure even though a
    // report from an earlier phase could conceivably exist.
    if (error.stderr?.includes('No tests were executed')) {
      throw new Error(
        `StrykerJS ran zero tests in its dry run — no tests in this project appear to cover ${filePath}. ` +
          'Add a test file exercising it, or check the test runner configuration if tests exist.',
      );
    }
    if (!reportExists) {
      throw new Error(
        `StrykerJS configuration or internal error (exit 1): ${error.stderr?.slice(0, 500) || error.message}`,
      );
    }
    // Report on disk → the run completed and exit 1 means the score is under the
    // project's own `thresholds.break`. Fall through to parseReport.
  }

  // Recoverable non-zero exit → parse the report.
  // Capture stderr for diagnostics in case the report is missing after all.
  if (isVerbose() && error.stderr) {
    log(`StrykerJS exited ${error.exit} (expected): ${error.stderr.slice(0, 500)}`);
  }
}

/**
 * The result of a `--dryRunOnly` run.
 *
 * StrykerJS performs only the initial test run and never generates mutants or
 * writes reports/mutation/mutation.json, so this shape is deliberately distinct
 * from a scored run: no mutants, and a non-numeric `mutationScore`.
 *
 * `scopeKind` is deliberately LEFT UNSET. The field answers "does
 * `totalMutants === 0` prove this file has no mutable logic?", and a dry run
 * never asked the question — it enumerated nothing anywhere. `undefined` is the
 * honest third state; consumers must not read a zero here as proven coverage.
 */
export function dryRunResult(filePath: string): MutationResult {
  return {
    target: filePath,
    totalMutants: 0,
    killed: 0,
    survived: 0,
    mutationScore: 'n/a (dry run)',
    vulnerabilities: [],
    scopeNote:
      'Dry run only: the test suite executed successfully against the sandboxed file. ' +
      'No mutants were generated — re-run without dryRun to score coverage.',
  };
}
