import { describe, it, expect, vi } from 'vitest';
import type * as cpType from 'child_process';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof cpType>();
  return {
    ...actual,
    execFile: vi.fn(actual.execFile),
    exec: vi.fn(actual.exec),
  };
});

vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  isVerbose: vi.fn().mockReturnValue(false),
}));

import { execFile, exec } from 'child_process';
import { killProcessTree, runShell, runShellCommand } from '../utils/exec.js';

describe('process-tree termination', () => {
  it('kills a Unix process group and returns without killing the child twice', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const childKill = vi.fn();
    killProcessTree({ pid: 123, kill: childKill } as unknown as cpType.ChildProcess, true);
    expect(processKill).toHaveBeenCalledWith(-123, 'SIGKILL');
    expect(childKill).not.toHaveBeenCalled();
    processKill.mockRestore();
    platform.mockRestore();
  });

  it('falls back to the direct child when group termination fails', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('group gone');
    });
    const childKill = vi.fn();
    killProcessTree({ pid: 123, kill: childKill } as unknown as cpType.ChildProcess, true);
    expect(childKill).toHaveBeenCalledWith('SIGKILL');
    processKill.mockRestore();
    platform.mockRestore();
  });

  it('uses direct-child termination for non-detached and Windows children', () => {
    const platform = vi.spyOn(process, 'platform', 'get');
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const childKill = vi.fn();
    const child = { pid: 123, kill: childKill } as unknown as cpType.ChildProcess;
    vi.mocked(execFile).mockClear();
    vi.mocked(execFile).mockImplementationOnce(((
      _command: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: () => void,
    ) => {
      callback();
      return {} as cpType.ChildProcess;
    }) as never);
    platform.mockReturnValue('linux');
    killProcessTree(child, false);
    expect(execFile).not.toHaveBeenCalled();
    platform.mockReturnValue('win32');
    killProcessTree(child, true);
    expect(childKill).toHaveBeenNthCalledWith(1, 'SIGKILL');
    expect(childKill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(processKill).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledWith(
      'taskkill',
      ['/PID', '123', '/T', '/F'],
      { windowsHide: true },
      expect.any(Function),
    );
    processKill.mockRestore();
    platform.mockRestore();
  });

  it('falls back to direct Windows child termination when taskkill cannot start', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const childKill = vi.fn();
    vi.mocked(execFile).mockImplementationOnce(() => {
      throw new Error('taskkill unavailable');
    });
    expect(() =>
      killProcessTree({ pid: 123, kill: childKill } as unknown as cpType.ChildProcess, true),
    ).not.toThrow();
    expect(childKill).toHaveBeenCalledWith('SIGKILL');
    platform.mockRestore();
  });

  it('uses the process group for every non-Windows platform token', () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('' as NodeJS.Platform);
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const childKill = vi.fn();
    killProcessTree({ pid: 123, kill: childKill } as unknown as cpType.ChildProcess, true);
    expect(processKill).toHaveBeenCalledWith(-123, 'SIGKILL');
    expect(childKill).not.toHaveBeenCalled();
    processKill.mockRestore();
    platform.mockRestore();
  });

  it('is a no-op for missing PIDs and tolerates an already-dead child', () => {
    expect(() => killProcessTree(undefined, true)).not.toThrow();
    expect(() =>
      killProcessTree(
        {
          pid: undefined,
          kill: vi.fn(() => {
            throw new Error('must not run');
          }),
        } as unknown as cpType.ChildProcess,
        true,
      ),
    ).not.toThrow();
    expect(() =>
      killProcessTree(
        {
          pid: 123,
          kill: vi.fn(() => {
            throw new Error('already dead');
          }),
        } as unknown as cpType.ChildProcess,
        false,
      ),
    ).not.toThrow();
  });
});

describe('runShell signal forwarding', () => {
  it('sets safe spawn defaults and only detaches when process-tree cleanup is requested', async () => {
    const childKill = vi.fn();
    vi.mocked(execFile).mockClear();
    vi.mocked(execFile).mockImplementation(((
      _f: string,
      _a: string[],
      opts: Record<string, unknown>,
      cb: (e: unknown, o: string, er: string) => void,
    ) => {
      setImmediate(() => cb(null, 'ok', ''));
      return { pid: 123, kill: childKill } as unknown as cpType.ChildProcess;
    }) as never);

    await runShell('echo', ['one']);
    expect(vi.mocked(execFile).mock.calls[0]?.[2]).toMatchObject({ windowsHide: true });
    expect(vi.mocked(execFile).mock.calls[0]?.[2]).not.toHaveProperty('detached');
    expect(childKill).not.toHaveBeenCalled();

    await runShell('echo', ['two'], { killTree: true });
    expect(vi.mocked(execFile).mock.calls[1]?.[2]).toMatchObject({
      windowsHide: true,
      detached: true,
    });

    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    await runShell('echo', ['three'], { killTree: true });
    expect(vi.mocked(execFile).mock.calls[2]?.[2]).not.toHaveProperty('detached');
    platform.mockRestore();
  });

  it('best-effort kills the child again when an execFile result carries a signal', async () => {
    const childKill = vi.fn();
    vi.mocked(execFile).mockImplementationOnce(((
      _f: string,
      _a: string[],
      _opts: Record<string, unknown>,
      cb: (e: unknown, o: string, er: string) => void,
    ) => {
      const child = { pid: 123, kill: childKill } as unknown as cpType.ChildProcess;
      setImmediate(() => cb(Object.assign(new Error('signal'), { signal: 'SIGTERM' }), '', ''));
      return child;
    }) as never);

    await expect(runShell('echo', [])).rejects.toBeDefined();
    expect(childKill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not kill the child again for an ordinary execFile exit code', async () => {
    const childKill = vi.fn();
    vi.mocked(execFile).mockImplementationOnce(((
      _f: string,
      _a: string[],
      _opts: Record<string, unknown>,
      cb: (e: unknown, o: string, er: string) => void,
    ) => {
      setImmediate(() => cb(Object.assign(new Error('exit'), { code: 1 }), '', ''));
      return { pid: 123, kill: childKill } as unknown as cpType.ChildProcess;
    }) as never);

    await expect(runShell('echo', [])).rejects.toBeDefined();
    expect(childKill).not.toHaveBeenCalled();
  });
  it('forwards an AbortSignal into execFile options', () => {
    const ac = new AbortController();

    // execFile(file, args, options, cb) — capture options; invoke cb to resolve.
    vi.mocked(execFile).mockImplementationOnce(((
      _f: string,
      _a: string[],
      opts: Record<string, unknown>,
      cb: (e: unknown, o: string, er: string) => void,
    ) => {
      expect(opts.signal).toBe(ac.signal);
      setImmediate(() => cb(null, 'ok', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    return runShell('echo', ['hi'], { signal: ac.signal }).then((r) => {
      expect(r.stdout).toBe('ok');
    });
  });

  it('does not set signal in execFile options when not provided', () => {
    vi.mocked(execFile).mockImplementationOnce(((
      _f: string,
      _a: string[],
      opts: Record<string, unknown>,
      cb: (e: unknown, o: string, er: string) => void,
    ) => {
      expect(opts.signal).toBeUndefined();
      setImmediate(() => cb(null, 'ok', ''));
      return {} as cpType.ChildProcess;
    }) as never);

    return runShell('echo', ['hi']).then((r) => {
      expect(r.stdout).toBe('ok');
    });
  });

  it('kills the process tree on timeout even when execFile never invokes its callback', () => {
    vi.useFakeTimers();
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(execFile).mockImplementationOnce(
      (() => ({ pid: 123, kill: vi.fn() }) as unknown as cpType.ChildProcess) as never,
    );

    void runShell('echo', ['hi'], { killTree: true, timeoutMs: 50 });
    vi.advanceTimersByTime(49);
    expect(processKill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(processKill).toHaveBeenCalledWith(-123, 'SIGKILL');

    processKill.mockRestore();
    platform.mockRestore();
    vi.useRealTimers();
  });

  it('disarms tree cleanup when execFile completes', async () => {
    vi.useFakeTimers();
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const controller = new AbortController();
    vi.mocked(execFile).mockImplementationOnce(((
      _f: string,
      _a: string[],
      _opts: Record<string, unknown>,
      callback: (e: unknown, o: string, er: string) => void,
    ) => {
      setTimeout(() => callback(null, 'ok', ''), 10);
      return { pid: 123, kill: vi.fn() } as unknown as cpType.ChildProcess;
    }) as never);

    const result = runShell('echo', ['hi'], {
      killTree: true,
      timeoutMs: 50,
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toMatchObject({ stdout: 'ok' });
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(processKill).not.toHaveBeenCalled();

    processKill.mockRestore();
    platform.mockRestore();
    vi.useRealTimers();
  });

  it('does not arm tree cleanup without a child or when killTree is disabled', () => {
    vi.useFakeTimers();
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(execFile)
      .mockImplementationOnce(() => undefined as unknown as cpType.ChildProcess)
      .mockImplementationOnce(
        (() => ({ pid: 123, kill: vi.fn() }) as unknown as cpType.ChildProcess) as never,
      );

    void runShell('echo', ['no-child'], { killTree: true, timeoutMs: 10 });
    void runShell('echo', ['no-tree'], { killTree: false, timeoutMs: 10 });
    vi.advanceTimersByTime(20);
    expect(processKill).not.toHaveBeenCalled();

    processKill.mockRestore();
    platform.mockRestore();
    vi.useRealTimers();
  });

  it('terminates only once and unregisters the abort listener', () => {
    vi.useFakeTimers();
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    let abortListener: (() => void) | undefined;
    const signal = {
      aborted: false,
      addEventListener: vi.fn((_event: string, listener: () => void) => {
        abortListener = listener;
      }),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    vi.mocked(execFile).mockImplementationOnce(
      (() => ({ pid: 123, kill: vi.fn() }) as unknown as cpType.ChildProcess) as never,
    );

    void runShell('echo', ['hi'], { killTree: true, timeoutMs: 50, signal });
    expect(abortListener).toBeTypeOf('function');
    abortListener?.();
    abortListener?.();
    expect(processKill).toHaveBeenCalledTimes(1);
    expect(signal.removeEventListener).toHaveBeenCalledWith('abort', abortListener);

    processKill.mockRestore();
    platform.mockRestore();
    vi.useRealTimers();
  });

  it('does not arm cleanup after a synchronous execFile callback', async () => {
    vi.useFakeTimers();
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(execFile).mockImplementationOnce(((
      _command: string,
      _args: string[],
      _options: Record<string, unknown>,
      callback: (e: unknown, o: string, er: string) => void,
    ) => {
      callback(null, 'ok', '');
      return { pid: 123, kill: vi.fn() } as unknown as cpType.ChildProcess;
    }) as never);

    await expect(
      runShell('echo', ['hi'], { killTree: true, timeoutMs: 10 }),
    ).resolves.toMatchObject({ stdout: 'ok' });
    vi.advanceTimersByTime(20);
    expect(processKill).not.toHaveBeenCalled();

    processKill.mockRestore();
    platform.mockRestore();
    vi.useRealTimers();
  });
});

describe('runShellCommand signal forwarding', () => {
  it('sets safe spawn defaults and only detaches when process-tree cleanup is requested', async () => {
    const childKill = vi.fn();
    vi.mocked(exec).mockImplementation(((
      _c: string,
      opts: Record<string, unknown>,
      cb: (e: unknown, o: string, er: string) => void,
    ) => {
      setImmediate(() => cb(null, 'ok', ''));
      return { pid: 123, kill: childKill } as unknown as cpType.ChildProcess;
    }) as never);

    await runShellCommand('echo one');
    expect(vi.mocked(exec).mock.calls[0]?.[1]).toMatchObject({ windowsHide: true });
    expect(vi.mocked(exec).mock.calls[0]?.[1]).not.toHaveProperty('detached');
    expect(childKill).not.toHaveBeenCalled();

    await runShellCommand('echo two', { killTree: true });
    expect(vi.mocked(exec).mock.calls[1]?.[1]).toMatchObject({
      windowsHide: true,
      detached: true,
    });

    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    await runShellCommand('echo three', { killTree: true });
    expect(vi.mocked(exec).mock.calls[2]?.[1]).not.toHaveProperty('detached');
    platform.mockRestore();
  });

  it('best-effort kills the child again when an exec result carries a signal', async () => {
    const childKill = vi.fn();
    vi.mocked(exec).mockImplementationOnce(((
      _c: string,
      _opts: Record<string, unknown>,
      cb: (e: unknown, o: string, er: string) => void,
    ) => {
      const child = { pid: 123, kill: childKill } as unknown as cpType.ChildProcess;
      setImmediate(() => cb(Object.assign(new Error('signal'), { signal: 'SIGTERM' }), '', ''));
      return child;
    }) as never);

    await expect(runShellCommand('echo')).rejects.toBeDefined();
    expect(childKill).toHaveBeenCalledWith('SIGKILL');
  });

  it('does not kill the child again for an ordinary exec exit code', async () => {
    const childKill = vi.fn();
    vi.mocked(exec).mockImplementationOnce(((
      _c: string,
      _opts: Record<string, unknown>,
      cb: (e: unknown, o: string, er: string) => void,
    ) => {
      setImmediate(() => cb(Object.assign(new Error('exit'), { code: 1 }), '', ''));
      return { pid: 123, kill: childKill } as unknown as cpType.ChildProcess;
    }) as never);

    await expect(runShellCommand('echo')).rejects.toBeDefined();
    expect(childKill).not.toHaveBeenCalled();
  });
  it('forwards an AbortSignal into exec options', () => {
    const ac = new AbortController();

    // exec(command, options, cb) — capture options; invoke cb to resolve.
    vi.mocked(exec).mockImplementationOnce(((
      _c: string,
      opts: Record<string, unknown>,
      cb: (e: unknown, o: string, er: string) => void,
    ) => {
      expect(opts.signal).toBe(ac.signal);
      cb(null, 'ok', '');
      return {} as cpType.ChildProcess;
    }) as never);

    return runShellCommand('echo hi', { signal: ac.signal }).then((r) => {
      expect(r.stdout).toBe('ok');
    });
  });

  it('does not set signal in exec options when not provided', () => {
    vi.mocked(exec).mockImplementationOnce(((
      _c: string,
      opts: Record<string, unknown>,
      cb: (e: unknown, o: string, er: string) => void,
    ) => {
      expect(opts.signal).toBeUndefined();
      cb(null, 'ok', '');
      return {} as cpType.ChildProcess;
    }) as never);

    return runShellCommand('echo hi').then((r) => {
      expect(r.stdout).toBe('ok');
    });
  });

  it('kills the process tree on abort even when exec never invokes its callback', () => {
    vi.useFakeTimers();
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(exec).mockImplementationOnce(
      (() => ({ pid: 456, kill: vi.fn() }) as unknown as cpType.ChildProcess) as never,
    );
    const controller = new AbortController();

    void runShellCommand('echo hi', {
      killTree: true,
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    controller.abort();
    expect(processKill).toHaveBeenCalledWith(-456, 'SIGKILL');

    processKill.mockRestore();
    platform.mockRestore();
    vi.useRealTimers();
  });

  it('kills the process tree immediately for an already-aborted signal', () => {
    vi.useFakeTimers();
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(exec).mockImplementationOnce(
      (() => ({ pid: 789, kill: vi.fn() }) as unknown as cpType.ChildProcess) as never,
    );
    const controller = new AbortController();
    controller.abort();

    void runShellCommand('echo hi', {
      killTree: true,
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    expect(processKill).toHaveBeenCalledWith(-789, 'SIGKILL');

    processKill.mockRestore();
    platform.mockRestore();
    vi.useRealTimers();
  });

  it('does not arm cleanup after a synchronous exec callback', async () => {
    vi.useFakeTimers();
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const processKill = vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.mocked(exec).mockImplementationOnce(((
      _command: string,
      _options: Record<string, unknown>,
      callback: (e: unknown, o: string, er: string) => void,
    ) => {
      callback(null, 'ok', '');
      return { pid: 456, kill: vi.fn() } as unknown as cpType.ChildProcess;
    }) as never);

    await expect(
      runShellCommand('echo hi', { killTree: true, timeoutMs: 10 }),
    ).resolves.toMatchObject({ stdout: 'ok' });
    vi.advanceTimersByTime(20);
    expect(processKill).not.toHaveBeenCalled();

    processKill.mockRestore();
    platform.mockRestore();
    vi.useRealTimers();
  });
});

describe('abort classification (audit M5)', () => {
  it('runShell classifies an aborted child (code ABORT_ERR) as code "ABORTED"', async () => {
    vi.mocked(execFile).mockImplementationOnce(((
      _f: string,
      _a: string[],
      _opts: Record<string, unknown>,
      cb: (e: unknown, o: string, er: string) => void,
    ) => {
      const abortErr = Object.assign(new Error('aborted'), {
        code: 'ABORT_ERR',
        name: 'AbortError',
      });
      cb(abortErr, '', '');
      return {} as cpType.ChildProcess;
    }) as never);

    await expect(runShell('cargo', ['mutants'])).rejects.toMatchObject({
      code: 'ABORTED',
      message: expect.stringContaining('cargo'),
    });
  });

  it('runShellCommand classifies an aborted child (code ABORT_ERR) as code "ABORTED"', async () => {
    vi.mocked(exec).mockImplementationOnce(((
      _c: string,
      _opts: Record<string, unknown>,
      cb: (e: unknown, o: string, er: string) => void,
    ) => {
      const abortErr = Object.assign(new Error('aborted'), {
        code: 'ABORT_ERR',
        name: 'AbortError',
      });
      cb(abortErr, '', '');
      return {} as cpType.ChildProcess;
    }) as never);

    await expect(runShellCommand('cargo mutants')).rejects.toMatchObject({
      code: 'ABORTED',
      message: expect.stringContaining('cargo mutants'),
    });
  });
});
