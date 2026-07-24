import { readFileSync } from 'node:fs';
import type { SupportedProjectType } from './engines/registry.js';
import type { EnvironmentInfo } from './utils/project-detector.js';
import { estimateHeuristic } from './estimate-heuristic.js';
import { invokeMutationTool, MutationToolStartupError } from './utils/exec-classify.js';
import { runShell } from './utils/exec.js';
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
        ['mutants', '--list', '--file', opts.relFile],
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
        basis: 'cargo-mutants --list',
        note: 'Exact mutant count from cargo-mutants --list (no tests were run).',
      };
    } catch (error: unknown) {
      if (error instanceof MutationToolStartupError) {
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

  const cmd = resolveBaselineTestCommand(opts.env, opts.projectType, opts.relFile);
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
    };
    if (opts.executor) await opts.executor.run(cmd.command, cmd.args, execOptions);
    else await runShell(cmd.command, cmd.args, execOptions);
    const baselineMs = Date.now() - t0;
    const concurrency = opts.concurrency ?? 1;
    const commandRunner = opts.projectType === 'typescript' && opts.env.testRunner === 'command';
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
  } catch {
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
