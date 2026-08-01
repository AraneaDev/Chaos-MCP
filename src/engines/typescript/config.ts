/**
 * The StrykerJS configuration overlay every run is launched with.
 *
 * Imports from `'fs'` rather than `'node:fs'` deliberately: the engine test
 * suite mocks the bare specifier, and the two are distinct module records.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { RunOptions } from '../base.js';

/**
 * Path (relative to the Stryker working directory) where the JSON reporter
 * writes its output.
 *
 * This is NOT merely where we look — it is pinned into the generated Stryker
 * overlay config as `jsonReporter.fileName` on every run (see
 * {@link writeStrykerRuntimeConfig}). `jsonReporter.fileName` is a first-class,
 * user-settable Stryker option (node_modules/@stryker-mutator/core/dist/src/
 * reporters/json-reporter.js resolves `this.options.jsonReporter.fileName`), and
 * the overlay faithfully carries the project's own config forward — so without
 * the pin a project shipping `jsonReporter: { fileName: 'artifacts/…' }` made a
 * fully successful run report "Stryker JSON report not found at …" (audit E).
 *
 * It cannot be pinned on the CLI: StrykerJS 9.6.1 declares no
 * `--jsonReporter.fileName` option (only `--dashboard.*` is special-cased in
 * stryker-cli.js), and Commander rejects the run outright with
 * `error: unknown option '--jsonReporter.fileName'`. The config overlay is the
 * only mechanism.
 */
export const STRIKER_JSON_REPORT = 'reports/mutation/mutation.json';

export const CHAOS_STRYKER_CONFIG = '.chaos-mcp.stryker.config.mjs';

/** Stryker's supported config names, in its own discovery order. */
const STRYKER_CONFIG_NAMES = [
  'stryker.conf.json',
  'stryker.conf.js',
  'stryker.conf.mjs',
  'stryker.conf.cjs',
  'stryker.config.json',
  'stryker.config.js',
  'stryker.config.mjs',
  'stryker.config.cjs',
  '.stryker.conf.json',
  '.stryker.conf.js',
  '.stryker.conf.mjs',
  '.stryker.conf.cjs',
  '.stryker.config.json',
  '.stryker.config.js',
  '.stryker.config.mjs',
  '.stryker.config.cjs',
] as const;

/**
 * Write the Stryker overlay config every run is launched with.
 *
 * The overlay inlines (for JSON) or imports (for the JS family) the project's
 * own config and layers Chaos-MCP's runtime-only settings on top. It is written
 * solely inside the disposable outer sandbox and selected explicitly as
 * Stryker's `configFile` argument, so the user's real config is never modified.
 *
 * ── Why the overlay is now UNCONDITIONAL ──
 * It used to be written only for scoped command-runner runs; a denylist-only run
 * instead merged `mutator.excludedMutations` in place into `stryker.config.json`.
 * Two verified defects came out of that (both against @stryker-mutator/core@9.6.1):
 *
 *  1. **The denylist landed in a file Stryker never read.** `SUPPORTED_CONFIG_FILE_NAMES`
 *     (config/config-file-formats.js) is ordered `stryker.conf.json`,
 *     `stryker.conf.js`, `stryker.conf.mjs`, `stryker.conf.cjs`,
 *     `stryker.config.json`, … and `ConfigReader.findConfigFile` returns the
 *     FIRST that exists. `stryker.config.json` is 5th — so a project shipping the
 *     (very common) `stryker.conf.json` or `stryker.conf.mjs` had every
 *     denylisted mutator run anyway, silently. A JS-family config also cannot be
 *     merged into textually at all; only the overlay can express it.
 *  2. **The JSON report path was not pinned.** See {@link STRIKER_JSON_REPORT}.
 *
 * Both are structural properties of "the config Stryker actually loads", so the
 * fix is to stop guessing and always hand Stryker a config we composed from the
 * one it *would* have discovered — {@link STRYKER_CONFIG_NAMES} is that same
 * ordered list.
 *
 * ── Mutator denylist semantics ──
 * StrykerJS v9 removed the v8 `--mutators` CLI flag; exclusions are expressed
 * only as `mutator.excludedMutations` (an array of PascalCase mutator names,
 * validated by Stryker at runtime). There is NO top-level `mutators` option —
 * earlier Chaos-MCP versions wrote a `mutators: { Name: false }` map that Stryker
 * silently ignored, so any such legacy map found in the project's config is
 * migrated into `excludedMutations` and the invalid key dropped. An allowlist is
 * not expressible; see {@link prepareStrykerConfig}.
 *
 * @param command — the command-runner command for a scoped `command`-runner run.
 *   `undefined` for every other run, which leaves the project's own
 *   `testRunner`/`coverageAnalysis`/`commandRunner` settings untouched — an
 *   overlay written for a native runner (vitest, jest, …) must not force the
 *   command runner on it.
 * @returns the overlay filename, to be passed as Stryker's `configFile` argument.
 */
export function writeStrykerRuntimeConfig(
  cwd: string,
  command: string | undefined,
  denylist: string[],
): string {
  const existingName = STRYKER_CONFIG_NAMES.find((name) => existsSync(join(cwd, name)));
  let baseDeclaration = 'const base = {};';
  if (existingName?.endsWith('.json')) {
    try {
      const parsed = JSON.parse(readFileSync(join(cwd, existingName), 'utf-8')) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        baseDeclaration = `const base = ${JSON.stringify(parsed)};`;
      }
    } catch {
      // Match the legacy denylist behavior: an invalid JSON config degrades to
      // an empty base and Stryker validates the generated overlay.
    }
  } else if (existingName) {
    baseDeclaration =
      `import importedConfig from ${JSON.stringify(`./${existingName}`)};\n` +
      'const base = importedConfig ?? {};';
  }

  // Only a scoped command-runner run overrides the runner. Emitting these for a
  // native-runner run would silently switch the project onto `command` (and turn
  // coverage analysis off) with no command to run.
  const commandRunnerSection =
    command === undefined
      ? ''
      : `  testRunner: 'command',
  coverageAnalysis: 'off',
  commandRunner: { ...(base.commandRunner ?? {}), command: ${JSON.stringify(command)} },
`;

  const source = `${baseDeclaration}
const legacyExcluded = Object.entries(base.mutators ?? {})
  .filter(([, enabled]) => enabled === false)
  .map(([name]) => name);
const existingExcluded = Array.isArray(base.mutator?.excludedMutations)
  ? base.mutator.excludedMutations.filter((name) => typeof name === 'string')
  : [];
const { mutators: _legacyMutators, ...withoutLegacyMutators } = base;
export default {
  ...withoutLegacyMutators,
${commandRunnerSection}  jsonReporter: { ...(base.jsonReporter ?? {}), fileName: ${JSON.stringify(STRIKER_JSON_REPORT)} },
  mutator: {
    ...(base.mutator ?? {}),
    excludedMutations: [...new Set([
      ...existingExcluded,
      ...legacyExcluded,
      ...${JSON.stringify(denylist)},
    ])],
  },
};
`;
  writeFileSync(join(cwd, CHAOS_STRYKER_CONFIG), source, 'utf-8');
  return CHAOS_STRYKER_CONFIG;
}

/**
 * Resolve the effective StrykerJS test runner for a run.
 *
 * The `?? 'command'` default is consulted from three places (`run`, `runOnce`
 * and {@link prepareStrykerConfig}), and they must agree — the config-writing
 * branch and the `--testRunner` argument are keyed off the same value.
 */
export function resolveRunner(options?: RunOptions): string {
  return options?.testRunner ?? 'command';
}

/**
 * Materialise the Stryker configuration a run needs, inside the sandbox `cwd`.
 *
 * ALWAYS returns an overlay filename: Stryker must never be left to its own
 * config discovery, because two settings Chaos-MCP depends on are otherwise at
 * the audited project's mercy — where the JSON report is written
 * (`jsonReporter.fileName`) and whether the mutator denylist is honoured at all
 * (which of the sixteen `stryker.conf|config.{json,js,mjs,cjs}` names Stryker
 * picks). See {@link writeStrykerRuntimeConfig} for the verified evidence.
 *
 * The overlay is composed FROM the project's own config, so this pins those two
 * settings without discarding anything the project configured.
 *
 * @returns the runtime-config filename to pass as Stryker's `configFile` argument.
 * @throws when a `mutatorAllowlist` is requested — v9 cannot express one.
 */
export function prepareStrykerConfig(cwd: string, options?: RunOptions): string {
  // The config model can only EXCLUDE mutators; there is no way to express
  // "only these N" without enumerating every mutator name Stryker ships. Fail
  // loudly rather than running an unrestricted mutation set the caller did not ask for.
  if (options?.mutatorAllowlist && options.mutatorAllowlist.length > 0) {
    throw new Error(
      'mutatorAllowlist is not supported in StrykerJS v9. ' +
        'Use mutatorDenylist instead, or create a stryker.config.json with explicit mutator settings. ' +
        `Requested allowlist: ${options.mutatorAllowlist.join(', ')}`,
    );
  }
  // Only a scoped command-runner run overrides the runner; every other run keeps
  // the project's own (see the `command` parameter of writeStrykerRuntimeConfig).
  const command =
    resolveRunner(options) === 'command' && options?.commandRunnerCommand
      ? options.commandRunnerCommand
      : undefined;
  return writeStrykerRuntimeConfig(cwd, command, options?.mutatorDenylist ?? []);
}
