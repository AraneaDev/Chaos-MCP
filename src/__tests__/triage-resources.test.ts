/**
 * Coverage for Task 8: the sweep-level resource-governance wiring in
 * `triage-handler.ts` and `triage/audit-one.ts`.
 *
 * `createResourceContext` (core/resource-context.ts) is stubbed rather than
 * exercised for real, so these tests can drive its watchdog deterministically
 * (no real memory probing, no timers) and stay decoupled from the machine
 * running the suite. Follows the same style as `handler-resources.test.ts`
 * (Task 7's equivalent for the single-file audit) combined with the
 * fake-engine stubbing already used in `triage-handler.test.ts` (mocking
 * `auditFile`, `discoverFiles`, `createSandbox`, `detectEnvironment`,
 * `makeEngine`, `mintRunId` and `loadSuppressions`).
 *
 * Every test runs the pool serially (`fileConcurrency: 1`), so the order
 * `mapPool` claims files in is exactly the order they appear in `files`. That
 * is what lets a stubbed `watchdog.register` (which only ever sees an
 * `AbortController`, never a file name) target one specific file by counting
 * how many times it has been called.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { ResourceExhaustedError } from '../utils/resources/errors.js';

vi.mock('../triage/discover-files.js', async () => {
  const actual = await vi.importActual<typeof import('../triage/discover-files.js')>(
    '../triage/discover-files.js',
  );
  return { ...actual, discoverFiles: vi.fn(), discoverChangedFiles: vi.fn() };
});
const { cleanupSpy } = vi.hoisted(() => ({ cleanupSpy: vi.fn() }));
vi.mock('../utils/sandbox.js', () => ({
  createSandbox: vi.fn(() => ({ workDir: '/tmp/s', targetFile: '', cleanup: cleanupSpy })),
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
vi.mock('../engines/registry.js', async () => {
  const actual =
    await vi.importActual<typeof import('../engines/registry.js')>('../engines/registry.js');
  return { ...actual, makeEngine: vi.fn(() => ({ run: vi.fn() })) };
});
vi.mock('../utils/run-cache.js', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/run-cache.js')>('../utils/run-cache.js');
  return { ...actual, mintRunId: vi.fn(actual.mintRunId) };
});
vi.mock('../utils/suppression.js', async () => {
  const actual =
    await vi.importActual<typeof import('../utils/suppression.js')>('../utils/suppression.js');
  return { ...actual, loadSuppressions: vi.fn(() => new Map()) };
});
// The module under test for this file: every test controls the resource
// context returned to the handler, rather than exercising the real probe.
vi.mock('../core/resource-context.js', () => ({
  createResourceContext: vi.fn(),
}));

import { discoverFiles } from '../triage/discover-files.js';
import { detectEnvironment } from '../utils/project-detector.js';
import { auditFile } from '../audit/audit-file.js';
import { createResourceContext } from '../core/resource-context.js';
import { handleTriageCall } from '../triage-handler.js';

const mockDiscover = vi.mocked(discoverFiles);
const mockDetectEnv = vi.mocked(detectEnvironment);
const mockAuditFile = vi.mocked(auditFile);
const mockCreateResourceContext = vi.mocked(createResourceContext);

const GIB = 1024 ** 3;

const req = (args: Record<string, unknown>): CallToolRequest =>
  ({
    method: 'tools/call',
    params: { name: 'triage_test_coverage', arguments: args },
  }) as CallToolRequest;

const txt = (res: { content: unknown[] }): string => (res.content[0] as { text: string }).text;

const tsEnv = {
  projectType: 'typescript' as const,
  testRunner: 'vitest',
  detectedRunner: 'vitest',
  packageManager: '',
  workspaceRoot: process.cwd(),
};

const mrOf = (over: Record<string, unknown>) => ({
  target: 'f',
  totalMutants: 10,
  killed: 8,
  survived: 2,
  mutationScore: '80.00%',
  vulnerabilities: [],
  ...over,
});

/**
 * A resource context whose watchdog and admission gate can be scripted by
 * CALL NUMBER (1-based), since neither `register` nor `admit` is handed the
 * file it concerns (`utils/resources/watchdog.ts`'s real signature). Combined
 * with `fileConcurrency: 1` in every test, call number and file position in
 * `files` line up exactly.
 */
function makeResources(opts: {
  fileConcurrency?: number;
  perFileWorkers?: number;
  /** 1-based `register()` calls whose controller is aborted for memory. */
  exhaustOnRegisterCalls?: number[];
  /** 1-based `admit()` calls that decline instead of admitting. */
  declineOnAdmitCalls?: number[];
} = {}) {
  const fileConcurrency = opts.fileConcurrency ?? 1;
  const perFileWorkers = opts.perFileWorkers ?? 2;
  const exhaustOn = new Set(opts.exhaustOnRegisterCalls ?? []);
  const declineOn = new Set(opts.declineOnAdmitCalls ?? []);
  let registerCalls = 0;
  let admitCalls = 0;

  const watchdog = {
    register: vi.fn((controller: AbortController) => {
      registerCalls++;
      if (exhaustOn.has(registerCalls)) {
        controller.abort(new ResourceExhaustedError(100 * 1024 ** 2, 512 * 1024 ** 2));
      }
      return { release: vi.fn() };
    }),
    admit: vi.fn(async (_costBytes: number, _signal?: AbortSignal) => {
      admitCalls++;
      return declineOn.has(admitCalls) ? ('cancelled' as const) : ('admitted' as const);
    }),
    tick: vi.fn(),
    stop: vi.fn(),
    trips: 0,
  };

  return {
    budget: { fileConcurrency, perFileWorkers, overBudget: false, affordableWorkers: fileConcurrency * perFileWorkers },
    watchdog,
    innerEnv: {},
    workerCostBytes: 300 * 1024 ** 2,
    report: () => ({
      availableAtStartBytes: 4 * GIB,
      limitBytes: 8 * GIB,
      source: 'host' as const,
      fileConcurrency,
      perFileWorkers,
      overBudget: false,
      watchdogTrips: exhaustOn.size,
    }),
    dispose: vi.fn(),
  };
}

/**
 * The fake engine every test in this file shares: it fails the way a REAL
 * engine does when its child process is killed by the watchdog's abort (a
 * generic failure, never an `AbortError`), whenever the signal it was handed
 * is already aborted at call time. `audit-one.ts` registers the per-file
 * controller with the watchdog and aborts it (synchronously, inside
 * `register()`) BEFORE calling this, so the signal is already tripped by the
 * time the mock inspects it.
 */
function installFakeEngine(): void {
  mockAuditFile.mockImplementation(async (input) => {
    if (input.signal?.aborted) {
      throw new Error('engine exited with code null');
    }
    return mrOf({});
  });
}

describe('triage_test_coverage resource governance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDetectEnv.mockReturnValue(tsEnv);
  });

  it('requeues a file whose run was stopped for memory, once', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts', 'b.ts', 'c.ts'], discovered: 3, skipped: 0 });
    installFakeEngine();
    // Serial order is a, b, c: register call 2 is b.ts's FIRST attempt. Its
    // requeue (register call 4, since a/b/c each register once) is not in the
    // exhaust set, so it succeeds.
    const resources = makeResources({ exhaustOnRegisterCalls: [2] });
    mockCreateResourceContext.mockReturnValue(
      resources as unknown as ReturnType<typeof createResourceContext>,
    );

    const res = await handleTriageCall(req({ paths: ['src'], fileConcurrency: 1 }));
    const payload = JSON.parse(txt(res)) as {
      ranking: { file: string }[];
      errors: unknown[];
    };

    expect(res.isError).toBeUndefined();
    expect(payload.ranking.map((r) => r.file).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(payload.errors).toEqual([]);
    // a, b, c in the first pass, plus one more call for b.ts's requeue.
    expect(mockAuditFile).toHaveBeenCalledTimes(4);
    expect(resources.watchdog.register).toHaveBeenCalledTimes(4);
  });

  it('turns a second memory stop into an error row, never a silent drop', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts', 'b.ts'], discovered: 2, skipped: 0 });
    installFakeEngine();
    // b.ts exhausts on its first attempt (register call 2) AND on its requeue
    // (register call 3, the only registration in the single-file retry pool).
    const resources = makeResources({ exhaustOnRegisterCalls: [2, 3] });
    mockCreateResourceContext.mockReturnValue(
      resources as unknown as ReturnType<typeof createResourceContext>,
    );

    const res = await handleTriageCall(req({ paths: ['src'], fileConcurrency: 1 }));
    const payload = JSON.parse(txt(res)) as {
      ranking: { file: string }[];
      errors: { file: string; error: string }[];
      summary: { filesDiscovered: number; filesAudited: number; filesErrored: number };
    };

    expect(res.isError).toBeUndefined();
    expect(payload.ranking.map((r) => r.file)).toEqual(['a.ts']);
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors[0].file).toBe('b.ts');
    // The RESOURCE_EXHAUSTED wording, never a bare 'Operation cancelled.'
    // A memory stop must never be reported as a user cancel.
    expect(payload.errors[0].error).toMatch(/exhaust/i);
    expect(payload.errors[0].error).not.toBe('Operation cancelled.');
    // discovered/audited/errored counts still account for both files: b.ts
    // did not silently disappear from the sweep's summary.
    expect(payload.summary.filesDiscovered).toBe(2);
    expect(payload.summary.filesAudited).toBe(1);
    expect(payload.summary.filesErrored).toBe(1);
  });

  it('never starts a file the admission gate declines', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts', 'b.ts', 'c.ts'], discovered: 3, skipped: 0 });
    installFakeEngine();
    // admit() is called once per file in file order (serial pool); declining
    // the third call declines exactly c.ts, before its engine ever starts.
    const resources = makeResources({ declineOnAdmitCalls: [3] });
    mockCreateResourceContext.mockReturnValue(
      resources as unknown as ReturnType<typeof createResourceContext>,
    );
    const controller = new AbortController();

    const res = await handleTriageCall(req({ paths: ['src'], fileConcurrency: 1 }), undefined, {
      signal: controller.signal,
    });
    const payload = JSON.parse(txt(res)) as {
      ranking: { file: string }[];
      unaudited?: string[];
      errors: unknown[];
    };

    expect(res.isError).toBeUndefined();
    expect(payload.ranking.map((r) => r.file).sort()).toEqual(['a.ts', 'b.ts']);
    // Reported the same way the deadline path reports a file it never
    // started: the unaudited bucket, not an error and not a silent drop.
    expect(payload.unaudited).toEqual(['c.ts']);
    expect(payload.errors).toEqual([]);
    expect(mockAuditFile).toHaveBeenCalledTimes(2);
    expect(mockAuditFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ targetFile: 'c.ts' }),
    );
    // The request's own (non-aborted) signal is what admit() is gated on.
    expect(resources.watchdog.admit).toHaveBeenCalledWith(expect.any(Number), controller.signal);
  });

  it('reports the resources block', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    installFakeEngine();
    const resources = makeResources({ fileConcurrency: 1, perFileWorkers: 2 });
    mockCreateResourceContext.mockReturnValue(
      resources as unknown as ReturnType<typeof createResourceContext>,
    );

    // Requests 4-way concurrency; the stub's budget (governance) lowers it to 1.
    const res = await handleTriageCall(req({ paths: ['src'], fileConcurrency: 4 }));
    const payload = JSON.parse(txt(res)) as {
      resources?: {
        fileConcurrency: number;
        perFileWorkers: number;
        watchdogTrips: number;
        source: string;
      };
    };

    expect(res.isError).toBeUndefined();
    expect(payload.resources).toBeDefined();
    expect(payload.resources?.fileConcurrency).toBeLessThanOrEqual(4);
    expect(payload.resources?.watchdogTrips).toBeDefined();
    expect(payload.resources?.source).toBe('host');
    expect(resources.dispose).toHaveBeenCalledTimes(1);
  });
});
