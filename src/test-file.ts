import { existsSync } from 'fs';
import { join, dirname, basename, extname } from 'path';
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
