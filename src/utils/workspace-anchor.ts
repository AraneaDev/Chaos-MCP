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
import { relative, isAbsolute, sep } from 'node:path';

/** A file expressed both as a workspace-relative key and as an engine target. */
export interface WorkspaceAnchor {
  /**
   * `resolvedFile` relative to `workspaceRoot`, with POSIX (`/`) separators.
   *
   * The key contract for the run cache and the suppressions file — audit and
   * triage must agree on it. The separator normalisation is what makes that
   * agreement hold ACROSS machines: `relative()` returns the platform
   * separator, so an unnormalised key is `src\utils\foo.ts` on Windows and
   * `src/utils/foo.ts` on Linux CI. Since the suppressions file is documented
   * as portable/committable (`audit/suppression-io.ts`), the two would be
   * written and looked up under different keys, `Map.get` would miss, and
   * every suppression would stop applying — SILENTLY, because a missing key
   * yields an empty verdict, so neither `drifted` nor `unverified` increments
   * to say anything went wrong.
   */
  relFromRoot: string;
  /**
   * The path to hand the sandbox and the engine: the workspace-relative path
   * when it is a clean descendant path, else `fallback`.
   *
   * Deliberately keeps the PLATFORM separator rather than reusing the
   * normalised `relFromRoot`. This value is a real filesystem path — it is
   * `join`ed/`resolve`d against the sandbox and workspace roots
   * (`utils/sandbox.ts`) and interpolated into engine CLI arguments (Stryker
   * `--mutate`, cargo-mutants `--file`, Infection `--filter`, the
   * `buildVitestRelatedCommand` allowlist) — not a stored key, so it has no
   * portability requirement and nothing to gain from being rewritten. Only the
   * key is normalised.
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
 *
 * The containment test and `targetFile` are decided on the RAW, platform-native
 * relative path; only the returned `relFromRoot` key is normalised to POSIX.
 * See {@link WorkspaceAnchor} for why the two must not share a separator.
 */
export function anchorToWorkspace(
  workspaceRoot: string,
  resolvedFile: string,
  fallback: string,
): WorkspaceAnchor {
  const native = relative(workspaceRoot, resolvedFile);
  const targetFile =
    native.length > 0 && !native.startsWith('..') && !isAbsolute(native) ? native : fallback;
  // `native` is produced by `relative()`, so it only ever contains the platform
  // separator. Splitting on `sep` is therefore exact — unlike an unconditional
  // backslash replace, it cannot mangle a POSIX filename that legitimately
  // contains a `\`. (The suppressions READER does replace unconditionally, and
  // must: it is repairing keys written by another machine's `sep`.)
  return { relFromRoot: native.split(sep).join('/'), targetFile };
}
