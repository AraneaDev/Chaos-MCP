import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as cpType from 'child_process';

const hoistedRefs = vi.hoisted(() => ({
  realExec: null as typeof cpType.exec | null,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof cpType>();
  hoistedRefs.realExec = actual.exec;
  return {
    ...actual,
    exec: vi.fn(actual.exec),
  };
});

// Mock logger for verbose tests
vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  isVerbose: vi.fn().mockReturnValue(false),
}));

import { exec } from 'child_process';
import { runShellCommand, ExecFailureError } from '../utils/exec.js';

async function expectRejection(fn: () => Promise<unknown>): Promise<ExecFailureError> {
  try {
    await fn();
  } catch (err: unknown) {
    if (err instanceof ExecFailureError) return err;
    throw err;
  }
  throw new Error('expected runShellCommand() to reject, but it resolved');
}

describe('runShellCommand', () => {
  beforeEach(() => {
    vi.mocked(exec).mockReset();
    const ref = hoistedRefs.realExec;
    if (!ref) {
      throw new Error('exec test setup error: vi.mock factory did not capture the real exec');
    }
    vi.mocked(exec).mockImplementation(ref);
  });

  it('resolves with stdout and exit 0 on success', async () => {
    // Delegate to real exec; spawn a quick echo child
    vi.mocked(exec).mockImplementationOnce(((_cmd, _opts, cb) => {
      setImmediate(() => cb(null, 'hello stdout', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    const result = await runShellCommand('echo hello');
    expect(result.exit).toBe(0);
    expect(result.stdout).toBe('hello stdout');
    expect(result.signal).toBeNull();
  });

  it('captures stderr even on success', async () => {
    vi.mocked(exec).mockImplementationOnce(((_cmd, _opts, cb) => {
      setImmediate(() => cb(null, '', 'some stderr output'));
      return {} as cpType.ChildProcess;
    }) as never);

    const result = await runShellCommand('cmd');
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe('some stderr output');
  });

  it('captures numeric exit code on non-zero exit', async () => {
    vi.mocked(exec).mockImplementationOnce(((_cmd, _opts, cb) => {
      const err = Object.assign(new Error('Command failed'), {
        code: 1,
        killed: false,
        signal: undefined,
      });
      setImmediate(() => cb(err, '', 'failure'));
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() => runShellCommand('failing-cmd'));
    expect(caught.exit).toBe(1);
    expect(caught.signal).toBeNull();
    expect(caught.stderr).toBe('failure');
  });

  it('captures exit code > 0', async () => {
    vi.mocked(exec).mockImplementationOnce(((_cmd, _opts, cb) => {
      const err = Object.assign(new Error('Command failed'), {
        code: 42,
        killed: false,
        signal: undefined,
      });
      setImmediate(() => cb(err, '', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() => runShellCommand('cmd'));
    expect(caught.exit).toBe(42);
  });

  it('classifies timeout (killed=true + signal) as code=TIMEOUT', async () => {
    vi.mocked(exec).mockImplementationOnce(((_cmd, _opts, cb) => {
      const err = Object.assign(new Error('ETIMEDOUT'), {
        code: null,
        killed: true,
        signal: 'SIGTERM',
      });
      setImmediate(() => cb(err, '', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() => runShellCommand('slow-cmd'));
    expect(caught.code).toBe('TIMEOUT');
    expect(caught.exit).toBeNull();
    expect(caught.signal).toBe('SIGTERM');
  });

  it('does NOT classify external signal (killed=false) as TIMEOUT', async () => {
    vi.mocked(exec).mockImplementationOnce(((_cmd, _opts, cb) => {
      const err = Object.assign(new Error('Killed by OOM'), {
        code: null,
        killed: false,
        signal: 'SIGTERM',
      });
      setImmediate(() => cb(err, '', 'OOM kill'));
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() => runShellCommand('cmd'));
    // Should NOT be TIMEOUT — it's a non-zero-exit/signal path
    expect(caught.code).not.toBe('TIMEOUT');
    expect(caught.signal).toBe('SIGTERM');
    expect(caught.exit).toBeNull();
  });

  it('handles null signal gracefully when killed=true with no signal', async () => {
    // Edge case: killed=true but signal=null (unlikely but defensive)
    vi.mocked(exec).mockImplementationOnce(((_cmd, _opts, cb) => {
      const err = Object.assign(new Error('killed'), {
        code: null,
        killed: true,
        signal: undefined,
      });
      setImmediate(() => cb(err, '', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() => runShellCommand('cmd'));
    // Should fall through to non-zero exit path, NOT timeout
    expect(caught.code).not.toBe('TIMEOUT');
  });

  it('handles err.code as string (non-number) gracefully', async () => {
    // exec() always sets code as number on non-zero exit, but defensive
    vi.mocked(exec).mockImplementationOnce(((_cmd, _opts, cb) => {
      const err = Object.assign(new Error('weird error'), {
        code: 'SOME_ERRNO' as unknown as number,
        killed: false,
        signal: undefined,
      });
      setImmediate(() => cb(err, '', 'weird'));
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() => runShellCommand('cmd'));
    // code as string → exit=null, falls through to non-zero exit with code='SIGNAL'
    expect(caught.exit).toBeNull();
    expect(caught.code).toBe('SIGNAL');
  });

  it('handles err.signal as non-string gracefully', async () => {
    // Defensive: signal is sometimes set to a non-string value
    vi.mocked(exec).mockImplementationOnce(((_cmd, _opts, cb) => {
      const err = Object.assign(new Error('killed'), {
        code: null,
        killed: false,
        signal: 9 as unknown as string,
      });
      setImmediate(() => cb(err, '', 'signal crash'));
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() => runShellCommand('cmd'));
    // signal as number → procSignal=null, falls through to non-zero exit
    expect(caught.signal).toBeNull();
    expect(caught.code).toBe('SIGNAL');
  });

  it('passes custom cwd to exec', async () => {
    vi.mocked(exec).mockImplementationOnce(((_cmd, opts, cb) => {
      setImmediate(() => cb(null, '', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    await runShellCommand('ls', { cwd: '/custom/path' });

    expect(vi.mocked(exec)).toHaveBeenCalledWith(
      'ls',
      expect.objectContaining({ cwd: '/custom/path' }),
      expect.any(Function),
    );
  });

  it('passes custom timeoutMs to exec', async () => {
    vi.mocked(exec).mockImplementationOnce(((_cmd, opts, cb) => {
      setImmediate(() => cb(null, '', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    await runShellCommand('ls', { timeoutMs: 5000 });

    expect(vi.mocked(exec)).toHaveBeenCalledWith(
      'ls',
      expect.objectContaining({ timeout: 5000 }),
      expect.any(Function),
    );
  });

  it('handles null stdout and stderr from exec callback', async () => {
    vi.mocked(exec).mockImplementationOnce(((_cmd, _opts, cb) => {
      setImmediate(() => cb(null, null as unknown as string, null as unknown as string));
      return {} as cpType.ChildProcess;
    }) as never);

    const result = await runShellCommand('cmd');
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('logs command in verbose mode', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    const mockVerbose = vi.mocked(isVerbose);

    mockVerbose.mockReturnValue(true);
    vi.mocked(exec).mockImplementationOnce(((_cmd, _opts, cb) => {
      setImmediate(() => cb(null, '', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    await runShellCommand('echo hello');

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('exec-shell'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('echo hello'));
    // Reset
    mockVerbose.mockReturnValue(false);
  });

  // ── Mutation-driven: error-message strings + verbose-off path ──
  // Chaos-MCP flagged the message ternary and verbose guard as surviving
  // mutants because no test asserted the exact failure strings.

  it('TIMEOUT failure message includes the timeout and command', async () => {
    vi.mocked(exec).mockImplementationOnce(((_cmd, _opts, cb) => {
      const err = Object.assign(new Error('ETIMEDOUT'), {
        code: null,
        killed: true,
        signal: 'SIGTERM',
      });
      setImmediate(() => cb(err, '', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() => runShellCommand('slow-cmd', { timeoutMs: 1234 }));
    expect(caught.message).toBe('Shell command timed out after 1234ms: slow-cmd');
  });

  it('signal-crash failure message names the signal', async () => {
    vi.mocked(exec).mockImplementationOnce(((_cmd, _opts, cb) => {
      const err = Object.assign(new Error('killed'), {
        code: null,
        killed: false,
        signal: 'SIGTERM',
      });
      setImmediate(() => cb(err, '', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() => runShellCommand('crash-cmd'));
    expect(caught.message).toBe('Shell command exited with signal SIGTERM: crash-cmd');
  });

  it('non-zero exit failure message includes the numeric code', async () => {
    vi.mocked(exec).mockImplementationOnce(((_cmd, _opts, cb) => {
      const err = Object.assign(new Error('failed'), {
        code: 5,
        killed: false,
        signal: undefined,
      });
      setImmediate(() => cb(err, '', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() => runShellCommand('fail-cmd'));
    expect(caught.message).toBe('Shell command exited with code 5: fail-cmd');
  });

  it('does not log when verbose is off', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(false);
    vi.mocked(log).mockClear();
    vi.mocked(exec).mockImplementationOnce(((_cmd, _opts, cb) => {
      setImmediate(() => cb(null, '', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    await runShellCommand('echo quiet');
    expect(vi.mocked(log)).not.toHaveBeenCalled();
  });

  it('does NOT classify killed=true with a numeric exit as TIMEOUT', async () => {
    // Edge case: killed=true but exit is a number (process exited with a code
    // then was killed). The TIMEOUT gate requires exit === null, so this must
    // fall through to the non-zero-exit branch. Kills the ConditionalExpression
    // mutant that drops the `result.exit === null` operand.
    vi.mocked(exec).mockImplementationOnce(((_cmd, _opts, cb) => {
      const err = Object.assign(new Error('exited then killed'), {
        code: 5,
        killed: true,
        signal: 'SIGTERM',
      });
      setImmediate(() => cb(err, '', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    const caught = await expectRejection(() => runShellCommand('cmd'));
    expect(caught.code).not.toBe('TIMEOUT');
    expect(caught.exit).toBe(5);
    expect(caught.signal).toBe('SIGTERM');
  });
});
