import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { ChaosConfig, ContainerConfig } from './types.js';
import {
  applyRules,
  sectionRule,
  CONTAINER_FIELD_RULES,
  ENGINE_CONFIG_SECTIONS,
  GLOBAL_FIELD_RULES,
} from './rules.js';

/** Default config file name looked up from the working directory. */
export const DEFAULT_CONFIG_FILE = 'chaos-mcp.config.json';

/** Resolve the config path a caller asked for, or the default file. */
export function resolveConfigPath(configPath?: string): string {
  return configPath ? resolve(configPath) : resolve(DEFAULT_CONFIG_FILE);
}

/**
 * Read and parse a JSON config file, returning the raw object.
 * Throws on I/O errors, invalid JSON, or non-object results.
 * @internal
 */
export function readConfigRaw(configPath?: string): Record<string, unknown> | null {
  const targetPath = resolveConfigPath(configPath);

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
 * Parse one engine section: keep every field of `knownKeys` its shared rule
 * accepts, and drop the section entirely when nothing survives. This one
 * function replaces the four near-identical `parse*Config` bodies — each of
 * which repeated the same `timeoutMs` block.
 * @internal
 */
export function parseSection<T>(raw: unknown, knownKeys: Iterable<string>): T | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const rules = [...knownKeys].map(sectionRule).filter((rule) => rule !== undefined);
  const result: Record<string, unknown> = {};
  const accepted = applyRules(raw as Record<string, unknown>, rules, result);
  return accepted > 0 ? (result as T) : undefined;
}

/**
 * Parse the shared container section. Separate from {@link parseSection} only
 * because its fields live in their own rule table (their warnings read
 * `container.x must be …`, not the engine-section house style).
 * @internal
 */
export function parseContainerConfig(raw: unknown): ContainerConfig | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const result: Record<string, unknown> = {};
  const accepted = applyRules(raw as Record<string, unknown>, CONTAINER_FIELD_RULES, result);
  return accepted > 0 ? (result as ContainerConfig) : undefined;
}

/**
 * Build a ChaosConfig from a raw parsed config object.
 * @internal
 */
export function buildConfig(raw: Record<string, unknown>): ChaosConfig {
  const result: ChaosConfig = {};

  applyRules(raw, GLOBAL_FIELD_RULES, result as Record<string, unknown>);

  for (const section of ENGINE_CONFIG_SECTIONS) {
    // Each section parses to its own shape; the table erases the precise per-key
    // linkage, so assign through an index signature. The key is always set — to
    // the parsed section or to undefined — exactly as before.
    (result as Record<string, unknown>)[section.key] = parseSection(
      raw[section.key],
      section.knownKeys,
    );
  }
  result.container = parseContainerConfig(raw.container);

  return result;
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
  const targetPath = resolveConfigPath(configPath);

  try {
    const raw = readConfigRaw(configPath);
    if (raw === null) return {};
    return buildConfig(raw);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load config file "${targetPath}": ${message}`);
  }
}
