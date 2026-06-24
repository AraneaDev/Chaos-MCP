import { BaseEngine, RunOptions, MutationResult } from './base.js';
import { runShell, ExecFailureError } from '../utils/exec.js';
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
    const isMissed = trimmed.startsWith('MISSED');
    const isCaught = trimmed.startsWith('CAUGHT');
    const isUncaught = trimmed.startsWith('UNCAUGHT');

    if (!isMissed && !isCaught && !isUncaught) continue;

    total++;
    if (isCaught) {
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
      const result = await runShell('cargo', ['mutants', '--file', fileName], { cwd, timeoutMs });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: unknown) {
      if (error instanceof ExecFailureError) {
        // ENOENT → cargo not installed
        if (error.code === 'ENOENT') {
          throw new Error(
            'cargo-mutants is not installed. Install it with:\n  cargo install cargo-mutants',
          );
        }

        // Timeout
        if (error.code === 'TIMEOUT') {
          throw new Error(
            `cargo-mutants timed out after ${timeoutMs}ms. Increase timeoutMs or narrow the target file.`,
          );
        }

        // Signal-based crash
        if (error.signal && error.exit === null) {
          throw new Error(
            `cargo-mutants crashed (signal ${error.signal}): ${error.stderr || error.message}`,
          );
        }

        // Non-zero exit: cargo-mutants exits non-zero when mutants survive.
        stdout = error.stdout;
        stderr = error.stderr;

        if (!stdout) {
          throw new Error(
            `cargo-mutants failed (exit ${error.exit}) with no parseable output. stderr: ${error.stderr?.slice(0, 500)}`,
          );
        }
      } else if (error instanceof Error) {
        throw new Error(`cargo-mutants execution failed: ${error.message}`);
      } else {
        throw new Error(`cargo-mutants execution failed: ${String(error)}`);
      }
    }

    if (isVerbose() && stderr) {
      log(`cargo-mutants stderr: ${stderr.slice(0, 500)}`);
    }

    return parseCargoMutantsOutput(stdout, filePath);
  }
}
