import { ExecFailureError } from '../utils/exec-error.js';
import { MutationToolStartupError } from '../utils/exec-classify.js';
import type { ExecutionSession } from '../utils/execution.js';

/**
 * Describes a single surviving mutant — a logical fault the test suite failed to catch.
 */
export interface Vulnerability {
  /** 1-based line number where the surviving mutant was injected */
  line: number;
  /** Name/type of the mutation operator applied (e.g., "ConditionalExpression") */
  mutator: string;
  /**
   * Whether a test ran this mutant and failed to kill it (`'survived'`) or no
   * test reached it at all (`'noCoverage'`).
   *
   * This drives the survivors/noCoverage split in the payload, the `survived`
   * arithmetic in suppression, and per-line reporting. It used to be recovered
   * downstream by regex-matching {@link description} for "no test reached",
   * so rewording a sentence silently reclassified every no-coverage mutant.
   * Engines that cannot distinguish the two (cosmic-ray, cargo-mutants,
   * Infection all report survivors only) set `'survived'`.
   *
   * Optional so that a `Vulnerability` built by an older consumer still parses;
   * `format.ts` falls back to the description heuristic when it is absent.
   */
  kind?: 'survived' | 'noCoverage';
  /** Human-readable explanation of why this mutant is a problem */
  description: string;
  /** Original source span the mutant replaced (best-effort; may be absent). */
  original?: string;
  /** Replacement code or mutation description (best-effort; may be absent). */
  mutated?: string;
}

/**
 * Structured result of a mutation testing run against a single file.
 */
export interface MutationResult {
  /** Path to the file that was mutated */
  target: string;
  /** Total number of mutants generated */
  totalMutants: number;
  /** Mutants killed by the test suite */
  killed: number;
  /** Mutants that survived (tests did NOT catch them) */
  survived: number;
  /** Formatted mutation score, e.g. "87.50%" */
  mutationScore: string;
  /** Details of each surviving mutant */
  vulnerabilities: Vulnerability[];
  /**
   * Optional human-readable note about scoping decisions for this run (e.g.
   * "no changed lines", or "diff scoping unsupported for this language;
   * whole file mutated"). Surfaced in the formatted output when present.
   */
  scopeNote?: string;
  /**
   * Optional warning that the run's own results may be unreliable — a
   * misconfiguration in the audited project that makes the underlying tool
   * misreport, rather than anything about the code under test. Surfaced
   * alongside `scopeNote`. See `WARNING_FIDELITY_NOTE` in the PHP engine.
   */
  fidelityNote?: string;
  /**
   * How much of the target file this run actually enumerated mutants for.
   *
   * WHY this is a STRUCTURAL field: `hasNoMutableLogic` (format.ts) used to
   * decide "this file has no testable logic" from `totalMutants === 0 &&
   * !scopeNote` — i.e. from the ABSENCE of a free-text sentence. Every batched
   * command-runner run sets a `scopeNote` ("Completed N bounded mutation
   * batches."), and the TypeScript engine batches any file over 120 lines by
   * default, so a genuinely-no-mutable-logic file scored a bogus "100.00%"
   * instead of "n/a" purely because prose happened to be present.
   *
   * Semantics — this describes the REQUESTED scope, not how much of it
   * completed:
   *  - `'whole-file'` — mutants were enumerated across the entire file, so a
   *    `totalMutants === 0` IS evidence that the file has no mutable logic.
   *  - `'scoped'` — the run was deliberately restricted to `lineScope` /
   *    `lineRanges`, so a `totalMutants === 0` only means "nothing mutable in
   *    the requested range".
   *  - `undefined` — the engine never enumerated mutants (e.g. a dry-run-only
   *    run). Consumers must NOT infer "no mutable logic" from a zero here.
   *
   * A batched whole-file run is `'whole-file'` even though each individual
   * batch is line-scoped, and consumers must additionally honour
   * {@link MutationResult.complete}: a `'whole-file'` run that stopped early
   * (`complete === false`) covered only the batches it finished, so its zero is
   * not conclusive either.
   */
  scopeKind?: 'whole-file' | 'scoped';
  /**
   * Mutants the tool could not score because the mutated code failed before a
   * real pass/fail (cosmic-ray `incompetent`, Stryker compile errors). Excluded
   * from the denominator. A non-zero value with `totalMutants === 0` means the
   * test command never actually ran — see PythonEngine's degenerate-run guard.
   */
  incompetent?: number;
  /** False when a time-budgeted audit returned completed batches only. */
  complete?: boolean;
  /** Number of mutation batches that produced usable reports. */
  batchesCompleted?: number;
  /** Total number of batches planned for the requested scope. */
  batchesPlanned?: number;
  /** Machine-readable reason a partial audit stopped. */
  stoppedReason?: 'time_budget_exhausted';
}

/**
 * Format a mutation score for {@link MutationResult.mutationScore} — always two
 * decimals and a trailing `%`, e.g. `"87.50%"`.
 *
 * WHY this is shared: the `total === 0 → "100.00%"` convention is load-bearing
 * downstream. `format.ts` (`hasNoMutableLogic`) and `gate.ts` both branch on the
 * parsed score, and a score they cannot parse is treated as PASSING. Every
 * engine plus the suppression recompute must therefore agree on the denominator
 * rule and the exact string shape; keeping the formula in one place is what
 * makes that structural rather than a comment.
 *
 * @param killed — mutants the suite caught (the numerator).
 * @param total — scored mutants (the denominator; excludes mutants that never
 *   ran, e.g. `incompetent`/unviable/compile errors).
 */
export function formatMutationScore(killed: number, total: number): string {
  return total > 0 ? `${((killed / total) * 100).toFixed(2)}%` : '100.00%';
}

/**
 * Build the {@link Vulnerability} for a surviving mutant reported by an engine
 * whose tool has no separate "no test reached this line" outcome (Infection,
 * cargo-mutants — all of which report survivors only, hence `kind: 'survived'`).
 *
 * The prose is identical across those engines apart from the language name, and
 * was previously written out at each site; one sentence, three copies.
 *
 * @param line — 1-based line the mutant was injected at (0 when unknown).
 * @param mutator — per-mutant label; must be distinct for two mutations on the
 *   same line, since suppression/verify keys are `keyOf(line, mutator)`.
 * @param language — human-readable language name used in the sentence ("PHP", "Rust").
 * @param extra.mutated — replacement text; set verbatim when not `undefined`
 *   (an empty string is still set, matching the previous per-site behaviour).
 * @param extra.lineLabel — overrides the line as rendered IN THE SENTENCE only;
 *   the structured `line` is untouched. It exists to decouple those two, because
 *   they need different values for a missing location: `line` must stay the 0
 *   sentinel (suppression/verify keys are `keyOf(line, mutator)`, so moving it
 *   would break them), while "line 0" in the prose reads as a real location the
 *   tool never reported. Both cargo-mutants branches therefore pass
 *   `lineLabel: 'unknown'` when the location is missing/unparseable and render
 *   "line unknown". Note this is only for a MISSING line: a `line: 0` the tool
 *   explicitly reports is passed through and still renders "line 0", since that
 *   is the tool stating a line rather than failing to. See engines/rust.ts.
 */
export function survivorVulnerability(
  line: number,
  mutator: string,
  language: string,
  extra?: { mutated?: string; lineLabel?: string | number },
): Vulnerability {
  const vuln: Vulnerability = {
    line,
    mutator,
    kind: 'survived',
    description: `Mutation survived at line ${extra?.lineLabel ?? line}. The ${language} test suite did not catch this change.`,
  };
  if (extra?.mutated !== undefined) vuln.mutated = extra.mutated;
  return vuln;
}

/**
 * Options for tuning a mutation testing run.
 */
export interface RunOptions {
  /** Internal per-audit native/container execution session. */
  executor?: ExecutionSession;

  /**
   * Test runner override detected from the workspace environment.
   * For JS/TS: 'vitest' | 'jest' | 'mocha' | 'jasmine' | 'command'
   * For Python: 'pytest' | 'unittest' | custom command string
   */
  testRunner?: string;

  /**
   * True when {@link testRunner} came from the operator's own configuration
   * (`chaos-mcp.config.json`) rather than from scanning the audited workspace.
   *
   * The Python engine turns `testRunner` into a shell command that cosmic-ray
   * executes once per mutant, and one detection source is the audited project's
   * `pyproject.toml [tool.mutmut] runner` key. Operator-supplied values are
   * trusted; project-supplied ones must be a bare executable name unless
   * explicitly opted in. See `isRepoTestCommandAllowed` in engines/python.ts.
   */
  testRunnerTrusted?: boolean;

  /**
   * Test command used when {@link testRunner} resolves to StrykerJS's generic
   * `command` runner. Chaos-MCP uses this to scope frameworks such as Vitest 3
   * to tests related to the mutation target instead of running the entire
   * project suite once per mutant.
   *
   * **TypeScript/JavaScript engine only.**
   */
  commandRunnerCommand?: string;

  /**
   * Working directory override for sandbox isolation.
   * When provided, the engine runs the mutation tool with this directory
   * as its working directory (cwd for child processes).
   */
  workDir?: string;

  /**
   * Maximum time in milliseconds for the mutation run.
   * Defaults to 300 000 (5 minutes).
   */
  timeoutMs?: number;

  /**
   * Concurrency hint for mutation engines that support parallel execution.
   *
   * **Honored by:**
   *  - StrykerJS — `--concurrency` (auto-detects cores when omitted).
   *  - cargo-mutants — `-j` (Rust). Defaults low (`-j2` on machines with spare
   *    cores, else serial); each job needs its own multi-GB `target/` copy, so
   *    it is deliberately not core-scaled.
   *  - Infection — `--threads` (PHP; falls back to `concurrency` only when the
   *    `phpThreads` field is unset, else `max`).
   *  - cosmic-ray (Python) — ignores it; runs its own (currently serial) distributor.
   *
   * When omitted, each engine uses its own default.
   */
  concurrency?: number;

  /**
   * Optionally constrain mutations to a specific line range (1-based, inclusive).
   *
   * **Supported by:** StrykerJS (via `--mutate` line-range syntax).
   * **Not supported by:** cosmic-ray (Python engine ignores this).
   */
  lineScope?: { start: number; end: number };

  /**
   * Multiple 1-based inclusive line ranges to constrain mutation to (the
   * diff-aware superset of {@link lineScope}). When set, takes precedence over
   * `lineScope`. **StrykerJS only** — emitted as comma-separated `--mutate`
   * patterns. Ignored by cosmic-ray, cargo-mutants.
   */
  lineRanges?: { start: number; end: number }[];

  /**
   * Restrict which Stryker mutator names to use.
   * When set, ONLY these mutators run.
   * **TypeScript engine only.**
   */
  mutatorAllowlist?: string[];

  /**
   * Exclude specific Stryker mutator names.
   * Mutators in this list are skipped even if they would normally apply.
   * **TypeScript engine only.**
   */
  mutatorDenylist?: string[];

  /**
   * If true, run only the dry-run phase (no mutation testing) to validate
   * that the test suite passes before introducing mutants.
   *
   * **Supported by:** StrykerJS (via `--dryRun` / exit after dry-run).
   * **Ignored by:** Other engines.
   */
  dryRun?: boolean;

  /**
   * Output format for the mutation run result.
   *
   * - 'json' (default): structured MutationResult as JSON.
   * - 'text': human-readable summary.
   *
   * Currently all engines return structured MutationResult; this flag
   * controls how the handler formats the final tool response.
   */
  outputFormat?: 'json' | 'text';

  /**
   * Enable incremental mode — reuse results from a previous run to skip
   * unchanged mutants. Speeds up repeat audits of the same file.
   *
   * **Supported by:** StrykerJS (via `--incremental` + `--incrementalFile`).
   * **Ignored by:** Other engines.
   */
  incremental?: boolean;

  /**
   * Absolute host path where this run's incremental state is persisted between
   * audits, supplied by the handler (which knows the workspace root).
   *
   * Required for {@link incremental} to do anything: the sandbox is deleted
   * after every run, so without a home outside it Stryker's incremental file
   * never survives to be reused. See utils/incremental-cache.ts.
   *
   * **TypeScript engine only.**
   */
  incrementalCachePath?: string;

  // NOTE: there is intentionally no `ignorePatterns` here. Sandbox-copy
  // exclusions are handled by `createSandbox`, which receives the patterns
  // straight from the tool arguments. This interface previously declared the
  // field and the handler populated it, but no engine ever read it — a config
  // surface that looked live and was not.

  /**
   * Per-mutant timeout in milliseconds — how long an individual mutant's
   * test run is allowed before being considered a timeout (and killed).
   *
   * **Supported by:** StrykerJS (via `--timeoutMs`).
   * **Ignored by:** cosmic-ray, cargo-mutants.
   *
   * Distinct from {@link timeoutMs} (total run cap). Use this to prevent
   * a single slow mutant from hanging the entire mutation run.
   *
   * Default: StrykerJS default (typically 5000ms per mutant).
   * Example: 10000 for 10 seconds per mutant.
   */
  perMutantTimeoutMs?: number;

  /**
   * Shell command to run in the sandbox BEFORE mutation testing begins.
   * Use this to compile or build the target so the mutation tool has
   * working artifacts.
   *
   * Runs inside the sandbox working directory via `child_process.exec`
   * (shell: true). The sandbox is provisioned and the workspace is in
   * place — this is your chance to run `npm run build`, `npx tsc`,
   * `go build ./...`, `cargo build`, etc.
   *
   * On failure, the tool returns an error before any mutation tools
   * are invoked. The sandbox is always cleaned up.
   *
   * Example: "npm run build"
   */
  prebuildCommand?: string;

  /** Abort signal; when aborted, the mutation subprocess is killed. */
  signal?: AbortSignal;

  /**
   * Optional extra args appended to the Python test-command (cosmic-ray
   * `test-command`). Use a test path (`["tests/unit/test_x.py"]`) or a marker
   * (`["-m","unit"]`) to scope the suite on large projects.
   *
   * **Python (cosmic-ray) only.** Scoping changes which tests can kill a mutant,
   * so it is opt-in (a narrow selection can make mutants survive that a broader
   * run would kill).
   */
  pythonTestSelection?: string[];

  /**
   * Operator-name regexes to exclude from a Python (cosmic-ray) run, applied via
   * `cr-filter-operators` between init and exec. cosmic-ray always enumerates its
   * full operator set and has no line-scoping, so this is the lever for bounding
   * the mutant count (and wall-clock) on large files. Excluded mutants are
   * dropped from the score (a scoped audit).
   *
   * **Python (cosmic-ray) only.**
   */
  pythonExcludeOperators?: string[];

  /**
   * Worker count forwarded to Infection's `--threads` (a positive integer as a
   * string, or "max"). Sourced from the `infection` config section.
   *
   * **PHP (Infection) only.**
   */
  phpThreads?: string;

  /**
   * Extra options forwarded to Infection's PHP test framework via
   * `--test-framework-options` (e.g. "--testsuite=unit").
   *
   * **PHP (Infection) only.**
   */
  phpTestFrameworkOptions?: string;
}

/**
 * Abstract base class for all mutation testing engines.
 * Each engine wraps a language-specific mutation testing tool.
 */
export abstract class BaseEngine {
  /**
   * Run mutation testing against the given file.
   *
   * @param filePath — workspace-relative path to the source file.
   * @param options — optional configuration for the run (test runner, sandbox workDir, timeout, etc.).
   * @returns A structured MutationResult.
   * @throws Error if the underlying tool is not installed or crashes.
   */
  abstract run(filePath: string, options?: RunOptions): Promise<MutationResult>;

  /**
   * Normalise an error caught from `invokeMutationTool` into a recoverable
   * {@link ExecFailureError}, or throw for non-recoverable cases.
   *
   * Shared by engines whose non-ExecFailure handling differs only by the tool
   * name in the wrapped message (cargo-mutants):
   *  - {@link MutationToolStartupError} → rethrown as a plain Error (verbatim).
   *  - any other non-{@link ExecFailureError} → wrapped as `<toolName> execution failed: …`.
   *  - an {@link ExecFailureError} → returned for engine-specific exit-code handling.
   */
  protected toExecFailure(error: unknown, toolName: string): ExecFailureError {
    if (error instanceof MutationToolStartupError) {
      throw new Error(error.message);
    }
    if (!(error instanceof ExecFailureError)) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${toolName} execution failed: ${message}`);
    }
    return error;
  }
}
