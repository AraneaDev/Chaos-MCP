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
    case 'go':
      return [j(dir, `${base}_test.go`)];
    case 'rust':
      // Rust convention is in-file #[cfg(test)]; suggest the source file itself,
      // then an integration-test fallback under tests/.
      return [targetFile, j('tests', `${base}.rs`)];
    default:
      return [];
  }
}

/** Directory names never worth descending into when hunting for test files. */
const TEST_SEARCH_SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__']);

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
  return { path: cands[0], exists: false };
}
