/**
 * Recognising a mutation engine's INITIAL (baseline/dry) test run failing, as
 * opposed to an ordinary run that scored survivors or an unrelated
 * startup/config failure.
 *
 * None of the four engines carry a typed, machine-readable marker for this
 * (unlike, say, {@link import('./resources/errors.js').ResourceExhaustedError}
 * for a memory stop, or `StrykerTimeoutError`'s `.code` for a timeout). Each
 * one just throws a plain `Error` whose MESSAGE happens to describe the
 * failing phase. This module keys on that message text, narrowly: the exact
 * phrases each engine's own failure-classification module already uses for
 * this phase, not a broad word like "error" or "failed" that a genuine
 * scored run's own wording could also contain.
 *
 * Sourced from:
 *   - TypeScript (`engines/typescript.ts` / `engines/typescript/failures.ts`):
 *     "...in the initial test run", matching both "There were failed tests
 *     in the initial test run" (the native vitest runner's own dry-run
 *     failure) and Stryker's "Something went wrong in the initial test run"
 *     (embedded in the generic "StrykerJS configuration or internal error
 *     (exit 1): ..." text `classifyStrykerFailure` raises when no JSON
 *     report was written). A run that produced a report, including one that
 *     failed its own mutation-score threshold, never reaches that branch, so
 *     this cannot match a survivor-bearing result.
 *   - PHP (`engines/php/failures.ts#explainMissingJsonLog`): "without
 *     producing a JSON log" and "the initial test run failed". Infection
 *     always writes its JSON log at the end of a completed run, survivors
 *     included; the module's own doc comment states the invariant this
 *     relies on, that a non-zero exit with no log means the initial coverage
 *     run never completed, so this phrase is raised only on that branch.
 *   - Rust (`engines/rust.ts`): "baseline test suite itself failed", raised
 *     only when cargo-mutants exits non-zero with EMPTY stdout, which happens
 *     only when the baseline `cargo test` step failed before any mutant ran.
 *     A run with survivors always has stdout to parse.
 *   - Python (`engines/python.ts`): "baseline failed (exit", raised only by
 *     the dedicated `baseline` step, the unmutated suite run once before
 *     `init`/`exec` ever see a mutant.
 *
 * Two PHP diagnoses match the markers above on message text alone but are
 * NOT contention: `explainMissingJsonLog` embeds "the initial test run" /
 * "without producing a JSON log" into both regardless of cause, and a retry
 * can never fix either because the same input reproduces them every time.
 * `DETERMINISTIC_STARTUP_MARKERS` excludes both by text unique to their own
 * diagnosis, checked before a message is allowed to count as retryable:
 *   - "the first byte written to STDERR": the exit-143 case
 *     (`engines/php/failures.ts#diagnoseInfectionStartupFailure`, first
 *     branch). Infection's InitialTestsRunner stops the test process the
 *     moment it writes ANYTHING to STDERR, so PHPUnit exits 143 on every run
 *     of the same suite, retry or not; nothing about contention changes that.
 *   - "coverage-scope warning": the coverage-scope case (same function,
 *     second branch). `--filter` narrows the generated initial-run config's
 *     `<source>` to one file, which deterministically invalidates every
 *     coverage-target attribute pointing elsewhere and trips PHPUnit's
 *     injected `stopOnDefect`; the same `--filter` value produces the same
 *     warning on every run, so a retry cannot help it either.
 */
const BASELINE_FAILURE_MARKERS = [
  'initial test run',
  'without producing a JSON log',
  'baseline test suite itself failed',
  'baseline failed (exit',
] as const;

/**
 * Text unique to a deterministic PHP/Infection startup failure that a retry
 * can never fix, checked before {@link BASELINE_FAILURE_MARKERS} so neither
 * diagnosis is ever reported as a retryable baseline/contention failure. See
 * the module doc comment above for what each phrase is keyed on and why.
 */
const DETERMINISTIC_STARTUP_MARKERS = [
  'the first byte written to STDERR',
  'coverage-scope warning',
] as const;

/**
 * Whether an engine failure message describes a baseline/initial-run failure
 * rather than an ordinary scored run or an unrelated startup/config error.
 *
 * A message that also matches a {@link DETERMINISTIC_STARTUP_MARKERS} entry
 * is never retryable, even when it also matches a baseline marker: those two
 * PHP diagnoses are deterministic, so a retry only pays a wasted second run
 * before surfacing the same failure.
 */
export function isBaselineFailureMessage(message: string): boolean {
  if (DETERMINISTIC_STARTUP_MARKERS.some((marker) => message.includes(marker))) {
    return false;
  }
  return BASELINE_FAILURE_MARKERS.some((marker) => message.includes(marker));
}
