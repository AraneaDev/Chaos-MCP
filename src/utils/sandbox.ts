import { mkdtempSync, cpSync, symlinkSync, rmSync, existsSync, statSync, readdirSync } from 'fs';
import { join, resolve, isAbsolute, relative, sep } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { isVerbose, warn } from './logger.js';

/**
 * Returns true when `candidate` is `root` itself, or a file/directory
 * strictly inside `root` (no `..` traversal, no absolute escape).
 *
 * Defense-in-depth against path traversal (audit finding C2): even if the
 * handler layer forgets to validate `filePath`, the sandbox refuses to
 * copy a workspace that lies outside the current process working directory.
 */
function isPathInside(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  // INSIDE means: equal-to (rel === ''), strictly inside (rel === 'foo'),
  // or the parent of (rel === '..') the root. Block only escape / sibling.
  // (Live-audit L1 fix: previously required `rel !== ''` which blocked the
  // legitimate case where `workspaceRoot === process.cwd()`, causing audit
  // calls on the user's own project to fail unconditionally.)
  return !rel.startsWith('..') && rel !== '..' && !isAbsolute(rel);
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
  'target', // Rust build artifacts (symlinked separately)
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
const SYMLINK_DIRS = ['node_modules', '.venv', 'venv'];

/**
 * Maximum workspace size (in bytes) to copy without warning.
 * 200 MB — beyond this, cpSync can be slow on large repos.
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
    if (isWindows() && error instanceof Error) {
      // EPERM on Windows → retry with junction (no admin privileges needed)
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
 * Skips ALWAYS_EXCLUDE directories to match what cpSync will actually copy.
 */
function estimateWorkspaceSize(workspaceRoot: string): number {
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
 * @param targetFile — workspace-relative path (e.g. "src/utils/math.ts")
 * @param workspaceRoot — absolute path to the resolved workspace root
 */
export function createSandbox(
  targetFile: string,
  workspaceRoot: string,
  ignorePatterns?: string[],
): SandboxContext {
  const id = randomUUID();
  // Use os.tmpdir() for cross-platform temp directory support (TMPDIR on
  // macOS/Linux, TEMP/TMP on Windows). Previously hard-coded to '/tmp'.
  const sandboxDir = mkdtempSync(join(tmpdir(), `chaos-mcp-${id}`));
  const absoluteWorkspace = resolve(workspaceRoot);

  // ── Defense in depth (audit finding C2): refuse workspaces outside cwd ──
  // The handler in src/index.ts already validates filePath, but a malicious
  // caller could still pass a `workspaceRoot` directly. This makes the
  // sandbox self-protecting.
  const absoluteCwd = resolve(process.cwd());
  if (!isPathInside(absoluteWorkspace, absoluteCwd)) {
    throw new Error(
      `Refusing to sandbox workspace outside process cwd: ` +
        `"${absoluteWorkspace}" is not inside "${absoluteCwd}".`,
    );
  }

  // ── Pre-copy: warn on very large workspaces ──
  // Only estimate in verbose mode (avoids full directory walk overhead in normal mode),
  // but use warn() for the output so it's always visible when triggered.
  if (isVerbose()) {
    const size = estimateWorkspaceSize(absoluteWorkspace);
    if (size > MAX_WORKSPACE_SIZE_BYTES) {
      warn(
        `Workspace is ~${(size / 1024 / 1024).toFixed(0)}MB — sandbox copy may be slow. ` +
          'Consider using ignorePatterns to exclude large directories.',
      );
    }
  }

  let success = false;
  try {
    // ── Step 1: Copy workspace tree (exclude heavyweight / generated dirs) ──
    // Build the combined exclusion set: ALWAYS_EXCLUDE + user ignorePatterns
    const userExcludes = new Set(ignorePatterns ?? []);

    cpSync(absoluteWorkspace, sandboxDir, {
      recursive: true,
      filter: (src: string) => {
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

    // ── Step 2: Symlink heavyweight directories ──
    for (const dirName of SYMLINK_DIRS) {
      const src = join(absoluteWorkspace, dirName);
      const dst = join(sandboxDir, dirName);
      if (existsSync(src)) {
        safeSymlink(src, dst);
      }
    }

    // ── Step 3: Verify the target file exists in the sandbox ──
    const absoluteTargetPath = join(sandboxDir, targetFile);
    if (!existsSync(absoluteTargetPath)) {
      throw new Error(
        `Sandbox provisioning failed: target file "${targetFile}" was not found in the copied workspace. ` +
          `Workspace root: ${absoluteWorkspace}`,
      );
    }

    success = true;
    return {
      workDir: sandboxDir,
      targetFile,
      cleanup: () => {
        try {
          rmSync(sandboxDir, { recursive: true, force: true });
        } catch {
          // Best-effort — OS will reclaim tmpdir() eventually
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
