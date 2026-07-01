import { ExecFailureError } from '../utils/exec.js';
import { MutationToolStartupError } from '../utils/exec-classify.js';

/**
 * Describes a single surviving mutant — a logical fault the test suite failed to catch.
 */
export interface Vulnerability {
  /** 1-based line number where the surviving mutant was injected */
  line: number;
  /** Name/type of the mutation operator applied (e.g., "ConditionalExpression") */
  mutator: string;
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
   * Mutants the tool could not score because the mutated code failed before a
   * real pass/fail (cosmic-ray `incompetent`, Stryker compile errors). Excluded
   * from the denominator. A non-zero value with `totalMutants === 0` means the
   * test command never actually ran — see PythonEngine's degenerate-run guard.
   */
  incompetent?: number;
}

/**
 * Options for tuning a mutation testing run.
 */
export interface RunOptions {
  /**
   * Test runner override detected from the workspace environment.
   * For JS/TS: 'vitest' | 'jest' | 'mocha' | 'jasmine' | 'command'
   * For Python: 'pytest' | 'unittest' | custom command string
   */
  testRunner?: string;

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
   * Glob patterns for files/directories to exclude from the sandbox copy.
   * Applied in addition to the built-in ALWAYS_EXCLUDE list.
   *
   * Example: ['*.test.ts', 'fixtures/', 'snapshots/']
   */
  ignorePatterns?: string[];

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
