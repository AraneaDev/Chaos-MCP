import { BaseEngine, RunOptions, MutationResult } from './base.js';
import { invokeMutationTool } from '../utils/exec-classify.js';
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

  for (const rawLine of lines) {
    // Trim before prefix matching so leading whitespace doesn't cause
    // undercounting (audit L8). Real go-mutesting outputs start at column 0,
    // but defensive trimming costs nothing.
    const line = rawLine.trim();
    // Lines look like: "PASS  \"/path/to/file.go:42:1\"" or "FAIL  \"/path/to/file.go:42:1\""
    // Real go-mutesting mutant lines are ALWAYS quoted paths (e.g.
    // `PASS  "/path/to/file.go:42:1"` or `FAIL  "/path/to/file.go:42:1"`).
    // Requiring a `"` after the FAIL/PASS prefix rejects spurious
    // `FAIL  <package-name> [build failed]` lines that appear in baseline
    // `go test` output, preventing them from being miscounted as surviving
    // mutants when the baseline test suite itself failed (audit H2).
    const isFail = line.startsWith('FAIL') && line.includes('"');
    const isPass = line.startsWith('PASS') && line.includes('"');

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
        mutator: 'Go Mutation Operator',
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
    // Coerce defensively: go-mutesting's JSON is external input, so a missing
    // OR non-numeric field must not reach arithmetic / `.toFixed` (which would
    // throw on a string and be reported as an opaque engine failure). The TS
    // and Rust engines already recompute their score from integer counts; this
    // brings Go in line. `num(v, d)` falls back to `d` for any non-number.
    const num = (v: unknown, d: number): number =>
      typeof v === 'number' && !Number.isNaN(v) ? v : d;
    const totalMutants = num(parsed.stats.totalMutants, 0);
    const killed = num(parsed.stats.killed, 0);
    const survived = num(parsed.stats.survived, 0);
    const mutationScore = num(parsed.stats.mutationScore, 100);

    return {
      target: filePath,
      totalMutants,
      killed,
      survived: survived || totalMutants - killed,
      mutationScore: `${mutationScore.toFixed(2)}%`,
      vulnerabilities: parsed.mutants
        .filter((m) => m.status === 'SURVIVED' || m.status === 'survived')
        .map((m) => ({
          line: m.line ?? 0,
          mutator: m.mutator ?? 'Go Mutation Operator',
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
 *
 * Go severity enrichment (GO_MUTATOR_MAP in enrich.ts) activates automatically
 * once go-mutesting emits structured JSON output carrying mutator names. The
 * JSON branch in parseGoMutestingOutput already preserves `m.mutator` verbatim
 * into Vulnerability.mutator. Enabling the structured reporter flag in the CLI
 * invocation is pending confirmation on an environment with go-mutesting installed
 * (spike deferred: go-mutesting not present in this build environment).
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
    // Audit finding H2: track whether we got here via a non-zero exit so
    // we can disambiguate "mutants survived" from a baseline test failure.
    let exitedNonZero = false;
    let failureExit: number | null = null;

    try {
      const result = await invokeMutationTool('go-mutesting', 'go-mutesting', [filePath], {
        cwd,
        timeoutMs,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: unknown) {
      // Startup failures rethrow; non-ExecFailure errors wrap; otherwise we get
      // a typed ExecFailureError back for the go-specific handling below.
      const execErr = this.toExecFailure(error, 'go-mutesting');

      // Non-zero exit: go-mutesting exits 1 when mutants survive AND when
      // baseline `go test ./...` itself fails. If stdout is empty we treat it
      // as a baseline failure (no mutants parsed out), otherwise fall through
      // and parse the captured stdout.
      stdout = execErr.stdout;
      stderr = execErr.stderr;
      exitedNonZero = true;
      failureExit = execErr.exit;

      if (!stdout) {
        throw new Error(
          `go-mutesting failed (exit ${execErr.exit}) with no parseable output. ` +
            `This usually means the baseline test suite itself failed \u2014 run \`go test ./...\` and fix those first. ` +
            `stderr: ${execErr.stderr?.slice(0, 500) ?? ''}`,
        );
      }
    }

    if (isVerbose() && stderr) {
      log(`go-mutesting stderr: ${stderr.slice(0, 500)}`);
    }

    const parsed = parseGoMutestingOutput(stdout, filePath);

    // H2: a non-zero exit combined with zero parsed mutants indicates a
    // baseline failure (no PASS/FAIL lines were produced -- go-mutesting
    // never reached the mutation phase). Without this guard the engine
    // would silently report a fake 100% mutation score.
    if (exitedNonZero && parsed.totalMutants === 0) {
      throw new Error(
        `go-mutesting baseline failure (exit ${failureExit}, no mutants parsed). ` +
          'The mutation run did not emit any PASS/FAIL lines despite a non-zero exit; ' +
          'this indicates the baseline test suite is broken. Run `go test ./...` first. ' +
          `stderr: ${stderr?.slice(0, 500) ?? ''}`,
      );
    }

    return parsed;
  }
}
