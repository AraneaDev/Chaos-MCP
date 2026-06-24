import { BaseEngine, RunOptions, MutationResult } from './base.js';
import { ExecFailureError } from '../utils/exec.js';
import {
  invokeMutationTool,
  MutationToolStartupError,
} from '../utils/exec-classify.js';
import { log, isVerbose } from '../utils/logger.js';

/** Default timeout for cargo-mutants runs (5 minutes). */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Structured JSON output from `cargo mutants --output`.
 */
interface CargoMutantsJsonOutput {
  /** Summary statistics */
  summary?: {
    caught?: number;
    missed?: number;
    total?: number;
  };
  /** Detailed mutant results */
  mutants?: {
    file?: string;
    line?: number;
    description?: string;
    caught?: boolean;
    status?: string;
  }[];
}

/**
 * Parse cargo-mutants text output into a MutationResult.
 *
 * cargo-mutants stdout contains lines like:
 *   "MISSED   src/main.rs:42:9  replacement details..."
 *   "CAUGHT   src/main.rs:88:5  replacement details..."
 *
 * Cargo-mutants uses the terms MISSED (survived) and CAUGHT (killed).
 */
function parseCargoMutantsText(stdout: string, filePath: string): MutationResult {
  const lines = stdout.split('\n').filter((l) => l.trim());
  let total = 0;
  let killed = 0;
  const vulnerabilities: MutationResult['vulnerabilities'] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const upper = trimmed.toUpperCase();
    const isMissed = upper.startsWith('MISSED');
    const isCaught = upper.startsWith('CAUGHT');
    const isUncaught = upper.startsWith('UNCAUGHT');
    // `cargo mutants` text output uses mixed case (`timeout`, `Timeout`),
    // unlike its JSON output. Normalise to uppercase before matching.
    // (Live-audit L4 fix.)
    const isTimeout = upper.startsWith('TIMEOUT');

    if (!isMissed && !isCaught && !isUncaught && !isTimeout) continue;

    total++;
    // Audit finding H3: TIMEOUT mutants are tests that hung past the per-mutant
    // timeout. They DID detect the mutant (the test suite hung trying to assert
    // against it), so count them as caught, not skipped.
    if (isCaught || isTimeout) {
      killed++;
      continue;
    }

    // Extract line number from "MISSED   src/file.rs:42:9" or "UNCAUGHT src/file.rs:42:9"
    const lineMatch = trimmed.match(/:(\d+):/);
    const mutantLine = lineMatch ? parseInt(lineMatch[1], 10) : 0;

    vulnerabilities.push({
      line: mutantLine,
      replacement: 'Rust Mutation Operator',
      description: `Mutation survived at line ${mutantLine}. The Rust test suite did not catch this change.`,
    });
  }

  const survived = total - killed;
  const score = total > 0 ? ((killed / total) * 100).toFixed(2) : '100.00';

  return {
    target: filePath,
    totalMutants: total,
    killed,
    survived,
    mutationScore: `${score}%`,
    vulnerabilities,
  };
}

/**
 * Attempt to parse cargo-mutants output as JSON, falling back to text parsing.
 */
function parseCargoMutantsOutput(stdout: string, filePath: string): MutationResult {
  // Try JSON first
  try {
    const parsed = JSON.parse(stdout) as CargoMutantsJsonOutput;

    if (parsed.summary && parsed.mutants) {
      const { caught = 0, missed = 0, total = caught + missed } = parsed.summary;

      return {
        target: filePath,
        totalMutants: total,
        killed: caught,
        survived: missed,
        mutationScore: `${total > 0 ? ((caught / total) * 100).toFixed(2) : '100.00'}%`,
        vulnerabilities: (parsed.mutants || [])
          .filter(
            (m) =>
              !m.caught &&
              (m.status === 'MISSED' || m.status === 'missed' || m.status === 'UNCAUGHT'),
          )
          .map((m) => ({
            line: m.line ?? 0,
            replacement:
              m.description?.split(' ').slice(0, 3).join(' ') ?? 'Rust Mutation Operator',
            description: `Mutation survived at line ${m.line ?? 'unknown'}. The Rust test suite did not catch this change.`,
          })),
      };
    }
  } catch {
    // Not JSON — fall through to text parsing
  }

  // Fall back to text output
  return parseCargoMutantsText(stdout, filePath);
}

/**
 * Mutation testing engine for Rust files.
 *
 * Shells out to `cargo mutants` to generate and evaluate mutants.
 * Requires `cargo-mutants` to be installed: `cargo install cargo-mutants`.
 *
 * Note: Line-level scoping is not supported by cargo-mutants' `--file` flag.
 * The `lineScope` option is silently ignored for Rust targets.
 */
export class RustEngine extends BaseEngine {
  async run(filePath: string, options?: RunOptions): Promise<MutationResult> {
    const cwd = options?.workDir ?? process.cwd();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const fileName = filePath.split('/').pop() ?? filePath;
    if (isVerbose()) {
      log(`RustEngine: cargo mutants --file "${fileName}"`);
    }

    let stdout: string;
    let stderr: string;

    try {
      const result = await invokeMutationTool('cargo-mutants', 'cargo', [
        'mutants',
        '--file',
        fileName,
      ], { cwd, timeoutMs });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: unknown) {
      if (error instanceof MutationToolStartupError) {
        throw new Error(error.message);
      }
      if (!(error instanceof ExecFailureError)) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`cargo-mutants execution failed: ${message}`);
      }

      // Non-zero exit: cargo-mutants exits non-zero when mutants survive OR
      // when the baseline `cargo test` itself fails. If stdout is empty we
      // treat it as a baseline failure (no mutants parsed out); otherwise
      // fall through and parse the captured stdout.
      stdout = error.stdout;
      stderr = error.stderr;

      if (!stdout) {
        throw new Error(
          `cargo-mutants failed (exit ${error.exit}) with no parseable output. ` +
            `This usually means the baseline test suite itself failed \u2014 run \`cargo test\` and fix those first. ` +
            `stderr: ${error.stderr?.slice(0, 500) ?? ''}`,
        );
      }
    }

    if (isVerbose() && stderr) {
      log(`cargo-mutants stderr: ${stderr.slice(0, 500)}`);
    }

    return parseCargoMutantsOutput(stdout, filePath);
  }
}
