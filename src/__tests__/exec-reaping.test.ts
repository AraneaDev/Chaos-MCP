import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type * as cpType from 'child_process';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof cpType>();
  return { ...actual, execFile: vi.fn(actual.execFile), exec: vi.fn(actual.exec) };
});

vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  isVerbose: vi.fn(() => false),
}));

import { execFile, exec } from 'child_process';
import { runShell, runShellCommand } from '../utils/exec.js';
import {
  killProcessesUnder,
  killAllTrackedProcesses,
  _trackedProcessCount,
  _resetTrackedProcesses,
} from '../utils/process-reaper.js';

/**
 * Reaping of engine processes and everything they spawned.
 *
 * A mutation engine is not a leaf process: StrykerJS's command runner launches a
 * `vitest` per mutant, cargo-mutants launches `cargo test`. Killing the engine
 * leaves those grandchildren running, and removing the sandbox directory
 * underneath them does not stop them either — it just leaves them executing
 * against a path that no longer exists. This suite pins the registry that makes
 * them reapable, by directory and on process exit.
 */

/** Spawn a child that has NOT finished yet, so the tracking window is open. */
function pendingChild(mocked: typeof exec | typeof execFile, pid: number) {
  let settle: ((err: unknown, stdout: string, stderr: string) => void) | undefined;
  vi.mocked(mocked).mockImplementationOnce(((...callArgs: unknown[]) => {
    settle = callArgs[callArgs.length - 1] as typeof settle;
    return { pid, kill: vi.fn() } as unknown as cpType.ChildProcess;
  }) as never);
  return {
    finish: () => settle?.(null, '', ''),
  };
}

describe('process-group reaping', () => {
  let platform: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    _resetTrackedProcesses();
    // The registry only exists for POSIX process groups; Windows uses taskkill.
    platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  });

  afterEach(() => {
    platform.mockRestore();
    _resetTrackedProcesses();
  });

  it('tracks a detached child while it runs and drops it once it exits', async () => {
    const child = pendingChild(exec, 4001);
    const running = runShellCommand('stryker run', { cwd: '/tmp/sbx-a', killTree: true });

    expect(_trackedProcessCount()).toBe(1);

    child.finish();
    await running;

    // A child that exited on its own must not linger in the registry, or a
    // later reap would signal a pid the OS may since have reused.
    expect(_trackedProcessCount()).toBe(0);
  });

  it('does not track a child spawned without killTree', async () => {
    // `killTree` is how a caller asks for tree semantics. Without it the caller
    // owns the child's lifetime, so the registry stays out of the way.
    const child = pendingChild(exec, 4002);
    const running = runShellCommand('npm test', { cwd: '/tmp/sbx-a' });

    expect(_trackedProcessCount()).toBe(0);

    child.finish();
    await running;
  });

  it('tracks runShell the same way as runShellCommand', async () => {
    const child = pendingChild(execFile, 4003);
    const running = runShell('cargo', ['mutants'], { cwd: '/tmp/sbx-b', killTree: true });

    expect(_trackedProcessCount()).toBe(1);

    child.finish();
    await running;
    expect(_trackedProcessCount()).toBe(0);
  });

  describe('killProcessesUnder', () => {
    it('reaps only the groups running inside the given directory', async () => {
      // The case that matters: a triage sweep tears down one sandbox while its
      // siblings are still auditing. A global kill here would abort the rest of
      // the run and report their files as errored.
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      const a = pendingChild(exec, 5001);
      const b = pendingChild(exec, 5002);
      const runA = runShellCommand('stryker run', { cwd: '/tmp/sbx-a', killTree: true });
      const runB = runShellCommand('stryker run', { cwd: '/tmp/sbx-b', killTree: true });

      expect(killProcessesUnder('/tmp/sbx-a')).toBe(1);

      expect(kill).toHaveBeenCalledWith(5001, 'SIGKILL');
      expect(kill).not.toHaveBeenCalledWith(5002, 'SIGKILL');
      expect(_trackedProcessCount()).toBe(1);

      a.finish();
      b.finish();
      await Promise.all([runA, runB]);
      kill.mockRestore();
    });

    it('reaps a child running in a SUBDIRECTORY of the sandbox', async () => {
      // Engines run their test command from a package subdirectory in monorepo
      // layouts, so an exact-path match alone would miss them.
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      const child = pendingChild(exec, 5003);
      const running = runShellCommand('vitest run', {
        cwd: '/tmp/sbx-a/packages/app',
        killTree: true,
      });

      expect(killProcessesUnder('/tmp/sbx-a')).toBe(1);
      expect(kill).toHaveBeenCalledWith(5003, 'SIGKILL');

      child.finish();
      await running;
      kill.mockRestore();
    });

    it('does not reap a sibling directory that merely shares a name prefix', async () => {
      // `/tmp/sbx-1` must not match `/tmp/sbx-10`. Sandbox names are generated,
      // so prefix collisions are ordinary, and killing the wrong one would end
      // an unrelated audit.
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      const child = pendingChild(exec, 5004);
      const running = runShellCommand('stryker run', { cwd: '/tmp/sbx-10', killTree: true });

      expect(killProcessesUnder('/tmp/sbx-1')).toBe(0);
      expect(kill).not.toHaveBeenCalled();
      expect(_trackedProcessCount()).toBe(1);

      child.finish();
      await running;
      kill.mockRestore();
    });

    it('never signals a negative pid, which would target an unrelated group', async () => {
      // `killGroup` used to try `process.kill(-pid)` first and RETURN on
      // success. A child spawned through exec/execFile is never a group leader
      // (see descendantPids), so the only way that call could succeed was an
      // unrelated process group whose pgid had been recycled onto our child's
      // pid — at which point the reap SIGKILLed those processes, dropped the
      // tracked pid from the registry, and left the engine running.
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      const child = pendingChild(exec, 5005);
      const running = runShellCommand('stryker run', { cwd: '/tmp/sbx-a', killTree: true });

      killProcessesUnder('/tmp/sbx-a');

      expect(kill.mock.calls.map((c) => c[0] as number).filter((t) => t < 0)).toEqual([]);
      expect(kill).toHaveBeenCalledWith(5005, 'SIGKILL');

      child.finish();
      await running;
      kill.mockRestore();
    });

    it('survives a pid the OS has already reaped', async () => {
      // Both kills throwing is the normal race, not an error — the reap runs on
      // teardown paths that must not throw.
      const kill = vi.spyOn(process, 'kill').mockImplementation((() => {
        throw new Error('ESRCH');
      }) as never);
      const child = pendingChild(exec, 5006);
      const running = runShellCommand('stryker run', { cwd: '/tmp/sbx-a', killTree: true });

      expect(() => killProcessesUnder('/tmp/sbx-a')).not.toThrow();
      expect(_trackedProcessCount()).toBe(0);

      child.finish();
      await running;
      kill.mockRestore();
    });
  });

  describe('descendant reaping (the killTree regression)', () => {
    /**
     * Node's callback-based exec/execFile accept `detached` and discard it —
     * only spawn honours it. So the child stays in OUR process group and
     * `kill(-pid)` fails with ESRCH, which used to mean only the direct child
     * died. Every grandchild (a StrykerJS `vitest`, a cargo-mutants `cargo
     * test`) survived. These cases pin the fallback that actually reaches them.
     */
    it('walks the process tree instead of trusting a process group', async () => {
      const killed: number[] = [];
      const kill = vi.spyOn(process, 'kill').mockImplementation(((target: number) => {
        if (target < 0) throw new Error('ESRCH'); // no such group — the real behaviour
        killed.push(target);
        return true;
      }) as never);
      const child = pendingChild(exec, 7001);
      const running = runShellCommand('stryker run', { cwd: '/tmp/sbx-a', killTree: true });

      killProcessesUnder('/tmp/sbx-a');

      // The tracked pid is signalled by the tree walk rather than being
      // abandoned to a group kill that cannot reach it.
      expect(killed).toContain(7001);

      child.finish();
      await running;
      kill.mockRestore();
    });

    it('never signals pid 0, init, or the audit process itself', async () => {
      // `kill(0, ...)` signals the entire process group and `kill(1, ...)` targets
      // init; a malformed `ps` line must not be able to reach either, and the
      // walk must never turn on the process running it.
      const kill = vi.spyOn(process, 'kill').mockImplementation(((target: number) => {
        if (target < 0) throw new Error('ESRCH');
        return true;
      }) as never);
      const child = pendingChild(exec, 7002);
      const running = runShellCommand('stryker run', { cwd: '/tmp/sbx-a', killTree: true });

      killProcessesUnder('/tmp/sbx-a');

      const targets = kill.mock.calls.map((c) => c[0] as number).filter((t) => t >= 0);
      expect(targets).not.toContain(0);
      expect(targets).not.toContain(1);
      expect(targets).not.toContain(process.pid);

      child.finish();
      await running;
      kill.mockRestore();
    });
  });

  describe('killAllTrackedProcesses', () => {
    it('reaps every group regardless of directory and empties the registry', async () => {
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      const a = pendingChild(exec, 6001);
      const b = pendingChild(exec, 6002);
      const runA = runShellCommand('stryker run', { cwd: '/tmp/sbx-a', killTree: true });
      const runB = runShellCommand('stryker run', { cwd: '/other/place', killTree: true });

      expect(killAllTrackedProcesses()).toBe(2);

      expect(kill).toHaveBeenCalledWith(6001, 'SIGKILL');
      expect(kill).toHaveBeenCalledWith(6002, 'SIGKILL');
      expect(_trackedProcessCount()).toBe(0);

      a.finish();
      b.finish();
      await Promise.all([runA, runB]);
      kill.mockRestore();
    });

    it('is a no-op when nothing is running', () => {
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      expect(killAllTrackedProcesses()).toBe(0);
      expect(kill).not.toHaveBeenCalled();
      kill.mockRestore();
    });
  });

  describe('Windows', () => {
    /**
     * Tracking used to be gated on `process.platform !== 'win32'`, so the
     * registry was permanently EMPTY on Windows and both consumers silently
     * reaped nothing: sandbox teardown deleted the directory while the engine's
     * grandchildren were still running inside it (and then rmSync failed
     * EBUSY/EPERM into a swallowing catch, so the sandbox leaked as well), and
     * the SIGTERM/exit sweep had nothing to sweep. `killProcessTree` did have a
     * taskkill path, but it is only reachable from the exec failure callback —
     * never from teardown or shutdown.
     */
    it('tracks killTree children and reaps them with taskkill /T', async () => {
      platform.mockReturnValue('win32');
      const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
      vi.mocked(execFile).mockImplementation((() => undefined) as never);
      const child = pendingChild(exec, 8001);
      const running = runShellCommand('stryker run', { cwd: '/tmp/sbx-a', killTree: true });

      expect(_trackedProcessCount()).toBe(1);

      expect(killProcessesUnder('/tmp/sbx-a')).toBe(1);
      expect(execFile).toHaveBeenCalledWith(
        'taskkill',
        ['/PID', '8001', '/T', '/F'],
        { windowsHide: true },
        expect.any(Function),
      );
      // No POSIX signalling on Windows: there are no process groups there and
      // no `ps` to walk.
      expect(kill).not.toHaveBeenCalled();
      expect(_trackedProcessCount()).toBe(0);

      child.finish();
      await running;
      kill.mockRestore();
    });

    it('reaps Windows children on the shutdown sweep as well', async () => {
      platform.mockReturnValue('win32');
      vi.mocked(execFile).mockImplementation((() => undefined) as never);
      const child = pendingChild(exec, 8002);
      const running = runShellCommand('stryker run', { cwd: '/tmp/sbx-b', killTree: true });

      expect(killAllTrackedProcesses()).toBe(1);
      expect(execFile).toHaveBeenCalledWith(
        'taskkill',
        ['/PID', '8002', '/T', '/F'],
        { windowsHide: true },
        expect.any(Function),
      );

      child.finish();
      await running;
    });

    it('survives a taskkill that cannot be spawned at all', async () => {
      // Best-effort like every other reap path: this runs from teardown and
      // process-exit handlers, where throwing would strand the rest.
      platform.mockReturnValue('win32');
      vi.mocked(execFile).mockImplementation((() => {
        throw new Error('taskkill unavailable');
      }) as never);
      const child = pendingChild(exec, 8003);
      const running = runShellCommand('stryker run', { cwd: '/tmp/sbx-c', killTree: true });

      expect(() => killProcessesUnder('/tmp/sbx-c')).not.toThrow();
      expect(_trackedProcessCount()).toBe(0);

      child.finish();
      await running;
    });
  });
});
