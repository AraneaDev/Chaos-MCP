/**
 * Process-lifetime ownership for sandbox directories.
 *
 * Split out of `utils/sandbox.ts` so that provisioning (copying a workspace
 * tree) and shutdown (installing `exit`/`SIGTERM`/`SIGINT`/`SIGHUP`/`SIGQUIT`
 * handlers and, by default, calling `process.exit`) are no longer the same
 * unit. Only this module talks to `process`; `utils/sandbox.ts` reaches it
 * through {@link registerSandbox} / {@link unregisterSandbox} / {@link makeCleanup}.
 *
 * SINGLE INSTANCE, NON-NEGOTIABLE. {@link ACTIVE_SANDBOXES} is module-level
 * state, and ES modules are cached per RESOLVED SPECIFIER. If this file were
 * ever reachable through two different specifiers (a second copy under another
 * path, a re-export chain that resolves differently, a bundler alias, a
 * `.js`/`.ts` split in one graph), two independent Sets would exist: sandboxes
 * would register in one and the signal handlers would walk the other, silently
 * cleaning up nothing. The leak is not a stray temp file — it is a full copy of
 * the audited workspace per audit, left in `tmpdir()` forever. Import this
 * module by exactly one path (`./sandbox/registry.js` from `utils/sandbox.ts`,
 * `./utils/sandbox/registry.js` from `src/index.ts`) and do not re-export its
 * mutable state through another module.
 */

import { rmSync } from 'fs';
import { killAllTrackedProcesses, killProcessesUnder } from '../process-reaper.js';

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
 * Every process listener {@link ensureExitHandler} installed, in install order.
 *
 * Kept solely so {@link _resetSandboxSignalState} can uninstall exactly those
 * listeners and nothing else: the signal handlers are closures created per call,
 * so without this record there is no reference to hand `process.off`, and a
 * reset that merely flipped `exitHandlerRegistered` back to false would let the
 * next {@link ensureExitHandler} install a SECOND full set on top of the live
 * one. That is a real leak inside a long-lived vitest worker — the per-event
 * listener count climbs past Node's default 10 into a
 * MaxListenersExceededWarning, and one signal would then run cleanup (and
 * `process.exit`) once per generation.
 *
 * Production never appends more than one generation here: `ensureExitHandler`
 * returns early once `exitHandlerRegistered` is set, and nothing outside tests
 * clears it.
 */
const INSTALLED_PROCESS_HANDLERS: Array<[NodeJS.Signals | 'exit', () => void]> = [];

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
 *
 * @internal Called by `createSandbox`; exported only for that seam.
 */
export function ensureExitHandler(): void {
  if (exitHandlerRegistered) return;
  exitHandlerRegistered = true;

  const cleanupAll = cleanupAllSandboxes;

  // `process.on('exit')` fires when the event loop empties or process.exit() is
  // called. Only synchronous operations are allowed in exit handlers.
  process.on('exit', cleanupAll);
  INSTALLED_PROCESS_HANDLERS.push(['exit', cleanupAll]);

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
    const handler = (): void => {
      cleanupAll();
      if (signalExitEnabled) process.exit(128 + SIGNAL_NUMBERS[sig]);
    };
    process.on(sig, handler);
    INSTALLED_PROCESS_HANDLERS.push([sig, handler]);
  }
}

/**
 * Reset the two process-lifetime latches above to their startup values.
 *
 * Both outlive an individual test: a case calling `setSandboxSignalExit(false)`
 * otherwise leaves every LATER test in the same vitest worker running with
 * signal-driven exit silently disabled, and `exitHandlerRegistered` makes the
 * first test that provisions a sandbox the only one that can ever observe
 * handler installation. Same class of cross-test leak the Python interpreter
 * probe cache was refactored away to eliminate.
 *
 * The listeners `ensureExitHandler` installed are removed BEFORE its latch is
 * cleared, so re-arming installs one generation rather than stacking a second
 * on a live one — see {@link INSTALLED_PROCESS_HANDLERS} for why a
 * flag-only reset would leak process listeners.
 *
 * {@link ACTIVE_SANDBOXES} is deliberately NOT cleared: forgetting tracked
 * directories without removing them from disk is exactly how sandboxes leak.
 * Call {@link cleanupAllSandboxes} when a test wants them gone.
 *
 * @internal Exported for testing only.
 */
export function _resetSandboxSignalState(): void {
  for (const [event, handler] of INSTALLED_PROCESS_HANDLERS) {
    process.off(event, handler);
  }
  INSTALLED_PROCESS_HANDLERS.length = 0;
  exitHandlerRegistered = false;
  signalExitEnabled = true;
}

/**
 * Take ownership of `sandboxDir`: from now until {@link unregisterSandbox}, the
 * shutdown handlers above will remove it.
 *
 * A `Set.add`, so callers can (and do) pay it the instant the directory exists
 * rather than after provisioning succeeds.
 *
 * @internal The only write path into ACTIVE_SANDBOXES — see the module docblock.
 */
export function registerSandbox(sandboxDir: string): void {
  ACTIVE_SANDBOXES.add(sandboxDir);
}

/**
 * Release ownership of `sandboxDir`. Call it only once the directory is
 * actually gone: a signal racing the removal must still find it in the registry.
 *
 * @internal The only delete path into ACTIVE_SANDBOXES — see the module docblock.
 */
export function unregisterSandbox(sandboxDir: string): void {
  ACTIVE_SANDBOXES.delete(sandboxDir);
}

/**
 * Build the teardown returned to the caller as {@link SandboxContext.cleanup}.
 *
 * Best-effort by design: it runs from `finally` blocks and process shutdown,
 * where throwing would strand the remaining sandboxes.
 *
 * @internal Lives here rather than with provisioning because it deregisters
 * from ACTIVE_SANDBOXES.
 */
export function makeCleanup(sandboxDir: string): () => void {
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
