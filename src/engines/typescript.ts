import { existsSync, readFileSync } from 'fs';
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
 * Build the `--mutate` argument for Stryker, optionally scoped to a line range.
 *
 * Stryker supports `--mutate "src/file.ts:1-100"` syntax for line-range scoping.
 */
function buildMutateArg(filePath: string, lineScope?: RunOptions['lineScope']): string {
  // No shell quoting — args are passed directly to execFile, not through a shell.
  if (lineScope && lineScope.start > 0 && lineScope.end >= lineScope.start) {
    return `${filePath}:${lineScope.start}-${lineScope.end}`;
  }
  return filePath;
}

/**
 * Build the `--mutators` argument string for Stryker from allowlists and denylists.
 *
 * Stryker syntax:
 *  - `--mutators ConditionalExpression,ArithmeticOperator`  (only these)
 *  - `--mutators !BooleanLiteral`                           (exclude this)
 *  - Combined: `--mutators ConditionalExpression,!StringLiteral`
 */
function buildMutatorsArg(allowlist?: string[], denylist?: string[]): string | null {
  const parts: string[] = [];

  if (allowlist && allowlist.length > 0) {
    parts.push(...allowlist);
  }

  if (denylist && denylist.length > 0) {
    for (const name of denylist) {
      parts.push(`!${name}`);
    }
  }

  return parts.length > 0 ? parts.join(',') : null;
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

    const mutateArg = buildMutateArg(filePath, options?.lineScope);
    const mutatorsArg = buildMutatorsArg(options?.mutatorAllowlist, options?.mutatorDenylist);

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

    if (mutatorsArg) {
      args.push('--mutators', mutatorsArg);
    }

    // dryRun mode: Stryker validates the test suite passes without mutation testing
    if (options?.dryRun) {
      args.push('--dryRun');
    }

    // incremental mode: reuse results from a previous run to skip unchanged mutants
    if (options?.incremental) {
      args.push('--incremental');
      args.push('--incrementalFile', '.stryker-incremental.json');
    }

    if (isVerbose()) {
      log(`TypeScriptEngine: npx stryker ${args.slice(2).join(' ')}`);
    }

    try {
      await invokeMutationTool('StrykerJS', args[0], args.slice(1), { cwd, timeoutMs });
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

    // Collect all mutants across all files
    const mutants: StrykerMutantRecord[] = [];
    if (raw.files) {
      for (const fileData of Object.values(raw.files)) {
        if (Array.isArray(fileData.mutants)) {
          mutants.push(...fileData.mutants);
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
      .map((m) => ({
        line: m.location.start.line,
        replacement: m.mutatorName,
        description:
          m.status === 'NoCoverage'
            ? `No test reached this line (NoCoverage). Consider adding tests covering this branch.`
            : `Logical mutation via [${m.mutatorName}] survived. Your tests did not catch this change.`,
      }));

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
