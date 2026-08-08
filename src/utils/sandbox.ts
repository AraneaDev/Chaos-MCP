import { cp, readdir } from 'fs/promises';
import { mkdtempSync, rmSync, existsSync, statSync, realpathSync } from 'fs';
import { join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { warn } from './logger.js';
import {
  ALLOWED_ROOTS_ENV,
  allowedWorkspaceRoots,
  isPathInside,
  isWorkspaceRootAllowed,
} from './path-safety.js';
import {
  buildCopyPolicy,
  isComposerPhpAudit,
  SYMLINK_DIRS,
  type CopyPolicy,
} from './sandbox/copy-policy.js';
import { linkDependencyEntries, safeSymlink } from './sandbox/dependency-link.js';
import type { DependencyMode } from './config/types.js';
// Exactly ONE specifier for the registry, here and in src/index.ts: its
// ACTIVE_SANDBOXES Set is module-level state, and a second resolvable path
// would give the signal handlers a different Set than the one sandboxes
// register in — see the docblock in ./sandbox/registry.ts.
import {
  ensureExitHandler,
  makeCleanup,
  registerSandbox,
  unregisterSandbox,
} from './sandbox/registry.js';

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
  /**
   * Dependency-directory strategy; defaults to `'link-entries'`. See
   * `SandboxConfig.dependencies` in utils/config/types.ts for the trade-offs.
   */
  dependencies?: DependencyMode;
}

/** Standard-shaped rejection for an aborted createSandbox. */
function abortError(): Error {
  const e = new Error('Sandbox creation cancelled.');
  e.name = 'AbortError';
  return e;
}

/**
 * Throw unless the provisioned target resolves to a path physically inside the
 * sandbox directory.
 *
 * Both sides are realpath'd: the sandbox root itself is commonly a symlink
 * (macOS `/tmp` → `/private/tmp`), so comparing an already-resolved target
 * against an unresolved root would reject every macOS run.
 *
 * A realpath failure on the target is itself disqualifying — a target we cannot
 * resolve is a target we cannot prove is safe to mutate, so this fails closed.
 *
 * @internal Exported for testing only.
 */
export function assertTargetInsideSandbox(
  absoluteTargetPath: string,
  sandboxDir: string,
  targetFile: string,
): void {
  let realTarget: string;
  let realSandbox: string;
  try {
    realTarget = realpathSync(absoluteTargetPath);
    realSandbox = realpathSync(sandboxDir);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Sandbox provisioning failed: could not resolve the real path of target file "${targetFile}" ` +
        `(${message}), so it cannot be confirmed to live inside the sandbox.`,
    );
  }
  if (isPathInside(realTarget, realSandbox)) return;
  throw new Error(
    `Sandbox provisioning failed: target file "${targetFile}" resolves to "${realTarget}", which is ` +
      `outside the sandbox. It is a symlink into the real workspace (or lives under one), and mutating ` +
      `it would modify your actual source tree rather than the isolated copy. ` +
      `Audit the symlink's target path directly instead.`,
  );
}

/**
 * Maximum workspace size (in bytes) to copy without warning.
 * 200 MB — beyond this, an async copy can still take seconds (audit C1).
 */
const MAX_WORKSPACE_SIZE_BYTES = 200 * 1024 * 1024;

/**
 * How many directories {@link estimateWorkspaceSize} may visit between forced
 * event-loop yields.
 *
 * `await readdir` already releases the loop whenever the read actually hits the
 * threadpool, but a warm page cache can resolve many reads without ever letting
 * a timer or an `abort()` callback run. 64 keeps the guaranteed release cheap
 * (one extra macrotask per 64 directories) while bounding the longest stretch
 * of uninterrupted walking on any filesystem.
 */
const SIZE_WALK_YIELD_EVERY_DIRS = 64;

/** Release the event loop for one macrotask so pending work (e.g. an abort) runs. */
function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolveYield) => setImmediate(resolveYield));
}

/** Size of a single file in bytes; 0 for files we cannot stat. */
function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    // Ignore files we can't stat
    return 0;
  }
}

/**
 * Estimate the size of a directory tree by summing file sizes.
 * Used as a pre-copy guard to warn on very large workspaces.
 *
 * Asynchronous: the walk yields to the event loop while reading each directory
 * (and unconditionally every {@link SIZE_WALK_YIELD_EVERY_DIRS} directories),
 * so an in-flight abort is observed mid-walk and concurrent provisions do not
 * serialise their walks on the loop.
 *
 * Applies the SAME {@link CopyPolicy} the copy will use, so the estimate
 * matches what the copy actually walks — otherwise the warning would fire for
 * bytes that are never copied (audit Low#3).
 *
 * The policy passed here is built with `forceIncludeTarget: false` and
 * `matchAncestorSegments: false` (see {@link createSandbox}), which preserves
 * this function's long-standing semantics: heavyweight dirs are skipped
 * unconditionally — even when the audited file lives inside one, where the copy
 * force-includes (and therefore copies) the whole tree — and exclusions match
 * the walked entry's own name rather than segments of the workspace root's
 * absolute path.
 */
async function estimateWorkspaceSize(
  workspaceRoot: string,
  policy: CopyPolicy,
  signal?: AbortSignal,
): Promise<number> {
  try {
    const stack: string[] = [workspaceRoot];
    let total = 0;
    let dirsSinceYield = 0;

    while (stack.length > 0) {
      // The walk is asynchronous, and that is what makes this check mean
      // something. `AbortController.abort()` runs on the event loop, so a
      // signal cannot flip in the middle of a synchronous walk no matter how
      // often the walk looks at it — the previous version's per-directory poll
      // was provably equivalent to the one before the loop, and its own comment
      // ("this walk is synchronous, so ... an MCP abort is not observed until
      // the whole scan finishes") was the reason it could not work.
      //
      // Each `await readdir` hands the event loop back while the directory read
      // runs on the threadpool, and the explicit yield every
      // SIZE_WALK_YIELD_EVERY_DIRS directories guarantees a release even when
      // every read is served from cache. Both give a pending abort a real
      // chance to run before the next iteration reads the flag. This also stops
      // `poolSize` concurrent triage provisions from serialising their tree
      // walks on the event loop and freezing the MCP server for that window.
      //
      // Stop early once we already know the workspace exceeds the warning
      // threshold — the result is only used for a boolean
      // `size > MAX_WORKSPACE_SIZE_BYTES` warning, so there is nothing to gain
      // by continuing to walk past the cap.
      if (signal?.aborted) throw abortError();
      if (total > MAX_WORKSPACE_SIZE_BYTES) break;
      const current = stack.pop();
      if (current === undefined) break;
      if (++dirsSinceYield >= SIZE_WALK_YIELD_EVERY_DIRS) {
        dirsSinceYield = 0;
        await yieldToEventLoop();
      }
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = join(current, entry.name);
        // Symlinked dirs are not copied, so they must not count toward the
        // copy-size estimate that drives the "large workspace" warning. (A dir
        // we COPY instead of symlink — e.g. vendor for a Composer audit — is
        // absent from the policy's symlink set and so DOES count, correctly.)
        if (!policy.shouldCopy(fullPath)) continue;

        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile()) {
          total += fileSize(fullPath);
        }
      }
    }

    return total;
  } catch (err) {
    // Cancellation must escape — the enclosing best-effort catch only exists to
    // swallow transient fs errors during the size estimate, not to mask an abort.
    if (err instanceof Error && err.name === 'AbortError') throw err;
    return 0;
  }
}

/**
 * Step 1: copy the workspace tree into the sandbox, excluding heavyweight and
 * generated dirs per `policy`.
 *
 * Audit C1: the async `cp` releases the event loop during disk I/O. The filter
 * callback is synchronous — Node's async `fs.cp` calls it sync per entry and
 * accumulates results internally — so `policy.skippedHeavyDirs` is fully
 * populated by the time this resolves.
 *
 * @returns the heavyweight dirs the filter skipped, for {@link linkHeavyDirs}.
 */
async function copyWorkspaceTree(
  absoluteWorkspace: string,
  sandboxDir: string,
  policy: CopyPolicy,
  signal?: AbortSignal,
): Promise<Set<string>> {
  await cp(absoluteWorkspace, sandboxDir, {
    recursive: true,
    filter: (src: string) => policy.shouldCopy(src),
    dereference: false,
  });

  if (signal?.aborted) throw abortError();

  return policy.skippedHeavyDirs;
}

/**
 * Step 2: materialise heavyweight directories in the sandbox.
 *
 * `mode` selects the materialiser:
 * - `'link-entries'` (default) and `'copy'` (nothing left to link — see the
 *   `symlinkDirs` derivation in {@link createSandbox}) use
 *   `linkDependencyEntries`: the sandbox owns the directory and each host entry
 *   is symlinked INSIDE it (see `./sandbox/dependency-link.ts`), so a tool that
 *   writes a new path under `node_modules/` writes into the sandbox rather than
 *   into the user's tree.
 * - `'share'` uses `safeSymlink` — the pre-1.8 whole-directory symlink — for
 *   anyone who depends on that behaviour and accepts that a write under it
 *   reaches the real workspace.
 *
 * (`symlinkDirs` excludes vendor for Composer PHP audits — that dir was copied
 * in Step 1 instead, so it is intentionally not linked here.)
 *
 * A destination that ALREADY EXISTS was materialised by Step 1 and must be left
 * alone. That happens when the audited file lives inside one of these dirs (e.g.
 * `vendor/my-lib/index.ts` in a repo that vendors first-party code): the
 * filter's force-include of the target's ancestors wins over the symlink-dir
 * check, so `cp` copies the whole tree and the dir is never recorded in
 * `skippedHeavyDirs`. `linkDependencyEntries` skips an existing destination per
 * entry (so a partially-materialised directory is completed rather than
 * clobbered); `safeSymlink` cannot target an existing path at all, so `'share'`
 * checks `existsSync(dst)` itself before calling it.
 */
function linkHeavyDirs(
  absoluteWorkspace: string,
  sandboxDir: string,
  symlinkDirs: readonly string[],
  skippedHeavyDirs: Set<string>,
  mode: DependencyMode,
): void {
  const materialise = mode === 'share' ? safeSymlink : linkDependencyEntries;
  for (const dirName of symlinkDirs) {
    const src = join(absoluteWorkspace, dirName);
    const dst = join(sandboxDir, dirName);
    if (existsSync(src) && !(mode === 'share' && existsSync(dst))) materialise(src, dst);
    skippedHeavyDirs.delete(src); // handled above; do not link it twice
  }
  // Nested occurrences (e.g. workers/typescript/node_modules). Their parent
  // directories were copied, so the link destination's parent already exists.
  for (const src of skippedHeavyDirs) {
    if (!src.startsWith(absoluteWorkspace + sep)) continue;
    if (!existsSync(src)) continue;
    const dst = join(sandboxDir, src.slice(absoluteWorkspace.length + 1));
    if (mode === 'share' && existsSync(dst)) continue;
    materialise(src, dst);
  }
}

/**
 * Steps 3 + 4: verify the target file exists in the sandbox AND really lives
 * there.
 *
 * `existsSync` (Step 3) follows symlinks, so it passes for a target that is
 * merely a link back into the real workspace. The copy runs with
 * `dereference: false`, so a symlinked source file (or a source file under
 * a symlinked directory) is reproduced in the sandbox AS a symlink — and
 * engines that mutate in place (cosmic-ray) would then write the injected
 * fault straight into the user's real working tree. That breaks the single
 * guarantee this module exists to provide, and a crashed or cancelled run
 * leaves the mutation behind on disk. Step 4 resolves both sides and requires
 * containment: an assertion, not a claim.
 */
function verifyTarget(sandboxDir: string, targetFile: string, absoluteWorkspace: string): void {
  const absoluteTargetPath = join(sandboxDir, targetFile);
  if (!existsSync(absoluteTargetPath)) {
    throw new Error(
      `Sandbox provisioning failed: target file "${targetFile}" was not found in the copied workspace. ` +
        `Workspace root: ${absoluteWorkspace}`,
    );
  }

  assertTargetInsideSandbox(absoluteTargetPath, sandboxDir, targetFile);
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
  if (!isWorkspaceRootAllowed(absoluteWorkspace)) {
    const extra = allowedWorkspaceRoots();
    throw new Error(
      `Refusing to sandbox workspace outside process cwd: ` +
        `"${absoluteWorkspace}" is not inside "${absoluteCwd}"` +
        (extra.length > 0
          ? ` or any ${ALLOWED_ROOTS_ENV} entry (${extra.join(', ')}).`
          : `. Set ${ALLOWED_ROOTS_ENV} to audit workspaces outside the working directory.`),
    );
  }

  // Honour an already-aborted signal before doing any pre-copy work.
  if (options?.signal?.aborted) throw abortError();

  // ── Decide which heavyweight dirs to symlink vs copy for THIS audit ──
  // Composer PHP audits must COPY vendor/ (see isComposerPhpAudit) so the
  // autoloader's __DIR__ stays inside the sandbox; everything else keeps the
  // cheap symlink. The invariant "excluded-from-copy ⇔ symlinked" is preserved
  // by deriving both the copy-filter exclusions and the symlink loop from this
  // single per-call list.
  const mode: DependencyMode = options?.dependencies ?? 'link-entries';
  const baseSymlinkDirs = isComposerPhpAudit(targetFile, absoluteWorkspace)
    ? SYMLINK_DIRS.filter((d) => d !== 'vendor')
    : SYMLINK_DIRS;
  // 'copy' takes every dependency dir out of the symlink set, which is also the
  // copy filter's exclusion set — so they are copied with the rest of the tree
  // and Step 2 has nothing to link.
  const symlinkDirs = mode === 'copy' ? [] : baseSymlinkDirs;

  // Absolute path of the audited file inside the workspace. The target and
  // every directory on the path to it must NEVER be excluded from the copy
  // (Med#7) — see the force-include in buildCopyPolicy.
  const absoluteTarget = resolve(absoluteWorkspace, targetFile);

  // The single exclusion policy for this provision: ALWAYS_EXCLUDE +
  // per-audit symlink dirs + the caller's ignorePatterns.
  const copyPolicy = buildCopyPolicy({
    absoluteTarget,
    symlinkDirs,
    userExcludes: ignorePatterns,
  });

  // ── Pre-copy: warn on very large workspaces ──
  // Always estimate and warn on large workspaces. Previously gated behind
  // isVerbose() which suppressed the warning in normal mode when it was
  // most useful (audit M13).
  //
  // Ensure exit handlers are registered so sandboxes are cleaned up on
  // unexpected process termination.
  ensureExitHandler();

  // A SEPARATE policy instance for the estimate. It shares every rule with
  // `copyPolicy` but keeps the estimator's pre-existing semantics: no
  // force-include (a target inside node_modules/ makes the copy pull the whole
  // dir in, but the size warning has never counted it) and basename-only
  // exclusion matching (the pruned walk cannot see an excluded ancestor, and
  // must not match segments of the workspace root's own path). Its
  // `skippedHeavyDirs` is deliberately discarded — only the copy's set drives
  // the symlink step.
  const size = await estimateWorkspaceSize(
    absoluteWorkspace,
    buildCopyPolicy({
      absoluteTarget,
      symlinkDirs,
      userExcludes: ignorePatterns,
      forceIncludeTarget: false,
      matchAncestorSegments: false,
    }),
    options?.signal,
  );
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

  // Register for cleanup the instant the directory exists, NOT after
  // provisioning succeeds.
  //
  // The registry ./sandbox/registry.ts owns is the only thing
  // cleanupAllSandboxes() walks, and that is what the
  // exit/SIGTERM/SIGINT/SIGHUP/SIGQUIT handlers it installs — and
  // installShutdownHandlers' `.finally` in src/index.ts — run on their way out.
  // Registering AFTER the copy meant a signal arriving during Step 1 (by far the
  // longest phase: a full workspace tree copy, seconds on a large repo) cleaned
  // a set that did not contain this directory and then called process.exit, so
  // the `finally` below never ran and the half-copied tree leaked into tmpdir()
  // permanently. Registration is a Set.add and every cleanup path is idempotent,
  // so paying it up front costs nothing.
  registerSandbox(sandboxDir);

  let success = false;
  try {
    // ── Step 1: Copy workspace tree (exclude heavyweight / generated dirs) ──
    const skippedHeavyDirs = await copyWorkspaceTree(
      absoluteWorkspace,
      sandboxDir,
      copyPolicy,
      options?.signal,
    );

    // ── Step 2: Symlink heavyweight directories ──
    linkHeavyDirs(absoluteWorkspace, sandboxDir, symlinkDirs, skippedHeavyDirs, mode);

    if (options?.signal?.aborted) throw abortError();

    // ── Steps 3 + 4: Verify the target exists in — and really lives in — the sandbox ──
    verifyTarget(sandboxDir, targetFile, absoluteWorkspace);

    success = true;
    return { workDir: sandboxDir, targetFile, cleanup: makeCleanup(sandboxDir) };
  } finally {
    if (!success) {
      try {
        rmSync(sandboxDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
      // Deregister only once the directory is gone, so a signal racing this
      // branch still finds the sandbox in the registry and removes it. A second
      // rmSync on an already-removed path is a no-op under `force: true`.
      unregisterSandbox(sandboxDir);
    }
  }
}
