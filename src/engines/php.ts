import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BaseEngine, RunOptions, MutationResult, Vulnerability } from './base.js';
import { invokeMutationTool } from '../utils/exec-classify.js';
import { log, isVerbose } from '../utils/logger.js';
import { DEFAULT_TIMEOUT_MS } from '../utils/constants.js';

/** Name of the config we generate when the project ships none. */
const GENERATED_CONFIG_NAME = 'infection.json';
/** Config files Infection already recognises — if present, we do NOT overwrite. */
const PROJECT_CONFIG_NAMES = ['infection.json', 'infection.json5'];
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
    const bin = existsSync(vendored) ? vendored : 'infection';

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
        throw new Error(
          `Infection failed (exit ${execErr.exit}) without producing a JSON log. This usually means ` +
            `the initial test run failed — ensure the PHPUnit suite passes (vendor/bin/phpunit) and a ` +
            `coverage driver (Xdebug or PCOV) is enabled. stderr: ${execErr.stderr?.slice(0, 500) ?? ''}`,
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
