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

// Mock fs so the v3 path's read of mutants/mutmut-cicd-stats.json is injectable.
// Default readFileSync: ENOENT (no stats file) so v2-format tests take the
// legacy path. existsSync=false means the [tool.mutmut] config injection reads
// nothing and just writes (writeFileSync is a noop here).
vi.mock('node:fs', () => ({
  readFileSync: vi.fn(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  existsSync: vi.fn(() => false),
  writeFileSync: vi.fn(),
}));

import { readFileSync } from 'node:fs';
import { runShell, ExecFailureError } from '../utils/exec.js';
import { PythonEngine } from '../engines/python.js';

const mockRunShell = vi.mocked(runShell);
const mockReadFileSync = vi.mocked(readFileSync);
const CICD_STATS_JSON = JSON.stringify({ killed: 1, survived: 1, total: 2 });

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
      'mutmut is not installed. Install it with: pipx install mutmut (or: pip install mutmut in a virtualenv)',
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
    // mutmut v3 `run` takes a mutant-name glob (module.*), NOT a file path —
    // `mutmut run src/test.py` errors with "nothing matches".
    expect(args[0]).toBe('run');
    expect(args[1]).toBe('src.test.*');
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

  // ─── mutmut run stdout capture optimization ────────────────────────────────

  it('parses results from mutmut run stdout and skips mutmut results call', async () => {
    // mutmut run outputs inline results (mutmut v3+ behavior)
    mockRunShell.mockResolvedValueOnce(
      makeExecResult(mutmutResults({ survived: 1, killed: 3, survivedIds: ['src/calc.py:42'] })),
    );

    const result = await engine.run('src/calc.py');

    expect(result.totalMutants).toBe(4);
    expect(result.killed).toBe(3);
    expect(result.survived).toBe(1);
    // mutmut results must NOT have been called
    expect(mockRunShell).toHaveBeenCalledTimes(1);
  });

  it('falls back to mutmut results when run stdout has no parseable results', async () => {
    // mutmut run succeeds but stdout is empty/irrelevant
    mockRunShell.mockResolvedValueOnce(makeExecResult('', ''));
    // mutmut results is called as fallback
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ killed: 4 })));

    const result = await engine.run('src/calc.py');

    expect(result.totalMutants).toBe(4);
    expect(result.killed).toBe(4);
    expect(mockRunShell).toHaveBeenCalledTimes(2);
  });

  it('falls back to mutmut results when run stdout parses to zero mutants', async () => {
    // mutmut run outputs category headers but all counts are 0
    mockRunShell.mockResolvedValueOnce(makeExecResult('Survived 🙂 (0)\nKilled 🎉 (0)'));
    // mutmut results has the real data
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ survived: 2, killed: 5 })));

    const result = await engine.run('src/calc.py');

    expect(result.totalMutants).toBe(7);
    expect(result.survived).toBe(2);
    expect(mockRunShell).toHaveBeenCalledTimes(2);
  });

  it('throws when mutmut run throws non-ExecFailureError plain Error', async () => {
    mockRunShell.mockRejectedValueOnce(new Error('something crashed'));

    await expect(engine.run('src/test.py')).rejects.toThrow('something crashed');
  });

  it('throws when mutmut results throws non-ExecFailureError non-Error (string)', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockRejectedValueOnce('plain string error');

    await expect(engine.run('src/test.py')).rejects.toThrow(/Failed to retrieve mutmut results/);
  });

  it('does not add --runner flag when testRunner is pytest (default)', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ killed: 0 })));

    await engine.run('src/test.py');

    const args = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain('--runner');
  });

  it('adds --runner when testRunner is not pytest', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ killed: 0 })));

    await engine.run('src/test.py', { testRunner: 'nosetests' });

    const args = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(args).toContain('--runner');
    expect(args).toContain('nosetests');
  });

  it('parses run stdout even when it contains only killed mutants (no survivors)', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ killed: 5 })));

    const result = await engine.run('src/calc.py');

    expect(result.totalMutants).toBe(5);
    expect(result.killed).toBe(5);
    expect(result.survived).toBe(0);
    expect(mockRunShell).toHaveBeenCalledTimes(1);
  });

  // ─── ExecFailureError with exit=null in mutmut run catch ──────────────────

  it('rethrows ExecFailureError when exit is 0 (not null and not !== 0)', async () => {
    // exit=0 is unusual (ExecFailureError normally has non-zero exit),
    // but tests the defensive fallthrough in the PythonEngine catch block
    mockRunShell.mockRejectedValueOnce(
      makeExecFailure({ exit: 0, signal: null, stderr: 'odd case' }),
    );

    await expect(engine.run('src/test.py')).rejects.toThrow('Command failed');
  });

  it('rethrows (not baseline-failure) an ExecFailureError whose exit is null', async () => {
    // exit=null must NOT be treated as a baseline test failure — it falls through
    // to the generic rethrow. Kills `error.exit !== null`→true (line 273): with
    // `true`, a null exit would wrongly produce the "baseline test failure" error.
    mockRunShell.mockRejectedValueOnce(
      makeExecFailure({ exit: null, signal: null, stderr: 'crash' }),
    );

    const err = await engine.run('src/test.py').catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/baseline test failure/);
    expect((err as Error).message).toContain('Command failed');
  });

  it('includes stderr prefix in mutmut baseline failure message, truncated to 500 chars', async () => {
    const longStderr = 'x'.repeat(600);
    mockRunShell.mockRejectedValueOnce(makeExecFailure({ exit: 1, stderr: longStderr }));

    const err = await engine.run('src/test.py').catch((e: Error) => e);
    expect((err as Error).message).toContain('Fix the failing tests first');
    // Kills the `.slice(0, 500)`→(no slice) MethodExpression on line 276.
    expect((err as Error).message).toContain('x'.repeat(500));
    expect((err as Error).message).not.toContain('x'.repeat(501));
  });

  // ─── mutmut results catch ─────────────────────────────────────────────────

  it('throws on MutationToolStartupError from mutmut results', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    const { MutationToolStartupError } = await import('../utils/exec-classify.js');
    mockRunShell.mockRejectedValueOnce(new MutationToolStartupError('mutmut', 'not installed', ''));

    await expect(engine.run('src/test.py')).rejects.toThrow('not installed');
  });

  // ─── Verbose logging path ───────────────────────────────────────────────

  it('logs command in verbose mode', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockedIsVerbose = vi.mocked(isVerbose);
    const mockedLog = vi.mocked(log);
    mockedIsVerbose.mockReturnValue(true);
    mockedLog.mockClear();

    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ killed: 1 })));

    await engine.run('src/test.py');

    expect(mockedLog).toHaveBeenCalledWith(expect.stringContaining('PythonEngine'));
  });

  it('handles ExecFailureError with exit=0 in mutmut run catch', async () => {
    // exit=0 on ExecFailureError is unusual but defensive
    mockRunShell.mockRejectedValueOnce(makeExecFailure({ exit: 0, signal: null, stderr: 'weird' }));

    await expect(engine.run('src/test.py')).rejects.toThrow('Command failed');
  });

  // ─── Mutation hardening: inline-results verbose path + results invocation ──

  it('logs the skip message in verbose mode when run stdout already has results', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(true);
    const mockedLog = vi.mocked(log);
    mockedLog.mockClear();

    mockRunShell.mockResolvedValueOnce(
      makeExecResult(mutmutResults({ survived: 1, killed: 3, survivedIds: ['src/calc.py:42'] })),
    );

    const result = await engine.run('src/calc.py');

    expect(result.totalMutants).toBe(4);
    // Covers the inline-results verbose branch (previously NoCoverage).
    expect(mockedLog).toHaveBeenCalledWith(expect.stringContaining('skipping mutmut results call'));
    // mutmut results must NOT have been called (inline short-circuit).
    expect(mockRunShell).toHaveBeenCalledTimes(1);
  });

  it('invokes `mutmut results` when run stdout has no parseable results', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult('')); // run: no inline results
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ killed: 2 }))); // results

    await engine.run('src/calc.py');

    expect(mockRunShell).toHaveBeenCalledTimes(2);
    expect(mockRunShell).toHaveBeenNthCalledWith(2, 'mutmut', ['results'], expect.any(Object));
  });

  it('wraps a non-Error rejection from mutmut run as "mutmut execution failed"', async () => {
    // The run catch ends with `throw error instanceof Error ? error : new Error(...)`.
    // A non-Error rejection exercises the String(error) wrap branch.
    mockRunShell.mockRejectedValueOnce('boom-string');
    await expect(engine.run('src/test.py')).rejects.toThrow(/mutmut execution failed: boom-string/);
  });

  // ─── Mutation hardening: parser edge cases ────────────────────────────────

  it('parses multi-digit category counts (not just the first digit)', async () => {
    // A `\d+` → `\d` regex mutant would read "12" as 1.
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ killed: 12, survived: 23 })));
    const result = await engine.run('src/calc.py');
    expect(result.killed).toBe(12);
    expect(result.survived).toBe(23);
    expect(result.totalMutants).toBe(35);
  });

  it('extracts a multi-digit line number from a mutant ID', async () => {
    // Guards the `:(\d+)\D*$` capture group against single-digit narrowing.
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(
      makeExecResult(mutmutResults({ survived: 1, killed: 1, survivedIds: ['pkg/mod.py:147'] })),
    );
    const result = await engine.run('src/calc.py');
    expect(result.vulnerabilities[0].line).toBe(147);
    expect(result.vulnerabilities[0].description).toContain('line 147');
  });

  it('recognizes a parenthetical header even without the category emoji', async () => {
    // Exercises the hasParensCount fallback (line ~119) and its \(\d+\) regex.
    mockRunShell.mockResolvedValueOnce(makeExecResult('Survived (15)\nKilled (5)'));
    const result = await engine.run('src/calc.py');
    expect(result.survived).toBe(15);
    expect(result.killed).toBe(5);
    expect(result.totalMutants).toBe(20);
  });

  it('resets the category on a blank line so trailing indented lines are not captured', async () => {
    // If the `if (!trimmed) { currentCategory = null }` reset is removed, the
    // stray indented line after the blank would be misattributed as a survivor.
    const text = [
      'Survived 🙂 (1)',
      '  real_mutant.py:9',
      '',
      '  stray_line',
      'Killed 🎉 (2)',
    ].join('\n');
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(makeExecResult(text));
    const result = await engine.run('src/calc.py');
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].line).toBe(9);
    expect(result.survived).toBe(1);
  });

  it('trusts the header count over fewer captured IDs (Math.max)', async () => {
    // survived header says 5 but only 2 IDs are listed → survivedCount must be 5.
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(
      makeExecResult(mutmutResults({ survived: 5, killed: 1, survivedIds: ['a.py:1', 'a.py:2'] })),
    );
    const result = await engine.run('src/calc.py');
    expect(result.survived).toBe(5);
    expect(result.vulnerabilities).toHaveLength(2);
  });

  it('counts suspicious mutants as surviving and emits a dedicated summary entry', async () => {
    // Covers the Suspicious header recognition, the suspicious>0 branch, and the
    // survivedCount = ... + suspicious arithmetic.
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ suspicious: 2, killed: 8 })));
    const result = await engine.run('src/calc.py');
    expect(result.survived).toBe(2);
    expect(result.totalMutants).toBe(10);
    const suspiciousVuln = result.vulnerabilities.find((v) => v.mutator === 'Suspicious Mutation');
    expect(suspiciousVuln?.description).toContain('2 suspicious mutant(s)');
  });

  it('treats skipped mutants as part of the total but not as killed or survived', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ killed: 4, skipped: 3 })));
    const result = await engine.run('src/calc.py');
    expect(result.killed).toBe(4);
    expect(result.survived).toBe(0);
    expect(result.totalMutants).toBe(7);
  });

  it('counts timeouts as killed (suite detected the mutant by hanging)', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ killed: 2, timeout: 3 })));
    const result = await engine.run('src/calc.py');
    expect(result.killed).toBe(5);
    expect(result.totalMutants).toBe(5);
    expect(result.mutationScore).toBe('100.00%');
  });

  it('only captures indented lines under the Survived category', async () => {
    // An indented line under "Killed" and a flush-left line under "Survived"
    // must both be excluded from surviving-mutant IDs.
    const text = [
      'Killed 🎉 (2)',
      '  killed_id.py:5',
      'Survived 🙂 (1)',
      '  surv_id.py:9',
      'flush_left_not_captured.py:99',
    ].join('\n');
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(makeExecResult(text));
    const result = await engine.run('src/calc.py');
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].line).toBe(9);
  });

  it('tags surviving-mutant vulnerabilities with the Arithmetic/Logical Mutation label', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(
      makeExecResult(mutmutResults({ survived: 1, killed: 1, survivedIds: ['a.py:3'] })),
    );
    const withIds = await engine.run('src/calc.py');
    expect(withIds.vulnerabilities[0].mutator).toBe('Arithmetic/Logical Mutation');

    vi.clearAllMocks();
    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ survived: 3, killed: 7 })));
    const noIds = await engine.run('src/calc.py');
    expect(noIds.vulnerabilities[0].mutator).toBe('Arithmetic/Logical Mutation');
  });

  it('does not log the command when verbose mode is off', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(false);
    const mockedLog = vi.mocked(log);
    mockedLog.mockClear();

    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ killed: 1 })));
    await engine.run('src/test.py');

    expect(mockedLog).not.toHaveBeenCalled();
  });

  it('logs the full "PythonEngine: mutmut run <file>" command in verbose mode', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(true);
    const mockedLog = vi.mocked(log);
    mockedLog.mockClear();

    mockRunShell.mockResolvedValueOnce(makeExecResult());
    mockRunShell.mockResolvedValueOnce(makeExecResult(mutmutResults({ killed: 1 })));
    await engine.run('src/test.py');

    expect(mockedLog).toHaveBeenCalledWith('PythonEngine: mutmut run src.test.*');
    vi.mocked(isVerbose).mockReturnValue(false);
  });

  // ─── mutmut v3: per-mutant status lines + `mutmut show` enrichment ────────

  const v3ShowDiff = [
    '# calc.x_classify__mutmut_1: survived',
    '--- calc.py',
    '+++ calc.py',
    '@@ -1,4 +1,4 @@',
    ' def classify(n):',
    '-    if n > 10:',
    '+    if n >= 10:',
    '         return "big"',
  ].join('\n');

  it('parses v3 `<id>: <status>` results and enriches survivors via `mutmut show`', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult('')); // run: spinner stdout, not parseable
    mockRunShell.mockResolvedValueOnce(makeExecResult('calc.x_classify__mutmut_1: survived')); // results (v3)
    mockRunShell.mockResolvedValueOnce(makeExecResult('')); // export-cicd-stats
    mockRunShell.mockResolvedValueOnce(makeExecResult(v3ShowDiff)); // show <id>
    // counts come from the cicd JSON, NOT the results text
    mockReadFileSync.mockReturnValueOnce(CICD_STATS_JSON);

    const result = await engine.run('calc.py');

    expect(result.killed).toBe(1);
    expect(result.survived).toBe(1);
    expect(result.totalMutants).toBe(2);
    expect(result.mutationScore).toBe('50.00%'); // 1/2 from the JSON, not the text
    expect(result.vulnerabilities).toHaveLength(1);
    const v = result.vulnerabilities[0];
    expect(v.line).toBe(2);
    expect(v.original).toBe('if n > 10:');
    expect(v.mutated).toBe('if n >= 10:');
    // `mutmut show` was invoked with the surviving mutant's id.
    expect(mockRunShell).toHaveBeenNthCalledWith(
      4,
      'mutmut',
      ['show', 'calc.x_classify__mutmut_1'],
      expect.any(Object),
    );
  });

  it('keeps the survivor (best-effort) when `mutmut show` fails', async () => {
    mockRunShell.mockResolvedValueOnce(makeExecResult('')); // run
    mockRunShell.mockResolvedValueOnce(makeExecResult('calc.x_f__mutmut_1: survived')); // results
    mockRunShell.mockResolvedValueOnce(makeExecResult('')); // export-cicd-stats
    mockRunShell.mockRejectedValueOnce(makeExecFailure({ exit: 1, stderr: 'no such mutant' })); // show fails
    mockReadFileSync.mockReturnValueOnce(CICD_STATS_JSON);

    const result = await engine.run('calc.py');

    expect(result.survived).toBe(1);
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].line).toBe(0); // unchanged — no diff to enrich from
  });

  it('does not log the inline-skip message when verbose mode is off', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(false);
    const mockedLog = vi.mocked(log);
    mockedLog.mockClear();

    // Inline results present → results call is skipped, but no log in quiet mode.
    mockRunShell.mockResolvedValueOnce(
      makeExecResult(mutmutResults({ survived: 1, killed: 3, survivedIds: ['a.py:1'] })),
    );
    await engine.run('src/calc.py');

    expect(mockedLog).not.toHaveBeenCalled();
    expect(mockRunShell).toHaveBeenCalledTimes(1);
  });
});
