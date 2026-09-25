/**
 * Regression coverage for a triage sweep that never produced a result on a
 * memory-constrained host (WSL2, 6.2 GB, 2.7 to 3.8 GB free).
 *
 * The admission gate charged a grouped unit (up to four vitest files in one
 * Stryker run) four times the per-file cost. That never fit what the machine
 * had free, and with no run of the sweep's own in flight nothing would ever
 * release memory, so the sweep waited out its whole deadline with no child
 * process alive, sent no progress (the client's idle timeout killed it) and
 * reported every file as `time_budget_exhausted` without saying why. An engine
 * that was not even installed never got the chance to fail.
 *
 * Uses the REAL watchdog with a scripted probe, so the gate under test is the
 * one production runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

vi.mock('../triage/discover-files.js', async () => {
  const actual = await vi.importActual<typeof import('../triage/discover-files.js')>(
    '../triage/discover-files.js',
  );
  return { ...actual, discoverFiles: vi.fn(), discoverChangedFiles: vi.fn() };
});
vi.mock('../utils/sandbox.js', () => ({
  createSandbox: vi.fn(() => ({ workDir: '/tmp/s', targetFile: '', cleanup: vi.fn() })),
}));
vi.mock('../utils/project-detector.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/project-detector.js')>(
    '../utils/project-detector.js',
  );
  return { ...actual, detectEnvironment: vi.fn() };
});
vi.mock('../audit/audit-file.js', async () => {
  const actual =
    await vi.importActual<typeof import('../audit/audit-file.js')>('../audit/audit-file.js');
  return { ...actual, auditFile: vi.fn() };
});
const { runGroup } = vi.hoisted(() => ({ runGroup: vi.fn() }));
vi.mock('../engines/registry.js', async () => {
  const actual =
    await vi.importActual<typeof import('../engines/registry.js')>('../engines/registry.js');
  return { ...actual, makeEngine: vi.fn(() => ({ run: vi.fn(), runGroup })) };
});
vi.mock('../utils/suppression.js', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/suppression.js')>('../utils/suppression.js');
  return { ...actual, loadSuppressions: vi.fn(() => new Map()) };
});
vi.mock('../core/resource-context.js', () => ({
  createResourceContext: vi.fn(),
}));

import { discoverFiles } from '../triage/discover-files.js';
import { detectEnvironment } from '../utils/project-detector.js';
import { auditFile } from '../audit/audit-file.js';
import { createResourceContext } from '../core/resource-context.js';
import { createWatchdog, type Watchdog } from '../utils/resources/watchdog.js';
import { handleTriageCall } from '../triage-handler.js';

const mockDiscover = vi.mocked(discoverFiles);
const mockDetectEnv = vi.mocked(detectEnvironment);
const mockAuditFile = vi.mocked(auditFile);
const mockCreateResourceContext = vi.mocked(createResourceContext);

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
/** The host from the report: `limitBytes: 6213472256`. */
const LIMIT = 6_213_472_256;
/** TypeScript at two workers: 900 MiB fixed plus 2 x 320 MiB. */
const TS_FILE_COST = 900 * MIB + 2 * 320 * MIB;

const req = (args: Record<string, unknown>): CallToolRequest =>
  ({
    method: 'tools/call',
    params: { name: 'triage_test_coverage', arguments: args },
  }) as CallToolRequest;

const payloadOf = (res: { content: unknown[] }) =>
  JSON.parse((res.content[0] as { text: string }).text) as {
    ranking: { file: string }[];
    errors: { file: string; error: string }[];
    unaudited?: string[];
    stoppedReason?: string;
    note: string;
  };

const tsEnv = {
  projectType: 'typescript' as const,
  testRunner: 'vitest',
  detectedRunner: 'vitest',
  packageManager: '',
  workspaceRoot: process.cwd(),
};

const mrOf = () => ({
  target: 'f',
  totalMutants: 10,
  killed: 8,
  survived: 2,
  mutationScore: '80.00%',
  vulnerabilities: [],
});

const STRYKER_MISSING = 'StrykerJS is not installed in this workspace.';

/** A resource context around a real watchdog reading a fixed free-memory figure. */
function realResources(availableBytes: number, fileConcurrency: number): { watchdog: Watchdog } {
  const watchdog = createWatchdog({
    probe: () => ({ availableBytes, limitBytes: LIMIT, source: 'host' }),
    criticalBytes: 512 * MIB,
    admissionBytes: 1 * GIB,
    intervalMs: 50,
  });
  const resources = {
    budget: { fileConcurrency, perFileWorkers: 2, overBudget: fileConcurrency > 1 },
    watchdog,
    innerEnv: {},
    innerEnvFor: () => ({}),
    workerCostBytes: 320 * MIB,
    perFileCostBytes: TS_FILE_COST,
    report: () => ({
      availableAtStartBytes: availableBytes,
      limitBytes: LIMIT,
      source: 'host' as const,
      fileConcurrency,
      perFileWorkers: 2,
      overBudget: fileConcurrency > 1,
      watchdogTrips: watchdog.trips,
    }),
    dispose: () => watchdog.stop(),
  };
  mockCreateResourceContext.mockReturnValue(
    resources as unknown as ReturnType<typeof createResourceContext>,
  );
  return resources;
}

const SIX = ['s1.ts', 's2.ts', 's3.ts', 's4.ts', 's5.ts', 's6.ts'];

describe('triage_test_coverage on a memory-constrained host', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectEnv.mockReturnValue(tsEnv);
  });

  it('starts a grouped unit that costs more than is free instead of waiting out the deadline', async () => {
    mockDiscover.mockReturnValue({ files: SIX, discovered: 6, skipped: 0 });
    runGroup.mockResolvedValue(new Map());
    mockAuditFile.mockResolvedValue(mrOf());
    realResources(2_722_947_072, 2);

    const res = await handleTriageCall(
      req({ paths: ['src'], fileConcurrency: 2, totalTimeoutMs: 6_000 }),
    );
    const payload = payloadOf(res);

    expect(runGroup).toHaveBeenCalled();
    expect(payload.unaudited ?? []).toEqual([]);
    expect(payload.ranking.map((r) => r.file).sort()).toEqual(SIX);
  }, 15_000);

  it('reports a missing engine per file in errors[] instead of unaudited files', async () => {
    mockDiscover.mockReturnValue({ files: SIX, discovered: 6, skipped: 0 });
    runGroup.mockRejectedValue(new Error(STRYKER_MISSING));
    mockAuditFile.mockRejectedValue(new Error(STRYKER_MISSING));
    realResources(2_722_947_072, 2);

    const res = await handleTriageCall(
      req({ paths: ['src'], fileConcurrency: 2, totalTimeoutMs: 6_000 }),
    );
    const payload = payloadOf(res);

    expect(payload.unaudited ?? []).toEqual([]);
    expect(payload.stoppedReason).toBeUndefined();
    expect(payload.errors.map((e) => e.file).sort()).toEqual(SIX);
    expect(payload.errors.every((e) => e.error.includes(STRYKER_MISSING))).toBe(true);
  }, 15_000);

  it('says the sweep was held back for memory when nothing could ever be admitted', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf());
    // Below the critical floor: a run would be stopped on the next tick, so
    // the gate keeps waiting, and the result has to say that is why.
    realResources(300 * MIB, 1);

    const res = await handleTriageCall(
      req({ paths: ['src'], fileConcurrency: 1, totalTimeoutMs: 2_300 }),
    );
    const payload = payloadOf(res);

    expect(payload.unaudited).toEqual(['a.ts']);
    expect(payload.stoppedReason).toBe('insufficient_memory');
    expect(payload.note).toMatch(/free memory/);
    expect(mockAuditFile).not.toHaveBeenCalled();
  }, 10_000);

  it('registers a file with the watchdog even when it returns before running an engine', async () => {
    // An admission lease is only handed back by `register()`. A file that
    // returned early without registering left it charged for the rest of the
    // sweep, which also kept the gate from ever seeing itself as idle.
    mockDiscover.mockReturnValue({ files: ['a.ts', 'notes.txt'], discovered: 2, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf());
    const { watchdog } = realResources(4 * GIB, 1);
    const register = vi.spyOn(watchdog, 'register');

    const res = await handleTriageCall(req({ paths: ['src'], fileConcurrency: 1 }));

    expect(payloadOf(res).errors.map((e) => e.file)).toEqual(['notes.txt']);
    expect(register).toHaveBeenCalledTimes(2);
  });

  it('registers a grouped unit at its group cost even when it falls back before running', async () => {
    // Under 1 s of budget left after the cleanup reserve: the group gives up
    // with `contain` before starting Stryker, which used to be before its
    // registration too.
    mockDiscover.mockReturnValue({ files: ['a.ts', 'b.ts'], discovered: 2, skipped: 0 });
    mockAuditFile.mockResolvedValue(mrOf());
    const { watchdog } = realResources(4 * GIB, 1);
    const register = vi.spyOn(watchdog, 'register');

    await handleTriageCall(req({ paths: ['src'], fileConcurrency: 1, totalTimeoutMs: 2_900 }));

    expect(runGroup).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledWith(expect.any(AbortController), 2 * TS_FILE_COST);
  });
});

describe('triage_test_coverage progress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectEnv.mockReturnValue({ ...tsEnv, testRunner: 'command', detectedRunner: 'command' });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a file starting, before it finishes', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts', 'b.ts'], discovered: 2, skipped: 0 });
    const messages: string[] = [];
    const seenAtEngineStart: string[][] = [];
    mockAuditFile.mockImplementation(async () => {
      seenAtEngineStart.push([...messages]);
      return mrOf();
    });
    realResources(4 * GIB, 1);

    await handleTriageCall(req({ paths: ['src'], fileConcurrency: 1 }), undefined, {
      reportProgress: (_p, _t, message) => messages.push(message ?? ''),
    });

    expect(seenAtEngineStart[0]).toEqual(['auditing a.ts (0/2 done)']);
    expect(messages).toEqual([
      'auditing a.ts (0/2 done)',
      'audited 1/2',
      'auditing b.ts (1/2 done)',
      'audited 2/2',
    ]);
  });

  it('keeps reporting while one long file runs, with strictly increasing progress', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    let finish!: () => void;
    let started!: () => void;
    const engineStarted = new Promise<void>((resolve) => (started = resolve));
    mockAuditFile.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(mrOf());
          started();
        }),
    );
    realResources(4 * GIB, 1);
    const calls: { progress: number; message?: string }[] = [];

    const pending = handleTriageCall(req({ paths: ['src'], fileConcurrency: 1 }), undefined, {
      reportProgress: (progress, _t, message) => calls.push({ progress, message }),
    });
    await engineStarted;
    const beforeHeartbeat = calls.length;
    vi.advanceTimersByTime(65_000);
    const heartbeats = calls.slice(beforeHeartbeat);
    finish();
    await pending;

    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    expect(heartbeats.every((c) => c.message === 'still running, audited 0/1')).toBe(true);
    const values = calls.map((c) => c.progress);
    for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
    expect(values[values.length - 1]).toBe(1);
  });
});
