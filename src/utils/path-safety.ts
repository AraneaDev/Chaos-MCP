/**
 * Path-safety helpers shared across the codebase.
 *
 * Audit A3: extracted from handler.ts so the boundary-check logic can be
 * imported freely without creating a cycle through handler.ts. handler.ts
 * re-exports `isRealPathInside` for backward compatibility with existing
 * callers (estimate-handler, triage-handler); new code should import
 * directly from this module.
 */
import { relative, isAbsolute, resolve, delimiter } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * Environment variable naming additional directories this process may audit,
 * separated by the platform path delimiter (`:` on POSIX, `;` on Windows).
 */
export const ALLOWED_ROOTS_ENV = 'CHAOS_ALLOWED_ROOTS';

/**
 * Extra workspace roots this process is permitted to sandbox, beyond its own
 * working directory.
 *
 * An MCP server is launched with one fixed cwd, and both the workspace-root
 * walk and the sandbox guard clamp to it — so a server started in project A
 * cannot audit project B at all, even when the operator wants exactly that.
 * This opt-in list restores that ability without dropping the boundary: only
 * roots the operator named in the server definition are reachable, and the
 * variable being unset leaves the cwd-only behaviour untouched.
 *
 * Read fresh on each call rather than cached at import: tests set the variable
 * per case, and an MCP server is long-lived enough that a cached empty list
 * would outlive a configuration change.
 *
 * Relative entries resolve against the current working directory. Blank
 * segments are dropped — an empty entry would otherwise resolve to cwd and
 * silently widen nothing, or worse read as "everything" to a future reader.
 */
export function allowedWorkspaceRoots(): string[] {
  const raw = process.env[ALLOWED_ROOTS_ENV];
  if (raw === undefined) return [];
  // No whitespace-only fast path: the trim + length filter below already maps
  // '   ' to an empty list, so an extra guard here would be unreachable in
  // effect (mutation testing flagged all three of its mutants as equivalent).
  return raw
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => resolve(entry));
}

/**
 * True when `candidate` may be used as a workspace root: it is inside the
 * process working directory, or inside one of {@link allowedWorkspaceRoots}.
 *
 * Symlinks are resolved on both sides (see {@link isRealPathInside}) so an
 * allowed root cannot be widened by pointing a symlink out of it.
 */
export function isWorkspaceRootAllowed(candidate: string): boolean {
  return isPathPermitted(candidate);
}

/**
 * True when `candidate` lies inside a directory this process may touch: the
 * working directory, or one of {@link allowedWorkspaceRoots}. Same boundary as
 * {@link isWorkspaceRootAllowed}, named for the callers that ask about a file
 * rather than about a root.
 *
 * The tool handlers validate their path arguments against this. Clamping them
 * to cwd alone made {@link ALLOWED_ROOTS_ENV} unreachable in practice: every
 * call was rejected at the entry point, before the sandbox — the layer the
 * opt-in was built into — ever saw the path.
 */
export function isPathPermitted(candidate: string): boolean {
  if (isRealPathInside(candidate, resolve(process.cwd()))) return true;
  return allowedWorkspaceRoots().some((root) => isRealPathInside(candidate, root));
}

/**
 * The workspace root to NAME in a report, or `undefined` when naming it would
 * be noise.
 *
 * A result's `target` is relative to the workspace the AUDITED FILE belongs to,
 * which is not always the directory the caller's path was relative to. When the
 * two differ, `target` is a path the caller never wrote and cannot resolve:
 *
 *  - A second project in reach via {@link ALLOWED_ROOTS_ENV}: a caller asks for
 *    `../termaxa/src/policy.rs` and gets back `src/policy.rs`, which names no
 *    project — and a file of the same name in the server's own tree reports
 *    identically.
 *  - A MONOREPO, with no allowed roots involved at all: the marker walk stops at
 *    the package (`packages/api/package.json`), so a caller asks for
 *    `packages/api/src/math.ts` and gets back `src/math.ts`. That path does not
 *    exist from the working directory, and every package with a `src/math.ts`
 *    reports the same string.
 *
 * The test is therefore INEQUALITY WITH THE WORKING DIRECTORY, not "outside" it.
 * Containment was the first thing tried and it silently excluded the monorepo
 * case — the commoner of the two — because a package root is inside the repo
 * root by construction.
 *
 * Absolute rather than relative-to-cwd: this exists to disambiguate, and
 * `../termaxa` cannot be placed by a reader who does not know the cwd. It also
 * gives the field a mechanical use — `join(workspace, target)` is a path the
 * tools accept back as `filePath`, which `target` alone is not.
 *
 * `undefined` when the workspace IS the working directory, so the field stays
 * absent from every report that was already unambiguous.
 */
export function reportableWorkspace(workspaceRoot: string): string | undefined {
  const resolved = resolve(workspaceRoot);
  // Symlinks resolved on both sides, as everywhere else in this module: a cwd
  // reached through a symlink must not read as a different workspace from the
  // same directory reached directly, or every report would carry the field.
  if (realPathOf(resolved) === realPathOf(resolve(process.cwd()))) return undefined;
  return resolved;
}

/**
 * The boundary the upward workspace-root walk must not climb past for a file at
 * `fileDir`: the innermost allowed root containing it, else the process cwd.
 *
 * Returning the *innermost* match matters when roots nest (e.g. a monorepo and
 * one of its packages both listed) — clamping to the outer one would let the
 * marker walk escape the package and resolve the wrong workspace.
 */
export function workspaceRootBoundary(fileDir: string): string {
  const cwd = resolve(process.cwd());
  if (isRealPathInside(fileDir, cwd)) return cwd;

  let boundary: string | null = null;
  for (const root of allowedWorkspaceRoots()) {
    if (!isRealPathInside(fileDir, root)) continue;
    // `>` vs `>=` is an equivalent mutation here and is left unpinned: two
    // DIFFERENT roots of equal length cannot both be ancestors of the same
    // directory, so the tie branch is unreachable.
    if (boundary === null || root.length > boundary.length) boundary = root;
  }
  return boundary ?? cwd;
}

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
  return isPathInside(realPathOf(candidate), realPathOf(root));
}

/**
 * A path's real location, falling back to the path itself when it cannot be
 * resolved (it does not exist yet, or is unreadable).
 *
 * Extracted from {@link isRealPathInside} so {@link reportableWorkspace} can
 * compare two paths for identity under the same symlink rules the containment
 * checks use. Two spellings of one directory must not read as two workspaces.
 */
function realPathOf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
