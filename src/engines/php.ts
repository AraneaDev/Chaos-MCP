/**
 * Mutation testing engine for PHP files (Infection).
 *
 * This module is the ENGINE and nothing else: it sequences one run — prepare
 * workspace → invoke Infection → explain a failure or read the log — and owns
 * the subprocess work. Every phase's substance lives under `engines/php/`:
 *
 *   config.ts    — hybrid Infection config, source-root inference, temp isolation
 *   failures.ts  — startup-failure diagnosis (pure)
 *   report.ts    — JSON-log parsing and scoring (pure)
 *
 * The helpers are re-exported here because that is the surface the test suite
 * already imports; the split moved where they live, not what the module offers.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BaseEngine, RunOptions, MutationResult } from './base.js';
import { invokeMutationTool } from '../utils/exec-classify.js';
import { log, isVerbose } from '../utils/logger.js';
import { DEFAULT_TIMEOUT_MS } from '../utils/constants.js';
import {
  JSON_LOG_NAME,
  PHPUNIT_CONFIG_NAMES,
  PROJECT_CONFIG_NAMES,
  WARNING_FIDELITY_NOTE,
  phpunitFailsOnWarning,
  prepareInfectionWorkspace,
} from './php/config.js';
import { explainMissingJsonLog } from './php/failures.js';
import { parseInfectionJsonLog } from './php/report.js';

export {
  inferSourceDir,
  buildInfectionConfig,
  phpunitFailsOnWarning,
  WARNING_FIDELITY_NOTE,
} from './php/config.js';
export {
  infectionDiagnostics,
  diagnoseInfectionStartupFailure,
  explainMissingJsonLog,
} from './php/failures.js';
export { parseInfectionJsonLog } from './php/report.js';

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
    const { hasProjectConfig, jsonLogPath, env } = prepareInfectionWorkspace(cwd, filePath);

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
        throw explainMissingJsonLog(execErr, cwd, hasProjectConfig);
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

    const result = parseInfectionJsonLog(logText, filePath);
    // Only worth saying when there is something it could be wrong about: a
    // clean run has no survivor to doubt.
    if (result.survived > 0 && !this.projectFailsOnWarning(cwd)) {
      result.fidelityNote = WARNING_FIDELITY_NOTE;
    }
    return result;
  }

  /**
   * Whether the audited project's PHPUnit config fails on warnings. An
   * unreadable or absent config answers `true` — the advisory exists to explain
   * a specific misconfiguration, not to speculate about one we cannot see.
   */
  private projectFailsOnWarning(cwd: string): boolean {
    for (const name of PHPUNIT_CONFIG_NAMES) {
      const path = join(cwd, name);
      if (!existsSync(path)) continue;
      try {
        return phpunitFailsOnWarning(readFileSync(path, 'utf8'));
      } catch {
        return true;
      }
    }
    return true;
  }
}
