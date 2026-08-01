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
import { ExecFailureError } from '../utils/exec-error.js';
import { _trackedProcessCount, _resetTrackedProcesses } from '../utils/process-reaper.js';

/**
 * Wiring inside the private `runChild` that neither the reaping suite nor the
 * classifier suite reaches, because both observe it from one side only.
 *
 * `exec-reaping.test.ts` always spawns a child that is still running, so the
 * `completed` guard is only ever seen in its false state. `classify-child-error.test.ts`
 * calls `classifyChildError` with a hand-built context, so it pins the
 * classifier's behaviour without ever exercising the `classifyEnoent` value the
 * front-ends actually pass. Both gaps showed up as surviving mutants in a
 * chaos-mcp audit of `src/utils/exec.ts`.
 */

/**
 * Spawn a child whose completion callback fires BEFORE the spawn call returns.
 *
 * Node's real `exec`/`execFile` always call back asynchronously, so this shape
 * only arises through the injected `spawnChild` seam — which is exactly the
 * contract the `completed` guard exists to honour.
 */
function syncChild(mocked: typeof exec | typeof execFile, pid: number, err: Error | null = null) {
  vi.mocked(mocked).mockImplementationOnce(((...callArgs: unknown[]) => {
    const done = callArgs[callArgs.length - 1] as (
      e: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    done(err, '', '');
    return { pid, kill: vi.fn() } as unknown as cpType.ChildProcess;
  }) as never);
}

/** Capture the ExecFailureError a rejecting run produces; throw loudly if it resolves. */
async function expectRejection(fn: () => Promise<unknown>): Promise<ExecFailureError> {
  try {
    await fn();
  } catch (err: unknown) {
    if (err instanceof ExecFailureError) return err;
    throw err;
  }
  throw new Error('expected the run to reject, but it resolved');
}

describe('runChild: a child that completes before spawn returns', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetTrackedProcesses();
  });

  afterEach(() => {
    _resetTrackedProcesses();
  });

  it('does not register a shell child that already finished', async () => {
    // The `completed` flag is set from inside the completion callback, so when
    // that callback runs synchronously the tracking block below it must be
    // skipped entirely. Registering here would leave a pid in the registry that
    // the completion callback already tried to remove — one the OS is free to
    // reuse, so a later reap would signal an unrelated process.
    syncChild(exec, 5001);

    await runShellCommand('npm test', { cwd: '/tmp/sbx-sync', killTree: true });

    expect(_trackedProcessCount()).toBe(0);
  });

  it('does not register an execFile child that already finished', async () => {
    syncChild(execFile, 5002);

    await runShell('cargo', ['mutants'], { cwd: '/tmp/sbx-sync', killTree: true });

    expect(_trackedProcessCount()).toBe(0);
  });

  it('still registers a child that is genuinely still running', async () => {
    // The contrast case: the guard must not suppress tracking wholesale, or the
    // reaping suite's invariant (track while running, drop on exit) is lost.
    let settle: ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
    vi.mocked(exec).mockImplementationOnce(((...callArgs: unknown[]) => {
      settle = callArgs[callArgs.length - 1] as typeof settle;
      return { pid: 5003, kill: vi.fn() } as unknown as cpType.ChildProcess;
    }) as never);

    const running = runShellCommand('stryker run', { cwd: '/tmp/sbx-live', killTree: true });
    expect(_trackedProcessCount()).toBe(1);

    settle?.(null, '', '');
    await running;
    expect(_trackedProcessCount()).toBe(0);
  });
});

describe('runChild: ENOENT wiring per front-end', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetTrackedProcesses();
  });

  afterEach(() => {
    _resetTrackedProcesses();
  });

  it('reports a shell-path ENOENT generically, not as a missing command', async () => {
    // `runShellCommand` passes `classifyEnoent: false` on purpose: through a
    // shell a missing command comes back as exit code 127, so an ENOENT here
    // means the CWD was gone. Classifying it would report "Shell command not
    // found: npm run build" for a command that exists perfectly well.
    const enoent = Object.assign(new Error('spawn /bin/sh ENOENT'), {
      code: 'ENOENT',
      killed: false,
      signal: null,
    });
    syncChild(exec, 5004, enoent);

    const failure = await expectRejection(() =>
      runShellCommand('npm run build', { cwd: '/tmp/does-not-exist' }),
    );

    expect(failure.code).toBe('SIGNAL');
    expect(failure.message).toBe('Shell command exited with code null: npm run build');
  });

  it('reports an execFile-path ENOENT as a missing binary', async () => {
    // The asymmetry the shell case exists to preserve: `execFile` spawns the
    // binary directly, so ENOENT really does mean it is not installed.
    const enoent = Object.assign(new Error('spawn ghost-bin ENOENT'), {
      code: 'ENOENT',
      killed: false,
      signal: null,
    });
    syncChild(execFile, 5005, enoent);

    const failure = await expectRejection(() => runShell('ghost-bin', ['--version']));

    expect(failure.code).toBe('ENOENT');
    expect(failure.message).toBe('Command not found: ghost-bin');
  });
});
