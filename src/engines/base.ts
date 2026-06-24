/**
 * Describes a single surviving mutant — a logical fault the test suite failed to catch.
 */
export interface Vulnerability {
  /** 1-based line number where the surviving mutant was injected */
  line: number;
  /** Name/type of the mutation operator applied (e.g., "ConditionalExpression") */
  replacement: string;
  /** Human-readable explanation of why this mutant is a problem */
  description: string;
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
   * **Supported by:** StrykerJS (via `--concurrency`).
   * **Ignored by:** Mutmut, go-mutesting, cargo-mutants (which manage their
   * own parallelism or run serially).
   *
   * When omitted, the engine uses its own default (StrykerJS auto-detects
   * CPU core count).
   */
  concurrency?: number;

  /**
   * Optionally constrain mutations to a specific line range (1-based, inclusive).
   *
   * **Supported by:** StrykerJS (via `--mutate` line-range syntax).
   * **Not supported by:** Mutmut (Python engine ignores this).
   */
  lineScope?: { start: number; end: number };

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
}
