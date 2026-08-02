import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Stubs for the triage per-file path (Med#9) ───────────────────────────────
// Only the collaborators `auditTriageFile` reaches before the engine are
// stubbed; the budget arithmetic under test is the real thing.
vi.mock('../utils/sandbox.js', () => ({ createSandbox: vi.fn() }));
vi.mock('../audit/audit-file.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../audit/audit-file.js')>()),
  auditFile: vi.fn(),
}));
vi.mock('../audit/target.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../audit/target.js')>()),
  resolveAuditTargetIn: vi.fn(),
}));
vi.mock('../engines/registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engines/registry.js')>()),
  makeEngine: vi.fn(() => ({ run: vi.fn() })),
}));
vi.mock('../utils/suppression.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/suppression.js')>()),
  loadSuppressions: vi.fn(() => new Map()),
}));
vi.mock('../utils/run-cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../utils/run-cache.js')>()),
  mintRunId: vi.fn(() => 'run-1'),
}));

import { AuditDeadline } from '../utils/deadline.js';
import { auditTriageFile, type TriageFileDeps } from '../triage/audit-one.js';
import { createSandbox } from '../utils/sandbox.js';
import { auditFile } from '../audit/audit-file.js';
import { resolveAuditTargetIn } from '../audit/target.js';
import type { ChaosConfig } from '../utils/config-loader.js';

describe('AuditDeadline', () => {
  it('tracks one absolute budget across phases', () => {
    let now = 1_000;
    const deadline = new AuditDeadline(10_000, () => now);

    expect(deadline.remainingMs()).toBe(10_000);
    now += 2_500;
    expect(deadline.elapsedMs()).toBe(2_500);
    expect(deadline.remainingMs()).toBe(7_500);
    expect(deadline.expired()).toBe(false);
  });

  it('reserves cleanup time without moving the absolute deadline', () => {
    let now = 0;
    const deadline = new AuditDeadline(5_000, () => now);
    expect(deadline.remainingMs(2_000)).toBe(3_000);
    now = 4_000;
    expect(deadline.remainingMs(2_000)).toBe(0);
    expect(deadline.remainingMs()).toBe(1_000);
  });

  it('clamps expired and invalid budgets safely', () => {
    let now = 10;
    const deadline = new AuditDeadline(0, () => now);
    expect(deadline.remainingMs()).toBe(1);
    now = 11;
    expect(deadline.remainingMs()).toBe(0);
    expect(deadline.expired()).toBe(true);
  });
});

/**
 * Med#9: a triage sweep's per-file budget must be re-read AFTER provisioning.
 *
 * `resolveDiffScope` (up to four git calls) and `createSandbox` (a whole
 * workspace copy) both spend wall clock, so the number computed before them is
 * stale by the time the engine starts — and it is that number the engine used
 * to be launched with, once per in-flight worker.
 */
describe('auditTriageFile — engine budget is re-read after provisioning', () => {
  const mockCreateSandbox = vi.mocked(createSandbox);
  const mockAuditFile = vi.mocked(auditFile);
  const mockResolveTarget = vi.mocked(resolveAuditTargetIn);

  const CLEANUP_RESERVE_MS = 2_000;
  const cleanup = vi.fn();

  /** The clock every deadline in this block reads; advanced by the stubs. */
  let now = 0;

  /** Deps for one file, on a `totalTimeoutMs`-style deadline over the fake clock. */
  const depsFor = (budgetMs: number): TriageFileDeps => ({
    rootCwd: process.cwd(),
    cfg: { runCacheTtlMs: 1_000, runCacheMax: 10 } as unknown as ChaosConfig,
    args: {},
    diffBase: undefined,
    strykerConcurrency: undefined,
    survivorsPerFile: 0,
    suppressionCache: new Map(),
    deadline: new AuditDeadline(budgetMs, () => now),
    cleanupReserveMs: CLEANUP_RESERVE_MS,
    onProgress: vi.fn(),
  });

  /** Make the sandbox copy "take" `ms` of wall clock. */
  const sandboxCosts = (ms: number): void => {
    mockCreateSandbox.mockImplementation(async () => {
      now += ms;
      return { workDir: '/tmp/sbx', targetFile: 'src/a.ts', cleanup };
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    now = 0;
    mockResolveTarget.mockReturnValue({
      projectType: 'typescript',
      env: {
        projectType: 'typescript',
        testRunner: 'vitest',
        detectedRunner: 'vitest',
        packageManager: 'npm',
        workspaceRoot: process.cwd(),
      },
      targetFile: 'src/a.ts',
      relFromRoot: 'src/a.ts',
    });
    mockAuditFile.mockResolvedValue({
      target: 'src/a.ts',
      totalMutants: 10,
      killed: 8,
      survived: 2,
      mutationScore: '80.00%',
      vulnerabilities: [],
    });
  });

  it('reports a file whose budget provisioning consumed as unaudited, not as a launched engine', async () => {
    // 60s budget; the sandbox copy alone burns 59.5s, leaving less than the
    // cleanup reserve — never mind an engine. The pre-copy read was 58s.
    sandboxCosts(59_500);

    const outcome = await auditTriageFile('src/a.ts', depsFor(60_000));

    expect(outcome).toEqual({ unaudited: 'src/a.ts' });
    // The engine was never started with the stale 58s.
    expect(mockAuditFile).not.toHaveBeenCalled();
    // The early return is inside the sandbox's `finally`, so nothing leaks.
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('refuses to start an engine with less than the 1s minimum budget', async () => {
    // Leaves exactly 999ms after the reserve — above zero, below the floor.
    sandboxCosts(60_000 - CLEANUP_RESERVE_MS - 999);

    const outcome = await auditTriageFile('src/a.ts', depsFor(60_000));

    expect(outcome).toEqual({ unaudited: 'src/a.ts' });
    expect(mockAuditFile).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('hands the engine the post-provisioning budget, not the pre-provisioning one', async () => {
    sandboxCosts(10_000);

    const outcome = await auditTriageFile('src/a.ts', depsFor(60_000));

    expect(outcome).toHaveProperty('row');
    // 60_000 − 10_000 spent − 2_000 reserve. The stale value would be 58_000.
    const args = mockAuditFile.mock.calls[0][0].args;
    expect(args.timeoutMs).toBe(48_000);
    // The bag is still constructed from scratch, not forwarded: two keys here
    // (concurrency is added only for TypeScript with a pooled sweep), and
    // never a caller-supplied prebuildCommand.
    expect(Object.keys(args).sort()).toEqual(['mutatorDenylist', 'timeoutMs']);
  });

  it('still short-circuits before any provisioning when the budget is already gone', async () => {
    sandboxCosts(0);
    const deps = depsFor(60_000);
    // The sweep drained the budget on earlier files, before this one started.
    now += 61_000;

    const outcome = await auditTriageFile('src/a.ts', deps);

    expect(outcome).toEqual({ unaudited: 'src/a.ts' });
    expect(mockCreateSandbox).not.toHaveBeenCalled();
    expect(mockAuditFile).not.toHaveBeenCalled();
  });
});
