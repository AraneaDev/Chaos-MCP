import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the async exec helper (runShell). invokeMutationTool runs for real on top
// of it, so startup-class classification (ENOENT/TIMEOUT/signal) is exercised.
vi.mock('../utils/exec.js', () => ({
  runShell: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  isVerbose: vi.fn(() => false),
}));

// Capture the generated config.toml without touching disk.
vi.mock('node:fs', () => ({ writeFileSync: vi.fn() }));

import { writeFileSync } from 'node:fs';
import { runShell } from '../utils/exec.js';
import { ExecFailureError } from '../utils/exec-error.js';
import { PythonEngine, parseCosmicRayDump, _resetInterpreterCache } from '../engines/python.js';

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
    // Pin the interpreter so the generated test-command is deterministic
    // regardless of whether the host has `python` or only `python3`.
    process.env.CHAOS_MCP_PYTHON = 'python';
    _resetInterpreterCache();
    engine = new PythonEngine();
  });
  afterEach(() => {
    delete process.env.CHAOS_MCP_PYTHON;
    _resetInterpreterCache();
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

  it('surfaces an actionable error when cr-filter-operators fails', async () => {
    // baseline, init succeed; the filter step fails. Covers the onExecFailure
    // callback (line 277-279) that maps the exec failure to a filter-specific
    // message — the happy-path filter test never runs that branch.
    mockRunShell
      .mockResolvedValueOnce(ok()) // baseline
      .mockResolvedValueOnce(ok()) // init
      .mockRejectedValueOnce(fail({ exit: 1, stderr: 'unknown operator' })); // cr-filter-operators
    await expect(
      engine.run('m.py', {
        workDir: '/tmp/sandbox',
        pythonExcludeOperators: ['core/NumberReplacer'],
      }),
    ).rejects.toThrow(/operator filter failed \(exit 1\)/);
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

  it('runs every cosmic-ray phase through the container session', async () => {
    const executor = {
      kind: 'container' as const,
      workDir: '/tmp/sandbox',
      run: vi
        .fn()
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce(ok('')),
      runCommand: vi.fn(),
      dispose: vi.fn(),
    };

    await engine.run('m.py', { workDir: '/tmp/sandbox', executor });

    expect(executor.run).toHaveBeenCalledTimes(4);
    expect(executor.run.mock.calls.map((call) => call[1][0])).toEqual([
      'baseline',
      'init',
      'exec',
      'dump',
    ]);
    expect(mockRunShell).not.toHaveBeenCalled();
  });

  it('throws an install hint when cosmic-ray is not installed (ENOENT)', async () => {
    mockRunShell.mockRejectedValueOnce(fail({ code: 'ENOENT' }));
    await expect(engine.run('m.py', { workDir: '/tmp/sandbox' })).rejects.toThrow(
      /cosmic-ray is not installed.*pipx install cosmic-ray/,
    );
  });

  it('surfaces a broken baseline as a hedged diagnosis (not a meaningless 100%)', async () => {
    mockRunShell.mockRejectedValueOnce(fail({ exit: 1, stderr: 'E   assert 1 == 2' }));
    await expect(engine.run('m.py', { workDir: '/tmp/sandbox' })).rejects.toThrow(
      /baseline failed.*usual cause is a failing or uncollectable test suite/i,
    );
  });

  it('falls back to python3 when `python` is not on PATH', async () => {
    // No env override → real interpreter probe. Empty PATH so the `python` probe
    // cannot resolve on ANY host (GitHub runners ship a `python` symlink), forcing
    // the python3 fallback deterministically rather than relying on host layout.
    delete process.env.CHAOS_MCP_PYTHON;
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    _resetInterpreterCache();
    try {
      queueRun('');
      await engine.run('m.py', { workDir: '/tmp/sandbox' });
      expect(lastConfig()).toContain('test-command = "python3 -m pytest -x -q"');
    } finally {
      process.env.PATH = savedPath;
      _resetInterpreterCache();
    }
  });

  it('prefers a `python` that IS on PATH over the python3 fallback', async () => {
    // The companion to the PATH='' case above, which can only ever prove the
    // fallback. Without a host where `python` resolves, the probe itself is
    // never shown to do anything — so plant a shim and make PATH deterministic.
    // (`node:fs` is module-mocked in this file, so reach for the real one.)
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const realOs = await vi.importActual<typeof import('node:os')>('node:os');
    const realPath = await vi.importActual<typeof import('node:path')>('node:path');

    const binDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chaos-pybin-'));
    // Exits 0 ONLY for `--version`, so the probe's argument list is part of what
    // is being asserted: probing with no arguments (or a blank one) fails here.
    realFs.writeFileSync(
      realPath.join(binDir, 'python'),
      '#!/bin/sh\n[ "$1" = "--version" ] || exit 7\nexit 0\n',
    );
    realFs.chmodSync(realPath.join(binDir, 'python'), 0o755);

    delete process.env.CHAOS_MCP_PYTHON;
    const savedPath = process.env.PATH;
    process.env.PATH = binDir;
    _resetInterpreterCache();
    try {
      queueRun('');
      await engine.run('m.py', { workDir: '/tmp/sandbox' });
      expect(lastConfig()).toContain('test-command = "python -m pytest -x -q"');
    } finally {
      process.env.PATH = savedPath;
      _resetInterpreterCache();
      realFs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('lets the CHAOS_MCP_PYTHON override win over a `python` on PATH', async () => {
    // Precedence: the override is checked BEFORE the probe. Both resolve here,
    // so only the ordering decides which one is used.
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const realOs = await vi.importActual<typeof import('node:os')>('node:os');
    const realPath = await vi.importActual<typeof import('node:path')>('node:path');

    const binDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chaos-pybin-'));
    realFs.writeFileSync(realPath.join(binDir, 'python'), '#!/bin/sh\nexit 0\n');
    realFs.chmodSync(realPath.join(binDir, 'python'), 0o755);

    const savedPath = process.env.PATH;
    process.env.PATH = binDir;
    process.env.CHAOS_MCP_PYTHON = '  /opt/venv/bin/python3.12  ';
    _resetInterpreterCache();
    try {
      queueRun('');
      await engine.run('m.py', { workDir: '/tmp/sandbox' });
      // Also pins the `.trim()`: a value padded by a shell export must not be
      // written into the config with its whitespace.
      expect(lastConfig()).toContain('test-command = "/opt/venv/bin/python3.12 -m pytest -x -q"');
    } finally {
      process.env.PATH = savedPath;
      delete process.env.CHAOS_MCP_PYTHON;
      _resetInterpreterCache();
      realFs.rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('ignores a blank CHAOS_MCP_PYTHON and falls through to the probe', async () => {
    // `override` is truthiness-checked AFTER trimming, so a variable exported as
    // empty (or all spaces) must not become the interpreter name.
    delete process.env.CHAOS_MCP_PYTHON;
    const savedPath = process.env.PATH;
    process.env.PATH = '';
    process.env.CHAOS_MCP_PYTHON = '   ';
    _resetInterpreterCache();
    try {
      queueRun('');
      await engine.run('m.py', { workDir: '/tmp/sandbox' });
      expect(lastConfig()).toContain('test-command = "python3 -m pytest -x -q"');
    } finally {
      process.env.PATH = savedPath;
      delete process.env.CHAOS_MCP_PYTHON;
      _resetInterpreterCache();
    }
  });

  it('fails loudly when every mutant is incompetent (interpreter/test-command broken)', async () => {
    // baseline/init/exec all return exit 0 (cosmic-ray does not catch a missing
    // interpreter), and dump reports two mutants — both 'incompetent'. This must
    // NOT be reported as a clean 100%/total:0 run.
    mockRunShell
      .mockResolvedValueOnce(ok()) // baseline
      .mockResolvedValueOnce(ok()) // init
      .mockResolvedValueOnce(ok()) // exec
      .mockResolvedValueOnce(
        ok(
          [
            dumpLine('core/ReplaceBinaryOperator_Add_Sub', 10, 'incompetent'),
            dumpLine('core/ReplaceComparisonOperator_Eq_GtE', 22, 'incompetent'),
          ].join('\n'),
        ),
      ); // dump
    await expect(engine.run('m.py', { workDir: '/tmp/sandbox' })).rejects.toThrow(
      /ran 2 mutant\(s\).*scored none.*incompetent.*never produced a real pass\/fail/is,
    );
  });

  it('names the resolved test-command in the all-incompetent diagnosis', async () => {
    // "Every mutant was incompetent" almost always means the test-command is
    // wrong. Echoing the resolved command — and saying to run it from the
    // project root — is the whole remediation; without it the caller is told
    // something is broken but not what to look at.
    mockRunShell
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok(dumpLine('core/A', 1, 'incompetent')));

    const message = await engine
      .run('m.py', { workDir: '/tmp/sandbox' })
      .then(() => '')
      .catch((e: Error) => e.message);

    expect(message).toContain('Resolved test-command: "python -m pytest -x -q"');
    expect(message).toContain('Verify it runs the suite from the project root before re-auditing.');
  });

  it('treats a file with zero enumerated mutants as a genuine clean run (no guard)', async () => {
    // Empty dump → no mutants at all (tiny file). This is a legitimate 100%,
    // not a broken run, so the degenerate-run guard must stay silent.
    queueRun('');
    const result = await engine.run('m.py', { workDir: '/tmp/sandbox' });
    expect(result.totalMutants).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
  });

  it('parseCosmicRayDump excludes incompetent mutants and reports the count', () => {
    const dump = [dumpLine('core/A', 1, 'killed'), dumpLine('core/B', 2, 'incompetent')].join('\n');
    const { result: r } = parseCosmicRayDump(dump, 'm.py');
    expect(r.killed).toBe(1);
    expect(r.totalMutants).toBe(1); // incompetent excluded from denominator
    expect(r.incompetent).toBe(1);
  });

  describe('parseCosmicRayDump — diff extraction', () => {
    const survivorWithDiff = (diff: string) => {
      const { result: r } = parseCosmicRayDump(dumpLine('core/Op', 7, 'survived', diff), 'm.py');
      return r.vulnerabilities[0];
    };

    it('takes the FIRST removed and first added line as the change', () => {
      // A real cosmic-ray diff has several context and hunk lines. Only the
      // first -/+ pair is the mutation itself; later ones are surrounding
      // context that would misreport what changed.
      const v = survivorWithDiff(
        ['--- a/m.py', '+++ b/m.py', '-    return a > b', '+    return a >= b'].join('\n'),
      );
      expect(v.original).toBe('return a > b');
      expect(v.mutated).toBe('return a >= b');
    });

    it('keeps the first pair when the diff carries several -/+ lines', () => {
      // `original === undefined` / `mutated === undefined` are what stop a later
      // hunk from overwriting the mutation with unrelated context.
      const v = survivorWithDiff(
        ['-first removed', '+first added', '-second removed', '+second added'].join('\n'),
      );
      expect(v.original).toBe('first removed');
      expect(v.mutated).toBe('first added');
    });

    it('does not mistake the +++ / --- file headers for the change', () => {
      const v = survivorWithDiff(['--- a/m.py', '+++ b/m.py', '-x = 1', '+x = 2'].join('\n'));
      expect(v.original).toBe('x = 1');
      expect(v.mutated).toBe('x = 2');
    });

    it('assigns each side from its own marker, even when + comes first', () => {
      // The two branches are an if/else-if chain over DIFFERENT markers. Under
      // an `||`-swapped guard the leading `+` line is captured as the ORIGINAL,
      // and the report shows the mutation backwards.
      const v = survivorWithDiff(['+added first', '-removed second'].join('\n'));
      expect(v.original).toBe('removed second');
      expect(v.mutated).toBe('added first');
    });

    it('ignores context lines that carry neither marker', () => {
      const v = survivorWithDiff([' context line', '-x = 1', ' more context'].join('\n'));
      expect(v.original).toBe('x = 1');
      expect(Object.keys(v)).not.toContain('mutated');
    });

    it('omits original/mutated entirely when the diff is empty', () => {
      // Not `original: undefined` — the vulnerability is serialised into the
      // report, where an explicit undefined key is a different shape.
      const v = survivorWithDiff('');
      expect(Object.keys(v)).not.toContain('original');
      expect(Object.keys(v)).not.toContain('mutated');
    });
  });

  describe('parseCosmicRayDump — outcome accounting', () => {
    it('counts ONLY the incompetent outcome as incompetent', () => {
      // `outcome === 'incompetent'` inverted would count every killed and
      // survived mutant as uncompilable, emptying the score of meaning.
      const dump = [
        dumpLine('core/A', 1, 'killed'),
        dumpLine('core/B', 2, 'survived'),
        dumpLine('core/C', 3, 'killed'),
      ].join('\n');
      const { result: r } = parseCosmicRayDump(dump, 'm.py');
      expect(r.incompetent).toBe(0);
      expect(r.killed).toBe(2);
      expect(r.survived).toBe(1);
      expect(r.totalMutants).toBe(3);
    });

    it('ignores a pending job (null result) rather than scoring it', () => {
      const pending = JSON.stringify([{ mutations: [] }, null]);
      const dump = [dumpLine('core/A', 1, 'killed'), pending].join('\n');
      const { result: r } = parseCosmicRayDump(dump, 'm.py');
      expect(r.totalMutants).toBe(1);
      expect(r.killed).toBe(1);
    });

    it('does not count a malformed line as a completed mutant', () => {
      // A JSON scalar indexes like an array (`"ab"[1] === 'b'`), so without the
      // Array.isArray guard it passes the null check and inflates the completed
      // count — which the engine reads to tell "no mutants" from "nothing was
      // scorable".
      const { result: r, completed } = parseCosmicRayDump('"ab"\nnot json at all\n[]', 'm.py');
      expect(r.totalMutants).toBe(0);
      expect(completed).toBe(0);
    });

    it('reads the survivor line and operator from the mutation record', () => {
      const { result: r } = parseCosmicRayDump(
        dumpLine('core/ReplaceComparison', 42, 'survived'),
        'm.py',
      );
      expect(r.vulnerabilities[0].line).toBe(42);
      expect(r.vulnerabilities[0].mutator).toBe('core/ReplaceComparison');
      expect(r.vulnerabilities[0].description).toContain('line 42');
    });

    it('survives a null work-item beside a real result', () => {
      // cosmic-ray pairs [WorkItem, WorkResult]; a truncated session DB can
      // yield a null item. Without the optional chain the whole dump parse
      // throws and an otherwise-complete audit is lost.
      const nullItem = JSON.stringify([null, { test_outcome: 'survived' }]);
      const { result: r } = parseCosmicRayDump(nullItem, 'm.py');
      expect(r.survived).toBe(1);
      expect(r.vulnerabilities[0].line).toBe(0);
      expect(r.vulnerabilities[0].mutator).toBe('Mutation');
    });

    it('falls back to line 0 and a generic operator when the record is bare', () => {
      const bare = JSON.stringify([{}, { test_outcome: 'survived' }]);
      const { result: r } = parseCosmicRayDump(bare, 'm.py');
      expect(r.vulnerabilities[0].line).toBe(0);
      expect(r.vulnerabilities[0].mutator).toBe('Mutation');
    });
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

  it('spends ONE shared wall-clock budget across the subcommands, not one each', async () => {
    // A cosmic-ray audit is four sequential CLI calls. Handing each the caller's
    // full timeoutMs would let a single file occupy 4x its budget — which breaks
    // the audit-wide AuditDeadline the handler derives timeoutMs from, and lets
    // one Python file overrun a whole triage sweep. Each call must therefore get
    // the REMAINING budget: bounded by the original, and never increasing.
    queueRun('');
    await engine.run('m.py', { workDir: '/tmp/sandbox', timeoutMs: 120000 });
    const budgets = mockRunShell.mock.calls.map(
      (call) => (call[2] as { timeoutMs: number }).timeoutMs,
    );
    expect(budgets).toHaveLength(4);
    for (const budget of budgets) {
      expect(budget).toBeGreaterThan(0);
      expect(budget).toBeLessThanOrEqual(120000);
    }
    for (let i = 1; i < budgets.length; i++) {
      expect(budgets[i]).toBeLessThanOrEqual(budgets[i - 1]);
    }
    // The whole run fits inside the caller's budget — the sum of a pass-through
    // would be 4x120000.
    expect(budgets[budgets.length - 1]).toBeLessThanOrEqual(budgets[0]);
  });

  it('bails with "audit budget exhausted" once the shared budget runs out', async () => {
    // baseline eats most of the budget; init must not then get a fresh timeout.
    mockRunShell.mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return ok();
    });
    await expect(engine.run('m.py', { workDir: '/tmp/sandbox', timeoutMs: 1100 })).rejects.toThrow(
      /audit budget exhausted/i,
    );
    // Only baseline ran — init was never spawned.
    expect(mockRunShell).toHaveBeenCalledTimes(1);
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

  it('stays quiet when verbose logging is off', async () => {
    // The companion assertion: with the guard forced true the engine writes a
    // diagnostic line on every normal run, and stderr is a protocol channel for
    // a stdio MCP server.
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(false);
    const mockedLog = vi.mocked(log);
    mockedLog.mockClear();
    queueRun('');
    await engine.run('m.py', { workDir: '/tmp/sandbox' });
    expect(mockedLog).not.toHaveBeenCalled();
  });

  it('reports a config-write failure instead of running against a stale config', async () => {
    // If the generated config.toml cannot be written, cosmic-ray would run
    // against whatever was there before (or fail confusingly later). The engine
    // must name the real cause up front.
    mockWriteFileSync.mockImplementationOnce(() => {
      throw new Error('EACCES: permission denied');
    });
    await expect(engine.run('m.py', { workDir: '/tmp/sandbox' })).rejects.toThrow(
      'Failed to write cosmic-ray config: EACCES: permission denied',
    );
  });

  it('falls back to the error message when a baseline failure has empty stderr', async () => {
    // `(e.stderr || e.message)` — cosmic-ray sometimes fails with everything on
    // stdout. Under `&&` the empty stderr wins and the caller gets a bare
    // "Details: " with nothing after it.
    mockRunShell.mockRejectedValueOnce(fail({ exit: 2, stderr: '', stdout: 'boom on stdout' }));
    expect(await rejectionMessage()).toBe(
      'cosmic-ray baseline failed (exit 2) before mutation testing began. ' +
        'The usual cause is a failing or uncollectable test suite; run the suite directly to confirm. ' +
        'Details: Command failed',
    );
  });

  it('truncates a very long baseline stderr rather than echoing all of it', async () => {
    // The message is surfaced to an LLM caller; an unbounded tail of pytest
    // output would swamp the actual diagnosis.
    mockRunShell.mockRejectedValueOnce(fail({ exit: 2, stderr: 'E'.repeat(5000) }));
    await expect(engine.run('m.py', { workDir: '/tmp/sandbox' })).rejects.toThrow(
      /Details: E{500}$/,
    );
  });

  /**
   * Run the engine expecting a rejection and return the reason's message.
   *
   * Deliberately NOT `rejects.toThrow`: that does a substring match and treats
   * a non-Error rejection loosely, so it cannot tell a full 5000-character
   * stderr from a sliced 500-character one, nor a real Error from a callback
   * that returned `undefined`. Both are exactly what these cases pin down.
   */
  async function rejectionMessage(options?: Parameters<typeof engine.run>[1]): Promise<string> {
    try {
      await engine.run('m.py', options ?? { workDir: '/tmp/sandbox' });
    } catch (e) {
      return e instanceof Error ? e.message : `NOT_AN_ERROR: ${String(e)}`;
    }
    throw new Error('expected the run to reject');
  }

  it.each([
    ['init', 1, 'cosmic-ray init failed (exit 2): '],
    ['exec', 2, 'cosmic-ray exec failed (exit 2): '],
    ['dump', 3, 'cosmic-ray dump failed (exit 2): '],
  ])(
    'falls back to the error message when the %s step fails with empty stderr',
    async (_step, failAfter, prefix) => {
      // Each step builds its own `(e.stderr || e.message)` message. Only the
      // baseline one was covered; under `&&` the rest report the prefix with
      // nothing after the colon.
      for (let i = 0; i < failAfter; i++) mockRunShell.mockResolvedValueOnce(ok());
      mockRunShell.mockRejectedValueOnce(fail({ exit: 2, stderr: '' }));

      expect(await rejectionMessage()).toBe(`${prefix}Command failed`);
    },
  );

  it.each([
    ['init', 1, 'cosmic-ray init failed (exit 2): '],
    ['exec', 2, 'cosmic-ray exec failed (exit 2): '],
    ['dump', 3, 'cosmic-ray dump failed (exit 2): '],
  ])('truncates a very long stderr on the %s step', async (_step, okCount, prefix) => {
    // Exact equality, because a substring check is satisfied by the untruncated
    // 5000-character message too — it contains the 500-character one.
    for (let i = 0; i < okCount; i++) mockRunShell.mockResolvedValueOnce(ok());
    mockRunShell.mockRejectedValueOnce(fail({ exit: 2, stderr: 'E'.repeat(5000) }));

    expect(await rejectionMessage()).toBe(`${prefix}${'E'.repeat(500)}`);
  });

  it('truncates and reports the operator-filter step the same way', async () => {
    // The filter step is skipped unless an exclude list is supplied, so it is
    // the one error path none of the cases above can reach.
    mockRunShell.mockResolvedValueOnce(ok()).mockResolvedValueOnce(ok());
    mockRunShell.mockRejectedValueOnce(fail({ exit: 2, stderr: 'E'.repeat(5000) }));

    expect(
      await rejectionMessage({ workDir: '/tmp/sandbox', pythonExcludeOperators: ['core/X'] }),
    ).toBe(`cosmic-ray operator filter failed (exit 2): ${'E'.repeat(500)}`);
  });

  it('generates the config.toml exactly, sections separated and newline-terminated', async () => {
    // TOML is whitespace-sensitive at the section level: without the blank line
    // the `[cosmic-ray.distributor]` header lands on the same logical block, and
    // without the trailing newline some parsers drop the final key.
    // Five steps here: baseline, init, cr-filter-operators, exec, dump.
    mockRunShell
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok(''));
    await engine.run('m.py', {
      workDir: '/tmp/sandbox',
      testRunner: 'pytest',
      pythonExcludeOperators: ['core/ReplaceComparisonOperator'],
    });

    expect(lastConfig()).toBe(
      [
        '[cosmic-ray]',
        'module-path = "m.py"',
        'timeout = 30',
        'test-command = "python -m pytest -x -q"',
        '',
        '[cosmic-ray.distributor]',
        'name = "local"',
        '',
        '[cosmic-ray.filters.operators-filter]',
        'exclude-operators = ["core/ReplaceComparisonOperator"]',
        '',
      ].join('\n'),
    );
  });

  it('omits the operators-filter section entirely when no operators are excluded', async () => {
    queueRun('');
    await engine.run('m.py', { workDir: '/tmp/sandbox', testRunner: 'pytest' });

    expect(lastConfig()).toBe(
      [
        '[cosmic-ray]',
        'module-path = "m.py"',
        'timeout = 30',
        'test-command = "python -m pytest -x -q"',
        '',
        '[cosmic-ray.distributor]',
        'name = "local"',
        '',
      ].join('\n'),
    );
  });

  it('runs with no options object at all', async () => {
    // `run(filePath)` is a valid call: every option is optional. Each `options?.x`
    // is a separate null-guard, and dropping ANY of them turns this into a
    // TypeError before the first subprocess starts.
    queueRun('');
    await expect(engine.run('m.py')).resolves.toMatchObject({ target: 'm.py' });
  });

  describe('operator filter step', () => {
    it('runs cr-filter-operators only when an exclude list is supplied', async () => {
      // Five runShell calls means the filter ran between init and exec.
      mockRunShell
        .mockResolvedValueOnce(ok()) // baseline
        .mockResolvedValueOnce(ok()) // init
        .mockResolvedValueOnce(ok()) // filter
        .mockResolvedValueOnce(ok()) // exec
        .mockResolvedValueOnce(ok('')); // dump

      await engine.run('m.py', {
        workDir: '/tmp/sandbox',
        pythonExcludeOperators: ['core/ReplaceComparisonOperator'],
      });

      expect(mockRunShell).toHaveBeenCalledTimes(5);
      expect(mockRunShell.mock.calls[2][0]).toBe('cr-filter-operators');
    });

    it('skips the filter step for an EMPTY exclude list', async () => {
      // An empty array is truthy, so only the length check stops a pointless
      // extra subprocess — and one that would filter nothing.
      queueRun('');
      await engine.run('m.py', { workDir: '/tmp/sandbox', pythonExcludeOperators: [] });
      expect(mockRunShell).toHaveBeenCalledTimes(4);
    });

    it('skips the filter step when no exclude list is given at all', async () => {
      queueRun('');
      await engine.run('m.py', { workDir: '/tmp/sandbox' });
      expect(mockRunShell).toHaveBeenCalledTimes(4);
    });

    it('reports a filter-step failure with its own message', async () => {
      mockRunShell
        .mockResolvedValueOnce(ok())
        .mockResolvedValueOnce(ok())
        .mockRejectedValueOnce(fail({ exit: 4, stderr: '' }));

      expect(
        await rejectionMessage({ workDir: '/tmp/sandbox', pythonExcludeOperators: ['core/X'] }),
      ).toBe('cosmic-ray operator filter failed (exit 4): Command failed');
    });
  });

  describe('invoke error mapping', () => {
    it('preserves a startup error message verbatim, without the step wrapper', async () => {
      // A missing binary is not a step failure: it must surface the install hint
      // rather than "cosmic-ray init failed (exit null)". The startup branch is
      // checked BEFORE the ExecFailureError one, and both match here.
      mockRunShell.mockResolvedValueOnce(ok()); // baseline
      mockRunShell.mockRejectedValueOnce(fail({ code: 'ENOENT' })); // init

      await expect(engine.run('m.py', { workDir: '/tmp/sandbox' })).rejects.toThrow(
        /cosmic-ray is not installed.*pipx install cosmic-ray/,
      );
    });

    it('passes a non-exec, non-startup Error through unchanged', async () => {
      // Neither instanceof branch applies, so the original error must survive —
      // wrapping it would bury the real cause.
      mockRunShell.mockResolvedValueOnce(ok());
      mockRunShell.mockRejectedValueOnce(new TypeError('something else entirely'));

      await expect(engine.run('m.py', { workDir: '/tmp/sandbox' })).rejects.toThrow(
        'something else entirely',
      );
    });

    it('stringifies a non-Error rejection', async () => {
      mockRunShell.mockResolvedValueOnce(ok());
      mockRunShell.mockRejectedValueOnce('a bare string');

      await expect(engine.run('m.py', { workDir: '/tmp/sandbox' })).rejects.toThrow(
        'cosmic-ray execution failed: a bare string',
      );
    });
  });

  it('falls back to python3 when the `python` on PATH exits non-zero', async () => {
    // A shim that resolves but fails `--version` is a broken or shadowed
    // interpreter. `!probe.error && probe.status === 0` requires BOTH; under
    // `||` a non-zero exit still selects `python`, and every mutant then runs
    // against an interpreter that cannot start.
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const realOs = await vi.importActual<typeof import('node:os')>('node:os');
    const realPath = await vi.importActual<typeof import('node:path')>('node:path');

    const binDir = realFs.mkdtempSync(realPath.join(realOs.tmpdir(), 'chaos-pybad-'));
    realFs.writeFileSync(realPath.join(binDir, 'python'), '#!/bin/sh\nexit 3\n');
    realFs.chmodSync(realPath.join(binDir, 'python'), 0o755);

    delete process.env.CHAOS_MCP_PYTHON;
    const savedPath = process.env.PATH;
    process.env.PATH = binDir;
    _resetInterpreterCache();
    try {
      queueRun('');
      await engine.run('m.py', { workDir: '/tmp/sandbox' });
      expect(lastConfig()).toContain('test-command = "python3 -m pytest -x -q"');
    } finally {
      process.env.PATH = savedPath;
      _resetInterpreterCache();
      realFs.rmSync(binDir, { recursive: true, force: true });
    }
  });
});
