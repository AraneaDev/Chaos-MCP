import { cp } from 'fs/promises';
import { mkdtempSync, symlinkSync, rmSync, existsSync, statSync, readdirSync } from 'fs';
import { join, resolve, isAbsolute, relative, sep } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { warn } from './logger.js';

/**
 * Registry of active sandbox directories that have not yet been cleaned up.
 *
 * When the process exits unexpectedly (SIGTERM, SIGINT, crash), registered
 * handlers walk this set and remove every remaining sandbox so temp
 * directories don't leak on disk. Normal cleanup via {@link SandboxContext.cleanup}
 * removes entries from this set.
 */
const ACTIVE_SANDBOXES = new Set<string>();

/** Guards against double-registration of process exit handlers. */
let exitHandlerRegistered = false;

/**
 * Register process-wide handlers that remove any sandboxes left behind
 * when the process terminates unexpectedly. The handlers use only
 * synchronous operations because Node.js `exit` callbacks must be sync.
 */
function ensureExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;

  const cleanupAll = (): void => {
    for (const dir of ACTIVE_SANDBOXES) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort — OS will reclaim tmpdir() eventually
      }
    }
    ACTIVE_SANDBOXES.clear();
  };

  // `process.on('exit')` fires when the event loop empties or process.exit() is
  // called. Only synchronous operations are allowed in exit handlers.
  process.on('exit', cleanupAll);

  // SIGTERM, SIGINT, SIGHUP, and SIGQUIT: try to clean up before the OS
  // kills the process. We call process.exit() after cleanup to let the
  // `exit` handler also fire (it's idempotent — the set is already emptied
  // by this point).
  // (Audit M10: SIGHUP + SIGQUIT added — previously only SIGTERM/SIGINT
  // were handled, so terminal-disconnect leaked sandboxes on disk.)
  // Exit with the conventional 128 + signal-number code so a signal kill is
  // not reported as a clean exit (0) to a supervising process.
  const SIGNAL_NUMBERS: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGTERM: 15,
  };
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const) {
    process.on(sig, () => {
      cleanupAll();
      process.exit(128 + SIGNAL_NUMBERS[sig]);
    });
  }
}

/**
 * Returns true when `candidate` is `root` itself, or a path strictly inside
 * `root` (no `..` traversal, no absolute escape).
 *
 * Defense-in-depth against path traversal (audit finding C2): even if the
 * handler layer forgets to validate `filePath`, the sandbox refuses to
 * copy a workspace that lies outside the current process working directory.
 */
function isPathInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  // INSIDE means equal-to (rel === '') or strictly inside (rel === 'foo/…').
  // A parent ('..'), sibling ('../foo'), or absolute-escape path is rejected.
  // Note `!rel.startsWith('..')` already covers the bare '..' parent case, so
  // no separate `rel !== '..'` check is needed (it would be dead code).
  // (Live-audit L1 fix: previously required `rel !== ''` which blocked the
  // legitimate case where `workspaceRoot === process.cwd()`, causing audit
  // calls on the user's own project to fail unconditionally.)
  return !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Context returned by the sandbox manager.
 * Callers MUST invoke cleanup() in a finally block to avoid leaking temp directories.
 */
export interface SandboxContext {
  /** Absolute path to the sandbox working directory */
  workDir: string;
  /** The target file path, relative to the sandbox workDir (same as the original relative path) */
  targetFile: string;
  /** Remove the sandbox directory and all its contents */
  cleanup: () => void;
}

/**
 * Optional per-call options for {@link createSandbox}.
 *
 * `signal` lets the MCP request context (or any caller) cancel the copy in
 * flight. The signal is checked at three short boundaries (before the async
 * copy starts, after it returns, and after each post-copy step). Rejection
 * throws `Error('Sandbox creation cancelled.')` with `name = 'AbortError'`
 * so callers can branch on a standard abort marker.
 *
 * Mid-copy cancellation is best-effort: `fs.cp` does not expose a cancel
 * hook, so once disk I/O has started it cannot be aborted without forcibly
 * killing the process. The signal still avoids the post-copy symlink + verify
 * phases; on Linux the kernel schedules both phases against an aborted
 * promise.
 */
export interface CreateSandboxOptions {
  signal?: AbortSignal;
}

/** Standard-shaped rejection for an aborted createSandbox. */
function abortError(): Error {
  const e = new Error('Sandbox creation cancelled.');
  e.name = 'AbortError';
  return e;
}

/** Directories and files that should never be copied into the sandbox. */
const ALWAYS_EXCLUDE = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.stryker-tmp',
  '.mutmut-cache',
  '__pycache__',
  '.pytest_cache',
  '.tox',
  '.venv',
  'venv',
  '.env',
  'dist',
  'build',
  'coverage',
  '.nyc_output',
  '.next',
  'target', // Rust build artifacts (excluded — NOT symlinked; audit H1)
]);

/**
 * Directories that, when present in the workspace root, should be symlinked
 * into the sandbox rather than copied (they are large and read-only during
 * mutation runs).
 *
 * Note: `target` (Rust build artifacts) is intentionally NOT symlinked — Rust
 * compiles into `target/`, and a symlink would let mutation runs corrupt the
 * host workspace's build cache (audit finding H1). Use `ALWAYS_EXCLUDE` for
 * bulk-excluded layout directories and add specific directories here only
 * when they are safe to share across sandboxes.
 */
const SYMLINK_DIRS = ['node_modules', '.venv', 'venv', 'vendor'];

/**
 * Maximum workspace size (in bytes) to copy without warning.
 * 200 MB — beyond this, an async copy can still take seconds (audit C1).
 */
const MAX_WORKSPACE_SIZE_BYTES = 200 * 1024 * 1024;

/**
 * Check whether the current platform is Windows.
 */
function isWindows(): boolean {
  return sep === '\\';
}

/**
 * Create a symlink (or junction on Windows) from `target` to `path`.
 *
 * On Windows, regular symlinks require Administrator privileges. Junctions
 * do not, and work for directories. We try 'dir' first, then fall back to
 * 'junction' on Windows if symlinkSync throws EPERM.
 */
function safeSymlink(target: string, path: string): void {
  try {
    symlinkSync(target, path, 'dir');
  } catch (error: unknown) {
    // On Windows: EPERM means regular symlinks need Administrator privileges.
    // Retry with junction (directory hard-link) which doesn't require admin.
    // On non-Windows: EPERM is a genuine filesystem error (e.g. NFS root_squash)
    // — rethrow it directly; junction fallback does not exist on Linux/macOS.
    if (isWindows()) {
      try {
        symlinkSync(target, path, 'junction');
        return;
      } catch {
        // Junction also failed — rethrow original error
      }
    }
    throw error;
  }
}

/**
 * Estimate the size of a directory tree by summing file sizes.
 * Used as a pre-copy guard to warn on very large workspaces.
 *
 * Skips ALWAYS_EXCLUDE directories AND the caller's ignorePatterns so the
 * estimate matches what the copy will actually walk — otherwise the warning
 * would fire for bytes that are never copied (audit Low#3).
 */
function estimateWorkspaceSize(workspaceRoot: string, ignorePatterns?: string[]): number {
  // Normalise ignore patterns the same way the cp filter does: strip a
  // single trailing separator and drop empties (which would match everything).
  const excludeSegments = new Set<string>();
  for (const pattern of ignorePatterns ?? []) {
    if (pattern.length === 0) continue;
    const normalised = pattern.endsWith(sep) ? pattern.slice(0, -1) : pattern;
    if (normalised.length > 0) excludeSegments.add(normalised);
  }

  try {
    const stack: string[] = [workspaceRoot];
    let total = 0;

    while (stack.length > 0) {
      const current = stack.pop();
      if (current === undefined) break;
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        if (ALWAYS_EXCLUDE.has(entry.name)) continue;
        if (excludeSegments.has(entry.name)) continue;

        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile()) {
          try {
            total += statSync(fullPath).size;
          } catch {
            // Ignore files we can't stat
          }
        }
      }
    }

    return total;
  } catch {
    return 0;
  }
}

/**
 * Copy the workspace into a temporary sandbox directory, symlinking
 * heavyweight directories (node_modules, .venv, target) rather than copying
 * them. Returns a SandboxContext the caller must clean up.
 *
 * Asynchronous. The async `fs.cp` call releases the event loop during disk
 * I/O, so a 200 MB workspace copy no longer holds it for tens of seconds
 * (audit C1). An optional `AbortSignal` lets the MCP client cancel mid-flight
 * at the phase boundaries (before the copy, after the copy, before the
 * symlinks, before the final existence check). A cancel rejects with
 * `Error('Sandbox creation cancelled.')` (`name = 'AbortError'`).
 *
 * @param targetFile — workspace-relative path (e.g. "src/utils/math.ts")
 * @param workspaceRoot — absolute path to the resolved workspace root
 * @param ignorePatterns — workspace-relative dir/file segments to exclude
 * @param options — optional AbortSignal; absence disables cancel
 */
export async function createSandbox(
  targetFile: string,
  workspaceRoot: string,
  ignorePatterns?: string[],
  options?: CreateSandboxOptions,
): Promise<SandboxContext> {
  const id = randomUUID();
  const absoluteWorkspace = resolve(workspaceRoot);

  // ── Defense in depth (audit finding C2): refuse workspaces outside cwd ──
  // The handler in src/index.ts already validates filePath, but a malicious
  // caller could still pass a `workspaceRoot` directly. This makes the
  // sandbox self-protecting.
  //
  // (Audit M4 fix: this check — and the exit-handler registration /
  // workspace-size estimate below, neither of which depends on the sandbox
  // dir — now runs BEFORE `mkdtempSync` creates anything on disk. Previously
  // the temp dir was created first, so a boundary-guard trip left an empty,
  // untracked directory behind permanently.)
  const absoluteCwd = resolve(process.cwd());
  if (!isPathInside(absoluteWorkspace, absoluteCwd)) {
    throw new Error(
      `Refusing to sandbox workspace outside process cwd: ` +
        `"${absoluteWorkspace}" is not inside "${absoluteCwd}".`,
    );
  }

  // Honour an already-aborted signal before doing any pre-copy work.
  if (options?.signal?.aborted) throw abortError();

  // ── Pre-copy: warn on very large workspaces ──
  // Always estimate and warn on large workspaces. Previously gated behind
  // isVerbose() which suppressed the warning in normal mode when it was
  // most useful (audit M13).
  //
  // Ensure exit handlers are registered so sandboxes are cleaned up on
  // unexpected process termination.
  ensureExitHandler();

  const size = estimateWorkspaceSize(absoluteWorkspace, ignorePatterns);
  if (size > MAX_WORKSPACE_SIZE_BYTES) {
    warn(
      `Workspace is ~${(size / 1024 / 1024).toFixed(0)}MB — sandbox copy may be slow. ` +
        'Consider using ignorePatterns to exclude large directories.',
    );
  }

  // Honour another abort checkpoint before allocating disk for the temp dir.
  if (options?.signal?.aborted) throw abortError();

  // Use os.tmpdir() for cross-platform temp directory support (TMPDIR on
  // macOS/Linux, TEMP/TMP on Windows). Previously hard-coded to '/tmp'.
  const sandboxDir = mkdtempSync(join(tmpdir(), `chaos-mcp-${id}`));

  let success = false;
  try {
    // ── Step 1: Copy workspace tree (exclude heavyweight / generated dirs) ──
    // Build the combined exclusion set: ALWAYS_EXCLUDE + user ignorePatterns
    const userExcludes = new Set(ignorePatterns ?? []);

    // Absolute path of the audited file inside the workspace. The target and
    // every directory on the path to it must NEVER be excluded — otherwise a
    // target under a conventionally-named dir (build/, dist/, coverage/) or
    // matched by an ignorePattern would be dropped and provisioning would fail
    // with a confusing "target not found" (Med#7).
    const absoluteTarget = resolve(absoluteWorkspace, targetFile);

    // ── Audit C1: async cp releases the event loop during disk I/O. ──
    // The filter callback is synchronous — Node's async fs.cp calls the
    // filter sync per entry and accumulates results internally.
    await cp(absoluteWorkspace, sandboxDir, {
      recursive: true,
      filter: (src: string) => {
        // Force-include the target file itself and any ancestor directory.
        if (src === absoluteTarget || absoluteTarget.startsWith(src + sep)) return true;

        const segments = src.split(sep);
        const basename = segments[segments.length - 1] ?? '';
        if (ALWAYS_EXCLUDE.has(basename)) return false;
        // Audit finding M6: segment-based matching prevents over-eager substring
        // exclusion. Excludes only when a path segment exactly equals the
        // pattern, not when the pattern is a substring of any path component.
        for (const pattern of userExcludes) {
          // Empty patterns would match every split (because `split(sep)` always
          // produces at least one element), so guard against the silent
          // "exclude everything" failure mode.
          if (pattern.length === 0) continue;
          // Strip a single trailing separator so common convention `["fixtures/"]`
          // matches directory segments named `fixtures`. (Live-audit L2 fix.)
          const normalised = pattern.endsWith(sep) ? pattern.slice(0, -1) : pattern;
          if (normalised.length === 0) continue;
          if (segments.includes(normalised)) return false;
        }
        return true;
      },
      dereference: false,
    });

    if (options?.signal?.aborted) throw abortError();

    // ── Step 2: Symlink heavyweight directories ──
    for (const dirName of SYMLINK_DIRS) {
      const src = join(absoluteWorkspace, dirName);
      const dst = join(sandboxDir, dirName);
      if (existsSync(src)) {
        safeSymlink(src, dst);
      }
    }

    if (options?.signal?.aborted) throw abortError();

    // ── Step 3: Verify the target file exists in the sandbox ──
    const absoluteTargetPath = join(sandboxDir, targetFile);
    if (!existsSync(absoluteTargetPath)) {
      throw new Error(
        `Sandbox provisioning failed: target file "${targetFile}" was not found in the copied workspace. ` +
          `Workspace root: ${absoluteWorkspace}`,
      );
    }

    success = true;
    ACTIVE_SANDBOXES.add(sandboxDir);
    return {
      workDir: sandboxDir,
      targetFile,
      cleanup: () => {
        try {
          rmSync(sandboxDir, { recursive: true, force: true });
        } catch {
          // Best-effort — OS will reclaim tmpdir() eventually
        } finally {
          ACTIVE_SANDBOXES.delete(sandboxDir);
        }
      },
    };
  } finally {
    if (!success) {
      try {
        rmSync(sandboxDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
