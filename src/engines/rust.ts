import { cpus } from 'node:os';
import { BaseEngine, RunOptions, MutationResult, Vulnerability } from './base.js';
import { invokeMutationTool } from '../utils/exec-classify.js';
import { log, isVerbose } from '../utils/logger.js';
import { DEFAULT_TIMEOUT_MS } from '../utils/constants.js';

/**
 * Resolve the cargo-mutants `-j` job count. Explicit `concurrency` (from a tool
 * arg or `rust.concurrency` config, already validated to 1–64) is honored as-is.
 * Otherwise a deliberately LOW default: `2` when the machine has spare cores
 * (`cpuCount >= 3`), else `1` (serial). cargo-mutants' own docs warn against
 * core-scaling `-j` for Rust — its build/test tooling is already parallel, and
 * each job needs its own multi-GB `target/` copy — so the default stays small.
 * A result of `1` means "serial"; the engine omits `-j` entirely in that case.
 */
export function resolveCargoJobs(concurrency: number | undefined, cpuCount: number): number {
  if (typeof concurrency === 'number' && Number.isInteger(concurrency) && concurrency >= 1) {
    return concurrency;
  }
  return cpuCount >= 3 ? 2 : 1;
}

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

    // Extract line number and trailing description from
    // "MISSED   src/file.rs:42:9: replace add -> sub with ..." (the description
    // separator may be a colon or spaces). cargo-mutants sometimes drops the
    // column (e.g. "MISSED src/file.rs:42: replace ..."), so accept either:
    // ":<line>:<col>:" or a bare ":<line>:" / ":<line>" at end-of-line (audit L7).
    const locMatch = trimmed.match(/:(\d+)(?::\d+)?:?\s*(.*)$/);
    const mutantLine = locMatch ? parseInt(locMatch[1], 10) : 0;
    const desc = locMatch && locMatch[2] ? locMatch[2].trim() : '';

    const vuln: Vulnerability = {
      line: mutantLine,
      // Derive a per-mutant label from the description, mirroring the JSON
      // branch below (H2/I4): two different mutations on the same line must
      // get distinct `mutator` values, or suppression/verify keys (which are
      // `keyOf(line, mutator)`) collapse them into one entry.
      mutator: desc || 'Rust Mutation Operator',
      description: `Mutation survived at line ${mutantLine}. The Rust test suite did not catch this change.`,
    };
    if (desc) vuln.mutated = desc;
    vulnerabilities.push(vuln);
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
        vulnerabilities: parsed.mutants
          .filter(
            (m) =>
              !m.caught &&
              (m.status === 'MISSED' || m.status === 'missed' || m.status === 'UNCAUGHT'),
          )
          .map((m) => {
            const vuln: Vulnerability = {
              line: m.line ?? 0,
              // `||` (not `??`) so empty-string descriptions fall back to the default label.
              mutator: m.description || 'Rust Mutation Operator',
              description: `Mutation survived at line ${m.line ?? 'unknown'}. The Rust test suite did not catch this change.`,
            };
            if (m.description) vuln.mutated = m.description;
            return vuln;
          }),
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

    // cargo-mutants `--file` is a glob matched against the source path. Pass the
    // full workspace-relative path (Med#9) so the run is scoped to exactly this
    // file — a bare basename would also match same-named files in other dirs.
    const jobs = resolveCargoJobs(options?.concurrency, cpus().length);
    const args = ['mutants', '--file', filePath];
    if (jobs > 1) args.push('-j', String(jobs));

    if (isVerbose()) {
      log(`RustEngine: cargo mutants --file "${filePath}"${jobs > 1 ? ` -j ${jobs}` : ''}`);
    }

    let stdout: string;
    let stderr: string;

    try {
      const result = await invokeMutationTool('cargo-mutants', 'cargo', args, {
        cwd,
        timeoutMs,
        signal: options?.signal,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: unknown) {
      // Startup failures rethrow; non-ExecFailure errors wrap; otherwise we get
      // a typed ExecFailureError back for the rust-specific handling below.
      const execErr = this.toExecFailure(error, 'cargo-mutants');

      // Non-zero exit: cargo-mutants exits non-zero when mutants survive OR
      // when the baseline `cargo test` itself fails. If stdout is empty we
      // treat it as a baseline failure (no mutants parsed out); otherwise
      // fall through and parse the captured stdout.
      stdout = execErr.stdout;
      stderr = execErr.stderr;

      if (!stdout) {
        throw new Error(
          `cargo-mutants failed (exit ${execErr.exit}) with no parseable output. ` +
            `This usually means the baseline test suite itself failed \u2014 run \`cargo test\` and fix those first. ` +
            `stderr: ${execErr.stderr?.slice(0, 500) ?? ''}`,
        );
      }
    }

    if (isVerbose() && stderr) {
      log(`cargo-mutants stderr: ${stderr.slice(0, 500)}`);
    }

    return parseCargoMutantsOutput(stdout, filePath);
  }
}
