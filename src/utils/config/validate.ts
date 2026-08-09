import type { ConfigValidation } from './types.js';
import { buildConfig, readConfigRaw, resolveConfigPath } from './parse.js';
import {
  sectionRule,
  warnRules,
  CONTAINER_FIELD_RULES,
  ENGINE_CONFIG_SECTIONS,
  GLOBAL_FIELD_RULES,
  KNOWN_CONTAINER_IMAGE_KEYS,
  KNOWN_CONTAINER_KEYS,
  KNOWN_SANDBOX_KEYS,
  KNOWN_TOP_LEVEL_KEYS,
} from './rules.js';

/**
 * Validate a config file and return warnings for silently-ignored fields.
 *
 * Unlike `loadConfig` which silently drops unknown/invalid values, this function
 * inspects the raw JSON and reports:
 *   - Unknown top-level keys
 *   - Engine sections that exist but contain no valid fields (all rejected)
 *   - Unknown keys within engine sections
 *   - Fields with wrong types (e.g. string where number expected)
 *
 * Every rejection reason comes from the same rule tables the parser uses, so a
 * field cannot be accepted here and warned about there (or the reverse).
 *
 * @param configPath - Optional explicit path to a config file.
 * @returns The parsed {@link ConfigValidation}.
 */
export function validateConfig(configPath?: string): ConfigValidation {
  const targetPath = resolveConfigPath(configPath);
  const warnings: string[] = [];

  let raw: Record<string, unknown>;
  try {
    const parsed = readConfigRaw(configPath);
    if (parsed === null) {
      return {
        config: {},
        warnings: [`Config file not found: ${targetPath}`],
        status: 'not-found',
      };
    }
    raw = parsed;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      config: {},
      warnings: [`Failed to parse config file "${targetPath}": ${message}`],
      status: 'unreadable',
    };
  }

  // ── Check unknown top-level keys ──
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      warnings.push(`Unknown config key: "${key}" — will be ignored.`);
    }
  }

  // ── Validate engine sections ──
  for (const section of ENGINE_CONFIG_SECTIONS) {
    validateEngineSection(raw[section.key], section.key, section.knownKeys, warnings);
  }
  validateEngineSection(raw.container, 'container', KNOWN_CONTAINER_KEYS, warnings);
  if (
    typeof raw.container === 'object' &&
    raw.container !== null &&
    !Array.isArray(raw.container)
  ) {
    const images = (raw.container as Record<string, unknown>).images;
    validateEngineSection(images, 'container.images', KNOWN_CONTAINER_IMAGE_KEYS, warnings);
  }
  validateContainerConfig(raw.container, warnings);
  validateEngineSection(raw.sandbox, 'sandbox', KNOWN_SANDBOX_KEYS, warnings);

  // ── Validate global fields ──
  warnRules(raw, GLOBAL_FIELD_RULES, warnings, (key, phrase) => `${key} ${phrase}.`);

  // Build the config from the already-parsed raw object (no double-read)
  const config = buildConfig(raw);

  return { config, warnings, status: 'ok' };
}

/**
 * Validate an engine-specific config section, adding warnings for issues.
 *
 * The eight-deep `if (key === '…')` chain this replaced was a dispatch table
 * written as an if-chain; the table is now {@link SECTION_FIELD_RULES}, shared
 * with the parser.
 * @internal
 */
function validateEngineSection(
  raw: unknown,
  sectionName: string,
  knownKeys: ReadonlySet<string>,
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

    const phrase = sectionRule(key)?.describe(obj[key]);
    if (phrase !== undefined) {
      warnings.push(`"${sectionName}.${key}" ${phrase} — will be ignored.`);
      continue;
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
 * Warn about the container section's own fields. Kept apart from
 * {@link validateEngineSection} because its messages have never used the
 * quoted `"section.key" … — will be ignored` house style.
 * @internal
 */
function validateContainerConfig(raw: unknown, warnings: string[]): void {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return;
  const value = raw as Record<string, unknown>;

  warnRules(value, CONTAINER_FIELD_RULES, warnings, (key, phrase) => `container.${key} ${phrase}.`);

  // Only when `images` is a usable object — otherwise the rule above already
  // said "must be an object" and the per-language detail would be noise.
  if (
    'images' in value &&
    typeof value.images === 'object' &&
    value.images !== null &&
    !Array.isArray(value.images)
  ) {
    const images = value.images as Record<string, unknown>;
    for (const language of KNOWN_CONTAINER_IMAGE_KEYS) {
      const image = images[language];
      if (language in images && (typeof image !== 'string' || image.trim().length === 0)) {
        warnings.push(`container.images.${language} must be a non-empty string.`);
      }
    }
  }
}
