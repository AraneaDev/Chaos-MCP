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
 * Read the MAJOR version of the vitest actually installed in the workspace,
 * or null when it can't be determined. Reads node_modules/vitest/package.json
 * — the version that will actually run — rather than the declared semver range,
 * which may be a caret/range that doesn't pin a single major.
 */
function installedVitestMajor(workspaceRoot: string): number | null {
  // Walk up ancestor node_modules (Node's own resolution order) so a vitest
  // hoisted to a monorepo/workspace root is still found — not just one installed
  // directly under workspaceRoot.
  let dir = workspaceRoot;
  for (;;) {
    const pkg = readJsonSafe(join(dir, 'node_modules', 'vitest', 'package.json'));
    const version = pkg && typeof pkg.version === 'string' ? pkg.version : null;
    if (version !== null) {
      const major = Number.parseInt(version.split('.')[0], 10);
      return Number.isInteger(major) ? major : null;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Map a raw runner name to a Stryker-compatible value.
 * Runners without native Stryker plugins (bun, node:test) map to 'command'.
 *
 * vitest 3.x fallback: StrykerJS 9's `@stryker-mutator/vitest-runner` is
 * incompatible with vitest 3 (it relies on vitest 2's removed `--related`
 * API), so the native runner aborts the run. When the installed vitest is
 * major >= 3 we fall back to Stryker's built-in command runner (`npm test`),
 * which drives any framework as a black box — mutation testing still works,
 * at the cost of no per-mutant coverage optimization (the full suite runs per
 * mutant). vitest <= 2 (or an undeterminable version) keeps the faster native
 * vitest-runner, so behavior is unchanged for those projects.
 */
function toStrykerRunner(raw: string, workspaceRoot: string): string {
  if (raw === 'bun' || raw === 'node:test') return 'command';
  if (raw === 'vitest') {
    const major = installedVitestMajor(workspaceRoot);
    if (major !== null && major >= 3) return 'command';
  }
  return raw;
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
