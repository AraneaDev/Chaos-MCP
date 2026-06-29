import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ─── Per-engine config sections ──────────────────────────────────────────────

/** Valid top-level config keys known to ChaosConfig. */
const KNOWN_KEYS = new Set([
  'defaultTimeoutMs',
  'defaultMaxFiles',
  'defaultMaxSurvivors',
  'defaultSeverityFloor',
  'defaultFileConcurrency',
  'testRunner',
  'concurrency',
  'mutatorAllowlist',
  'mutatorDenylist',
  'perMutantTimeoutMs',
  'allowPrebuild',
  'suppressionsPath',
  'runCacheTtlMs',
  'runCacheMax',
  'stryker',
  'cosmicray',
  'go',
  'rust',
]);

/** Valid keys within a StrykerConfig section. */
const KNOWN_STRYKER_KEYS = new Set([
  'timeoutMs',
  'concurrency',
  'mutatorAllowlist',
  'mutatorDenylist',
  'perMutantTimeoutMs',
  'dryRun',
  'incremental',
  'testRunner',
]);

/** Valid keys within a CosmicRayConfig section. */
const KNOWN_COSMICRAY_KEYS = new Set([
  'timeoutMs',
  'testRunner',
  'testSelection',
  'excludeOperators',
]);

/** Valid keys within a GoMutestingConfig section. */
const KNOWN_GO_KEYS = new Set(['timeoutMs']);

/** Valid keys within a CargoMutantsConfig section. */
const KNOWN_RUST_KEYS = new Set(['timeoutMs']);

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
 * go-mutesting-specific config overrides.
 */
export interface GoMutestingConfig {
  /** Timeout override for go-mutesting runs (ms). */
  timeoutMs?: number;
}

/**
 * cargo-mutants-specific config overrides.
 */
export interface CargoMutantsConfig {
  /** Timeout override for cargo-mutants runs (ms). */
  timeoutMs?: number;
}

/**
 * User-configurable defaults for mutation testing runs.
 * Loaded from a JSON config file at startup and merged with per-call arguments.
 * Tool call arguments always take precedence over config defaults.
 *
 * Engine-specific sections (`stryker`, `cosmicray`, `go`, `rust`) override their
 * corresponding global defaults. This lets you set a short global timeout while
 * giving Rust/Go builds more time, or tune Stryker concurrency independently.
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
   * outside the sandbox (audit Med#10). Auto-detected prebuilds (go mod
   * download, cargo check) are unaffected by this flag. Can also be enabled via
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

  /** go-mutesting-specific overrides (precedence over global defaults). */
  go?: GoMutestingConfig;

  /** cargo-mutants-specific overrides (precedence over global defaults). */
  rust?: CargoMutantsConfig;
}

/** Default config file name looked up from the working directory. */
const DEFAULT_CONFIG_FILE = 'chaos-mcp.config.json';

// ─── Engine-specific config parsers ──────────────────────────────────────────

function parseStrykerConfig(raw: unknown): StrykerConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  const result: StrykerConfig = {};
  let hasAny = false;

  if (typeof s.timeoutMs === 'number' && s.timeoutMs > 0) {
    result.timeoutMs = s.timeoutMs;
    hasAny = true;
  }
  if (
    typeof s.concurrency === 'number' &&
    Number.isInteger(s.concurrency) &&
    s.concurrency >= 1 &&
    s.concurrency <= 64
  ) {
    result.concurrency = s.concurrency;
    hasAny = true;
  }
  if (Array.isArray(s.mutatorAllowlist)) {
    result.mutatorAllowlist = s.mutatorAllowlist.filter((v: unknown) => typeof v === 'string');
    if (result.mutatorAllowlist.length > 0) hasAny = true;
  }
  if (Array.isArray(s.mutatorDenylist)) {
    result.mutatorDenylist = s.mutatorDenylist.filter((v: unknown) => typeof v === 'string');
    if (result.mutatorDenylist.length > 0) hasAny = true;
  }
  if (typeof s.perMutantTimeoutMs === 'number' && s.perMutantTimeoutMs > 0) {
    result.perMutantTimeoutMs = s.perMutantTimeoutMs;
    hasAny = true;
  }
  if (typeof s.dryRun === 'boolean') {
    result.dryRun = s.dryRun;
    hasAny = true;
  }
  if (typeof s.incremental === 'boolean') {
    result.incremental = s.incremental;
    hasAny = true;
  }
  if (typeof s.testRunner === 'string' && s.testRunner.length > 0) {
    result.testRunner = s.testRunner;
    hasAny = true;
  }

  return hasAny ? result : undefined;
}

function parseCosmicRayConfig(raw: unknown): CosmicRayConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  const result: CosmicRayConfig = {};
  let hasAny = false;

  if (typeof s.timeoutMs === 'number' && s.timeoutMs > 0) {
    result.timeoutMs = s.timeoutMs;
    hasAny = true;
  }
  if (typeof s.testRunner === 'string' && s.testRunner.length > 0) {
    result.testRunner = s.testRunner;
    hasAny = true;
  }
  const stringArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) && v.length > 0 && v.every((e) => typeof e === 'string' && e.length > 0)
      ? (v as string[])
      : undefined;
  const testSelection = stringArray(s.testSelection);
  if (testSelection) {
    result.testSelection = testSelection;
    hasAny = true;
  }
  const excludeOperators = stringArray(s.excludeOperators);
  if (excludeOperators) {
    result.excludeOperators = excludeOperators;
    hasAny = true;
  }

  return hasAny ? result : undefined;
}

/**
 * Parse a config section that supports only a positive `timeoutMs` field.
 * Shared by the structurally-identical go-mutesting and cargo-mutants sections.
 * Returns `undefined` when the section is absent, malformed, or has no valid field.
 */
function parseTimeoutOnlyConfig(raw: unknown): { timeoutMs?: number } | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  const result: { timeoutMs?: number } = {};
  let hasAny = false;

  if (typeof s.timeoutMs === 'number' && s.timeoutMs > 0) {
    result.timeoutMs = s.timeoutMs;
    hasAny = true;
  }

  return hasAny ? result : undefined;
}

/**
 * Per-engine config sections, in one place. Replaces the parallel per-section
 * dispatch previously repeated in {@link buildConfig} and {@link validateConfig}.
 * `key` mirrors `EngineDescriptor.configKey` in engines/registry.ts. Adding a
 * language adds one entry here.
 */
const ENGINE_CONFIG_SECTIONS: {
  key: 'stryker' | 'cosmicray' | 'go' | 'rust';
  knownKeys: Set<string>;
  parse: (raw: unknown) => object | undefined;
}[] = [
  { key: 'stryker', knownKeys: KNOWN_STRYKER_KEYS, parse: parseStrykerConfig },
  { key: 'cosmicray', knownKeys: KNOWN_COSMICRAY_KEYS, parse: parseCosmicRayConfig },
  { key: 'go', knownKeys: KNOWN_GO_KEYS, parse: parseTimeoutOnlyConfig },
  { key: 'rust', knownKeys: KNOWN_RUST_KEYS, parse: parseTimeoutOnlyConfig },
];

/**
 * Read and parse a JSON config file, returning the raw object.
 * Throws on I/O errors, invalid JSON, or non-object results.
 * @internal
 */
function readConfigRaw(configPath?: string): Record<string, unknown> | null {
  const targetPath = configPath ? resolve(configPath) : resolve(DEFAULT_CONFIG_FILE);

  if (!existsSync(targetPath)) {
    return null;
  }

  const text = readFileSync(targetPath, 'utf-8');
  const parsed = JSON.parse(text) as unknown;

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Config file must contain a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

/**
 * Build a ChaosConfig from a raw parsed config object.
 * @internal
 */
function buildConfig(raw: Record<string, unknown>): ChaosConfig {
  const result: ChaosConfig = {};

  if (typeof raw.defaultTimeoutMs === 'number' && raw.defaultTimeoutMs > 0) {
    result.defaultTimeoutMs = raw.defaultTimeoutMs;
  }
  if (
    typeof raw.defaultMaxFiles === 'number' &&
    Number.isInteger(raw.defaultMaxFiles) &&
    raw.defaultMaxFiles >= 1
  ) {
    result.defaultMaxFiles = raw.defaultMaxFiles;
  }
  if (
    typeof raw.defaultMaxSurvivors === 'number' &&
    Number.isInteger(raw.defaultMaxSurvivors) &&
    raw.defaultMaxSurvivors >= 1
  ) {
    result.defaultMaxSurvivors = raw.defaultMaxSurvivors;
  }
  if (
    typeof raw.defaultFileConcurrency === 'number' &&
    Number.isInteger(raw.defaultFileConcurrency) &&
    raw.defaultFileConcurrency >= 1 &&
    raw.defaultFileConcurrency <= 64
  ) {
    result.defaultFileConcurrency = raw.defaultFileConcurrency;
  }
  if (typeof raw.suppressionsPath === 'string' && raw.suppressionsPath.trim().length > 0) {
    result.suppressionsPath = raw.suppressionsPath;
  }
  if (
    typeof raw.runCacheTtlMs === 'number' &&
    Number.isInteger(raw.runCacheTtlMs) &&
    raw.runCacheTtlMs > 0
  ) {
    result.runCacheTtlMs = raw.runCacheTtlMs;
  }
  if (
    typeof raw.runCacheMax === 'number' &&
    Number.isInteger(raw.runCacheMax) &&
    raw.runCacheMax >= 1
  ) {
    result.runCacheMax = raw.runCacheMax;
  }
  if (
    raw.defaultSeverityFloor === 'high' ||
    raw.defaultSeverityFloor === 'medium' ||
    raw.defaultSeverityFloor === 'low'
  ) {
    result.defaultSeverityFloor = raw.defaultSeverityFloor;
  }
  if (typeof raw.testRunner === 'string' && raw.testRunner.length > 0) {
    result.testRunner = raw.testRunner;
  }
  if (
    typeof raw.concurrency === 'number' &&
    Number.isInteger(raw.concurrency) &&
    raw.concurrency >= 1 &&
    raw.concurrency <= 64
  ) {
    result.concurrency = raw.concurrency;
  }
  if (Array.isArray(raw.mutatorAllowlist)) {
    result.mutatorAllowlist = raw.mutatorAllowlist.filter(
      (v: unknown) => typeof v === 'string',
    ) as string[];
  }
  if (Array.isArray(raw.mutatorDenylist)) {
    result.mutatorDenylist = raw.mutatorDenylist.filter(
      (v: unknown) => typeof v === 'string',
    ) as string[];
  }
  if (typeof raw.perMutantTimeoutMs === 'number' && raw.perMutantTimeoutMs > 0) {
    result.perMutantTimeoutMs = raw.perMutantTimeoutMs;
  }
  if (typeof raw.allowPrebuild === 'boolean') {
    result.allowPrebuild = raw.allowPrebuild;
  }

  for (const section of ENGINE_CONFIG_SECTIONS) {
    // Each parser returns its own section shape; the table erases the precise
    // per-key linkage, so assign through an index signature. Behaviour is
    // identical to the previous explicit per-section assignments (the key is
    // always set, to the parsed section or undefined).
    (result as Record<string, unknown>)[section.key] = section.parse(raw[section.key]);
  }

  return result;
}

/**
 * Validate a config file and return warnings for silently-ignored fields.
 *
 * Unlike {@link loadConfig} which silently drops unknown/invalid values,
 * this function inspects the raw JSON and reports:
 *   - Unknown top-level keys
 *   - Engine sections that exist but contain no valid fields (all rejected)
 *   - Unknown keys within engine sections
 *   - Fields with wrong types (e.g. string where number expected)
 *
 * @param configPath - Optional explicit path to a config file.
 * @returns Validated ChaosConfig and an array of warning strings.
 */
export function validateConfig(configPath?: string): { config: ChaosConfig; warnings: string[] } {
  const targetPath = configPath ? resolve(configPath) : resolve(DEFAULT_CONFIG_FILE);
  const warnings: string[] = [];

  let raw: Record<string, unknown>;
  try {
    const parsed = readConfigRaw(configPath);
    if (parsed === null) {
      return { config: {}, warnings: [`Config file not found: ${targetPath}`] };
    }
    raw = parsed;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { config: {}, warnings: [`Failed to parse config file "${targetPath}": ${message}`] };
  }

  // ── Check unknown top-level keys ──
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      warnings.push(`Unknown config key: "${key}" — will be ignored.`);
    }
  }

  // ── Validate engine sections ──
  for (const section of ENGINE_CONFIG_SECTIONS) {
    validateEngineSection(raw[section.key], section.key, section.knownKeys, warnings);
  }

  // ── Validate global fields ──
  if ('defaultTimeoutMs' in raw && typeof raw.defaultTimeoutMs !== 'number') {
    warnings.push(`defaultTimeoutMs must be a number, got ${typeof raw.defaultTimeoutMs}.`);
  }
  if ('testRunner' in raw && typeof raw.testRunner !== 'string') {
    warnings.push(`testRunner must be a string, got ${typeof raw.testRunner}.`);
  }
  if (
    'concurrency' in raw &&
    (typeof raw.concurrency !== 'number' ||
      !Number.isInteger(raw.concurrency) ||
      raw.concurrency < 1 ||
      raw.concurrency > 64)
  ) {
    warnings.push(
      `concurrency must be an integer between 1 and 64, got ${typeof raw.concurrency === 'number' ? raw.concurrency : typeof raw.concurrency}.`,
    );
  }
  if ('perMutantTimeoutMs' in raw && typeof raw.perMutantTimeoutMs !== 'number') {
    warnings.push(`perMutantTimeoutMs must be a number, got ${typeof raw.perMutantTimeoutMs}.`);
  }
  if ('allowPrebuild' in raw && typeof raw.allowPrebuild !== 'boolean') {
    warnings.push(`allowPrebuild must be a boolean, got ${typeof raw.allowPrebuild}.`);
  }
  if (
    'defaultMaxSurvivors' in raw &&
    (typeof raw.defaultMaxSurvivors !== 'number' ||
      !Number.isInteger(raw.defaultMaxSurvivors) ||
      raw.defaultMaxSurvivors < 1)
  ) {
    warnings.push(
      `defaultMaxSurvivors must be an integer >= 1, got ${typeof raw.defaultMaxSurvivors === 'number' ? raw.defaultMaxSurvivors : typeof raw.defaultMaxSurvivors}.`,
    );
  }
  if (
    'defaultSeverityFloor' in raw &&
    raw.defaultSeverityFloor !== 'high' &&
    raw.defaultSeverityFloor !== 'medium' &&
    raw.defaultSeverityFloor !== 'low'
  ) {
    warnings.push(
      `defaultSeverityFloor must be one of "high"|"medium"|"low", got ${JSON.stringify(raw.defaultSeverityFloor)}.`,
    );
  }
  if (
    'defaultFileConcurrency' in raw &&
    (typeof raw.defaultFileConcurrency !== 'number' ||
      !Number.isInteger(raw.defaultFileConcurrency) ||
      raw.defaultFileConcurrency < 1 ||
      raw.defaultFileConcurrency > 64)
  ) {
    warnings.push(
      `defaultFileConcurrency must be an integer between 1 and 64, got ${typeof raw.defaultFileConcurrency === 'number' ? raw.defaultFileConcurrency : typeof raw.defaultFileConcurrency}.`,
    );
  }
  if (
    'suppressionsPath' in raw &&
    (typeof raw.suppressionsPath !== 'string' || raw.suppressionsPath.trim().length === 0)
  ) {
    warnings.push('suppressionsPath must be a non-empty string.');
  }
  if (
    'runCacheTtlMs' in raw &&
    (typeof raw.runCacheTtlMs !== 'number' ||
      !Number.isInteger(raw.runCacheTtlMs) ||
      raw.runCacheTtlMs <= 0)
  ) {
    warnings.push(
      `runCacheTtlMs must be an integer > 0, got ${typeof raw.runCacheTtlMs === 'number' ? raw.runCacheTtlMs : typeof raw.runCacheTtlMs}.`,
    );
  }
  if (
    'runCacheMax' in raw &&
    (typeof raw.runCacheMax !== 'number' ||
      !Number.isInteger(raw.runCacheMax) ||
      raw.runCacheMax < 1)
  ) {
    warnings.push(
      `runCacheMax must be an integer >= 1, got ${typeof raw.runCacheMax === 'number' ? raw.runCacheMax : typeof raw.runCacheMax}.`,
    );
  }

  // Build the config from the already-parsed raw object (no double-read)
  const config = buildConfig(raw);

  return { config, warnings };
}

/**
 * Validate an engine-specific config section, adding warnings for issues.
 * @internal
 */
function validateEngineSection(
  raw: unknown,
  sectionName: string,
  knownKeys: Set<string>,
  warnings: string[],
): void {
  if (raw === undefined || raw === null) return;

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(
      `Engine section "${sectionName}" must be an object, got ${Array.isArray(raw) ? 'array' : typeof raw}.`,
    );
    return;
  }

  const obj = raw as Record<string, unknown>;
  let validFieldCount = 0;

  for (const key of Object.keys(obj)) {
    if (!knownKeys.has(key)) {
      warnings.push(
        `Unknown key "${key}" in "${sectionName}" section — will be ignored. Valid keys: ${[...knownKeys].join(', ')}.`,
      );
      continue;
    }

    // Check types for known fields
    const val = obj[key];
    if (key === 'timeoutMs' || key === 'perMutantTimeoutMs' || key === 'concurrency') {
      if (typeof val !== 'number') {
        warnings.push(
          `"${sectionName}.${key}" must be a number, got ${typeof val} — will be ignored.`,
        );
        continue;
      }
      if (val <= 0) {
        warnings.push(`"${sectionName}.${key}" must be positive, got ${val} — will be ignored.`);
        continue;
      }
      if (key === 'concurrency' && !Number.isInteger(val)) {
        warnings.push(
          `"${sectionName}.concurrency" must be an integer, got ${val} — will be ignored.`,
        );
        continue;
      }
      if (key === 'concurrency' && (val < 1 || val > 64)) {
        warnings.push(
          `"${sectionName}.concurrency" must be between 1 and 64, got ${val} — will be ignored.`,
        );
        continue;
      }
    }
    if (key === 'mutatorAllowlist' || key === 'mutatorDenylist') {
      if (!Array.isArray(val)) {
        warnings.push(
          `"${sectionName}.${key}" must be an array, got ${typeof val} — will be ignored.`,
        );
        continue;
      }
    }
    if (key === 'dryRun' || key === 'incremental') {
      if (typeof val !== 'boolean') {
        warnings.push(
          `"${sectionName}.${key}" must be a boolean, got ${typeof val} — will be ignored.`,
        );
        continue;
      }
    }
    if (key === 'testRunner') {
      if (typeof val !== 'string') {
        warnings.push(
          `"${sectionName}.${key}" must be a string, got ${typeof val} — will be ignored.`,
        );
        continue;
      }
    }
    validFieldCount++;
  }

  // If the section exists but has zero valid fields, report it
  if (validFieldCount === 0) {
    warnings.push(
      `Engine section "${sectionName}" has no valid fields — the entire section will be ignored.`,
    );
  }
}

/**
 * Load configuration from a JSON file.
 *
 * Lookup order:
 * 1. If `configPath` is provided via --config, load that file.
 * 2. Otherwise, look for `chaos-mcp.config.json` in the current working directory.
 * 3. If neither exists, return empty defaults.
 *
 * @param configPath - Optional explicit path to a config file.
 * @returns Parsed ChaosConfig; invalid JSON or missing file returns empty object.
 */
export function loadConfig(configPath?: string): ChaosConfig {
  const targetPath = configPath ? resolve(configPath) : resolve(DEFAULT_CONFIG_FILE);

  try {
    const raw = readConfigRaw(configPath);
    if (raw === null) return {};
    return buildConfig(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load config file "${targetPath}": ${message}`);
  }
}
