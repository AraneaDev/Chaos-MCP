import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the async exec helper
vi.mock('../utils/exec.js', () => ({
  runShell: vi.fn(),
  ExecFailureError: class ExecFailureError extends Error {
    stdout = '';
    stderr = '';
    exit: number | null = null;
    signal: NodeJS.Signals | null = null;
    code: string | undefined;
    constructor(
      result: {
        stdout: string;
        stderr: string;
        exit: number | null;
        signal: NodeJS.Signals | null;
        code?: string;
      },
      message: string,
    ) {
      super(message);
      this.name = 'ExecFailureError';
      this.stdout = result.stdout;
      this.stderr = result.stderr;
      this.exit = result.exit;
      this.signal = result.signal;
      this.code = result.code;
    }
  },
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  isVerbose: vi.fn().mockReturnValue(false),
}));

import { runShell, ExecFailureError } from '../utils/exec.js';
import { GoEngine } from '../engines/go.js';

const mockRunShell = vi.mocked(runShell);

function makeExecResult(
  stdout = '',
  stderr = '',
): { stdout: string; stderr: string; exit: number; signal: null } {
  return { stdout, stderr, exit: 0, signal: null };
}

function makeExecFailure(opts: {
  exit?: number | null;
  signal?: NodeJS.Signals | null;
  code?: string;
  stdout?: string;
  stderr?: string;
}): Error {
  // ExecFailureError is imported at top level — vi.mock replaces it with the mock class
  return new ExecFailureError(
    {
      stdout: opts.stdout ?? '',
      stderr: opts.stderr ?? '',
      exit: opts.exit ?? null,
      signal: opts.signal ?? null,
      code: opts.code,
    },
    `Command failed`,
  );
}

describe('GoEngine', () => {
  let engine: GoEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new GoEngine();
  });

  it('parses go-mutesting text output when all mutants are killed', async () => {
    const stdout = [
      'PASS  "/path/src/math.go:10:1"',
      'PASS  "/path/src/math.go:20:1"',
      'PASS  "/path/src/math.go:30:1"',
    ].join('\n');

    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/math.go');

    expect(result.target).toBe('src/math.go');
    expect(result.totalMutants).toBe(3);
    expect(result.killed).toBe(3);
    expect(result.survived).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
    expect(result.vulnerabilities).toHaveLength(0);
  });

  it('reports surviving mutants from FAIL lines', async () => {
    const stdout = [
      'PASS  "/path/src/billing.go:10:1"',
      'FAIL  "/path/src/billing.go:42:1"',
      'FAIL  "/path/src/billing.go:88:1"',
    ].join('\n');

    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/billing.go');

    expect(result.totalMutants).toBe(3);
    expect(result.killed).toBe(1);
    expect(result.survived).toBe(2);
    expect(result.mutationScore).toBe('33.33%');
    expect(result.vulnerabilities).toHaveLength(2);
    expect(result.vulnerabilities[0].line).toBe(42);
    expect(result.vulnerabilities[1].line).toBe(88);
  });

  it('returns 100% score for zero mutants', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(''));

    const result = await engine.run('src/empty.go');

    expect(result.totalMutants).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
  });

  it('throws descriptive error when go-mutesting is not installed (ENOENT)', async () => {
    mockRunShell.mockRejectedValue(makeExecFailure({ code: 'ENOENT' }));

    await expect(engine.run('src/test.go')).rejects.toThrow(/go-mutesting is not installed/);
    await expect(engine.run('src/test.go')).rejects.toThrow(/go install/);
  });

  it('parses stdout output when go-mutesting exits non-zero', async () => {
    const stdout = ['FAIL  "/path/src/calc.go:15:1"'].join('\n');
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 1, stdout }));

    const result = await engine.run('src/calc.go');

    expect(result.survived).toBe(1);
    expect(result.vulnerabilities[0].line).toBe(15);
  });

  it('throws when go-mutesting crashes with signal (no output)', async () => {
    mockRunShell.mockRejectedValue(
      makeExecFailure({ signal: 'SIGSEGV', exit: null, stderr: 'segfault' }),
    );

    await expect(engine.run('src/test.go')).rejects.toThrow(/crashed.*SIGSEGV/);
  });

  it('throws on timeout', async () => {
    mockRunShell.mockRejectedValue(makeExecFailure({ code: 'TIMEOUT' }));

    await expect(engine.run('src/test.go')).rejects.toThrow(/timed out/);
  });

  // ─── RunOptions tests ───────────────────────────────────────────────────

  it('uses workDir from RunOptions as cwd', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(''));

    await engine.run('src/test.go', { workDir: '/tmp/sandbox' });

    expect(mockRunShell).toHaveBeenCalledWith(
      'go-mutesting',
      expect.any(Array),
      expect.objectContaining({ cwd: '/tmp/sandbox' }),
    );
  });

  it('uses custom timeoutMs from RunOptions', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(''));

    await engine.run('src/test.go', { timeoutMs: 120000 });

    expect(mockRunShell).toHaveBeenCalledWith(
      'go-mutesting',
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 120000 }),
    );
  });

  it('defaults to 5-minute timeout', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(''));

    await engine.run('src/test.go');

    expect(mockRunShell).toHaveBeenCalledWith(
      'go-mutesting',
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });
});
