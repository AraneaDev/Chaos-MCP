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
 * Authoritative per-outcome counts extracted from cargo-mutants' final summary
 * line, e.g. "47 mutants tested in 30s: 4 missed, 42 caught, 1 unviable".
 */
interface CargoSummary {
  caught: number;
  missed: number;
  unviable: number;
  timeout: number;
}

/**
 * Extract cargo-mutants' summary counts from its final report line.
 *
 * WHY this is load-bearing: by default cargo-mutants (v27) prints ONLY the
 * MISSED (and, with extra flags, TIMEOUT/UNVIABLE) result lines — CAUGHT mutants
 * are silent. So counting printed lines alone under-reports both `total` and
 * `killed`, yielding a bogus 0% score on a suite that actually kills most
 * mutants. The summary line is the ground truth for the totals; the per-line
 * MISSED entries remain the source of survivor detail.
 *
 * The line looks like:
 *   "47 mutants tested in 30s: 4 missed, 42 caught, 1 unviable"
 *   "13 mutants tested in 14s: 2 missed, 11 caught"
 * (order/set of categories varies; zero-count categories are omitted).
 * Returns null when no summary line is present (e.g. the synthetic fixtures
 * that predate v27's output format), so callers fall back to line-counting.
 */
function parseCargoSummary(stdout: string): CargoSummary | null {
  const lines = stdout.split('\n');
  // Scan from the end: the summary is the last such line cargo-mutants prints.
  for (let i = lines.length - 1; i >= 0; i--) {
    // Match "<n> mutants tested ... : <tail>". "Found N mutants to test" says
    // "to test", not "tested", so it is correctly excluded.
    const head = lines[i].match(/\bmutants?\s+tested\b[^:]*:(.*)$/i);
    if (!head) continue;

    const summary: CargoSummary = { caught: 0, missed: 0, unviable: 0, timeout: 0 };
    let matched = false;
    const re = /(\d+)\s+([a-zA-Z]+)/g;
    let g: RegExpExecArray | null;
    while ((g = re.exec(head[1])) !== null) {
      const n = parseInt(g[1], 10);
      const label = g[2].toLowerCase();
      if (label.startsWith('caught')) {
        summary.caught += n;
        matched = true;
      } else if (label.startsWith('miss')) {
        summary.missed += n;
        matched = true;
      } else if (label.startsWith('unviable')) {
        summary.unviable += n;
        matched = true;
      } else if (label.startsWith('timeout')) {
        summary.timeout += n;
        matched = true;
      }
    }
    if (matched) return summary;
  }
  return null;
}

/**
 * Strip cargo-mutants' trailing " in <build> build + <test> test" timing suffix
 * from a mutant description. WHY: the timing varies run-to-run ("in 0s build +
 * 0s test" vs "in 8s build + 2s test"), so leaving it in the `mutator` label
 * would give the SAME logical mutant a different suppression/verify key on every
 * run, silently breaking baseline re-tests. Only the trailing timing clause is
 * removed; an earlier "... in <fn_name>" in the mutation text is preserved.
 */
function stripCargoTiming(desc: string): string {
  return desc.replace(/\s+in\s+\S+\s+build\s+\+\s+\S+\s+test$/, '').trim();
}

/**
 * Parse cargo-mutants text output into a MutationResult.
 *
 * cargo-mutants stdout contains survivor lines like:
 *   "MISSED   src/main.rs:42:9: replace > with >= in fn foo in 0s build + 0s test"
 *   "UNCAUGHT src/main.rs:88:5: ..."
 * plus a final summary line ("N mutants tested in Xs: A missed, B caught, ...").
 *
 * Cargo-mutants uses the terms MISSED (survived) and CAUGHT (killed) — but only
 * MISSED lines are printed by default (see parseCargoSummary), so the summary
 * line is preferred for the totals when present.
 */
function parseCargoMutantsText(stdout: string, filePath: string): MutationResult {
  const lines = stdout.split('\n').filter((l) => l.trim());
  let lineTotal = 0;
  let lineKilled = 0;
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

    lineTotal++;
    // Audit finding H3: TIMEOUT mutants are tests that hung past the per-mutant
    // timeout. They DID detect the mutant (the test suite hung trying to assert
    // against it), so count them as caught, not skipped.
    if (isCaught || isTimeout) {
      lineKilled++;
      continue;
    }

    // Extract line number and trailing description from
    // "MISSED   src/file.rs:42:9: replace add -> sub with ..." (the description
    // separator may be a colon or spaces). cargo-mutants sometimes drops the
    // column (e.g. "MISSED src/file.rs:42: replace ..."), so accept either:
    // ":<line>:<col>:" or a bare ":<line>:" / ":<line>" at end-of-line (audit L7).
    const locMatch = trimmed.match(/:(\d+)(?::\d+)?:?\s*(.*)$/);
    const mutantLine = locMatch ? parseInt(locMatch[1], 10) : 0;
    const desc = locMatch && locMatch[2] ? stripCargoTiming(locMatch[2].trim()) : '';

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

  // Prefer the authoritative summary line over line counts — cargo-mutants only
  // prints MISSED lines by default, so line-counting alone reports a false 0%.
  // Unviable mutants (did not compile) are excluded from the denominator, since
  // they were never actually exercised by a test.
  const summary = parseCargoSummary(stdout);
  let total: number;
  let killed: number;
  let survived: number;
  // Unviable mutants (did not compile) are excluded from the denominator above;
  // surface them via the shared `incompetent` field so callers can see how many
  // mutants were skipped (base.ts MutationResult contract).
  let incompetent = 0;
  if (summary) {
    killed = summary.caught + summary.timeout;
    survived = summary.missed;
    total = killed + survived;
    incompetent = summary.unviable;
  } else {
    total = lineTotal;
    killed = lineKilled;
    survived = total - killed;
  }

  const score = total > 0 ? ((killed / total) * 100).toFixed(2) : '100.00';

  return {
    target: filePath,
    totalMutants: total,
    killed,
    survived,
    mutationScore: `${score}%`,
    vulnerabilities,
    ...(incompetent > 0 ? { incompetent } : {}),
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
