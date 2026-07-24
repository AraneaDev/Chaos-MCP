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
  };
});

import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { invokeMutationTool, MutationToolStartupError } from '../utils/exec-classify.js';
import { ExecFailureError } from '../utils/exec.js';
import {
  PhpEngine,
  parseInfectionJsonLog,
  buildInfectionConfig,
  inferSourceDir,
} from '../engines/php.js';

const mockInvoke = vi.mocked(invokeMutationTool);
const mockExists = vi.mocked(existsSync);
const mockWrite = vi.mocked(writeFileSync);
const mockRead = vi.mocked(readFileSync);
const mockMkdir = vi.mocked(mkdirSync);

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

describe('inferSourceDir', () => {
  it('returns the top path segment', () => {
    expect(inferSourceDir('src/Calculator.php')).toBe('src');
    expect(inferSourceDir('app/Service/Math.php')).toBe('app');
  });
  it('returns "." for a bare filename', () => {
    expect(inferSourceDir('Calculator.php')).toBe('.');
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
