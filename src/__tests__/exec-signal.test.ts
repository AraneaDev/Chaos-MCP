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
import { runShell, runShellCommand } from '../utils/exec.js';

describe('runShell signal forwarding', () => {
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
      cb(null, 'ok', '');
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
      cb(null, 'ok', '');
      return {} as cpType.ChildProcess;
    }) as never);

    return runShell('echo', ['hi']).then((r) => {
      expect(r.stdout).toBe('ok');
    });
  });
});

describe('runShellCommand signal forwarding', () => {
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
      const abortErr = Object.assign(new Error('aborted'), { code: 'ABORT_ERR', name: 'AbortError' });
      cb(abortErr, '', '');
      return {} as cpType.ChildProcess;
    }) as never);

    await expect(runShell('cargo', ['mutants'])).rejects.toMatchObject({ code: 'ABORTED' });
  });

  it('runShellCommand classifies an aborted child (code ABORT_ERR) as code "ABORTED"', async () => {
    vi.mocked(exec).mockImplementationOnce(((
      _c: string,
      _opts: Record<string, unknown>,
      cb: (e: unknown, o: string, er: string) => void,
    ) => {
      const abortErr = Object.assign(new Error('aborted'), { code: 'ABORT_ERR', name: 'AbortError' });
      cb(abortErr, '', '');
      return {} as cpType.ChildProcess;
    }) as never);

    await expect(runShellCommand('cargo mutants')).rejects.toMatchObject({ code: 'ABORTED' });
  });
});
