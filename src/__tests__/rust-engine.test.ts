import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the async exec helper
vi.mock('../utils/exec.js', () => ({
  runShell: vi.fn(),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  isVerbose: vi.fn(() => false),
}));

import { runShell } from '../utils/exec.js';
import { ExecFailureError } from '../utils/exec-error.js';
import { RustEngine, resolveCargoJobs } from '../engines/rust.js';

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
  // The real ExecFailureError from exec-error.js — the same class the engine
  // narrows against with `instanceof`.
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

  describe('authoritative "N mutants tested" summary line', () => {
    // cargo-mutants only PRINTS the missed mutants by default, so counting
    // printed lines reports a false 0%. Since v27 it emits a summary line, and
    // that line is the source of truth for the score. Nothing else in this file
    // exercises it — every other fixture relies on line counting.

    it('scores from the summary rather than from the printed lines', async () => {
      const stdout = [
        'MISSED   src/math.rs:42:5  replaced >= with >',
        'MISSED   src/math.rs:88:1  replaced + with -',
        '12 mutants tested in 41s: 8 caught, 2 missed, 1 unviable, 1 timeout',
      ].join('\n');
      mockRunShell.mockResolvedValue(makeExecResult(stdout));

      const result = await engine.run('src/math.rs');

      // caught(8) + timeout(1) killed, missed(2) survived, unviable(1) excluded
      // from the denominator and surfaced separately.
      expect(result.killed).toBe(9);
      expect(result.survived).toBe(2);
      expect(result.totalMutants).toBe(11);
      expect(result.mutationScore).toBe('81.82%');
      expect(result.incompetent).toBe(1);
    });

    it('counts each outcome label into its own bucket', async () => {
      // Distinct numbers per label so a bucket wired to the wrong counter, or a
      // branch forced always-true, changes the score.
      const stdout = ['20 mutants tested: 10 caught, 4 missed, 3 unviable, 2 timeout'].join('\n');
      mockRunShell.mockResolvedValue(makeExecResult(stdout));

      const result = await engine.run('src/math.rs');

      expect(result.killed).toBe(12); // 10 caught + 2 timeout
      expect(result.survived).toBe(4);
      expect(result.totalMutants).toBe(16);
      expect(result.incompetent).toBe(3);
    });

    it('omits the incompetent field when no mutant was unviable', async () => {
      const stdout = '5 mutants tested: 4 caught, 1 missed';
      mockRunShell.mockResolvedValue(makeExecResult(stdout));

      const result = await engine.run('src/math.rs');

      expect(result.killed).toBe(4);
      expect(result.survived).toBe(1);
      expect(Object.keys(result)).not.toContain('incompetent');
    });

    it('accepts the singular "1 mutant tested" line', async () => {
      // cargo-mutants writes "mutant" when there is exactly one. Requiring the
      // plural drops the summary for single-mutant files, which are then scored
      // by line counting instead — a silent 0% when nothing was printed.
      mockRunShell.mockResolvedValue(makeExecResult('1 mutant tested in 2s: 1 caught'));
      const result = await engine.run('src/math.rs');
      expect(result.killed).toBe(1);
      expect(result.totalMutants).toBe(1);
    });

    it('tolerates runs of whitespace inside the summary line', async () => {
      // Column-aligned output pads with several spaces; matching exactly one
      // space would skip the summary entirely.
      mockRunShell.mockResolvedValue(
        makeExecResult('6  mutants   tested in 3s:   4 caught,   2 missed'),
      );
      const result = await engine.run('src/math.rs');
      expect(result.killed).toBe(4);
      expect(result.survived).toBe(2);
    });

    it('tolerates padding between a count and its label', async () => {
      // `(\d+)\s+([a-zA-Z]+)` — cargo aligns columns with several spaces, and
      // matching exactly one would drop every padded bucket from the score.
      mockRunShell.mockResolvedValue(makeExecResult('9 mutants tested: 6  caught, 3   missed'));
      const result = await engine.run('src/math.rs');
      expect(result.killed).toBe(6);
      expect(result.survived).toBe(3);
    });

    it('matches outcome labels by PREFIX, so plural and singular both count', async () => {
      // cargo-mutants writes "1 caught" but "2 missed"; the labels are matched
      // with startsWith so `caught`/`missed`/`unviable`/`timeouts` all land.
      const stdout = '4 mutants tested: 1 caughts, 1 missing, 1 unviables, 1 timeouts';
      mockRunShell.mockResolvedValue(makeExecResult(stdout));

      const result = await engine.run('src/math.rs');

      expect(result.killed).toBe(2); // caught + timeout
      expect(result.survived).toBe(1); // missing → miss*
      expect(result.incompetent).toBe(1);
    });

    it('falls back to line counting when the summary names no known outcome', async () => {
      // A summary line whose labels are all unrecognised must NOT be treated as
      // an authoritative all-zero result — that would report 0 mutants tested.
      const stdout = [
        'MISSED   src/math.rs:42:5  replaced >= with >',
        '3 mutants tested in 9s: 3 wibbled',
      ].join('\n');
      mockRunShell.mockResolvedValue(makeExecResult(stdout));

      const result = await engine.run('src/math.rs');

      expect(result.totalMutants).toBe(1);
      expect(result.survived).toBe(1);
    });

    it('ignores the "Found N mutants to test" line, which is not a summary', async () => {
      // "to test" is not "tested" — treating it as the summary would score the
      // run before any mutant had been exercised.
      const stdout = [
        'Found 9 mutants to test',
        'MISSED   src/math.rs:42:5  replaced >= with >',
      ].join('\n');
      mockRunShell.mockResolvedValue(makeExecResult(stdout));

      const result = await engine.run('src/math.rs');

      expect(result.totalMutants).toBe(1);
      expect(result.survived).toBe(1);
    });
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

  it('parses column-less locations: ":line:" and bare ":line" at EOL (audit L7)', async () => {
    // cargo-mutants sometimes drops the column, emitting ":<line>:" or a bare
    // ":<line>" at end-of-line instead of ":<line>:<col>". The relaxed location
    // regex must still recover the correct line number for both variants.
    const stdout = [
      'MISSED   src/calc.rs:42: replace add -> sub with Default::default()',
      'MISSED   src/calc.rs:88',
    ].join('\n');

    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/calc.rs');

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

  it('runs cargo-mutants through the container session', async () => {
    const executor = {
      kind: 'container' as const,
      workDir: '/sb',
      run: vi.fn().mockResolvedValue(makeExecResult('')),
      runCommand: vi.fn(),
      dispose: vi.fn(),
    };

    await engine.run('src/test.rs', { workDir: '/sb', executor, concurrency: 1 });

    expect(executor.run).toHaveBeenCalledWith(
      'cargo',
      ['mutants', '--file', 'src/test.rs'],
      expect.objectContaining({ cwd: '/sb' }),
    );
    expect(mockRunShell).not.toHaveBeenCalled();
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
    // Mutator is the full parsed description (H2/I4) — the most distinct key for
    // suppression/verify; truncating risks re-collapsing two same-line mutants.
    expect(result.vulnerabilities[0].mutator).toBe('replace == with !=');
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
    expect(result.vulnerabilities[0].mutator).toBe('Rust Mutation Operator');
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
    mockRunShell.mockRejectedValue(new MutationToolStartupError('cargo-mutants', 'not installed'));

    // Verbatim: the message must be re-thrown unchanged, NOT wrapped in the
    // generic "<tool> execution failed: …" prefix that non-startup errors get.
    // Asserting exact equality (not a substring) kills the `instanceof
    // MutationToolStartupError → false` mutant in base.ts toExecFailure, under
    // which the message would become "cargo-mutants execution failed: not installed".
    const err = (await engine.run('src/test.rs').catch((e: unknown) => e)) as Error;
    expect(err.message).toBe('not installed');
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

  it('names the job count in the verbose log only when running in parallel', async () => {
    // The `-j` suffix is what tells an operator reading the log whether the run
    // was serial. Forced always-on it claims "-j 1" on a serial run; forced off
    // it hides the parallelism entirely.
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    const mockVerbose = vi.mocked(isVerbose);

    mockVerbose.mockReturnValue(true);
    mockRunShell.mockResolvedValue(makeExecResult(''));

    await engine.run('src/test.rs', { concurrency: 4 });
    expect(mockLog).toHaveBeenCalledWith('RustEngine: cargo mutants --file "src/test.rs" -j 4');

    mockLog.mockClear();
    await engine.run('src/test.rs', { concurrency: 1 });
    expect(mockLog).toHaveBeenCalledWith('RustEngine: cargo mutants --file "src/test.rs"');

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
    // No description was extracted → `mutated` must stay unset. Kills the
    // `desc`→true ConditionalExpression (line 77) and the `: ''`→junk fallback
    // (line 70), both of which would wrongly populate `mutated`.
    expect(result.vulnerabilities[0].mutated).toBeUndefined();
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

  it('treats whitespace-only stdout as a baseline failure, not a zero-mutant run', async () => {
    // A `!stdout` check passes whitespace-only stdout ("\n") through as truthy,
    // so the text parser runs on output containing no mutants and reports
    // totalMutants: 0 — which surfaces to the user as "no mutable logic"
    // instead of the real cause. `!stdout.trim()` routes it to the baseline
    // diagnosis where it belongs.
    mockRunShell.mockRejectedValue(
      makeExecFailure({
        exit: 1,
        stdout: '\n  \n',
        stderr: 'test result: FAILED. 3 passed; 1 failed',
      }),
    );

    await expect(engine.run('src/test.rs')).rejects.toThrow(/no parseable output/);
    await expect(engine.run('src/test.rs')).rejects.toThrow(/run `cargo test`/);
    await expect(engine.run('src/test.rs')).rejects.toThrow(/1 failed/);
  });

  it('still reports the halt when the failure carries no stderr at all', async () => {
    // `execErr.stderr?.slice(0, 500) ?? ''` — an ExecFailureError built without
    // a stderr field is what a spawn-level failure produces. Without the
    // optional chain the error handler itself throws a TypeError, replacing a
    // clear "run cargo test first" message with an internal crash.
    const failure = new ExecFailureError(
      { stdout: '', stderr: undefined as unknown as string, exit: 1, signal: null },
      'cargo mutants failed',
    );
    mockRunShell.mockRejectedValue(failure);

    await expect(engine.run('src/test.rs')).rejects.toThrow(/no parseable output/);
    await expect(engine.run('src/test.rs')).rejects.toThrow(/run `cargo test`/);
    // The `?? ''` fallback must render as nothing at all — not as placeholder
    // text that reads like real stderr the caller should go looking for.
    await expect(engine.run('src/test.rs')).rejects.toThrow(/stderr: $/);
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
    expect(result.vulnerabilities[0].mutator).toBe('Rust Mutation Operator');
    // Empty description → `mutated` stays unset (kills `m.description`→true, line 124).
    expect(result.vulnerabilities[0].mutated).toBeUndefined();
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

  it('labels a text-parsed survivor with a mutator derived from its description', async () => {
    // H2/I4: the text branch now derives `mutator` from the full parsed
    // description, matching the JSON branch, instead of a constant label.
    mockRunShell.mockResolvedValue(
      makeExecResult('MISSED   src/billing.rs:42:5  replaced >= with >'),
    );
    const result = await engine.run('src/billing.rs');
    expect(result.vulnerabilities[0].mutator).toBe('replaced >= with >');
    expect(result.vulnerabilities[0].description).toBe(
      'Mutation survived at line 42. The Rust test suite did not catch this change.',
    );
  });

  it('gives two different same-line survivors distinct mutator keys (H2/I4)', async () => {
    // Before the fix both of these shared the constant 'Rust Mutation
    // Operator' label, so `keyOf(line, mutator)` collapsed them into one
    // suppression/verify key — suppressing one silently hid the other.
    const stdout = [
      'MISSED   src/billing.rs:50:5  replaced >= with >',
      'MISSED   src/billing.rs:50:9  replaced + with -',
    ].join('\n');
    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/billing.rs');
    expect(result.vulnerabilities).toHaveLength(2);
    expect(result.vulnerabilities[0].line).toBe(50);
    expect(result.vulnerabilities[1].line).toBe(50);
    expect(result.vulnerabilities[0].mutator).toBe('replaced >= with >');
    expect(result.vulnerabilities[1].mutator).toBe('replaced + with -');
    expect(result.vulnerabilities[0].mutator).not.toBe(result.vulnerabilities[1].mutator);
  });

  it('falls back to the default mutator label when no description is parsed', async () => {
    const stdout = 'MISSED   src/file  replaced something';
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/file');
    expect(result.vulnerabilities[0].mutator).toBe('Rust Mutation Operator');
  });

  it('says "line unknown" — not "line 0" — when a MISSED location cannot be parsed', async () => {
    // The location regex needs a ":<line>"; without one the parser falls back to
    // the 0 sentinel. The sentence must not claim a line 0 that does not exist,
    // but the structured `line` stays 0 because suppression/verify key on it.
    mockRunShell.mockResolvedValue(makeExecResult('MISSED   src/file  replace add -> sub'));
    const result = await engine.run('src/main.rs');
    expect(result.vulnerabilities[0].description).toContain('line unknown');
    expect(result.vulnerabilities[0].description).not.toContain('line 0');
    expect(result.vulnerabilities[0].line).toBe(0);
  });

  it('still renders the parsed line in text descriptions', async () => {
    mockRunShell.mockResolvedValue(makeExecResult('MISSED   src/file.rs:42:9: replace add -> sub'));
    const result = await engine.run('src/main.rs');
    expect(result.vulnerabilities[0].description).toContain('line 42');
    expect(result.vulnerabilities[0].line).toBe(42);
  });

  it('passes exactly ["mutants", "--file", <relative path>] to cargo when serial', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(''));
    // Pin concurrency:1 so this assertion is deterministic regardless of the
    // host's CPU count (resolveCargoJobs would otherwise default to -j 2 on
    // machines with >=3 cores).
    await engine.run('src/deeply/nested/module.rs', { workDir: '/tmp/x', concurrency: 1 });
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

  it('A1: text path sets mutated from the cargo-mutants description', async () => {
    const stdout = 'MISSED   src/lib.rs:42:9: replace add -> sub with Default::default()\n';
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/lib.rs');
    const vuln = result.vulnerabilities.find((v) => v.line === 42);
    expect(vuln?.mutated).toBe('replace add -> sub with Default::default()');
    expect(vuln?.original).toBeUndefined();
  });

  it('A1: JSON path sets mutated from the description', async () => {
    const stdout = JSON.stringify({
      summary: { caught: 1, missed: 1, total: 2 },
      mutants: [
        {
          file: 'src/lib.rs',
          line: 7,
          description: 'replace foo -> bar',
          caught: false,
          status: 'MISSED',
        },
        { file: 'src/lib.rs', line: 8, description: 'kept', caught: true, status: 'CAUGHT' },
      ],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/lib.rs');
    const vuln = result.vulnerabilities.find((v) => v.line === 7);
    expect(vuln?.mutated).toBe('replace foo -> bar');
  });

  it('parses a multi-digit column without leaking it into the description', async () => {
    // Column 15 has two digits; a `:\d+`→`:\d` mutant would consume only `1`,
    // leaving `5:` glued to the front of the description.
    const stdout = 'MISSED   src/lib.rs:42:15: replace add -> sub\n';
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/lib.rs');
    const vuln = result.vulnerabilities.find((v) => v.line === 42);
    expect(vuln?.mutated).toBe('replace add -> sub');
  });

  it('trims surrounding whitespace from the text-path description', async () => {
    // Trailing whitespace in the captured group must be stripped (kills the
    // `locMatch[2].trim()`→`locMatch[2]` MethodExpression on line 70).
    const stdout = 'MISSED   src/lib.rs:9:1:   replace x -> y   \n';
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/lib.rs');
    const vuln = result.vulnerabilities.find((v) => v.line === 9);
    expect(vuln?.mutated).toBe('replace x -> y');
  });

  it('truncates a long stderr tail to 500 chars in the no-output failure message', async () => {
    // Kills the `.slice(0, 500)`→(no slice) MethodExpression on line 186.
    const longStderr = 'E'.repeat(600);
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 1, stdout: '', stderr: longStderr }));
    const err = await engine.run('src/test.rs').catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('E'.repeat(500));
    expect((err as Error).message).not.toContain('E'.repeat(501));
  });

  it('truncates a long stderr tail to 500 chars in the verbose log', async () => {
    // Kills the `.slice(0, 500)`→(no slice) MethodExpression on line 192.
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    const mockVerbose = vi.mocked(isVerbose);
    mockVerbose.mockReturnValue(true);
    mockRunShell.mockResolvedValue(makeExecResult('CAUGHT   src/m.rs:1:1  x', 'W'.repeat(600)));

    await engine.run('src/m.rs');

    const stderrLog = mockLog.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('cargo-mutants stderr'));
    expect(stderrLog).toContain('W'.repeat(500));
    expect(stderrLog).not.toContain('W'.repeat(501));
    mockVerbose.mockReturnValue(false);
  });

  // ─── -j concurrency wiring ──────────────────────────────────────────────

  it('passes -j to cargo-mutants when concurrency > 1, omits it when serial', async () => {
    mockRunShell.mockResolvedValue(makeExecResult('MISSED src/x.rs:1:1: x', ''));

    await engine.run('src/x.rs', { concurrency: 4, workDir: '/tmp' });
    expect(mockRunShell.mock.calls[0][1]).toEqual(['mutants', '--file', 'src/x.rs', '-j', '4']);

    mockRunShell.mockClear();
    await engine.run('src/x.rs', { concurrency: 1, workDir: '/tmp' });
    expect(mockRunShell.mock.calls[0][1]).toEqual(['mutants', '--file', 'src/x.rs']);
  });

  // ─── cargo-mutants v27 real-world output (summary line is ground truth) ────
  // Reproduces the exact stdout format of cargo-mutants 27.x, where ONLY MISSED
  // lines are printed and the totals live in the trailing summary line. Before
  // the fix, line-counting reported total=4/killed=0/score=0.00% on a suite that
  // actually kills 42 of 46 viable mutants (~91%).

  const REAL_V27 = [
    'Found 47 mutants to test',
    'ok       Unmutated baseline in 8s build + 0s test',
    ' INFO Auto-set test timeout to 20s',
    'MISSED   src/dfs.rs:27:12: replace > with >= in compute_score in 0s build + 0s test',
    'MISSED   src/dfs.rs:28:24: replace - with / in compute_score in 0s build + 0s test',
    'MISSED   src/dfs.rs:65:33: replace && with || in dfs_has_word in 0s build + 0s test',
    'MISSED   src/dfs.rs:129:33: replace && with || in dfs_best in 0s build + 0s test',
    '47 mutants tested in 30s: 4 missed, 42 caught, 1 unviable',
  ].join('\n');

  it('trusts the v27 summary line for totals (caught mutants are never printed)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(REAL_V27));

    const result = await engine.run('src/dfs.rs');
    // killed = 42 caught, survived = 4 missed, unviable (1) excluded from denom.
    expect(result.totalMutants).toBe(46);
    expect(result.killed).toBe(42);
    expect(result.survived).toBe(4);
    expect(result.mutationScore).toBe('91.30%');
    // Survivor DETAIL still comes from the four MISSED lines.
    expect(result.vulnerabilities).toHaveLength(4);
    expect(result.vulnerabilities.map((v) => v.line)).toEqual([27, 28, 65, 129]);
  });

  it('strips the run-to-run timing suffix from the mutator key', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(REAL_V27));

    const result = await engine.run('src/dfs.rs');
    // The " in 0s build + 0s test" tail must be gone (it varies per run and
    // would otherwise re-key the same mutant every time), but the semantic
    // "... in compute_score" part of the mutation text must be preserved.
    expect(result.vulnerabilities[0].mutator).toBe('replace > with >= in compute_score');
    expect(result.vulnerabilities[0].mutated).toBe('replace > with >= in compute_score');
    expect(result.vulnerabilities[0].mutator).not.toMatch(/build \+/);
  });

  it('strips a timing suffix padded with extra whitespace', async () => {
    // Every separator in the timing pattern is `\s+` so cargo's column padding
    // does not defeat the strip. Tightened to a single space, the suffix stays
    // in the mutator key — and since the durations change every run, the same
    // mutant gets a new identity on each audit, breaking verify and suppression.
    mockRunShell.mockResolvedValue(
      makeExecResult('MISSED   src/x.rs:5:1: replace a with b  in  12.4s  build  +  3s  test'),
    );

    const result = await engine.run('src/x.rs');
    expect(result.vulnerabilities[0].mutator).toBe('replace a with b');
  });

  it('only strips a timing suffix that ends the description', async () => {
    // The `$` anchor. Without it, any description that merely CONTAINS the
    // pattern is truncated mid-sentence and the real mutation text is lost.
    mockRunShell.mockResolvedValue(
      makeExecResult('MISSED   src/x.rs:6:1: replace c with d in 0s build + 0s test cases'),
    );

    const result = await engine.run('src/x.rs');
    expect(result.vulnerabilities[0].mutator).toBe('replace c with d in 0s build + 0s test cases');
  });

  it('counts a summary "timeout" bucket as killed, not survived', async () => {
    const stdout = [
      'MISSED   src/x.rs:5:1: replace a with b in 0s build + 0s test',
      '10 mutants tested in 12s: 1 missed, 7 caught, 2 timeout',
    ].join('\n');
    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/x.rs');
    // killed = 7 caught + 2 timeout = 9, survived = 1 missed, total = 10.
    expect(result.totalMutants).toBe(10);
    expect(result.killed).toBe(9);
    expect(result.survived).toBe(1);
    expect(result.mutationScore).toBe('90.00%');
  });

  it('reports 100% when the summary shows zero missed', async () => {
    const stdout = '20 mutants tested in 40s: 0 missed, 18 caught, 2 unviable';
    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/clean.rs');
    expect(result.totalMutants).toBe(18);
    expect(result.killed).toBe(18);
    expect(result.survived).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
    expect(result.vulnerabilities).toHaveLength(0);
  });

  it('does not mistake the "Found N mutants to test" header for the summary', async () => {
    // "to test" (header) must NOT match; only "tested" (summary) does. If the
    // header were parsed as a summary it would yield 0 caught / 0 missed → a
    // spurious 100% with a live survivor present.
    const stdout = [
      'Found 3 mutants to test',
      'MISSED   src/x.rs:9:1: replace + with - in 0s build + 0s test',
      '3 mutants tested in 5s: 1 missed, 2 caught',
    ].join('\n');
    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/x.rs');
    expect(result.totalMutants).toBe(3);
    expect(result.killed).toBe(2);
    expect(result.survived).toBe(1);
    expect(result.vulnerabilities).toHaveLength(1);
  });

  it('falls back to line-counting when no summary line is present (legacy format)', async () => {
    // Pre-v27 / synthetic output with explicit CAUGHT lines and no summary must
    // still be counted line-by-line so older callers keep working.
    const stdout = [
      'CAUGHT   src/x.rs:1:1  replaced',
      'CAUGHT   src/x.rs:2:1  replaced',
      'MISSED   src/x.rs:3:1  replaced',
    ].join('\n');
    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/x.rs');
    expect(result.totalMutants).toBe(3);
    expect(result.killed).toBe(2);
    expect(result.survived).toBe(1);
  });
});

describe('resolveCargoJobs', () => {
  it('honors an explicit concurrency as-is', () => {
    expect(resolveCargoJobs(4, 8)).toBe(4);
    expect(resolveCargoJobs(1, 8)).toBe(1);
  });
  it('accepts 1 as an explicit request, not as "unset"', () => {
    // Boundary: `concurrency >= 1`. As `> 1` an explicit serial request would be
    // discarded and replaced by the 2-job default on any machine with spare
    // cores — the opposite of what the caller asked for.
    expect(resolveCargoJobs(1, 8)).toBe(1);
  });

  it('ignores a non-integer or out-of-range concurrency and uses the default', () => {
    // Each of these must fail the guard: a fractional job count is meaningless
    // to cargo, and 0 or negative would mean "no jobs at all". Under an
    // `||`-swapped guard, 2.5 satisfies `>= 1` on its own and is passed straight
    // through to `-j 2.5`.
    expect(resolveCargoJobs(2.5, 8)).toBe(2);
    expect(resolveCargoJobs(0, 8)).toBe(2);
    expect(resolveCargoJobs(-3, 8)).toBe(2);
    expect(resolveCargoJobs(Number.NaN, 8)).toBe(2);
    expect(resolveCargoJobs('4' as unknown as number, 8)).toBe(2);
  });

  it('defaults to 2 jobs when the machine has spare cores (cpus >= 3)', () => {
    expect(resolveCargoJobs(undefined, 8)).toBe(2);
    expect(resolveCargoJobs(undefined, 3)).toBe(2);
  });
  it('defaults to serial (1) on low-core machines (cpus < 3)', () => {
    expect(resolveCargoJobs(undefined, 2)).toBe(1);
    expect(resolveCargoJobs(undefined, 1)).toBe(1);
  });
});

describe('JSON output that is missing half the shape', () => {
  let engine: RustEngine;
  beforeEach(() => {
    vi.clearAllMocks();
    engine = new RustEngine();
  });

  it('falls back to text parsing when the JSON has a summary but no mutants', async () => {
    // Both halves are required: the branch reads `parsed.mutants` immediately
    // after. Entering it with only a summary would score the run off numbers
    // whose per-mutant detail never arrived — and with `||` instead of `&&`,
    // dereferencing a missing `mutants` array.
    mockRunShell.mockResolvedValue(
      makeExecResult(JSON.stringify({ summary: { caught: 3, missed: 1, total: 4 } })),
    );

    const result = await engine.run('src/math.rs');

    expect(result.totalMutants).toBe(0);
    expect(result.killed).toBe(0);
  });

  it('falls back to text parsing when the JSON has mutants but no summary', async () => {
    mockRunShell.mockResolvedValue(
      makeExecResult(JSON.stringify({ mutants: [{ status: 'missed', caught: false, line: 7 }] })),
    );

    const result = await engine.run('src/math.rs');

    expect(result.totalMutants).toBe(0);
  });
});

/**
 * The JSON and text parsers must agree, or the same cargo-mutants run is scored
 * differently depending on whether its stdout happened to be JSON. The JSON
 * branch used to take `summary.total` as the denominator (which includes
 * unviable mutants that never compiled, deflating the score against code no
 * test could have exercised) and ignored `timeout` entirely (which the text
 * branch counts as killed, since a mutant that hangs the suite WAS detected).
 */
describe('RustEngine — JSON scoring parity with the text parser', () => {
  let engine: RustEngine;
  beforeEach(() => {
    vi.clearAllMocks();
    engine = new RustEngine();
  });

  it('excludes unviable mutants from the denominator and reports them', async () => {
    const stdout = JSON.stringify({
      summary: { caught: 8, missed: 2, unviable: 5, total: 15 },
      mutants: [{ status: 'missed', line: 3, description: 'replace + with -' }],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.rs');
    // 8 killed / (8 + 2) scored — NOT 8/15.
    expect(result.totalMutants).toBe(10);
    expect(result.mutationScore).toBe('80.00%');
    expect(result.incompetent).toBe(5);
  });

  it('counts timed-out mutants as killed', async () => {
    const stdout = JSON.stringify({
      summary: { caught: 7, missed: 1, timeout: 2 },
      mutants: [{ status: 'missed', line: 3, description: 'replace + with -' }],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.rs');
    expect(result.killed).toBe(9);
    expect(result.totalMutants).toBe(10);
    expect(result.mutationScore).toBe('90.00%');
  });

  it('infers unviable from a total that exceeds the scored mutants', async () => {
    const stdout = JSON.stringify({
      summary: { caught: 4, missed: 1, total: 9 },
      mutants: [{ status: 'missed', line: 3, description: 'x' }],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.rs');
    expect(result.totalMutants).toBe(5);
    expect(result.incompetent).toBe(4);
  });

  it('omits incompetent when every mutant was scored', async () => {
    const stdout = JSON.stringify({
      summary: { caught: 4, missed: 1, total: 5 },
      mutants: [{ status: 'missed', line: 3, description: 'x' }],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.rs');
    expect(result.incompetent).toBeUndefined();
  });

  it('classifies JSON survivors structurally, not by their description text', async () => {
    const stdout = JSON.stringify({
      summary: { caught: 1, missed: 1 },
      mutants: [{ status: 'missed', line: 3, description: 'x' }],
    });
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/main.rs');
    expect(result.vulnerabilities[0].kind).toBe('survived');
  });
});
