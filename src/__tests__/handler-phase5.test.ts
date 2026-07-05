/**
 * Phase 5 tests: audit progress milestones + cancellation.
 *
 * Covers:
 *   (a) A successful audit with ctx.reportProgress records all 4 milestones in
 *       order: (1,4,'validating'), (2,4,'provisioning sandbox'),
 *       (3,4,'running mutation engine'), (4,4,'complete').
 *   (b) A pre-aborted ctx.signal short-circuits before createSandbox is called and
 *       returns a cancelled error result.
 *
 * Uses the same engine-stub / mocking pattern as handler.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// ── same mocks as handler.test.ts ──────────────────────────────────────────

vi.mock('../engines/typescript.js', () => ({
  TypeScriptEngine: vi.fn(),
}));
vi.mock('../engines/python.js', () => ({
  PythonEngine: vi.fn(),
}));
vi.mock('../engines/go.js', () => ({
  GoEngine: vi.fn(),
}));
vi.mock('../engines/rust.js', () => ({
  RustEngine: vi.fn(),
}));

vi.mock('../utils/project-detector.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/project-detector.js')>(
    '../utils/project-detector.js',
  );
  return { ...actual, detectEnvironment: vi.fn() };
});

vi.mock('../utils/sandbox.js', () => ({
  createSandbox: vi.fn(),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    realpathSync: vi.fn((p: string) => p),
  };
});

vi.mock('../utils/exec.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/exec.js')>('../utils/exec.js');
  return { ...actual, runShellCommand: vi.fn() };
});

vi.mock('../utils/git-diff.js', () => ({
  computeChangedRanges: vi.fn(),
}));

vi.mock('../utils/logger.js', () => ({
  enableVerbose: vi.fn(),
  isVerbose: vi.fn().mockReturnValue(false),
  log: vi.fn(),
  warn: vi.fn(),
}));

// ── imports ────────────────────────────────────────────────────────────────

import { handleToolCall } from '../index.js';
import { TypeScriptEngine } from '../engines/typescript.js';
import { detectEnvironment } from '../utils/project-detector.js';
import { createSandbox } from '../utils/sandbox.js';
import { computeChangedRanges } from '../utils/git-diff.js';
import type { ToolContext } from '../tool-context.js';

const MockTSEngine = vi.mocked(TypeScriptEngine);
const mockDetectEnv = vi.mocked(detectEnvironment);
const mockCreateSandbox = vi.mocked(createSandbox);
const mockComputeChangedRanges = vi.mocked(computeChangedRanges);

// ── helpers ────────────────────────────────────────────────────────────────

function makeRequest(args: Record<string, unknown>): CallToolRequest {
  return {
    method: 'tools/call',
    params: { name: 'audit_code_resilience', arguments: args },
  };
}

/** Stub engine whose run() resolves to a clean 100% result. */
function stubCleanRun(): void {
  MockTSEngine.mockImplementation(
    () =>
      ({
        run: vi.fn().mockResolvedValue({
          target: 'src/math.ts',
          totalMutants: 2,
          killed: 2,
          survived: 0,
          mutationScore: '100.00%',
          vulnerabilities: [],
        }),
      }) as unknown as TypeScriptEngine,
  );
}

/** Default detectEnvironment stub pointing at /workspace. */
function stubWorkspaceEnv(): void {
  mockDetectEnv.mockReturnValue({
    projectType: 'typescript',
    testRunner: 'vitest',
    detectedRunner: 'vitest',
    workspaceRoot: '/workspace',
  });
}

// ── suite ──────────────────────────────────────────────────────────────────

describe('handleToolCall — Phase 5: progress milestones + cancellation', () => {
  // Pin cwd so workspace re-anchoring is deterministic (same rationale as
  // handler.test.ts — prevents Forgejo /workspace/<owner>/<repo> breakage).
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace');
  afterAll(() => cwdSpy.mockRestore());

  beforeEach(() => {
    vi.clearAllMocks();
    cwdSpy.mockReturnValue('/workspace');

    // Default sandbox mock
    mockCreateSandbox.mockReturnValue({
      workDir: '/tmp/chaos-mcp-sandbox',
      targetFile: '',
      cleanup: vi.fn(),
    });
  });

  // ── (a) Milestone ordering ───────────────────────────────────────────────

  it('reports all 4 milestones in order on a successful audit', async () => {
    stubCleanRun();
    stubWorkspaceEnv();

    const calls: [number, number | undefined, string | undefined][] = [];
    const ctx: ToolContext = {
      reportProgress: (progress, total, message) => {
        calls.push([progress, total, message]);
      },
    };

    const request = makeRequest({ filePath: 'src/math.ts' });
    const response = await handleToolCall(request, undefined, ctx);

    expect(response.isError).toBeUndefined();

    expect(calls).toEqual([
      [1, 4, 'validating'],
      [2, 4, 'provisioning sandbox'],
      [3, 4, 'running mutation engine'],
      [4, 4, 'complete'],
    ]);
  });

  it('no-ops gracefully when ctx is omitted (existing callers unaffected)', async () => {
    stubCleanRun();
    stubWorkspaceEnv();

    const request = makeRequest({ filePath: 'src/math.ts' });
    // No ctx — should not throw
    const response = await handleToolCall(request);
    expect(response.isError).toBeUndefined();
  });

  it('no-ops gracefully when ctx has no reportProgress', async () => {
    stubCleanRun();
    stubWorkspaceEnv();

    const ctx: ToolContext = {}; // signal and reportProgress both absent
    const request = makeRequest({ filePath: 'src/math.ts' });
    const response = await handleToolCall(request, undefined, ctx);
    expect(response.isError).toBeUndefined();
  });

  // ── (b) Pre-aborted signal ───────────────────────────────────────────────

  it('returns a cancelled error immediately when signal is pre-aborted (abort check #1)', async () => {
    // We deliberately do NOT set up engine or detectEnvironment stubs here —
    // if any of them were called, the test would likely throw or produce
    // unexpected output, revealing that the early abort did not fire.

    const controller = new AbortController();
    controller.abort();

    const ctx: ToolContext = { signal: controller.signal };
    const request = makeRequest({ filePath: 'src/math.ts' });
    const response = await handleToolCall(request, undefined, ctx);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toBe('Operation cancelled.');

    // Sandbox must NOT have been provisioned — abort fires before createSandbox.
    expect(mockCreateSandbox).not.toHaveBeenCalled();
  });

  it('does NOT emit milestone 1 (validating) when signal is pre-aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const calls: number[] = [];
    const ctx: ToolContext = {
      signal: controller.signal,
      reportProgress: (progress) => {
        calls.push(progress);
      },
    };

    const request = makeRequest({ filePath: 'src/math.ts' });
    await handleToolCall(request, undefined, ctx);

    // Abort fires before reportProgress(1, …) so no milestones emitted.
    expect(calls).toEqual([]);
  });

  it('cancelled result shape is consistent with toolError (isError true, single text content)', async () => {
    const controller = new AbortController();
    controller.abort();

    const ctx: ToolContext = { signal: controller.signal };
    const request = makeRequest({ filePath: 'src/math.ts' });
    const response = await handleToolCall(request, undefined, ctx);

    expect(response.isError).toBe(true);
    expect(response.content).toHaveLength(1);
    expect(response.content[0]).toMatchObject({ type: 'text', text: 'Operation cancelled.' });
  });

  // ── (b') Abort DURING the engine run (audit M5) ──────────────────────────

  it('reports "Operation cancelled." when the engine run is aborted mid-flight (audit M5)', async () => {
    stubWorkspaceEnv();

    // Simulate a cancel landing while the engine is running: the controller
    // aborts and the engine rejects (as an aborted child would surface). The
    // handler must map this to the cancellation shape, not a phantom tool bug.
    const controller = new AbortController();
    MockTSEngine.mockImplementation(
      () =>
        ({
          run: vi.fn().mockImplementation(async () => {
            controller.abort();
            throw new Error(
              'cargo-mutants failed (exit null): the baseline test suite itself failed',
            );
          }),
        }) as unknown as TypeScriptEngine,
    );

    const ctx: ToolContext = { signal: controller.signal };
    const request = makeRequest({ filePath: 'src/math.ts' });
    const response = await handleToolCall(request, undefined, ctx);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toBe('Operation cancelled.');
  });

  // ── (c) Milestone 4 on no-changes short-circuit path ─────────────────────

  it('emits (4,4,complete) on the no-changes short-circuit terminal path', async () => {
    // diffBase triggers computeChangedRanges; no-changes causes computeScope to
    // return { kind: 'result' } immediately (before sandbox provisioning).
    // handler.ts line ~928: if (!scope.result.isError) ctx?.reportProgress?.(4, 4, 'complete')
    stubWorkspaceEnv();
    // Engine stub not needed — the short-circuit fires before auditFile is called.
    mockComputeChangedRanges.mockResolvedValue({ kind: 'no-changes' });

    const calls: [number, number | undefined, string | undefined][] = [];
    const ctx: ToolContext = {
      reportProgress: (progress, total, message) => {
        calls.push([progress, total, message]);
      },
    };

    const request = makeRequest({ filePath: 'src/math.ts', diffBase: 'HEAD' });
    const response = await handleToolCall(request, undefined, ctx);

    expect(response.isError).toBeUndefined();
    // Sandbox must not have been provisioned — we short-circuited before it.
    expect(mockCreateSandbox).not.toHaveBeenCalled();
    // The last call must be the complete milestone.
    expect(calls[calls.length - 1]).toEqual([4, 4, 'complete']);
  });

  // ── (d) Milestone 4 on verify-mode terminal path ─────────────────────────

  it('emits (4,4,complete) on the verify-mode terminal path', async () => {
    // baseline arg drives verify mode: computeScope returns { kind: 'scope', baselineKeys }
    // and the main branch emits milestone 4 at line ~1081 before formatAuditOutput.
    stubCleanRun();
    stubWorkspaceEnv();

    const calls: [number, number | undefined, string | undefined][] = [];
    const ctx: ToolContext = {
      reportProgress: (progress, total, message) => {
        calls.push([progress, total, message]);
      },
    };

    const request = makeRequest({
      filePath: 'src/math.ts',
      baseline: { survivors: [{ line: 1, mutators: { ArithmeticOperator: 1 } }] },
    });
    const response = await handleToolCall(request, undefined, ctx);

    expect(response.isError).toBeUndefined();
    // The last call must be the complete milestone (emitted before formatAuditOutput).
    expect(calls[calls.length - 1]).toEqual([4, 4, 'complete']);
  });
});
