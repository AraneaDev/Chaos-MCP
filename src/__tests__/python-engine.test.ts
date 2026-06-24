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
import { PythonEngine } from '../engines/python.js';

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

/** Simulate mutmut results text output. */
function mutmutResults(opts: {
  survived?: number;
  killed?: number;
  timeout?: number;
  skipped?: number;
  suspicious?: number;
  survivedIds?: string[];
}): string {
  const lines: string[] = [];

  const s = opts.survived ?? 0;
  const k = opts.killed ?? 0;
  const t = opts.timeout ?? 0;
  const sk = opts.skipped ?? 0;
  const su = opts.suspicious ?? 0;

  if (s > 0) {
    lines.push(`Survived 🙂 (${s})`);
    for (const id of opts.survivedIds ?? []) {
      lines.push(`  ${id}`);
    }
  }
  if (k > 0) {
    lines.push(`Killed 🎉 (${k})`);
  }
  if (t > 0) {
    lines.push(`Timeout ⏰ (${t})`);
  }
  if (sk > 0) {
    lines.push(`Skipped 🤔 (${sk})`);
  }
  if (su > 0) {
    lines.push(`Suspicious 🤨 (${su})`);
  }

  return lines.join('\n');
}

describe('PythonEngine', () => {
  let engine: PythonEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new PythonEngine();
  });

  it('returns correct metrics when all mutants are killed', async () => {
    // mutmut run succeeds (exit 0)
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    // mutmut results shows all killed
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ killed: 5 })));

    const result = await engine.run('src/calculator.py');

    expect(result.totalMutants).toBe(5);
    expect(result.killed).toBe(5);
    expect(result.survived).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
  });

  it('reports surviving mutants as vulnerabilities', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(
      makeExecResult(
        mutmutResults({
          survived: 2,
          killed: 2,
          survivedIds: ['src/calculator.py:15', 'src/calculator.py:32'],
        }),
      ),
    );

    const result = await engine.run('src/calculator.py');

    expect(result.survived).toBe(2);
    expect(result.vulnerabilities).toHaveLength(2);
    expect(result.vulnerabilities[0].line).toBe(15);
    expect(result.vulnerabilities[1].line).toBe(32);
  });

  it('handles surviving mutants with numeric-only IDs (no line number)', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(
      makeExecResult(
        mutmutResults({
          survived: 2,
          killed: 3,
          survivedIds: ['1', '2'],
        }),
      ),
    );

    const result = await engine.run('src/calc.py');

    expect(result.survived).toBe(2);
    expect(result.vulnerabilities).toHaveLength(2);
    expect(result.vulnerabilities[0].line).toBe(0);
    expect(result.vulnerabilities[0].description).toContain('mutmut show');
  });

  it('adds a summary entry when survived count > 0 but no IDs captured', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ survived: 3, killed: 7 })));

    const result = await engine.run('src/calc.py');

    expect(result.survived).toBe(3);
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].line).toBe(0);
    expect(result.vulnerabilities[0].description).toContain('3 mutant(s) survived');
  });

  it('throws when mutmut is not installed (ENOENT)', async () => {
    mockRunShell.mockRejectedValueOnce(makeExecFailure({ code: 'ENOENT' }));

    await expect(engine.run('src/test.py')).rejects.toThrow(
      'mutmut is not installed. Install it with: pip install mutmut',
    );
  });

  it('surfaces non-zero exit from mutmut run as baseline-test failure', async () => {
    mockRunShell.mockRejectedValueOnce(
      makeExecFailure({ exit: 1, stderr: 'FAILED tests/test_calc.py::test_add' }),
    );

    await expect(engine.run('src/test.py')).rejects.toThrow(/baseline test failure/);
  });

  it('throws on timeout', async () => {
    mockRunShell.mockRejectedValueOnce(makeExecFailure({ code: 'TIMEOUT' }));

    await expect(engine.run('src/test.py')).rejects.toThrow(/timed out/);
  });

  it('throws on signal-based crash', async () => {
    mockRunShell.mockRejectedValueOnce(
      makeExecFailure({ signal: 'SIGSEGV', exit: null, stderr: 'segfault' }),
    );

    await expect(engine.run('src/test.py')).rejects.toThrow(/crashed.*SIGSEGV/);
  });

  it('handles mutmut results exiting non-zero with partial stdout', async () => {
    // run succeeds
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    // results exits non-zero but has stdout
    mockRunShell.mockRejectedValueOnce(
      makeExecFailure({ exit: 1, stdout: mutmutResults({ survived: 1, killed: 2 }) }),
    );

    const result = await engine.run('src/test.py');

    expect(result.survived).toBe(1);
    expect(result.killed).toBe(2);
  });

  it('throws when mutmut results fails with no output', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockRejectedValueOnce(
      makeExecFailure({ exit: 1, stdout: '', stderr: 'no cache' }),
    );

    await expect(engine.run('src/test.py')).rejects.toThrow(/Failed to retrieve mutmut results/);
  });

  // ─── RunOptions tests ───────────────────────────────────────────────────

  it('uses testRunner from RunOptions', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult()); // run
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ killed: 0 }))); // results

    await engine.run('src/test.py', { testRunner: 'python -m unittest' });

    const runCall = mockRunShell.mock.calls[0];
    const args = runCall?.[1] as string[];
    // mutmut v3 uses positional pattern, v2 used --paths-to-mutate
    expect(args[0]).toBe('run');
    expect(args[1]).toBe('src/test.py');
    expect(args).toContain('--runner');
    expect(args).toContain('python -m unittest');
  });

  it('uses workDir from RunOptions as cwd', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ killed: 0 })));

    await engine.run('src/test.py', { workDir: '/tmp/sandbox/workspace' });

    expect(mockRunShell).toHaveBeenNthCalledWith(
      1,
      'mutmut',
      expect.any(Array),
      expect.objectContaining({ cwd: '/tmp/sandbox/workspace' }),
    );
    expect(mockRunShell).toHaveBeenNthCalledWith(
      2,
      'mutmut',
      expect.any(Array),
      expect.objectContaining({ cwd: '/tmp/sandbox/workspace' }),
    );
  });

  it('uses custom timeoutMs from RunOptions', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ killed: 0 })));

    await engine.run('src/test.py', { timeoutMs: 120000 });

    expect(mockRunShell).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 120000 }),
    );
  });

  it('defaults to 5-minute timeout', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ killed: 0 })));

    await engine.run('src/test.py');

    expect(mockRunShell).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });
});
