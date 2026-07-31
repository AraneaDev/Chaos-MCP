import type { SupportedProjectType } from '../project-detector.js';

/**
 * The per-engine config section keys. Declared here — the module tree that parses
 * and types those sections — and consumed by `EngineDescriptor.configKey` in
 * engines/registry.ts, so the descriptor cannot name a section this loader does
 * not know about. (It cannot live in registry.ts: the config loader is a leaf that
 * registry's engines already depend on transitively, and importing the other way
 * would close a cycle.)
 */
export type EngineConfigKey = 'stryker' | 'cosmicray' | 'rust' | 'infection';

/**
 * StrykerJS-specific config overrides.
 * These take precedence over the global {@link ChaosConfig} defaults.
 */
export interface StrykerConfig {
  /** Timeout override for StrykerJS runs (ms). */
  timeoutMs?: number;
  /** Concurrency override (number of parallel workers). */
  concurrency?: number;
  /** Mutator names to include (overrides global mutatorAllowlist). */
  mutatorAllowlist?: string[];
  /** Mutator names to exclude (overrides global mutatorDenylist). */
  mutatorDenylist?: string[];
  /** Per-mutant timeout override (ms). */
  perMutantTimeoutMs?: number;
  /** If true, only validate the test suite without mutation testing. */
  dryRun?: boolean;
  /** If true, reuse results from a previous run for unchanged mutants. */
  incremental?: boolean;
  /** Test runner override (e.g. "vitest", "jest", "command"). */
  testRunner?: string;
}

/**
 * cosmic-ray (Python)-specific config overrides.
 */
export interface CosmicRayConfig {
  /** Timeout override for the whole cosmic-ray run (ms). */
  timeoutMs?: number;
  /** Test runner override (e.g. "pytest", "unittest", or a full command). */
  testRunner?: string;
  /**
   * Extra args appended to the Python test-command to scope the suite on large
   * projects (a test path like `["tests/unit/test_x.py"]` or a marker like
   * `["-m","unit"]`). Opt-in: narrowing changes which tests can kill a mutant.
   */
  testSelection?: string[];
  /**
   * Operator-name regexes to exclude (applied via `cr-filter-operators`) to bound
   * the mutant count on large files — cosmic-ray has no operator allowlist or
   * line-scoping. Excluded mutants drop out of the score (a scoped audit).
   */
  excludeOperators?: string[];
}

/**
 * cargo-mutants-specific config overrides.
 */
export interface CargoMutantsConfig {
  /** Timeout override for cargo-mutants runs (ms). */
  timeoutMs?: number;
  /** Parallel job count forwarded to cargo-mutants `-j` (integer 1–64). */
  concurrency?: number;
}

/**
 * Infection (PHP)-specific config overrides.
 */
export interface InfectionConfig {
  /** Timeout override for the whole Infection run (ms). */
  timeoutMs?: number;
  /** Worker count passed to Infection's `--threads` (positive integer, or "max"). */
  threads?: number | 'max';
  /** Extra options forwarded to the PHP test framework (e.g. "--testsuite=unit"). */
  testFrameworkOptions?: string;
}

export interface ContainerConfig {
  /** Native subprocesses, pinned containers, or containers with native fallback. */
  mode?: 'native' | 'container' | 'auto';
  /** OCI-compatible CLI. Docker is the default; Podman is also supported. */
  runtime?: 'docker' | 'podman';
  /** Container network name/mode. Defaults to bridge for project dependency resolution. */
  network?: string;
  /** CPU limit passed to the container runtime. Defaults to a conservative 2. */
  cpus?: number;
  /** Memory limit in MiB. Defaults to 4096. */
  memoryMb?: number;
  /** Maximum processes in one audit container. */
  pidsLimit?: number;
  /** Runtime probe/create/start timeout in milliseconds. */
  startupTimeoutMs?: number;
  /**
   * Size (MiB) of the container's writable /tmp. Defaults to 2048. The root
   * filesystem is read-only, so this is the only scratch space available to the
   * language toolchain (Cargo registry, npm cache, per-mutant working files).
   */
  tmpfsSizeMb?: number;
  /** Per-language image override. Digest-pinned references are recommended. */
  images?: Partial<Record<SupportedProjectType, string>>;
}

/**
 * User-configurable defaults for mutation testing runs.
 * Loaded from a JSON config file at startup and merged with per-call arguments.
 * Tool call arguments always take precedence over config defaults.
 *
 * Engine-specific sections (`stryker`, `cosmicray`, `rust`, `infection`) override
 * their corresponding global defaults. This lets you set a short global timeout
 * while giving Rust builds more time, or tune Stryker concurrency independently.
 */
export interface ChaosConfig {
  /** Default timeout in milliseconds for all mutation runs. */
  defaultTimeoutMs?: number;

  /** Default cap on files audited by triage_test_coverage (integer >= 1; default 25). */
  defaultMaxFiles?: number;

  /** Default cap on survivor/no-coverage groups returned by audit_code_resilience (integer >= 1; default 10). */
  defaultMaxSurvivors?: number;

  /** Default number of files audited in parallel by triage_test_coverage (integer 1–64). */
  defaultFileConcurrency?: number;

  /** Default severity floor for audit_code_resilience survivor reporting. */
  defaultSeverityFloor?: 'high' | 'medium' | 'low';

  /** Default test runner override (applied when auto-detection is inconclusive). */
  testRunner?: string;

  /** Default concurrency for mutation engines that support it. */
  concurrency?: number;

  /** Mutator names to include by default (StrykerJS only). */
  mutatorAllowlist?: string[];

  /** Mutator names to exclude by default (StrykerJS only). */
  mutatorDenylist?: string[];

  /** Default per-mutant timeout in milliseconds (StrykerJS only). */
  perMutantTimeoutMs?: number;

  /**
   * Allow an explicit `prebuildCommand` tool argument to run an arbitrary shell
   * command in the sandbox. Disabled by default because the command can reach
   * outside the sandbox (audit Med#10). Auto-detected prebuilds (cargo check)
   * are unaffected by this flag. Can also be enabled via
   * the `CHAOS_MCP_ALLOW_PREBUILD` environment variable.
   */
  allowPrebuild?: boolean;

  /** Path to suppressions file (optional string). */
  suppressionsPath?: string;

  /** TTL for run cache entries in milliseconds (integer > 0). */
  runCacheTtlMs?: number;

  /** Maximum number of run cache entries (integer >= 1). */
  runCacheMax?: number;

  /** StrykerJS-specific overrides (precedence over global defaults). */
  stryker?: StrykerConfig;

  /** cosmic-ray (Python)-specific overrides (precedence over global defaults). */
  cosmicray?: CosmicRayConfig;

  /** cargo-mutants-specific overrides (precedence over global defaults). */
  rust?: CargoMutantsConfig;

  /** Infection (PHP)-specific overrides (precedence over global defaults). */
  infection?: InfectionConfig;

  /** Optional OCI-container execution backend shared by every language engine. */
  container?: ContainerConfig;
}

/**
 * Result of {@link validateConfig}: the parsed config plus the advisory warnings
 * describing everything the parser silently dropped.
 */
export interface ConfigValidation {
  config: ChaosConfig;
  warnings: string[];
  /**
   * Distinguishes the three outcomes callers must treat differently: `'ok'`
   * (the file parsed; `warnings` are advisory), `'not-found'` (no file at the
   * path — benign for the default location, an error for an explicit
   * `--config`), and `'unreadable'` (present but unparseable, always an error).
   * Folding all three into `warnings` made every caller's only signal
   * "warnings.length > 0", so `--validate-config` failed CI on advice.
   */
  status: 'ok' | 'not-found' | 'unreadable';
}
