import { execFile, spawnSync, type ChildProcess } from 'child_process';
import { resolve, sep } from 'path';

/**
 * Process-wide reaper for children and everything they spawned.
 *
 * A module-global singleton by design: the tracking registry has to outlive any
 * single `exec` call so a sandbox teardown or a process-exit handler can reach
 * children nobody is awaiting any more. `_trackedProcessCount` /
 * `_resetTrackedProcesses` exist so tests can assert and clear that global.
 */

/**
 * Every descendant pid of `root`, deepest-first.
 *
 * Node's callback-based `exec`/`execFile` accept a `detached` option and then
 * DISCARD it — only `spawn` honours it. Verified on this platform:
 *
 *   spawn    detached:true  -> child is its own group leader
 *   execFile detached:true  -> child stays in the PARENT's group
 *   exec     detached:true  -> child stays in the PARENT's group
 *
 * So `kill(-pid)` fails with ESRCH for every child this module spawns, and the
 * group path silently degraded to killing the direct child only. That is how a
 * `vitest` worker outlived the StrykerJS run that started it by 20 hours.
 * Walking `ps` is the portable way to reach grandchildren without rewriting the
 * capture/timeout/maxBuffer semantics of exec().
 *
 * This is also why no reaping path here attempts a group kill any more: a call
 * that can only fail is dead code, and on the rare occasion it did NOT fail it
 * was signalling somebody else's process group (a pgid recycled onto our child's
 * pid) instead of our own tree.
 */
function descendantPids(root: number): number[] {
  const children = new Map<number, number[]>();
  try {
    // Stryker disable next-line StringLiteral: the fallback only has to be a string with no pid/ppid line in it; every non-table value produces the same empty tree.
    const listing = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf-8' }).stdout ?? '';
    for (const line of listing.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      children.set(ppid, [...(children.get(ppid) ?? []), pid]);
    }
  } catch {
    // No `ps` (or it failed): fall back to direct-child termination only.
    //
    // Mutation note: emptying this catch is an EQUIVALENT mutant, the walk
    // below would then run over an empty `children` map and return the same
    // empty array. It is left as a live survivor rather than suppressed: a
    // `Stryker disable next-line` comment cannot be attached here (the only
    // place to put it is inside the `try`, where Stryker does not resolve it to
    // the catch block), and a region-level disable would also hide the loop
    // above. The explicit return is kept because it states the intent.
    return [];
  }

  const out: number[] = [];
  const seen = new Set<number>([root]);
  const stack = [root];
  // The loop guard and the `undefined` check below are individually equivalent
  // but NOT jointly so: each covers for the other. `stack.length > 0` is what
  // actually bounds the loop; the check exists because `Array.pop()` is typed
  // `T | undefined` and TypeScript cannot see that the guard rules it out.
  // Stryker disable next-line EqualityOperator: `>= 0` still terminates, the `undefined` check below breaks on the empty pop.
  while (stack.length > 0) {
    const current = stack.pop();
    // Stryker disable next-line ConditionalExpression: unreachable while the loop guard holds; it is a type narrowing, not a runtime branch.
    if (current === undefined) break;
    for (const child of children.get(current) ?? []) {
      // A cycle is impossible in a real process table, but a malformed `ps`
      // line must not spin here.
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      stack.push(child);
    }
  }
  // Deepest last in discovery order, so reverse to kill leaves first and avoid
  // a parent re-spawning while its children are still being signalled.
  return out.reverse();
}

/** SIGKILL a pid, ignoring the ordinary race where it has already exited. */
function killPid(pid: number): void {
  // Never signal the whole system (0), init (1), or ourselves.
  if (pid <= 1 || pid === process.pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already reaped.
  }
}

/**
 * Windows has no process groups and no `ps`, so `taskkill /T` is the whole tree
 * walk: it terminates the pid and every process it spawned. Shared by the
 * in-flight failure path ({@link killProcessTree}) and the teardown/shutdown
 * path ({@link killGroup}) so the two cannot drift — the second one used to have
 * no Windows branch at all, which left sandbox cleanup deleting a directory out
 * from under a live engine.
 *
 * Fire-and-forget: nothing is left to await the result on the paths that call
 * this, and `execFile` itself can throw synchronously if the binary cannot be
 * spawned at all.
 */
function taskkillTree(pid: number): void {
  try {
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  } catch {
    // Fall through to whatever direct termination the caller can still do.
  }
}

/** Best-effort termination of a subprocess and all of its descendants. */
export function killProcessTree(child: ChildProcess | undefined, detachedGroup: boolean): void {
  // Stryker disable next-line ConditionalExpression: continuing with an absent child is observably the same because both best-effort kill attempts are caught.
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    taskkillTree(child.pid);
  }
  if (detachedGroup && process.platform !== 'win32') {
    // No `process.kill(-pid)` here, deliberately. See {@link descendantPids}:
    // exec()/execFile() DISCARD `detached`, so a child spawned through this
    // module is never a group leader and `-child.pid` never names its own
    // group. A SUCCESSFUL group kill therefore had exactly one meaning — some
    // UNRELATED group happened to carry a pgid equal to our child's pid — and
    // the code then returned on that success, skipping both the descendant walk
    // and the direct kill. The engine this call exists to terminate survived,
    // and somebody else's processes died in its place. The descendant walk
    // reaches everything the group kill was ever meant to reach.
    for (const pid of descendantPids(child.pid)) killPid(pid);
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Best effort on an already-failing timeout/cancellation path.
  }
}

/**
 * Detached child process GROUPS this process still owns, keyed by group leader
 * pid and valued by the working directory the child was started in.
 *
 * Killing a mutation tool kills the tool, not the test processes it spawned:
 * StrykerJS's command runner launches a `vitest` per mutant, cargo-mutants
 * launches `cargo test`, and those are grandchildren. `killProcessTree` handles
 * that for one in-flight call via the process group, but nothing owned the
 * problem at two other boundaries:
 *
 *  - A sandbox's `cleanup()` removes the temp directory while a grandchild may
 *    still be running INSIDE it. Observed in the wild: a `vitest` worker held
 *    2 GB for 20 hours, running against a directory that had been deleted
 *    minutes after it started.
 *  - Process exit reaped sandbox DIRECTORIES (see sandbox.ts) but never the
 *    process groups, so a crash or SIGTERM mid-audit orphaned every test
 *    process the engine had spawned.
 *
 * Only `killTree` spawns are tracked — that flag is how a caller states it owns
 * a whole tool invocation rather than a single process. Callers that manage a
 * child's lifetime themselves are left alone.
 *
 * Tracking is platform-independent even though the reaping mechanism is not.
 * Registration used to be gated on `platform !== 'win32'`, which left this map
 * permanently empty on Windows and quietly turned BOTH consumers into no-ops:
 * `makeCleanup` in utils/sandbox.ts reaped nothing before removing the sandbox
 * (the exact "delete the directory out from under a live vitest" failure
 * described above, made worse on Windows because rmSync over open handles then
 * fails EBUSY into a swallowing catch and the sandbox leaks too), and
 * `killAllTrackedProcesses` on SIGTERM/exit reaped nothing at all.
 * {@link killGroup} carries the platform difference instead.
 */
const ACTIVE_PROCESS_GROUPS = new Map<number, string>();

/** Register a detached child so it can be reaped by cwd or on process exit. */
export function trackProcessGroup(child: ChildProcess | undefined, cwd: string): void {
  if (child?.pid !== undefined) ACTIVE_PROCESS_GROUPS.set(child.pid, cwd);
}

/** Drop a child that has already exited on its own. */
export function untrackProcessGroup(child: ChildProcess | undefined): void {
  if (child?.pid !== undefined) ACTIVE_PROCESS_GROUPS.delete(child.pid);
}

/**
 * SIGKILL a tracked child and everything below it.
 *
 * Windows takes `taskkill /T`; there are no process groups there and no `ps` to
 * walk, and without this branch a tracked pid was dropped from the registry
 * having never been signalled.
 *
 * POSIX walks the descendant tree, deepest-first, then kills the child itself.
 * It does NOT attempt `process.kill(-pid)`: see {@link descendantPids} — the
 * children this module spawns are never group leaders, so that call could only
 * ever succeed by hitting an unrelated group, and it used to `return` on that
 * success and abandon the tracked pid entirely.
 */
function killGroup(pid: number): void {
  if (process.platform === 'win32') {
    taskkillTree(pid);
    return;
  }
  for (const descendant of descendantPids(pid)) killPid(descendant);
  killPid(pid);
}

/**
 * Kill every tracked process group whose working directory is `dir` or sits
 * inside it, and return how many were signalled.
 *
 * Scoped by directory rather than global because a triage sweep runs several
 * sandboxes concurrently: tearing one down must not kill the others' engines.
 */
export function killProcessesUnder(dir: string): number {
  const root = resolve(dir);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  let killed = 0;
  for (const [pid, cwd] of [...ACTIVE_PROCESS_GROUPS]) {
    const abs = resolve(cwd);
    if (abs !== root && !abs.startsWith(prefix)) continue;
    killGroup(pid);
    ACTIVE_PROCESS_GROUPS.delete(pid);
    killed++;
  }
  return killed;
}

/**
 * Kill every tracked process group, whatever directory it runs in, and return
 * how many were signalled. For process-exit handlers, where nothing is left to
 * receive their output.
 */
export function killAllTrackedProcesses(): number {
  const pids = [...ACTIVE_PROCESS_GROUPS.keys()];
  for (const pid of pids) killGroup(pid);
  ACTIVE_PROCESS_GROUPS.clear();
  return pids.length;
}

/** Test-only introspection hook so the tracking invariant can be asserted. */
export function _trackedProcessCount(): number {
  return ACTIVE_PROCESS_GROUPS.size;
}

/** Test-only reset so a leaked entry cannot poison an unrelated case. */
export function _resetTrackedProcesses(): void {
  ACTIVE_PROCESS_GROUPS.clear();
}

/** Arm timeout/abort tree cleanup independently of the child close callback. */
export function installProcessTreeCleanup(
  child: ChildProcess | undefined,
  killTree: boolean,
  timeoutMs: number,
  signal?: AbortSignal,
): () => void {
  if (!killTree || !child) return () => undefined;
  let active = true;
  const deactivate = (): boolean => {
    if (!active) return false;
    active = false;
    clearTimeout(timer);
    signal?.removeEventListener('abort', terminate);
    return true;
  };
  const terminate = () => {
    if (deactivate()) killProcessTree(child, true);
  };
  const timer = setTimeout(terminate, timeoutMs);
  timer.unref();
  if (signal?.aborted) terminate();
  else signal?.addEventListener('abort', terminate);
  return () => void deactivate();
}
