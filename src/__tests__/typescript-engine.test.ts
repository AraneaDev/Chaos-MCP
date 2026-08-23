import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the async exec helper
vi.mock('../utils/exec.js', () => ({
  runShell: vi.fn(),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  isVerbose: vi.fn(() => false),
}));

// Mock fs for report parsing and config-file writes (StrykerJS v9)
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  rmSync: vi.fn(),
}));

import { runShell } from '../utils/exec.js';
import { ExecFailureError } from '../utils/exec-error.js';
import { MutationToolStartupError } from '../utils/exec-classify.js';
import { warn } from '../utils/logger.js';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import type { PathLike, PathOrFileDescriptor } from 'fs';
import {
  TypeScriptEngine,
  StrykerTimeoutError,
  buildStrykerArgs,
  classifyStrykerFailure,
  dryRunResult,
  mergeBatchResults,
  planLineBatches,
  prepareStrykerConfig,
  writeStrykerRuntimeConfig,
} from '../engines/typescript.js';

const mockRunShell = vi.mocked(runShell);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);

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

function makeJsonReport(mutants: { status: string; mutatorName: string; line: number }[]) {
  return JSON.stringify({
    files: {
      'src/test.ts': {
        source: 'const x = 1;',
        mutants: mutants.map((m, i) => ({
          id: String(i + 1),
          mutatorName: m.mutatorName,
          replacement: '',
          location: {
            start: { line: m.line, column: 0 },
            end: { line: m.line, column: 10 },
          },
          status: m.status,
        })),
      },
    },
  });
}

describe('TypeScriptEngine', () => {
  let engine: TypeScriptEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new TypeScriptEngine();
    mockExistsSync.mockReturnValue(true);
  });

  it('plans bounded line batches only for large or explicitly ranged scopes', () => {
    expect(planLineBatches(0)).toEqual([]);
    expect(planLineBatches(120)).toEqual([]);
    expect(planLineBatches(121)).toEqual([
      { start: 1, end: 80 },
      { start: 81, end: 121 },
    ]);
    expect(planLineBatches(500, [])).toEqual([
      { start: 1, end: 80 },
      { start: 81, end: 160 },
      { start: 161, end: 240 },
      { start: 241, end: 320 },
      { start: 321, end: 400 },
      { start: 401, end: 480 },
      { start: 481, end: 500 },
    ]);
    expect(planLineBatches(500, [{ start: 9, end: 88 }])).toEqual([]);
    expect(planLineBatches(500, [{ start: 9, end: 89 }])).toEqual([
      { start: 9, end: 88 },
      { start: 89, end: 89 },
    ]);
    expect(planLineBatches(500, [{ start: 75, end: 170 }])).toEqual([
      { start: 75, end: 154 },
      { start: 155, end: 170 },
    ]);
  });

  it('merges completed batch metrics without losing partial-result metadata', () => {
    const result = mergeBatchResults(
      'src/app.ts',
      [
        {
          target: 'src/app.ts',
          totalMutants: 3,
          killed: 2,
          survived: 1,
          incompetent: 2,
          mutationScore: '66.67%',
          vulnerabilities: [
            {
              line: 2,
              mutator: 'BooleanLiteral',
              description: 'Survived boolean literal mutation',
            },
          ],
        },
        {
          target: 'src/app.ts',
          totalMutants: 1,
          killed: 1,
          survived: 0,
          mutationScore: '100.00%',
          vulnerabilities: [],
        },
      ],
      3,
      false,
    );

    expect(result).toEqual({
      target: 'src/app.ts',
      totalMutants: 4,
      killed: 3,
      survived: 1,
      mutationScore: '75.00%',
      vulnerabilities: [
        { line: 2, mutator: 'BooleanLiteral', description: 'Survived boolean literal mutation' },
      ],
      incompetent: 2,
      complete: false,
      batchesCompleted: 2,
      batchesPlanned: 3,
      stoppedReason: 'time_budget_exhausted',
      scopeKind: 'whole-file',
      scopeNote:
        'Partial audit: completed 2 of 3 bounded mutation batches before the time budget was exhausted.',
    });
  });

  it('merges empty and fully completed batches exactly', () => {
    expect(mergeBatchResults('src/empty.ts', [], 0, true)).toEqual({
      target: 'src/empty.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
      incompetent: undefined,
      complete: true,
      batchesCompleted: 0,
      batchesPlanned: 0,
      stoppedReason: undefined,
      scopeKind: 'whole-file',
      scopeNote: 'Completed 0 bounded mutation batches.',
    });
  });

  // `hasNoMutableLogic` (score-semantics.ts) must key on a STRUCTURAL field, not on the
  // presence of the free-text scopeNote every batched run emits. scopeKind is
  // that field: it says whether the batches spanned the whole file or only the
  // caller's ranges, and it must be carried verbatim, never inferred from prose.
  it('carries scopeKind through the merge, defaulting to whole-file', () => {
    expect(mergeBatchResults('src/a.ts', [], 0, true).scopeKind).toBe('whole-file');
    expect(mergeBatchResults('src/a.ts', [], 0, true, 'scoped').scopeKind).toBe('scoped');
    expect(mergeBatchResults('src/a.ts', [], 0, true, 'whole-file').scopeKind).toBe('whole-file');
  });

  it('builds command-runner overlays for JSON, invalid, and absent project configs', () => {
    const mockWrite = vi.mocked(writeFileSync);

    mockExistsSync.mockImplementation((p: PathLike) => p === '/json/stryker.config.json');
    mockReadFileSync.mockReturnValueOnce(
      JSON.stringify({ commandRunner: { timeout: 5 }, mutator: { excludedMutations: ['A'] } }),
    );
    expect(writeStrykerRuntimeConfig('/json', 'npm test', ['B'])).toBe(
      '.chaos-mcp.stryker.config.mjs',
    );
    expect(String(mockWrite.mock.calls.at(-1)?.[1])).toContain(
      'const base = {"commandRunner":{"timeout":5},"mutator":{"excludedMutations":["A"]}};',
    );

    mockExistsSync.mockImplementation((p: PathLike) => p === '/invalid/stryker.config.json');
    mockReadFileSync.mockReturnValueOnce('{');
    writeStrykerRuntimeConfig('/invalid', 'npm test', []);
    expect(String(mockWrite.mock.calls.at(-1)?.[1])).toContain('const base = {};');

    mockExistsSync.mockReturnValue(false);
    writeStrykerRuntimeConfig('/none', 'npm test', []);
    const absentSource = String(mockWrite.mock.calls.at(-1)?.[1]);
    expect(absentSource).toContain(
      'commandRunner: { ...(base.commandRunner ?? {}), command: "npm test" }',
    );
    expect(absentSource).not.toContain('import importedConfig');
    expect(mockWrite.mock.calls.at(-1)?.[2]).toBe('utf-8');
  });

  it.each([
    ['null', 'null'],
    ['array', '[]'],
    ['string', '"bad"'],
  ])('rejects a parsed %s JSON config as an overlay base', (_label, json) => {
    const mockWrite = vi.mocked(writeFileSync);
    mockExistsSync.mockImplementation((p: PathLike) => p === '/bad/stryker.config.json');
    mockReadFileSync.mockReturnValueOnce(json);
    writeStrykerRuntimeConfig('/bad', 'npm test', []);
    expect(String(mockWrite.mock.calls.at(-1)?.[1])).toContain('const base = {};');
  });

  it('imports an existing JavaScript config with the exact fallback declaration', () => {
    const mockWrite = vi.mocked(writeFileSync);
    mockExistsSync.mockImplementation((p: PathLike) => p === '/js/stryker.config.mjs');
    writeStrykerRuntimeConfig('/js', 'npm test', []);
    expect(String(mockWrite.mock.calls.at(-1)?.[1])).toContain(
      'import importedConfig from "./stryker.config.mjs";\nconst base = importedConfig ?? {};',
    );
  });

  it('returns completed command-runner batches as an explicit partial result', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      p === '/sb/src/large.ts'
        ? Array.from({ length: 200 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([]),
    );
    mockExistsSync.mockReturnValue(true);
    mockRunShell
      .mockResolvedValueOnce(makeExecResult())
      .mockRejectedValueOnce(makeExecFailure({ code: 'TIMEOUT' }))
      .mockResolvedValueOnce(makeExecResult());

    const result = await engine.run('src/large.ts', {
      workDir: '/sb',
      testRunner: 'command',
      // 45s affords floor(45000 / 15000) = 3 startups, which is what this test
      // needs to keep its 3-batch, 80-line-wide plan under the new floor.
      timeoutMs: 45_000,
    });

    expect(mockRunShell).toHaveBeenCalledTimes(3);
    expect(result.complete).toBe(false);
    expect(result.batchesCompleted).toBe(2);
    expect(result.batchesPlanned).toBe(3);
    expect(result.stoppedReason).toBe('time_budget_exhausted');
    expect(result.scopeNote).toContain('completed 2 of 3');
    const calls = mockRunShell.mock.calls;
    expect(calls.map((call) => mutateValueOf(call[1] as string[]))).toEqual([
      'src/large.ts:1-80',
      'src/large.ts:81-160',
      'src/large.ts:161-200',
    ]);
    expect(calls.map((call) => (call[2] as { timeoutMs: number }).timeoutMs)).toEqual([
      15_000, 22_500, 45_000,
    ]);
    now.mockRestore();
  });

  it('runs every planned batch when the clock ticks between the deadline and the first read', async () => {
    // `planLineBatches` certifies `floor(45000 / 15000) = 3` batches against the
    // FULL budget, while the loop used to fund batch 0 with the AVERAGE share of
    // what remains. Those agree only at zero elapsed time, so a single
    // millisecond dropped the share to 14999, broke the loop on batch 0 and
    // ended a fully funded run in "Time budget exhausted ... 0 of 3".
    let stamped = false;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => {
      if (stamped) return 1;
      stamped = true;
      return 0;
    });
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      p === '/sb/src/large.ts'
        ? Array.from({ length: 200 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([]),
    );
    mockExistsSync.mockReturnValue(true);
    mockRunShell.mockResolvedValue(makeExecResult());

    const result = await engine.run('src/large.ts', {
      workDir: '/sb',
      testRunner: 'command',
      timeoutMs: 45_000,
    });

    expect(mockRunShell).toHaveBeenCalledTimes(3);
    expect(result.complete).toBe(true);
    expect(result.batchesCompleted).toBe(3);
    expect(result.batchesPlanned).toBe(3);
    // Batch 0 is floored at one whole start-up rather than the 14999 average.
    expect(
      mockRunShell.mock.calls.map((call) => (call[2] as { timeoutMs: number }).timeoutMs),
    ).toEqual([15_000, 22_499, 44_999]);
    now.mockRestore();
  });

  it('marks a fully completed batch run complete and aggregates its reports', async () => {
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      p === '/sb/src/large.ts'
        ? Array.from({ length: 121 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([{ status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 }]),
    );
    mockRunShell.mockResolvedValue(makeExecResult());

    const result = await engine.run('src/large.ts', {
      workDir: '/sb',
      testRunner: 'command',
      timeoutMs: 30_000,
    });

    expect(mockRunShell).toHaveBeenCalledTimes(2);
    expect(result.complete).toBe(true);
    expect(result.batchesCompleted).toBe(2);
    expect(result.batchesPlanned).toBe(2);
    expect(result.totalMutants).toBe(2);
    expect(result.killed).toBe(2);
    expect(result.scopeNote).toBe('Completed 2 bounded mutation batches.');
  });

  it('throws when every bounded batch times out', async () => {
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      p === '/sb/src/large.ts'
        ? Array.from({ length: 121 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([]),
    );
    mockRunShell.mockRejectedValue(makeExecFailure({ code: 'TIMEOUT' }));

    await expect(
      engine.run('src/large.ts', {
        workDir: '/sb',
        testRunner: 'command',
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/timed out/);
  });

  it('does not swallow a non-timeout failure from a bounded batch', async () => {
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      p === '/sb/src/large.ts'
        ? Array.from({ length: 121 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([]),
    );
    mockRunShell.mockRejectedValue(new Error('batch exploded'));

    await expect(
      engine.run('src/large.ts', {
        workDir: '/sb',
        testRunner: 'command',
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow('batch exploded');
  });

  it('stops immediately on a non-timeout failure even if a later batch could pass', async () => {
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      p === '/sb/src/large.ts'
        ? Array.from({ length: 121 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([]),
    );
    mockRunShell
      .mockRejectedValueOnce(new Error('configuration exploded'))
      .mockResolvedValueOnce(makeExecResult());

    await expect(
      engine.run('src/large.ts', {
        workDir: '/sb',
        testRunner: 'command',
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow('configuration exploded');
    expect(mockRunShell).toHaveBeenCalledTimes(1);
  });

  // ─── Batch-timeout classification is STRUCTURAL, not prose-based ─────────

  it('swallows a genuine batch timeout and keeps running later batches', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      p === '/sb/src/large.ts'
        ? Array.from({ length: 121 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([{ status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 }]),
    );
    mockRunShell
      .mockRejectedValueOnce(makeExecFailure({ code: 'TIMEOUT' }))
      .mockResolvedValueOnce(makeExecResult());

    const result = await engine.run('src/large.ts', {
      workDir: '/sb',
      testRunner: 'command',
      timeoutMs: 30_000,
    });

    expect(mockRunShell).toHaveBeenCalledTimes(2);
    expect(result.complete).toBe(false);
    expect(result.batchesCompleted).toBe(1);
    expect(result.batchesPlanned).toBe(2);
    expect(result.stoppedReason).toBe('time_budget_exhausted');
    now.mockRestore();
  });

  it('rethrows a Stryker exit-1 config error whose stderr merely mentions a timeout', async () => {
    // No report on disk — exit 1 without one is a genuine failure. (With one it
    // means "score under thresholds.break"; see the recoverable-exit-1 tests.)
    mockExistsSync.mockImplementation((p: PathLike) => !String(p).endsWith('mutation.json'));
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      p === '/sb/src/large.ts'
        ? Array.from({ length: 121 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([]),
    );
    mockRunShell.mockRejectedValue(
      makeExecFailure({ exit: 1, stderr: 'Error: Test timed out in 5000ms.' }),
    );

    await expect(
      engine.run('src/large.ts', {
        workDir: '/sb',
        testRunner: 'command',
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/configuration or internal error \(exit 1\)/);
    // Fails fast on the first batch rather than dropping it and continuing.
    expect(mockRunShell).toHaveBeenCalledTimes(1);
  });

  it('does not report time_budget_exhausted when a later batch fails to configure', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    mockExistsSync.mockImplementation((p: PathLike) => !String(p).endsWith('mutation.json'));
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      p === '/sb/src/large.ts'
        ? Array.from({ length: 121 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([]),
    );
    mockRunShell
      .mockRejectedValueOnce(makeExecFailure({ code: 'TIMEOUT' }))
      .mockRejectedValueOnce(
        makeExecFailure({ exit: 1, stderr: 'ConfigError: Test timed out in 5000ms.' }),
      );

    // Previously the exit-1 error matched /timed out/ too, so BOTH batches were
    // dropped and the run resolved as a partial "time budget exhausted" result.
    await expect(
      engine.run('src/large.ts', {
        workDir: '/sb',
        testRunner: 'command',
        timeoutMs: 30_000,
      }),
    ).rejects.toThrow(/configuration or internal error \(exit 1\)/);
    expect(mockRunShell).toHaveBeenCalledTimes(2);
    now.mockRestore();
  });

  // Previously this resolved to a merged result over ZERO batches: totalMutants 0,
  // killed 0, and `formatMutationScore(0, 0)` === '100.00%' — a flawless score for
  // a run in which Stryker was never invoked. Reachable with no timeout at all,
  // because the handler admits any remaining budget >= 1000ms while a run needs
  // MIN_BATCH_BUDGET_MS (15000, one Stryker startup plus 5s) per batch, so the
  // first batchBudget can be below the floor and the loop breaks with
  // `firstTimeout` still undefined.
  it('throws when the time budget is exhausted before any batch runs', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValue(29_001);
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      p === '/sb/src/large.ts'
        ? Array.from({ length: 121 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([]),
    );

    const error = await engine
      .run('src/large.ts', { workDir: '/sb', testRunner: 'command', timeoutMs: 30_000 })
      .catch((e: unknown) => e);

    expect(mockRunShell).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(Error);
    // Names the target, the batch arithmetic, and the two things that fix it.
    expect((error as Error).message).toContain('src/large.ts');
    expect((error as Error).message).toContain('0 of 2 planned batches completed');
    expect((error as Error).message).toMatch(/raise timeoutMs or narrow the audit scope/);
    // Above all: no score was invented for a run that measured nothing.
    expect((error as Error).message).not.toContain('100.00%');
    now.mockRestore();
  });

  it('runs a batch whose allocated budget is exactly the minimum', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(0);
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      p === '/sb/src/large.ts'
        ? Array.from({ length: 121 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([]),
    );
    mockRunShell.mockResolvedValue(makeExecResult());

    const result = await engine.run('src/large.ts', {
      workDir: '/sb',
      testRunner: 'command',
      timeoutMs: 30_000,
    });

    expect(mockRunShell).toHaveBeenCalledTimes(2);
    expect((mockRunShell.mock.calls[0]?.[2] as { timeoutMs: number }).timeoutMs).toBe(15_000);
    expect(result.complete).toBe(true);
    now.mockRestore();
  });

  it('runs unbatched when the budget cannot fund two Stryker startups', async () => {
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      p === '/sb/src/large.ts'
        ? Array.from({ length: 500 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([]),
    );
    mockRunShell.mockResolvedValue(makeExecResult());

    await engine.run('src/large.ts', {
      workDir: '/sb',
      testRunner: 'command',
      timeoutMs: 20_000,
    });

    // One invocation over the whole file beats seven that each die in startup.
    expect(mockRunShell).toHaveBeenCalledTimes(1);
    expect(mockRunShell.mock.calls[0]?.[1] as string[]).toContain('src/large.ts');
  });

  it('runs unbatched, covering every hunk in one --mutate argument, when there are more ranges than the budget can start', async () => {
    // 25 diff-hunk-sized ranges (5 lines each) at the DEFAULT 300s budget: only
    // 20 startups are affordable, so planLineBatches now returns [] instead of
    // planning 25 batches destined to time out before a single one completes.
    // A call-count assertion alone would not prove the hunks survived the
    // fallback — the JSON report is what the caller actually gets scored on,
    // so this asserts every range reached Stryker's --mutate argument.
    const ranges = Array.from({ length: 25 }, (_, i) => ({ start: i * 10 + 1, end: i * 10 + 5 }));
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    mockRunShell.mockResolvedValue(makeExecResult());

    await engine.run('src/large.ts', {
      workDir: '/sb',
      testRunner: 'command',
      lineRanges: ranges,
    });

    expect(mockRunShell).toHaveBeenCalledTimes(1);
    expect(mutateValueOf(mockRunShell.mock.calls[0]?.[1] as string[])).toBe(
      ranges.map((r) => `src/large.ts:${r.start}-${r.end}`).join(','),
    );
  });

  it('does not batch large files for native runners or command-runner dry runs', async () => {
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      p === '/sb/src/large.ts'
        ? Array.from({ length: 121 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([]),
    );
    mockRunShell.mockResolvedValue(makeExecResult());

    await engine.run('src/large.ts', { workDir: '/sb', testRunner: 'vitest' });
    await engine.run('src/large.ts', {
      workDir: '/sb',
      testRunner: 'command',
      dryRun: true,
    });

    expect(mockRunShell).toHaveBeenCalledTimes(2);
    expect(mockRunShell.mock.calls[0]?.[1] as string[]).toContain('src/large.ts');
    expect(mockRunShell.mock.calls[1]?.[1] as string[]).toContain('--dryRunOnly');
  });

  it('uses command-runner batching defaults when RunOptions are absent', async () => {
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      String(p).endsWith('src/large.ts')
        ? Array.from({ length: 121 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([]),
    );
    mockRunShell.mockResolvedValue(makeExecResult());

    await engine.run('src/large.ts');

    expect(mockRunShell).toHaveBeenCalledTimes(2);
    expect(mockReadFileSync).toHaveBeenCalledWith(expect.stringContaining('src/large.ts'), 'utf-8');
  });

  it('falls back to one run when the source cannot be read for batch planning', async () => {
    // Keyed by path rather than by call order: writing the overlay config now
    // reads the project's own Stryker config too, so a positional
    // mockImplementationOnce chain no longer lines up with the source read.
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) => {
      if (String(p).endsWith('src/large.ts')) throw new Error('unreadable source');
      return makeJsonReport([]);
    });
    mockRunShell.mockResolvedValue(makeExecResult());

    await engine.run('src/large.ts', { workDir: '/sb', testRunner: 'command' });
    expect(mockRunShell).toHaveBeenCalledTimes(1);
  });

  it('prefers explicit lineRanges over a large legacy lineScope during planning', async () => {
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    mockRunShell.mockResolvedValue(makeExecResult());

    await engine.run('src/large.ts', {
      workDir: '/sb',
      testRunner: 'command',
      lineScope: { start: 1, end: 200 },
      lineRanges: [{ start: 10, end: 20 }],
    });

    expect(mockRunShell).toHaveBeenCalledTimes(1);
    expect(mockRunShell.mock.calls[0]?.[1]).toContain('src/large.ts:10-20');
  });

  it('batches a large legacy lineScope when lineRanges are absent', async () => {
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    mockRunShell.mockResolvedValue(makeExecResult());

    await engine.run('src/large.ts', {
      workDir: '/sb',
      testRunner: 'command',
      lineScope: { start: 1, end: 200 },
    });

    expect(mockRunShell).toHaveBeenCalledTimes(3);
    expect(mockRunShell.mock.calls.map((call) => mutateValueOf(call[1] as string[]))).toEqual([
      'src/large.ts:1-80',
      'src/large.ts:81-160',
      'src/large.ts:161-200',
    ]);
  });

  it('returns correct metrics when all mutants are killed', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 },
        { status: 'Killed', mutatorName: 'ConditionalExpression', line: 2 },
        { status: 'Killed', mutatorName: 'ArithmeticOperator', line: 3 },
      ]),
    );

    const result = await engine.run('src/test.ts');

    expect(result.totalMutants).toBe(3);
    expect(result.killed).toBe(3);
    expect(result.survived).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
  });

  it('excludes Ignored mutants (e.g. denylisted) from the score denominator', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 },
        { status: 'Ignored', mutatorName: 'StringLiteral', line: 2 },
        { status: 'Ignored', mutatorName: 'StringLiteral', line: 3 },
        { status: 'Survived', mutatorName: 'ConditionalExpression', line: 4 },
      ]),
    );

    const result = await engine.run('src/test.ts');

    expect(result.totalMutants).toBe(2);
    expect(result.killed).toBe(1);
    expect(result.survived).toBe(1);
    expect(result.mutationScore).toBe('50.00%');
    // Ignored mutants must not surface as vulnerabilities either.
    expect(result.vulnerabilities).toHaveLength(1);
  });

  it('reports surviving mutants as vulnerabilities', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 },
        { status: 'Survived', mutatorName: 'ConditionalExpression', line: 42 },
        { status: 'Survived', mutatorName: 'ArithmeticOperator', line: 88 },
      ]),
    );

    const result = await engine.run('src/billing.ts');

    expect(result.survived).toBe(2);
    expect(result.vulnerabilities).toHaveLength(2);
    expect(result.vulnerabilities[0].line).toBe(42);
  });

  it('throws descriptive error when Stryker is not installed (ENOENT)', async () => {
    mockRunShell.mockRejectedValue(makeExecFailure({ code: 'ENOENT' }));

    await expect(engine.run('src/test.ts')).rejects.toThrow(/StrykerJS is not installed/);
    await expect(engine.run('src/test.ts')).rejects.toThrow(/@stryker-mutator\/core/);
  });

  it('handles Stryker exit 2 (threshold not met) and still parses report', async () => {
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 2, stderr: 'threshold not met' }));
    mockReadFileSync.mockReturnValue(
      makeJsonReport([{ status: 'Survived', mutatorName: 'ArithmeticOperator', line: 10 }]),
    );

    const result = await engine.run('src/test.ts');
    expect(result.survived).toBe(1);
  });

  it('throws on Stryker exit 1 when NO report was written (config/internal error)', async () => {
    mockExistsSync.mockImplementation((p: PathLike) => !String(p).endsWith('mutation.json'));
    mockRunShell.mockRejectedValue(
      makeExecFailure({ exit: 1, stderr: 'stryker.config.js not found' }),
    );

    await expect(engine.run('src/test.ts')).rejects.toThrow(/configuration or internal error/);
    // The stderr tail is interpolated into the message — pin it so its
    // string-literal / slice survives mutation.
    await expect(engine.run('src/test.ts')).rejects.toThrow(/stryker\.config\.js not found/);
  });

  // Exit 1 is OVERLOADED in StrykerJS: MutationTestReportHelper.determineExitCode()
  // sets it when the score is under `thresholds.break`, and that is the ONLY
  // setExitCode call site in @stryker-mutator/core@9.6.1 (there is no exit 2).
  // Treating every exit 1 as a config error meant any project with the standard
  // CI gate `thresholds: { break: 80 }` got an EMPTY "configuration or internal
  // error (exit 1):" message (--logLevel off blanks stderr) and had its entire
  // survivor report discarded — for a run that fully succeeded.
  it('parses the report on exit 1 when the report exists (score under thresholds.break)', async () => {
    mockExistsSync.mockReturnValue(true);
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 1, stderr: '' }));
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Survived', mutatorName: 'ArithmeticOperator', line: 10 },
        { status: 'Killed', mutatorName: 'BooleanLiteral', line: 11 },
      ]),
    );

    const result = await engine.run('src/test.ts');

    expect(result.survived).toBe(1);
    expect(result.killed).toBe(1);
    expect(result.mutationScore).toBe('50.00%');
  });

  it('still reports the no-tests failure on exit 1 even when a report exists', async () => {
    // The "No tests were executed" branch is checked BEFORE the report probe:
    // a dry run that ran zero tests is a real failure regardless of what is on disk.
    mockExistsSync.mockReturnValue(true);
    mockRunShell.mockRejectedValue(
      makeExecFailure({ exit: 1, stderr: 'ConfigError: No tests were executed.' }),
    );
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await expect(engine.run('src/orphan.ts')).rejects.toThrow(/zero tests/);
  });

  it('maps the "No tests were executed" ConfigError to an actionable no-tests message', async () => {
    mockRunShell.mockRejectedValue(
      makeExecFailure({
        exit: 1,
        stderr:
          'ConfigError: No tests were executed. Stryker will exit prematurely. Please check your configuration.\n    at DryRunExecutor.execute (file:///x/3-dry-run-executor.js:47)',
      }),
    );

    await expect(engine.run('src/orphan.ts')).rejects.toThrow(/zero tests/);
    await expect(engine.run('src/orphan.ts')).rejects.toThrow(/src\/orphan\.ts/);
    // The raw Stryker stack trace must not leak through.
    await expect(engine.run('src/orphan.ts')).rejects.not.toThrow(/DryRunExecutor/);
  });

  it('throws on timeout (TIMEOUT code)', async () => {
    mockRunShell.mockRejectedValue(makeExecFailure({ code: 'TIMEOUT' }));

    await expect(engine.run('src/test.ts')).rejects.toThrow(/timed out/);
  });

  it('classifies a real Stryker timeout as a typed StrykerTimeoutError', async () => {
    mockRunShell.mockRejectedValue(makeExecFailure({ code: 'TIMEOUT' }));

    const error = await engine.run('src/test.ts').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StrykerTimeoutError);
    expect((error as StrykerTimeoutError).code).toBe('TIMEOUT');
    expect((error as StrykerTimeoutError).message).toMatch(/^StrykerJS timed out after \d+ms\./);
  });

  it('leaves the other startup-class failures as plain, untyped errors', async () => {
    mockRunShell.mockRejectedValue(makeExecFailure({ code: 'ENOENT' }));

    const error = await engine.run('src/test.ts').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(StrykerTimeoutError);
    expect((error as Error).message).toMatch(/is not installed/);
  });

  it('throws on signal-based crash', async () => {
    mockRunShell.mockRejectedValue(
      makeExecFailure({ signal: 'SIGSEGV', exit: null, stderr: 'segfault' }),
    );

    await expect(engine.run('src/test.ts')).rejects.toThrow(/crashed unexpectedly.*SIGSEGV/);
  });

  it('propagates an ABORTED exec failure out of the engine unchanged', async () => {
    // A cancelled run arrives as the raw ExecFailureError with `code: 'ABORTED'`
    // (`invokeMutationTool` rethrows it untouched so `isCancel` still works).
    // It used to match no branch of classifyStrykerFailure — `exit: null`, no
    // stderr — and fall out the bottom as a "recoverable" exit, so the engine
    // went on to parseReport and reported `Stryker JSON report not found at …`
    // for a run the caller had deliberately stopped.
    mockExistsSync.mockImplementation((p: PathLike) => !String(p).endsWith('mutation.json'));
    const aborted = makeExecFailure({ code: 'ABORTED', signal: 'SIGKILL', exit: null });
    mockRunShell.mockRejectedValue(aborted);

    const error = await engine.run('src/test.ts').catch((e: unknown) => e);

    // Same error object, so the marker every cancel check keys on survives.
    expect(error).toBe(aborted);
    expect(error).toBeInstanceOf(ExecFailureError);
    expect((error as ExecFailureError).code).toBe('ABORTED');
    expect((error as Error).message).not.toMatch(/Stryker JSON report not found/);
  });

  // ─── RunOptions tests ───────────────────────────────────────────────────

  it('uses testRunner from RunOptions', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/test.ts', { testRunner: 'jest' });

    const callArgs = mockRunShell.mock.calls[0];
    const argList = callArgs?.[1] as string[];
    expect(argList).toContain('--testRunner');
    expect(argArgsContain(argList, '--testRunner', 'jest')).toBe(true);
  });

  it('uses an explicit overlay config for a scoped command runner', async () => {
    const { writeFileSync } = await import('fs');
    const mockWrite = vi.mocked(writeFileSync);
    mockExistsSync.mockImplementation(
      (p: PathLike) => p === '/sb/stryker.config.mjs' || p === '/sb/reports/mutation/mutation.json',
    );
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', {
      workDir: '/sb',
      testRunner: 'command',
      commandRunnerCommand: 'npx vitest related src/app.ts --run',
      mutatorDenylist: ['StringLiteral'],
    });

    const configWrite = mockWrite.mock.calls.find(
      (call) => call[0] === '/sb/.chaos-mcp.stryker.config.mjs',
    );
    expect(configWrite).toBeDefined();
    const source = String(configWrite?.[1]);
    expect(source).toContain('import importedConfig from "./stryker.config.mjs"');
    expect(source).toContain('"npx vitest related src/app.ts --run"');
    expect(source).toContain('"StringLiteral"');
    expect(source).toContain("coverageAnalysis: 'off'");

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList.slice(0, 4)).toEqual([
      '--no-install',
      'stryker',
      'run',
      '.chaos-mcp.stryker.config.mjs',
    ]);
  });

  it('writes an empty denylist into a command-runner overlay when none is configured', async () => {
    const mockWrite = vi.mocked(writeFileSync);
    mockExistsSync.mockImplementation((p: PathLike) => p === '/sb/reports/mutation/mutation.json');
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', {
      workDir: '/sb',
      testRunner: 'command',
      commandRunnerCommand: 'npm test',
    });

    const source = String(
      mockWrite.mock.calls.find((call) => call[0] === '/sb/.chaos-mcp.stryker.config.mjs')?.[1],
    );
    expect(source).toContain('...[],');
    expect(source).not.toContain('Stryker was here');
  });

  // The overlay is written for EVERY run now (it is the only place the JSON
  // report path and the mutator denylist can be pinned), but it must not drag
  // the command runner along: forcing `testRunner: 'command'` and
  // `coverageAnalysis: 'off'` onto a vitest run would silently change what is
  // being measured — and, with no commandRunner.command, run nothing at all.
  it('writes an overlay for a native test runner without any command-runner override', async () => {
    const mockWrite = vi.mocked(writeFileSync);
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', {
      workDir: '/sb',
      testRunner: 'vitest',
      commandRunnerCommand: 'npm test',
    });

    const source = String(
      mockWrite.mock.calls.find((call) => call[0] === '/sb/.chaos-mcp.stryker.config.mjs')?.[1],
    );
    expect(source).not.toContain("testRunner: 'command'");
    expect(source).not.toContain("coverageAnalysis: 'off'");
    expect(source).not.toContain('commandRunner:');
    expect(source).not.toContain('npm test');
    // The overlay is still selected on the CLI, and --testRunner (which wins
    // over the config file) still names the native runner.
    expect(mockRunShell.mock.calls[0]?.[1]).toContain('.chaos-mcp.stryker.config.mjs');
    expect(
      argArgsContain(mockRunShell.mock.calls[0]?.[1] as string[], '--testRunner', 'vitest'),
    ).toBe(true);
  });

  it('passes the runner plugin explicitly so it resolves under pnpm', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/test.ts', { testRunner: 'vitest' });

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    // Explicit runner plugin AND the wildcard (so other plugins still resolve).
    expect(argPairPresent(argList, '--plugins', '@stryker-mutator/vitest-runner')).toBe(true);
    expect(argPairPresent(argList, '--plugins', '@stryker-mutator/*')).toBe(true);
  });

  it('maps each supported runner to its @stryker-mutator/<runner>-runner plugin', async () => {
    for (const [runner, plugin] of [
      ['jest', '@stryker-mutator/jest-runner'],
      ['mocha', '@stryker-mutator/mocha-runner'],
      ['jasmine', '@stryker-mutator/jasmine-runner'],
      ['karma', '@stryker-mutator/karma-runner'],
    ] as const) {
      mockRunShell.mockClear();
      mockRunShell.mockResolvedValue(makeExecResult());
      mockReadFileSync.mockReturnValue(makeJsonReport([]));

      await engine.run('src/test.ts', { testRunner: runner });

      const argList = mockRunShell.mock.calls[0]?.[1] as string[];
      expect(argPairPresent(argList, '--plugins', plugin)).toBe(true);
    }
  });

  it('omits --plugins for the built-in command runner (default)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    // No testRunner override → resolves to the built-in 'command' runner,
    // which needs no plugin and works under Stryker's default discovery.
    await engine.run('src/test.ts');

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).not.toContain('--plugins');
  });

  it('does not resolve inherited Object.prototype names as runner plugins', async () => {
    for (const runner of ['constructor', 'toString', 'hasOwnProperty'] as const) {
      mockRunShell.mockClear();
      mockRunShell.mockResolvedValue(makeExecResult());
      mockReadFileSync.mockReturnValue(makeJsonReport([]));

      await engine.run('src/test.ts', { testRunner: runner });

      const argList = mockRunShell.mock.calls[0]?.[1] as string[];
      expect(argList).not.toContain('--plugins');
    }
  });

  it('uses workDir from RunOptions as cwd', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/test.ts', { workDir: '/tmp/sandbox' });

    expect(mockRunShell).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ cwd: '/tmp/sandbox' }),
    );
  });

  it('uses custom timeoutMs from RunOptions', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/test.ts', { timeoutMs: 120000 });

    expect(mockRunShell).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 120000 }),
    );
  });

  it('defaults to 5-minute timeout when no timeoutMs provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/test.ts');

    expect(mockRunShell).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ timeoutMs: 300_000 }),
    );
  });

  it('passes concurrency as --concurrency flag when provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', { concurrency: 4 });

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--concurrency', '4')).toBe(true);
  });

  it('omits --concurrency when not provided (lets Stryker auto-detect)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts');

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).not.toContain('--concurrency');
  });

  it('scopes --mutate to line range when lineScope is provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', { lineScope: { start: 10, end: 50 } });

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--mutate', 'src/app.ts:10-50')).toBe(true);
  });

  it('does not include line range in --mutate when lineScope is absent', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts');

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--mutate', 'src/app.ts')).toBe(true);
  });

  it('throws when lineScope.start is not an integer (M12 regression)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await expect(engine.run('src/app.ts', { lineScope: { start: 2.5, end: 50 } })).rejects.toThrow(
      /lineScope.start must be an integer/,
    );
  });

  it('throws when lineScope.start < 1 (M12 regression)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await expect(engine.run('src/app.ts', { lineScope: { start: 0, end: 50 } })).rejects.toThrow(
      /lineScope.start must be an integer >= 1/,
    );
  });

  it('throws when lineScope.end < lineScope.start (M12 regression)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await expect(engine.run('src/app.ts', { lineScope: { start: 50, end: 10 } })).rejects.toThrow(
      /lineScope.end must be an integer >= start/,
    );
  });

  it('passes mutatorDenylist via the overlay config, never as a CLI flag (StrykerJS v9)', async () => {
    const { writeFileSync } = await import('fs');
    const mockWrite = vi.mocked(writeFileSync);

    // Nothing in the sandbox but the report — no project Stryker config at all.
    mockExistsSync.mockImplementation((p: PathLike) => String(p).endsWith('mutation.json'));
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', {
      workDir: '/tmp/test-sandbox',
      mutatorDenylist: ['StringLiteral', 'BooleanLiteral'],
    });

    const source = String(
      mockWrite.mock.calls.find(
        (c) => c[0] === '/tmp/test-sandbox/.chaos-mcp.stryker.config.mjs',
      )?.[1],
    );
    expect(source).toContain('const base = {};');
    // Stryker's schema exposes exclusions as mutator.excludedMutations — the
    // former top-level `mutators` map is not a Stryker option and was ignored.
    expect(source).toContain('excludedMutations');
    expect(source).toContain('...["StringLiteral","BooleanLiteral"],');
    // v9 removed the --mutators CLI flag; nothing mutator-ish may reach argv.
    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList.filter((a) => a.includes('mutators'))).toHaveLength(0);
  });

  // THE bug this replaces: the denylist used to be merged into
  // `stryker.config.json`, which is FIFTH in Stryker's own discovery order
  // (SUPPORTED_CONFIG_FILE_NAMES: stryker.conf.json, .conf.js, .conf.mjs,
  // .conf.cjs, stryker.config.json, …) and `ConfigReader.findConfigFile` returns
  // the FIRST hit. A project shipping `stryker.conf.json` therefore had its
  // denylist written to a file Stryker never opened, and every denylisted
  // mutator ran anyway — silently.
  it('composes the overlay from the config Stryker actually loads, not stryker.config.json', async () => {
    const { writeFileSync } = await import('fs');
    const mockWrite = vi.mocked(writeFileSync);
    const loadedPath = '/tmp/test-sandbox/stryker.conf.json';
    const ignoredPath = '/tmp/test-sandbox/stryker.config.json';

    // Both exist; stryker.conf.json wins because it comes first in Stryker's order.
    mockExistsSync.mockImplementation(
      (p: PathLike) => p === loadedPath || p === ignoredPath || String(p).endsWith('mutation.json'),
    );
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) => {
      if (p === loadedPath) return JSON.stringify({ mutator: { excludedMutations: ['FromConf'] } });
      if (p === ignoredPath) {
        return JSON.stringify({ mutator: { excludedMutations: ['FromConfigDotJson'] } });
      }
      return makeJsonReport([]);
    });
    mockRunShell.mockResolvedValue(makeExecResult());

    await engine.run('src/app.ts', {
      workDir: '/tmp/test-sandbox',
      mutatorDenylist: ['StringLiteral'],
    });

    const source = String(
      mockWrite.mock.calls.find(
        (c) => c[0] === '/tmp/test-sandbox/.chaos-mcp.stryker.config.mjs',
      )?.[1],
    );
    expect(source).toContain('"FromConf"');
    expect(source).not.toContain('FromConfigDotJson');
    // The project's own config file is never rewritten in place any more.
    expect(mockWrite.mock.calls.some((c) => c[0] === loadedPath)).toBe(false);
    expect(mockWrite.mock.calls.some((c) => c[0] === ignoredPath)).toBe(false);
  });

  it('routes the denylist through the overlay for a JS-family config it cannot merge into', async () => {
    const { writeFileSync } = await import('fs');
    const mockWrite = vi.mocked(writeFileSync);
    // stryker.conf.mjs is 3rd in Stryker's order and is not textually mergeable —
    // the overlay imports it and layers the exclusions on the imported object.
    mockExistsSync.mockImplementation(
      (p: PathLike) =>
        p === '/tmp/test-sandbox/stryker.conf.mjs' || String(p).endsWith('mutation.json'),
    );
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    mockRunShell.mockResolvedValue(makeExecResult());

    await engine.run('src/app.ts', {
      workDir: '/tmp/test-sandbox',
      mutatorDenylist: ['StringLiteral'],
    });

    const source = String(
      mockWrite.mock.calls.find(
        (c) => c[0] === '/tmp/test-sandbox/.chaos-mcp.stryker.config.mjs',
      )?.[1],
    );
    expect(source).toContain('import importedConfig from "./stryker.conf.mjs";');
    expect(source).toContain('...["StringLiteral"],');
    expect(mockRunShell.mock.calls[0]?.[1]).toContain('.chaos-mcp.stryker.config.mjs');
  });

  it('unions the denylist with the project exclusions and migrates a legacy `mutators` map', () => {
    const mockWrite = vi.mocked(writeFileSync);
    mockExistsSync.mockImplementation((p: PathLike) => p === '/sb/stryker.conf.json');
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        testRunner: 'vitest',
        mutate: ['src/**/*.ts'],
        // The shape earlier Chaos-MCP versions wrote — never a valid Stryker option.
        mutators: { ConditionalExpression: false, BooleanLiteral: true },
        mutator: { plugins: null, excludedMutations: ['ArithmeticOperator'] },
      }),
    );

    writeStrykerRuntimeConfig('/sb', undefined, ['StringLiteral', 'ArithmeticOperator']);
    const source = String(mockWrite.mock.calls.at(-1)?.[1]);

    // The project's own settings survive, spread ahead of our overrides…
    expect(source).toContain('"testRunner":"vitest"');
    expect(source).toContain('"mutate":["src/**/*.ts"]');
    expect(source).toContain('"plugins":null');
    // …with the invalid legacy key stripped from the emitted options,
    // its disabled entries folded into excludedMutations, and the whole lot deduped.
    expect(source).toContain(
      'const { mutators: _legacyMutators, ...withoutLegacyMutators } = base;',
    );
    expect(source).toContain('...withoutLegacyMutators,');
    expect(source).toContain('...legacyExcluded,');
    expect(source).toContain('...existingExcluded,');
    expect(source).toContain('new Set(');
  });

  it('pins jsonReporter.fileName so a project config cannot move the report', () => {
    const mockWrite = vi.mocked(writeFileSync);
    // Stryker honours `jsonReporter.fileName` (json-reporter.js normalises it),
    // and the overlay spreads the project's config forward — so without an
    // explicit pin a successful run's report lands somewhere parseReport never
    // looks and the engine reports "Stryker JSON report not found".
    // It cannot be pinned on the CLI: 9.6.1 declares no --jsonReporter.fileName
    // and Commander aborts with "unknown option".
    mockExistsSync.mockImplementation((p: PathLike) => p === '/sb/stryker.conf.json');
    mockReadFileSync.mockReturnValue(
      JSON.stringify({ jsonReporter: { fileName: 'artifacts/mutation.json' } }),
    );

    writeStrykerRuntimeConfig('/sb', undefined, []);
    const source = String(mockWrite.mock.calls.at(-1)?.[1]);

    expect(source).toContain(
      'jsonReporter: { ...(base.jsonReporter ?? {}), fileName: "reports/mutation/mutation.json" }',
    );
    // The override must come AFTER the base spread, or the project value wins.
    expect(source.indexOf('...withoutLegacyMutators')).toBeLessThan(
      source.indexOf('jsonReporter: {'),
    );
  });

  it('writes the overlay even for an empty mutatorDenylist', async () => {
    const { writeFileSync } = await import('fs');
    const mockWrite = vi.mocked(writeFileSync);
    mockWrite.mockClear();
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', { workDir: '/sb', mutatorDenylist: [] });

    // No longer conditional on the denylist: the overlay is also what pins the
    // JSON report path, so it must be written on every run.
    const source = String(
      mockWrite.mock.calls.find((c) => c[0] === '/sb/.chaos-mcp.stryker.config.mjs')?.[1],
    );
    expect(source).toContain('...[],');
    expect(source).toContain('fileName: "reports/mutation/mutation.json"');
  });

  it('treats an empty mutatorAllowlist as a no-op (does not throw)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    // An empty allowlist must NOT trip the "unsupported" guard (length > 0).
    await expect(engine.run('src/app.ts', { mutatorAllowlist: [] })).resolves.toBeDefined();
  });

  it('throws when mutatorAllowlist is provided (unsupported in StrykerJS v9)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await expect(
      engine.run('src/app.ts', { mutatorAllowlist: ['ConditionalExpression'] }),
    ).rejects.toThrow(/mutatorAllowlist is not supported in StrykerJS v9/);
  });

  it('omits mutator denylist args when none provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts');

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList.filter((a) => a.startsWith('--mutators.'))).toHaveLength(0);
  });

  it('passes --dryRunOnly for dryRun mode (StrykerJS v9)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', { dryRun: true });

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).toContain('--dryRunOnly');
    expect(argList).not.toContain('--dryRun');
  });

  it('returns a dry-run result without parsing a report (no report is written for --dryRunOnly)', async () => {
    // Reproduces the real dry-run condition: StrykerJS with --dryRunOnly runs
    // only the initial test pass and never writes reports/mutation/mutation.json.
    // The engine must NOT throw "report not found" — it should report success.
    mockRunShell.mockResolvedValue(makeExecResult());
    mockExistsSync.mockReturnValue(false); // report genuinely absent

    const result = await engine.run('src/app.ts', { dryRun: true });

    expect(result.totalMutants).toBe(0);
    expect(result.survived).toBe(0);
    expect(result.vulnerabilities).toEqual([]);
    expect(result.scopeNote).toMatch(/dry run/i);
  });

  // ─── Timeout-status mutant tests ────────────────────────────────────────

  it('counts Timeout-status mutants as killed in the score', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 },
        { status: 'Killed', mutatorName: 'ConditionalExpression', line: 2 },
        { status: 'Timeout', mutatorName: 'ArithmeticOperator', line: 3 },
        { status: 'Survived', mutatorName: 'StringLiteral', line: 4 },
      ]),
    );

    const result = await engine.run('src/test.ts');

    // killed includes the Timeout mutant: 2 Killed + 1 Timeout = 3
    expect(result.killed).toBe(3);
    expect(result.survived).toBe(1);
    expect(result.totalMutants).toBe(4);
    // score = 3/4 * 100 = 75.00%
    expect(result.mutationScore).toBe('75.00%');
    // Only the Survived mutant should be a vulnerability
    expect(result.vulnerabilities).toHaveLength(1);
    expect(result.vulnerabilities[0].line).toBe(4);
  });

  it('counts all-Timeout mutants as fully killed', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Timeout', mutatorName: 'BooleanLiteral', line: 1 },
        { status: 'Timeout', mutatorName: 'ConditionalExpression', line: 2 },
      ]),
    );
    const result = await engine.run('src/test.ts');

    expect(result.killed).toBe(2);
    expect(result.survived).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
    expect(result.vulnerabilities).toHaveLength(0);
  });

  // ─── perMutantTimeoutMs tests ───────────────────────────────────────────

  it('adds --timeoutMs when perMutantTimeoutMs is provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([{ status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 }]),
    );

    await engine.run('src/app.ts', { perMutantTimeoutMs: 10000 });

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).toBeDefined();
    expect(argArgsContain(argList, '--timeoutMs', '10000')).toBe(true);
  });

  // ─── parseReport edge case tests ─────────────────────────────────────────

  it('throws when Stryker JSON report file is missing', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockExistsSync.mockReturnValue(false);

    await expect(engine.run('src/test.ts')).rejects.toThrow(/Stryker JSON report not found/);
  });

  it('throws when report JSON is malformed', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not valid json {{{');

    await expect(engine.run('src/test.ts')).rejects.toThrow(/Failed to parse Stryker JSON report/);
  });

  it('collects mutants from multiple files in the report', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        files: {
          'src/a.ts': {
            source: '',
            mutants: [
              {
                status: 'Killed',
                mutatorName: 'ArithmeticOperator',
                line: 1,
                id: '1',
                replacement: '',
                location: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
              },
            ],
          },
          'src/b.ts': {
            source: '',
            mutants: [
              {
                status: 'Survived',
                mutatorName: 'ConditionalExpression',
                line: 10,
                id: '2',
                replacement: '',
                location: { start: { line: 10, column: 0 }, end: { line: 10, column: 10 } },
              },
            ],
          },
        },
      }),
    );

    const result = await engine.run('src/app.ts');
    expect(result.totalMutants).toBe(2);
    expect(result.killed).toBe(1);
    expect(result.survived).toBe(1);
  });

  it('handles report with null/undefined files object gracefully', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(JSON.stringify({}));

    const result = await engine.run('src/app.ts');
    expect(result.totalMutants).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
  });

  it('skips files whose mutants field is not an array', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        files: {
          'src/a.ts': { source: '', mutants: 'not-an-array' },
          'src/b.ts': {
            source: '',
            mutants: [
              {
                status: 'Killed',
                mutatorName: 'ArithmeticOperator',
                line: 1,
                id: '1',
                replacement: '',
                location: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
              },
            ],
          },
        },
      }),
    );

    const result = await engine.run('src/app.ts');
    expect(result.totalMutants).toBe(1);
    expect(result.killed).toBe(1);
  });

  it('reports NoCoverage mutants as vulnerabilities alongside Survived', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 },
        { status: 'NoCoverage', mutatorName: 'BlockStatement', line: 5 },
        { status: 'Survived', mutatorName: 'ArithmeticOperator', line: 10 },
      ]),
    );

    const result = await engine.run('src/test.ts');
    expect(result.survived).toBe(1);
    expect(result.vulnerabilities).toHaveLength(2);
    expect(result.vulnerabilities[0].line).toBe(5);
    expect(result.vulnerabilities[0].description).toContain('NoCoverage');
    expect(result.vulnerabilities[1].line).toBe(10);
    expect(result.vulnerabilities[1].description).toContain('survived');
  });

  it('filters out CompileError and RuntimeError mutants', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 },
        { status: 'CompileError', mutatorName: 'ArithmeticOperator', line: 3 },
        { status: 'RuntimeError', mutatorName: 'ConditionalExpression', line: 5 },
      ]),
    );

    const result = await engine.run('src/test.ts');
    expect(result.totalMutants).toBe(1);
    expect(result.killed).toBe(1);
    expect(result.survived).toBe(0);
  });

  it('omits --timeoutMs when perMutantTimeoutMs is not provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([{ status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 }]),
    );

    await engine.run('src/app.ts');

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).toBeDefined();
    expect(argList).not.toContain('--timeoutMs');
  });

  // ─── Option guard edge cases ────────────────────────────────────────────

  it('omits --concurrency when concurrency is 0', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', { concurrency: 0 });

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).not.toContain('--concurrency');
  });

  it('omits --dryRunOnly when dryRun is not provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts');

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).not.toContain('--dryRunOnly');
  });

  it('omits --incremental when incremental is not provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts');

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).not.toContain('--incremental');
  });

  it('passes --incremental and --incrementalFile when incremental is true', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', { incremental: true });

    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).toContain('--incremental');
    expect(argList).toContain('.stryker-incremental.json');
  });

  // ─── MutationToolStartupError and verbose paths ─────────────────────────

  it('throws MutationToolStartupError verbatim', async () => {
    const { MutationToolStartupError } = await import('../utils/exec-classify.js');
    mockRunShell.mockRejectedValue(new MutationToolStartupError('StrykerJS', 'not found'));

    await expect(engine.run('src/test.ts')).rejects.toThrow('not found');
  });

  it('logs stderr in verbose mode on non-zero exit', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    const mockVerbose = vi.mocked(isVerbose);

    mockVerbose.mockReturnValue(true);
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 2, stderr: 'threshold not met' }));
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/test.ts');

    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('threshold not met'));
    // Reset for subsequent tests
    mockVerbose.mockReturnValue(false);
  });

  it('logs NoCoverage heads-up in verbose mode', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    const mockLog = vi.mocked(log);
    const mockVerbose = vi.mocked(isVerbose);

    mockVerbose.mockReturnValue(true);
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([{ status: 'NoCoverage', mutatorName: 'BlockStatement', line: 5 }]),
    );

    const result = await engine.run('src/test.ts');
    expect(result.vulnerabilities).toHaveLength(1);
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('NoCoverage'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('vulnerabilities'));
    // Reset for subsequent tests
    mockVerbose.mockReturnValue(false);
  });

  it('throws non-ExecFailureError non-MutationToolStartupError errors as-is', async () => {
    mockRunShell.mockRejectedValue(new Error('something unexpected'));

    await expect(engine.run('src/test.ts')).rejects.toThrow('something unexpected');
  });

  it('throws non-Error rejection as string', async () => {
    mockRunShell.mockRejectedValue('plain string failure');

    await expect(engine.run('src/test.ts')).rejects.toThrow(/Stryker execution failed/);
  });

  // ─── Mutation hardening ──────────────────────────────────────────────────

  it('passes the exact base Stryker CLI argument array', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/math.ts', { testRunner: 'vitest', workDir: '/sb' });

    // Pins every static flag/value in the args array (the 126–141 cluster).
    expect(mockRunShell).toHaveBeenCalledWith(
      'npx',
      [
        '--no-install',
        'stryker',
        'run',
        // Every run is launched with the generated overlay as Stryker's
        // configFile: it is the only place jsonReporter.fileName and the mutator
        // denylist can be pinned regardless of what config the project ships.
        '.chaos-mcp.stryker.config.mjs',
        '--mutate',
        'src/math.ts',
        '--testRunner',
        'vitest',
        '--reporters',
        'json',
        '--logLevel',
        'off',
        '--cleanTempDir',
        'true',
        '--tempDirName',
        '.stryker-tmp',
        // Runner plugin passed explicitly (+ wildcard) so it resolves in
        // Stryker's child test-runner process under pnpm's symlinked layout.
        '--plugins',
        '@stryker-mutator/*',
        '--plugins',
        '@stryker-mutator/vitest-runner',
      ],
      expect.objectContaining({ cwd: '/sb' }),
    );
  });

  it('uses the image-provided Stryker binary in container mode', async () => {
    const executor = {
      kind: 'container' as const,
      workDir: '/sb',
      run: vi.fn().mockResolvedValue(makeExecResult()),
      runCommand: vi.fn(),
      dispose: vi.fn(),
    };
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/math.ts', {
      testRunner: 'command',
      workDir: '/sb',
      executor,
    });

    expect(executor.run).toHaveBeenCalledWith(
      'stryker',
      expect.arrayContaining(['run', '--mutate', 'src/math.ts']),
      expect.objectContaining({ cwd: '/sb' }),
    );
    expect(mockRunShell).not.toHaveBeenCalled();
  });

  it('accepts lineScope at the boundaries (start=1, end=start)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    // start=1 and end===start are both valid; the `< 1` / `< start` guards must
    // use strict-less-than (a `<=` mutant would wrongly throw here).
    await engine.run('src/math.ts', { lineScope: { start: 1, end: 1 } });
    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).toContain('src/math.ts:1-1');
  });

  it('reads the report from the canonical Stryker JSON report path', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/math.ts', { workDir: '/sb' });

    expect(mockReadFileSync).toHaveBeenCalledWith('/sb/reports/mutation/mutation.json', 'utf-8');
  });

  it('does not log anything when verbose mode is off', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(false);
    const mockLog = vi.mocked(log);
    mockLog.mockClear();
    mockRunShell.mockResolvedValue(makeExecResult());
    // Include a NoCoverage mutant so the parseReport verbose branch is also exercised.
    mockReadFileSync.mockReturnValue(
      makeJsonReport([{ status: 'NoCoverage', mutatorName: 'BooleanLiteral', line: 4 }]),
    );

    await engine.run('src/math.ts');

    expect(mockLog).not.toHaveBeenCalled();
  });

  // ─── Mutation hardening (round 2) ────────────────────────────────────────

  it('defaults the test runner to "command" when none is provided', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    await engine.run('src/app.ts');
    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--testRunner', 'command')).toBe(true);
  });

  it('explains the denylist alternative and echoes the requested allowlist', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    const run = engine.run('src/app.ts', { mutatorAllowlist: ['Alpha', 'Beta'] });
    await expect(run).rejects.toThrow(/Use mutatorDenylist instead/);
    // The `.join(', ')` separator and the echoed list are their own mutants.
    await expect(engine.run('src/app.ts', { mutatorAllowlist: ['Alpha', 'Beta'] })).rejects.toThrow(
      /Requested allowlist: Alpha, Beta/,
    );
  });

  it('passes the --incrementalFile flag (not just its value) in incremental mode', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    await engine.run('src/app.ts', { incremental: true });
    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--incrementalFile', '.stryker-incremental.json')).toBe(true);
  });

  it('omits --timeoutMs when perMutantTimeoutMs is exactly 0 (strict > 0 guard)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    await engine.run('src/app.ts', { perMutantTimeoutMs: 0 });
    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argList).not.toContain('--timeoutMs');
  });

  it('logs the exact native Stryker invocation in verbose mode', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(true);
    const mockLog = vi.mocked(log);
    mockLog.mockClear();
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/math.ts');

    expect(mockLog).toHaveBeenCalledWith(
      'TypeScriptEngine: npx --no-install stryker run .chaos-mcp.stryker.config.mjs ' +
        '--mutate src/math.ts --testRunner command ' +
        '--reporters json --logLevel off --cleanTempDir true --tempDirName .stryker-tmp',
    );
    vi.mocked(isVerbose).mockReturnValue(false);
  });

  it('rethrows a plain Error verbatim without the "Stryker execution failed" wrapper', async () => {
    mockRunShell.mockRejectedValue(new Error('boom-xyz'));
    await expect(engine.run('src/test.ts')).rejects.toThrow('boom-xyz');
    await expect(engine.run('src/test.ts')).rejects.not.toThrow(/Stryker execution failed/);
  });

  it('does not log stderr when verbose is off even on a non-zero exit', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(false);
    const mockLog = vi.mocked(log);
    mockLog.mockClear();
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 2, stderr: 'threshold not met' }));
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/test.ts');

    expect(mockLog).not.toHaveBeenCalled();
  });

  it('does not log stderr in verbose mode when stderr is empty', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(true);
    const mockLog = vi.mocked(log);
    mockLog.mockClear();
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 2, stderr: '' }));
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/test.ts');

    // The `&& error.stderr` arm must suppress the log when stderr is empty.
    const stderrLogs = mockLog.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('expected'),
    );
    expect(stderrLogs).toHaveLength(0);
    vi.mocked(isVerbose).mockReturnValue(false);
  });

  // ─── A1: original / mutated population ─────────────────────────────────

  it('A1: populates original (sliced from source) and mutated (replacement)', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        files: {
          'src/x.ts': {
            source: 'const x = a > b;\n',
            mutants: [
              {
                id: '1',
                mutatorName: 'ConditionalExpression',
                replacement: 'a >= b',
                location: { start: { line: 1, column: 11 }, end: { line: 1, column: 16 } },
                status: 'Survived',
              },
            ],
          },
        },
      }),
    );
    const result = engine.parseReport('/wd', 'src/x.ts');
    const vuln = result.vulnerabilities.find((v) => v.line === 1);
    expect(vuln?.original).toBe('a > b');
    expect(vuln?.mutated).toBe('a >= b');
  });

  it('A1: omits original (no throw) when location is out of range, still sets mutated', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        files: {
          'src/x.ts': {
            source: 'short\n',
            mutants: [
              {
                id: '2',
                mutatorName: 'BooleanLiteral',
                replacement: 'false',
                location: { start: { line: 99, column: 1 }, end: { line: 99, column: 5 } },
                status: 'Survived',
              },
            ],
          },
        },
      }),
    );
    const result = engine.parseReport('/wd', 'src/x.ts');
    const vuln = result.vulnerabilities.find((v) => v.mutator === 'BooleanLiteral');
    expect(vuln?.original).toBeUndefined();
    expect(vuln?.mutated).toBe('false');
  });

  it('A1: leaves original/mutated unset when replacement is empty and span unsliceable', () => {
    // Mirrors the existing makeJsonReport fixtures (column 0, empty replacement).
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        files: {
          'src/x.ts': {
            source: 'const x = 1;',
            mutants: [
              {
                id: '3',
                mutatorName: 'ArithmeticOperator',
                replacement: '',
                location: { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
                status: 'Survived',
              },
            ],
          },
        },
      }),
    );
    const result = engine.parseReport('/wd', 'src/x.ts');
    const vuln = result.vulnerabilities[0];
    expect(vuln.original).toBeUndefined();
    expect(vuln.mutated).toBeUndefined();
  });

  it('A1: slices a multi-line original span across lines', () => {
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        files: {
          'src/x.ts': {
            source: 'a >\nb',
            mutants: [
              {
                id: '1',
                mutatorName: 'ConditionalExpression',
                replacement: 'a >= b',
                location: { start: { line: 1, column: 1 }, end: { line: 2, column: 2 } },
                status: 'Survived',
              },
            ],
          },
        },
      }),
    );
    const result = engine.parseReport('/wd', 'src/x.ts');
    expect(result.vulnerabilities[0].original).toBe('a >\nb');
  });

  // ─── Malformed report entries must not escape as raw TypeErrors ─────────

  it('skips a null file entry and a location-less mutant instead of crashing', () => {
    const mutants: unknown[] = [
      { id: '1', mutatorName: 'NoLocation', replacement: 'x', status: 'Survived' },
      null,
      { id: '3', mutatorName: 'EmptyLocation', replacement: 'z', location: {}, status: 'Survived' },
      {
        id: '4',
        mutatorName: 'BooleanLiteral',
        replacement: 'false',
        location: { start: { line: 1, column: 1 }, end: { line: 1, column: 6 } },
        status: 'Survived',
      },
    ];
    mockReadFileSync.mockReturnValue(
      JSON.stringify({
        files: {
          'src/null.ts': null,
          'src/x.ts': { source: 'const x = 1;', mutants },
        },
      }),
    );

    const result = engine.parseReport('/wd', 'src/x.ts');
    expect(result.totalMutants).toBe(1);
    expect(result.survived).toBe(1);
    expect(result.vulnerabilities.map((v) => v.mutator)).toEqual(['BooleanLiteral']);
  });

  it('does not throw when the report parses to null', () => {
    mockReadFileSync.mockReturnValue('null');
    const result = engine.parseReport('/wd', 'src/x.ts');
    expect(result.totalMutants).toBe(0);
    expect(result.mutationScore).toBe('100.00%');
  });

  // ─── A2: lineRanges multi-range scoping ─────────────────────────────────

  it('A2: emits one --mutate range for a single lineScope (unchanged behavior)', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    await engine.run('src/app.ts', { lineScope: { start: 10, end: 20 } });
    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--mutate', 'src/app.ts:10-20')).toBe(true);
  });

  it('A2: emits comma-joined --mutate patterns for multiple lineRanges', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    await engine.run('src/app.ts', {
      lineRanges: [
        { start: 3, end: 5 },
        { start: 20, end: 20 },
      ],
    });
    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--mutate', 'src/app.ts:3-5,src/app.ts:20-20')).toBe(true);
  });

  it('A2: lineRanges takes precedence over lineScope', async () => {
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(makeJsonReport([]));
    await engine.run('src/app.ts', {
      lineScope: { start: 1, end: 2 },
      lineRanges: [{ start: 40, end: 44 }],
    });
    const argList = mockRunShell.mock.calls[0]?.[1] as string[];
    expect(argArgsContain(argList, '--mutate', 'src/app.ts:40-44')).toBe(true);
  });

  it('does not emit the NoCoverage heads-up when there are zero NoCoverage mutants', async () => {
    const { isVerbose, log } = await import('../utils/logger.js');
    vi.mocked(isVerbose).mockReturnValue(true);
    const mockLog = vi.mocked(log);
    mockLog.mockClear();
    mockRunShell.mockResolvedValue(makeExecResult());
    mockReadFileSync.mockReturnValue(
      makeJsonReport([{ status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 }]),
    );

    await engine.run('src/test.ts');

    // `noCoverage > 0` must be strict — zero NoCoverage mutants log nothing.
    const noCovLogs = mockLog.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).includes('NoCoverage'),
    );
    expect(noCovLogs).toHaveLength(0);
    vi.mocked(isVerbose).mockReturnValue(false);
  });
});

describe('planLineBatches: budget awareness', () => {
  it('never plans more batches than the budget can start', () => {
    // 2000 lines / 80 = 25 batches by line count, but a 300s budget can only
    // fund floor(300000 / 15000) = 20 startups.
    const batches = planLineBatches(2000, undefined, 300_000);
    expect(batches.length).toBeLessThanOrEqual(20);
  });

  it('still covers the whole requested span when it widens the batches', () => {
    const batches = planLineBatches(2000, undefined, 300_000);
    expect(batches[0].start).toBe(1);
    expect(batches[batches.length - 1].end).toBe(2000);
    for (let i = 1; i < batches.length; i++) {
      expect(batches[i].start).toBe(batches[i - 1].end + 1);
    }
  });

  it('falls back to a single batch when the budget funds only one startup', () => {
    const batches = planLineBatches(2000, undefined, 20_000);
    expect(batches).toEqual([]);
  });

  it('keeps the line-count plan when no budget is supplied', () => {
    expect(planLineBatches(2000).length).toBe(25);
  });

  it('falls back to unbatched when there are more ranges than the budget can start (one per diff hunk)', () => {
    // 25 five-line hunks: `spanned`-based sizing would still try to fund
    // ceil(125/80) = 2 "batches" worth of step, but each of the 25 ranges
    // emits its OWN batch regardless of step, so the emitted count is 25 — and
    // a 300s budget only affords floor(300000 / 15000) = 20 startups. This is
    // exactly the "0 of N planned batches completed" regression: without the
    // emitted-count check, this used to plan 25 unfundable batches instead of
    // falling back to one invocation that covers every hunk.
    const ranges = Array.from({ length: 25 }, (_, i) => ({ start: i * 10 + 1, end: i * 10 + 5 }));
    expect(planLineBatches(0, ranges, 300_000)).toEqual([]);
  });

  it('falls back to unbatched when ONE oversized range among several inflates the emitted count past what a range-count check alone would catch', () => {
    // Two ranges — a 2000-line one and an 11-line one — at a 30s budget
    // (affordable=2). A range-COUNT proxy (requested.length=2) would wrongly
    // let this through, because 2 is not greater than 2. But the 2000-line
    // range alone splits into 2 batches under the shared step, so the loop
    // actually emits 3 batches against only 2 affordable start-ups. Counting
    // the emitted array (not the range count) is what catches this.
    const batches = planLineBatches(
      4000,
      [
        { start: 1, end: 2000 },
        { start: 3000, end: 3010 },
      ],
      30_000,
    );
    expect(batches).toEqual([]);
  });

  it('still batches multiple ranges normally when the budget can start one per range', () => {
    // 3 ranges, each well under COMMAND_BATCH_LINES so each yields exactly one
    // batch: a budget that can start 3 (45s / 15s) should batch, not fall back.
    const ranges = [
      { start: 1, end: 30 },
      { start: 100, end: 129 },
      { start: 200, end: 229 },
    ];
    expect(planLineBatches(0, ranges, 45_000)).toEqual(ranges);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildStrykerArgs — the argv builder extracted out of runOnce. It is pure (no
// filesystem, no environment), so the whole flag matrix is assertable as plain
// string arrays instead of by driving a run through the exec mock.
// ─────────────────────────────────────────────────────────────────────────────
describe('buildStrykerArgs', () => {
  const BASE = [
    'npx',
    '--no-install',
    'stryker',
    'run',
    '--mutate',
    'src/app.ts',
    '--testRunner',
    'command',
    '--reporters',
    'json',
    '--logLevel',
    'off',
    '--cleanTempDir',
    'true',
    '--tempDirName',
    '.stryker-tmp',
  ];

  it('builds the baseline argv for a native run with no options', () => {
    expect(buildStrykerArgs('command', 'src/app.ts', undefined)).toEqual(BASE);
    expect(buildStrykerArgs('command', 'src/app.ts', undefined, {})).toEqual(BASE);
  });

  it('drops the npx launcher when the executor is a container', () => {
    const args = buildStrykerArgs('command', 'src/app.ts', undefined, {
      executor: {
        kind: 'container',
        workDir: '/sb',
        run: vi.fn(),
        runCommand: vi.fn(),
        dispose: vi.fn(),
      },
    });
    expect(args.slice(0, 2)).toEqual(['stryker', 'run']);
    expect(args).not.toContain('npx');
  });

  it('inserts the runtime config immediately after `run`', () => {
    const args = buildStrykerArgs('command', 'src/app.ts', '.chaos-mcp.stryker.config.mjs');
    expect(args.slice(0, 5)).toEqual([
      'npx',
      '--no-install',
      'stryker',
      'run',
      '.chaos-mcp.stryker.config.mjs',
    ]);
  });

  it('passes the resolved runner and mutate argument through verbatim', () => {
    const args = buildStrykerArgs('vitest', 'src/app.ts:3-5,src/app.ts:20-20', undefined);
    expect(argArgsContain(args, '--testRunner', 'vitest')).toBe(true);
    expect(argArgsContain(args, '--mutate', 'src/app.ts:3-5,src/app.ts:20-20')).toBe(true);
  });

  it('adds the runner plugin pair, keeping the wildcard, for every known runner', () => {
    for (const [runner, plugin] of Object.entries({
      vitest: '@stryker-mutator/vitest-runner',
      jest: '@stryker-mutator/jest-runner',
      mocha: '@stryker-mutator/mocha-runner',
      jasmine: '@stryker-mutator/jasmine-runner',
      karma: '@stryker-mutator/karma-runner',
    })) {
      const args = buildStrykerArgs(runner, 'src/app.ts', undefined);
      expect(argPairPresent(args, '--plugins', '@stryker-mutator/*')).toBe(true);
      expect(argPairPresent(args, '--plugins', plugin)).toBe(true);
    }
  });

  it('adds no --plugins for the built-in command runner or an unknown runner', () => {
    expect(buildStrykerArgs('command', 'src/app.ts', undefined)).not.toContain('--plugins');
    expect(buildStrykerArgs('my-custom-runner', 'src/app.ts', undefined)).not.toContain(
      '--plugins',
    );
  });

  it('never resolves an inherited Object.prototype member as a plugin package', () => {
    for (const runner of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      expect(buildStrykerArgs(runner, 'src/app.ts', undefined)).not.toContain('--plugins');
    }
  });

  it('appends --concurrency only for a positive number', () => {
    expect(
      argArgsContain(
        buildStrykerArgs('command', 'src/app.ts', undefined, { concurrency: 4 }),
        '--concurrency',
        '4',
      ),
    ).toBe(true);
    expect(buildStrykerArgs('command', 'src/app.ts', undefined, { concurrency: 0 })).not.toContain(
      '--concurrency',
    );
    expect(buildStrykerArgs('command', 'src/app.ts', undefined, { concurrency: -2 })).not.toContain(
      '--concurrency',
    );
  });

  it('appends --dryRunOnly (never the removed v8 --dryRun) for a dry run', () => {
    const args = buildStrykerArgs('command', 'src/app.ts', undefined, { dryRun: true });
    expect(args).toContain('--dryRunOnly');
    expect(args).not.toContain('--dryRun');
  });

  it('appends the incremental flag and its sandbox-relative file', () => {
    const args = buildStrykerArgs('command', 'src/app.ts', undefined, { incremental: true });
    expect(args).toContain('--incremental');
    expect(argArgsContain(args, '--incrementalFile', '.stryker-incremental.json')).toBe(true);
  });

  it('appends --timeoutMs only for a positive perMutantTimeoutMs', () => {
    expect(
      argArgsContain(
        buildStrykerArgs('command', 'src/app.ts', undefined, { perMutantTimeoutMs: 10_000 }),
        '--timeoutMs',
        '10000',
      ),
    ).toBe(true);
    expect(
      buildStrykerArgs('command', 'src/app.ts', undefined, { perMutantTimeoutMs: 0 }),
    ).not.toContain('--timeoutMs');
  });

  it('emits every optional flag in a stable order when all are requested', () => {
    expect(
      buildStrykerArgs('vitest', 'src/app.ts', 'cfg.mjs', {
        concurrency: 2,
        dryRun: true,
        incremental: true,
        perMutantTimeoutMs: 7,
      }),
    ).toEqual([
      'npx',
      '--no-install',
      'stryker',
      'run',
      'cfg.mjs',
      '--mutate',
      'src/app.ts',
      '--testRunner',
      'vitest',
      '--reporters',
      'json',
      '--logLevel',
      'off',
      '--cleanTempDir',
      'true',
      '--tempDirName',
      '.stryker-tmp',
      '--plugins',
      '@stryker-mutator/*',
      '--plugins',
      '@stryker-mutator/vitest-runner',
      '--concurrency',
      '2',
      '--dryRunOnly',
      '--incremental',
      '--incrementalFile',
      '.stryker-incremental.json',
      '--timeoutMs',
      '7',
    ]);
  });

  it('touches no filesystem mock — it is pure', () => {
    vi.clearAllMocks();
    buildStrykerArgs('vitest', 'src/app.ts', 'cfg.mjs', { incremental: true, dryRun: true });
    expect(mockExistsSync).not.toHaveBeenCalled();
    expect(mockReadFileSync).not.toHaveBeenCalled();
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyStrykerFailure — the exit-code triage extracted out of runOnce.
// Returning (rather than throwing) means "expected non-zero, go parse the
// report". Branch order is most-specific-first and is load-bearing.
// ─────────────────────────────────────────────────────────────────────────────
describe('classifyStrykerFailure', () => {
  /**
   * Run the classifier and hand back whatever it threw (undefined if it returned).
   *
   * `reportExists` defaults to false — the startup-class cases below never reach
   * the report check, and the exit-1 cases are asserting the no-report branch.
   * The recoverable "exit 1 WITH a report" path has its own dedicated tests.
   */
  const thrownBy = (error: unknown, filePath = 'src/app.ts', reportExists = false): unknown => {
    try {
      classifyStrykerFailure(error, filePath, reportExists);
      return undefined;
    } catch (caught) {
      return caught;
    }
  };

  it('rethrows an ABORTED ExecFailureError untouched, ahead of every other branch', () => {
    // The marker `isCancel` keys on only survives if the SAME object comes back
    // out. Ordered first because an aborted child otherwise looks like an
    // ordinary `exit: null` failure and is waved through to parseReport.
    const aborted = makeExecFailure({ code: 'ABORTED', signal: 'SIGKILL', exit: null });
    expect(thrownBy(aborted)).toBe(aborted);
    // Even with a report on disk it is still a cancel, never a recoverable exit.
    expect(thrownBy(aborted, 'src/app.ts', true)).toBe(aborted);
  });

  it('re-types a startup TIMEOUT as StrykerTimeoutError, preserving message and cause', () => {
    const startup = new MutationToolStartupError('StrykerJS', 'StrykerJS timed out after 5000ms.');
    const thrown = thrownBy(startup);
    expect(thrown).toBeInstanceOf(StrykerTimeoutError);
    expect((thrown as StrykerTimeoutError).code).toBe('TIMEOUT');
    expect((thrown as Error).message).toBe('StrykerJS timed out after 5000ms.');
    expect((thrown as Error).cause).toBe(startup);
  });

  it('anchors the timeout check at the start, so tool-controlled text cannot forge it', () => {
    const forged = new MutationToolStartupError(
      'StrykerJS',
      'StrykerJS crashed unexpectedly: StrykerJS timed out after 5000ms.',
    );
    const thrown = thrownBy(forged);
    expect(thrown).not.toBeInstanceOf(StrykerTimeoutError);
    expect((thrown as Error).message).toBe(
      'StrykerJS crashed unexpectedly: StrykerJS timed out after 5000ms.',
    );
  });

  it('surfaces other startup failures verbatim as a plain Error', () => {
    const notInstalled = new MutationToolStartupError(
      'StrykerJS',
      'StrykerJS is not installed. Install it with: npm install --save-dev @stryker-mutator/core',
    );
    const thrown = thrownBy(notInstalled);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(StrykerTimeoutError);
    expect((thrown as Error).message).toBe(notInstalled.message);
  });

  it('rethrows a non-ExecFailure Error unchanged', () => {
    const boom = new Error('boom');
    expect(() => classifyStrykerFailure(boom, 'src/app.ts', false)).toThrow(boom);
  });

  it('wraps a non-Error throwable', () => {
    expect(() => classifyStrykerFailure('kaput', 'src/app.ts', false)).toThrow(
      'Stryker execution failed: kaput',
    );
  });

  it('names the file when exit 1 reports that no tests were executed', () => {
    expect(() =>
      classifyStrykerFailure(
        makeExecFailure({ exit: 1, stderr: 'ERROR No tests were executed. Stopping.' }),
        'src/app.ts',
        false,
      ),
    ).toThrow(
      'StrykerJS ran zero tests in its dry run — no tests in this project appear to cover src/app.ts. ' +
        'Add a test file exercising it, or check the test runner configuration if tests exist.',
    );
  });

  it('reports any other exit 1 as a configuration error, capped at 500 chars of stderr', () => {
    const stderr = 'x'.repeat(600);
    expect(() =>
      classifyStrykerFailure(makeExecFailure({ exit: 1, stderr }), 'src/app.ts', false),
    ).toThrow(`StrykerJS configuration or internal error (exit 1): ${'x'.repeat(500)}`);
  });

  it('falls back to the error message when exit 1 carries no stderr', () => {
    expect(() =>
      classifyStrykerFailure(makeExecFailure({ exit: 1, stderr: '' }), 'src/app.ts', false),
    ).toThrow('StrykerJS configuration or internal error (exit 1): Command failed');
  });

  it('returns for exit 2 and other non-zero exits — the report is still parseable', () => {
    expect(
      classifyStrykerFailure(makeExecFailure({ exit: 2 }), 'src/app.ts', false),
    ).toBeUndefined();
    expect(
      classifyStrykerFailure(makeExecFailure({ exit: 3 }), 'src/app.ts', false),
    ).toBeUndefined();
    expect(
      classifyStrykerFailure(makeExecFailure({ exit: null }), 'src/app.ts', false),
    ).toBeUndefined();
  });
});

describe('dryRunResult', () => {
  it('reports the distinct dry-run shape: no mutants and a non-numeric score', () => {
    expect(dryRunResult('src/app.ts')).toEqual({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: 'n/a (dry run)',
      vulnerabilities: [],
      scopeNote:
        'Dry run only: the test suite executed successfully against the sandboxed file. ' +
        'No mutants were generated — re-run without dryRun to score coverage.',
    });
  });
});

describe('prepareStrykerConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('rejects a mutator allowlist, listing what was requested', () => {
    expect(() => prepareStrykerConfig('/sb', { mutatorAllowlist: ['ArithmeticOperator'] })).toThrow(
      'mutatorAllowlist is not supported in StrykerJS v9. ' +
        'Use mutatorDenylist instead, or create a stryker.config.json with explicit mutator settings. ' +
        'Requested allowlist: ArithmeticOperator',
    );
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });

  // Stryker is never left to its own config discovery: which of the sixteen
  // stryker.conf|config.{json,js,mjs,cjs} names it picks decides whether the
  // denylist is honoured at all, and where the JSON report is written.
  it('always writes the overlay and selects it, even for a plain run', () => {
    expect(prepareStrykerConfig('/sb', {})).toBe('.chaos-mcp.stryker.config.mjs');
    const [path] = vi.mocked(writeFileSync).mock.calls[0];
    expect(path).toBe('/sb/.chaos-mcp.stryker.config.mjs');
  });

  it('writes the runtime overlay and returns its name for a command-runner run', () => {
    expect(prepareStrykerConfig('/sb', { commandRunnerCommand: 'npm test' })).toBe(
      '.chaos-mcp.stryker.config.mjs',
    );
    const [path, contents] = vi.mocked(writeFileSync).mock.calls[0];
    expect(path).toBe('/sb/.chaos-mcp.stryker.config.mjs');
    expect(String(contents)).toContain("testRunner: 'command'");
  });

  it('routes a denylist-only run through the overlay too, without a runner override', () => {
    expect(
      prepareStrykerConfig('/sb', { testRunner: 'vitest', mutatorDenylist: ['BlockStatement'] }),
    ).toBe('.chaos-mcp.stryker.config.mjs');
    const [path, contents] = vi.mocked(writeFileSync).mock.calls[0];
    expect(path).toBe('/sb/.chaos-mcp.stryker.config.mjs');
    expect(String(contents)).toContain('...["BlockStatement"],');
    expect(String(contents)).not.toContain("testRunner: 'command'");
  });

  it('writes exactly one config file per run', () => {
    expect(
      prepareStrykerConfig('/sb', {
        commandRunnerCommand: 'npm test',
        mutatorDenylist: ['BlockStatement'],
      }),
    ).toBe('.chaos-mcp.stryker.config.mjs');
    expect(vi.mocked(writeFileSync)).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Report provenance, status classification, and the structural scope field.
// ─────────────────────────────────────────────────────────────────────────────
describe('report handling', () => {
  let engine: TypeScriptEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new TypeScriptEngine();
    mockExistsSync.mockReturnValue(true);
    mockRunShell.mockResolvedValue(makeExecResult());
  });

  // `parseReport` guards a FIXED path with nothing but existsSync, which cannot
  // tell this invocation's report from the previous batch's — `runBatched` calls
  // `runOnce` N times against the same cwd and `mergeBatchResults` SUMS totals
  // and CONCATENATES vulnerabilities, so a re-read produces double-counted
  // mutants and duplicate (line, mutator) suppression keys. Nor from one the
  // audited workspace shipped: ALWAYS_EXCLUDE (utils/sandbox.ts) does not
  // exclude `reports/`. Deleting first makes a missing report an honest error.
  it('deletes any stale JSON report before invoking Stryker, once per batch', async () => {
    const mockRm = vi.mocked(rmSync);
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      String(p).endsWith('src/large.ts')
        ? Array.from({ length: 121 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([]),
    );

    await engine.run('src/large.ts', {
      workDir: '/sb',
      testRunner: 'command',
      timeoutMs: 30_000,
    });

    expect(mockRunShell).toHaveBeenCalledTimes(2);
    expect(mockRm.mock.calls).toEqual([
      ['/sb/reports/mutation/mutation.json', { force: true }],
      ['/sb/reports/mutation/mutation.json', { force: true }],
    ]);
  });

  it('deletes the report BEFORE the run, never after it', async () => {
    const order: string[] = [];
    vi.mocked(rmSync).mockImplementation(() => {
      order.push('rm');
    });
    mockRunShell.mockImplementation(() => {
      order.push('run');
      return Promise.resolve(makeExecResult());
    });
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    await engine.run('src/app.ts', { workDir: '/sb', testRunner: 'vitest' });

    expect(order).toEqual(['rm', 'run']);
  });

  it('still runs when the stale report cannot be removed', async () => {
    vi.mocked(rmSync).mockImplementation(() => {
      throw new Error('EPERM');
    });
    mockReadFileSync.mockReturnValue(
      makeJsonReport([{ status: 'Killed', mutatorName: 'BooleanLiteral', line: 1 }]),
    );

    const result = await engine.run('src/app.ts', { workDir: '/sb', testRunner: 'vitest' });
    expect(result.killed).toBe(1);
  });

  // engines/base.ts documents `incompetent` as covering "Stryker compile
  // errors", and format.ts has a guarded branch that reports it — but this
  // engine never set the field, so a file where mutants fail to compile showed a
  // shrunken total with no explanation of the missing mutants (gap audit I3).
  it('counts CompileError and RuntimeError as incompetent, outside the denominator', () => {
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Killed', mutatorName: 'A', line: 1 },
        { status: 'Survived', mutatorName: 'B', line: 2 },
        { status: 'CompileError', mutatorName: 'C', line: 3 },
        { status: 'CompileError', mutatorName: 'D', line: 4 },
        { status: 'RuntimeError', mutatorName: 'E', line: 5 },
      ]),
    );

    const result = engine.parseReport('/wd', 'src/x.ts');

    expect(result.totalMutants).toBe(2);
    expect(result.killed).toBe(1);
    expect(result.survived).toBe(1);
    expect(result.incompetent).toBe(3);
    expect(result.mutationScore).toBe('50.00%');
  });

  // `Ignored` is the operator's own choice (mutator.excludedMutations, `Stryker
  // disable` comments), not a failure — reporting it as incompetent would blame
  // the project for something it asked for.
  it('keeps Ignored separate from incompetent and out of the score', () => {
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Killed', mutatorName: 'A', line: 1 },
        { status: 'Ignored', mutatorName: 'B', line: 2 },
        { status: 'Ignored', mutatorName: 'C', line: 3 },
      ]),
    );

    const result = engine.parseReport('/wd', 'src/x.ts');

    expect(result.totalMutants).toBe(1);
    expect(result.incompetent).toBeUndefined();
    expect(vi.mocked(warn)).not.toHaveBeenCalled();
  });

  // The filter used to be a DENY-list (everything except CompileError/
  // RuntimeError/Ignored counted), so any status the schema gains later landed
  // in the denominator as "valid but neither killed nor survived", silently
  // lowering the score. mutation-testing-report-schema@3.7.3 already declares a
  // "Pending" status this engine never handled.
  it('excludes unrecognised statuses from the score and warns once, naming each', () => {
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Killed', mutatorName: 'A', line: 1 },
        { status: 'Pending', mutatorName: 'B', line: 2 },
        { status: 'Pending', mutatorName: 'C', line: 3 },
        { status: 'SomethingNew', mutatorName: 'D', line: 4 },
      ]),
    );

    const result = engine.parseReport('/wd', 'src/x.ts');

    // Denominator is 1, not 4 — the score is not diluted by statuses we cannot judge.
    expect(result.totalMutants).toBe(1);
    expect(result.mutationScore).toBe('100.00%');
    expect(vi.mocked(warn)).toHaveBeenCalledTimes(1);
    const message = String(vi.mocked(warn).mock.calls[0][0]);
    expect(message).toContain('Pending (2)');
    expect(message).toContain('SomethingNew (1)');
    expect(message).toContain('src/x.ts');
  });

  it('does not warn when every status is recognised', () => {
    mockReadFileSync.mockReturnValue(
      makeJsonReport([
        { status: 'Killed', mutatorName: 'A', line: 1 },
        { status: 'Survived', mutatorName: 'B', line: 2 },
        { status: 'NoCoverage', mutatorName: 'C', line: 3 },
        { status: 'Timeout', mutatorName: 'D', line: 4 },
        { status: 'CompileError', mutatorName: 'E', line: 5 },
        { status: 'Ignored', mutatorName: 'F', line: 6 },
      ]),
    );

    const result = engine.parseReport('/wd', 'src/x.ts');

    expect(result.totalMutants).toBe(4);
    // Timeout counts as killed — the mutant was detected by hanging the suite.
    expect(result.killed).toBe(2);
    expect(vi.mocked(warn)).not.toHaveBeenCalled();
  });

  // hasNoMutableLogic (score-semantics.ts) must not key on the presence of free-text
  // prose. These pin the structural discriminator the engine now emits.
  it('labels an unscoped single run whole-file and a line-scoped one scoped', async () => {
    mockReadFileSync.mockReturnValue(makeJsonReport([]));

    const whole = await engine.run('src/app.ts', { workDir: '/sb', testRunner: 'vitest' });
    expect(whole.scopeKind).toBe('whole-file');

    const scopedRange = await engine.run('src/app.ts', {
      workDir: '/sb',
      testRunner: 'vitest',
      lineScope: { start: 1, end: 10 },
    });
    expect(scopedRange.scopeKind).toBe('scoped');

    const scopedRanges = await engine.run('src/app.ts', {
      workDir: '/sb',
      testRunner: 'vitest',
      lineRanges: [{ start: 1, end: 10 }],
    });
    expect(scopedRanges.scopeKind).toBe('scoped');
  });

  it('labels a batched whole-file run whole-file, despite every batch being line-scoped', async () => {
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      String(p).endsWith('src/large.ts')
        ? Array.from({ length: 121 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([]),
    );

    const result = await engine.run('src/large.ts', {
      workDir: '/sb',
      testRunner: 'command',
      timeoutMs: 30_000,
    });

    expect(result.batchesPlanned).toBe(2);
    // The scopeNote is present on every batched run — which is exactly why
    // hasNoMutableLogic cannot be inferred from it.
    expect(result.scopeNote).toBeTruthy();
    expect(result.scopeKind).toBe('whole-file');
  });

  it('labels a batched line-scoped run scoped', async () => {
    mockReadFileSync.mockImplementation((p: PathOrFileDescriptor) =>
      String(p).endsWith('src/large.ts')
        ? Array.from({ length: 300 }, () => 'const x = 1;').join('\n')
        : makeJsonReport([]),
    );

    const result = await engine.run('src/large.ts', {
      workDir: '/sb',
      testRunner: 'command',
      // 45s affords floor(45000 / 15000) = 3 startups, needed for the 200-line
      // requested range to still plan 3 batches under the new floor.
      timeoutMs: 45_000,
      lineRanges: [{ start: 1, end: 200 }],
    });

    expect(result.batchesPlanned).toBe(3);
    expect(result.scopeKind).toBe('scoped');
  });

  it('leaves scopeKind unset for a dry run, which enumerated nothing', () => {
    expect(dryRunResult('src/app.ts').scopeKind).toBeUndefined();
  });
});

/**
 * Helper: the value passed after `--mutate`.
 *
 * Indexed lookups used to be fine because `--mutate` sat at a fixed offset, but
 * every run now carries the generated overlay config as Stryker's `configFile`
 * argument right after `run`, so the offset moved. Looking the flag up by name
 * keeps these assertions about the mutate scope rather than about argv layout.
 */
function mutateValueOf(args: string[]): string | undefined {
  const idx = args.indexOf('--mutate');
  return idx === -1 ? undefined : args[idx + 1];
}

/** Helper: check if an args array contains a flag-value pair. */
function argArgsContain(args: string[], flag: string, value: string): boolean {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] === value;
}

// Like argArgsContain but matches the (flag value) pair at ANY position, so it
// works for flags that legitimately repeat (e.g. --plugins A --plugins B).
function argPairPresent(args: string[], flag: string, value: string): boolean {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag && args[i + 1] === value) return true;
  }
  return false;
}

describe('native vitest runner → command runner fallback', () => {
  const DRY_RUN_STDERR = 'ConfigError: There were failed tests in the initial test run.';

  function runnerArgOf(callIndex: number): string | undefined {
    const argv = mockRunShell.mock.calls[callIndex]?.[1] as string[] | undefined;
    if (!argv) return undefined;
    const at = argv.indexOf('--testRunner');
    return at === -1 ? undefined : argv[at + 1];
  }

  beforeEach(() => {
    // No report on disk → classifyStrykerFailure treats exit 1 as a real
    // failure rather than a threshold break.
    mockExistsSync.mockImplementation((p: PathLike) => !String(p).endsWith('mutation.json'));
  });

  it('retries on the command runner when the native runner fails its dry run', async () => {
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 1, stderr: DRY_RUN_STDERR }));
    const engine = new TypeScriptEngine();

    // Both attempts fail here; what is asserted is that a SECOND attempt was
    // made and that it switched runners.
    await expect(engine.run('src/a.ts', { workDir: '/sb', testRunner: 'vitest' })).rejects.toThrow(
      /initial test run/,
    );

    expect(mockRunShell).toHaveBeenCalledTimes(2);
    expect(runnerArgOf(0)).toBe('vitest');
    expect(runnerArgOf(1)).toBe('command');
    expect(vi.mocked(warn)).toHaveBeenCalledWith(expect.stringContaining('command runner'));
  });

  it('does NOT retry when the operator pinned the runner themselves', async () => {
    // testRunnerTrusted marks a runner named in the operator's own config.
    // Silently switching it would be overriding an explicit instruction.
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 1, stderr: DRY_RUN_STDERR }));
    const engine = new TypeScriptEngine();

    await expect(
      engine.run('src/a.ts', { workDir: '/sb', testRunner: 'vitest', testRunnerTrusted: true }),
    ).rejects.toThrow(/initial test run/);

    expect(mockRunShell).toHaveBeenCalledTimes(1);
    expect(vi.mocked(warn)).not.toHaveBeenCalledWith(expect.stringContaining('command runner'));
  });

  it('does NOT retry a failure from a phase other than the dry run', async () => {
    // Retrying an ordinary failure would double the cost of every genuinely
    // broken run for no benefit.
    mockRunShell.mockRejectedValue(
      makeExecFailure({ exit: 1, stderr: 'Error: something else entirely' }),
    );
    const engine = new TypeScriptEngine();

    await expect(engine.run('src/a.ts', { workDir: '/sb', testRunner: 'vitest' })).rejects.toThrow(
      /configuration or internal error/,
    );

    expect(mockRunShell).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry when the resolved runner is not the native vitest one', async () => {
    mockRunShell.mockRejectedValue(makeExecFailure({ exit: 1, stderr: DRY_RUN_STDERR }));
    const engine = new TypeScriptEngine();

    await expect(engine.run('src/a.ts', { workDir: '/sb', testRunner: 'command' })).rejects.toThrow(
      /initial test run/,
    );

    expect(mockRunShell).toHaveBeenCalledTimes(1);
  });
});
