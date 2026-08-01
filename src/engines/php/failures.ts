/**
 * Explaining a failed Infection run.
 *
 * Infection reports startup failures on its own STDOUT rather than stderr, and
 * a non-zero exit is normal (mutants escaped) — so distinguishing "the run
 * worked and found survivors" from "the run never started" is its own concern,
 * kept free of the parsing and config logic.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ExecFailureError } from '../../utils/exec-error.js';
import { PHPUNIT_CONFIG_NAMES, PROJECT_CONFIG_NAMES } from './config.js';

/** How much of each stream to echo back when Infection dies before logging. */
const DIAGNOSTIC_TAIL_CHARS = 2000;

/**
 * Build the operator-facing diagnostic tail for an Infection run that failed
 * before writing its JSON log.
 *
 * Infection reports startup failures — "Project tests must be in a passing
 * state", the PHPUnit exit code, and the wrapped PHPUnit STDOUT/STDERR — on its
 * OWN STDOUT, not stderr. Reporting only `stderr` (as this engine used to) left
 * every such failure ending in a bare "stderr:" with nothing after it, so the
 * real cause (a failing test, a coverage-scope warning tripping PHPUnit's
 * stopOnDefect, a killed process) was invisible and the caller was left with
 * only the generic "ensure the suite passes" guess.
 *
 * The tail — not the head — carries the cause: Infection's banner and the test
 * progress dots come first, and the error block is emitted last.
 */
export function infectionDiagnostics(err: { stdout?: string; stderr?: string }): string {
  const tail = (s: string | undefined): string => {
    const text = (s ?? '').trimEnd();
    return text.length > DIAGNOSTIC_TAIL_CHARS ? `…${text.slice(-DIAGNOSTIC_TAIL_CHARS)}` : text;
  };
  const parts: string[] = [];
  const out = tail(err.stdout);
  const errOut = tail(err.stderr);
  // Infection's own error block lives on stdout, so surface it first.
  if (out) parts.push(`Infection output (tail):\n${out}`);
  if (errOut) parts.push(`stderr (tail):\n${errOut}`);
  return parts.length > 0
    ? parts.join('\n\n')
    : '(Infection produced no output on stdout or stderr.)';
}

/**
 * Recognise the two Infection startup failures whose symptom is indistinguishable
 * from "your test suite is broken" but whose cause is neither the suite nor the
 * coverage driver. Both are specific to running Infection with `--filter`, which
 * is how this engine always runs it, so both are reachable on a project whose
 * suite passes perfectly under a plain `vendor/bin/phpunit`.
 *
 * Returns the actionable explanation, or null when the failure is not one of
 * these and the generic guidance should stand.
 */
export function diagnoseInfectionStartupFailure(output: string): string | null {
  // (1) Infection's InitialTestsRunner passes a callback to Symfony's
  //     Process::run that calls `$process->stop()` as soon as the type is
  //     Process::ERR — i.e. on the FIRST byte the test process writes to
  //     STDERR, regardless of whether any test failed. PHPUnit is SIGTERMed
  //     mid-suite and Infection reports the resulting exit code 143 under its
  //     "Project tests must be in a passing state" banner.
  if (/exit code of 143/.test(output)) {
    return (
      `Infection terminated the initial test run itself: it stops the test process on the first byte ` +
      `written to STDERR (Symfony Process::ERR), and PHPUnit then exits 143 (SIGTERM). The suite is ` +
      `probably fine — something it runs writes to STDERR. Find it with ` +
      `\`vendor/bin/phpunit 2>/tmp/suite.err\` and make those writes go to an injectable stream that ` +
      `tests can capture, so the suite emits nothing on STDERR.`
    );
  }

  // (2) `--filter=<file>` makes Infection generate an initial-run PHPUnit config
  //     whose <source> is narrowed to that one file. Every coverage-target
  //     attribute (#[CoversClass] and friends) pointing outside it becomes
  //     invalid, PHPUnit emits a warning, and Infection's own injected
  //     stopOnDefect="true" halts the suite.
  if (/is not a valid target for code coverage/.test(output)) {
    return (
      `PHPUnit stopped on a coverage-scope warning, not on a real test failure. Running Infection with ` +
      `\`--filter\` narrows the generated initial-run config's <source> to the single target file, which ` +
      `invalidates every #[CoversClass]/#[UsesClass] attribute pointing elsewhere; Infection injects ` +
      `stopOnDefect="true" into that same config, so the first such warning aborts the suite. Remove the ` +
      `coverage-target attributes from the test suite (or stop using --filter).`
    );
  }

  return null;
}

/**
 * Explain an Infection run that exited non-zero WITHOUT producing a JSON log.
 *
 * A non-zero exit alone is normal (mutants escaped); a non-zero exit with no
 * log means the initial coverage run never completed. Returns — rather than
 * throws — the error to raise, so each branch is assertable directly.
 *
 * The three branches are ordered most-specific-first, and that order decides
 * which explanation a user sees:
 *  1. we generated the config (so it targets PHPUnit) and the project has no
 *     PHPUnit config at all → Infection could never have run;
 *  2. a named startup failure recognised in Infection's own output
 *     (see {@link diagnoseInfectionStartupFailure});
 *  3. the generic "make the suite pass, enable a coverage driver" guidance.
 */
export function explainMissingJsonLog(
  execErr: ExecFailureError,
  cwd: string,
  hasProjectConfig: boolean,
): Error {
  // When we generated the config (no project Infection config), it targets
  // PHPUnit. If the project ships no PHPUnit configuration at all, Infection
  // can never run — report that specific, actionable cause instead of the
  // generic coverage-driver hint. (A project with its own Infection config
  // may deliberately target a different framework, so this only applies to
  // the generated-config path.)
  const hasPhpUnitConfig = PHPUNIT_CONFIG_NAMES.some((n) => existsSync(join(cwd, n)));
  if (!hasProjectConfig && !hasPhpUnitConfig) {
    return new Error(
      `Infection could not run: no PHPUnit configuration found (looked for ` +
        `${PHPUNIT_CONFIG_NAMES.join(', ')}). Chaos-MCP's PHP engine drives Infection, which ` +
        `requires PHPUnit; this project appears to use a different or custom test runner. Add a ` +
        `phpunit.xml, or ship an Infection config (${PROJECT_CONFIG_NAMES.join('/')}) that ` +
        `targets your framework.\n${infectionDiagnostics(execErr)}`,
    );
  }
  // Infection reports startup failures on its own STDOUT, so the specific
  // cause — when there is one we can name — is found there.
  const specific = diagnoseInfectionStartupFailure(
    `${execErr.stdout ?? ''}\n${execErr.stderr ?? ''}`,
  );
  if (specific !== null) {
    return new Error(
      `Infection failed (exit ${execErr.exit}) without producing a JSON log. ` +
        `${specific}\n${infectionDiagnostics(execErr)}`,
    );
  }
  return new Error(
    `Infection failed (exit ${execErr.exit}) without producing a JSON log. This usually means ` +
      `the initial test run failed — ensure the PHPUnit suite passes (vendor/bin/phpunit) and a ` +
      `coverage driver (Xdebug or PCOV) is enabled.\n${infectionDiagnostics(execErr)}`,
  );
}
