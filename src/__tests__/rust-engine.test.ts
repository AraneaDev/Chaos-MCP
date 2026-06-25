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

  // ─── JSON output parsing tests ──────────────────────────────────────────

  it('parses valid JSON output and prioritises it over text', async () => {
    const stdout = JSON.stringify({
      summary: { caught: 1, missed: 1, total: 2 },
      mutants: [
        { status: 'missed', line: 42, description: 'replace == with !=' },
        { status: 'caught', line: 10 },
      ],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.rs');
    expect(result.totalMutants).toBe(2);
    expect(result.survived).toBe(1);
    expect(result.mutationScore).toBe('50.00%');
    expect(result.vulnerabilities[0].line).toBe(42);
    expect(result.vulnerabilities[0].replacement).toBe('replace == with');
  });

  it('handles JSON with missing summary properties and missing mutant descriptions', async () => {
    const stdout = JSON.stringify({
      summary: {},
      mutants: [{ status: 'UNCAUGHT', caught: false }],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.rs');
    expect(result.killed).toBe(0);
    expect(result.survived).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
    expect(result.vulnerabilities[0].line).toBe(0);
    expect(result.vulnerabilities[0].replacement).toBe('Rust Mutation Operator');
  });

  it('falls back to text parsing when JSON has no summary/mutants', async () => {
    mockRunShell.mockResolvedValue(
      makeExecResult('{"bad": true}\nMISSED   src/main.rs:1:1  replaced'),
    );
    const result = await engine.run('src/main.rs');
    expect(result.survived).toBe(1);
    expect(result.vulnerabilities[0].line).toBe(1);
  });

  it('handles text output with leading whitespace and empty lines mixed in', async () => {
    const stdout = '\n  MISSED   src/m.rs:5:1  \n\n  CAUGHT   src/m.rs:6:1  \n';
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/m.rs');
    expect(result.totalMutants).toBe(2);
    expect(result.survived).toBe(1);
    expect(result.vulnerabilities[0].line).toBe(5);
  });

  it('reports 100% when JSON has zero total mutants and empty mutants array', async () => {
    const stdout = JSON.stringify({
      summary: { caught: 0, missed: 0, total: 0 },
      mutants: [],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.rs');
    expect(result.mutationScore).toBe('100.00%');
    expect(result.vulnerabilities).toHaveLength(0);
  });

  // ─── Error handling edge cases ──────────────────────────────────────────

  it('throws when cargo-mutants rejects with non-ExecFailureError non-Error', async () => {
    mockRunShell.mockRejectedValue('plain string rejection');

    await expect(engine.run('src/test.rs')).rejects.toThrow(/cargo-mutants execution failed/);
  });

  it('handles ExecFailureError with exit=0 gracefully', async () => {
    const stdout = ['CAUGHT   src/m.rs:1:1  replaced'].join('\n');
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 0, stdout, stderr: 'odd' }));

    const result = await engine.run('src/m.rs');
    expect(result.totalMutants).toBe(1);
    expect(result.killed).toBe(1);
  });

  it('throws MutationToolStartupError from cargo-mutants verbatim', async () => {
    const { MutationToolStartupError } = await import('../utils/exec-classify.js');
    mockRunShell.mockRejectedValue(
      new MutationToolStartupError('cargo-mutants', 'not installed', ''),
    );

    await expect(engine.run('src/test.rs')).rejects.toThrow('not installed');
  });

  it('extracts filename correctly from filePath without slashes', async () => {
    const stdout = ['CAUGHT   main.rs:1:1  replaced'].join('\n');
    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('main.rs');
    expect(result.totalMutants).toBe(1);
    // fileName extraction: 'main.rs'.split('/').pop() = 'main.rs'
    expect(mockRunShell).toHaveBeenCalledWith(
      'cargo',
      expect.arrayContaining(['--file', 'main.rs']),
      expect.any(Object),
    );
  });

  it('passes --file with the full workspace-relative path for nested paths', async () => {
    // Med#9: cargo-mutants --file is a glob matched against the path. A bare
    // basename (module.rs) over-matches every same-named file in other dirs;
    // the precise relative path scopes the run to the requested file only.
    mockRunShell.mockResolvedValue(makeExecResult(''));

    await engine.run('src/deeply/nested/module.rs');
    expect(mockRunShell).toHaveBeenCalledWith(
      'cargo',
      expect.arrayContaining(['--file', 'src/deeply/nested/module.rs']),
      expect.any(Object),
    );
  });

  it('passes --file with a backslash path unchanged (Windows separators)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(''));

    await engine.run('src\\win\\mod.rs');
    expect(mockRunShell).toHaveBeenCalledWith(
      'cargo',
      expect.arrayContaining(['--file', 'src\\win\\mod.rs']),
      expect.any(Object),
    );
  });

  // ─── Verbose logging paths ──────────────────────────────────────────────

  it('logs cargo-mutants invocation in verbose mode', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    const mockVerbose = vi.mocked(isVerbose);

    mockVerbose.mockReturnValue(true);
    mockRunShell.mockResolvedValue(makeExecResult(''));

    await engine.run('src/test.rs');

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('RustEngine'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('cargo mutants'));
    // Reset for subsequent tests
    mockVerbose.mockReturnValue(false);
  });

  it('logs cargo-mutants stderr in verbose mode when present', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    const mockVerbose = vi.mocked(isVerbose);

    mockVerbose.mockReturnValue(true);
    mockRunShell.mockResolvedValue(
      makeExecResult('CAUGHT   src/m.rs:1:1  replaced', 'compilation warnings'),
    );

    await engine.run('src/m.rs');

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('cargo-mutants stderr'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('compilation warnings'));
    // Reset
    mockVerbose.mockReturnValue(false);
  });

  it('extracts filename from filePath with only filename (no slashes)', async () => {
    const stdout = ['CAUGHT   lib.rs:1:1  replaced'].join('\n');
    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('lib.rs');
    expect(result.totalMutants).toBe(1);
    // fileName = 'lib.rs'.split('/').pop() = 'lib.rs'
    expect(mockRunShell).toHaveBeenCalledWith(
      'cargo',
      expect.arrayContaining(['--file', 'lib.rs']),
      expect.any(Object),
    );
  });

  it('handles MISSED line with no colon-number pattern (line=0)', async () => {
    const stdout = 'MISSED   src/file  replaced something';
    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/file');
    // lineMatch is null → mutantLine = 0
    expect(result.vulnerabilities[0].line).toBe(0);
  });

  it('handles non-zero exit with empty stdout but non-empty stderr', async () => {
    mockRunShell.mockRejectedValue(
      makeExecFailure({ exit: 1, stdout: '', stderr: 'build failure' }),
    );

    await expect(engine.run('src/test.rs')).rejects.toThrow(/no parseable output/);
    await expect(engine.run('src/test.rs')).rejects.toThrow(/build failure/);
    // Pin the remediation hint so its string literal is covered.
    await expect(engine.run('src/test.rs')).rejects.toThrow(/run `cargo test`/);
  });

  // ─── Description fallback for empty-string (bug fix verification) ─────

  it('falls back to default replacement when JSON mutant has empty-string description', async () => {
    // Bug fix: m.description?.split(' ').slice(0, 3).join(' ') ?? 'Rust Mutation Operator'
    // — the `??` only catches null/undefined. An empty string is truthy, so
    // `''.split(' ').slice(0, 3).join(' ')` produces '' which would be the
    // replacement shown to the user. We switched to `||` so empty strings
    // also fall back to the default label.
    const stdout = JSON.stringify({
      summary: { caught: 0, missed: 1, total: 1 },
      mutants: [{ status: 'missed', line: 42, description: '' }],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.rs');
    expect(result.vulnerabilities[0].replacement).toBe('Rust Mutation Operator');
  });

  // ─── Mutation hardening: JSON filter precision + summary math + verbose ────

  it('excludes caught mutants and includes only genuine survivors (JSON filter)', async () => {
    const stdout = JSON.stringify({
      summary: { caught: 1, missed: 1, total: 2 },
      mutants: [
        // caught=true with a "missed" status must STILL be excluded — the
        // `!m.caught && (...)` guard requires BOTH arms.
        { status: 'missed', caught: true, line: 99 },
        { status: 'missed', caught: false, line: 42 },
      ],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.rs');
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].line).toBe(42);
  });

  it.each(['MISSED', 'missed', 'UNCAUGHT'])(
    'treats an uncaught mutant with status %s as a survivor',
    async (status) => {
      const stdout = JSON.stringify({
        summary: { caught: 0, missed: 1, total: 1 },
        mutants: [{ status, caught: false, line: 7 }],
      });
      mockRunShell.mockResolvedValue(makeExecResult(stdout));
      const result = await engine.run('src/main.rs');
      expect(result.vulnerabilities).toHaveLength(1);
      expect(result.vulnerabilities[0].line).toBe(7);
    },
  );

  it('ignores a mutant whose status is not a survivor marker', async () => {
    const stdout = JSON.stringify({
      summary: { caught: 1, missed: 0, total: 1 },
      mutants: [{ status: 'caught', caught: false, line: 5 }],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.rs');
    expect(result.vulnerabilities).toHaveLength(0);
  });

  it('derives total from caught + missed when summary.total is absent', async () => {
    const stdout = JSON.stringify({
      summary: { caught: 3, missed: 2 },
      mutants: [],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.rs');
    expect(result.totalMutants).toBe(5);
    expect(result.mutationScore).toBe('60.00%');
  });

  it('does not log when verbose mode is off', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    vi.mocked(isVerbose).mockReturnValue(false);
    mockLog.mockClear();
    mockRunShell.mockResolvedValue(makeExecResult('CAUGHT  src/main.rs:1:1', 'noise'));

    await engine.run('src/main.rs');

    expect(mockLog).not.toHaveBeenCalled();
  });

  it('labels a text-parsed survivor with the operator and full description', async () => {
    mockRunShell.mockResolvedValue(
      makeExecResult('MISSED   src/billing.rs:42:5  replaced >= with >'),
    );
    const result = await engine.run('src/billing.rs');
    expect(result.vulnerabilities[0].replacement).toBe('Rust Mutation Operator');
    expect(result.vulnerabilities[0].description).toBe(
      'Mutation survived at line 42. The Rust test suite did not catch this change.',
    );
  });

  it('passes exactly ["mutants", "--file", <relative path>] to cargo', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(''));
    await engine.run('src/deeply/nested/module.rs', { workDir: '/tmp/x' });
    expect(mockRunShell).toHaveBeenCalledWith(
      'cargo',
      ['mutants', '--file', 'src/deeply/nested/module.rs'],
      expect.objectContaining({ cwd: '/tmp/x' }),
    );
  });

  it('renders the survivor line in JSON descriptions, keeping 0 distinct from missing', async () => {
    const present = JSON.stringify({
      summary: { caught: 0, missed: 1, total: 1 },
      mutants: [{ status: 'missed', caught: false, line: 42 }],
    });
    mockRunShell.mockResolvedValue(makeExecResult(present));
    const r1 = await engine.run('src/main.rs');
    expect(r1.vulnerabilities[0].description).toContain('line 42');

    const missing = JSON.stringify({
      summary: { caught: 0, missed: 1, total: 1 },
      mutants: [{ status: 'missed', caught: false }],
    });
    vi.clearAllMocks();
    mockRunShell.mockResolvedValue(makeExecResult(missing));
    const r2 = await engine.run('src/main.rs');
    expect(r2.vulnerabilities[0].description).toContain('line unknown');

    const zero = JSON.stringify({
      summary: { caught: 0, missed: 1, total: 1 },
      mutants: [{ status: 'missed', caught: false, line: 0 }],
    });
    vi.clearAllMocks();
    mockRunShell.mockResolvedValue(makeExecResult(zero));
    const r3 = await engine.run('src/main.rs');
    expect(r3.vulnerabilities[0].description).toContain('line 0');
  });

  it('falls back to text parsing when JSON has a summary but no mutants array', async () => {
    // `summary && mutants` short-circuits to text; a `||` mutant would dereference
    // the absent mutants array and throw.
    mockRunShell.mockResolvedValue(
      makeExecResult('{"summary":{"caught":1,"missed":0,"total":1}}\nCAUGHT src/m.rs:1:1  x'),
    );
    const result = await engine.run('src/main.rs');
    expect(result.totalMutants).toBe(1);
    expect(result.killed).toBe(1);
  });

  it('falls back to text parsing when JSON has mutants but no summary', async () => {
    mockRunShell.mockResolvedValue(
      makeExecResult('{"mutants":[{"status":"missed","line":9}]}\nMISSED src/m.rs:3:1  x'),
    );
    const result = await engine.run('src/main.rs');
    expect(result.totalMutants).toBe(1);
    expect(result.vulnerabilities[0].line).toBe(3);
  });
});
