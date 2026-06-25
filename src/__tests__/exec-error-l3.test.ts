import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as cpType from 'child_process';

/**
 * `vi.mock` factories are hoisted ABOVE top-level declarations, so any
 * module-scope variable the factory wants to write into must itself be
 * hoisted via `vi.hoisted()`. Otherwise the factory runs while the `let`
 * is in the temporal dead zone and throws "Cannot access X before
 * initialization".
 *
 * `realExecFile` is the underlying real execFile captured BEFORE the
 * vi.mock swap; we re-delegate to it in `beforeEach` so the positive-arm
 * test still spawns a real Node child.
 */
const hoistedRefs = vi.hoisted(() => ({
  realExecFile: null as typeof cpType.execFile | null,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof cpType>();
  hoistedRefs.realExecFile = actual.execFile;
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
  };
});

// Mock logger for verbose tests
vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  isVerbose: vi.fn().mockReturnValue(false),
}));

import { execFile } from 'child_process';
import { runShell, ExecFailureError } from '../utils/exec.js';

/** Same shape as the helper in `exec-error.test.ts`. */
async function expectRejection(fn: () => Promise<unknown>): Promise<ExecFailureError> {
  try {
    await fn();
  } catch (err: unknown) {
    if (err instanceof ExecFailureError) return err;
    throw err;
  }
  throw new Error('expected runShell() to reject, but it resolved');
}

/**
 * Live-audit L3 (`LIVE-AUDIT.md`):
 *   - The pre-fix wrapper classified ANY `signal='SIGTERM' + exit=null` as
 *     TIMEOUT, including external kills (OOM, parent SIGTERM) which have
 *     `killed=false`.
 *   - The fix gates TIMEOUT classification on `killed === true` (set by
 *     execFile's internal child.kill() call when its configured timeout
 *     elapses, NOT set for OS-level external kills).
 *
 * Both arms live here because the wrapper's only consumer is `runShell` —
 * we can't reach `errnoError.killed` from outside without mocking the
 * child_process module entirely. Spy-based approaches (`vi.spyOn`)
 * don't work on ESM module exports ("namespace not configurable"),
 * so vi.mock with vi.importActual is the canonical workaround.
 */
describe('Live-audit L3: runShell TIMEOUT classification', () => {
  beforeEach(() => {
    // mockReset clears any per-test implementation overrides; re-establish
    // the default delegation to the real execFile so the positive arm still
    // spawns an actual Node child.
    vi.mocked(execFile).mockReset();
    const ref = hoistedRefs.realExecFile;
    if (!ref) {
      throw new Error(
        'exec-error-l3 test setup error: vi.mock factory did not capture the real execFile',
      );
    }
    vi.mocked(execFile).mockImplementation(ref);
  });

  it('positive arm: a configured-timeout end is classified as code=TIMEOUT', async () => {
    // Real execFile (delegated) spawns a Node child that runs for 60s.
    // timeoutMs: 200 forces execFile to call child.kill() internally,
    // so the resulting error has killed=true AND signal='SIGTERM'.
    const caught = await expectRejection(() =>
      runShell('node', ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 }),
    );
    expect(caught.code).toBe('TIMEOUT');
    expect(caught.exit).toBeNull();
    expect(caught.signal).toBe('SIGTERM');
  });

  it('classifies ENOENT when err.code is the string ENOENT', async () => {
    vi.mocked(execFile).mockImplementationOnce(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const err = Object.assign(new Error('spawn ENOENT'), {
        code: 'ENOENT' as string,
        signal: undefined,
        killed: false,
      });
      setImmediate(() => cb(err, '', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() => runShell('nonexistent-binary', []));
    expect(caught.code).toBe('ENOENT');
    expect(caught.exit).toBeNull();
  });

  it('classifies non-zero exit when err.code is a number (not ENOENT/TIMEOUT/signal)', async () => {
    vi.mocked(execFile).mockImplementationOnce(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const err = Object.assign(new Error('Command failed'), {
        code: 1 as number,
        signal: undefined,
        killed: false,
      });
      setImmediate(() => cb(err, '', 'some error'));
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() => runShell('node', ['test.js']));
    expect(caught.exit).toBe(1);
    expect(caught.signal).toBeNull();
  });

  it('handles err.code = undefined gracefully (fallthrough to non-zero exit)', async () => {
    vi.mocked(execFile).mockImplementationOnce(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const err = Object.assign(new Error('Unknown failure'), {
        code: undefined,
        signal: undefined,
        killed: false,
      });
      setImmediate(() => cb(err, '', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() => runShell('node', ['test.js']));
    // code=undefined → exit=null, signal=null, not ENOENT, not TIMEOUT
    // Falls through to non-zero exit with code=String('SIGNAL')
    expect(caught.exit).toBeNull();
    expect(caught.signal).toBeNull();
    expect(caught.code).toBe('SIGNAL');
  });

  it('negative arm: an external SIGTERM (killed=false) is NOT classified as TIMEOUT', async () => {
    // Override the mock for one invocation. We mimic what Node's execFile
    // callback receives for an OS-level kill (OOM killer, parent SIGTERM):
    //   - err.signal = 'SIGTERM'
    //   - err.killed = false  ← decisive signal that is NOT a wrapper timeout
    //   - err.code = null (no numeric exit code)
    // The wrapper's TIMEOUT gate (killed === true && exit === null && signal)
    // does NOT fire, so the error falls through to the signal-crash branch
    // with code = String('SIGNAL').
    vi.mocked(execFile).mockImplementationOnce(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const err = Object.assign(new Error('Child killed externally'), {
        code: null,
        signal: 'SIGTERM' as NodeJS.Signals,
        killed: false,
      });
      setImmediate(() => cb(err, '', ''));
      // Return a placeholder ChildProcess; the callback form doesn't require
      // the return value to be consumed by the wrapper.
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() => runShell('node', ['-e', 'process.exit(0)']));
    expect(caught.code).not.toBe('TIMEOUT');
    expect(caught.signal).toBe('SIGTERM');
    // And not an empty/numeric exit either \u2014 fall-through to signal-crash
    expect(caught.exit).toBeNull();
  });

  it('handles killed=true with numeric exit (not TIMEOUT, falls to non-zero exit)', async () => {
    // Edge case: killed=true but exit is a number (killed after exiting with code).
    // The TIMEOUT gate requires exit === null, so this falls through to non-zero exit.
    vi.mocked(execFile).mockImplementationOnce(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const err = Object.assign(new Error('Process exited then killed'), {
        code: 1 as number,
        killed: true,
        signal: 'SIGTERM' as NodeJS.Signals,
      });
      setImmediate(() => cb(err, '', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() => runShell('node', ['-e', '0']));
    // Not TIMEOUT because exit is not null
    expect(caught.code).not.toBe('TIMEOUT');
    expect(caught.exit).toBe(1);
    expect(caught.signal).toBe('SIGTERM');
  });

  it('passes custom env to execFile', async () => {
    vi.mocked(execFile).mockImplementationOnce(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      setImmediate(() => cb(null, '', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    await runShell('node', ['-e', '0'], { env: { NODE_ENV: 'test' } });

    expect(vi.mocked(execFile)).toHaveBeenCalled();
    const callOpts = vi.mocked(execFile).mock.calls[0]?.[2] as Record<string, unknown> | undefined;
    expect(callOpts?.env).toEqual({ NODE_ENV: 'test' });
  });

  it('logs command in verbose mode', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    const mockVerbose = vi.mocked(isVerbose);

    mockVerbose.mockReturnValue(true);
    vi.mocked(execFile).mockImplementationOnce(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: Error | null, stdout: string, stderr: string) => void,
    ) => {
      setImmediate(() => cb(null, '', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    await runShell('node', ['-e', '0']);

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('exec:'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('node'));
    // Pin the full formatted shape so every string fragment of the log line
    // (the "-e 0" arg separator, "(cwd=", ", timeout=", "ms)") is asserted.
    expect(mockLog).toHaveBeenCalledWith(
      expect.stringMatching(/exec: node -e 0 {2}\(cwd=.+, timeout=\d+ms\)/),
    );
    // Reset
    mockVerbose.mockReturnValue(false);
  });
});

/**
 * Mutation-driven coverage for runShell's resolve path and error-message
 * formatting. The L3 suite above only ever feeds the callback empty strings,
 * leaving the `stdout ?? ''` / `stderr ?? ''` fallbacks (and every error
 * message string) unverified — Chaos-MCP flagged these as surviving mutants.
 */
describe('runShell resolve path + error messages', () => {
  beforeEach(() => {
    vi.mocked(execFile).mockReset();
  });

  /** Drive runShell's callback with a controlled (err, stdout, stderr) triple. */
  function feed(err: unknown, stdout: unknown, stderr: unknown): void {
    vi.mocked(execFile).mockImplementationOnce(((
      _cmd: string,
      _args: string[],
      _opts: unknown,
      cb: (err: unknown, stdout: unknown, stderr: unknown) => void,
    ) => {
      setImmediate(() => cb(err, stdout, stderr));
      return {} as cpType.ChildProcess;
    }) as never);
  }

  it('resolves with the real stdout/stderr and exit 0 on success', async () => {
    feed(null, 'real out', 'real err');
    const result = await runShell('node', ['-e', '0']);
    expect(result.exit).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toBe('real out');
    expect(result.stderr).toBe('real err');
  });

  it('falls back to empty strings when stdout/stderr are null', async () => {
    feed(null, null, null);
    const result = await runShell('node', ['-e', '0']);
    // Kills both the StringLiteral ('' → "x") and LogicalOperator (?? → &&)
    // mutants on the fallback assignments: null && '' would be null, not ''.
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('ENOENT failure message names the missing command', async () => {
    feed(Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }), '', '');
    const caught = await expectRejection(() => runShell('ghost-bin', []));
    expect(caught.message).toBe('Command not found: ghost-bin');
  });

  it('TIMEOUT failure message includes the timeout and command', async () => {
    feed(
      Object.assign(new Error('ETIMEDOUT'), { code: null, killed: true, signal: 'SIGTERM' }),
      '',
      '',
    );
    const caught = await expectRejection(() => runShell('slow', [], { timeoutMs: 1234 }));
    expect(caught.message).toBe('Command timed out after 1234ms: slow');
  });

  it('signal-crash failure message names the signal', async () => {
    feed(
      Object.assign(new Error('killed'), { code: null, killed: false, signal: 'SIGTERM' }),
      '',
      '',
    );
    const caught = await expectRejection(() => runShell('node', []));
    expect(caught.message).toBe('Command exited with signal SIGTERM: node');
  });

  it('non-zero exit failure message includes the numeric code', async () => {
    feed(Object.assign(new Error('failed'), { code: 7, killed: false, signal: undefined }), '', '');
    const caught = await expectRejection(() => runShell('node', []));
    expect(caught.message).toBe('Command exited with code 7: node');
  });

  it('does not log when verbose is off', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(false);
    vi.mocked(log).mockClear();
    feed(null, '', '');
    await runShell('node', ['-e', '0']);
    expect(vi.mocked(log)).not.toHaveBeenCalled();
  });
});
