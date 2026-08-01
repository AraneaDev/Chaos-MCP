import { describe, it, expect } from 'vitest';
import { COMMON_IGNORE_DIRS } from '../utils/ignore-dirs.js';
import { ALWAYS_EXCLUDE } from '../utils/sandbox.js';
import { IGNORE_DIRS } from '../triage/discover-files.js';
import { TEST_SEARCH_SKIP, PYTHON_TEST_IGNORE_DIRS } from '../test-file.js';

/**
 * Regression guard for Finding #7: four hand-maintained "directories to skip"
 * lists that drifted twice into production bugs (a Python `.venv/` eating the
 * whole triage `maxFiles` budget; `vendor` missing from `ALWAYS_EXCLUDE` and
 * failing every PHP provision). They now compose one shared
 * {@link COMMON_IGNORE_DIRS} leaf plus per-consumer extras.
 *
 * The refactor was required to be behaviour-preserving, so each consumer's
 * EFFECTIVE set is pinned byte-for-byte to what it was before — the analogue of
 * how sandbox.test.ts pins `SYMLINK_DIRS`. Sorted comparison, because every
 * consumer looks these up with `Set.has` and iteration order is not load-bearing
 * for any of them.
 *
 * These lists are still deliberately DIFFERENT from one another (see each
 * consumer's docblock). Changing one is allowed; changing one *by accident*,
 * because an entry was added to the shared leaf, is what this test catches.
 */
const sorted = (s: Iterable<string>): string[] => [...s].sort();

describe('COMMON_IGNORE_DIRS', () => {
  it('is exactly the names all four consumers agree on', () => {
    expect(sorted(COMMON_IGNORE_DIRS)).toEqual([
      '.git',
      '.venv',
      '__pycache__',
      'build',
      'dist',
      'node_modules',
      'venv',
    ]);
  });

  it('has no duplicates, so every consumer set is the size it looks', () => {
    expect(new Set(COMMON_IGNORE_DIRS).size).toBe(COMMON_IGNORE_DIRS.length);
  });

  it('really is the intersection — every entry is in all four consumers', () => {
    // Guards the other direction from the per-consumer pins: an entry could be
    // hoisted here that one consumer never had, silently widening it.
    const missing: string[] = [];
    for (const dir of COMMON_IGNORE_DIRS) {
      if (!ALWAYS_EXCLUDE.has(dir)) missing.push(`ALWAYS_EXCLUDE:${dir}`);
      if (!IGNORE_DIRS.has(dir)) missing.push(`IGNORE_DIRS:${dir}`);
      if (!TEST_SEARCH_SKIP.has(dir)) missing.push(`TEST_SEARCH_SKIP:${dir}`);
      if (!PYTHON_TEST_IGNORE_DIRS.has(dir)) missing.push(`PYTHON_TEST_IGNORE_DIRS:${dir}`);
    }
    expect(missing).toEqual([]);
  });

  it('is maximal — no name common to all four is left out of the shared leaf', () => {
    const inAllFour = [...ALWAYS_EXCLUDE].filter(
      (d) => IGNORE_DIRS.has(d) && TEST_SEARCH_SKIP.has(d) && PYTHON_TEST_IGNORE_DIRS.has(d),
    );
    expect(sorted(inAllFour)).toEqual(sorted(COMMON_IGNORE_DIRS));
  });
});

describe('each consumer keeps its pre-refactor effective set', () => {
  it('ALWAYS_EXCLUDE (utils/sandbox.ts copy filter)', () => {
    expect(sorted(ALWAYS_EXCLUDE)).toEqual([
      '.env',
      '.git',
      '.mutmut-cache',
      '.next',
      '.nyc_output',
      '.pytest_cache',
      '.stryker-tmp',
      '.svn',
      '.tox',
      '.venv',
      '__pycache__',
      'build',
      'chaos-infection-log.json',
      'coverage',
      'dist',
      'node_modules',
      'target',
      'venv',
    ]);
  });

  it('IGNORE_DIRS (triage/discover-files.ts discovery walker)', () => {
    expect(sorted(IGNORE_DIRS)).toEqual([
      '.cache',
      '.git',
      '.next',
      '.stryker-tmp',
      '.tox',
      '.venv',
      '__pycache__',
      '__tests__',
      'build',
      'coverage',
      'dist',
      'env',
      'node_modules',
      'out',
      'reports',
      'site-packages',
      'target',
      'tests',
      'vendor',
      'venv',
    ]);
  });

  it('TEST_SEARCH_SKIP (test-file.ts test-file finder)', () => {
    expect(sorted(TEST_SEARCH_SKIP)).toEqual([
      '.chaos-mcp',
      '.git',
      '.stryker-tmp',
      '.venv',
      '__pycache__',
      'build',
      'coverage',
      'dist',
      'node_modules',
      'target',
      'vendor',
      'venv',
    ]);
  });

  it('PYTHON_TEST_IGNORE_DIRS (test-file.ts pytest-presence scan)', () => {
    expect(sorted(PYTHON_TEST_IGNORE_DIRS)).toEqual([
      '.git',
      '.tox',
      '.venv',
      '__pycache__',
      'build',
      'dist',
      'node_modules',
      'site-packages',
      'venv',
    ]);
  });
});

describe('the drift the refactor deliberately did NOT close', () => {
  it('TEST_SEARCH_SKIP still hunts inside test roots the triage walker prunes', () => {
    // Load-bearing: the finder is looking FOR these directories.
    for (const dir of ['tests', '__tests__']) {
      expect(IGNORE_DIRS.has(dir)).toBe(true);
      expect(TEST_SEARCH_SKIP.has(dir)).toBe(false);
    }
  });

  it('TEST_SEARCH_SKIP still descends into caches the others prune', () => {
    // Not load-bearing, just untouched — widening it changes which test files
    // are discovered, which is a behaviour change and a separate decision.
    for (const dir of ['.tox', 'out', '.next', '.cache', 'reports', 'site-packages']) {
      expect(TEST_SEARCH_SKIP.has(dir)).toBe(false);
    }
  });

  it('ALWAYS_EXCLUDE still omits vendor, which SYMLINK_DIRS covers structurally', () => {
    // The PHP provisioning bug was fixed by deriving the copy exclusions from
    // the per-audit symlink list, NOT by re-adding vendor here. Pinned so a
    // future edit cannot quietly re-couple the two.
    expect(ALWAYS_EXCLUDE.has('vendor')).toBe(false);
    expect(IGNORE_DIRS.has('vendor')).toBe(true);
    expect(TEST_SEARCH_SKIP.has('vendor')).toBe(true);
  });
});
