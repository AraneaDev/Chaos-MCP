import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { BaseEngine, RunOptions, MutationResult, Vulnerability } from './base.js';
import { ExecFailureError } from '../utils/exec.js';
import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';
import { log, isVerbose } from '../utils/logger.js';

/** Default timeout for Stryker runs (5 minutes). */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Path (relative to the Stryker working directory) where the JSON reporter
 * writes its output.
 */
const STRIKER_JSON_REPORT = 'reports/mutation/mutation.json';

/**
 * Structured JSON produced by the Stryker JSON reporter.
 */
interface StrykerJsonReport {
  files: Record<
    string,
    {
      source: string;
      mutants: StrykerMutantRecord[];
    }
  >;
}

interface StrykerMutantRecord {
  id: string;
  mutatorName: string;
  replacement: string;
  location: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  status: 'Killed' | 'Survived' | 'NoCoverage' | 'CompileError' | 'RuntimeError' | 'Timeout';
  statusReason?: string;
}

/**
 * Slice the original source span a mutant replaced, from the report's embedded
 * file source. 1-based lines/columns, exclusive end column. Returns undefined
 * (never throws) when the location falls outside the source.
 */
function sliceSource(source: string, loc: StrykerMutantRecord['location']): string | undefined {
  const lines = source.split('\n');
  const { start, end } = loc;
  if (
    start.line < 1 ||
    end.line < 1 ||
    start.line > lines.length ||
    end.line > lines.length ||
    start.column < 1 ||
    end.column < 1
  ) {
    return undefined;
  }
  if (start.line === end.line) {
    return lines[start.line - 1].slice(start.column - 1, end.column - 1);
  }
  const parts: string[] = [lines[start.line - 1].slice(start.column - 1)];
  for (let ln = start.line + 1; ln < end.line; ln++) {
    parts.push(lines[ln - 1]);
  }
  parts.push(lines[end.line - 1].slice(0, end.column - 1));
  return parts.join('\n');
}

/**
 * Build the `--mutate` argument for Stryker, optionally scoped to one or more
 * 1-based inclusive line ranges. Stryker accepts a comma-separated list where
 * each entry may carry a `:startLine-endLine` suffix:
 *   "src/file.ts:1-5,src/file.ts:20-25"
 */
function buildMutateArg(filePath: string, ranges?: { start: number; end: number }[]): string {
  // No shell quoting — args are passed directly to execFile, not through a shell.
  // Fail closed on invalid scope: the handler validates args before they reach
  // here, but this is defense-in-depth against silent full-file mutation
  // (audit M12). Each range is validated independently.
  if (ranges && ranges.length > 0) {
    return ranges
      .map((r) => {
        if (!Number.isInteger(r.start) || r.start < 1) {
          throw new Error(`lineScope.start must be an integer >= 1, got ${r.start}`);
        }
        if (!Number.isInteger(r.end) || r.end < r.start) {
          throw new Error(`lineScope.end must be an integer >= start (${r.start}), got ${r.end}`);
        }
        return `${filePath}:${r.start}-${r.end}`;
      })
      .join(',');
  }
  return filePath;
}

/**
 * Build a StrykerJS v9 config file in the sandbox working directory when
 * mutator configuration (denylist) is specified.
 *
 * StrykerJS v9 removed the `--mutators` CLI flag from v8. Mutator
 * configuration is now done exclusively via `stryker.config.json`.
 * We write a minimal config with only the `mutators` key so the project's
 * existing config (if any) is not clobbered — Stryker merges CLI args with
 * the config file, and the config file is the authoritative source for
 * mutator settings.
 *
 * **allowlist is not supported:** v9's config model requires toggling
 * individual mutators off; there is no way to express "only these N mutators"
 * without knowing the complete list of all mutator names. Users who need an
 * allowlist should create their own `stryker.config.json`.
 *
 * Mutator names remain PascalCase as in v8 (e.g. "ConditionalExpression",
 * "ArithmeticOperator"). Stryker validates them at runtime.
 */
function writeStrykerMutatorConfig(cwd: string, denylist: string[]): void {
  const configPath = join(cwd, 'stryker.config.json');

  // Merge into any existing config rather than overwriting it. A blind write
  // would discard the project's own stryker.config.json (testRunner, mutate
  // globs, reporters, thresholds, plugins), silently running mutation under
  // different settings than the user configured (audit Med#4).
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        config = parsed as Record<string, unknown>;
      }
    } catch {
      // Unreadable / invalid existing config — fall back to a fresh object.
    }
  }

  const existingMutators =
    config.mutators !== null &&
    typeof config.mutators === 'object' &&
    !Array.isArray(config.mutators)
      ? (config.mutators as Record<string, boolean>)
      : {};
  const mutators: Record<string, boolean> = { ...existingMutators };
  for (const name of denylist) {
    mutators[name] = false;
  }
  config.mutators = mutators;

  writeFileSync(configPath, JSON.stringify(config), 'utf-8');
}

/**
 * Mutation testing engine for TypeScript/JavaScript files.
 *
 * Invokes the StrykerJS CLI (via `npx stryker run`) inside the sandbox
 * working directory so the real workspace tree is never touched.
 */
export class TypeScriptEngine extends BaseEngine {
  async run(filePath: string, options?: RunOptions): Promise<MutationResult> {
    const resolvedRunner = options?.testRunner ?? 'command';
    const cwd = options?.workDir ?? process.cwd();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const effectiveRanges =
      options?.lineRanges ?? (options?.lineScope ? [options.lineScope] : undefined);
    const mutateArg = buildMutateArg(filePath, effectiveRanges);

    // StrykerJS v9 removed the `--mutators` CLI flag. We express denylists by
    // writing a minimal stryker.config.json in the sandbox with the
    // `mutators` key. Allowlists are not supported without a full config.
    if (options?.mutatorAllowlist && options.mutatorAllowlist.length > 0) {
      throw new Error(
        'mutatorAllowlist is not supported in StrykerJS v9. ' +
          'Use mutatorDenylist instead, or create a stryker.config.json with explicit mutator settings. ' +
          `Requested allowlist: ${options.mutatorAllowlist.join(', ')}`,
      );
    }
    if (options?.mutatorDenylist && options.mutatorDenylist.length > 0) {
      writeStrykerMutatorConfig(cwd, options.mutatorDenylist);
    }

    // ── Build the Stryker CLI arguments ──
    // Use --concurrency when provided; omit to let Stryker auto-detect CPU cores.
    const args = [
      'npx',
      '--no-install',
      'stryker',
      'run',
      '--mutate',
      mutateArg,
      '--testRunner',
      resolvedRunner,
      '--reporters',
      'json',
      '--logLevel',
      'off',
      '--cleanTempDir',
      'true',
      '--tempDirName',
      '.stryker-tmp',
    ];

    if (typeof options?.concurrency === 'number' && options.concurrency > 0) {
      args.push('--concurrency', String(options.concurrency));
    }

    // No denylist args to add — denylist is now expressed via stryker.config.json

    // dryRun mode (StrykerJS v9: renamed --dryRun to --dryRunOnly)
    if (options?.dryRun) {
      args.push('--dryRunOnly');
    }

    // incremental mode: reuse results from a previous run to skip unchanged mutants
    if (options?.incremental) {
      args.push('--incremental');
      args.push('--incrementalFile', '.stryker-incremental.json');
    }

    // per-mutant timeout: how long an individual mutant's test is allowed to run
    if (typeof options?.perMutantTimeoutMs === 'number' && options.perMutantTimeoutMs > 0) {
      args.push('--timeoutMs', String(options.perMutantTimeoutMs));
    }

    if (isVerbose()) {
      log(`TypeScriptEngine: npx stryker ${args.slice(2).join(' ')}`);
    }

    try {
      await invokeMutationTool('StrykerJS', args[0], args.slice(1), {
        cwd,
        timeoutMs,
        signal: options?.signal,
      });
    } catch (error: unknown) {
      // Startup-class failures (not-installed / timeout / signal crash) are
      // wrapped in MutationToolStartupError by the helper. Surface verbatim.
      if (error instanceof MutationToolStartupError) {
        throw new Error(error.message);
      }

      // Per-tool exit-code logic. The shared helper has already classified
      // the standard startup failures; anything reaching here is a non-zero
      // exit code that Stryker-specific behaviour must interpret.
      if (!(error instanceof ExecFailureError)) {
        if (error instanceof Error) throw error;
        throw new Error(`Stryker execution failed: ${String(error)}`);
      }

      // Stryker-specific exit code semantics:
      //   1 = configuration error or internal exception (real failure)
      //   2 = mutation score threshold not reached (expected when mutants survive)
      if (error.exit === 1) {
        throw new Error(
          `StrykerJS configuration or internal error (exit 1): ${error.stderr?.slice(0, 500) || error.message}`,
        );
      }

      // exit 2 (threshold not met) or other non-zero → expected, parse the report.
      // Capture stderr for diagnostics in case the report is missing.
      if (isVerbose() && error.stderr) {
        log(`StrykerJS exited ${error.exit} (expected): ${error.stderr.slice(0, 500)}`);
      }
      // fall through to parseReport
    }

    // ── Parse the JSON report ──
    return this.parseReport(cwd, filePath);
  }

  /**
   * Read and parse the Stryker JSON report from the filesystem.
   * Extracted as a separate method for testability.
   *
   * @internal
   */
  parseReport(workDir: string, filePath: string): MutationResult {
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

    // Collect all mutants across all files, keeping each mutant's file source
    // so we can slice the original span it replaced.
    const mutants: StrykerMutantRecord[] = [];
    const sourceById = new Map<string, string>();
    if (raw.files) {
      for (const fileData of Object.values(raw.files)) {
        if (Array.isArray(fileData.mutants)) {
          for (const m of fileData.mutants) {
            mutants.push(m);
            if (typeof fileData.source === 'string') sourceById.set(m.id, fileData.source);
          }
        }
      }
    }

    // Filter out invalid mutants (CompileError / RuntimeError) — they are
    // not testable and shouldn't penalise the mutation score.
    // (Stryker's `Ignored` status is normally absent from a finished report,
    // but defensively skip it just in case a future version emits it.)
    const validMutants = mutants.filter(
      (m) => m.status !== 'CompileError' && m.status !== 'RuntimeError',
    );
    const totalMutants = validMutants.length;
    // Timeouts count as killed — the mutant was detected by causing the test suite to hang.
    const killed = validMutants.filter(
      (m) => m.status === 'Killed' || m.status === 'Timeout',
    ).length;
    const survived = validMutants.filter((m) => m.status === 'Survived').length;
    const score = totalMutants > 0 ? ((killed / totalMutants) * 100).toFixed(2) : '100.00';

    // Vulnerabilities include Survived AND NoCoverage mutants — NoCoverage
    // means no test reached that code path and is therefore an actionable hole.
    const vulnerabilities: Vulnerability[] = validMutants
      .filter((m) => m.status === 'Survived' || m.status === 'NoCoverage')
      .map((m) => {
        const vuln: Vulnerability = {
          line: m.location.start.line,
          mutator: m.mutatorName,
          description:
            m.status === 'NoCoverage'
              ? `No test reached this line (NoCoverage). Consider adding tests covering this branch.`
              : `Logical mutation via [${m.mutatorName}] survived. Your tests did not catch this change.`,
        };
        if (m.replacement) vuln.mutated = m.replacement;
        const source = sourceById.get(m.id);
        if (source !== undefined) {
          try {
            const original = sliceSource(source, m.location);
            if (original) vuln.original = original;
          } catch {
            // best-effort — leave original unset
          }
        }
        return vuln;
      });

    // Log a heads-up when NoCoverage mutants are present (these lower the score
    // and now show up as explicit vulnerabilities — previously they were silent).
    const noCoverage = validMutants.filter((m) => m.status === 'NoCoverage').length;
    if (noCoverage > 0 && isVerbose()) {
      log(`parseReport: ${noCoverage} NoCoverage mutant(s) reported as vulnerabilities`);
    }

    return {
      target: filePath,
      totalMutants,
      killed,
      survived,
      mutationScore: `${score}%`,
      vulnerabilities,
    };
  }
}
