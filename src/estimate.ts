import { readFileSync } from 'node:fs';
import type { EnvironmentInfo, SupportedProjectType } from './utils/project-detector.js';
import { estimateHeuristic } from './estimate-heuristic.js';
import { invokeMutationTool, MutationToolStartupError } from './utils/exec-classify.js';
import { escapeCargoFileGlob } from './engines/rust.js';
import { runShell } from './utils/exec.js';
import { isCancel } from './utils/cancel.js';
import { resolveBaselineTestCommand, projectTimingRange } from './baseline-timing.js';
import type { ExecutionSession } from './utils/execution.js';

export type Fidelity = 'exact' | 'approx';

export interface EstimateResult {
  target: string;
  language: SupportedProjectType;
  mutants: number;
  fidelity: Fidelity;
  basis: string;
  baselineMs?: number;
  optimisticMs?: number;
  estimatedMs?: number;
  upperBoundMs?: number;
  concurrency?: number;
  timingConfidence?: 'low' | 'medium';
  budgetMs?: number;
  fitsBudget?: boolean;
  recommendation?: string;
  note: string;
}

export interface EstimateOptions {
  absFile: string;
  relFile: string;
  projectType: SupportedProjectType;
  /** Sandbox directory; required for the native Rust path and for withTiming. */
  workDir?: string;
  timeoutMs?: number;
  /** When true (and workDir + env are present), run the test suite once to measure baselineMs. */
  withTiming?: boolean;
  /** Environment info; required when withTiming=true. */
  env?: EnvironmentInfo;
  /**
   * The test runner the AUDIT would use for this target, already resolved with
   * the audit's own precedence (engine config section → `cfg.testRunner` →
   * detected `env.testRunner`; see `buildRunOptions` in audit/run-options.ts).
   *
   * Passed in rather than re-derived here because reading `env.testRunner`
   * directly ignored the config file entirely: a project detected as `vitest`
   * with `"stryker": { "testRunner": "command" }` in config was audited with
   * the command runner but ESTIMATED with the native constants — roughly a 4×
   * under-estimate (perMutantOverheadMs 250 vs 1500, startupMs 5000 vs 10000,
   * estimateFactor 1.2 vs 1.5) reported as `fitsBudget: true` for a run that
   * would blow its budget, and a baseline measured with the wrong command.
   *
   * Falls back to `env.testRunner` when absent, so direct callers (tests, and
   * anything that has no config) behave exactly as before.
   */
  testRunner?: string;
  /** Worker concurrency used to project total time; defaults to 1. */
  concurrency?: number;
  /** Abort signal; forwarded to subprocesses so the caller can cancel in-flight work. */
  signal?: AbortSignal;
  /** Internal native/container execution session for exact counts and timing. */
  executor?: ExecutionSession;
}

const ESTIMATE_TIMEOUT_MS = 60_000;

/**
 * Returns true when a sandbox must be provisioned before calling `estimateAudit`.
 * Rust always needs one (for `cargo mutants --list`); timing needs one for any language.
 */
export function estimateNeedsSandbox(
  projectType: SupportedProjectType,
  withTiming: boolean,
): boolean {
  return withTiming || projectType === 'rust';
}

/** Heuristic estimate from the file's source. Read failure → 0 with a note. */
function heuristicEstimate(opts: EstimateOptions, basisSuffix = ''): EstimateResult {
  let source = '';
  try {
    source = readFileSync(opts.absFile, 'utf8');
  } catch {
    source = '';
  }
  const h = estimateHeuristic(source, opts.projectType);
  return {
    target: opts.relFile,
    language: opts.projectType,
    mutants: h.mutants,
    fidelity: 'approx',
    basis: `source heuristic: ${h.constructs} constructs${basisSuffix}`,
    note:
      'Approximate mutant count from a source-parse heuristic; the real audit may differ. ' +
      'Run audit_code_resilience for exact results.',
  };
}

/** Count mutants from `cargo mutants --list` output (one mutant per non-empty line). */
function countCargoMutants(stdout: string): number {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // cargo-mutants --list prints one mutant per line as "path:line:col: description".
  // Match on the :line:col: shape (not anchored, so Windows-style drive letters and
  // leading path segments are fine). Fall back to all non-empty lines if NOTHING
  // matches — never under-report an "exact" count to 0 due to an unexpected format.
  const entries = lines.filter((l) => /:\d+:\d+:/.test(l));
  return entries.length > 0 ? entries.length : lines.length;
}

/**
 * Compute the mutant count for a file without running the test suite.
 * Non-startup ExecFailureErrors from cargo-mutants propagate to the caller.
 *
 * - Rust + workDir: runs `cargo mutants --list --file <relFile>` for an exact count.
 *   Falls back to heuristic if cargo-mutants is not installed.
 * - Rust without workDir: heuristic fallback (caller should have provisioned a sandbox).
 * - TS / Python: reads `absFile` and applies the source-parse heuristic.
 */
async function computeCount(opts: EstimateOptions): Promise<EstimateResult> {
  if (opts.projectType === 'rust') {
    if (opts.workDir === undefined) {
      // Defensive: caller should have provisioned a sandbox for Rust.
      return heuristicEstimate(opts, ' (no sandbox; cargo-mutants skipped)');
    }
    try {
      const res = await invokeMutationTool(
        'cargo-mutants',
        'cargo',
        // `--file` takes a GLOBSET PATTERN, not a literal path, so the same
        // escape the audit path uses (engines/rust.ts) is mandatory here.
        // Unescaped, `src/parser/token[0].rs` makes `[0]` a character class and
        // the glob selects `src/parser/token0.rs` — a DIFFERENT file — or, far
        // more often, nothing at all, and cargo-mutants still exits 0. Because
        // this branch labels its result `fidelity: 'exact'`, a miss does not
        // degrade to the heuristic: it returns a confident `mutants: 0`, and the
        // timing projected from it is silently zero-cost. See the docblock on
        // `escapeCargoFileGlob` for the verified cargo-mutants 27.1.0 incident.
        ['mutants', '--list', '--file', escapeCargoFileGlob(opts.relFile)],
        {
          cwd: opts.workDir,
          timeoutMs: opts.timeoutMs ?? ESTIMATE_TIMEOUT_MS,
          signal: opts.signal,
          executor: opts.executor,
        },
      );
      return {
        target: opts.relFile,
        language: 'rust',
        mutants: countCargoMutants(res.stdout),
        fidelity: 'exact',
        basis: 'cargo-mutants --list (generated mutants)',
        // The count is exact for GENERATED mutants — which is the right input
        // for TIMING, because an unviable mutant still costs a compile — but it
        // is NOT the audit's denominator. `scoreCounts` in engines/rust.ts
        // computes totalMutants = caught + timeout + missed and reports
        // unviable mutants separately as `incompetent`, so on a file with
        // generics or trait bounds the audit routinely scores fewer mutants
        // than this. Saying "exact" without saying exact-at-what invited the
        // reading that the audit would report the same total.
        note:
          'Exact count of the mutants cargo-mutants --list GENERATES for this file (no tests were run). ' +
          'The audit scores fewer: mutants that fail to compile are excluded from its denominator and ' +
          'reported as `incompetent`. Timing below is projected over the generated count, since ' +
          'unviable mutants still cost compile time.',
      };
    } catch (error: unknown) {
      // ONLY a genuinely missing cargo-mutants may degrade to the heuristic.
      //
      // This catch used to swallow the whole MutationToolStartupError class and
      // return normally with "(cargo-mutants not installed)" appended — so a
      // TIMEOUT, truncated output, and (before the ABORTED passthrough in
      // exec-classify.ts) a deliberate CANCELLATION were all reported to the
      // caller as a missing binary, wrapped in a successful result. There is no
      // request context here to rescue it, and estimate-handler's `isCancel`
      // only runs in its catch, which a normal return never reaches.
      //
      // Branch on the machine-readable `reason`, never on the message prose.
      if (error instanceof MutationToolStartupError && error.reason === 'NOT_INSTALLED') {
        return heuristicEstimate(opts, ' (cargo-mutants not installed)');
      }
      throw error;
    }
  }

  // TypeScript / Python — heuristic from source.
  return heuristicEstimate(opts);
}

/**
 * Best-effort: run the baseline test suite and populate timing fields on `result`.
 * On miss (no command resolved) or failure, appends ' (timing unavailable)' to result.note.
 * Only runs when opts.withTiming && opts.workDir && opts.env.
 */
async function applyTiming(result: EstimateResult, opts: EstimateOptions): Promise<void> {
  if (!opts.withTiming || !opts.workDir || !opts.env) return;

  // The runner the AUDIT resolved, not the one detection alone reported. Both
  // the baseline COMMAND and the timing MODEL below key on it, and reading
  // `env.testRunner` for either made a config-file `testRunner` override
  // invisible to the estimate while the audit honoured it.
  const testRunner = opts.testRunner ?? opts.env.testRunner;

  const cmd = resolveBaselineTestCommand(opts.env, opts.projectType, opts.relFile, testRunner);
  // Stryker disable next-line ConditionalExpression,BlockStatement: the surrounding catch produces the same public fallback if an undefined command is dereferenced.
  if (cmd === undefined) {
    result.note += ' (timing unavailable)';
    return;
  }
  try {
    const t0 = Date.now();
    const execOptions = {
      cwd: opts.workDir,
      timeoutMs: opts.timeoutMs ?? ESTIMATE_TIMEOUT_MS,
      signal: opts.signal,
      killTree: true,
    };
    if (opts.executor) await opts.executor.run(cmd.command, cmd.args, execOptions);
    else await runShell(cmd.command, cmd.args, execOptions);
    const baselineMs = Date.now() - t0;
    const concurrency = opts.concurrency ?? 1;
    const commandRunner = opts.projectType === 'typescript' && testRunner === 'command';
    const projection = projectTimingRange(result.mutants, baselineMs, concurrency, commandRunner);
    result.baselineMs = baselineMs;
    result.concurrency = concurrency;
    result.optimisticMs = projection.optimisticMs;
    result.estimatedMs = projection.estimatedMs;
    result.upperBoundMs = projection.upperBoundMs;
    result.timingConfidence = projection.confidence;
    if (opts.timeoutMs !== undefined) {
      result.budgetMs = opts.timeoutMs;
      result.fitsBudget = projection.upperBoundMs <= opts.timeoutMs;
      result.recommendation = result.fitsBudget
        ? 'Estimated to fit the configured audit budget.'
        : 'Upper estimate exceeds the configured audit budget; narrow lineScope/diffBase or use a larger budget.';
    }
  } catch (err: unknown) {
    // Cancellation must escape. This catch is a best-effort fallback for a
    // baseline suite that fails or times out — not a place to swallow a
    // deliberate abort. Swallowing it made handleEstimateCall's `isCancel`
    // branch unreachable for the timing phase, so a client that cancelled
    // mid-baseline got a SUCCESSFUL estimate back for work it had cancelled.
    if (isCancel(err)) throw err;
    result.note += ' (timing unavailable)';
  }
}

/**
 * Estimate the number of mutants for a single file without running the full test suite.
 *
 * When withTiming=true (and workDir + env are present), runs the test suite once to
 * measure baselineMs and populates estimatedMs. This applies to ALL languages including Rust.
 */
export async function estimateAudit(opts: EstimateOptions): Promise<EstimateResult> {
  const result = await computeCount(opts);
  await applyTiming(result, opts);
  return result;
}
