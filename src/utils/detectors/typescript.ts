/**
 * JS/TS workspace detection: root markers, test-runner signals, and the
 * Stryker-compatibility mapping.
 */
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { readJsonSafe } from './fs-read.js';
import type { LanguageDetector } from './types.js';

/** Marker files that indicate a JS/TS project root. */
export const JS_ROOT_MARKERS = ['package.json'] as const;

/** Config files whose presence unambiguously identifies a test runner. */
const JS_CONFIG_SIGNALS: { files: string[]; runner: string }[] = [
  {
    files: ['vitest.config.ts', 'vitest.config.js', 'vitest.config.mts', 'vitest.config.mjs'],
    runner: 'vitest',
  },
  {
    files: ['jest.config.ts', 'jest.config.js', 'jest.config.mjs', 'jest.config.cjs'],
    runner: 'jest',
  },
  {
    files: ['.mocharc.yml', '.mocharc.yaml', '.mocharc.json', '.mocharc.js', '.mocharc.cjs'],
    runner: 'mocha',
  },
  {
    files: ['jasmine.json', 'spec/support/jasmine.json'],
    runner: 'jasmine',
  },
];

/**
 * Shared low-level runner detection that returns the raw runner name.
 * Callers should use {@link detectJsTestRunner} for Stryker-compatible values.
 *
 * Returns 'bun' or 'node:test' etc. when those runners are detected.
 *
 * @internal
 */
function detectJsRunnerRaw(workspaceRoot: string): string {
  // ── Priority 1: config files ──
  for (const signal of JS_CONFIG_SIGNALS) {
    for (const file of signal.files) {
      if (existsSync(join(workspaceRoot, file))) {
        return signal.runner;
      }
    }
  }

  // ── Priority 1.5: bunfig.toml or bun.lockb (bun project signals) ──
  if (
    existsSync(join(workspaceRoot, 'bunfig.toml')) ||
    existsSync(join(workspaceRoot, 'bun.lockb'))
  ) {
    return 'bun';
  }

  // ── Priority 2 & 3: package.json scanning ──
  const pkgPath = join(workspaceRoot, 'package.json');
  const pkg = readJsonSafe(pkgPath);

  if (pkg) {
    const deps = {
      ...(typeof pkg.dependencies === 'object' && pkg.dependencies !== null
        ? (pkg.dependencies as Record<string, unknown>)
        : {}),
      ...(typeof pkg.devDependencies === 'object' && pkg.devDependencies !== null
        ? (pkg.devDependencies as Record<string, unknown>)
        : {}),
    };

    // Priority 2: dependency keys
    if ('vitest' in deps) return 'vitest';
    if ('jest' in deps) return 'jest';
    if ('mocha' in deps) return 'mocha';
    if ('jasmine' in deps) return 'jasmine';
    if ('bun' in deps || 'bun-types' in deps) return 'bun';

    // Priority 3: scripts.test content
    const scripts =
      typeof pkg.scripts === 'object' && pkg.scripts !== null
        ? (pkg.scripts as Record<string, unknown>)
        : {};

    const testScript = typeof scripts.test === 'string' ? scripts.test : '';

    if (testScript.includes('vitest')) return 'vitest';
    if (testScript.includes('jest')) return 'jest';
    if (testScript.includes('mocha')) return 'mocha';
    if (testScript.includes('jasmine')) return 'jasmine';
    if (/bun (?:run )?test/.test(testScript)) return 'bun';
    if (testScript.includes('node --test') || testScript.includes('node:test')) return 'node:test';
  }

  // ── Priority 4: generic fallback ──
  return 'command';
}

/**
 * Read the version of a package actually installed in the workspace, or null
 * when it can't be determined. Reads node_modules/<name>/package.json — the
 * version that will actually run — rather than the declared semver range,
 * which may be a caret/range that doesn't pin a single major.
 */
function installedPackageVersion(workspaceRoot: string, name: string): string | null {
  // Walk up ancestor node_modules (Node's own resolution order) so a package
  // hoisted to a monorepo/workspace root is still found — not just one installed
  // directly under workspaceRoot.
  let dir = workspaceRoot;
  for (;;) {
    const pkg = readJsonSafe(join(dir, 'node_modules', name, 'package.json'));
    if (pkg && typeof pkg.version === 'string') return pkg.version;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Leading numeric parts of a version string, `[major, minor]`, or null. */
function majorMinor(version: string): [number, number] | null {
  const [major, minor] = version.split('.').map((part) => Number.parseInt(part, 10));
  return Number.isInteger(major) && Number.isInteger(minor) ? [major, minor] : null;
}

/** MAJOR version of the installed vitest, or null when it can't be determined. */
function installedVitestMajor(workspaceRoot: string): number | null {
  const version = installedPackageVersion(workspaceRoot, 'vitest');
  if (version === null) return null;
  const major = Number.parseInt(version.split('.')[0], 10);
  return Number.isInteger(major) ? major : null;
}

/**
 * Minimum vitest major that `@stryker-mutator/vitest-runner` can drive.
 *
 * The runner declares `vitest: >=2.0.0` as a peer. Below that, the native
 * runner is not supported and the command runner is the compatible path.
 */
export const MIN_NATIVE_VITEST_MAJOR = 2;

/**
 * Highest vitest major that `@stryker-mutator/vitest-runner` is VERIFIED to
 * drive correctly.
 *
 * The runner's declared peer range is an open `vitest: >=2.0.0`, which is a
 * claim rather than a guarantee, so this ceiling is measured instead. Above it
 * the command runner is the compatible path.
 *
 * Why a ceiling exists at all: on vitest 5, `vitest-runner@10.0.0` reports every
 * mutant as Survived. It does not throw, and the dry run SUCCEEDS, so no error
 * classifier and no dry-run fallback can catch it. One fixture, one variable
 * changed:
 *
 *     native runner,  vitest 4.1.11  ->  Killed, Killed, Survived, Killed, Killed
 *     native runner,  vitest 5.0.1   ->  Survived x5
 *     command runner, vitest 5.0.1   ->  Killed, Killed, Survived, Killed, Killed
 *
 * A survivor is a coverage hole in this tool's vocabulary, so the native runner
 * turns a healthy vitest 5 suite into a total false-positive flood presented
 * with full confidence. That is the one failure mode a mutation-testing tool
 * must never have, and it outranks what the fallback costs: the command runner
 * grades a black-box exit code, which forces `coverageAnalysis: 'off'` and
 * re-runs the related-test set per mutant. Slower and correct beats fast and
 * wrong.
 *
 * Raised to 5 on measured evidence. StrykerJS 10.1.0 fixed the name filter
 * (stryker-js#6210, #6214); on npm it ships as 10.1.1, since 10.1.0 never
 * reached the registry. A 12-mutant fixture with `coverageAnalysis: 'perTest'`:
 *
 *     native runner 10.0.0, vitest 4.1.11  ->  10 Killed, 2 Survived
 *     native runner 10.0.0, vitest 5.0.5   ->  12 Survived, testsCompleted 0
 *     native runner 10.1.1, vitest 5.0.5   ->  10 Killed, 2 Survived (same two)
 *
 * The fix lives in the runner, not in vitest, so a vitest 5 workspace only gets
 * the native runner when the installed runner is new enough; see
 * {@link MIN_RUNNER_FOR_VITEST_MAJOR}.
 *
 * Raise this the same way, on measured evidence: run a fixture with a known
 * Killed/Survived split on the new major and confirm the split survives the
 * native runner.
 */
export const MAX_NATIVE_VITEST_MAJOR = 5;

/**
 * Lowest `@stryker-mutator/vitest-runner` version, as `[major, minor]`, that
 * drives a given vitest major correctly. A major missing here has no runner
 * floor beyond the vitest window itself.
 *
 * vitest 5 changed `testNamePattern` to match the suite chain joined by `' > '`,
 * and runners before 10.1.0 still joined names with a space, so the per-mutant
 * filter matched nothing. A runner that cannot be found counts as too old: with
 * no runner installed the native path cannot work anyway, and the command
 * runner is the one that fails loudly instead of quietly.
 */
export const MIN_RUNNER_FOR_VITEST_MAJOR: Readonly<Record<number, readonly [number, number]>> = {
  5: [10, 1],
};

/** Whether the installed vitest-runner meets the floor for `vitestMajor`. */
function runnerSupportsVitestMajor(workspaceRoot: string, vitestMajor: number): boolean {
  const floor = MIN_RUNNER_FOR_VITEST_MAJOR[vitestMajor];
  if (floor === undefined) return true;
  const version = installedPackageVersion(workspaceRoot, '@stryker-mutator/vitest-runner');
  const installed = version === null ? null : majorMinor(version);
  if (installed === null) return false;
  return installed[0] > floor[0] || (installed[0] === floor[0] && installed[1] >= floor[1]);
}

/**
 * Map a raw runner name to a Stryker-compatible value.
 * Runners without native Stryker plugins (bun, node:test) map to 'command'.
 *
 * HISTORY, because the previous rule here was built on a false premise and the
 * correction matters more than the rule: this used to force vitest projects on
 * major >= 3 onto Stryker's command runner, on the stated grounds that vitest 3
 * removed the `--related` / `config.related` API `@stryker-mutator/vitest-runner`
 * depends on. It did not. vitest 3 and 4 both still ship `related`; the real
 * blocker was vitest-runner 9.x itself.
 *
 * That fallback cost every modern vitest project per-mutant coverage: the
 * command runner grades a black-box exit code, which forces
 * `coverageAnalysis: 'off'` and re-runs the whole related-test set for every
 * single mutant.
 *
 * StrykerJS 10 resolves it, and the fallback is lifted on measured evidence
 * rather than on the same kind of assumption that created it. Both majors the
 * old rule excluded were exercised against `@stryker-mutator/vitest-runner@10`
 * with `coverageAnalysis: 'perTest'`:
 *   - vitest 4.1.11 — this repo's own suite, plus src/__tests__/e2e-stryker.test.ts
 *   - vitest 3.2.7  — a standalone fixture: 4 killed, 1 survived, 80% score
 *
 * What the range became is a measured window rather than a one-sided floor. The
 * floor is the runner's own declared peer range; the ceiling is
 * {@link MAX_NATIVE_VITEST_MAJOR}, which exists because the declared range is an
 * open `>=2.0.0` that vitest 5 falsifies. Both ends now say the same thing: a
 * major is supported when someone has run mutants through it, not when a peer
 * range permits it.
 */
function toStrykerRunner(raw: string, workspaceRoot: string): string {
  if (raw === 'bun' || raw === 'node:test') return 'command';
  if (raw === 'vitest' && unsupportedNativeVitestMajor(workspaceRoot) !== null) return 'command';
  return raw;
}

/**
 * The installed vitest MAJOR when it sits outside the range
 * `@stryker-mutator/vitest-runner` is verified against, or when the installed
 * runner is older than that major needs, or null when it is in range or cannot
 * be determined.
 *
 * Shared so the detector and the engine cannot drift: the detector routes an
 * out-of-range workspace to the command runner, and the engine uses the same
 * answer to warn an operator who pinned `testRunner: 'vitest'` in config and so
 * bypassed that routing. Returning the number rather than a boolean is what lets
 * the warning name the version the operator actually has.
 */
export function unsupportedNativeVitestMajor(workspaceRoot: string): number | null {
  const major = installedVitestMajor(workspaceRoot);
  if (major === null) return null;
  if (major < MIN_NATIVE_VITEST_MAJOR || major > MAX_NATIVE_VITEST_MAJOR) return major;
  return runnerSupportsVitestMajor(workspaceRoot, major) ? null : major;
}

/**
 * Detect the JS/TS test runner from workspace signals, returning a
 * Stryker-compatible value.
 *
 * Priority order:
 * 1. Dedicated config files (vitest.config.*, jest.config.*, .mocharc.*, jasmine.json, bunfig.toml)
 * 2. package.json dependencies / devDependencies
 * 3. package.json scripts.test content
 * 4. Fallback: 'command' (Stryker's generic npm test runner)
 *
 * Runners without native Stryker plugins (bun, node:test) are detected
 * but mapped to 'command' since Stryker falls back to `npm test`.
 * Use {@link detectRawJsRunner} to get the unmapped value.
 *
 * @internal Exported for testing only.
 */
export function detectJsTestRunner(workspaceRoot: string): string {
  return toStrykerRunner(detectJsRunnerRaw(workspaceRoot), workspaceRoot);
}

/**
 * Detect the raw JS/TS test runner from workspace signals, without mapping
 * to Stryker-compatible values.
 *
 * Returns 'bun' or 'node:test' when those runners are detected, unlike
 * {@link detectJsTestRunner} which maps them to 'command'.
 *
 * @internal Exported for testing only.
 */
export function detectRawJsRunner(workspaceRoot: string): string {
  return detectJsRunnerRaw(workspaceRoot);
}

export const typescriptDetector: LanguageDetector = {
  matches: (p) => /\.(c|m)?[jt]sx?$/.test(p),
  // The ESM/CJS variants are listed so the tool schema advertises them: they
  // have always been auditable (`matches` accepts them) but went unmentioned,
  // and a model does not ask for a file type the description omits.
  // `primaryExtensions` keeps the space-constrained prose short.
  extensions: ['.ts', '.js', '.tsx', '.jsx', '.mjs', '.cjs', '.mts', '.cts'],
  primaryExtensions: ['.ts', '.js'],
  markers: JS_ROOT_MARKERS,
  testRunner: detectJsTestRunner,
  rawRunner: detectRawJsRunner,
};
