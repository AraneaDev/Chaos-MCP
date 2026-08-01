import { cp } from 'fs/promises';
import {
  mkdtempSync,
  symlinkSync,
  rmSync,
  existsSync,
  statSync,
  readdirSync,
  realpathSync,
} from 'fs';
import { join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { warn } from './logger.js';
import { killAllTrackedProcesses, killProcessesUnder } from './process-reaper.js';
import {
  ALLOWED_ROOTS_ENV,
  allowedWorkspaceRoots,
  isPathInside,
  isWorkspaceRootAllowed,
} from './path-safety.js';
import { ALL_DEPENDENCY_DIRS } from './dependency-dirs.js';
import { COMMON_IGNORE_DIRS } from './ignore-dirs.js';

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
 * Whether this module's signal handlers terminate the process themselves.
 *
 * Registering a signal handler suppresses Node's default termination, so
 * something must still end the process — but a leaf utility calling
 * `process.exit` pre-empts every other shutdown path, including the MCP
 * transport's graceful close, and drops in-flight responses. The process owner
 * can take that responsibility instead via {@link setSandboxSignalExit}; the
 * default stays true so a library or CLI consumer that installs nothing keeps
 * the previous behaviour and never hangs on a signal.
 */
let signalExitEnabled = true;

/**
 * Hand signal-driven termination to the caller (see {@link signalExitEnabled}).
 * The caller MUST then terminate the process itself and SHOULD call
 * {@link cleanupAllSandboxes} on its way out.
 */
export function setSandboxSignalExit(enabled: boolean): void {
  signalExitEnabled = enabled;
}

/**
 * Remove every sandbox this process still owns. Synchronous and idempotent, so
 * it is safe from an `exit` handler and safe to call more than once.
 */
export function cleanupAllSandboxes(): void {
  // Kill first, delete second. A mutation engine's test processes run INSIDE
  // these directories; removing the directory out from under a live `vitest`
  // does not stop it — it just leaves it running against a path that no longer
  // exists. (Observed: a worker held 2 GB for 20 hours that way.)
  killAllTrackedProcesses();
  for (const dir of ACTIVE_SANDBOXES) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Best-effort — OS will reclaim tmpdir() eventually
    }
  }
  ACTIVE_SANDBOXES.clear();
}

/**
 * Register process-wide handlers that remove any sandboxes left behind
 * when the process terminates unexpectedly. The handlers use only
 * synchronous operations because Node.js `exit` callbacks must be sync.
 */
function ensureExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;

  const cleanupAll = cleanupAllSandboxes;

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
  //
  // The exit is skipped when the process owner has claimed shutdown via
  // setSandboxSignalExit(false) — see that flag for why a leaf utility should
  // not unilaterally end the process. Cleanup always runs either way.
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'] as const) {
    process.on(sig, () => {
      cleanupAll();
      if (signalExitEnabled) process.exit(128 + SIGNAL_NUMBERS[sig]);
    });
  }
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

/**
 * Directories and files that should never be copied into the sandbox.
 *
 * {@link COMMON_IGNORE_DIRS} is the core every tree-walker in the codebase
 * shares; everything after it is exclusive to the sandbox copy filter and is
 * listed explicitly so the remaining drift against triage.ts / test-file.ts is
 * visible rather than buried in four hand-kept copies. Note this set also
 * carries FILE names, which the shared constant deliberately does not.
 *
 * @internal Exported for testing only — `ignore-dirs.test.ts` pins the
 * effective set byte-for-byte.
 */
export const ALWAYS_EXCLUDE = new Set([
  ...COMMON_IGNORE_DIRS,
  // ── sandbox-only ──
  '.svn',
  '.stryker-tmp',
  '.mutmut-cache',
  '.pytest_cache',
  '.tox',
  '.env',
  'coverage',
  '.nyc_output',
  '.next',
  'target', // Rust build artifacts (excluded — NOT symlinked; audit H1)
  // Our own derived output from a previous audit. Copying it in lets a run that
  // never produced a log read the old one and report it as a fresh result.
  'chaos-infection-log.json',
]);

/**
 * Directories that, when present in the workspace root, should be symlinked
 * into the sandbox rather than copied (they are large and read-only during
 * mutation runs).
 *
 * DERIVED, not hand-maintained: the union of every language's dependency
 * directories, deduped, in declaration order. A new language therefore cannot
 * ship with its dependency tree silently deep-copied into every sandbox — the
 * `DEPENDENCY_DIRS` entry it is forced to add carries the answer. Today that
 * yields exactly `['node_modules', '.venv', 'venv', 'vendor']`
 * (typescript → python → rust(none) → php), pinned by sandbox.test.ts.
 *
 * Taken from the `utils/dependency-dirs.ts` leaf rather than from
 * `engines/registry.ts#dependencyDirectories()`: the two are equal by
 * construction (the registry stamps each descriptor's `dependencyDirs` from the
 * same constant) and sandbox.test.ts pins them equal, but reaching through the
 * registry made this util import every engine class to learn four directory
 * names.
 *
 * Note: `target` (Rust build artifacts) is intentionally NOT symlinked — Rust
 * compiles into `target/`, and a symlink would let mutation runs corrupt the
 * host workspace's build cache (audit finding H1), so the Rust descriptor
 * declares no dependency dirs at all and `target` is bulk-excluded via
 * `ALWAYS_EXCLUDE` instead. Only list a directory in `dependencyDirs` when it is
 * safe to share across sandboxes.
 *
 * @internal Exported for testing only.
 */
export const SYMLINK_DIRS: readonly string[] = ALL_DEPENDENCY_DIRS;

/**
 * The single decision function for "does this path get copied into the sandbox?".
 *
 * Built once per {@link createSandbox} call and shared by the `fs.cp` filter and
 * the pre-copy size estimate, so the exclusion rules (and in particular the
 * trailing-separator / empty-pattern normalisation) exist in exactly one place.
 *
 * @internal Exported for testing only.
 */
export interface CopyPolicy {
  /** Whether the absolute path `src` should be copied into the sandbox. */
  shouldCopy(src: string): boolean;
  /**
   * The caller's ignorePatterns after normalisation: a single trailing
   * separator stripped and empty patterns dropped (an empty pattern matches
   * every `split(sep)` result and would silently exclude everything).
   */
  normalisedExcludes: Set<string>;
  /**
   * Heavyweight dirs {@link CopyPolicy.shouldCopy} refused, at any depth, so
   * Step 2 can symlink them back in. Populated as a side effect of the filter
   * (which `fs.cp` calls synchronously per entry).
   */
  skippedHeavyDirs: Set<string>;
}

/** Inputs for {@link buildCopyPolicy}. */
export interface CopyPolicyInput {
  /** Absolute path of the audited file inside the workspace. */
  absoluteTarget: string;
  /**
   * Heavyweight dirs that will be symlinked into the sandbox for THIS audit.
   *
   * Symlinked directories MUST be excluded from the workspace copy: Step 1 copies
   * the tree and Step 2 symlinks these dirs into the sandbox, so if the copy also
   * materialised them the symlink would collide with `EEXIST`. Excluding them here
   * (rather than relying on every entry ALSO being hand-listed in ALWAYS_EXCLUDE)
   * makes the "symlinked ⇒ never copied" invariant structural, so the two lists
   * cannot silently drift. Regression: `vendor` was in SYMLINK_DIRS but missing
   * from ALWAYS_EXCLUDE, so every PHP (Composer) project failed provisioning.
   */
  symlinkDirs: Iterable<string>;
  /** Caller-supplied ignorePatterns (workspace-relative dir/file segments). */
  userExcludes?: Iterable<string>;
  /**
   * Force-include the target file and every ancestor directory (default true).
   *
   * Only the copy filter wants this; see {@link estimateWorkspaceSize} for why
   * the size estimate deliberately opts out.
   */
  forceIncludeTarget?: boolean;
  /**
   * Match user excludes against EVERY segment of `src`, not just its basename
   * (default true).
   *
   * The copy filter sees each entry in isolation and must therefore reject a
   * path whose ancestor matched. A pruned walk (the size estimate) never
   * descends past a rejected ancestor, so it opts out to avoid ALSO matching
   * segments of the workspace root's own absolute path.
   */
  matchAncestorSegments?: boolean;
}

/**
 * Build the copy/exclusion policy for one sandbox provision.
 *
 * Pure: it touches no filesystem and holds no state beyond
 * {@link CopyPolicy.skippedHeavyDirs}, so the rules can be unit-tested on plain
 * path strings without provisioning a sandbox.
 *
 * @internal Exported for testing only.
 */
export function buildCopyPolicy({
  absoluteTarget,
  symlinkDirs,
  userExcludes,
  forceIncludeTarget = true,
  matchAncestorSegments = true,
}: CopyPolicyInput): CopyPolicy {
  const symlinkDirsSet = new Set(symlinkDirs);

  // Strip a single trailing separator so the common convention `["fixtures/"]`
  // matches directory segments named `fixtures` (Live-audit L2 fix), and drop
  // patterns that normalise to empty — they would match every split and
  // silently exclude the entire workspace.
  const normalisedExcludes = new Set<string>();
  for (const pattern of userExcludes ?? []) {
    if (pattern.length === 0) continue;
    const normalised = pattern.endsWith(sep) ? pattern.slice(0, -1) : pattern;
    if (normalised.length > 0) normalisedExcludes.add(normalised);
  }

  const skippedHeavyDirs = new Set<string>();

  return {
    normalisedExcludes,
    skippedHeavyDirs,
    shouldCopy(src: string): boolean {
      // Force-include the target file itself and any ancestor directory. This
      // deliberately wins over BOTH checks below: a target under a
      // conventionally-named dir (build/, dist/, coverage/, vendor/,
      // node_modules/) or matched by an ignorePattern would otherwise be
      // dropped and provisioning would fail with a confusing "target not
      // found" (Med#7). Step 2's symlink loops guard on `!existsSync(dst)`
      // precisely because this can materialise a heavyweight dir.
      if (forceIncludeTarget && (src === absoluteTarget || absoluteTarget.startsWith(src + sep))) {
        return true;
      }

      const segments = src.split(sep);
      const basename = segments[segments.length - 1] ?? '';

      // Symlinked heavyweight dirs (node_modules, .venv, venv, and — except
      // for Composer PHP audits — vendor) are materialised as symlinks in
      // Step 2, so they must never be copied here: a copied dir would make the
      // later symlinkSync fail with EEXIST. Dirs we deliberately COPY (vendor
      // for PHP) are absent from this set and fall through to be copied.
      //
      // This matches on a path SEGMENT, so it skips these dirs at every depth.
      // Record each one: Step 2 used to symlink only the workspace root, so a
      // workspace layout (npm workspaces, or a PHP project shipping a Node
      // worker) lost its NESTED dependencies from the sandbox entirely.
      //
      // Checked BEFORE ALWAYS_EXCLUDE because node_modules/.venv/venv appear
      // in both lists; an ALWAYS_EXCLUDE hit first would drop them silently
      // instead of recording them for re-linking.
      if (symlinkDirsSet.has(basename)) {
        skippedHeavyDirs.add(src);
        return false;
      }
      if (ALWAYS_EXCLUDE.has(basename)) return false;

      // Audit finding M6: segment-based matching prevents over-eager substring
      // exclusion. Excludes only when a path segment exactly equals the
      // pattern, not when the pattern is a substring of any path component.
      if (matchAncestorSegments) {
        for (const segment of segments) {
          if (normalisedExcludes.has(segment)) return false;
        }
        return true;
      }
      return !normalisedExcludes.has(basename);
    },
  };
}

/**
 * Detect a Composer (PHP) audit that must COPY `vendor/` rather than symlink it.
 *
 * Composer's autoloader (vendor/composer/ClassLoader.php + autoload_*.php) derives
 * its project base dir from `__DIR__`, and PHP resolves `__DIR__` THROUGH symlinks
 * to the real path. So if `vendor/` is a symlink into the sandbox, the autoloader
 * (and the phpunit/infection bin stubs, which `require __DIR__/../autoload.php`)
 * resolve back to the ORIGINAL workspace and load the real source — not the
 * mutated sandbox copy. Coverage then attributes execution to the real files and
 * Infection reports "No source code … was executed", silently invalidating the
 * whole mutation run. Copying vendor/ keeps every `__DIR__` inside the sandbox.
 *
 * Gated on a `.php` target AND a Composer marker (composer.json or vendor/composer)
 * so non-PHP audits keep the cheap symlink for their heavyweight dirs.
 */
function isComposerPhpAudit(targetFile: string, absoluteWorkspace: string): boolean {
  if (!targetFile.toLowerCase().endsWith('.php')) return false;
  return (
    existsSync(join(absoluteWorkspace, 'composer.json')) ||
    existsSync(join(absoluteWorkspace, 'vendor', 'composer'))
  );
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
function estimateWorkspaceSize(
  workspaceRoot: string,
  policy: CopyPolicy,
  signal?: AbortSignal,
): number {
  try {
    const stack: string[] = [workspaceRoot];
    let total = 0;

    while (stack.length > 0) {
      // CodeRabbit finding: this walk is synchronous, so a large workspace
      // could block the event loop long enough that an MCP abort is not
      // observed until the whole scan finishes. Check the signal per directory
      // so cancellation is honoured promptly, and stop early once we already
      // know the workspace exceeds the warning threshold — the result is only
      // used for a boolean `size > MAX_WORKSPACE_SIZE_BYTES` warning, so there
      // is nothing to gain by continuing to walk past the cap.
      if (signal?.aborted) throw abortError();
      if (total > MAX_WORKSPACE_SIZE_BYTES) break;
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
 * Step 2: symlink heavyweight directories into the sandbox.
 *
 * (`symlinkDirs` excludes vendor for Composer PHP audits — that dir was
 * copied in Step 1 instead, so it is intentionally not symlinked here.)
 *
 * A destination that ALREADY EXISTS was materialised by Step 1 and must be
 * left alone. That happens when the audited file lives inside one of these
 * dirs (e.g. `vendor/my-lib/index.ts` in a repo that vendors first-party
 * code): the filter's force-include of the target's ancestors wins over the
 * symlink-dir check, so `cp` copies the whole tree and the dir is never
 * recorded in `skippedHeavyDirs`. Symlinking over it threw a raw EEXIST
 * (`safeSymlink` only retries on Windows), failing provisioning outright.
 * Skipping is correct AND required: the real copy already makes the sandbox
 * complete, and a symlink here would point the target back at the live
 * workspace — which Step 4's containment assertion rejects anyway.
 */
function linkHeavyDirs(
  absoluteWorkspace: string,
  sandboxDir: string,
  symlinkDirs: readonly string[],
  skippedHeavyDirs: Set<string>,
): void {
  for (const dirName of symlinkDirs) {
    const src = join(absoluteWorkspace, dirName);
    const dst = join(sandboxDir, dirName);
    if (existsSync(src) && !existsSync(dst)) {
      safeSymlink(src, dst);
    }
    skippedHeavyDirs.delete(src); // handled above; do not link it twice
  }
  // Nested occurrences (e.g. workers/typescript/node_modules). Their parent
  // directories were copied, so the link destination's parent already exists.
  for (const src of skippedHeavyDirs) {
    if (!src.startsWith(absoluteWorkspace + sep)) continue;
    if (!existsSync(src)) continue;
    const dst = join(sandboxDir, src.slice(absoluteWorkspace.length + 1));
    if (existsSync(dst)) continue; // already materialised by the copy — see above
    safeSymlink(src, dst);
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
 * Build the teardown returned to the caller as {@link SandboxContext.cleanup}.
 *
 * Best-effort by design: it runs from `finally` blocks and process shutdown,
 * where throwing would strand the remaining sandboxes.
 */
function makeCleanup(sandboxDir: string): () => void {
  return () => {
    try {
      // Reap only the engine processes running in THIS sandbox — a triage
      // sweep tears sandboxes down while its siblings are still auditing,
      // so a global kill here would abort the rest of the run.
      killProcessesUnder(sandboxDir);
      rmSync(sandboxDir, { recursive: true, force: true });
    } catch {
      // Best-effort — OS will reclaim tmpdir() eventually
    } finally {
      ACTIVE_SANDBOXES.delete(sandboxDir);
    }
  };
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
  const symlinkDirs = isComposerPhpAudit(targetFile, absoluteWorkspace)
    ? SYMLINK_DIRS.filter((d) => d !== 'vendor')
    : SYMLINK_DIRS;

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
  const size = estimateWorkspaceSize(
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
  // ACTIVE_SANDBOXES is the only thing cleanupAllSandboxes() walks, and that is
  // what the exit/SIGTERM/SIGINT/SIGHUP/SIGQUIT handlers above — and
  // installShutdownHandlers' `.finally` in src/index.ts — run on their way out.
  // Registering AFTER the copy meant a signal arriving during Step 1 (by far the
  // longest phase: a full workspace tree copy, seconds on a large repo) cleaned
  // a set that did not contain this directory and then called process.exit, so
  // the `finally` below never ran and the half-copied tree leaked into tmpdir()
  // permanently. Registration is a Set.add and every cleanup path is idempotent,
  // so paying it up front costs nothing.
  ACTIVE_SANDBOXES.add(sandboxDir);

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
    linkHeavyDirs(absoluteWorkspace, sandboxDir, symlinkDirs, skippedHeavyDirs);

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
      ACTIVE_SANDBOXES.delete(sandboxDir);
    }
  }
}
