import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/exec-classify.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/exec-classify.js')>(
    '../utils/exec-classify.js',
  );
  return { ...actual, invokeMutationTool: vi.fn() };
});
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

import { existsSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';
import { ExecFailureError } from '../utils/exec.js';
import {
  PhpEngine,
  parseInfectionJsonLog,
  buildInfectionConfig,
  inferSourceDir,
  infectionDiagnostics,
  phpunitFailsOnWarning,
} from '../engines/php.js';

const mockInvoke = vi.mocked(invokeMutationTool);
const mockExists = vi.mocked(existsSync);
const mockWrite = vi.mocked(writeFileSync);
const mockRead = vi.mocked(readFileSync);
const mockMkdir = vi.mocked(mkdirSync);
const mockRm = vi.mocked(rmSync);

// A minimal Infection JSON log: 3 killed, 1 timed-out, 1 escaped → killed 4, survived 1.
const SAMPLE_LOG = JSON.stringify({
  stats: { totalMutantsCount: 5, killedCount: 3, escapedCount: 1, timeOutCount: 1 },
  escaped: [
    {
      mutator: {
        mutatorName: 'GreaterThan',
        originalFilePath: 'src/Calculator.php',
        originalStartLine: 12,
      },
      diff: '--- Original\n+++ New\n@@ @@\n- return $a > $b;\n+ return $a >= $b;',
    },
  ],
  killed: [{}, {}, {}],
  timeouted: [{}],
});

beforeEach(() => {
  vi.clearAllMocks();
  mockExists.mockReturnValue(false);
  mockWrite.mockReturnValue(undefined);
});

describe('phpunitFailsOnWarning', () => {
  it('is true when the root element sets failOnWarning="true"', () => {
    expect(phpunitFailsOnWarning('<phpunit failOnWarning="true"></phpunit>')).toBe(true);
  });

  /** Real configs spread attributes over many lines. */
  it('finds the attribute across a multi-line root element', () => {
    const xml = `<?xml version="1.0"?>
<phpunit xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         bootstrap="tests/bootstrap.php"
         failOnRisky="true"
         failOnWarning="true"
         cacheDirectory=".phpunit.cache">
  <testsuites/>
</phpunit>`;
    expect(phpunitFailsOnWarning(xml)).toBe(true);
  });

  it('accepts single-quoted attribute values', () => {
    expect(phpunitFailsOnWarning("<phpunit failOnWarning='true'/>")).toBe(true);
  });

  it('is false when the attribute is absent', () => {
    expect(phpunitFailsOnWarning('<phpunit bootstrap="x.php"><testsuites/></phpunit>')).toBe(false);
  });

  it('is false when the attribute is explicitly false', () => {
    expect(phpunitFailsOnWarning('<phpunit failOnWarning="false"/>')).toBe(false);
  });

  /**
   * The setting is only meaningful on the root element. A comment quoting it —
   * the shape a config carries right after someone reads about this trap — must
   * not be mistaken for the setting itself.
   */
  it('ignores the attribute when it appears only in a comment', () => {
    const xml = `<!-- consider failOnWarning="true" here -->\n<phpunit bootstrap="x.php"/>`;
    expect(phpunitFailsOnWarning(xml)).toBe(false);
  });

  it('is false for a file with no phpunit element at all', () => {
    expect(phpunitFailsOnWarning('<not-phpunit failOnWarning="true"/>')).toBe(false);
  });
});

describe('inferSourceDir', () => {
  it('returns the top path segment', () => {
    expect(inferSourceDir('src/Calculator.php')).toBe('src');
    expect(inferSourceDir('app/Service/Math.php')).toBe('app');
  });
  it('returns "." for a bare filename', () => {
    expect(inferSourceDir('Calculator.php')).toBe('.');
  });
  it('returns "." for a leading-slash path rather than an empty source directory', () => {
    // The `slash > 0` guard, not `>= 0`: a path starting with a separator has
    // its first slash at index 0, and slicing there yields '' — which would be
    // written into the generated config as `source.directories: [""]` and make
    // Infection mutate nothing. Normalized backslashes take the same path.
    expect(inferSourceDir('/Calculator.php')).toBe('.');
    expect(inferSourceDir('\\Calculator.php')).toBe('.');
  });
  it('normalizes backslash separators to forward slashes', () => {
    expect(inferSourceDir('src\\Domain\\Calculator.php')).toBe('src');
  });
});

describe('buildInfectionConfig', () => {
  it('generates minimal phpunit config with the json log path', () => {
    const cfg = JSON.parse(buildInfectionConfig('src', 'chaos-infection-log.json'));
    expect(cfg.source.directories).toEqual(['src']);
    expect(cfg.testFramework).toBe('phpunit');
    expect(cfg.logs.json).toBe('chaos-infection-log.json');
  });
});

describe('parseInfectionJsonLog', () => {
  it('maps escaped→survivors, timed-out→killed, and computes killed/(killed+survived)', () => {
    const r = parseInfectionJsonLog(SAMPLE_LOG, 'src/Calculator.php');
    expect(r.killed).toBe(4); // 3 killed + 1 timed-out
    expect(r.survived).toBe(1);
    expect(r.totalMutants).toBe(5);
    expect(r.mutationScore).toBe('80.00%');
    expect(r.vulnerabilities).toHaveLength(1);
    expect(r.vulnerabilities[0]).toMatchObject({ line: 12, mutator: 'GreaterThan' });
    expect(r.vulnerabilities[0].mutated).toContain('>=');
  });

  it('excludes notCovered/errored from the denominator', () => {
    const log = JSON.stringify({
      stats: { killedCount: 1, escapedCount: 1 },
      escaped: [{ mutator: { mutatorName: 'Plus', originalStartLine: 3 } }],
      killed: [{}],
      notCovered: [{}, {}],
      errored: [{}],
    });
    const r = parseInfectionJsonLog(log, 'src/X.php');
    expect(r.killed).toBe(1);
    expect(r.survived).toBe(1);
    expect(r.totalMutants).toBe(2); // notCovered + errored NOT counted
    expect(r.mutationScore).toBe('50.00%');
  });

  it('returns a clean 100% when there are zero scored mutants', () => {
    const r = parseInfectionJsonLog(JSON.stringify({ stats: {}, escaped: [] }), 'src/X.php');
    expect(r.totalMutants).toBe(0);
    expect(r.mutationScore).toBe('100.00%');
    expect(r.vulnerabilities).toEqual([]);
  });

  it('throws on an unparseable (corrupt) JSON log rather than reporting a false 100%', () => {
    expect(() => parseInfectionJsonLog('not json {{{', 'src/X.php')).toThrow(
      /unparseable JSON log/,
    );
  });

  it('L5: derives survived/totalMutants from escaped.length, not a mismatched stats.escapedCount', () => {
    // stats.escapedCount (5) disagrees with the actual escaped array (1 entry).
    // Before the fix, `survived` would be 5 while `vulnerabilities` only had 1
    // entry — a self-contradictory result (score/survived count not matching
    // the emitted survivor list).
    const log = JSON.stringify({
      stats: { killedCount: 3, escapedCount: 5 },
      escaped: [{ mutator: { mutatorName: 'GreaterThan', originalStartLine: 12 } }],
      killed: [{}, {}, {}],
    });
    const r = parseInfectionJsonLog(log, 'src/Calculator.php');
    expect(r.vulnerabilities).toHaveLength(1);
    expect(r.survived).toBe(r.vulnerabilities.length);
    expect(r.survived).toBe(1);
    expect(r.totalMutants).toBe(4); // 3 killed + 1 survived (consistent with vulnerabilities)
    expect(r.mutationScore).toBe('75.00%');
  });

  it('tolerates an escaped entry with no mutator metadata instead of throwing', () => {
    // The `e.mutator?.` optional chaining and its `?? 0` / default-name
    // fallbacks: an Infection version skew that omits `mutator` must degrade to
    // a placeholder survivor, not crash the whole audit.
    const log = JSON.stringify({
      stats: { killedCount: 1 },
      escaped: [{}],
      killed: [{}],
    });
    const r = parseInfectionJsonLog(log, 'src/X.php');
    expect(r.vulnerabilities).toHaveLength(1);
    expect(r.vulnerabilities[0].line).toBe(0);
    expect(r.vulnerabilities[0].mutator).toBe('PHP Mutation Operator');
    expect(r.vulnerabilities[0].description).toContain('line 0');
  });

  it('trims surrounding whitespace off a survivor diff', () => {
    const log = JSON.stringify({
      stats: { killedCount: 0 },
      escaped: [
        { mutator: { mutatorName: 'Plus', originalStartLine: 4 }, diff: '\n  - $a + $b\n\n' },
      ],
      killed: [],
    });
    const r = parseInfectionJsonLog(log, 'src/X.php');
    expect(r.vulnerabilities[0].mutated).toBe('- $a + $b');
  });

  it('falls back to array lengths when the log carries no stats block', () => {
    // `parsed.stats ?? {}` plus the `?? …length` fallbacks: a log without
    // `stats` must still score, not read every count as undefined.
    const log = JSON.stringify({
      escaped: [{ mutator: { mutatorName: 'Plus', originalStartLine: 1 } }],
      killed: [{}, {}, {}],
      timeouted: [{}],
    });
    const r = parseInfectionJsonLog(log, 'src/X.php');
    expect(r.killed).toBe(4); // 3 killed + 1 timed-out, both from array lengths
    expect(r.survived).toBe(1);
    expect(r.mutationScore).toBe('80.00%');
  });

  it('treats a non-array escaped field as no survivors rather than trusting it', () => {
    const log = JSON.stringify({ stats: { killedCount: 2 }, escaped: null, killed: [{}, {}] });
    const r = parseInfectionJsonLog(log, 'src/X.php');
    expect(r.survived).toBe(0);
    expect(r.vulnerabilities).toEqual([]);
    expect(r.mutationScore).toBe('100.00%');
  });

  it('refuses a log whose mutants all belong to a different file', () => {
    // The sandbox is a copy of the workspace, so a `chaos-infection-log.json`
    // left over from an earlier audit is copied in with it. When Infection then
    // fails to start, that stale log is still on disk and used to be parsed and
    // reported as THIS file's result: auditing GraphReconciler.php returned
    // "100%, 27/27 killed" for 27 mutants that all belonged to
    // CliErrorRenderer.php and were hours old.
    const log = JSON.stringify({
      stats: { killedCount: 1 },
      escaped: [],
      killed: [{ mutator: { mutatorName: 'Plus', originalFilePath: '/sb/src/Other.php' } }],
    });

    expect(() => parseInfectionJsonLog(log, 'src/Calculator.php')).toThrow(/different file/i);
  });

  it('accepts a log whose mutants carry no file path (nothing to contradict)', () => {
    // Provenance is only enforceable when Infection records paths; a log that
    // omits them must still parse rather than becoming an unusable audit.
    const log = JSON.stringify({ stats: { killedCount: 2 }, escaped: [], killed: [{}, {}] });

    expect(parseInfectionJsonLog(log, 'src/Calculator.php').killed).toBe(2);
  });

  it('accepts a log when at least one mutant matches the audited file', () => {
    const log = JSON.stringify({
      stats: { killedCount: 2 },
      escaped: [],
      killed: [
        { mutator: { mutatorName: 'Plus', originalFilePath: '/sb/src/Calculator.php' } },
        { mutator: { mutatorName: 'Minus' } },
      ],
    });

    expect(parseInfectionJsonLog(log, 'src/Calculator.php').killed).toBe(2);
  });

  it('L5: stays identical to the stats-driven count when stats and escaped agree (normal case)', () => {
    const r = parseInfectionJsonLog(SAMPLE_LOG, 'src/Calculator.php');
    // Unchanged behavior versus the pre-fix path: escapedCount (1) already
    // equals escaped.length (1), so survived/totalMutants/score are identical.
    expect(r.survived).toBe(1);
    expect(r.totalMutants).toBe(5);
    expect(r.mutationScore).toBe('80.00%');
  });
});

describe('PhpEngine.run', () => {
  it('generates a config when none exists, filters to the file, and parses the log', async () => {
    // existsSync: no infection.json/.json5, no vendor/bin/infection, but the log IS produced.
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    const result = await engine.run('src/Calculator.php', { workDir: '/sb' });

    // Generated config written (no project config present).
    expect(mockWrite).toHaveBeenCalledWith(
      expect.stringContaining('infection.json'),
      expect.stringContaining('"testFramework"'),
      'utf8',
    );
    // Invoked with --filter scoped to the file. The detailed JSON log is
    // configured via the generated config's `logs.json`, NOT a CLI flag —
    // Infection 0.34+ removed `--logger-json`, so it must never be passed.
    const [, bin, args] = mockInvoke.mock.calls[0];
    expect(bin).toBe('infection'); // no vendor/bin/infection → global fallback
    expect(args).toContain('--filter=src/Calculator.php');
    expect(args.some((a: string) => a.startsWith('--logger-json'))).toBe(false);
    expect(args).toContain('--no-progress');
    expect(args).toContain('--no-interaction');
    expect(result.survived).toBe(1);
  });

  /**
   * The survivors this engine reports are only trustworthy if a killed mutant
   * reliably produces a failing exit code. Under `failOnWarning="false"` it does
   * not, so the result says so rather than letting a caller act on phantoms.
   */
  it('flags survivors when the project does not fail on warnings', async () => {
    mockExists.mockImplementation(
      (p) => String(p).endsWith('chaos-infection-log.json') || String(p).endsWith('phpunit.xml'),
    );
    mockRead.mockImplementation((p) =>
      String(p).endsWith('phpunit.xml')
        ? '<phpunit failOnWarning="false"><testsuites/></phpunit>'
        : SAMPLE_LOG,
    );
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const result = await new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });

    expect(result.survived).toBe(1);
    expect(result.fidelityNote).toContain('failOnWarning');
  });

  it('does not flag survivors when the project already fails on warnings', async () => {
    mockExists.mockImplementation(
      (p) => String(p).endsWith('chaos-infection-log.json') || String(p).endsWith('phpunit.xml'),
    );
    mockRead.mockImplementation((p) =>
      String(p).endsWith('phpunit.xml')
        ? '<phpunit failOnWarning="true"><testsuites/></phpunit>'
        : SAMPLE_LOG,
    );
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const result = await new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });

    expect(result.fidelityNote).toBeUndefined();
  });

  /** No survivor, nothing to doubt — the advisory would be noise. */
  it('does not flag a run with no survivors', async () => {
    const cleanLog = JSON.stringify({
      stats: { totalMutantsCount: 2, killedCount: 2, escapedCount: 0, timeOutCount: 0 },
      escaped: [],
      killed: [{ mutator: { originalFilePath: 'src/Calculator.php' } }, {}],
    });
    mockExists.mockImplementation(
      (p) => String(p).endsWith('chaos-infection-log.json') || String(p).endsWith('phpunit.xml'),
    );
    mockRead.mockImplementation((p) =>
      String(p).endsWith('phpunit.xml')
        ? '<phpunit failOnWarning="false"><testsuites/></phpunit>'
        : cleanLog,
    );
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const result = await new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });

    expect(result.survived).toBe(0);
    expect(result.fidelityNote).toBeUndefined();
  });

  /** A project with no PHPUnit config at all is not evidence of the trap. */
  it('does not flag when no PHPUnit config can be read', async () => {
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const result = await new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });

    expect(result.survived).toBe(1);
    expect(result.fidelityNote).toBeUndefined();
  });

  it('deletes any pre-existing JSON log before running so a stale one cannot be read', async () => {
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    await new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });

    expect(mockRm).toHaveBeenCalledWith(
      expect.stringContaining('chaos-infection-log.json'),
      expect.objectContaining({ force: true }),
    );
    // Removal must precede the run, or it would delete this run's own output.
    expect(mockRm.mock.invocationCallOrder[0]).toBeLessThan(mockInvoke.mock.invocationCallOrder[0]);
  });

  it('reports the Infection failure instead of a stale log left in the sandbox', async () => {
    // Regression: a sandbox copy carries the workspace's old
    // chaos-infection-log.json. Infection's initial test run failed (exit 1),
    // but because a log file "existed" the engine skipped its no-log error path
    // and reported the stale contents as a fresh 100% score.
    let logOnDisk = true; // the stale copy
    mockExists.mockImplementation((p) => {
      const s = String(p);
      if (s.endsWith('chaos-infection-log.json')) return logOnDisk;
      return s.endsWith('phpunit.xml'); // a normal PHPUnit project
    });
    mockRm.mockImplementation(() => {
      logOnDisk = false;
    });
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockRejectedValue(
      new ExecFailureError('Infection failed', 1, null, 'initial test run failed', ''),
    );

    await expect(new PhpEngine().run('src/Calculator.php', { workDir: '/sb' })).rejects.toThrow(
      /without producing a JSON log/,
    );
  });

  it('forwards the container session to Infection execution', async () => {
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });
    const executor = {
      kind: 'container' as const,
      workDir: '/sb',
      run: vi.fn(),
      runCommand: vi.fn(),
      dispose: vi.fn(),
    };

    await new PhpEngine().run('src/Calculator.php', { workDir: '/sb', executor });

    expect(mockInvoke).toHaveBeenCalledWith(
      'Infection',
      'infection',
      expect.any(Array),
      expect.objectContaining({ executor }),
    );
  });

  it('does NOT overwrite an existing project infection.json and prefers vendor/bin/infection', async () => {
    mockExists.mockImplementation((p) => {
      const s = String(p);
      return (
        s.endsWith('infection.json') ||
        s.endsWith('vendor/bin/infection') ||
        s.endsWith('chaos-infection-log.json')
      );
    });
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    await engine.run('src/Calculator.php', { workDir: '/sb' });

    expect(mockWrite).not.toHaveBeenCalled(); // project config respected
    const [, bin] = mockInvoke.mock.calls[0];
    expect(String(bin)).toContain('vendor/bin/infection');
  });

  it('isolates Infection temp files per run via TMPDIR inside the workDir (parallel-collision regression)', async () => {
    // Infection writes to sys_get_temp_dir()/infection — a FIXED shared path.
    // Concurrent runs (parallel triage) collided there and failed with
    // "Cannot declare class ComposerAutoloaderInit… already in use". Each run
    // must get a per-workDir TMPDIR so sys_get_temp_dir() is unique.
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    await engine.run('src/Calculator.php', { workDir: '/sb' });

    // A per-run temp dir under the sandbox workDir is created…
    expect(mockMkdir).toHaveBeenCalledWith('/sb/.chaos-infection-tmp', { recursive: true });
    // …and pointed at via TMPDIR/TMP/TEMP in the Infection invocation's env.
    const invokeEnv = mockInvoke.mock.calls[0][3]?.env as NodeJS.ProcessEnv;
    expect(invokeEnv.TMPDIR).toBe('/sb/.chaos-infection-tmp');
    expect(invokeEnv.TMP).toBe('/sb/.chaos-infection-tmp');
    expect(invokeEnv.TEMP).toBe('/sb/.chaos-infection-tmp');
    // PATH (and the rest of the environment) is preserved so `infection` still resolves.
    expect(invokeEnv.PATH).toBe(process.env.PATH);
  });

  it('parses the log even when Infection exits non-zero (mutants escaped)', async () => {
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        { stdout: '', stderr: 'MSI below threshold', exit: 1, signal: null, code: undefined },
        'nonzero',
      ),
    );

    const engine = new PhpEngine();
    const result = await engine.run('src/Calculator.php', { workDir: '/sb' });
    expect(result.survived).toBe(1);
  });

  it('throws a coverage-driver hint when no JSON log is produced', async () => {
    // A PHPUnit config IS present (so it is not the "unsupported runner" case),
    // but no log file ever appears → the coverage-driver hint.
    mockExists.mockImplementation((p) => String(p).endsWith('phpunit.xml.dist'));
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        {
          stdout: '',
          stderr: 'No code coverage driver found',
          exit: 1,
          signal: null,
          code: undefined,
        },
        'nonzero',
      ),
    );

    const engine = new PhpEngine();
    await expect(engine.run('src/Calculator.php', { workDir: '/sb' })).rejects.toThrow(
      /Xdebug or PCOV/,
    );
  });

  it('reports a missing PHPUnit config (unsupported/custom test runner) rather than the coverage hint', async () => {
    // No project Infection config, no PHPUnit config, and no JSON log: the
    // project uses a different or custom test runner, so Infection can never run.
    // The error must name the real cause, not the generic coverage-driver hint.
    mockExists.mockReturnValue(false);
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        {
          stdout: '',
          stderr: 'The path does not contain any of the requested files: "phpunit.xml", ...',
          exit: 1,
          signal: null,
          code: undefined,
        },
        'nonzero',
      ),
    );

    const engine = new PhpEngine();
    const run = engine.run('src/Calculator.php', { workDir: '/sb' });
    await expect(run).rejects.toThrow(/no PHPUnit configuration found/);
    await expect(run).rejects.not.toThrow(/Xdebug or PCOV/);
  });

  it('names the STDERR-abort cause instead of blaming the suite when PHPUnit exits 143', async () => {
    // Real failure observed auditing a project whose suite passes cleanly:
    // Infection's InitialTestsRunner stops the test process on the first byte
    // written to STDERR, PHPUnit exits 143, and the generic message sends the
    // caller off checking the coverage driver and the suite's health instead.
    mockExists.mockImplementation((p) => String(p).endsWith('phpunit.xml'));
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        {
          stdout:
            '[ERROR] Project tests must be in a passing state before running Infection.\n' +
            'PHPUnit reported an exit code of 143.\n' +
            'STDERR:\nAPP_RUNTIME_ERROR: msg\n',
          stderr: '',
          exit: 1,
          signal: null,
          code: undefined,
        },
        'nonzero',
      ),
    );

    const run = new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });
    await expect(run).rejects.toThrow(/first byte written to STDERR/);
    await expect(run).rejects.not.toThrow(/Xdebug or PCOV/);
  });

  it('diagnoses the startup failure from STDERR too, not only from STDOUT', async () => {
    // The diagnosis input joins both streams (`stdout ?? '' + '\n' + stderr ?? ''`).
    // Mutation testing showed that join was only ever exercised through stdout,
    // so a variant that dropped the stderr half went undetected — yet a wrapper
    // or a differently-configured Infection can put the banner on stderr.
    mockExists.mockImplementation((p) => String(p).endsWith('phpunit.xml'));
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        {
          stdout: '',
          stderr: 'PHPUnit reported an exit code of 143.',
          exit: 1,
          signal: null,
          code: undefined,
        },
        'nonzero',
      ),
    );

    await expect(new PhpEngine().run('src/Calculator.php', { workDir: '/sb' })).rejects.toThrow(
      /first byte written to STDERR/,
    );
  });

  it('keeps the generic guidance when neither known startup failure matches', async () => {
    // The specific-diagnosis branch must not swallow the fallback: an ordinary
    // failing suite still gets the coverage-driver hint.
    mockExists.mockImplementation((p) => String(p).endsWith('phpunit.xml'));
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        {
          stdout: 'FAILURES!\nTests: 10, Assertions: 12, Failures: 1.',
          stderr: '',
          exit: 1,
          signal: null,
          code: undefined,
        },
        'nonzero',
      ),
    );

    const run = new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });
    await expect(run).rejects.toThrow(/Xdebug or PCOV/);
    await expect(run).rejects.not.toThrow(/first byte written to STDERR/);
  });

  it('names the coverage-scope cause when a coverage-target attribute trips stopOnDefect', async () => {
    // `--filter` narrows the generated initial config's <source> to one file,
    // invalidating every #[CoversClass] elsewhere; Infection's own injected
    // stopOnDefect turns that warning into an aborted run.
    mockExists.mockImplementation((p) => String(p).endsWith('phpunit.xml'));
    mockInvoke.mockRejectedValue(
      new ExecFailureError(
        {
          stdout:
            '[ERROR] Project tests must be in a passing state before running Infection.\n' +
            'Class App\\Thing is not a valid target for code coverage\n',
          stderr: '',
          exit: 1,
          signal: null,
          code: undefined,
        },
        'nonzero',
      ),
    );

    const run = new PhpEngine().run('src/Calculator.php', { workDir: '/sb' });
    await expect(run).rejects.toThrow(/coverage-target attributes/);
    await expect(run).rejects.not.toThrow(/Xdebug or PCOV/);
  });

  it('rethrows the install hint when the binary is missing', async () => {
    mockExists.mockReturnValue(false);
    mockInvoke.mockRejectedValue(
      new MutationToolStartupError(
        'Infection',
        'Infection is not installed. Install it with: composer require --dev infection/infection',
      ),
    );

    const engine = new PhpEngine();
    await expect(engine.run('src/Calculator.php', { workDir: '/sb' })).rejects.toThrow(
      /composer require --dev infection\/infection/,
    );
  });

  it('forwards phpTestFrameworkOptions as --test-framework-options', async () => {
    // The framework-options arg is only appended when the caller supplies it;
    // without a test, the whole `if (options?.phpTestFrameworkOptions)` block and
    // its pushed arg go unexercised (line 165-167).
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    await engine.run('src/Calculator.php', {
      workDir: '/sb',
      phpTestFrameworkOptions: '--testsuite=unit',
    });
    const args = mockInvoke.mock.calls[0][2] as string[];
    expect(args).toContain('--test-framework-options=--testsuite=unit');
  });

  it('omits --test-framework-options when phpTestFrameworkOptions is absent', async () => {
    // The negative of the above: no caller option → no arg. Kills the mutant that
    // removes the `if` guard and always pushes the (undefined) option.
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    await engine.run('src/Calculator.php', { workDir: '/sb' });
    const args = mockInvoke.mock.calls[0][2] as string[];
    expect(args.some((a) => a.startsWith('--test-framework-options='))).toBe(false);
  });

  it('throws a coverage-driver hint when the JSON log exists but is unreadable', async () => {
    // Infection succeeds and the log path passes existsSync, but readFileSync
    // throws (permissions / truncation). Covers the readFileSync catch (line
    // 201-205) — distinct from the "no log produced" path above.
    mockExists.mockReturnValue(true);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });
    mockRead.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const engine = new PhpEngine();
    await expect(engine.run('src/Calculator.php', { workDir: '/sb' })).rejects.toThrow(
      /no readable JSON log/,
    );
  });

  it('builds --threads: phpThreads wins, then concurrency, else max', async () => {
    mockExists.mockImplementation((p) => String(p).endsWith('chaos-infection-log.json'));
    mockRead.mockReturnValue(SAMPLE_LOG);
    mockInvoke.mockResolvedValue({ stdout: '', stderr: '', exit: 0, signal: null });

    const engine = new PhpEngine();
    const argsOf = () => mockInvoke.mock.calls[0][2] as string[];

    // phpThreads wins even when concurrency is also set.
    await engine.run('src/Calculator.php', { workDir: '/sb', phpThreads: '3', concurrency: 4 });
    expect(argsOf()).toContain('--threads=3');

    mockInvoke.mockClear();
    await engine.run('src/Calculator.php', { workDir: '/sb', concurrency: 4 });
    expect(argsOf()).toContain('--threads=4');

    mockInvoke.mockClear();
    await engine.run('src/Calculator.php', { workDir: '/sb' });
    expect(argsOf()).toContain('--threads=max');
  });
});

describe('infectionDiagnostics', () => {
  // Regression: Infection reports startup failures on its OWN stdout, not
  // stderr. The engine used to interpolate only `stderr`, so a real failure —
  // e.g. PHPUnit halting on a coverage-scope warning under Infection's
  // stopOnDefect — surfaced as a bare "stderr:" with nothing after it.
  it('surfaces stdout, where Infection writes its error block', () => {
    const out = infectionDiagnostics({
      stdout: '[ERROR] Project tests must be in a passing state before running Infection.',
      stderr: '',
    });
    expect(out).toContain('Infection output (tail)');
    expect(out).toContain('must be in a passing state');
  });

  it('includes both streams when each has content, stdout first', () => {
    const out = infectionDiagnostics({ stdout: 'STDOUT_MARKER', stderr: 'STDERR_MARKER' });
    expect(out).toContain('STDOUT_MARKER');
    expect(out).toContain('STDERR_MARKER');
    expect(out.indexOf('STDOUT_MARKER')).toBeLessThan(out.indexOf('STDERR_MARKER'));
  });

  it('keeps the TAIL of a long stream, where the cause lives', () => {
    // Infection prints a banner and progress dots first; the error block is last.
    const long = `BANNER${'.'.repeat(5000)}THE_ACTUAL_ERROR`;
    const out = infectionDiagnostics({ stdout: long });
    expect(out).toContain('THE_ACTUAL_ERROR');
    expect(out).not.toContain('BANNER');
    expect(out).toContain('…');
  });

  it('reports explicitly when both streams are empty', () => {
    expect(infectionDiagnostics({ stdout: '', stderr: '' })).toBe(
      '(Infection produced no output on stdout or stderr.)',
    );
    expect(infectionDiagnostics({})).toBe('(Infection produced no output on stdout or stderr.)');
  });

  // The next four cases pin behaviour that mutation testing found unprotected:
  // trimEnd-vs-trimStart, the truncation boundary, tail-vs-head slicing, and the
  // blank line between the two sections.
  it('strips only TRAILING whitespace, keeping leading indentation', () => {
    // Infection indents its error block; that indentation is meaningful context.
    const out = infectionDiagnostics({ stdout: '  indented line\ntrailing  \n' });
    expect(out).toContain('\n  indented line');
    expect(out.endsWith('trailing')).toBe(true);
  });

  it('does NOT truncate a stream exactly at the tail limit', () => {
    // DIAGNOSTIC_TAIL_CHARS is 2000; the comparison must be `>`, not `>=`.
    const exact = 'A'.repeat(2000);
    const out = infectionDiagnostics({ stdout: exact });
    expect(out).not.toContain('…');
    expect(out).toContain(exact);
  });

  it('slices from the END, keeping content that a head-slice would drop', () => {
    // Length 2411. A tail slice keeps the last 2000 chars (MID + TAIL); a head
    // slice from index 2000 would keep only ~400 chars and lose MID.
    const stream = `HEAD${'x'.repeat(1500)}MID${'y'.repeat(900)}TAIL`;
    const out = infectionDiagnostics({ stdout: stream });
    expect(out).toContain('MID');
    expect(out).toContain('TAIL');
    expect(out).not.toContain('HEAD');
  });

  it('separates the two sections with a blank line', () => {
    const out = infectionDiagnostics({ stdout: 'OUT', stderr: 'ERR' });
    expect(out).toContain('OUT\n\nstderr (tail):');
  });

  it('ignores a stream that is only whitespace', () => {
    const out = infectionDiagnostics({ stdout: '   \n\n  ', stderr: 'real failure' });
    expect(out).not.toContain('Infection output (tail)');
    expect(out).toContain('stderr (tail)');
  });
});
