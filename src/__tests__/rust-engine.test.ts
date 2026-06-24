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
import { RustEngine } from '../engines/rust.js';

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

describe('RustEngine', () => {
  let engine: RustEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new RustEngine();
  });

  it('parses cargo-mutants text output when all mutants are caught', async () => {
    const stdout = [
      'CAUGHT   src/math.rs:10:9  replaced > with >=',
      'CAUGHT   src/math.rs:20:5  replaced && with ||',
      'CAUGHT   src/math.rs:30:1  replaced + with -',
    ].join('\n');

    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/math.rs');

    expect(result.target).toBe('src/math.rs');
    expect(result.totalMutants).toBe(3);
    expect(result.killed).toBe(3);
    expect(result.survived).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
    expect(result.vulnerabilities).toHaveLength(0);
  });

  it('reports MISSED mutants as vulnerabilities', async () => {
    const stdout = [
      'CAUGHT   src/billing.rs:10:9  replaced > with >=',
      'MISSED   src/billing.rs:42:5  replaced >= with >',
      'MISSED   src/billing.rs:88:1  replaced + with -',
    ].join('\n');

    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/billing.rs');

    expect(result.totalMutants).toBe(3);
    expect(result.killed).toBe(1);
    expect(result.survived).toBe(2);
    expect(result.mutationScore).toBe('33.33%');
    expect(result.vulnerabilities).toHaveLength(2);
    expect(result.vulnerabilities[0].line).toBe(42);
    expect(result.vulnerabilities[1].line).toBe(88);
  });

  it('handles UNCAUGHT status', async () => {
    const stdout = ['UNCAUGHT src/main.rs:15:5  mutated'].join('\n');

    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/main.rs');
    expect(result.survived).toBe(1);
    expect(result.vulnerabilities[0].line).toBe(15);
  });

  it('counts TIMEOUT mutants as killed (H3 regression)', async () => {
    const stdout = [
      'CAUGHT   src/math.rs:10:9  replaced > with >=',
      'TIMEOUT  src/math.rs:20:5  infinite loop in test',
      'MISSED   src/math.rs:30:1  replaced + with -',
    ].join('\n');

    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/math.rs');
    // total = 3, killed = 2 (CAUGHT + TIMEOUT), survived = 1 (MISSED)
    expect(result.totalMutants).toBe(3);
    expect(result.killed).toBe(2);
    expect(result.survived).toBe(1);
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].line).toBe(30);
  });

  it('handles lowercase `timeout` lines from cargo-mutants text output (Live-audit L4)', async () => {
    // cargo-mutants text output uses mixed case (`timeout`, `Timeout`),
    // unlike its JSON output which uses uppercase.
    const stdout = [
      'CAUGHT   src/math.rs:10:9  replaced > with >=',
      'timeout  src/math.rs:20:5  infinite loop in test',
      'Timeout  src/math.rs:25:5  another hang',
      'MISSED   src/math.rs:30:1  replaced + with -',
    ].join('\n');

    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/math.rs');
    // total = 4, killed = 3 (CAUGHT + 2 TIMEOUTs), survived = 1 (MISSED)
    expect(result.totalMutants).toBe(4);
    expect(result.killed).toBe(3);
    expect(result.survived).toBe(1);
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].line).toBe(30);
  });

  it('returns 100% score for zero mutants', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(''));

    const result = await engine.run('src/empty.rs');
    expect(result.totalMutants).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
  });

  it('throws when cargo-mutants is not installed (ENOENT)', async () => {
    mockRunShell.mockRejectedValue(makeExecFailure({ code: 'ENOENT' }));

    await expect(engine.run('src/test.rs')).rejects.toThrow(/cargo-mutants is not installed/);
    await expect(engine.run('src/test.rs')).rejects.toThrow(/cargo install/);
  });

  it('parses stdout from non-zero exit', async () => {
    const stdout = ['MISSED   src/calc.rs:22:5  mutated'].join('\n');
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 1, stdout }));

    const result = await engine.run('src/calc.rs');
    expect(result.survived).toBe(1);
    expect(result.vulnerabilities[0].line).toBe(22);
  });

  it('throws when cargo-mutants crashes with signal', async () => {
    mockRunShell.mockRejectedValue(
      makeExecFailure({ signal: 'SIGSEGV', exit: null, stderr: 'segfault' }),
    );

    await expect(engine.run('src/test.rs')).rejects.toThrow(/crashed.*SIGSEGV/);
  });

  it('throws on timeout', async () => {
    mockRunShell.mockRejectedValue(makeExecFailure({ code: 'TIMEOUT' }));

    await expect(engine.run('src/test.rs')).rejects.toThrow(/timed out/);
  });

  // ─── RunOptions tests ───────────────────────────────────────────────────

  it('uses workDir from RunOptions as cwd', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(''));

    await engine.run('src/test.rs', { workDir: '/tmp/sandbox' });

    expect(mockRunShell).toHaveBeenCalledWith(
      'cargo',
      expect.any(Array),
      expect.objectContaining({ cwd: '/tmp/sandbox' }),
    );
  });

  it('uses custom timeoutMs from RunOptions', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(''));

    await engine.run('src/test.rs', { timeoutMs: 120000 });

    expect(mockRunShell).toHaveBeenCalledWith(
      'cargo',
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 120000 }),
    );
  });

  it('defaults to 5-minute timeout', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(''));

    await engine.run('src/test.rs');

    expect(mockRunShell).toHaveBeenCalledWith(
      'cargo',
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });
});
