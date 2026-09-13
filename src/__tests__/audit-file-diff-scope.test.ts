/**
 * `auditFile`'s diff-scope wiring: turning already-computed `lineRanges` into
 * `RunOptions.diffScope` via `materialiseDiffScope`, for the engines that need
 * something built inside the sandbox first (Rust, PHP; Python's ranges pass
 * straight through, TypeScript is a no-op).
 *
 * `auditFile` is the single place both entry points funnel through
 * (`handler.ts` and `triage/audit-one.ts`), so these tests exercise it
 * directly with a stubbed engine, in the style of `dead-harness.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../audit/diff-scope.js', () => ({
  materialiseDiffScope: vi.fn(),
}));

import { auditFile } from '../audit/audit-file.js';
import { materialiseDiffScope } from '../audit/diff-scope.js';
import type { MutationResult } from '../engines/base.js';
import type { EnvironmentInfo } from '../utils/project-detector.js';

const mockMaterialise = vi.mocked(materialiseDiffScope);

function env(overrides: Partial<EnvironmentInfo> = {}): EnvironmentInfo {
  return {
    projectType: 'rust',
    testRunner: 'cargo test',
    detectedRunner: 'cargo test',
    packageManager: '',
    workspaceRoot: '/ws',
    ...overrides,
  };
}

function result(overrides: Partial<MutationResult> = {}): MutationResult {
  return {
    target: 'src/x.rs',
    totalMutants: 4,
    killed: 4,
    survived: 0,
    mutationScore: '100.00%',
    vulnerabilities: [],
    ...overrides,
  };
}

const ranges = [{ start: 3, end: 7 }];

describe('auditFile diff-scope wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('carries the materialised scope to engine.run', async () => {
    // rust supports diff scope; materialisation succeeds with a patch file.
    const diffScope = { kind: 'patch' as const, path: '/sandbox/.chaos-mcp.in-diff.patch' };
    mockMaterialise.mockResolvedValue({ diffScope });
    const run = vi.fn().mockResolvedValue(result());

    await auditFile({
      targetFile: 'src/x.rs',
      env: env(),
      projectType: 'rust',
      engine: { run } as never,
      args: {},
      config: {},
      workDir: '/tmp/sandbox',
      prebuildCmd: null,
      lineRanges: ranges,
      resolvedDiffBase: { ref: 'HEAD', staged: false },
    });

    expect(mockMaterialise).toHaveBeenCalledWith(
      expect.objectContaining({
        projectType: 'rust',
        relFile: 'src/x.rs',
        workspaceRoot: '/ws',
        sandboxDir: '/tmp/sandbox',
        resolvedBase: { ref: 'HEAD', staged: false },
        ranges,
      }),
    );
    const options = run.mock.calls[0][1];
    expect(options.diffScope).toEqual(diffScope);
  });

  it('surfaces a materialisation note WITHOUT setting diffScope', async () => {
    const note =
      'Diff scoping unavailable (git could not be run); mutating the whole file instead.';
    mockMaterialise.mockResolvedValue({ note });
    const run = vi.fn().mockResolvedValue(result());

    const out = await auditFile({
      targetFile: 'src/x.rs',
      env: env(),
      projectType: 'rust',
      engine: { run } as never,
      args: {},
      config: {},
      workDir: '/tmp/sandbox',
      prebuildCmd: null,
      lineRanges: ranges,
      resolvedDiffBase: { ref: 'HEAD', staged: false },
    });

    const options = run.mock.calls[0][1];
    expect(options.diffScope).toBeUndefined();
    expect(out.scopeNote).toBe(note);
  });

  it('deducts materialisation time from the budget the engine then runs under (Finding 3)', async () => {
    // Before this fix, `auditFile` handed the FULL run budget to the
    // materialiser and never charged what it used: a slow materialisation
    // (or one that falls back after timing out) left `runOptions.timeoutMs`
    // untouched, so the engine started its whole-file fallback run with the
    // budget the caller's deadline no longer actually had.
    const now = vi.spyOn(Date, 'now');
    const t0 = 1_000_000;
    now.mockReturnValueOnce(t0); // AuditDeadline constructed around materialisation
    mockMaterialise.mockImplementation(async () => {
      now.mockReturnValueOnce(t0 + 4_000); // materialisation "took" 4s
      return { note: 'Diff scoping unavailable (timed out); mutating the whole file instead.' };
    });
    const run = vi.fn().mockResolvedValue(result());

    await auditFile({
      targetFile: 'src/x.rs',
      env: env(),
      projectType: 'rust',
      engine: { run } as never,
      args: { timeoutMs: 10_000 },
      config: {},
      workDir: '/tmp/sandbox',
      prebuildCmd: null,
      lineRanges: ranges,
      resolvedDiffBase: { ref: 'HEAD', staged: false },
    });

    const options = run.mock.calls[0][1];
    // 10_000 budgeted minus the 4_000 materialisation spent, not the
    // untouched 10_000 the engine used to receive.
    expect(options.timeoutMs).toBe(6_000);
    now.mockRestore();
  });

  it('refuses to start the engine when materialisation exhausts the budget (Finding 3)', async () => {
    const now = vi.spyOn(Date, 'now');
    const t0 = 1_000_000;
    now.mockReturnValueOnce(t0);
    mockMaterialise.mockImplementation(async () => {
      // Materialisation alone burns through the whole 10s budget.
      now.mockReturnValueOnce(t0 + 10_000);
      return { note: 'Diff scoping unavailable (timed out); mutating the whole file instead.' };
    });
    const run = vi.fn().mockResolvedValue(result());

    await expect(
      auditFile({
        targetFile: 'src/x.rs',
        env: env(),
        projectType: 'rust',
        engine: { run } as never,
        args: { timeoutMs: 10_000 },
        config: {},
        workDir: '/tmp/sandbox',
        prebuildCmd: null,
        lineRanges: ranges,
        resolvedDiffBase: { ref: 'HEAD', staged: false },
      }),
    ).rejects.toThrow(/Audit time budget exhausted during diff-scope materialisation/);

    expect(run).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it('leaves an unscoped run untouched: no diffBase, no materialisation', async () => {
    const run = vi.fn().mockResolvedValue(result());

    const out = await auditFile({
      targetFile: 'src/x.rs',
      env: env(),
      projectType: 'rust',
      engine: { run } as never,
      args: {},
      config: {},
      workDir: '/tmp/sandbox',
      prebuildCmd: null,
      // No lineRanges and no resolvedDiffBase: no diffBase was given upstream,
      // so there is nothing to scope. This is today's path, and it must stay
      // byte-identical.
    });

    expect(mockMaterialise).not.toHaveBeenCalled();
    const options = run.mock.calls[0][1];
    expect(options.diffScope).toBeUndefined();
    expect(out.scopeNote).toBeUndefined();
  });

  it('does not materialise when lineRanges exist but resolvedDiffBase is missing', async () => {
    // Guards the CRITICAL fix directly: gating on `resolvedDiffBase` rather
    // than `args.diffBase` must not silently start materialising for every
    // caller that sets `lineRanges` some other way (e.g. `baseline`/verify
    // mode, which also populates `lineRanges` but must stay whole-file-styled
    // scoping, not diff scoping).
    const run = vi.fn().mockResolvedValue(result());

    await auditFile({
      targetFile: 'src/x.rs',
      env: env(),
      projectType: 'rust',
      engine: { run } as never,
      args: {},
      config: {},
      workDir: '/tmp/sandbox',
      prebuildCmd: null,
      lineRanges: ranges,
      // resolvedDiffBase intentionally omitted.
    });

    expect(mockMaterialise).not.toHaveBeenCalled();
  });
});
