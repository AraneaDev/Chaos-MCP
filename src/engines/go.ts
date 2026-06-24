import { BaseEngine, RunOptions, MutationResult } from './base.js';
import { runShell, ExecFailureError } from '../utils/exec.js';
import { log, isVerbose } from '../utils/logger.js';

/** Default timeout for go-mutesting runs (5 minutes). */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Structured output from go-mutesting's JSON reporter.
 *
 * go-mutesting outputs a JSON object with a `stats` summary and a `mutants`
 * array when configured with `json_output: true` in its YAML config.
 *
 * When JSON output is not available, we fall back to parsing the text-based
 * stdout (each line is a mutant result).
 */
interface GoMutestingJsonOutput {
  stats?: {
    totalMutants?: number;
    killed?: number;
    survived?: number;
    mutationScore?: number;
  };
  mutants?: {
    line?: number;
    mutator?: string;
    status?: string;
  }[];
}

/**
 * Parse go-mutesting text-based stdout into a MutationResult.
 * go-mutesting outputs one line per mutant: "PASS" or "FAIL" with a description.
 * Example line: "PASS  \"/path/to/file.go:42:1\"" or "FAIL  \"/path/to/file.go:88:1\""
 */
function parseGoMutestingText(stdout: string, filePath: string): MutationResult {
  const lines = stdout.split('\n').filter((l) => l.trim());
  let total = 0;
  let killed = 0;
  const vulnerabilities: MutationResult['vulnerabilities'] = [];

  for (const line of lines) {
    // Lines look like: "PASS  \"/path/to/file.go:42:1\"" or "FAIL  \"/path/to/file.go:42:1\""
    const isFail = line.startsWith('FAIL');
    const isPass = line.startsWith('PASS');

    if (!isFail && !isPass) continue;

    total++;

    // Extract line number from the output
    const lineMatch = line.match(/:(\d+):/);
    const mutantLine = lineMatch ? parseInt(lineMatch[1], 10) : 0;

    if (isPass) {
      killed++;
    } else {
      vulnerabilities.push({
        line: mutantLine,
        replacement: 'Go Mutation Operator',
        description: `Mutation survived at line ${mutantLine}. The go test suite did not catch this change.`,
      });
    }
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
 * Attempt to parse go-mutesting output as JSON, falling back to text parsing.
 */
function parseGoMutestingOutput(stdout: string, filePath: string): MutationResult {
  let parsed: GoMutestingJsonOutput;

  try {
    parsed = JSON.parse(stdout) as GoMutestingJsonOutput;
  } catch {
    // Not JSON — parse as text output
    return parseGoMutestingText(stdout, filePath);
  }

  // JSON output available
  if (parsed.stats && parsed.mutants) {
    const { totalMutants = 0, killed = 0, survived = 0, mutationScore = 100 } = parsed.stats;

    return {
      target: filePath,
      totalMutants,
      killed,
      survived: survived || totalMutants - killed,
      mutationScore: `${mutationScore.toFixed(2)}%`,
      vulnerabilities: (parsed.mutants || [])
        .filter((m) => m.status === 'SURVIVED' || m.status === 'survived')
        .map((m) => ({
          line: m.line ?? 0,
          replacement: m.mutator ?? 'Go Mutation Operator',
          description: `Mutation survived at line ${m.line ?? 'unknown'}. The go test suite did not catch this change.`,
        })),
    };
  }

  // JSON but no structured stats — fall back to text
  return parseGoMutestingText(stdout, filePath);
}

/**
 * Mutation testing engine for Go files.
 *
 * Shells out to the `go-mutesting` CLI to generate and evaluate mutants.
 * `go-mutesting` must be installed in the target workspace:
 *   go install github.com/zimmski/go-mutesting/cmd/go-mutesting@latest
 *
 * Note: Line-level scoping and mutator allow/denylists are not supported by
 * go-mutesting's CLI. These `RunOptions` parameters are silently ignored
 * for Go targets.
 */
export class GoEngine extends BaseEngine {
  async run(filePath: string, options?: RunOptions): Promise<MutationResult> {
    const cwd = options?.workDir ?? process.cwd();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // go-mutesting accepts a file or package path as its argument
    if (isVerbose()) {
      log(`GoEngine: go-mutesting "${filePath}"`);
    }

    let stdout: string;
    let stderr: string;

    try {
      const result = await runShell('go-mutesting', [filePath], { cwd, timeoutMs });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: unknown) {
      if (error instanceof ExecFailureError) {
        // ENOENT → go-mutesting not installed
        if (error.code === 'ENOENT') {
          throw new Error(
            'go-mutesting is not installed. Install it with:\n' +
              '  go install github.com/zimmski/go-mutesting/cmd/go-mutesting@latest',
          );
        }

        // Timeout
        if (error.code === 'TIMEOUT') {
          throw new Error(
            `go-mutesting timed out after ${timeoutMs}ms. Increase timeoutMs or narrow the target file.`,
          );
        }

        // Signal-based crash (not an expected survivors exit)
        if (error.signal && error.exit === null) {
          throw new Error(
            `go-mutesting crashed (signal ${error.signal}): ${error.stderr || error.message}`,
          );
        }

        // Non-zero exit: go-mutesting exits non-zero when mutants survive.
        // Parse stdout from the error's captured output.
        stdout = error.stdout;
        stderr = error.stderr;

        if (!stdout) {
          throw new Error(
            `go-mutesting failed (exit ${error.exit}) with no parseable output. stderr: ${error.stderr?.slice(0, 500)}`,
          );
        }
      } else if (error instanceof Error) {
        throw new Error(`go-mutesting execution failed: ${error.message}`);
      } else {
        throw new Error(`go-mutesting execution failed: ${String(error)}`);
      }
    }

    if (isVerbose() && stderr) {
      log(`go-mutesting stderr: ${stderr.slice(0, 500)}`);
    }

    return parseGoMutestingOutput(stdout, filePath);
  }
}
