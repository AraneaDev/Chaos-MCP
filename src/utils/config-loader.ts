import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

// ─── Per-engine config sections ──────────────────────────────────────────────

/** Valid top-level config keys known to ChaosConfig. */
const KNOWN_KEYS = new Set([
  'defaultTimeoutMs',
  'testRunner',
  'concurrency',
  'mutatorAllowlist',
  'mutatorDenylist',
  'perMutantTimeoutMs',
  'allowPrebuild',
  'stryker',
  'mutmut',
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

/** Valid keys within a MutmutConfig section. */
const KNOWN_MUTMUT_KEYS = new Set(['timeoutMs', 'testRunner']);

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
 * Mutmut (Python)-specific config overrides.
 */
export interface MutmutConfig {
  /** Timeout override for mutmut runs (ms). */
  timeoutMs?: number;
  /** Test runner override (e.g. "pytest", "unittest"). */
  testRunner?: string;
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
 * Engine-specific sections (`stryker`, `mutmut`, `go`, `rust`) override their
 * corresponding global defaults. This lets you set a short global timeout while
 * giving Rust/Go builds more time, or tune Stryker concurrency independently.
 */
export interface ChaosConfig {
  /** Default timeout in milliseconds for all mutation runs. */
  defaultTimeoutMs?: number;

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

  /** StrykerJS-specific overrides (precedence over global defaults). */
  stryker?: StrykerConfig;

  /** Mutmut (Python)-specific overrides (precedence over global defaults). */
  mutmut?: MutmutConfig;

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

function parseMutmutConfig(raw: unknown): MutmutConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  const result: MutmutConfig = {};
  let hasAny = false;

  if (typeof s.timeoutMs === 'number' && s.timeoutMs > 0) {
    result.timeoutMs = s.timeoutMs;
    hasAny = true;
  }
  if (typeof s.testRunner === 'string' && s.testRunner.length > 0) {
    result.testRunner = s.testRunner;
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

  result.stryker = parseStrykerConfig(raw.stryker);
  result.mutmut = parseMutmutConfig(raw.mutmut);
  result.go = parseTimeoutOnlyConfig(raw.go);
  result.rust = parseTimeoutOnlyConfig(raw.rust);

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
  validateEngineSection(raw.stryker, 'stryker', KNOWN_STRYKER_KEYS, warnings);
  validateEngineSection(raw.mutmut, 'mutmut', KNOWN_MUTMUT_KEYS, warnings);
  validateEngineSection(raw.go, 'go', KNOWN_GO_KEYS, warnings);
  validateEngineSection(raw.rust, 'rust', KNOWN_RUST_KEYS, warnings);

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
