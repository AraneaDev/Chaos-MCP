import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the async exec helper (runShell). invokeMutationTool runs for real on top
// of it, so startup-class classification (ENOENT/TIMEOUT/signal) is exercised.
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

vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  isVerbose: vi.fn().mockReturnValue(false),
}));

// Capture the generated config.toml without touching disk.
vi.mock('node:fs', () => ({ writeFileSync: vi.fn() }));

import { writeFileSync } from 'node:fs';
import { runShell, ExecFailureError } from '../utils/exec.js';
import { PythonEngine } from '../engines/python.js';

const mockRunShell = vi.mocked(runShell);
const mockWriteFileSync = vi.mocked(writeFileSync);

function ok(
  stdout = '',
  stderr = '',
): { stdout: string; stderr: string; exit: number; signal: null } {
  return { stdout, stderr, exit: 0, signal: null };
}

function fail(opts: {
  exit?: number | null;
  signal?: NodeJS.Signals | null;
  code?: string;
  stdout?: string;
  stderr?: string;
}): Error {
  return new ExecFailureError(
    {
      stdout: opts.stdout ?? '',
      stderr: opts.stderr ?? '',
      exit: opts.exit ?? null,
      signal: opts.signal ?? null,
      code: opts.code,
    },
    'Command failed',
  );
}

/** A cosmic-ray dump line ([WorkItem, WorkResult]). */
function dumpLine(operator: string, line: number, outcome: string, diff = ''): string {
  return JSON.stringify([
    {
      job_id: operator,
      mutations: [
        {
          module_path: 'm.py',
          operator_name: operator,
          occurrence: 0,
          start_pos: [line, 1],
          end_pos: [line, 2],
        },
      ],
    },
    { worker_outcome: 'normal', output: '...', test_outcome: outcome, diff },
  ]);
}

const SURVIVED_DIFF = [
  '@@ -73,1 +73,1 @@',
  '-    backoff = base * 2',
  '+    backoff = base - 2',
].join('\n');

/** Queue the 4-call happy-path sequence: baseline, init, exec, dump. */
function queueRun(dump: string): void {
  mockRunShell
    .mockResolvedValueOnce(ok()) // baseline
    .mockResolvedValueOnce(ok()) // init
    .mockResolvedValueOnce(ok()) // exec
    .mockResolvedValueOnce(ok(dump)); // dump
}

/** Last config.toml content written by the engine. */
function lastConfig(): string {
  const calls = mockWriteFileSync.mock.calls;
  return (calls[calls.length - 1]?.[1] as string) ?? '';
}

describe('PythonEngine (cosmic-ray)', () => {
  let engine: PythonEngine;
  beforeEach(() => {
    vi.clearAllMocks();
    engine = new PythonEngine();
  });

  it('runs baseline → init → exec → dump and parses the result', async () => {
    queueRun(
      [
        dumpLine('core/ReplaceBinaryOperator_Sub_Mul', 183, 'killed'),
        dumpLine('core/ReplaceBinaryOperator_Add_Sub', 73, 'survived', SURVIVED_DIFF),
      ].join('\n'),
    );

    const result = await engine.run('m.py', { workDir: '/tmp/sandbox' });

    expect(result.killed).toBe(1);
    expect(result.survived).toBe(1);
    expect(result.totalMutants).toBe(2);
    expect(result.mutationScore).toBe('50.00%');
    expect(result.vulnerabilities[0]).toMatchObject({
      line: 73,
      mutator: 'core/ReplaceBinaryOperator_Add_Sub',
      original: 'backoff = base * 2',
      mutated: 'backoff = base - 2',
    });
    // The four subcommands, in order.
    const subs = mockRunShell.mock.calls.map((c) => (c[1] as string[])[0]);
    expect(subs).toEqual(['baseline', 'init', 'exec', 'dump']);
  });

  it('writes a config.toml scoped to the target file', async () => {
    queueRun('');
    await engine.run('pkg/calc.py', { workDir: '/tmp/sandbox' });
    const cfg = lastConfig();
    expect(cfg).toContain('module-path = "pkg/calc.py"');
    expect(cfg).toContain('test-command = "python -m pytest -x -q"');
    expect(cfg).toContain('name = "local"');
  });

  it('appends pythonTestSelection to the test-command', async () => {
    queueRun('');
    await engine.run('m.py', {
      workDir: '/tmp/sandbox',
      pythonTestSelection: ['tests/unit/test_x.py'],
    });
    expect(lastConfig()).toContain('test-command = "python -m pytest -x -q tests/unit/test_x.py"');
  });

  it('runs cr-filter-operators between init and exec when excludeOperators is set', async () => {
    // 5 calls now: baseline, init, cr-filter-operators, exec, dump.
    mockRunShell
      .mockResolvedValueOnce(ok()) // baseline
      .mockResolvedValueOnce(ok()) // init
      .mockResolvedValueOnce(ok()) // cr-filter-operators
      .mockResolvedValueOnce(ok()) // exec
      .mockResolvedValueOnce(ok('')); // dump
    await engine.run('m.py', {
      workDir: '/tmp/sandbox',
      pythonExcludeOperators: ['core/NumberReplacer'],
    });
    const commands = mockRunShell.mock.calls.map((c) => c[0] as string);
    expect(commands).toEqual([
      'cosmic-ray',
      'cosmic-ray',
      'cr-filter-operators',
      'cosmic-ray',
      'cosmic-ray',
    ]);
    // the filter runs on the session with the config: `cr-filter-operators <session> <config>`
    const filterArgs = mockRunShell.mock.calls[2][1] as string[];
    expect(filterArgs[0]).toMatch(/chaos-cosmic-ray\.sqlite$/);
    expect(filterArgs[1]).toMatch(/chaos-cosmic-ray\.toml$/);
    // the emitted config carries the exclude list for the filter to read
    expect(lastConfig()).toContain('[cosmic-ray.filters.operators-filter]');
  });

  it('does not run a filter step when excludeOperators is absent (4 calls)', async () => {
    queueRun('');
    await engine.run('m.py', { workDir: '/tmp/sandbox' });
    const commands = mockRunShell.mock.calls.map((c) => c[0] as string);
    expect(commands).not.toContain('cr-filter-operators');
    expect(commands).toHaveLength(4);
  });

  it('uses `python -m unittest` when the runner is unittest', async () => {
    queueRun('');
    await engine.run('m.py', { workDir: '/tmp/sandbox', testRunner: 'unittest' });
    expect(lastConfig()).toContain('test-command = "python -m unittest"');
  });

  it('runs each subcommand in the sandbox workDir', async () => {
    queueRun('');
    await engine.run('m.py', { workDir: '/tmp/sandbox' });
    for (const call of mockRunShell.mock.calls) {
      expect(call[2]).toMatchObject({ cwd: '/tmp/sandbox' });
    }
  });

  it('throws an install hint when cosmic-ray is not installed (ENOENT)', async () => {
    mockRunShell.mockRejectedValueOnce(fail({ code: 'ENOENT' }));
    await expect(engine.run('m.py', { workDir: '/tmp/sandbox' })).rejects.toThrow(
      /cosmic-ray is not installed.*pipx install cosmic-ray/,
    );
  });

  it('surfaces a broken baseline as a test-suite failure (not a meaningless 100%)', async () => {
    mockRunShell.mockRejectedValueOnce(fail({ exit: 1, stderr: 'E   assert 1 == 2' }));
    await expect(engine.run('m.py', { workDir: '/tmp/sandbox' })).rejects.toThrow(
      /baseline failed.*test suite fails before mutation/i,
    );
  });

  it('reports an init failure', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok()) // baseline
      .mockRejectedValueOnce(fail({ exit: 1, stderr: 'bad config' })); // init
    await expect(engine.run('m.py', { workDir: '/tmp/sandbox' })).rejects.toThrow(
      /cosmic-ray init failed/,
    );
  });

  it('reports an exec failure', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok()) // baseline
      .mockResolvedValueOnce(ok()) // init
      .mockRejectedValueOnce(fail({ exit: 1, stderr: 'exec boom' })); // exec
    await expect(engine.run('m.py', { workDir: '/tmp/sandbox' })).rejects.toThrow(
      /cosmic-ray exec failed/,
    );
  });

  it('reports a dump failure', async () => {
    mockRunShell
      .mockResolvedValueOnce(ok()) // baseline
      .mockResolvedValueOnce(ok()) // init
      .mockResolvedValueOnce(ok()) // exec
      .mockRejectedValueOnce(fail({ exit: 1, stderr: 'no session' })); // dump
    await expect(engine.run('m.py', { workDir: '/tmp/sandbox' })).rejects.toThrow(
      /cosmic-ray dump failed/,
    );
  });

  it('throws on timeout', async () => {
    mockRunShell.mockRejectedValueOnce(fail({ code: 'TIMEOUT' }));
    await expect(engine.run('m.py', { workDir: '/tmp/sandbox' })).rejects.toThrow(/timed out/);
  });

  it('throws on a signal crash', async () => {
    mockRunShell.mockRejectedValueOnce(fail({ signal: 'SIGSEGV', exit: null, stderr: 'boom' }));
    await expect(engine.run('m.py', { workDir: '/tmp/sandbox' })).rejects.toThrow(
      /crashed.*SIGSEGV/,
    );
  });

  it('passes a custom timeoutMs to each subcommand', async () => {
    queueRun('');
    await engine.run('m.py', { workDir: '/tmp/sandbox', timeoutMs: 120000 });
    for (const call of mockRunShell.mock.calls) {
      expect(call[2]).toMatchObject({ timeoutMs: 120000 });
    }
  });

  it('forwards the abort signal into the subcommands', async () => {
    queueRun('');
    const controller = new AbortController();
    await engine.run('m.py', { workDir: '/tmp/sandbox', signal: controller.signal });
    expect(mockRunShell.mock.calls[0][2]).toMatchObject({ signal: controller.signal });
  });

  it('logs the run in verbose mode', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(true);
    const mockedLog = vi.mocked(log);
    mockedLog.mockClear();
    queueRun('');
    await engine.run('m.py', { workDir: '/tmp/sandbox' });
    expect(mockedLog).toHaveBeenCalledWith(expect.stringContaining('cosmic-ray'));
    vi.mocked(isVerbose).mockReturnValue(false);
  });
});
