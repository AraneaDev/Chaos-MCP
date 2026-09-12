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
import { isBaselineFailureMessage } from '../utils/baseline-failure.js';
import { explainMissingJsonLog } from '../engines/php/failures.js';
import { ExecFailureError } from '../utils/exec-error.js';

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
import { createWatchdog } from '../utils/resources/watchdog.js';
import { createSandbox } from '../utils/sandbox.js';
import { handleTriageCall } from '../triage-handler.js';

const mockDiscover = vi.mocked(discoverFiles);
const mockDetectEnv = vi.mocked(detectEnvironment);
const mockAuditFile = vi.mocked(auditFile);
const mockCreateResourceContext = vi.mocked(createResourceContext);
const mockCreateSandbox = vi.mocked(createSandbox);

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
function makeResources(
  opts: {
    fileConcurrency?: number;
    perFileWorkers?: number;
    /** 1-based `register()` calls whose controller is aborted for memory. */
    exhaustOnRegisterCalls?: number[];
    /** 1-based `admit()` calls that decline instead of admitting. */
    declineOnAdmitCalls?: number[];
    /** Overrides the default workers-only charge, to prove a fixed term reaches admission/registration. */
    perFileCostBytes?: number;
  } = {},
) {
  const fileConcurrency = opts.fileConcurrency ?? 1;
  const perFileWorkers = opts.perFileWorkers ?? 2;
  const exhaustOn = new Set(opts.exhaustOnRegisterCalls ?? []);
  const declineOn = new Set(opts.declineOnAdmitCalls ?? []);
  const perFileCostBytes = opts.perFileCostBytes ?? 300 * 1024 ** 2 * perFileWorkers;
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
    budget: { fileConcurrency, perFileWorkers, overBudget: false },
    watchdog,
    innerEnv: {},
    workerCostBytes: 300 * 1024 ** 2,
    perFileCostBytes,
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

  it('reports progress once per file even when the file is requeued (MINOR 7)', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts', 'b.ts', 'c.ts'], discovered: 3, skipped: 0 });
    installFakeEngine();
    const resources = makeResources({ exhaustOnRegisterCalls: [2] });
    mockCreateResourceContext.mockReturnValue(
      resources as unknown as ReturnType<typeof createResourceContext>,
    );
    const reportProgress = vi.fn();

    await handleTriageCall(req({ paths: ['src'], fileConcurrency: 1 }), undefined, {
      reportProgress,
    });

    // 3 files, never 4: b.ts's requeue must not report progress a second
    // time, or a 3-file sweep would print "audited 4/3".
    expect(reportProgress).toHaveBeenCalledTimes(3);
    expect(reportProgress).toHaveBeenLastCalledWith(3, 3, 'audited 3/3');
  });

  it('treats a memory stop DURING sandbox creation the same as one during the engine run (IMPORTANT 5)', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    installFakeEngine();
    // register() aborts the controller the moment it is called, now BEFORE
    // createSandbox runs at all, proving sandbox creation is inside the
    // governed window. createSandbox observes the aborted signal and rejects,
    // the way fs.cp does mid-copy.
    const resources = makeResources({ exhaustOnRegisterCalls: [1] });
    mockCreateResourceContext.mockReturnValue(
      resources as unknown as ReturnType<typeof createResourceContext>,
    );
    mockCreateSandbox.mockImplementationOnce(
      async (_file: string, _root: string, _ignore, opts?: { signal?: AbortSignal }) => {
        if (opts?.signal?.aborted) throw new Error('sandbox copy failed');
        return { workDir: '/tmp/s', targetFile: '', cleanup: cleanupSpy };
      },
    );

    const res = await handleTriageCall(req({ paths: ['src'], fileConcurrency: 1 }));
    const payload = JSON.parse(txt(res)) as {
      ranking: { file: string }[];
      errors: { file: string; error: string }[];
    };

    expect(res.isError).toBeUndefined();
    // The retry succeeds (register call 2, not in the exhaust set), same
    // requeue-once contract as a trip during the engine run.
    expect(payload.ranking.map((r) => r.file)).toEqual(['a.ts']);
    expect(payload.errors).toEqual([]);
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

  it('preserves the original exhausted marker when admission is declined on the RETRY pass itself', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    installFakeEngine();
    // a.ts's first attempt trips the watchdog (register call 1) and becomes
    // `{ exhausted }`. Its requeue's own admission check (admit call 2, the
    // only admission check the single-file retry pool makes) is declined
    // outright, so the retry pool never reaches `register()` for it at all:
    // `mapPool` leaves that slot an unassigned hole (utils/pool.ts), never a
    // resolved outcome, when `admit` declines before `fn` is even called.
    const resources = makeResources({
      exhaustOnRegisterCalls: [1],
      declineOnAdmitCalls: [2],
    });
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
    // The retry never reached a second engine attempt.
    expect(mockAuditFile).toHaveBeenCalledTimes(1);
    expect(resources.watchdog.register).toHaveBeenCalledTimes(1);
    // A declined retry must not overwrite the original `{ exhausted }`
    // marker with an empty slot: the file still becomes an error row, the
    // same RESOURCE_EXHAUSTED wording as a retry that ran and exhausted
    // again, never a silent drop from the ranking.
    expect(payload.ranking).toEqual([]);
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors[0].file).toBe('a.ts');
    expect(payload.errors[0].error).toMatch(/exhaust/i);
    expect(payload.errors[0].error).not.toBe('Operation cancelled.');
    expect(payload.summary.filesDiscovered).toBe(1);
    expect(payload.summary.filesAudited).toBe(0);
    expect(payload.summary.filesErrored).toBe(1);
  });

  it('charges the admission gate and watchdog registration with the per-file figure including the fixed term, not the workers-only figure', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    installFakeEngine();
    // 2 workers at 300 MB each is 600 MB workers-only; the fixed term pushes
    // the real per-file charge to 1500 MB. If the gate or the registration
    // fell back to (or recomputed) the workers-only figure, this would catch
    // it: both must see 1500 MB, not 600 MB.
    const perFileCostBytes = 900 * 1024 ** 2 + 2 * 300 * 1024 ** 2;
    const resources = makeResources({ perFileWorkers: 2, perFileCostBytes });
    mockCreateResourceContext.mockReturnValue(
      resources as unknown as ReturnType<typeof createResourceContext>,
    );

    const res = await handleTriageCall(req({ paths: ['src'], fileConcurrency: 1 }));

    expect(res.isError).toBeUndefined();
    expect(resources.watchdog.admit).toHaveBeenCalledWith(perFileCostBytes, expect.anything());
    expect(resources.watchdog.register).toHaveBeenCalledWith(expect.anything(), perFileCostBytes);
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
    expect(mockAuditFile).not.toHaveBeenCalledWith(expect.objectContaining({ targetFile: 'c.ts' }));
    // admit() is gated on a signal LINKED to the request's own signal (CRITICAL
    // 2 combines it with a deadline signal, so it is no longer the exact same
    // object), not yet aborted, but a cancel on the request must still reach
    // it, which is what actually makes admission give up on a user cancel.
    const [, gatedSignal] = resources.watchdog.admit.mock.calls[0] as [number, AbortSignal];
    expect(gatedSignal.aborted).toBe(false);
    controller.abort();
    expect(gatedSignal.aborted).toBe(true);
  });

  it('gives up on admission when the sweep deadline passes, instead of hanging forever (CRITICAL 2)', async () => {
    mockDiscover.mockReturnValue({ files: ['a.ts'], discovered: 1, skipped: 0 });
    installFakeEngine();
    // A REAL watchdog (not the hand-rolled stub the other tests use): its
    // `admit()` only ever resolves from a `tick()` that finds enough memory or
    // a `stop()`, never called here, since nothing outside admission is
    // waiting on it, or from the signal it was handed aborting. An
    // admission floor no amount of "available" memory can clear reproduces
    // the sustained-external-pressure scenario: every file blocks forever
    // unless something OTHER than the watchdog gives up.
    const realWatchdog = createWatchdog({
      probe: () => ({ availableBytes: 0, limitBytes: 8 * GIB, source: 'host' }),
      criticalBytes: 1,
      admissionBytes: 8 * GIB,
      intervalMs: 10_000_000,
    });
    const resources = {
      budget: { fileConcurrency: 1, perFileWorkers: 1, overBudget: false },
      watchdog: realWatchdog,
      innerEnv: {},
      workerCostBytes: 1,
      perFileCostBytes: 1,
      report: () => ({
        availableAtStartBytes: 0,
        limitBytes: 8 * GIB,
        source: 'host' as const,
        fileConcurrency: 1,
        perFileWorkers: 1,
        overBudget: false,
        watchdogTrips: 0,
      }),
      dispose: () => realWatchdog.stop(),
    };
    mockCreateResourceContext.mockReturnValue(
      resources as unknown as ReturnType<typeof createResourceContext>,
    );

    // TRIAGE_CLEANUP_RESERVE_MS is 2000ms; this leaves ~100ms for admission to
    // give up in, short enough to keep the test fast but long enough that the
    // deadline signal, not the immediate "no time left at all" shortcut, is
    // what resolves it.
    const res = await handleTriageCall(
      req({ paths: ['src'], fileConcurrency: 1, totalTimeoutMs: 2100 }),
    );
    const payload = JSON.parse(txt(res)) as {
      ranking: unknown[];
      errors: unknown[];
      unaudited?: string[];
    };

    expect(res.isError).toBeUndefined();
    // Reported the same way the deadline path already reports a file it never
    // started: the unaudited bucket, never a silent drop and never a hang.
    expect(payload.unaudited).toEqual(['a.ts']);
    expect(payload.ranking).toEqual([]);
    expect(payload.errors).toEqual([]);
    expect(mockAuditFile).not.toHaveBeenCalled();
  }, 10_000);

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

  describe('baseline (initial test run) failure retry', () => {
    /** The exact wording reported on the real 4-file sweep this feature fixes. */
    const BASELINE_FAILURE_MESSAGE =
      'StrykerJS configuration or internal error (exit 1): Error: Something went wrong in the initial test run';

    it('retries a baseline failure once in a PARALLEL sweep and ranks it after a clean retry', async () => {
      mockDiscover.mockReturnValue({ files: ['a.ts', 'b.ts'], discovered: 2, skipped: 0 });
      let bCalls = 0;
      mockAuditFile.mockImplementation(async (input) => {
        if (input.targetFile === 'b.ts') {
          bCalls++;
          if (bCalls === 1) throw new Error(BASELINE_FAILURE_MESSAGE);
          return mrOf({});
        }
        return mrOf({});
      });
      // fileConcurrency 2 resolves the first pass to more than one file at a
      // time, which is what makes a baseline failure eligible for the retry.
      const resources = makeResources({ fileConcurrency: 2 });
      mockCreateResourceContext.mockReturnValue(
        resources as unknown as ReturnType<typeof createResourceContext>,
      );

      const res = await handleTriageCall(req({ paths: ['src'], fileConcurrency: 2 }));
      const payload = JSON.parse(txt(res)) as {
        ranking: { file: string }[];
        errors: unknown[];
      };

      expect(res.isError).toBeUndefined();
      expect(payload.ranking.map((r) => r.file).sort()).toEqual(['a.ts', 'b.ts']);
      expect(payload.errors).toEqual([]);
      expect(bCalls).toBe(2);
      // a.ts once, b.ts twice.
      expect(mockAuditFile).toHaveBeenCalledTimes(3);
    });

    it('reports a baseline failure that fails TWICE as an error row with the original message and a retried note, and does not queue a third attempt', async () => {
      mockDiscover.mockReturnValue({ files: ['b.ts'], discovered: 1, skipped: 0 });
      let bCalls = 0;
      mockAuditFile.mockImplementation(async () => {
        bCalls++;
        // A different message on the retry proves the reported row keeps the
        // FIRST message rather than whatever the second attempt produced.
        throw new Error(bCalls === 1 ? BASELINE_FAILURE_MESSAGE : 'a different failure entirely');
      });
      const resources = makeResources({ fileConcurrency: 2 });
      mockCreateResourceContext.mockReturnValue(
        resources as unknown as ReturnType<typeof createResourceContext>,
      );

      const res = await handleTriageCall(req({ paths: ['src'], fileConcurrency: 2 }));
      const payload = JSON.parse(txt(res)) as {
        ranking: unknown[];
        errors: { file: string; error: string }[];
      };

      expect(res.isError).toBeUndefined();
      expect(payload.ranking).toEqual([]);
      expect(payload.errors).toHaveLength(1);
      expect(payload.errors[0].file).toBe('b.ts');
      // The original message survives verbatim...
      expect(payload.errors[0].error).toContain(BASELINE_FAILURE_MESSAGE);
      // ...the retry's own (different) message never replaces it...
      expect(payload.errors[0].error).not.toContain('a different failure entirely');
      // ...plus a short note that a retry happened.
      expect(payload.errors[0].error).toMatch(/retried once/i);
      // Retried exactly once: a second failure must not queue a third attempt.
      expect(bCalls).toBe(2);
    });

    it('does not retry the same baseline failure in a SERIAL sweep', async () => {
      mockDiscover.mockReturnValue({ files: ['b.ts'], discovered: 1, skipped: 0 });
      let bCalls = 0;
      mockAuditFile.mockImplementation(async () => {
        bCalls++;
        throw new Error(BASELINE_FAILURE_MESSAGE);
      });
      const resources = makeResources({ fileConcurrency: 1 });
      mockCreateResourceContext.mockReturnValue(
        resources as unknown as ReturnType<typeof createResourceContext>,
      );

      const res = await handleTriageCall(req({ paths: ['src'], fileConcurrency: 1 }));
      const payload = JSON.parse(txt(res)) as {
        ranking: unknown[];
        errors: { file: string; error: string }[];
      };

      expect(res.isError).toBeUndefined();
      expect(payload.errors).toHaveLength(1);
      expect(payload.errors[0].file).toBe('b.ts');
      // Reported exactly once, with no "retried" note, contention was never a
      // plausible cause for a sweep that was already serial.
      expect(payload.errors[0].error).toBe(BASELINE_FAILURE_MESSAGE);
      expect(bCalls).toBe(1);
    });

    it('does not retry an ordinary engine failure that is not a baseline failure', async () => {
      mockDiscover.mockReturnValue({ files: ['b.ts'], discovered: 1, skipped: 0 });
      let bCalls = 0;
      const ORDINARY_MESSAGE =
        'StrykerJS configuration or internal error (exit 1): malformed stryker.conf.js';
      mockAuditFile.mockImplementation(async () => {
        bCalls++;
        throw new Error(ORDINARY_MESSAGE);
      });
      // Parallel, so only the failure-shape predicate (not concurrency) is
      // under test here.
      const resources = makeResources({ fileConcurrency: 2 });
      mockCreateResourceContext.mockReturnValue(
        resources as unknown as ReturnType<typeof createResourceContext>,
      );

      const res = await handleTriageCall(req({ paths: ['src'], fileConcurrency: 2 }));
      const payload = JSON.parse(txt(res)) as {
        ranking: unknown[];
        errors: { file: string; error: string }[];
      };

      expect(res.isError).toBeUndefined();
      expect(payload.errors).toHaveLength(1);
      expect(payload.errors[0].file).toBe('b.ts');
      expect(payload.errors[0].error).toBe(ORDINARY_MESSAGE);
      expect(bCalls).toBe(1);
    });

    describe('PHP deterministic Infection startup failures (never retried)', () => {
      /**
       * Mirrors the `failure` helper in `php-engine.test.ts`: builds the exact
       * `ExecFailureError` shape `explainMissingJsonLog` takes, so the message
       * text asserted below comes from the real production function rather
       * than a paraphrase that could drift from `engines/php/failures.ts`.
       */
      const execFailure = (opts: { stdout?: string; stderr?: string }) =>
        new ExecFailureError(
          {
            stdout: opts.stdout ?? '',
            stderr: opts.stderr ?? '',
            exit: 1,
            signal: null,
            code: undefined,
          },
          'Infection failed',
        );

      it('still retries a generic PHP initial-test-run failure (no named startup cause)', async () => {
        const GENERIC_MESSAGE = explainMissingJsonLog(
          execFailure({ stderr: 'something unrecognised' }),
          '/fake-project',
          true,
        ).message;
        // Sanity check on the fixture itself: this is the branch the retry
        // exists for, and it must still contain the shared TS/PHP marker.
        expect(GENERIC_MESSAGE).toContain('the initial test run failed');

        mockDiscover.mockReturnValue({ files: ['b.php'], discovered: 1, skipped: 0 });
        let bCalls = 0;
        mockAuditFile.mockImplementation(async () => {
          bCalls++;
          if (bCalls === 1) throw new Error(GENERIC_MESSAGE);
          return mrOf({});
        });
        const resources = makeResources({ fileConcurrency: 2 });
        mockCreateResourceContext.mockReturnValue(
          resources as unknown as ReturnType<typeof createResourceContext>,
        );

        const res = await handleTriageCall(req({ paths: ['src'], fileConcurrency: 2 }));
        const payload = JSON.parse(txt(res)) as { ranking: { file: string }[]; errors: unknown[] };

        expect(res.isError).toBeUndefined();
        expect(payload.errors).toEqual([]);
        expect(payload.ranking.map((r) => r.file)).toEqual(['b.php']);
        expect(bCalls).toBe(2);
      });

      it('does NOT retry the exit-143 diagnosis (Infection kills the run on the first STDERR byte)', async () => {
        const EXIT_143_MESSAGE = explainMissingJsonLog(
          execFailure({
            stdout: 'Project tests must be in a passing state\nexit code of 143',
          }),
          '/fake-project',
          true,
        ).message;
        // Sanity check on the fixture: this is the trap the naive fix misses,
        // the diagnosis text itself contains the generic TS/PHP marker.
        expect(EXIT_143_MESSAGE).toContain('the initial test run');

        mockDiscover.mockReturnValue({ files: ['b.php'], discovered: 1, skipped: 0 });
        let bCalls = 0;
        mockAuditFile.mockImplementation(async () => {
          bCalls++;
          throw new Error(EXIT_143_MESSAGE);
        });
        const resources = makeResources({ fileConcurrency: 2 });
        mockCreateResourceContext.mockReturnValue(
          resources as unknown as ReturnType<typeof createResourceContext>,
        );

        const res = await handleTriageCall(req({ paths: ['src'], fileConcurrency: 2 }));
        const payload = JSON.parse(txt(res)) as {
          errors: { file: string; error: string }[];
        };

        expect(res.isError).toBeUndefined();
        expect(payload.errors).toHaveLength(1);
        expect(payload.errors[0].file).toBe('b.php');
        // Reported once, verbatim, no "retried once" note.
        expect(payload.errors[0].error).toBe(EXIT_143_MESSAGE);
        expect(bCalls).toBe(1);
      });

      it('does NOT retry the coverage-scope diagnosis (--filter invalidates coverage targets deterministically)', async () => {
        const COVERAGE_SCOPE_MESSAGE = explainMissingJsonLog(
          execFailure({ stderr: 'is not a valid target for code coverage' }),
          '/fake-project',
          true,
        ).message;

        mockDiscover.mockReturnValue({ files: ['b.php'], discovered: 1, skipped: 0 });
        let bCalls = 0;
        mockAuditFile.mockImplementation(async () => {
          bCalls++;
          throw new Error(COVERAGE_SCOPE_MESSAGE);
        });
        const resources = makeResources({ fileConcurrency: 2 });
        mockCreateResourceContext.mockReturnValue(
          resources as unknown as ReturnType<typeof createResourceContext>,
        );

        const res = await handleTriageCall(req({ paths: ['src'], fileConcurrency: 2 }));
        const payload = JSON.parse(txt(res)) as {
          errors: { file: string; error: string }[];
        };

        expect(res.isError).toBeUndefined();
        expect(payload.errors).toHaveLength(1);
        expect(payload.errors[0].file).toBe('b.php');
        expect(payload.errors[0].error).toBe(COVERAGE_SCOPE_MESSAGE);
        expect(bCalls).toBe(1);
      });
    });
  });

  describe('isBaselineFailureMessage: other engines unaffected by the PHP exclusion', () => {
    it('still matches the Rust baseline marker', () => {
      expect(
        isBaselineFailureMessage(
          'cargo-mutants failed (exit null): the baseline test suite itself failed',
        ),
      ).toBe(true);
    });

    it('still matches the Python baseline marker', () => {
      expect(isBaselineFailureMessage('baseline failed (exit 1): pytest exited non-zero')).toBe(
        true,
      );
    });

    it('still matches the TypeScript/Stryker baseline marker', () => {
      expect(
        isBaselineFailureMessage(
          'StrykerJS configuration or internal error (exit 1): Error: Something went wrong in the initial test run',
        ),
      ).toBe(true);
    });

    it('does not match an ordinary scored run for any engine', () => {
      expect(isBaselineFailureMessage('12/50 mutants killed, 3 survived')).toBe(false);
      expect(isBaselineFailureMessage('cargo-mutants: 4 survivors, 40 caught')).toBe(false);
    });
  });
});
