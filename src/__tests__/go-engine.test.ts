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

  it('throws baseline failure on non-zero exit when zero mutants parsed (H2 regression)', async () => {
    // go-mutesting exits 1 with stdout showing a baseline `go test` BUILD error.
    // A realistic baseline failure looks like a Go compiler error
    // (e.g. `undefined: foo`, `cannot find package`) rather than a mutant
    // PASS/FAIL line. The H2 fix: do NOT silently report 100% score — throw
    // baseline failure when zero mutant lines are parsed on a non-zero exit.
    const baselineErrorStdout = [
      '# github.com/example/pkg',
      './main.go:5:2: undefined: foo',
      './main.go:6:2: undefined: bar',
    ].join('\n');
    mockRunShell.mockRejectedValue(
      makeExecFailure({ exit: 1, stdout: baselineErrorStdout, stderr: '' }),
    );

    await expect(engine.run('src/test.go')).rejects.toThrow(/go-mutesting baseline failure/);
    await expect(engine.run('src/test.go')).rejects.toThrow(/no mutants parsed/);
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

  // ─── JSON output parsing tests ──────────────────────────────────────────

  it('parses valid JSON output and prioritises it over text', async () => {
    const stdout = JSON.stringify({
      stats: { totalMutants: 2, killed: 1, survived: 1, mutationScore: 50 },
      mutants: [{ status: 'SURVIVED', line: 42, mutator: 'ConditionalsBoundary' }],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.go');
    expect(result.survived).toBe(1);
    expect(result.mutationScore).toBe('50.00%');
    expect(result.vulnerabilities[0].line).toBe(42);
    expect(result.vulnerabilities[0].replacement).toBe('ConditionalsBoundary');
  });

  it('handles JSON with missing stats properties and missing mutant lines/mutators', async () => {
    const stdout = JSON.stringify({
      stats: { totalMutants: 2, killed: 1 },
      mutants: [{ status: 'survived' }],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.go');
    expect(result.survived).toBe(1);
    expect(result.mutationScore).toBe('100.00%');
    expect(result.vulnerabilities[0].line).toBe(0);
    expect(result.vulnerabilities[0].replacement).toBe('Go Mutation Operator');
  });

  it('falls back to text parsing when JSON has no stats/mutants', async () => {
    mockRunShell.mockResolvedValue(makeExecResult('{"stats": {}}\nFAIL  "/path/src/m.go:1:1"'));
    const result = await engine.run('src/main.go');
    expect(result.survived).toBe(1);
    expect(result.vulnerabilities[0].line).toBe(1);
  });

  it('handles text output with leading whitespace (Audit L8 fix)', async () => {
    const stdout = '   FAIL  "/path/src/m.go:5:1"  \n   PASS  "/path/src/m.go:6:1"  ';
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/m.go');
    expect(result.totalMutants).toBe(2);
    expect(result.survived).toBe(1);
    expect(result.vulnerabilities[0].line).toBe(5);
  });

  it('ignores PASS/FAIL lines without quotes (Audit H2 compiler errors)', async () => {
    const stdout = 'FAIL  some/package [build failed]\nFAIL  "/path/src/m.go:10:1"';
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.go');
    expect(result.totalMutants).toBe(1);
    expect(result.survived).toBe(1);
    expect(result.vulnerabilities[0].line).toBe(10);
  });

  // ─── Error handling edge cases ──────────────────────────────────────────

  it('throws when go-mutesting rejects with non-ExecFailureError non-Error', async () => {
    mockRunShell.mockRejectedValue('plain string rejection');

    await expect(engine.run('src/test.go')).rejects.toThrow(/go-mutesting execution failed/);
  });

  it('handles ExecFailureError with exit=0 gracefully', async () => {
    const stdout = ['PASS  "/path/src/m.go:1:1"'].join('\n');
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 0, stdout, stderr: 'odd' }));

    const result = await engine.run('src/m.go');
    expect(result.totalMutants).toBe(1);
    expect(result.killed).toBe(1);
  });

  it('throws MutationToolStartupError from go-mutesting verbatim', async () => {
    const { MutationToolStartupError } = await import('../utils/exec-classify.js');
    mockRunShell.mockRejectedValue(new MutationToolStartupError('go-mutesting', 'not found', ''));

    await expect(engine.run('src/test.go')).rejects.toThrow('not found');
  });

  // ─── JSON-without-mutants fallback ──────────────────────────────────────

  it('falls back to text when JSON has stats but no mutants array', async () => {
    mockRunShell.mockResolvedValue(
      makeExecResult('{"stats":{"totalMutants":1,"killed":1}}\nPASS  "/path/src/m.go:1:1"'),
    );
    const result = await engine.run('src/main.go');
    // JSON has stats but no mutants → parsed.stats is truthy, parsed.mutants is undefined
    // `parsed.stats && parsed.mutants` → false → falls to text parsing
    expect(result.totalMutants).toBe(1);
    expect(result.killed).toBe(1);
  });

  it('falls back to text when JSON is partially valid but lacks stats', async () => {
    mockRunShell.mockResolvedValue(
      makeExecResult('{"mutants":[{"status":"SURVIVED","line":42}]}\nPASS  "/path/src/m.go:1:1"'),
    );
    const result = await engine.run('src/main.go');
    // JSON has mutants but no stats → parsed.stats is undefined
    // `parsed.stats && parsed.mutants` → false → falls to text parsing
    expect(result.totalMutants).toBe(1);
    expect(result.killed).toBe(1);
  });

  // ─── Verbose logging paths ──────────────────────────────────────────────

  it('logs go-mutesting invocation in verbose mode', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    const mockVerbose = vi.mocked(isVerbose);

    mockVerbose.mockReturnValue(true);
    mockRunShell.mockResolvedValue(makeExecResult(''));

    await engine.run('src/test.go');

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('GoEngine'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('go-mutesting'));
    // Reset for subsequent tests
    mockVerbose.mockReturnValue(false);
  });

  it('logs go-mutesting stderr in verbose mode when present', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    const mockVerbose = vi.mocked(isVerbose);

    mockVerbose.mockReturnValue(true);
    mockRunShell.mockResolvedValue(makeExecResult('PASS  "/path/src/m.go:1:1"', 'some stderr'));

    await engine.run('src/test.go');

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('go-mutesting stderr'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('some stderr'));
    // Reset for subsequent tests
    mockVerbose.mockReturnValue(false);
  });

  it('does not log stderr in verbose mode when stderr is empty', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    const mockVerbose = vi.mocked(isVerbose);

    mockVerbose.mockReturnValue(true);
    mockLog.mockClear();
    mockRunShell.mockResolvedValue(makeExecResult('PASS  "/path/src/m.go:1:1"', ''));

    await engine.run('src/test.go');

    // Only the invocation log should appear, not the stderr log
    const stderrLogs = mockLog.mock.calls.filter(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('go-mutesting stderr'),
    );
    expect(stderrLogs).toHaveLength(0);
    // Reset
    mockVerbose.mockReturnValue(false);
  });

  it('handles FAIL line with quotes but no colon-number pattern (line=0)', async () => {
    const stdout = 'FAIL  "/path/src/no-line"';
    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/main.go');
    // lineMatch is null → mutantLine = 0
    expect(result.vulnerabilities[0].line).toBe(0);
  });

  it('uses survived fallback when JSON survived is 0 (totalMutants - killed)', async () => {
    const stdout = JSON.stringify({
      stats: { totalMutants: 5, killed: 3, survived: 0, mutationScore: 60 },
      mutants: [{ status: 'SURVIVED', line: 10 }],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.go');
    // survived is 0 → `survived || totalMutants - killed` → 5-3 = 2
    expect(result.survived).toBe(2);
  });

  // ─── Mutation hardening: baseline-failure messages + verbose guard ────────

  it('throws "no parseable output" on a non-zero exit with empty stdout', async () => {
    mockRunShell.mockRejectedValue(
      makeExecFailure({ exit: 1, stdout: '', stderr: 'baseline boom' }),
    );

    // Covers the `if (!stdout)` branch and its message (incl. the stderr tail).
    await expect(engine.run('src/test.go')).rejects.toThrow(/no parseable output/);
    await expect(engine.run('src/test.go')).rejects.toThrow(/baseline test suite itself failed/);
    await expect(engine.run('src/test.go')).rejects.toThrow(/baseline boom/);
  });

  it('includes the remediation hint and stderr in the H2 baseline-failure message', async () => {
    const baselineErrorStdout = '# pkg\n./main.go:5:2: undefined: foo';
    mockRunShell.mockRejectedValue(
      makeExecFailure({ exit: 1, stdout: baselineErrorStdout, stderr: 'compiler exploded' }),
    );

    await expect(engine.run('src/test.go')).rejects.toThrow(/Run `go test \.\/\.\.\.` first/);
    await expect(engine.run('src/test.go')).rejects.toThrow(/compiler exploded/);
  });

  it('does not log when verbose mode is off', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    const mockVerbose = vi.mocked(isVerbose);
    mockVerbose.mockReturnValue(false);
    mockLog.mockClear();
    mockRunShell.mockResolvedValue(makeExecResult('PASS  "/path/src/m.go:1:1"', 'some stderr'));

    await engine.run('src/main.go');

    expect(mockLog).not.toHaveBeenCalled();
  });

  // ─── Mutation hardening ──────────────────────────────────────────────────

  it('ignores an unquoted PASS line (the quote gate must reject non-mutant output)', async () => {
    // `PASS ok pkg 0.5s` is a `go test` success line, not a mutant result.
    const stdout = 'PASS ok github.com/x/pkg 0.5s\nPASS  "/path/src/m.go:7:1"';
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/m.go');
    expect(result.totalMutants).toBe(1);
    expect(result.killed).toBe(1);
  });

  it('labels a text-parsed survivor with the operator and full description', async () => {
    mockRunShell.mockResolvedValue(makeExecResult('FAIL  "/path/src/billing.go:42:1"'));
    const result = await engine.run('src/billing.go');
    expect(result.vulnerabilities[0].replacement).toBe('Go Mutation Operator');
    expect(result.vulnerabilities[0].description).toBe(
      'Mutation survived at line 42. The go test suite did not catch this change.',
    );
  });

  it('passes exactly [filePath] as the go-mutesting argument vector', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(''));
    await engine.run('src/widget.go', { workDir: '/tmp/x' });
    expect(mockRunShell).toHaveBeenCalledWith(
      'go-mutesting',
      ['src/widget.go'],
      expect.objectContaining({ cwd: '/tmp/x' }),
    );
  });

  it('keeps only SURVIVED mutants from JSON output, dropping killed/other statuses', async () => {
    const stdout = JSON.stringify({
      stats: { totalMutants: 3, killed: 2, survived: 1, mutationScore: 33.33 },
      mutants: [
        { status: 'KILLED', line: 5 },
        { status: 'SURVIVED', line: 9 },
        { status: 'covered', line: 1 },
      ],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.go');
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].line).toBe(9);
  });

  it('renders "line unknown" when a JSON survivor has no line and keeps 0 distinct from missing', async () => {
    const missing = JSON.stringify({
      stats: { totalMutants: 1, killed: 0, survived: 1, mutationScore: 0 },
      mutants: [{ status: 'SURVIVED' }],
    });
    mockRunShell.mockResolvedValue(makeExecResult(missing));
    const r1 = await engine.run('src/main.go');
    expect(r1.vulnerabilities[0].description).toContain('line unknown');

    // line 0 must read as "line 0", not coalesce to "unknown" (?? vs ||).
    const zero = JSON.stringify({
      stats: { totalMutants: 1, killed: 0, survived: 1, mutationScore: 0 },
      mutants: [{ status: 'SURVIVED', line: 0 }],
    });
    vi.clearAllMocks();
    mockRunShell.mockResolvedValue(makeExecResult(zero));
    const r2 = await engine.run('src/main.go');
    expect(r2.vulnerabilities[0].description).toContain('line 0');
  });

  it('names the missing PASS/FAIL emission in the H2 baseline-failure message', async () => {
    mockRunShell.mockRejectedValue(
      makeExecFailure({ exit: 1, stdout: '# pkg\n./main.go:5:2: undefined: foo', stderr: 'x' }),
    );
    await expect(engine.run('src/test.go')).rejects.toThrow(/did not emit any PASS\/FAIL lines/);
  });

  // BaseEngine.toExecFailure: a MutationToolStartupError is rethrown verbatim,
  // while any other non-ExecFailure error is wrapped as "<tool> execution failed".
  it('rethrows a startup error verbatim rather than wrapping it as "execution failed"', async () => {
    const { MutationToolStartupError } = await import('../utils/exec-classify.js');
    mockRunShell.mockRejectedValue(
      new MutationToolStartupError('go-mutesting', 'go-mutesting is not installed', ''),
    );
    // Must surface the verbatim startup message, NOT the "<tool> execution failed: …" wrap.
    await expect(engine.run('src/test.go')).rejects.toThrow('go-mutesting is not installed');
    await expect(engine.run('src/test.go')).rejects.not.toThrow(/execution failed/);
  });
});
