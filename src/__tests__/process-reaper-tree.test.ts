import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as cpType from 'child_process';

// `spawnSync` is mocked here — unlike exec-reaping.test.ts, which leaves it
// real. That is the whole point of this file: with a real `ps` and synthetic
// pids the descendant walk always finds nothing, so every branch inside it
// (the line regex, the cycle guard, the deepest-first ordering, the no-`ps`
// fallback) was unreachable from a test.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof cpType>();
  return { ...actual, spawnSync: vi.fn(), execFile: vi.fn() };
});

import { spawnSync } from 'child_process';
import {
  trackProcessGroup,
  killAllTrackedProcesses,
  killProcessesUnder,
  _resetTrackedProcesses,
  _trackedProcessCount,
} from '../utils/process-reaper.js';

const mockSpawnSync = vi.mocked(spawnSync);

/** A `ps -eo pid=,ppid=` listing, in the column shape the real one emits. */
function psTable(rows: [pid: number, ppid: number][], extraLines: string[] = []): void {
  const body = rows
    .map(([pid, ppid]) => `  ${pid}  ${ppid}`)
    .concat(extraLines)
    .join('\n');
  mockSpawnSync.mockReturnValue({ stdout: body } as unknown as ReturnType<typeof spawnSync>);
}

/** Register a tracked group without going through the exec layer. */
function track(pid: number, cwd = '/work'): void {
  trackProcessGroup({ pid } as unknown as cpType.ChildProcess, cwd);
}

describe('process-reaper: descendant tree walk', () => {
  let killed: number[];
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetTrackedProcesses();
    killed = [];
    killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      killed.push(pid);
      return true;
    }) as never);
  });

  afterEach(() => {
    killSpy.mockRestore();
    _resetTrackedProcesses();
  });

  it('kills every descendant, deepest-first, then the tracked pid itself', () => {
    // 100 -> 200 -> 300, plus a second branch 100 -> 201.
    psTable([
      [200, 100],
      [300, 200],
      [201, 100],
      [999, 1], // unrelated: must not be touched
    ]);
    track(100);

    expect(killAllTrackedProcesses()).toBe(1);

    expect(killed).not.toContain(999);
    expect(new Set(killed)).toEqual(new Set([200, 300, 201, 100]));
    // The tracked pid dies LAST, so it cannot respawn children that have
    // already been signalled.
    expect(killed[killed.length - 1]).toBe(100);
    // 300 is below 200, so it must be signalled before its parent.
    expect(killed.indexOf(300)).toBeLessThan(killed.indexOf(200));
  });

  it('asks ps for exactly the pid/ppid columns it parses', () => {
    // Mocking spawnSync hides its arguments from every other assertion here,
    // but the invocation IS the contract: drop `-eo`, or the column spec, and
    // production gets output this parser cannot read while the tests stay green.
    psTable([[200, 100]]);
    track(100);

    killAllTrackedProcesses();

    expect(mockSpawnSync).toHaveBeenCalledWith('ps', ['-eo', 'pid=,ppid='], {
      encoding: 'utf-8',
    });
  });

  it('ignores lines that are not a pid/ppid pair', () => {
    // A real `ps` can emit a header, blank lines and ragged spacing. Loosening
    // the anchors in the line regex would turn these into bogus pids.
    psTable(
      [[200, 100]],
      ['', '  PID  PPID', 'not numbers at all', '12x  100', '  300  100  extra-column'],
    );
    track(100);

    killAllTrackedProcesses();

    expect(new Set(killed)).toEqual(new Set([200, 100]));
  });

  it('requires the pid pair to be the WHOLE line, not a suffix of it', () => {
    // Without the leading `^`, a line carrying text before the pair still
    // matches and injects a process that is not in the tree.
    psTable([[200, 100]], ['some-command  300  100']);
    track(100);

    killAllTrackedProcesses();

    expect(killed).not.toContain(300);
  });

  it('rejects a ppid with trailing non-space characters', () => {
    // Relaxing the trailing `\s*$` to `\S*$` accepts "100abc" as ppid 100.
    psTable([[200, 100]], ['  400  100abc']);
    track(100);

    killAllTrackedProcesses();

    expect(killed).not.toContain(400);
  });

  it('does not signal a pid twice when a malformed table reaches it twice', () => {
    // A diamond: 400 listed under two parents. Without the `seen` bookkeeping
    // it is discovered, queued and signalled once per path.
    psTable([
      [200, 100],
      [300, 100],
      [400, 200],
      [400, 300],
    ]);
    track(100);

    killAllTrackedProcesses();

    expect(killed.filter((pid) => pid === 400)).toHaveLength(1);
  });

  it('terminates on a malformed table that cycles back to an ancestor', () => {
    // Impossible in a real process table, but a cycle must not spin forever
    // and must not signal the same pid twice.
    psTable([
      [200, 100],
      [100, 200],
    ]);
    track(100);

    killAllTrackedProcesses();

    expect(killed.filter((pid) => pid === 200)).toHaveLength(1);
    // The root is pre-seeded into `seen`, so the cycle cannot rediscover it and
    // queue it as its own descendant on top of the final kill.
    expect(killed.filter((pid) => pid === 100)).toHaveLength(1);
  });

  it('falls back to the tracked pid alone when ps is unavailable', () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error('ENOENT: ps');
    });
    track(100);

    killAllTrackedProcesses();

    expect(killed).toEqual([100]);
  });

  it('treats a ps run with no stdout as an empty listing', () => {
    mockSpawnSync.mockReturnValue({ stdout: undefined } as unknown as ReturnType<typeof spawnSync>);
    track(100);

    killAllTrackedProcesses();

    expect(killed).toEqual([100]);
  });

  it('never signals pid 0, pid 1, or this process', () => {
    // Guard rails: 0 is "every process in the group", 1 is init, and signalling
    // ourselves would kill the audit that is doing the reaping.
    psTable([
      [0, 100],
      [1, 100],
      [process.pid, 100],
      [200, 100],
    ]);
    track(100);

    killAllTrackedProcesses();

    expect(killed).not.toContain(0);
    expect(killed).not.toContain(1);
    expect(killed).not.toContain(process.pid);
    expect(killed).toContain(200);
  });

  it('survives a kill that throws because the pid already exited', () => {
    psTable([[200, 100]]);
    killSpy.mockImplementation((() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    }) as never);
    track(100);

    expect(() => killAllTrackedProcesses()).not.toThrow();
  });
});

describe('process-reaper: directory scoping', () => {
  let killed: number[];
  let killSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetTrackedProcesses();
    killed = [];
    killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      killed.push(pid);
      return true;
    }) as never);
    psTable([]);
  });

  afterEach(() => {
    killSpy.mockRestore();
    _resetTrackedProcesses();
  });

  it('kills groups inside the directory and leaves siblings alone', () => {
    // A triage sweep runs several sandboxes at once; tearing one down must not
    // reach into another.
    track(100, '/sandboxes/a');
    track(200, '/sandboxes/a/nested');
    track(300, '/sandboxes/b');

    expect(killProcessesUnder('/sandboxes/a')).toBe(2);

    expect(new Set(killed)).toEqual(new Set([100, 200]));
    expect(_trackedProcessCount()).toBe(1);
  });

  it('does not treat a sibling with a shared name prefix as being inside', () => {
    // '/sandboxes/a-other' starts with '/sandboxes/a' as a STRING but is not
    // inside it; the separator is what makes the boundary real.
    track(100, '/sandboxes/a');
    track(200, '/sandboxes/a-other');

    expect(killProcessesUnder('/sandboxes/a')).toBe(1);

    expect(killed).toEqual([100]);
    expect(_trackedProcessCount()).toBe(1);
  });

  it('accepts a directory given with a trailing separator', () => {
    track(100, '/sandboxes/a');

    expect(killProcessesUnder('/sandboxes/a/')).toBe(1);
    expect(killed).toEqual([100]);
  });

  it('returns zero and kills nothing when no group matches', () => {
    track(100, '/sandboxes/a');

    expect(killProcessesUnder('/sandboxes/zzz')).toBe(0);

    expect(killed).toEqual([]);
    expect(_trackedProcessCount()).toBe(1);
  });
});

describe('process-reaper: killProcessTree', () => {
  let killed: number[];
  let killSpy: ReturnType<typeof vi.spyOn>;

  function fakeChild(pid: number | undefined) {
    return { pid, kill: vi.fn() } as unknown as cpType.ChildProcess;
  }

  beforeEach(() => {
    _resetTrackedProcesses();
    killed = [];
    killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      killed.push(pid);
      return true;
    }) as never);
  });

  afterEach(() => {
    killSpy.mockRestore();
  });

  it('walks descendants and then kills the child when the group is detached', async () => {
    const { killProcessTree } = await import('../utils/process-reaper.js');
    psTable([[200, 100]]);
    const child = fakeChild(100);

    killProcessTree(child, true);

    expect(killed).toContain(200);
    expect(vi.mocked(child.kill)).toHaveBeenCalledWith('SIGKILL');
  });

  it('skips the descendant walk when the caller did not claim the group', async () => {
    // detachedGroup=false means the caller owns a single process, not a tree.
    // Walking anyway would reach processes it never claimed.
    const { killProcessTree } = await import('../utils/process-reaper.js');
    psTable([[200, 100]]);
    const child = fakeChild(100);

    killProcessTree(child, false);

    expect(killed).not.toContain(200);
    expect(vi.mocked(child.kill)).toHaveBeenCalledWith('SIGKILL');
  });

  it('does nothing for a child that never got a pid', async () => {
    const { killProcessTree } = await import('../utils/process-reaper.js');
    psTable([[200, 100]]);
    const child = fakeChild(undefined);

    killProcessTree(child, true);

    expect(killed).toEqual([]);
    expect(vi.mocked(child.kill)).not.toHaveBeenCalled();
  });

  it('swallows a child.kill that throws on an already-failing path', async () => {
    const { killProcessTree } = await import('../utils/process-reaper.js');
    psTable([]);
    const child = {
      pid: 100,
      kill: vi.fn(() => {
        throw new Error('already gone');
      }),
    } as unknown as cpType.ChildProcess;

    expect(() => killProcessTree(child, true)).not.toThrow();
  });
});

describe('process-reaper: Windows tree termination', () => {
  // Windows has no process groups and no `ps`, so `taskkill /T` IS the tree
  // walk. Running on Linux, this whole branch is otherwise unreachable — which
  // is how it once shipped missing entirely, leaving sandbox cleanup deleting a
  // directory out from under a live engine.
  const realPlatform = process.platform;
  let killSpy: ReturnType<typeof vi.spyOn>;

  function asWin32(): void {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  }

  beforeEach(() => {
    _resetTrackedProcesses();
    killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never);
    psTable([[200, 100]]);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    killSpy.mockRestore();
    _resetTrackedProcesses();
  });

  it('reaps a tracked group with taskkill /T instead of walking ps', async () => {
    const { execFile } = await import('child_process');
    asWin32();
    track(100);

    expect(killAllTrackedProcesses()).toBe(1);

    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '100', '/T', '/F'],
      { windowsHide: true },
      expect.any(Function),
    );
    // No POSIX signalling, and no ps walk to derive it from.
    expect(killSpy).not.toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
  });

  it('does not walk descendants in killProcessTree on Windows', async () => {
    const { killProcessTree } = await import('../utils/process-reaper.js');
    const { execFile } = await import('child_process');
    asWin32();
    const child = { pid: 100, kill: vi.fn() } as unknown as cpType.ChildProcess;

    killProcessTree(child, true);

    expect(vi.mocked(execFile)).toHaveBeenCalled();
    expect(mockSpawnSync).not.toHaveBeenCalled();
    // The direct kill still runs: taskkill is fire-and-forget.
    expect(vi.mocked(child.kill)).toHaveBeenCalledWith('SIGKILL');
  });

  it('keeps reaping when taskkill cannot be spawned at all', async () => {
    const { execFile } = await import('child_process');
    vi.mocked(execFile).mockImplementation((() => {
      throw new Error('ENOENT: taskkill');
    }) as never);
    asWin32();
    track(100);

    expect(() => killAllTrackedProcesses()).not.toThrow();
    expect(_trackedProcessCount()).toBe(0);
  });
});

describe('process-reaper: installProcessTreeCleanup', () => {
  let killSpy: ReturnType<typeof vi.spyOn>;
  let killed: number[];

  function fakeChild(pid: number) {
    return { pid, kill: vi.fn() } as unknown as cpType.ChildProcess;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    killed = [];
    killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
      killed.push(pid);
      return true;
    }) as never);
    psTable([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    killSpy.mockRestore();
  });

  it('kills the tree when the timeout elapses', async () => {
    const { installProcessTreeCleanup } = await import('../utils/process-reaper.js');
    const child = fakeChild(100);

    installProcessTreeCleanup(child, true, 1000);
    expect(vi.mocked(child.kill)).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);

    expect(vi.mocked(child.kill)).toHaveBeenCalledWith('SIGKILL');
  });

  it('reaps DESCENDANTS on timeout, not just the direct child', async () => {
    // The whole reason this module exists: a timed-out engine's `vitest` /
    // `cargo test` grandchildren outlive it otherwise. Passing the timeout
    // cleanup a non-detached kill would terminate the engine and leave the
    // tree running — the "vitest worker held 2 GB for 20 hours" failure.
    const { installProcessTreeCleanup } = await import('../utils/process-reaper.js');
    psTable([
      [200, 100],
      [300, 200],
    ]);
    const child = fakeChild(100);

    installProcessTreeCleanup(child, true, 1000);
    vi.advanceTimersByTime(1000);

    expect(killed).toContain(200);
    expect(killed).toContain(300);
  });

  it('disarms the timer when disposed, rather than leaving it pending', async () => {
    // Skipping clearTimeout is invisible in behaviour — the fire is a no-op
    // once deactivated — but leaves a timer armed per exec for its full
    // timeout, which on a triage sweep is thousands of them.
    const { installProcessTreeCleanup } = await import('../utils/process-reaper.js');
    const child = fakeChild(100);

    const before = vi.getTimerCount();
    const dispose = installProcessTreeCleanup(child, true, 60_000);
    expect(vi.getTimerCount()).toBe(before + 1);

    dispose();

    expect(vi.getTimerCount()).toBe(before);
  });

  it('the returned disposer prevents a later timeout from firing', async () => {
    const { installProcessTreeCleanup } = await import('../utils/process-reaper.js');
    const child = fakeChild(100);

    const dispose = installProcessTreeCleanup(child, true, 1000);
    dispose();
    vi.advanceTimersByTime(5000);

    expect(vi.mocked(child.kill)).not.toHaveBeenCalled();
  });

  it('kills the tree when the abort signal fires', async () => {
    const { installProcessTreeCleanup } = await import('../utils/process-reaper.js');
    const child = fakeChild(100);
    const controller = new AbortController();

    installProcessTreeCleanup(child, true, 60_000, controller.signal);
    controller.abort();

    expect(vi.mocked(child.kill)).toHaveBeenCalledWith('SIGKILL');
  });

  it('kills immediately when the signal is ALREADY aborted at install time', async () => {
    // Arming a listener on an already-aborted signal would never fire, leaving
    // the tree alive until the timeout.
    const { installProcessTreeCleanup } = await import('../utils/process-reaper.js');
    const child = fakeChild(100);

    installProcessTreeCleanup(child, true, 60_000, AbortSignal.abort());

    expect(vi.mocked(child.kill)).toHaveBeenCalledWith('SIGKILL');
  });

  it('fires once, even when the signal aborts after the timeout already killed', async () => {
    const { installProcessTreeCleanup } = await import('../utils/process-reaper.js');
    const child = fakeChild(100);
    const controller = new AbortController();

    installProcessTreeCleanup(child, true, 1000, controller.signal);
    vi.advanceTimersByTime(1000);
    controller.abort();

    expect(vi.mocked(child.kill)).toHaveBeenCalledTimes(1);
  });

  it('is inert when the caller did not ask for tree cleanup', async () => {
    const { installProcessTreeCleanup } = await import('../utils/process-reaper.js');
    const child = fakeChild(100);

    const dispose = installProcessTreeCleanup(child, false, 1000);
    vi.advanceTimersByTime(5000);

    expect(vi.mocked(child.kill)).not.toHaveBeenCalled();
    expect(() => dispose()).not.toThrow();
  });

  it('is inert when there is no child at all', async () => {
    const { installProcessTreeCleanup } = await import('../utils/process-reaper.js');

    const dispose = installProcessTreeCleanup(undefined, true, 1000);
    vi.advanceTimersByTime(5000);

    expect(() => dispose()).not.toThrow();
  });
});
