import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

/**
 * User-configurable defaults for mutation testing runs.
 * Loaded from a JSON config file at startup and merged with per-call arguments.
 * Tool call arguments always take precedence over config defaults.
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
}

/** Default config file name looked up from the working directory. */
const DEFAULT_CONFIG_FILE = 'chaos-mcp.config.json';

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

  if (!existsSync(targetPath)) {
    return {};
  }

  try {
    const raw = readFileSync(targetPath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Config file must contain a JSON object.');
    }

    const config = parsed as Record<string, unknown>;

    // Sanitise: only allow known keys
    const result: ChaosConfig = {};

    if (typeof config.defaultTimeoutMs === 'number' && config.defaultTimeoutMs > 0) {
      result.defaultTimeoutMs = config.defaultTimeoutMs;
    }

    if (typeof config.testRunner === 'string' && config.testRunner.length > 0) {
      result.testRunner = config.testRunner;
    }

    if (typeof config.concurrency === 'number' && config.concurrency > 0) {
      result.concurrency = config.concurrency;
    }

    if (Array.isArray(config.mutatorAllowlist)) {
      result.mutatorAllowlist = config.mutatorAllowlist.filter(
        (v: unknown) => typeof v === 'string',
      ) as string[];
    }

    if (Array.isArray(config.mutatorDenylist)) {
      result.mutatorDenylist = config.mutatorDenylist.filter(
        (v: unknown) => typeof v === 'string',
      ) as string[];
    }

    return result;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load config file "${targetPath}": ${message}`);
  }
}
