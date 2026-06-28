import { readFileSync } from 'node:fs';
import type { SupportedProjectType } from './engines/registry.js';
import { estimateHeuristic } from './estimate-heuristic.js';
import { invokeMutationTool, MutationToolStartupError } from './utils/exec-classify.js';

export type Fidelity = 'exact' | 'approx';

export interface EstimateResult {
  target: string;
  language: SupportedProjectType;
  mutants: number;
  fidelity: Fidelity;
  basis: string;
  baselineMs?: number;
  estimatedMs?: number;
  concurrency?: number;
  note: string;
}

export interface EstimateOptions {
  absFile: string;
  relFile: string;
  projectType: SupportedProjectType;
  /** Sandbox directory; required for the native Rust path. */
  workDir?: string;
  timeoutMs?: number;
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
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0).length;
}

/**
 * Estimate the number of mutants for a single file without running the full test suite.
 *
 * - Rust + workDir: runs `cargo mutants --list --file <relFile>` for an exact count.
 *   Falls back to heuristic if cargo-mutants is not installed.
 * - Rust without workDir: heuristic fallback (caller should have provisioned a sandbox).
 * - TS / Python / Go: reads `absFile` and applies the source-parse heuristic.
 */
export async function estimateAudit(opts: EstimateOptions): Promise<EstimateResult> {
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
        { cwd: opts.workDir, timeoutMs: opts.timeoutMs ?? ESTIMATE_TIMEOUT_MS },
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

  // TypeScript / Python / Go — heuristic from source.
  return heuristicEstimate(opts);
}
