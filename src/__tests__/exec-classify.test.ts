import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';
import { ExecFailureError } from '../utils/exec.js';

// Mock runShell from exec.js
vi.mock('../utils/exec.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/exec.js')>('../utils/exec.js');
  return {
    ...actual,
    runShell: vi.fn(),
  };
});

import { runShell } from '../utils/exec.js';
const mockRunShell = vi.mocked(runShell);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('invokeMutationTool', () => {
  it('returns ExecResult on successful tool run', async () => {
    const result = { stdout: 'ok', stderr: '', exit: 0, signal: null };
    mockRunShell.mockResolvedValue(result);

    const out = await invokeMutationTool('StrykerJS', 'npx', ['stryker', 'run']);
    expect(out).toBe(result);
    expect(mockRunShell).toHaveBeenCalledWith('npx', ['stryker', 'run'], {});
  });

  it('passes options through to runShell', async () => {
    mockRunShell.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });
    await invokeMutationTool('mutmut', 'mutmut', ['run'], {
      cwd: '/tmp/sandbox',
      timeoutMs: 5000,
    });
    expect(mockRunShell).toHaveBeenCalledWith('mutmut', ['run'], {
      cwd: '/tmp/sandbox',
      timeoutMs: 5000,
    });
  });

  it('throws MutationToolStartupError with install hint on ENOENT', async () => {
    const enoentError = new ExecFailureError(
      { stdout: '', stderr: '', exit: null, signal: null, code: 'ENOENT' },
      'Command not found: stryker',
    );
    mockRunShell.mockRejectedValue(enoentError);

    await expect(invokeMutationTool('StrykerJS', 'stryker', ['run'])).rejects.toThrow(
      MutationToolStartupError,
    );
    await expect(invokeMutationTool('StrykerJS', 'stryker', ['run'])).rejects.toThrow(
      /npm install.*@stryker-mutator\/core/,
    );
  });

  it('throws MutationToolStartupError with install hint for cosmic-ray ENOENT', async () => {
    const enoentError = new ExecFailureError(
      { stdout: '', stderr: '', exit: null, signal: null, code: 'ENOENT' },
      'Command not found',
    );
    mockRunShell.mockRejectedValue(enoentError);

    await expect(invokeMutationTool('cosmic-ray', 'cosmic-ray', ['init'])).rejects.toThrow(
      /pip install cosmic-ray/,
    );
  });

  it('throws MutationToolStartupError with install hint for cargo-mutants ENOENT', async () => {
    const enoentError = new ExecFailureError(
      { stdout: '', stderr: '', exit: null, signal: null, code: 'ENOENT' },
      'Command not found',
    );
    mockRunShell.mockRejectedValue(enoentError);

    await expect(invokeMutationTool('cargo-mutants', 'cargo-mutants', [])).rejects.toThrow(
      /cargo install cargo-mutants/,
    );
  });

  it('throws MutationToolStartupError with install hint for Infection ENOENT', async () => {
    const enoentError = new ExecFailureError(
      { stdout: '', stderr: '', exit: null, signal: null, code: 'ENOENT' },
      'Command not found',
    );
    mockRunShell.mockRejectedValue(enoentError);
    await expect(invokeMutationTool('Infection', 'infection', [])).rejects.toThrow(
      /composer require --dev infection\/infection/,
    );
  });

  it('throws MutationToolStartupError on TIMEOUT', async () => {
    const timeoutError = new ExecFailureError(
      { stdout: '', stderr: '', exit: null, signal: 'SIGTERM', code: 'TIMEOUT' },
      'timed out',
    );
    mockRunShell.mockRejectedValue(timeoutError);

    await expect(
      invokeMutationTool('StrykerJS', 'stryker', ['run'], { timeoutMs: 1000 }),
    ).rejects.toThrow(MutationToolStartupError);
    await expect(
      invokeMutationTool('StrykerJS', 'stryker', ['run'], { timeoutMs: 1000 }),
    ).rejects.toThrow(/timed out after 1000ms/);
  });

  it('shows default timeout in message when timeoutMs is not provided', async () => {
    const timeoutError = new ExecFailureError(
      { stdout: '', stderr: '', exit: null, signal: 'SIGTERM', code: 'TIMEOUT' },
      'timed out',
    );
    mockRunShell.mockRejectedValue(timeoutError);

    await expect(invokeMutationTool('StrykerJS', 'stryker', ['run'])).rejects.toThrow(
      /timed out after 300000ms/,
    );
  });

  it('throws MutationToolStartupError on signal crash', async () => {
    const crashError = new ExecFailureError(
      {
        stdout: 'partial output',
        stderr: 'segfault details',
        exit: null,
        signal: 'SIGSEGV',
        code: undefined,
      },
      'crashed',
    );
    mockRunShell.mockRejectedValue(crashError);

    await expect(invokeMutationTool('cargo-mutants', 'cargo-mutants', [])).rejects.toThrow(
      MutationToolStartupError,
    );
    await expect(invokeMutationTool('cargo-mutants', 'cargo-mutants', [])).rejects.toThrow(
      /crashed unexpectedly.*SIGSEGV/,
    );
  });

  it('includes stderr in signal crash message when available', async () => {
    const crashError = new ExecFailureError(
      {
        stdout: '',
        stderr: 'stack trace dump',
        exit: null,
        signal: 'SIGABRT',
        code: undefined,
      },
      'aborted',
    );
    mockRunShell.mockRejectedValue(crashError);

    await expect(invokeMutationTool('cargo-mutants', 'cargo-mutants', [])).rejects.toThrow(
      /stack trace dump/,
    );
  });

  it('falls back to error.message when stderr is empty in signal crash', async () => {
    const crashError = new ExecFailureError(
      { stdout: '', stderr: '', exit: null, signal: 'SIGKILL', code: undefined },
      'was killed',
    );
    mockRunShell.mockRejectedValue(crashError);

    await expect(invokeMutationTool('mutmut', 'mutmut', [])).rejects.toThrow(/was killed/);
  });

  it('rethrows non-ExecFailureError errors verbatim (not wrapped)', async () => {
    const plainError = new Error('something unexpected');
    mockRunShell.mockRejectedValue(plainError);

    // Should reject with the exact same error instance — not a MutationToolStartupError
    await expect(invokeMutationTool('StrykerJS', 'stryker', ['run'])).rejects.toBe(plainError);
  });

  it('processes ExecFailureError through code/signal checks (does not rethrow blindly)', async () => {
    // An ExecFailureError with code='ENOENT' should be wrapped in MutationToolStartupError,
    // NOT rethrown verbatim. This verifies the `!(error instanceof ExecFailureError)` guard
    // correctly routes ExecFailureErrors into the code/signal classification chains.
    const enoentError = new ExecFailureError(
      { stdout: '', stderr: '', exit: null, signal: null, code: 'ENOENT' },
      'Command not found: stryker',
    );
    mockRunShell.mockRejectedValue(enoentError);

    await expect(invokeMutationTool('StrykerJS', 'stryker', ['run'])).rejects.toBeInstanceOf(
      MutationToolStartupError,
    );
  });

  it('sets the correct Error name for MutationToolStartupError', async () => {
    const enoentError = new ExecFailureError(
      { stdout: '', stderr: '', exit: null, signal: null, code: 'ENOENT' },
      'Command not found: stryker',
    );
    mockRunShell.mockRejectedValue(enoentError);

    await expect(invokeMutationTool('StrykerJS', 'stryker', ['run'])).rejects.toHaveProperty(
      'name',
      'MutationToolStartupError',
    );
  });

  it('throws non-ExecFailureError errors verbatim even if they mock ExecFailureError properties', async () => {
    const fakeError = new Error('fake plain error');
    (fakeError as Record<string, unknown>).code = 'ENOENT';
    mockRunShell.mockRejectedValue(fakeError);

    await expect(invokeMutationTool('StrykerJS', 'stryker', ['run'])).rejects.toBe(fakeError);
  });

  it('rethrows ExecFailureError when signal is present but exit is definitively not null', async () => {
    const hybridError = new ExecFailureError(
      { stdout: '', stderr: '', exit: 1, signal: 'SIGTERM', code: undefined },
      'crashed but also exited natively',
    );
    mockRunShell.mockRejectedValue(hybridError);

    await expect(invokeMutationTool('StrykerJS', 'stryker', ['run'])).rejects.toBe(hybridError);
  });

  it('rethrows ExecFailureError when exit is null but signal is also null', async () => {
    const blankDeadError = new ExecFailureError(
      { stdout: '', stderr: '', exit: null, signal: null, code: undefined },
      'no code, no exit, no signal',
    );
    mockRunShell.mockRejectedValue(blankDeadError);

    await expect(invokeMutationTool('StrykerJS', 'stryker', ['run'])).rejects.toBe(blankDeadError);
  });

  it('rethrows ExecFailureError for non-zero exit (not ENOENT/TIMEOUT/signal)', async () => {
    const exitError = new ExecFailureError(
      { stdout: 'report', stderr: '', exit: 2, signal: null, code: '2' },
      'exited with code 2',
    );
    mockRunShell.mockRejectedValue(exitError);

    // Should rethrow the original ExecFailureError (not wrap in MutationToolStartupError).
    // Assert against the known instance to avoid expect() inside a catch block.
    await expect(invokeMutationTool('StrykerJS', 'stryker', ['run'])).rejects.toBe(exitError);
    expect(exitError).toBeInstanceOf(ExecFailureError);
    expect(exitError).not.toBeInstanceOf(MutationToolStartupError);
  });
});
