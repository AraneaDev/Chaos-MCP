import { MAX_TIMEOUT_MS } from '../constants.js';
import type { SupportedProjectType } from '../project-detector.js';
import type { EngineConfigKey } from './types.js';

/**
 * ONE table per group of config fields, shared by the parser and the validator.
 *
 * Before this table existed every rule was written twice by hand: `buildConfig`
 * decided whether to ACCEPT a field, and `validateConfig` decided whether to
 * WARN about the same field using the same predicate spelled out again, negated.
 * The two drifted (see the `describe` comments below), and adding one config key
 * needed four coordinated edits. Now `applyRules` (parse) and `warnRules`
 * (validate) walk the SAME array, so acceptance and reporting cannot disagree
 * unless a rule says so explicitly, in one place, with a reason.
 */
export interface FieldRule {
  /** The config key this rule governs. */
  key: string;
  /** Accept predicate. The parser keeps the value if and only if this is true. */
  check: (value: unknown) => boolean;
  /**
   * The complaint phrase for a value the user should hear about, or `undefined`
   * to stay silent. Callers wrap it: global fields render `${key} ${phrase}.`,
   * engine sections render `"${section}.${key}" ${phrase} — will be ignored.`,
   * and the container section renders `container.${key} ${phrase}.`
   *
   * A phrase-producing function (rather than a fixed string) is what lets one
   * table reproduce the staged messages the validator has always emitted
   * ("must be a number" / "must be positive" / "must be an integer" for the
   * same key) and the historical cases where the validator stayed SILENT about
   * a value the parser drops. Each of those gaps is flagged `HISTORICAL GAP`
   * below: `check` rejects, `describe` says nothing. They are preserved
   * deliberately — closing one adds a user-visible warning.
   */
  describe: (value: unknown) => string | undefined;
  /** Normaliser applied to an accepted value before it is stored. */
  coerce?: (value: unknown) => unknown;
  /**
   * Whether an accepted value makes its section non-empty. Only the Stryker
   * mutator lists differ: an empty array is stored but does not by itself keep
   * the section alive.
   */
  counts?: (coerced: unknown) => boolean;
}

// ─── Predicate helpers ───────────────────────────────────────────────────────

/** A finite-or-infinite number strictly greater than zero. */
export const positiveNumber = (value: unknown): value is number =>
  typeof value === 'number' && value > 0;

/** An integer within `[min, max]`. `max` defaults to unbounded, as before. */
export const boundedInt =
  (min: number, max = Infinity) =>
  (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

/**
 * A timeout the platform can actually honour: positive and no larger than
 * {@link MAX_TIMEOUT_MS}. Values above the cap reach `setTimeout`, get clamped
 * to 1 ms and abort the run instantly, so a typo like `3000000000` used to kill
 * every audit silently. `tool-args-validation.ts` already rejects that for tool
 * arguments; the config file now matches.
 */
export const timeoutValue = (value: unknown): value is number =>
  positiveNumber(value) && value <= MAX_TIMEOUT_MS;

/** `1..64` — the concurrency rule, previously written out three separate times. */
const int1to64 = boundedInt(1, 64);
/** `>= 1` — the shared "positive integer" rule. */
const intAtLeast1 = boundedInt(1);

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The `got ${…}` rendering used by the numeric global warnings. */
const numberOrType = (value: unknown): string =>
  typeof value === 'number' ? String(value) : typeof value;

/**
 * The complaint for a global mutator list. The parser takes any array and keeps
 * only its string entries, so both failure modes are user-invisible without
 * this: a non-array is dropped whole, and a stray non-string entry disappears
 * from a list the user wrote by hand. An all-string array (including `[]`) is
 * accepted verbatim and stays silent.
 */
const describeStringList = (value: unknown): string | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? undefined
    : `must be an array of strings, got ${Array.isArray(value) ? 'array with invalid entries' : typeof value}`;

/**
 * `mutatorAllowlist` is accepted by the parser and then deliberately never read
 * (`buildRunOptions` in audit/run-options.ts: "sourcing it here (from args OR
 * config) would make every TS run throw"). That combination is invisible to
 * `--validate-config`, whose whole job is to report what the parser dropped —
 * this is a value the parser KEEPS and the consumer ignores. Wording matches
 * the tool-argument rejection and the `chaos://config-schema` resource.
 */
const ALLOWLIST_UNSUPPORTED_PHRASE =
  'is NOT SUPPORTED (StrykerJS has no allowlist) and is ignored — use mutatorDenylist instead';

/** Phrase shared by every over-the-cap timeout warning. */
const overCapPhrase = (value: unknown): string =>
  `must be <= ${MAX_TIMEOUT_MS} (the largest delay a timer accepts; larger values are clamped to 1ms and abort the run immediately), got ${numberOrType(value)}`;

/**
 * The staged complaint for a timeout-style field, matching the order the
 * validator has always used: wrong type, then non-positive, then over the cap.
 */
const describeTimeout = (value: unknown): string | undefined => {
  if (typeof value !== 'number') return `must be a number, got ${typeof value}`;
  // HISTORICAL GAP: a non-positive or NaN timeout is dropped by the parser but
  // has never been warned about at the global level. Preserved.
  if (value <= 0) return undefined;
  if (value > MAX_TIMEOUT_MS) return overCapPhrase(value);
  return undefined;
};

// ─── Global (top-level) fields ───────────────────────────────────────────────

/**
 * The top-level fields, in the order the validator has always reported them.
 * The last three (`defaultMaxFiles`, `mutatorAllowlist`, `mutatorDenylist`) were
 * appended back when they emitted nothing at all; they now warn, so they report
 * after the rest. Nothing above them moved, so every pre-existing message keeps
 * both its text and its position.
 */
export const GLOBAL_FIELD_RULES: readonly FieldRule[] = [
  {
    key: 'defaultTimeoutMs',
    check: timeoutValue,
    describe: describeTimeout,
  },
  {
    key: 'testRunner',
    check: nonEmptyString,
    // HISTORICAL GAP: `""` is dropped by the parser but never warned about.
    describe: (v) => (typeof v !== 'string' ? `must be a string, got ${typeof v}` : undefined),
  },
  {
    key: 'concurrency',
    check: int1to64,
    describe: (v) =>
      int1to64(v) ? undefined : `must be an integer between 1 and 64, got ${numberOrType(v)}`,
  },
  {
    key: 'perMutantTimeoutMs',
    check: timeoutValue,
    describe: describeTimeout,
  },
  {
    key: 'allowPrebuild',
    check: (v) => typeof v === 'boolean',
    describe: (v) => (typeof v !== 'boolean' ? `must be a boolean, got ${typeof v}` : undefined),
  },
  {
    key: 'defaultMaxSurvivors',
    check: intAtLeast1,
    describe: (v) =>
      intAtLeast1(v) ? undefined : `must be an integer >= 1, got ${numberOrType(v)}`,
  },
  {
    key: 'defaultSeverityFloor',
    check: (v) => v === 'high' || v === 'medium' || v === 'low',
    describe: (v) =>
      v === 'high' || v === 'medium' || v === 'low'
        ? undefined
        : `must be one of "high"|"medium"|"low", got ${JSON.stringify(v)}`,
  },
  {
    key: 'defaultFileConcurrency',
    check: int1to64,
    describe: (v) =>
      int1to64(v) ? undefined : `must be an integer between 1 and 64, got ${numberOrType(v)}`,
  },
  {
    key: 'suppressionsPath',
    // Note: the accepted value is stored untrimmed, as it always has been.
    check: (v) => typeof v === 'string' && v.trim().length > 0,
    describe: (v) =>
      typeof v === 'string' && v.trim().length > 0 ? undefined : 'must be a non-empty string',
  },
  {
    key: 'runCacheTtlMs',
    check: intAtLeast1,
    describe: (v) =>
      intAtLeast1(v) ? undefined : `must be an integer > 0, got ${numberOrType(v)}`,
  },
  {
    key: 'runCacheMax',
    check: intAtLeast1,
    describe: (v) =>
      intAtLeast1(v) ? undefined : `must be an integer >= 1, got ${numberOrType(v)}`,
  },
  {
    key: 'defaultMaxFiles',
    check: intAtLeast1,
    // GAP CLOSED (was: never validated at all — an invalid value was dropped in
    // total silence, with no type warning and no unknown-key warning either).
    // Same phrase as its siblings `defaultMaxSurvivors` / `runCacheMax`; `check`
    // is untouched, so nothing the parser used to accept is rejected now.
    describe: (v) =>
      intAtLeast1(v) ? undefined : `must be an integer >= 1, got ${numberOrType(v)}`,
  },
  {
    key: 'mutatorAllowlist',
    check: Array.isArray,
    coerce: (v) => (v as unknown[]).filter((entry) => typeof entry === 'string'),
    // `check` is untouched — every array the parser took before is still taken.
    // Unlike its siblings, `describe` is unconditional: even a well-formed
    // array of strings is exactly the case that silently does nothing, because
    // the value is never read (see ALLOWLIST_UNSUPPORTED_PHRASE above).
    describe: () => ALLOWLIST_UNSUPPORTED_PHRASE,
  },
  {
    key: 'mutatorDenylist',
    check: Array.isArray,
    coerce: (v) => (v as unknown[]).filter((entry) => typeof entry === 'string'),
    // GAP CLOSED: same as mutatorAllowlist.
    describe: describeStringList,
  },
];

// ─── Engine-section fields ───────────────────────────────────────────────────

const nonEmptyStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((entry) => typeof entry === 'string' && entry.length > 0);

const describeStringArray = (value: unknown): string | undefined =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)
    ? undefined
    : `must be an array of non-empty strings, got ${Array.isArray(value) ? 'array with invalid entries' : typeof value}`;

/**
 * The `sandbox.dependencies` rule, shared verbatim by {@link SANDBOX_FIELD_RULES}
 * (the parser, via `parseSandboxConfig`) and {@link SECTION_FIELD_RULES} (the
 * validator, via `sectionRule`/`validateEngineSection`) — one object literal so
 * the two cannot drift on what counts as a valid mode.
 */
const dependenciesRule: FieldRule = {
  key: 'dependencies',
  check: (v) => v === 'link-entries' || v === 'copy' || v === 'share',
  describe: (v) =>
    v === 'link-entries' || v === 'copy' || v === 'share'
      ? undefined
      : `must be one of "link-entries", "copy", or "share", got ${JSON.stringify(v)}`,
};

/**
 * Field rules shared by every engine section, keyed by field name. A section
 * declares which of these it accepts through its `knownKeys` set, so the same
 * `timeoutMs` rule serves Stryker, cosmic-ray, cargo-mutants and Infection —
 * the block that used to be copy-pasted into all four parsers.
 *
 * `dependencies` also lives here (rather than only in {@link SANDBOX_FIELD_RULES})
 * so `validateEngineSection`, which looks up per-key rules through
 * {@link sectionRule} against this table, has something to find for the sandbox
 * section too.
 */
export const SECTION_FIELD_RULES: Readonly<Record<string, FieldRule>> = {
  dependencies: dependenciesRule,
  timeoutMs: {
    key: 'timeoutMs',
    check: timeoutValue,
    describe: (v) => {
      if (typeof v !== 'number') return `must be a number, got ${typeof v}`;
      if (v <= 0) return `must be positive, got ${v}`;
      if (v > MAX_TIMEOUT_MS) return overCapPhrase(v);
      // HISTORICAL GAP: NaN passes every stage above yet the parser drops it.
      return undefined;
    },
  },
  perMutantTimeoutMs: {
    key: 'perMutantTimeoutMs',
    check: timeoutValue,
    describe: (v) => {
      if (typeof v !== 'number') return `must be a number, got ${typeof v}`;
      if (v <= 0) return `must be positive, got ${v}`;
      if (v > MAX_TIMEOUT_MS) return overCapPhrase(v);
      return undefined;
    },
  },
  concurrency: {
    key: 'concurrency',
    check: int1to64,
    describe: (v) => {
      if (typeof v !== 'number') return `must be a number, got ${typeof v}`;
      if (v <= 0) return `must be positive, got ${v}`;
      if (!Number.isInteger(v)) return `must be an integer, got ${v}`;
      if (v < 1 || v > 64) return `must be between 1 and 64, got ${v}`;
      return undefined;
    },
  },
  mutatorAllowlist: {
    key: 'mutatorAllowlist',
    check: Array.isArray,
    coerce: (v) => (v as unknown[]).filter((entry) => typeof entry === 'string'),
    // An all-invalid (or empty) list is stored but does not keep the section alive.
    // `counts` is untouched by the describe change below.
    counts: (v) => (v as string[]).length > 0,
    // Unconditional, like the global rule above: a well-formed array is exactly
    // the case that silently does nothing, so it warns too.
    describe: () => ALLOWLIST_UNSUPPORTED_PHRASE,
  },
  mutatorDenylist: {
    key: 'mutatorDenylist',
    check: Array.isArray,
    coerce: (v) => (v as unknown[]).filter((entry) => typeof entry === 'string'),
    counts: (v) => (v as string[]).length > 0,
    describe: (v) => (Array.isArray(v) ? undefined : `must be an array, got ${typeof v}`),
  },
  dryRun: {
    key: 'dryRun',
    check: (v) => typeof v === 'boolean',
    describe: (v) => (typeof v !== 'boolean' ? `must be a boolean, got ${typeof v}` : undefined),
  },
  incremental: {
    key: 'incremental',
    check: (v) => typeof v === 'boolean',
    describe: (v) => (typeof v !== 'boolean' ? `must be a boolean, got ${typeof v}` : undefined),
  },
  testRunner: {
    key: 'testRunner',
    check: nonEmptyString,
    // HISTORICAL GAP: `""` is dropped by the parser but reported as valid.
    describe: (v) => (typeof v !== 'string' ? `must be a string, got ${typeof v}` : undefined),
  },
  threads: {
    key: 'threads',
    check: (v) => v === 'max' || intAtLeast1(v),
    describe: (v) =>
      v === 'max' || intAtLeast1(v)
        ? undefined
        : `must be "max" or a positive integer, got ${typeof v === 'number' || typeof v === 'string' ? JSON.stringify(v) : typeof v}`,
  },
  testFrameworkOptions: {
    key: 'testFrameworkOptions',
    check: nonEmptyString,
    // HISTORICAL GAP: `""` is dropped by the parser but reported as valid.
    describe: (v) => (typeof v !== 'string' ? `must be a string, got ${typeof v}` : undefined),
  },
  testSelection: {
    key: 'testSelection',
    check: (v) => nonEmptyStringArray(v),
    // HISTORICAL GAP: `[]` satisfies `every()` so it is reported as valid, yet
    // the parser requires at least one entry. Preserved.
    describe: (v) => describeStringArray(v),
  },
  excludeOperators: {
    key: 'excludeOperators',
    check: (v) => nonEmptyStringArray(v),
    describe: (v) => describeStringArray(v),
  },
};

/** Prototype-safe lookup: a config key like `constructor` must not resolve. */
export function sectionRule(key: string): FieldRule | undefined {
  return Object.hasOwn(SECTION_FIELD_RULES, key) ? SECTION_FIELD_RULES[key] : undefined;
}

// ─── Container section fields ────────────────────────────────────────────────

/** Per-language image keys accepted inside `container.images`. */
export const KNOWN_CONTAINER_IMAGE_KEYS = new Set<SupportedProjectType>([
  'typescript',
  'python',
  'rust',
  'php',
]);

/** The trimmed, non-empty per-language images found in a raw `images` value. */
export function pickImages(value: unknown): Record<string, string> {
  const images: Record<string, string> = {};
  if (!isPlainObject(value)) return images;
  for (const language of KNOWN_CONTAINER_IMAGE_KEYS) {
    const image = value[language];
    if (typeof image === 'string' && image.trim().length > 0) {
      images[language] = image.trim();
    }
  }
  return images;
}

/**
 * The valid per-language execution modes found in a raw `modes` value.
 *
 * Mirrors {@link pickImages}: an unknown language or an unrecognised mode is
 * dropped rather than failing the whole section, and the validator reports it.
 */
export function pickModes(value: unknown): Record<string, string> {
  const modes: Record<string, string> = {};
  if (!isPlainObject(value)) return modes;
  for (const language of KNOWN_CONTAINER_IMAGE_KEYS) {
    const mode = value[language];
    if (mode === 'native' || mode === 'container' || mode === 'auto') {
      modes[language] = mode;
    }
  }
  return modes;
}

const positiveIntRule = (key: string): FieldRule => ({
  key,
  check: (v) => typeof v === 'number' && Number.isInteger(v) && v > 0,
  describe: (v) =>
    typeof v === 'number' && Number.isInteger(v) && v > 0
      ? undefined
      : 'must be a positive integer',
});

/**
 * The container section, in the order the validator reports it (which is also
 * the order the parser assigns). Its warnings read `container.${key} ${phrase}.`
 * — no quoting and no "will be ignored" suffix — so it keeps its own table
 * rather than joining {@link SECTION_FIELD_RULES}.
 */
export const CONTAINER_FIELD_RULES: readonly FieldRule[] = [
  {
    key: 'mode',
    check: (v) => v === 'native' || v === 'container' || v === 'auto',
    describe: (v) =>
      v === 'native' || v === 'container' || v === 'auto'
        ? undefined
        : 'must be one of "native", "container", or "auto"',
  },
  {
    key: 'modes',
    // A modes map whose entries are all invalid is dropped entirely, exactly as
    // an images map is; the per-language warnings explain why.
    check: (v) => Object.keys(pickModes(v)).length > 0,
    coerce: pickModes,
    describe: (v) => (isPlainObject(v) ? undefined : 'must be an object'),
  },
  {
    key: 'runtime',
    check: (v) => v === 'docker' || v === 'podman',
    describe: (v) =>
      v === 'docker' || v === 'podman' ? undefined : 'must be "docker" or "podman"',
  },
  {
    key: 'network',
    check: (v) => typeof v === 'string' && v.trim().length > 0,
    coerce: (v) => (v as string).trim(),
    describe: (v) =>
      typeof v === 'string' && v.trim().length > 0 ? undefined : 'must be a non-empty string',
  },
  {
    key: 'cpus',
    check: (v) => typeof v === 'number' && Number.isFinite(v) && v > 0,
    describe: (v) =>
      typeof v === 'number' && Number.isFinite(v) && v > 0
        ? undefined
        : 'must be a positive number',
  },
  positiveIntRule('memoryMb'),
  positiveIntRule('pidsLimit'),
  positiveIntRule('startupTimeoutMs'),
  positiveIntRule('tmpfsSizeMb'),
  {
    key: 'images',
    // An images map whose entries are all invalid is dropped entirely; the
    // per-language warnings below explain why.
    check: (v) => Object.keys(pickImages(v)).length > 0,
    coerce: pickImages,
    describe: (v) => (isPlainObject(v) ? undefined : 'must be an object'),
  },
];

// ─── Sandbox section fields ──────────────────────────────────────────────────

/** Valid keys within a SandboxConfig section. */
export const KNOWN_SANDBOX_KEYS = new Set(['dependencies']);

/**
 * The sandbox section. Its warnings read `"sandbox.${key}" ${phrase} — will be
 * ignored.`, i.e. the engine-section house style, so it reuses that renderer.
 */
export const SANDBOX_FIELD_RULES: readonly FieldRule[] = [dependenciesRule];

// ─── Rule engine ─────────────────────────────────────────────────────────────

/**
 * Parse side: copy every field the rules accept into `target`.
 * @returns how many accepted fields count towards the section being non-empty.
 */
export function applyRules(
  raw: Record<string, unknown>,
  rules: readonly FieldRule[],
  target: Record<string, unknown>,
): number {
  let accepted = 0;
  for (const rule of rules) {
    const value = raw[rule.key];
    if (!rule.check(value)) continue;
    const stored = rule.coerce ? rule.coerce(value) : value;
    target[rule.key] = stored;
    if (!rule.counts || rule.counts(stored)) accepted++;
  }
  return accepted;
}

/**
 * Validate side: warn about every present field the SAME rules reject and have
 * something to say about. `format` turns a key and a phrase into the section's
 * house style.
 */
export function warnRules(
  raw: Record<string, unknown>,
  rules: readonly FieldRule[],
  warnings: string[],
  format: (key: string, phrase: string) => string,
): void {
  for (const rule of rules) {
    if (!(rule.key in raw)) continue;
    const phrase = rule.describe(raw[rule.key]);
    if (phrase !== undefined) warnings.push(format(rule.key, phrase));
  }
}

// ─── Section membership ──────────────────────────────────────────────────────

/** Valid keys within a StrykerConfig section (also the parse order). */
export const KNOWN_STRYKER_KEYS = new Set([
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
export const KNOWN_COSMICRAY_KEYS = new Set([
  'timeoutMs',
  'testRunner',
  'testSelection',
  'excludeOperators',
]);

/** Valid keys within a CargoMutantsConfig section. */
export const KNOWN_RUST_KEYS = new Set(['timeoutMs', 'concurrency']);

/** Valid keys within an InfectionConfig section. */
export const KNOWN_INFECTION_KEYS = new Set(['timeoutMs', 'threads', 'testFrameworkOptions']);

/** Valid keys within a ContainerConfig section — derived from its rule table. */
export const KNOWN_CONTAINER_KEYS = new Set(CONTAINER_FIELD_RULES.map((rule) => rule.key));

/** One engine section: the config key plus the fields it accepts. */
export interface EngineConfigSection {
  key: EngineConfigKey;
  knownKeys: Set<string>;
}

/**
 * The known keys of every engine section, as a `Record` over
 * {@link EngineConfigKey} — so the two CANNOT drift. This used to be a plain
 * array, which meant a fifth member of the union compiled cleanly while its
 * section was silently never parsed and never validated. A `Record` makes the
 * missing entry a compile error at this literal instead.
 *
 * Declaration order is load-bearing: {@link ENGINE_CONFIG_SECTIONS} is derived
 * from it, and warning order follows that list.
 */
const ENGINE_SECTION_KNOWN_KEYS: Readonly<Record<EngineConfigKey, Set<string>>> = {
  stryker: KNOWN_STRYKER_KEYS,
  cosmicray: KNOWN_COSMICRAY_KEYS,
  rust: KNOWN_RUST_KEYS,
  infection: KNOWN_INFECTION_KEYS,
};

/**
 * Per-engine config sections, in one place. `key` is the {@link EngineConfigKey}
 * that `EngineDescriptor.configKey` in engines/registry.ts also uses; `knownKeys`
 * selects this section's subset of {@link SECTION_FIELD_RULES}, which is all a
 * parser or a validator needs. Adding a language adds one entry to
 * {@link ENGINE_SECTION_KNOWN_KEYS} — and omitting it no longer compiles.
 *
 * Derived from that record rather than written out again, so a new engine joins
 * this list automatically. `Object.keys` on an object with no integer-like keys
 * yields insertion order, which is why the record above is written in the same
 * order the list has always had (stryker, cosmicray, rust, infection) — parse
 * order and warning order are unchanged.
 */
export const ENGINE_CONFIG_SECTIONS: readonly EngineConfigSection[] = (
  Object.keys(ENGINE_SECTION_KNOWN_KEYS) as EngineConfigKey[]
).map((key) => ({ key, knownKeys: ENGINE_SECTION_KNOWN_KEYS[key] }));

/**
 * Valid top-level config keys, derived from the rule table and the section list
 * so a new key cannot be accepted by the parser yet reported as "unknown".
 */
export const KNOWN_TOP_LEVEL_KEYS = new Set<string>([
  ...GLOBAL_FIELD_RULES.map((rule) => rule.key),
  ...ENGINE_CONFIG_SECTIONS.map((section) => section.key),
  'container',
  'sandbox',
]);
