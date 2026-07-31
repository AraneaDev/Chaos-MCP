/**
 * Re-anchoring a caller-supplied path onto the detected workspace root.
 *
 * All three tool handlers (`handler.ts`, `estimate-handler.ts`,
 * `triage-handler.ts`) received a path relative to `process.cwd()` but must
 * hand the engine — and the sandbox — a path relative to `env.workspaceRoot`,
 * which can be a subdirectory of cwd in a monorepo (High#1 / Med#9). Each one
 * carried a verbatim copy of the same guarded `relative()` expression, so a fix
 * to one silently left the other two behind.
 *
 * This lives beside `path-safety.ts` rather than inside it on purpose:
 * `path-safety` answers security questions ("may this process touch that
 * path?") with realpath-resolved booleans, whereas this helper only reshapes a
 * path and needs the computed relative string as a value — it grants no access
 * and makes no boundary decision. The lexical containment test it applies is
 * the same one `isPathInside` performs; keeping it inline avoids computing
 * `relative()` twice for a value this function must return anyway.
 */
import { relative, isAbsolute } from 'node:path';

/** A file expressed both as a workspace-relative key and as an engine target. */
export interface WorkspaceAnchor {
  /**
   * `resolvedFile` relative to `workspaceRoot`. The key contract for the run
   * cache and the suppressions file — audit and triage must agree on it.
   */
  relFromRoot: string;
  /**
   * The path to hand the sandbox and the engine: `relFromRoot` when it is a
   * clean descendant path, else `fallback`.
   */
  targetFile: string;
}

/**
 * Express `resolvedFile` relative to `workspaceRoot`.
 *
 * Falls back to `fallback` (the caller's original path) when the root is not a
 * real ancestor of the file — an empty relative path (file *is* the root), a
 * `..` escape, or an absolute result on a different drive. Defensive: in
 * production the workspace-root clamp already guarantees ancestry.
 */
export function anchorToWorkspace(
  workspaceRoot: string,
  resolvedFile: string,
  fallback: string,
): WorkspaceAnchor {
  const relFromRoot = relative(workspaceRoot, resolvedFile);
  const targetFile =
    relFromRoot.length > 0 && !relFromRoot.startsWith('..') && !isAbsolute(relFromRoot)
      ? relFromRoot
      : fallback;
  return { relFromRoot, targetFile };
}
