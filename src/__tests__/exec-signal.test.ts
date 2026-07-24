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
    platform.mockReturnValue('linux');
    killProcessTree(child, false);
    platform.mockReturnValue('win32');
    killProcessTree(child, true);
    expect(childKill).toHaveBeenNthCalledWith(1, 'SIGKILL');
    expect(childKill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    expect(processKill).not.toHaveBeenCalled();
    processKill.mockRestore();
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
