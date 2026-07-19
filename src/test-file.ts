import { existsSync, readdirSync } from 'fs';
import { join, dirname, basename, extname, relative, sep } from 'path';
import type { SupportedProjectType } from './engines/registry.js';

/**
 * Candidate test-file paths (workspace-root-relative) for a target, in priority
 * order. The first that exists on disk wins; if none exist, the first candidate
 * is returned as the "would create" suggestion.
 */
function candidates(targetFile: string, projectType: SupportedProjectType): string[] {
  const dir = dirname(targetFile);
  const ext = extname(targetFile);
  const base = basename(targetFile, ext);
  const j = (...p: string[]) => p.join('/').replace(/^\.\//, '');

  switch (projectType) {
    case 'typescript': {
      return [
        j(dir, `${base}.test${ext}`),
        j(dir, `${base}.spec${ext}`),
        j(dir, '__tests__', `${base}.test${ext}`),
        j('test', `${base}.test${ext}`),
        j('tests', `${base}.test${ext}`),
      ];
    }
    case 'python':
      return [j(dir, `test_${base}.py`), j('tests', `test_${base}.py`)];
    case 'rust':
      // Rust convention is in-file #[cfg(test)]; suggest the source file itself,
      // then an integration-test fallback under tests/.
      return [targetFile, j('tests', `${base}.rs`)];
    case 'php': {
      // PHPUnit convention: <ClassName>Test.php, conventionally under tests/.
      const cap = base.charAt(0).toUpperCase() + base.slice(1);
      return [
        j(dir, `${base}Test.php`),
        j('tests', `${cap}Test.php`),
        j('tests', `${base}Test.php`),
      ];
    }
    default:
      return [];
  }
}

/** Directory names never worth descending into when hunting for test files. */
const TEST_SEARCH_SKIP = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'coverage',
  'target',
  'vendor',
  '.stryker-tmp',
  '.chaos-mcp',
]);

/**
 * Recursively collect files named exactly `name` under `absDir`, returning
 * workspace-root-relative POSIX paths. Bounded in depth and breadth so it stays
 * cheap on large trees; silently skips unreadable directories.
 */
function collectByName(
  absDir: string,
  name: string,
  workspaceRoot: string,
  out: string[],
  depth: number,
): void {
  if (depth > 8 || out.length >= 16) return;
  let entries: import('fs').Dirent[];
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (TEST_SEARCH_SKIP.has(e.name)) continue;
      collectByName(join(absDir, e.name), name, workspaceRoot, out, depth + 1);
    } else if (e.name === name) {
      out.push(relative(workspaceRoot, join(absDir, e.name)).split(sep).join('/'));
    }
  }
}

/**
 * Best-effort list of Python test files covering `targetFile`, for DEFAULT
 * test-command scoping (workspace-root-relative POSIX paths). Without this, the
 * cosmic-ray engine runs the ENTIRE suite per mutant — impractical on real
 * projects and prone to unrelated baseline failures.
 *
 * Resolution: the conventional `test_<base>.py` co-located with the source and
 * directly under `tests/`, plus any `test_<base>.py` found by a bounded
 * recursive walk of `tests/` (covers `tests/unit/<pkg>/test_<base>.py` layouts).
 * Returns `[]` when nothing matches, so the caller falls back to the whole suite.
 *
 * Note: this scopes to the UNIT module by name; mutants also covered only by
 * differently-named suites (integration/adversarial) may show as survivors.
 * Operators can widen coverage via the `cosmicray.testSelection` config.
 */
export function findPythonTestSelection(targetFile: string, workspaceRoot: string): string[] {
  let base: string;
  try {
    base = basename(targetFile, extname(targetFile));
  } catch {
    return [];
  }
  if (!base || base.startsWith('test_')) return [];
  const name = `test_${base}.py`;
  const found: string[] = [];

  for (const rel of [join(dirname(targetFile), name), join('tests', name)]) {
    const norm = rel.split(sep).join('/');
    if (existsSync(join(workspaceRoot, norm))) found.push(norm);
  }
  const testsRoot = join(workspaceRoot, 'tests');
  if (existsSync(testsRoot)) collectByName(testsRoot, name, workspaceRoot, found, 0);

  return [...new Set(found)];
}

const PYTHON_TEST_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  'build',
  'dist',
  '.tox',
  'site-packages',
]);

function isPythonTestFile(name: string): boolean {
  return name.endsWith('.py') && (name.startsWith('test_') || name.endsWith('_test.py'));
}

/**
 * Depth bound for the Python test-file walk. pytest itself has no depth limit,
 * so the bound exists only to keep the walk from running away on pathological
 * trees; 24 levels clears realistic monorepo layouts (e.g.
 * `packages/<svc>/src/<pkg>/.../tests/unit/...`) with room to spare, and the
 * walk short-circuits on the first hit while skipping heavyweight directories.
 */
const PYTHON_TEST_MAX_DEPTH = 24;

/** Outcome of the Python test-file walk. */
export interface PythonTestScan {
  /** At least one pytest-discoverable test file was seen. */
  found: boolean;
  /**
   * The walk stopped at `maxDepth` somewhere without exhausting the tree, so a
   * `found: false` result is inconclusive and must NOT be treated as proof that
   * the project has no tests.
   */
  depthLimited: boolean;
}

/**
 * Scans the workspace for at least one Python test file.
 *
 * Distinguishes "this project has no Python tests" from "the test suite is
 * failing" — pytest exits 5 for the former, which must not be reported as a
 * broken suite. Also distinguishes a tree-exhausted miss (confidently no tests)
 * from a depth-limited miss (unknown), so callers can fail closed only when the
 * scan is actually conclusive.
 */
export function workspaceHasPythonTests(
  workspaceRoot: string,
  maxDepth = PYTHON_TEST_MAX_DEPTH,
): PythonTestScan {
  let depthLimited = false;

  const walk = (dir: string, depth: number): boolean => {
    if (depth > maxDepth) {
      depthLimited = true;
      return false;
    }
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (PYTHON_TEST_IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        if (walk(join(dir, entry.name), depth + 1)) return true;
      } else if (entry.isFile() && isPythonTestFile(entry.name)) {
        return true;
      }
    }
    return false;
  };

  const found = walk(workspaceRoot, 0);
  return { found, depthLimited: found ? false : depthLimited };
}

/**
 * Directories worth hunting recursively for a test file, beyond the fixed
 * candidates: the common top-level test roots plus the target's own top-level
 * segment and directory (covers `src/__tests__/...` and deeply co-located
 * layouts). Only existing directories are returned, deduped, workspace-relative.
 */
function searchRoots(targetFile: string, workspaceRoot: string): string[] {
  const dir = dirname(targetFile);
  const topSegment = targetFile.split('/')[0];
  const roots: string[] = [];
  for (const rel of ['tests', 'test', 'spec', '__tests__', topSegment, dir]) {
    if (!rel || rel === '.' || rel === targetFile || roots.includes(rel)) continue;
    try {
      if (existsSync(join(workspaceRoot, rel))) roots.push(rel);
    } catch {
      // ignore and keep probing
    }
  }
  return roots;
}

/** How many of `sourceDir`'s path segments also appear in `candidateDir`. */
function segmentOverlap(sourceDir: string, candidateDir: string): number {
  const candidateSegments = new Set(candidateDir.split('/').filter((s) => s && s !== '.'));
  return sourceDir.split('/').filter((s) => s && s !== '.' && candidateSegments.has(s)).length;
}

export function suggestTestFile(
  targetFile: string,
  projectType: SupportedProjectType,
  workspaceRoot: string,
): { path: string; exists: boolean } | undefined {
  let cands: string[];
  try {
    cands = candidates(targetFile, projectType);
  } catch {
    return undefined;
  }
  if (cands.length === 0) return undefined;
  for (const rel of cands) {
    try {
      if (existsSync(join(workspaceRoot, rel))) return { path: rel, exists: true };
    } catch {
      // ignore and keep probing
    }
  }

  // No fixed candidate exists — hunt the common test roots recursively for a
  // file matching a candidate basename, covering nested layouts the fixed list
  // can't express (e.g. tests/unit/<pkg>/<base>.test.ts). Rust is excluded:
  // its first candidate is the source file itself, so a workspace-wide name
  // hunt would surface unrelated same-named sources.
  if (projectType !== 'rust') {
    const dir = dirname(targetFile);
    // Candidate order encodes priority (.test before .spec) — probe name-major.
    for (const name of [...new Set(cands.map((c) => basename(c)))]) {
      const found: string[] = [];
      for (const rootRel of searchRoots(targetFile, workspaceRoot)) {
        collectByName(join(workspaceRoot, rootRel), name, workspaceRoot, found, 0);
      }
      const unique = [...new Set(found)];
      if (unique.length > 0) {
        unique.sort(
          (a, b) =>
            segmentOverlap(dir, dirname(b)) - segmentOverlap(dir, dirname(a)) ||
            a.length - b.length ||
            a.localeCompare(b),
        );
        return { path: unique[0], exists: true };
      }
    }
  }

  return { path: cands[0], exists: false };
}
