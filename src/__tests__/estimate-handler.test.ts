import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// Mock estimate functions before importing the handler.
vi.mock('../estimate.js', () => ({
  estimateAudit: vi.fn(),
  estimateNeedsSandbox: vi.fn().mockReturnValue(false),
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

// Mock realpathSync (used by isRealPathInside in handler.ts) to be identity,
// so boundary tests work without a real filesystem.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    realpathSync: vi.fn((p: string) => p),
  };
});

import { handleEstimateCall } from '../estimate-handler.js';
import { estimateAudit, estimateNeedsSandbox } from '../estimate.js';
import { detectEnvironment } from '../utils/project-detector.js';
import { createSandbox } from '../utils/sandbox.js';

const mockEstimateAudit = vi.mocked(estimateAudit);
const mockEstimateNeedsSandbox = vi.mocked(estimateNeedsSandbox);
const mockDetectEnv = vi.mocked(detectEnvironment);
const mockCreateSandbox = vi.mocked(createSandbox);

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
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace');
  afterAll(() => cwdSpy.mockRestore());

  beforeEach(() => {
    vi.clearAllMocks();
    cwdSpy.mockReturnValue('/workspace');
    cleanupSpy.mockReset();
    mockEstimateNeedsSandbox.mockReturnValue(false);
    mockDetectEnv.mockReturnValue(defaultEnv);
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

  it('handles a Python file (.py) successfully', async () => {
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
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
