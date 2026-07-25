import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BaseEngine, RunOptions, MutationResult, Vulnerability } from './base.js';
import { invokeMutationTool } from '../utils/exec-classify.js';
import { log, isVerbose } from '../utils/logger.js';
import { DEFAULT_TIMEOUT_MS } from '../utils/constants.js';

/** Name of the config we generate when the project ships none. */
const GENERATED_CONFIG_NAME = 'infection.json';
/** Config files Infection already recognises — if present, we do NOT overwrite. */
const PROJECT_CONFIG_NAMES = ['infection.json', 'infection.json5'];
/**
 * PHPUnit configuration files Infection looks for at the project root. Our
 * generated config targets PHPUnit, so when none of these exist Infection has
 * no test runner to drive — a project using a different or custom runner.
 */
const PHPUNIT_CONFIG_NAMES = [
  'phpunit.xml',
  'phpunit.xml.dist',
  'phpunit.dist.xml',
  'phpunit.yml',
  'phpunit.yml.dist',
  'phpunit.dist.yml',
  'phpunit.php',
];
/** Sandbox-relative JSON log path we always read results from. */
const JSON_LOG_NAME = 'chaos-infection-log.json';

/** Top path segment of a workspace-relative file, used as the generated `source.directories` root. */
export function inferSourceDir(filePath: string): string {
  const norm = filePath.replace(/\\/g, '/');
  const slash = norm.indexOf('/');
  return slash > 0 ? norm.slice(0, slash) : '.';
}

/** Build a minimal Infection config for a bare PHPUnit project (hybrid fallback). */
export function buildInfectionConfig(sourceDir: string, jsonLogName: string): string {
  return (
    JSON.stringify(
      {
        source: { directories: [sourceDir] },
        testFramework: 'phpunit',
        logs: { json: jsonLogName },
      },
      null,
      2,
    ) + '\n'
  );
}

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

/** One mutant entry in Infection's JSON log. */
interface InfectionMutant {
  mutator?: { mutatorName?: string; originalFilePath?: string; originalStartLine?: number };
  diff?: string;
}
interface InfectionJsonLog {
  stats?: {
    totalMutantsCount?: number;
    killedCount?: number;
    escapedCount?: number;
    timeOutCount?: number;
    timedOutCount?: number;
  };
  escaped?: InfectionMutant[];
  killed?: InfectionMutant[];
  timeouted?: InfectionMutant[];
  timedOut?: InfectionMutant[];
}

/**
 * Parse Infection's `logs.json` output into a MutationResult.
 *
 * Consistent with the Python/Rust engines: the denominator is `killed + survived`
 * only. `escaped` mutants are the reported survivors (real coverage gaps).
 * Timed-out mutants are counted as killed (the suite detected them by hanging).
 * `notCovered`/`errored` are excluded from the score entirely (missing coverage or
 * a crashed mutation — not a scored pass/fail), mirroring how the Python engine
 * drops `incompetent`.
 *
 * Field names read defensively (stats when present, array lengths as fallback;
 * `timeOutCount`/`timedOutCount` and `timeouted`/`timedOut` both tolerated) so a
 * minor Infection version bump does not silently zero the count. The E2E in
 * Task 4 is the reality check.
 */
/**
 * Reject a log that demonstrably describes some other file.
 *
 * `--filter` scopes the run to one file, so every mutant Infection records
 * should sit in it. When none do, the log did not come from this run — the
 * observed case being a stale `chaos-infection-log.json` copied into the
 * sandbox with the workspace and read after Infection failed to start, which
 * reported another file's hours-old mutants as a fresh 100% score.
 *
 * Paths are compared by suffix because the log records absolute sandbox paths
 * while the audit target is workspace-relative. Mutants with no recorded path
 * cannot contradict anything, so a log carrying none is left alone rather than
 * made unusable.
 */
function assertLogDescribes(filePath: string, mutants: InfectionMutant[]): void {
  const recorded = mutants
    .map((m) => m.mutator?.originalFilePath)
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map((p) => p.replace(/\\/g, '/'));
  if (recorded.length === 0) {
    return;
  }
  const target = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (recorded.some((p) => p === target || p.endsWith(`/${target}`))) {
    return;
  }
  throw new Error(
    `Infection's JSON log describes a different file than the one audited (${filePath}); ` +
      `its mutants belong to ${recorded[0]}. The log is stale or left over from another run, ` +
      `so no result can be reported for ${filePath}.`,
  );
}

export function parseInfectionJsonLog(logText: string, filePath: string): MutationResult {
  let parsed: InfectionJsonLog;
  try {
    parsed = JSON.parse(logText) as InfectionJsonLog;
  } catch {
    throw new Error(
      `Infection produced an unparseable JSON log for ${filePath}. The mutation run likely did not complete ` +
        `(check that the PHPUnit suite runs and a coverage driver — Xdebug or PCOV — is enabled).`,
    );
  }

  const escaped = Array.isArray(parsed.escaped) ? parsed.escaped : [];
  const killedArr = Array.isArray(parsed.killed) ? parsed.killed : [];

  assertLogDescribes(filePath, [...escaped, ...killedArr]);

  const timedOutArr = Array.isArray(parsed.timeouted)
    ? parsed.timeouted
    : Array.isArray(parsed.timedOut)
      ? parsed.timedOut
      : [];

  // L5: `survived`/`totalMutants` must stay consistent with `vulnerabilities`,
  // which is built only from `escaped`. `escaped.length` is therefore the
  // source of truth — reading `stats.escapedCount` independently could
  // (on a stats/array mismatch from an Infection version skew) report a
  // survivor count and score that contradict the emitted `vulnerabilities`.
  const stats = parsed.stats ?? {};
  const survived = escaped.length;
  const timeouts = stats.timeOutCount ?? stats.timedOutCount ?? timedOutArr.length;
  const killed = (stats.killedCount ?? killedArr.length) + timeouts;
  const totalMutants = killed + survived;

  const vulnerabilities: Vulnerability[] = escaped.map((e) => {
    const line = e.mutator?.originalStartLine ?? 0;
    const mutator = e.mutator?.mutatorName ?? 'PHP Mutation Operator';
    const vuln: Vulnerability = {
      line,
      mutator,
      description: `Mutation survived at line ${line}. The PHP test suite did not catch this change.`,
    };
    if (e.diff) vuln.mutated = e.diff.trim();
    return vuln;
  });

  const score = totalMutants > 0 ? ((killed / totalMutants) * 100).toFixed(2) : '100.00';
  return {
    target: filePath,
    totalMutants,
    killed,
    survived,
    mutationScore: `${score}%`,
    vulnerabilities,
  };
}

/**
 * Mutation testing engine for PHP files, backed by the Infection CLI.
 *
 * Flow (inside the sandbox `workDir`): hybrid config (use the project's
 * infection.json/.json5 if present, else write a minimal one whose `logs.json`
 * points at our JSON log) → run
 * `infection --filter=<file> --no-progress --no-interaction --threads=<n|max>`
 * → read + parse the JSON log emitted via config `logs.json`. (Infection 0.34+
 * removed the `--logger-json` CLI flag, so the log path lives in the config.)
 *
 * Coarse: no line scoping (`supportsLineScope: false`). Requires a coverage
 * driver (Xdebug or PCOV); a missing driver surfaces as the baseline error below.
 */
export class PhpEngine extends BaseEngine {
  async run(filePath: string, options?: RunOptions): Promise<MutationResult> {
    const cwd = options?.workDir ?? process.cwd();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const jsonLogPath = join(cwd, JSON_LOG_NAME);

    // The sandbox is a copy of the workspace, so an earlier audit's
    // `chaos-infection-log.json` is copied in along with it. The failure path
    // below treats "a log exists" as proof that Infection ran, so a stale copy
    // silently stood in for a run that never happened — auditing one file
    // returned a hours-old 100% score computed for a different file entirely.
    // Removing it first makes any log read below necessarily this run's output.
    try {
      rmSync(jsonLogPath, { force: true });
    } catch {
      // Best-effort. If the stale log cannot be removed, the provenance check in
      // parseInfectionJsonLog is the remaining guard against reporting it.
    }

    // Hybrid config: only generate when the project ships none.
    const hasProjectConfig = PROJECT_CONFIG_NAMES.some((n) => existsSync(join(cwd, n)));
    if (!hasProjectConfig) {
      try {
        writeFileSync(
          join(cwd, GENERATED_CONFIG_NAME),
          buildInfectionConfig(inferSourceDir(filePath), JSON_LOG_NAME),
          'utf8',
        );
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to write generated infection.json: ${message}`);
      }
    }

    // Prefer the vendored binary; fall back to a global `infection` on PATH.
    const vendored = join(cwd, 'vendor', 'bin', 'infection');
    const bin = existsSync(vendored) ? './vendor/bin/infection' : 'infection';

    const threads =
      options?.phpThreads ?? (options?.concurrency ? String(options.concurrency) : 'max');
    // NOTE: the detailed JSON log is configured via the config file's `logs.json`
    // (see buildInfectionConfig), NOT a CLI flag. Infection 0.34 removed the
    // `--logger-json` option — passing it aborts the run with
    // `The "--logger-json" option does not exist.` The full mutation-detail log
    // this engine parses is only obtainable through config `logs.json`; the CLI
    // only exposes summary/gitlab/html/text loggers.
    const args = [
      `--filter=${filePath}`,
      '--no-progress',
      '--no-interaction',
      `--threads=${threads}`,
    ];
    if (options?.phpTestFrameworkOptions) {
      args.push(`--test-framework-options=${options.phpTestFrameworkOptions}`);
    }

    if (isVerbose()) log(`PhpEngine: ${bin} ${args.join(' ')}`);

    // Isolate Infection's working files per run. Infection (and the phpunit it
    // spawns) write to `sys_get_temp_dir()/infection` — a FIXED shared path. Two
    // concurrent runs (e.g. a parallel `triage_test_coverage` sweep, each in its
    // own sandbox) clobber each other there: one run's phpunit ends up loading a
    // DIFFERENT sandbox's Composer autoloader and dies with
    // `Cannot declare class ComposerAutoloaderInit… already in use`, failing the
    // initial test run. Pointing TMPDIR/TMP/TEMP at a per-run dir inside the
    // sandbox gives each run its own `sys_get_temp_dir()`, so they never collide.
    const infectionTmp = join(cwd, '.chaos-infection-tmp');
    try {
      mkdirSync(infectionTmp, { recursive: true });
    } catch {
      // Best-effort: if we can't create it, fall through and let Infection use
      // its default temp dir (the pre-existing single-run behaviour).
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: infectionTmp,
      TMP: infectionTmp,
      TEMP: infectionTmp,
    };

    let stderr = '';
    try {
      const res = await invokeMutationTool('Infection', bin, args, {
        cwd,
        timeoutMs,
        env,
        signal: options?.signal,
        executor: options?.executor,
      });
      stderr = res.stderr;
    } catch (error: unknown) {
      // Startup failures (missing binary/timeout/crash) rethrow via toExecFailure.
      const execErr = this.toExecFailure(error, 'Infection');
      stderr = execErr.stderr;
      // Infection exits non-zero when mutants escape (MSI below threshold). That
      // is the normal survivors case AS LONG AS the JSON log was produced. If no
      // log exists, the initial (coverage) run failed — surface the likely cause.
      if (!existsSync(jsonLogPath)) {
        // When we generated the config (no project Infection config), it targets
        // PHPUnit. If the project ships no PHPUnit configuration at all, Infection
        // can never run — report that specific, actionable cause instead of the
        // generic coverage-driver hint. (A project with its own Infection config
        // may deliberately target a different framework, so this only applies to
        // the generated-config path.)
        const hasPhpUnitConfig = PHPUNIT_CONFIG_NAMES.some((n) => existsSync(join(cwd, n)));
        if (!hasProjectConfig && !hasPhpUnitConfig) {
          throw new Error(
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
          throw new Error(
            `Infection failed (exit ${execErr.exit}) without producing a JSON log. ` +
              `${specific}\n${infectionDiagnostics(execErr)}`,
          );
        }
        throw new Error(
          `Infection failed (exit ${execErr.exit}) without producing a JSON log. This usually means ` +
            `the initial test run failed — ensure the PHPUnit suite passes (vendor/bin/phpunit) and a ` +
            `coverage driver (Xdebug or PCOV) is enabled.\n${infectionDiagnostics(execErr)}`,
        );
      }
    }

    if (isVerbose() && stderr) log(`Infection stderr: ${stderr.slice(0, 500)}`);

    let logText: string;
    try {
      logText = readFileSync(jsonLogPath, 'utf8');
    } catch {
      const configHint = hasProjectConfig
        ? `Your project ships its own Infection config (${PROJECT_CONFIG_NAMES.join('/')}); ` +
          `Infection 0.34+ has no --logger-json flag, so that config must define ` +
          `logs.json = "${JSON_LOG_NAME}" for Chaos-MCP to read the detailed results. `
        : '';
      throw new Error(
        `Infection produced no readable JSON log at ${JSON_LOG_NAME}. ${configHint}Ensure a coverage driver ` +
          `(Xdebug or PCOV) is enabled and the PHPUnit suite runs from the project root.`,
      );
    }

    return parseInfectionJsonLog(logText, filePath);
  }
}
