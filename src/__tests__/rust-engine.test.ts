import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Mock the async exec helper
vi.mock('../utils/exec.js', () => ({
  runShell: vi.fn(),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  isVerbose: vi.fn(() => false),
  // `warn` is not used by the engine, but format.ts imports it and these tests
  // import format.ts to assert the zero-mutant result's rendering contract at
  // first hand. A factory mock replaces the WHOLE module, so an export it omits
  // is a hard import error in any consumer — hence the extra stub.
  warn: vi.fn(),
}));

import { runShell } from '../utils/exec.js';
import { ExecFailureError } from '../utils/exec-error.js';
import { RustEngine, resolveCargoJobs, escapeCargoFileGlob } from '../engines/rust.js';
import { displayMutationScore, hasNoMutableLogic } from '../core/score-semantics.js';

const mockRunShell = vi.mocked(runShell);

/** Sandbox roots created by {@link makeSandbox}, removed after the suite. */
const sandboxRoots: string[] = [];

/**
 * A throwaway stand-in for the copied workspace a real audit runs against,
 * optionally pre-populated with source files.
 *
 * `RustEngine.run` stats `<workDir>/<filePath>` before scoring, because
 * cargo-mutants prints the identical "Found 0 mutants to test" + exit 0 both
 * when its `--file` glob matched NOTHING (a targeting failure) and when it
 * matched a real file that simply has no mutable logic. Existence is the only
 * signal separating them, so any test that exercises either branch has to say
 * explicitly whether the file is there — relying on `process.cwd()` happening
 * not to contain `src/empty.rs` would make the assertion an accident.
 */
function makeSandbox(files: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'chaos-rust-engine-'));
  sandboxRoots.push(root);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), 'pub const LIMIT: u8 = 3;\n');
  }
  return root;
}

afterAll(() => {
  for (const root of sandboxRoots) rmSync(root, { recursive: true, force: true });
});

// The smallest COMPLETE cargo-mutants run: one mutant, caught, plus the summary
// line the parser requires. Used by the tests that only assert how the tool was
// invoked — empty stdout is now a zero-mutant error (audit Med#4), so it can no
// longer stand in for "don't care".
const MINIMAL_RUN = '1 mutant tested in 1s: 1 caught';

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
      '3 mutants tested in 4s: 3 caught',
    ].join('\n');

    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/math.rs');

    expect(result.target).toBe('src/math.rs');
    expect(result.totalMutants).toBe(3);
    expect(result.killed).toBe(3);
    expect(result.survived).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
    expect(result.vulnerabilities).toHaveLength(0);
    // cargo-mutants has no line-scoping mode, so the report must SAY it
    // enumerated the whole file rather than leaving consumers to infer it from
    // the absence of a scope note. `handler.ts` appends "diffBase scoping is
    // not supported for rust; mutated the whole file" to this very result
    // before the suppression phase runs, and the transitional
    // `scopeKind === undefined && !scopeNote` fallback reads that note as
    // evidence of SCOPING — switching the orphan counter and the
    // no-mutable-logic verdict off on every diffBase run.
    expect(result.scopeKind).toBe('whole-file');
  });

  describe('authoritative "N mutants tested" summary line', () => {
    // cargo-mutants only PRINTS the missed mutants by default, so counting
    // printed lines reports a false 0%. Since v27 it emits a summary line, and
    // that line is the ONLY source of truth for the score — there is no
    // line-counting fallback any more (audit Med#5), which is why every fixture
    // in this file now carries a summary line and the ones that cannot be
    // scored assert an error instead of a number.

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
      // plural drops the summary for single-mutant files, which are then not
      // scorable at all — a perfectly good run rejected as unreadable.
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

    it('refuses to score when the summary names no known outcome', async () => {
      // A summary line whose labels are all unrecognised must NOT be treated as
      // an authoritative all-zero result — that would report 0 mutants tested.
      //
      // UPDATED (audit Med#5): this test used to assert the line-counting
      // fallback (totalMutants 1, survived 1). That fallback is the bogus-0%
      // path the parser's own comments warn about — cargo-mutants prints only
      // MISSED lines, so the printed lines describe the survivors and nothing
      // else, and scoring them reports 0% for a file that may kill everything.
      // A summary we cannot read is now an error, not a number.
      const stdout = [
        'MISSED   src/math.rs:42:5  replaced >= with >',
        '3 mutants tested in 9s: 3 wibbled',
      ].join('\n');
      mockRunShell.mockResolvedValue(makeExecResult(stdout));

      await expect(engine.run('src/math.rs')).rejects.toThrow(/no recognisable summary/);
      await expect(engine.run('src/math.rs')).rejects.toThrow(/cannot score this run/);
    });

    it('reads a summary whose duration contains a colon', async () => {
      // `[^:]*` before the result colon forbade any earlier colon, so a run long
      // enough to be rendered as "1:04" instead of "64s" lost its summary — and
      // a lost summary used to mean a silently wrong score.
      const stdout = [
        'MISSED   src/math.rs:42:5  replaced >= with >',
        '47 mutants tested in 1:04: 4 missed, 42 caught, 1 unviable',
      ].join('\n');
      mockRunShell.mockResolvedValue(makeExecResult(stdout));

      const result = await engine.run('src/math.rs');

      expect(result.killed).toBe(42);
      expect(result.survived).toBe(4);
      expect(result.totalMutants).toBe(46);
      expect(result.incompetent).toBe(1);
    });

    it('ignores the "Found N mutants to test" line, which is not a summary', async () => {
      // "to test" is not "tested" — treating it as the summary would score the
      // run before any mutant had been exercised. With the header correctly
      // ignored this output has no summary at all, so the run is unscorable and
      // must be reported as such (it previously scored 1/1 by line counting).
      const stdout = [
        'Found 9 mutants to test',
        'MISSED   src/math.rs:42:5  replaced >= with >',
      ].join('\n');
      mockRunShell.mockResolvedValue(makeExecResult(stdout));

      await expect(engine.run('src/math.rs')).rejects.toThrow(/no recognisable summary/);
      await expect(engine.run('src/math.rs')).rejects.toThrow(/1 result line\(s\)/);
    });
  });

  it('reports MISSED mutants as vulnerabilities', async () => {
    const stdout = [
      'CAUGHT   src/billing.rs:10:9  replaced > with >=',
      'MISSED   src/billing.rs:42:5  replaced >= with >',
      'MISSED   src/billing.rs:88:1  replaced + with -',
      '3 mutants tested in 6s: 1 caught, 2 missed',
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
      '2 mutants tested in 3s: 2 missed',
    ].join('\n');

    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    const result = await engine.run('src/calc.rs');

    expect(result.vulnerabilities).toHaveLength(2);
    expect(result.vulnerabilities[0].line).toBe(42);
    expect(result.vulnerabilities[1].line).toBe(88);
  });

  it('handles UNCAUGHT status', async () => {
    const stdout = ['UNCAUGHT src/main.rs:15:5  mutated', '1 mutant tested in 2s: 1 missed'].join(
      '\n',
    );

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
      '3 mutants tested in 7s: 1 caught, 1 timeout, 1 missed',
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
    // cargo-mutants text output uses mixed case (`timeout`, `Timeout`), so the
    // parser upper-cases before matching. A `timeout` line is a KILLED mutant,
    // so it must never appear as a survivor.
    const stdout = [
      'CAUGHT   src/math.rs:10:9  replaced > with >=',
      'timeout  src/math.rs:20:5  infinite loop in test',
      'Timeout  src/math.rs:25:5  another hang',
      'MISSED   src/math.rs:30:1  replaced + with -',
      '4 mutants tested in 9s: 1 caught, 2 timeout, 1 missed',
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

  it('refuses to report 100% when cargo-mutants produced no output for a file that is not there', async () => {
    // UPDATED (audit Med#4): this used to assert `100.00%` for zero mutants.
    // formatMutationScore(0, 0) is "100.00%", so an empty run — a `--file` glob
    // that matched nothing, a path outside the workspace, a module the crate
    // root never declares — was reported as a fully covered file. There is no
    // evidence of coverage here at all, so the run is refused.
    //
    // RE-UPDATED (refinement): the refusal is now conditional on the target
    // being absent, so the sandbox is created EMPTY and named in the assertion
    // rather than left to `process.cwd()`. The "file exists" counterpart lives
    // in the "refuses to invent a score" suite below and must NOT throw.
    const workDir = makeSandbox();
    mockRunShell.mockResolvedValue(makeExecResult(''));

    await expect(engine.run('src/empty.rs', { workDir })).rejects.toThrow(/generated no mutants/);
    await expect(engine.run('src/empty.rs', { workDir })).rejects.toThrow(/cargo mutants --list/);
  });

  it('throws when cargo-mutants is not installed (ENOENT)', async () => {
    mockRunShell.mockRejectedValue(makeExecFailure({ code: 'ENOENT' }));

    await expect(engine.run('src/test.rs')).rejects.toThrow(/cargo-mutants is not installed/);
    await expect(engine.run('src/test.rs')).rejects.toThrow(/cargo install/);
  });

  it('parses stdout from non-zero exit', async () => {
    const stdout = ['MISSED   src/calc.rs:22:5  mutated', '1 mutant tested in 2s: 1 missed'].join(
      '\n',
    );
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
    mockRunShell.mockResolvedValue(makeExecResult(MINIMAL_RUN));

    await engine.run('src/test.rs', { workDir: '/tmp/sandbox' });

    expect(mockRunShell).toHaveBeenCalledWith(
      'cargo',
      expect.any(Array),
      expect.objectContaining({ cwd: '/tmp/sandbox' }),
    );
  });

  it('uses custom timeoutMs from RunOptions', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(MINIMAL_RUN));

    await engine.run('src/test.rs', { timeoutMs: 120000 });

    expect(mockRunShell).toHaveBeenCalledWith(
      'cargo',
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 120000 }),
    );
  });

  it('defaults to 5-minute timeout', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(MINIMAL_RUN));

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
      run: vi.fn().mockResolvedValue(makeExecResult(MINIMAL_RUN)),
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

  it('handles text output with leading whitespace and empty lines mixed in', async () => {
    const stdout =
      '\n  MISSED   src/m.rs:5:1  \n\n  CAUGHT   src/m.rs:6:1  \n2 mutants tested in 3s: 1 caught, 1 missed\n';
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/m.rs');
    expect(result.totalMutants).toBe(2);
    expect(result.survived).toBe(1);
    expect(result.vulnerabilities[0].line).toBe(5);
  });

  // ─── Error handling edge cases ──────────────────────────────────────────

  it('throws when cargo-mutants rejects with non-ExecFailureError non-Error', async () => {
    mockRunShell.mockRejectedValue('plain string rejection');

    await expect(engine.run('src/test.rs')).rejects.toThrow(/cargo-mutants execution failed/);
  });

  it('handles ExecFailureError with exit=0 gracefully', async () => {
    const stdout = ['CAUGHT   src/m.rs:1:1  replaced', '1 mutant tested in 1s: 1 caught'].join(
      '\n',
    );
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
    const stdout = ['CAUGHT   main.rs:1:1  replaced', '1 mutant tested in 1s: 1 caught'].join('\n');
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
    mockRunShell.mockResolvedValue(makeExecResult(MINIMAL_RUN));

    await engine.run('src/deeply/nested/module.rs');
    expect(mockRunShell).toHaveBeenCalledWith(
      'cargo',
      expect.arrayContaining(['--file', 'src/deeply/nested/module.rs']),
      expect.any(Object),
    );
  });

  it('passes --file with a backslash path unchanged (Windows separators)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(MINIMAL_RUN));

    await engine.run('src\\win\\mod.rs');
    expect(mockRunShell).toHaveBeenCalledWith(
      'cargo',
      expect.arrayContaining(['--file', 'src\\win\\mod.rs']),
      expect.any(Object),
    );
  });

  it('escapes glob metacharacters in the --file argument (audit Med#4)', async () => {
    // `--file` is a glob. Passed raw, `token[0].rs` is a character class that
    // matches `token0.rs` — verified against real cargo-mutants 27.1.0, which
    // happily listed mutants for the WRONG file. The escaped form selects the
    // literal path.
    mockRunShell.mockResolvedValue(makeExecResult(MINIMAL_RUN));

    await engine.run('src/parser/token[0].rs', { concurrency: 1 });

    expect(mockRunShell).toHaveBeenCalledWith(
      'cargo',
      ['mutants', '--file', 'src/parser/token[[]0[]].rs'],
      expect.any(Object),
    );
  });

  // ─── Verbose logging paths ──────────────────────────────────────────────

  it('logs cargo-mutants invocation in verbose mode', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    const mockVerbose = vi.mocked(isVerbose);

    mockVerbose.mockReturnValue(true);
    mockRunShell.mockResolvedValue(makeExecResult(MINIMAL_RUN));

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
    mockRunShell.mockResolvedValue(makeExecResult(MINIMAL_RUN));

    await engine.run('src/test.rs', { concurrency: 4 });
    expect(mockLog).toHaveBeenCalledWith('RustEngine: cargo mutants --file "src/test.rs" -j 4');

    mockLog.mockClear();
    await engine.run('src/test.rs', { concurrency: 1 });
    expect(mockLog).toHaveBeenCalledWith('RustEngine: cargo mutants --file "src/test.rs"');

    // The log must show the ESCAPED pattern — it is the argument cargo-mutants
    // actually received, and the only form an operator can paste back into a
    // shell and reproduce the run with.
    mockLog.mockClear();
    await engine.run('src/a*b.rs', { concurrency: 1 });
    expect(mockLog).toHaveBeenCalledWith('RustEngine: cargo mutants --file "src/a[*]b.rs"');

    mockVerbose.mockReturnValue(false);
  });

  it('logs cargo-mutants stderr in verbose mode when present', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    const mockVerbose = vi.mocked(isVerbose);

    mockVerbose.mockReturnValue(true);
    mockRunShell.mockResolvedValue(
      makeExecResult(
        'CAUGHT   src/m.rs:1:1  replaced\n1 mutant tested in 1s: 1 caught',
        'compilation warnings',
      ),
    );

    await engine.run('src/m.rs');

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('cargo-mutants stderr'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('compilation warnings'));
    // Reset
    mockVerbose.mockReturnValue(false);
  });

  it('extracts filename from filePath with only filename (no slashes)', async () => {
    const stdout = ['CAUGHT   lib.rs:1:1  replaced', '1 mutant tested in 1s: 1 caught'].join('\n');
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
    const stdout = 'MISSED   src/file  replaced something\n1 mutant tested in 1s: 1 missed';
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

  it('rethrows an ABORTED exec failure untouched so isCancel still sees it', async () => {
    // `invokeMutationTool` goes out of its way to rethrow a cancellation as the
    // raw ExecFailureError (utils/exec-classify.ts) precisely so
    // `code === 'ABORTED'` survives; python.ts guards the same way. A killed
    // child brings back empty stdout, so without the guard the cancel was
    // rewrapped as the phantom baseline diagnosis "cargo-mutants failed (exit
    // null) with no parseable output … run `cargo test`" — and a caller with no
    // request context (`computeCount` in estimate.ts) has nothing else to key on.
    const aborted = makeExecFailure({ code: 'ABORTED', signal: 'SIGKILL', exit: null });
    mockRunShell.mockRejectedValue(aborted);

    const error = await engine.run('src/test.rs').catch((e: unknown) => e);

    expect(error).toBe(aborted);
    expect(error).toBeInstanceOf(ExecFailureError);
    expect((error as ExecFailureError).code).toBe('ABORTED');
    expect((error as Error).message).not.toMatch(/no parseable output/);
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

  // ─── Mutation hardening: summary math + verbose ────────────────────────

  it('does not log when verbose mode is off', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    vi.mocked(isVerbose).mockReturnValue(false);
    mockLog.mockClear();
    mockRunShell.mockResolvedValue(
      makeExecResult('CAUGHT  src/main.rs:1:1\n1 mutant tested in 1s: 1 caught', 'noise'),
    );

    await engine.run('src/main.rs');

    expect(mockLog).not.toHaveBeenCalled();
  });

  it('labels a text-parsed survivor with a mutator derived from its description', async () => {
    // H2/I4: `mutator` is derived from the full parsed description instead of a
    // constant label, so two mutants never collide on one suppression key.
    mockRunShell.mockResolvedValue(
      makeExecResult('MISSED   src/billing.rs:42:5  replaced >= with >\n1 mutant tested: 1 missed'),
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
      '2 mutants tested in 3s: 2 missed',
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
    const stdout = 'MISSED   src/file  replaced something\n1 mutant tested in 1s: 1 missed';
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/file');
    expect(result.vulnerabilities[0].mutator).toBe('Rust Mutation Operator');
  });

  it('says "line unknown" — not "line 0" — when a MISSED location cannot be parsed', async () => {
    // The location regex needs a ":<line>"; without one the parser falls back to
    // the 0 sentinel. The sentence must not claim a line 0 that does not exist,
    // but the structured `line` stays 0 because suppression/verify key on it.
    mockRunShell.mockResolvedValue(
      makeExecResult('MISSED   src/file  replace add -> sub\n1 mutant tested in 1s: 1 missed'),
    );
    const result = await engine.run('src/main.rs');
    expect(result.vulnerabilities[0].description).toContain('line unknown');
    expect(result.vulnerabilities[0].description).not.toContain('line 0');
    expect(result.vulnerabilities[0].line).toBe(0);
  });

  it('still renders the parsed line in text descriptions', async () => {
    mockRunShell.mockResolvedValue(
      makeExecResult('MISSED   src/file.rs:42:9: replace add -> sub\n1 mutant tested: 1 missed'),
    );
    const result = await engine.run('src/main.rs');
    expect(result.vulnerabilities[0].description).toContain('line 42');
    expect(result.vulnerabilities[0].line).toBe(42);
  });

  it('passes exactly ["mutants", "--file", <relative path>] to cargo when serial', async () => {
    mockRunShell.mockResolvedValue(makeExecResult(MINIMAL_RUN));
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

  it('carries the cargo-mutants description as the mutator, and no change halves', async () => {
    // Was "A1: text path sets mutated from the cargo-mutants description", and
    // it asserted the duplication this engine no longer emits: `mutated` held a
    // byte-identical copy of `mutator`. Two things came of that copy. The
    // survivor's `changes` array repeated the `mutators` keys verbatim, and the
    // suppression identity became the one-sided `"→ <description>"` — a string
    // the report rendered WITHOUT its arrow, so the `change` a caller copied out
    // of a report never matched the one on disk and `unsuppress` silently did
    // nothing. cargo-mutants reports no replacement text; mutator-only identity
    // is the honest shape and loses nothing, because the mutator IS the
    // description.
    const stdout =
      'MISSED   src/lib.rs:42:9: replace add -> sub with Default::default()\n1 mutant tested: 1 missed\n';
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/lib.rs');
    const vuln = result.vulnerabilities.find((v) => v.line === 42);
    expect(vuln?.mutator).toBe('replace add -> sub with Default::default()');
    expect(vuln?.mutated).toBeUndefined();
    expect(vuln?.original).toBeUndefined();
  });

  it('parses a multi-digit column without leaking it into the description', async () => {
    // Column 15 has two digits; a `:\d+`→`:\d` mutant would consume only `1`,
    // leaving `5:` glued to the front of the description.
    const stdout = 'MISSED   src/lib.rs:42:15: replace add -> sub\n1 mutant tested: 1 missed\n';
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/lib.rs');
    const vuln = result.vulnerabilities.find((v) => v.line === 42);
    expect(vuln?.mutator).toBe('replace add -> sub');
  });

  it('trims surrounding whitespace from the text-path description', async () => {
    // Trailing whitespace in the captured group must be stripped (kills the
    // `locMatch[2].trim()`→`locMatch[2]` MethodExpression on line 70).
    const stdout = 'MISSED   src/lib.rs:9:1:   replace x -> y   \n1 mutant tested: 1 missed\n';
    mockRunShell.mockResolvedValue(makeExecResult(stdout));
    const result = await engine.run('src/lib.rs');
    const vuln = result.vulnerabilities.find((v) => v.line === 9);
    expect(vuln?.mutator).toBe('replace x -> y');
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
    mockRunShell.mockResolvedValue(
      makeExecResult('CAUGHT   src/m.rs:1:1  x\n1 mutant tested in 1s: 1 caught', 'W'.repeat(600)),
    );

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
    mockRunShell.mockResolvedValue(
      makeExecResult('MISSED src/x.rs:1:1: x\n1 mutant tested in 1s: 1 missed', ''),
    );

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
    expect(result.vulnerabilities[0].mutator).not.toMatch(/build \+/);
  });

  it('strips a timing suffix padded with extra whitespace', async () => {
    // Every separator in the timing pattern is `\s+` so cargo's column padding
    // does not defeat the strip. Tightened to a single space, the suffix stays
    // in the mutator key — and since the durations change every run, the same
    // mutant gets a new identity on each audit, breaking verify and suppression.
    mockRunShell.mockResolvedValue(
      makeExecResult(
        'MISSED   src/x.rs:5:1: replace a with b  in  12.4s  build  +  3s  test\n1 mutant tested: 1 missed',
      ),
    );

    const result = await engine.run('src/x.rs');
    expect(result.vulnerabilities[0].mutator).toBe('replace a with b');
  });

  it('only strips a timing suffix that ends the description', async () => {
    // The `$` anchor. Without it, any description that merely CONTAINS the
    // pattern is truncated mid-sentence and the real mutation text is lost.
    mockRunShell.mockResolvedValue(
      makeExecResult(
        'MISSED   src/x.rs:6:1: replace c with d in 0s build + 0s test cases\n1 mutant tested: 1 missed',
      ),
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

  it('refuses to line-count when no summary line is present (audit Med#5)', async () => {
    // UPDATED: this used to assert the line-counting fallback (3 total, 2
    // killed). Line counting is only ever right when cargo-mutants happens to
    // print the CAUGHT lines too — it does not by default — and the parser
    // cannot tell the two cases apart from the output alone. Since the same
    // fallback silently reports 0% for a well-tested file, it is gone: no
    // summary means no score.
    const stdout = [
      'CAUGHT   src/x.rs:1:1  replaced',
      'CAUGHT   src/x.rs:2:1  replaced',
      'MISSED   src/x.rs:3:1  replaced',
    ].join('\n');
    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    await expect(engine.run('src/x.rs')).rejects.toThrow(/no recognisable summary/);
    await expect(engine.run('src/x.rs')).rejects.toThrow(/3 result line\(s\)/);
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

/**
 * A cargo-mutants run that reports on mutants but whose totals we cannot read is
 * a PARSING failure, and a run that reports no mutants at all for a file that is
 * NOT THERE is a TARGETING failure. Neither may be turned into a score:
 * line-counting reports ~0% for a well-tested file (only MISSED lines are
 * printed), and 0/0 formats as 100.00%.
 *
 * A run that reports no mutants for a file that IS there is neither: it is an
 * ordinary constants file / `mod.rs` barrel / re-export module, and the honest
 * answer is a zero-mutant result rendered as "n/a". Throwing for that shape too
 * would fail `triage_test_coverage`'s CI gate (which fails closed over errored
 * files) on a perfectly healthy repo — the same harm as the false 100%, aimed
 * the other way. Both dispositions are pinned below.
 */
describe('RustEngine — refuses to invent a score', () => {
  let engine: RustEngine;
  beforeEach(() => {
    vi.clearAllMocks();
    engine = new RustEngine();
  });

  it('throws instead of scoring 0% when result lines have no summary (audit Med#5)', async () => {
    // The real shape of the bug: 40 mutants, 38 caught, 2 missed. cargo-mutants
    // prints ONLY the two MISSED lines, so if the summary is lost, line counting
    // yields total 2 / killed 0 / "0.00%" and the gate fails a file that kills
    // 95% of its mutants. The count of printed lines appears in the message so
    // the operator can see how much output did arrive.
    const stdout = [
      'MISSED   src/pay.rs:42:5: replace >= with > in charge in 0s build + 0s test',
      'MISSED   src/pay.rs:88:1: replace + with - in refund in 0s build + 0s test',
    ].join('\n');
    mockRunShell.mockResolvedValue(makeExecResult(stdout));

    await expect(engine.run('src/pay.rs')).rejects.toThrow(/no recognisable summary/);
    await expect(engine.run('src/pay.rs')).rejects.toThrow(/2 result line\(s\)/);
    await expect(engine.run('src/pay.rs')).rejects.toThrow(/cannot score this run/);
  });

  it('throws instead of reporting 100% when cargo-mutants found no mutants for an absent file (audit Med#4)', async () => {
    // Exactly what cargo-mutants 27 prints when `--file` matches nothing: a
    // header, a warning on stderr, and exit 0. No result lines, no summary.
    // formatMutationScore(0, 0) is "100.00%", so the old parser called this a
    // perfectly covered file.
    //
    // The sandbox is empty, which is the true shape of this failure: the glob
    // matched nothing because there is nothing at that path to match.
    const workDir = makeSandbox();
    mockRunShell.mockResolvedValue(makeExecResult('Found 0 mutants to test\n'));

    const run = () => engine.run('src/parser/token[0].rs', { workDir });
    await expect(run()).rejects.toThrow(/generated no mutants/);
    await expect(run()).rejects.toThrow(/will not report that as 100%/);
    // The message must quote the ESCAPED glob, since that is the argument the
    // operator has to reproduce by hand.
    await expect(run()).rejects.toThrow(/src\/parser\/token\[\[\]0\[\]\]\.rs/);
  });

  it('throws when a summary reports every bucket as zero and the file is absent', async () => {
    // A summary that parses but describes nothing is still a zero-mutant run.
    const workDir = makeSandbox();
    mockRunShell.mockResolvedValue(makeExecResult('0 mutants tested in 0s: 0 caught, 0 missed'));

    await expect(engine.run('src/empty.rs', { workDir })).rejects.toThrow(/generated no mutants/);
  });

  it('checks the UNESCAPED path on disk, so a real `[` in a filename is not a false error', async () => {
    // The escaping exists for the glob engine only; to the filesystem a `[` is
    // just a `[`. Probing for the escaped form (`token[[]0[]].rs`) would never
    // find this file and would turn every metacharacter-bearing path into a
    // spurious "generated no mutants" failure — reintroducing Med#4's harm on
    // the other side of the fix.
    const workDir = makeSandbox(['src/parser/token[0].rs']);
    mockRunShell.mockResolvedValue(makeExecResult('Found 0 mutants to test\n'));

    const result = await engine.run('src/parser/token[0].rs', { workDir });
    expect(result.totalMutants).toBe(0);
    expect(displayMutationScore(result)).toBe('n/a');
  });

  it('returns a zero-mutant result — not an error — when the file exists but has no mutable logic', async () => {
    // cargo-mutants prints this for a constants file, a `mod.rs` barrel, or a
    // module of pure `pub use` re-exports just as it does for a glob that
    // matched nothing. The file IS there, so nothing is wrong: no mutant could
    // be generated because there is no logic to mutate. Erroring here would
    // fail triage's CI gate (it fails closed over errored files) on a healthy
    // repo.
    const workDir = makeSandbox(['src/consts.rs']);
    mockRunShell.mockResolvedValue(makeExecResult('Found 0 mutants to test\n'));

    const result = await engine.run('src/consts.rs', { workDir });
    expect(result.target).toBe('src/consts.rs');
    expect(result.totalMutants).toBe(0);
    expect(result.killed).toBe(0);
    expect(result.survived).toBe(0);
    expect(result.vulnerabilities).toHaveLength(0);
    // No `scopeNote`: `hasNoMutableLogic` is `totalMutants === 0 && !scopeNote`,
    // so setting one here would push the result back onto the raw score — and
    // formatMutationScore(0, 0) is "100.00%", the very verdict this whole guard
    // exists to prevent. Asserted through format.ts's own predicate rather than
    // by restating it, so the two cannot drift apart.
    expect(result.scopeNote).toBeUndefined();
    expect(hasNoMutableLogic(result)).toBe(true);
    expect(displayMutationScore(result)).toBe('n/a');
    expect(displayMutationScore(result)).not.toBe('100.00%');
  });

  it('returns a zero-mutant result when an existing file yields an all-zero summary', async () => {
    // The other spelling of the same run: cargo-mutants got as far as printing a
    // summary, and every bucket in it is zero. Both spellings must land on the
    // same disposition, or which one a cargo version happens to emit decides
    // whether the audit errors.
    const workDir = makeSandbox(['src/barrel.rs']);
    mockRunShell.mockResolvedValue(makeExecResult('0 mutants tested in 0s: 0 caught, 0 missed'));

    const result = await engine.run('src/barrel.rs', { workDir });
    expect(result.totalMutants).toBe(0);
    expect(hasNoMutableLogic(result)).toBe(true);
    expect(displayMutationScore(result)).toBe('n/a');
  });

  it('still refuses an unreadable summary even when the file exists', async () => {
    // Decision-point ordering: file existence only ever excuses a run that
    // reported NOTHING. This run printed result lines, so cargo-mutants
    // demonstrably found the file — the problem is that its totals cannot be
    // read, and scoring the printed lines would report 0.00% for a file that may
    // kill every mutant. Existence must not soften that into a score.
    const workDir = makeSandbox(['src/pay.rs']);
    mockRunShell.mockResolvedValue(
      makeExecResult('MISSED   src/pay.rs:42:5: replace >= with > in charge'),
    );

    await expect(engine.run('src/pay.rs', { workDir })).rejects.toThrow(/no recognisable summary/);
    await expect(engine.run('src/pay.rs', { workDir })).rejects.toThrow(/1 result line\(s\)/);
  });

  it('does NOT throw when mutants were generated but none of them compiled', async () => {
    // Unviable mutants were generated for the file, so `--file` did find it —
    // a different situation from "no mutants at all". Nothing was scored, so the
    // score is the 0/0 convention, but `incompetent` states why on the result.
    //
    // Pinned against an EMPTY sandbox on purpose: this exception predates the
    // existence check and does not depend on it. cargo-mutants having generated
    // mutants is itself proof that `--file` matched, which is a stronger signal
    // than any stat we could take, so the unviable-only run must survive even
    // when the host-side probe comes back negative.
    const workDir = makeSandbox();
    mockRunShell.mockResolvedValue(makeExecResult('5 mutants tested in 9s: 5 unviable'));

    const result = await engine.run('src/macros.rs', { workDir });
    expect(result.totalMutants).toBe(0);
    expect(result.incompetent).toBe(5);
    expect(result.mutationScore).toBe('100.00%');
  });
});

/**
 * `--file` takes a GLOB, not a literal path. Verified against cargo-mutants
 * 27.1.0: with `src/token[0].rs` passed unescaped, cargo-mutants listed mutants
 * for `src/token0.rs` — a different file — and `src/does{not}exist.rs` matched
 * nothing at all while still exiting 0.
 */
describe('escapeCargoFileGlob', () => {
  it('wraps every glob metacharacter in a single-character class', () => {
    expect(escapeCargoFileGlob('src/parser/token[0].rs')).toBe('src/parser/token[[]0[]].rs');
    expect(escapeCargoFileGlob('src/a*b.rs')).toBe('src/a[*]b.rs');
    expect(escapeCargoFileGlob('src/q?.rs')).toBe('src/q[?].rs');
    expect(escapeCargoFileGlob('src/br{ace}.rs')).toBe('src/br[{]ace[}].rs');
  });

  it('escapes EVERY occurrence, not just the first', () => {
    // A non-global replace leaves the second `*` live, and one surviving
    // metacharacter is enough to match the wrong file (or none).
    expect(escapeCargoFileGlob('a*b*c.rs')).toBe('a[*]b[*]c.rs');
  });

  it('leaves ordinary paths byte-for-byte identical', () => {
    // Every real-world path goes through this function; a needless rewrite here
    // would break the common case to fix the rare one.
    expect(escapeCargoFileGlob('src/deeply/nested/module.rs')).toBe('src/deeply/nested/module.rs');
    expect(escapeCargoFileGlob('src/mod-1_2.rs')).toBe('src/mod-1_2.rs');
  });

  it('leaves `!` and `\\` alone, deliberately', () => {
    // `!` is only special right after a `[`, and every `[` we emit is escaped —
    // and `[!]` would be an UNTERMINATED class, i.e. worse than the disease.
    // A backslash is the Windows path separator and must arrive intact.
    expect(escapeCargoFileGlob('src/bang!.rs')).toBe('src/bang!.rs');
    expect(escapeCargoFileGlob('src\\win\\mod.rs')).toBe('src\\win\\mod.rs');
  });
});
