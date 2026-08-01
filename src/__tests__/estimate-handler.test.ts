import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { cpus } from 'os';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// Mock estimate functions before importing the handler.
vi.mock('../estimate.js', () => ({
  estimateAudit: vi.fn(),
  estimateNeedsSandbox: vi.fn(() => false),
}));

// Partial mock: keep detectProjectType (real extension check), mock detectEnvironment.
vi.mock('../utils/project-detector.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/project-detector.js')>(
    '../utils/project-detector.js',
  );
  return {
    ...actual,
    detectEnvironment: vi.fn(),
  };
});

// Mock sandbox
const cleanupSpy = vi.fn();
vi.mock('../utils/sandbox.js', () => ({
  createSandbox: vi.fn(() => ({
    workDir: '/tmp/chaos-estimate-sandbox',
    targetFile: '',
    cleanup: cleanupSpy,
  })),
}));

vi.mock('../utils/execution.js', () => ({
  createExecutionSession: vi.fn(),
}));

// Mock realpathSync (used by isRealPathInside in handler.ts) to be identity,
// so boundary tests work without a real filesystem.
// statSync is mocked alongside it: the handler stats the target to reject a
// missing path, and these cases run against paths that exist only in the mock.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    realpathSync: vi.fn((p: string) => p),
    statSync: vi.fn(),
  };
});

import { statSync } from 'fs';
import { handleEstimateCall, resolveEstimateConcurrency } from '../estimate-handler.js';
import { estimateAudit, estimateNeedsSandbox } from '../estimate.js';
import { detectEnvironment } from '../utils/project-detector.js';
import { createSandbox } from '../utils/sandbox.js';
import { createExecutionSession } from '../utils/execution.js';
import { MAX_TIMEOUT_MS } from '../utils/constants.js';

const mockEstimateAudit = vi.mocked(estimateAudit);
const mockEstimateNeedsSandbox = vi.mocked(estimateNeedsSandbox);
const mockDetectEnv = vi.mocked(detectEnvironment);
const mockCreateSandbox = vi.mocked(createSandbox);
const mockCreateExecutionSession = vi.mocked(createExecutionSession);
const mockStatSync = vi.mocked(statSync);

function req(args: Record<string, unknown>): CallToolRequest {
  return {
    method: 'tools/call',
    params: { name: 'estimate_audit', arguments: args },
  } as CallToolRequest;
}

/** Pull the text out of the first content block. */
function text(res: { content?: unknown[] }): string {
  return ((res.content?.[0] ?? {}) as { text?: string }).text ?? '';
}

const defaultEnv = {
  projectType: 'typescript' as const,
  testRunner: 'vitest',
  detectedRunner: 'vitest',
  packageManager: '',
  workspaceRoot: '/workspace',
};

const approxResult = {
  target: 'src/math.ts',
  language: 'typescript' as const,
  mutants: 12,
  fidelity: 'approx' as const,
  basis: 'source heuristic: 6 constructs',
  note: 'Approximate mutant count from a source-parse heuristic.',
};

describe('handleEstimateCall', () => {
  // Pin cwd so boundary and relFile calculations are deterministic on every runner.
  // `restoreMocks: true` un-installs this spy before every test, so it has to be
  // re-installed per test rather than once at describe-collection time.
  let cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace');
  afterAll(() => cwdSpy.mockRestore());

  beforeEach(() => {
    vi.clearAllMocks();
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace');
    cleanupSpy.mockReset();
    mockEstimateNeedsSandbox.mockReturnValue(false);
    mockDetectEnv.mockReturnValue(defaultEnv);
    // Default: every target resolves to a readable file. Cases that exercise a
    // missing or non-file target override this.
    mockStatSync.mockReturnValue({ isFile: () => true } as ReturnType<typeof statSync>);
  });

  // ── Input validation ──────────────────────────────────────────────────────

  it('rejects a missing filePath', async () => {
    const res = await handleEstimateCall(req({}));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/filePath is required/i);
  });

  it('rejects an empty filePath', async () => {
    const res = await handleEstimateCall(req({ filePath: '' }));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/filePath is required/i);
  });

  it('rejects a non-string filePath', async () => {
    const res = await handleEstimateCall(req({ filePath: 42 }));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/filePath is required/i);
  });

  it('rejects withTiming as a non-boolean', async () => {
    const res = await handleEstimateCall(req({ filePath: 'src/math.ts', withTiming: 'yes' }));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/withTiming must be a boolean/i);
  });

  /**
   * `timeoutMs` used to reach `resolveAuditTimeoutMs` unvalidated — it accepts
   * any `number > 0`, and Node CLAMPS a delay past MAX_TIMEOUT_MS to 1ms. The
   * estimate's own subprocess was therefore killed instantly and the failure
   * blamed on a timeout the caller had deliberately made enormous. Both sibling
   * tools reject these; the estimate now borrows their validator.
   */
  it.each([-1, 0, NaN, '60000', MAX_TIMEOUT_MS + 1])(
    'rejects timeoutMs=%p before doing any work',
    async (v) => {
      const res = await handleEstimateCall(req({ filePath: 'src/math.ts', timeoutMs: v }));
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/timeoutMs must be/i);
      // Rejected up-front: no estimate is attempted for an argument we refuse.
      expect(mockEstimateAudit).not.toHaveBeenCalled();
    },
  );

  it('accepts a timeoutMs at the clamp boundary', async () => {
    mockEstimateAudit.mockResolvedValue(approxResult);
    const res = await handleEstimateCall(
      req({ filePath: 'src/math.ts', timeoutMs: MAX_TIMEOUT_MS }),
    );
    expect(res.isError).toBeUndefined();
    expect(mockEstimateAudit).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: MAX_TIMEOUT_MS }),
    );
  });

  // ── C2 boundary enforcement ───────────────────────────────────────────────

  it('rejects a path outside the workspace (C2)', async () => {
    const res = await handleEstimateCall(req({ filePath: '/etc/passwd' }));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/workspace|outside|within/i);
  });

  it('rejects a path that escapes via traversal (C2)', async () => {
    const res = await handleEstimateCall(req({ filePath: '../../etc/shadow' }));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/workspace|outside|within/i);
  });

  // ── Unsupported extension ─────────────────────────────────────────────────

  it('returns an error for an unsupported file extension', async () => {
    const res = await handleEstimateCall(req({ filePath: 'src/main.cpp' }));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unsupported/i);
  });

  // ── Missing target ────────────────────────────────────────────────────────

  /**
   * A path that does not exist used to reach the heuristic, whose read failure
   * degrades to an empty source — reporting `mutants: 0` with the same shape a
   * genuinely trivial file produces. A caller reading that estimate concludes
   * there is nothing to audit, when in fact it mistyped the path or pointed at
   * the wrong workspace. Only an error distinguishes the two.
   */
  it('rejects a filePath that does not exist instead of estimating zero mutants', async () => {
    mockStatSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const res = await handleEstimateCall(req({ filePath: 'src/typo.ts' }));

    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not found/i);
    expect(text(res)).toContain('src/typo.ts');
    // The second sentence is the actionable half: without it a caller who typed
    // a cwd-relative path has no idea the path is resolved against the
    // workspace root instead.
    expect(text(res)).toContain('Paths are resolved relative to the workspace root.');
    expect(mockEstimateAudit).not.toHaveBeenCalled();
  });

  it('rejects a filePath that names a directory', async () => {
    mockStatSync.mockReturnValue({ isFile: () => false } as ReturnType<typeof statSync>);

    const res = await handleEstimateCall(req({ filePath: 'src/utils.ts' }));

    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not a file|not found/i);
    expect(mockEstimateAudit).not.toHaveBeenCalled();
  });

  // ── Happy path (no sandbox) ───────────────────────────────────────────────

  it('returns structuredContent with mutants and fidelity "approx" for a TS file', async () => {
    mockEstimateAudit.mockResolvedValue(approxResult);

    const res = await handleEstimateCall(req({ filePath: 'src/math.ts' }));

    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.mutants).toBe(12);
    expect(sc.fidelity).toBe('approx');
    expect(sc.language).toBe('typescript');
  });

  it('also returns the result serialised as JSON in content[0].text', async () => {
    mockEstimateAudit.mockResolvedValue(approxResult);

    const res = await handleEstimateCall(req({ filePath: 'src/math.ts' }));

    const parsed = JSON.parse(text(res)) as Record<string, unknown>;
    expect(parsed.mutants).toBe(12);
    expect(parsed.fidelity).toBe('approx');
  });

  it('passes absFile, relFile, and projectType to estimateAudit', async () => {
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts' }));

    expect(mockEstimateAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        absFile: '/workspace/src/math.ts',
        relFile: 'src/math.ts',
        projectType: 'typescript',
      }),
    );
  });

  it('does NOT provision a sandbox when estimateNeedsSandbox returns false', async () => {
    mockEstimateNeedsSandbox.mockReturnValue(false);
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts' }));

    expect(mockCreateSandbox).not.toHaveBeenCalled();
  });

  it('passes withTiming=false when the arg is absent', async () => {
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts' }));

    expect(mockEstimateAudit).toHaveBeenCalledWith(expect.objectContaining({ withTiming: false }));
  });

  it('passes withTiming=true when the arg is true', async () => {
    mockEstimateNeedsSandbox.mockReturnValue(true);
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts', withTiming: true }));

    expect(mockEstimateAudit).toHaveBeenCalledWith(expect.objectContaining({ withTiming: true }));
  });

  // ── Sandbox lifecycle when needed ─────────────────────────────────────────

  it('provisions a sandbox and cleans it up when estimateNeedsSandbox returns true', async () => {
    mockEstimateNeedsSandbox.mockReturnValue(true);
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts' }));

    expect(mockCreateSandbox).toHaveBeenCalledTimes(1);
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('cleans up the sandbox even when estimateAudit throws', async () => {
    mockEstimateNeedsSandbox.mockReturnValue(true);
    mockEstimateAudit.mockRejectedValue(new Error('cargo exploded'));

    const res = await handleEstimateCall(req({ filePath: 'src/math.ts' }));

    // Error is caught and returned as a tool error
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Chaos Engine Halted/i);
    // Sandbox was still cleaned up
    expect(cleanupSpy).toHaveBeenCalledTimes(1);
  });

  it('passes workDir from the sandbox to estimateAudit when a sandbox is provisioned', async () => {
    mockEstimateNeedsSandbox.mockReturnValue(true);
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts' }));

    expect(mockEstimateAudit).toHaveBeenCalledWith(
      expect.objectContaining({ workDir: '/tmp/chaos-estimate-sandbox' }),
    );
  });

  it('passes workDir=undefined to estimateAudit when no sandbox is provisioned', async () => {
    mockEstimateNeedsSandbox.mockReturnValue(false);
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts' }));

    expect(mockEstimateAudit).toHaveBeenCalledWith(expect.objectContaining({ workDir: undefined }));
  });

  // ── Config plumbing ───────────────────────────────────────────────────────

  it('passes defaultTimeoutMs from config to estimateAudit', async () => {
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts' }), { defaultTimeoutMs: 90_000 });

    expect(mockEstimateAudit).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 90_000 }));
  });

  // ── Python / Go / other supported types ──────────────────────────────────

  // ── Cancellation ──────────────────────────────────────────────────────────

  it('returns a cancelled error immediately when ctx.signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const res = await handleEstimateCall(req({ filePath: 'src/math.ts' }), undefined, {
      signal: controller.signal,
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/cancelled/i);
    // estimateAudit should NOT have been called
    expect(mockEstimateAudit).not.toHaveBeenCalled();
  });

  it('passes signal from ctx into estimateAudit', async () => {
    mockEstimateAudit.mockResolvedValue(approxResult);
    const controller = new AbortController();

    await handleEstimateCall(req({ filePath: 'src/math.ts' }), undefined, {
      signal: controller.signal,
    });

    expect(mockEstimateAudit).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('reports a mid-flight cancellation as a cancel, not an engine failure', async () => {
    // The pre-abort check above returns before the try block, so nothing else
    // reaches the catch-side isCancel. A caller branches on this exact string to
    // tell "I cancelled this" from "the estimate broke".
    mockEstimateAudit.mockRejectedValueOnce(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );
    const controller = new AbortController();

    const res = await handleEstimateCall(req({ filePath: 'src/math.ts' }), undefined, {
      signal: controller.signal,
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Operation cancelled.');
  });

  it('reports a cancel that lands on a NON-throwing path as cancelled', async () => {
    // The catch-side `isCancel` is only reachable when something throws, and
    // estimateAudit has non-throwing paths that survive an abort — the Rust
    // count degraded a startup failure to a heuristic result and returned
    // normally, and a signal flipped between the last subprocess and the return
    // is never observed at all. Without a post-run check the caller got a
    // successful structuredContent estimate (isError unset) for cancelled work,
    // which is indistinguishable from a completed one.
    const controller = new AbortController();
    mockEstimateAudit.mockImplementationOnce(async () => {
      controller.abort(); // cancel lands mid-flight; nothing throws
      return approxResult;
    });

    const res = await handleEstimateCall(req({ filePath: 'src/math.ts' }), undefined, {
      signal: controller.signal,
    });

    expect(res.isError).toBe(true);
    expect(text(res)).toBe('Operation cancelled.');
    expect(res.structuredContent).toBeUndefined();
  });

  it('still returns the estimate when the signal was never aborted', async () => {
    // The other arm of the post-run guard: an ordinary run must not be
    // mistaken for a cancelled one.
    const controller = new AbortController();
    mockEstimateAudit.mockResolvedValue(approxResult);

    const res = await handleEstimateCall(req({ filePath: 'src/math.ts' }), undefined, {
      signal: controller.signal,
    });

    expect(res.isError).toBeUndefined();
    expect((res.structuredContent as Record<string, unknown>).mutants).toBe(12);
  });

  it('reports a genuine engine failure as halted, not as a cancel', async () => {
    // The other arm of the same branch: without it, forcing isCancel to false
    // is invisible because no test distinguishes the two messages.
    mockEstimateAudit.mockRejectedValueOnce(new Error('engine exploded'));
    const res = await handleEstimateCall(req({ filePath: 'src/math.ts' }));
    expect(text(res)).toBe('Chaos Engine Halted: engine exploded');
  });

  it('hands the abort signal to createSandbox so provisioning is cancellable', async () => {
    // The sandbox copy is the slowest part of a timed estimate; without the
    // signal a cancel cannot interrupt it and the copy runs to completion with
    // nobody waiting for it.
    mockEstimateNeedsSandbox.mockReturnValue(true);
    mockEstimateAudit.mockResolvedValue(approxResult);
    const controller = new AbortController();

    await handleEstimateCall(req({ filePath: 'src/math.ts' }), undefined, {
      signal: controller.signal,
    });

    expect(mockCreateSandbox).toHaveBeenCalledWith(
      'src/math.ts',
      '/workspace',
      undefined,
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('does not throw when ctx is supplied without a signal', async () => {
    // `ctx?.signal?.aborted` must stay null-safe when signal is absent (kills the
    // mutant that drops the optional chain after `.signal`).
    mockEstimateAudit.mockResolvedValue(approxResult);
    const res = await handleEstimateCall(req({ filePath: 'src/math.ts' }), undefined, {});
    expect(res.isError).toBeUndefined();
    expect(mockEstimateAudit).toHaveBeenCalled();
  });

  it('emits the result as a "text" content block', async () => {
    mockEstimateAudit.mockResolvedValue(approxResult);
    const res = await handleEstimateCall(req({ filePath: 'src/math.ts' }));
    expect((res.content?.[0] as { type?: string }).type).toBe('text');
  });

  // ── relFile re-anchoring (line 74) ────────────────────────────────────────

  it('falls back to the raw filePath when the workspace root is below the target', async () => {
    // workspaceRoot deeper than the file → relative() yields a "../" path, which
    // must NOT be used; relFile falls back to rawFilePath.
    mockDetectEnv.mockReturnValue({ ...defaultEnv, workspaceRoot: '/workspace/pkg' });
    mockEstimateAudit.mockResolvedValue(approxResult);
    await handleEstimateCall(req({ filePath: 'src/math.ts' }));
    expect(mockEstimateAudit).toHaveBeenCalledWith(
      expect.objectContaining({ relFile: 'src/math.ts' }),
    );
  });

  it('re-anchors the target to the workspace root in a monorepo', async () => {
    // The whole point of the re-anchor: cwd is the package, but the workspace
    // root is the repo, so the engine must be given the repo-relative path.
    // Every other case in this file has rawFilePath === relFromRoot, so the two
    // arms of the ternary return the same string and none of them can tell a
    // working re-anchor from one that always falls back.
    cwdSpy.mockReturnValue('/workspace/pkg');
    mockDetectEnv.mockReturnValue({ ...defaultEnv, workspaceRoot: '/workspace' });
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts' }));

    expect(mockEstimateAudit).toHaveBeenCalledWith(
      expect.objectContaining({ relFile: 'pkg/src/math.ts' }),
    );
  });

  it('falls back to the raw filePath when the target IS the workspace root', async () => {
    // `relative()` returns '' for a path equal to the root. An empty relFile
    // would reach the engine as "mutate nothing"; the length guard is what
    // sends the raw path through instead.
    mockDetectEnv.mockReturnValue({ ...defaultEnv, workspaceRoot: '/workspace/src/math.ts' });
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts' }));

    expect(mockEstimateAudit).toHaveBeenCalledWith(
      expect.objectContaining({ relFile: 'src/math.ts' }),
    );
  });

  // ── Concurrency projection (line 83) ──────────────────────────────────────

  it('passes conservative concurrency = max(1, min(2, cpus-1)) to estimateAudit', async () => {
    mockEstimateAudit.mockResolvedValue(approxResult);
    await handleEstimateCall(req({ filePath: 'src/math.ts' }));
    expect(mockEstimateAudit).toHaveBeenCalledWith(
      expect.objectContaining({ concurrency: Math.max(1, Math.min(2, cpus().length - 1)) }),
    );
  });

  // ── Timeout config plumbing (line 108) ────────────────────────────────────

  it('passes the default 5-minute budget when no config is supplied', async () => {
    mockEstimateAudit.mockResolvedValue(approxResult);
    await handleEstimateCall(req({ filePath: 'src/math.ts' }));
    expect(mockEstimateAudit).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 300_000 }));
  });

  it('treats a non-positive defaultTimeoutMs as the standard budget', async () => {
    mockEstimateAudit.mockResolvedValue(approxResult);
    await handleEstimateCall(req({ filePath: 'src/math.ts' }), { defaultTimeoutMs: 0 });
    expect(mockEstimateAudit).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 300_000 }));
  });

  it('treats a non-numeric defaultTimeoutMs as the standard budget', async () => {
    mockEstimateAudit.mockResolvedValue(approxResult);
    await handleEstimateCall(req({ filePath: 'src/math.ts' }), {
      defaultTimeoutMs: 'soon' as never,
    });
    expect(mockEstimateAudit).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 300_000 }));
  });

  // ── The budget must be the one the AUDIT would use (audit finding: the
  //    estimate graded fitsBudget against a different number) ────────────────

  it('prefers the engine-section timeoutMs over defaultTimeoutMs, as the audit does', async () => {
    // Scenario B: `"stryker": { "timeoutMs": 900000 }` with a 60s global
    // default. audit_code_resilience resolves 900s (resolveAuditTimeoutMs:
    // arg → engine section → global default). The estimate read only
    // `cfg.defaultTimeoutMs`, so it graded `fitsBudget` against 60s and
    // recommended narrowing a run that would have fit comfortably.
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts' }), {
      defaultTimeoutMs: 60_000,
      stryker: { timeoutMs: 900_000 },
    });

    expect(mockEstimateAudit).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 900_000 }));
  });

  it('ignores another engine section when resolving the budget', async () => {
    // The section must match the engine that would run: a TypeScript target
    // must not inherit the Rust budget.
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts' }), {
      defaultTimeoutMs: 60_000,
      rust: { timeoutMs: 900_000 },
    });

    expect(mockEstimateAudit).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 60_000 }));
  });

  // ── The runner must be resolved the same way the audit resolves it ────────

  it('passes the config-resolved test runner, not the detected one', async () => {
    // Scenario A: the project detects as vitest but config pins the Stryker
    // command runner. The audit obeys the config; the estimate used to compare
    // `env.testRunner` and so projected with the native constants — a ~4×
    // under-estimate reported as fitting the budget.
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts', withTiming: true }), {
      stryker: { testRunner: 'command' },
    });

    expect(mockEstimateAudit).toHaveBeenCalledWith(
      expect.objectContaining({ testRunner: 'command' }),
    );
  });

  it('falls back to the detected runner when no config overrides it', async () => {
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts', withTiming: true }));

    expect(mockEstimateAudit).toHaveBeenCalledWith(
      expect.objectContaining({ testRunner: 'vitest' }),
    );
  });

  it('uses the global config testRunner over detection when no engine section applies', async () => {
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts' }), { testRunner: 'jest' });

    expect(mockEstimateAudit).toHaveBeenCalledWith(expect.objectContaining({ testRunner: 'jest' }));
  });

  it('rejects a NUMERIC STRING defaultTimeoutMs rather than passing it through', async () => {
    // `'90000' > 0` is true, so the `> 0` half of the guard accepts it and only
    // the typeof check stops it. Passing the string on would hand the engine a
    // budget it compares numerically elsewhere — the classic JSON-config
    // mistake this guard exists for.
    mockEstimateAudit.mockResolvedValue(approxResult);
    await handleEstimateCall(req({ filePath: 'src/math.ts' }), {
      defaultTimeoutMs: '90000' as never,
    });
    expect(mockEstimateAudit).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 300_000 }));
  });

  // ── Sandbox provisioning failure (line 91) ────────────────────────────────

  it('returns a provisioning error when createSandbox throws', async () => {
    mockEstimateNeedsSandbox.mockReturnValue(true);
    mockCreateSandbox.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const res = await handleEstimateCall(req({ filePath: 'src/math.ts' }));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Failed to provision sandbox/i);
    // estimateAudit must NOT run if the sandbox could not be created.
    expect(mockEstimateAudit).not.toHaveBeenCalled();
  });

  it('uses and disposes a container session for sandboxed estimates', async () => {
    mockEstimateNeedsSandbox.mockReturnValue(true);
    const executor = {
      kind: 'container' as const,
      workDir: '/tmp/chaos-estimate-sandbox',
      run: vi.fn(),
      runCommand: vi.fn(),
      dispose: vi.fn().mockResolvedValue(undefined),
    };
    mockCreateExecutionSession.mockResolvedValue(executor);
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts', withTiming: true }), {
      container: { mode: 'container' },
    });

    expect(mockCreateExecutionSession).toHaveBeenCalledWith(
      'typescript',
      '/tmp/chaos-estimate-sandbox',
      { mode: 'container' },
      undefined,
    );
    expect(mockEstimateAudit).toHaveBeenCalledWith(expect.objectContaining({ executor }));
    expect(executor.dispose).toHaveBeenCalledOnce();
    expect(cleanupSpy).toHaveBeenCalledOnce();
    expect(executor.dispose.mock.invocationCallOrder[0]).toBeLessThan(
      cleanupSpy.mock.invocationCallOrder[0],
    );
  });

  it('does not create a container when an estimate needs no sandbox', async () => {
    mockEstimateNeedsSandbox.mockReturnValue(false);
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts' }), {
      container: { mode: 'container' },
    });

    expect(mockCreateExecutionSession).not.toHaveBeenCalled();
    const options = mockEstimateAudit.mock.calls[0]?.[0];
    expect(options && Object.hasOwn(options, 'executor')).toBe(true);
    expect(options?.executor).toBeUndefined();
  });

  it('does not create a container for explicit native mode', async () => {
    mockEstimateNeedsSandbox.mockReturnValue(true);
    mockEstimateAudit.mockResolvedValue(approxResult);

    await handleEstimateCall(req({ filePath: 'src/math.ts' }), {
      container: { mode: 'native' },
    });

    expect(mockCreateExecutionSession).not.toHaveBeenCalled();
  });

  it('handles a Python file (.py) successfully', async () => {
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });
    mockEstimateAudit.mockResolvedValue({
      target: 'src/calc.py',
      language: 'python',
      mutants: 7,
      fidelity: 'approx',
      basis: 'source heuristic: 4 constructs',
      note: 'Approximate.',
    });

    const res = await handleEstimateCall(req({ filePath: 'src/calc.py' }));

    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.language).toBe('python');
    expect(sc.mutants).toBe(7);
  });
});

describe('resolveEstimateConcurrency', () => {
  it('reserves one CPU before applying the two-worker cap', () => {
    expect(resolveEstimateConcurrency(1)).toBe(1);
    expect(resolveEstimateConcurrency(2)).toBe(1);
    expect(resolveEstimateConcurrency(3)).toBe(2);
    expect(resolveEstimateConcurrency(8)).toBe(2);
  });
});
