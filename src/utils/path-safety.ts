/**
 * Path-safety helpers shared across the codebase.
 *
 * Audit A3: extracted from handler.ts so the boundary-check logic can be
 * imported freely without creating a cycle through handler.ts. handler.ts
 * re-exports `isRealPathInside` for backward compatibility with existing
 * callers (estimate-handler, triage-handler); new code should import
 * directly from this module.
 */
import { relative, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * Returns true when `candidate` is `root` itself, or a path strictly inside
 * `root` (no `..` traversal, no absolute escape).
 */
export function isPathInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Resolve symlinks (falling back to the lexical path when the target does not
 * exist), then test lexical containment. Defense-in-depth against a symlink
 * whose lexical path is inside the workspace but resolves outside it.
 */
export function isRealPathInside(candidate: string, root: string): boolean {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return isPathInside(real(candidate), real(root));
}
