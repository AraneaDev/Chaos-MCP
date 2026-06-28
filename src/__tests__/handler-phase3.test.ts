import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Mocks (mirror handler.test.ts so handleToolCall can run with a stub engine) ──
vi.mock('../engines/typescript.js', () => ({ TypeScriptEngine: vi.fn() }));
vi.mock('../engines/python.js', () => ({ PythonEngine: vi.fn() }));
vi.mock('../engines/go.js', () => ({ GoEngine: vi.fn() }));
vi.mock('../engines/rust.js', () => ({ RustEngine: vi.fn() }));

vi.mock('../utils/project-detector.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/project-detector.js')>(
    '../utils/project-detector.js',
  );
  return { ...actual, detectEnvironment: vi.fn() };
});

vi.mock('../utils/sandbox.js', () => ({ createSandbox: vi.fn() }));

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

vi.mock('../utils/git-diff.js', () => ({ computeChangedRanges: vi.fn() }));

vi.mock('../utils/logger.js', () => ({
  enableVerbose: vi.fn(),
  isVerbose: vi.fn().mockReturnValue(false),
  log: vi.fn(),
  warn: vi.fn(),
}));

import { handleToolCall } from '../index.js';
import { TypeScriptEngine } from '../engines/typescript.js';
import { detectEnvironment } from '../utils/project-detector.js';
import { createSandbox } from '../utils/sandbox.js';
import { loadRun, saveRun } from '../utils/run-cache.js';
import { loadSuppressions, addSuppressions } from '../utils/suppression.js';
import type { MutationResult } from '../engines/base.js';

const MockTSEngine = vi.mocked(TypeScriptEngine);
const mockDetectEnv = vi.mocked(detectEnvironment);
const mockCreateSandbox = vi.mocked(createSandbox);

const WS = '/workspace';
const FILE = 'src/math.ts';
const RESOLVED = `${WS}/${FILE}`;

function makeRequest(args: Record<string, unknown>): CallToolRequest {
  return { method: 'tools/call', params: { name: 'audit_code_resilience', arguments: args } };
}

function stubEngine(result: MutationResult): ReturnType<typeof vi.fn> {
  const run = vi.fn().mockResolvedValue(result);
  MockTSEngine.mockImplementation(() => ({ run }) as unknown as TypeScriptEngine);
  return run;
}

function cleanResult(): MutationResult {
  return {
    target: FILE,
    totalMutants: 4,
    killed: 4,
    survived: 0,
    mutationScore: '100.00%',
    vulnerabilities: [],
  };
}

function resultWithSurvivor(): MutationResult {
  return {
    target: FILE,
    totalMutants: 4,
    killed: 3,
    survived: 1,
    mutationScore: '75.00%',
    vulnerabilities: [
      {
        line: 7,
        mutator: 'ConditionalExpression',
        description: 'Survived: changed condition',
      },
    ],
  };
}

describe('phase3 run-cache integration seam', () => {
  it('a saved run is retrievable by the id it returns', () => {
    const id = saveRun({
      file: 'src/x.ts',
      projectType: 'typescript',
      survivors: [{ line: 3, mutators: { Cond: 1 } }],
      noCoverage: [],
    });
    const got = loadRun(id);
    expect(got?.survivors[0].line).toBe(3);
  });
});

describe('handleToolCall phase3 wiring', () => {
  const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(WS);
  afterAll(() => cwdSpy.mockRestore());

  let supPath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    cwdSpy.mockReturnValue(WS);
    mockCreateSandbox.mockReturnValue({
      workDir: '/tmp/chaos-mcp-sandbox',
      targetFile: '',
      cleanup: vi.fn(),
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      workspaceRoot: WS,
    });
    // Isolate suppression writes to a throwaway absolute file per test.
    supPath = join(mkdtempSync(join(tmpdir(), 'chaos-sup-')), 'suppressions.json');
  });

  it('mints a runId on a non-verify run and the cache round-trips the survivors', async () => {
    stubEngine(resultWithSurvivor());
    const res = await handleToolCall(makeRequest({ filePath: FILE }));
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    const runId = sc.runId as string;
    expect(typeof runId).toBe('string');
    const cached = loadRun(runId);
    expect(cached?.file).toBe(RESOLVED);
    expect(cached?.survivors[0]).toMatchObject({ line: 7 });
  });

  it('does NOT mint a runId on a verify-by-runId run', async () => {
    const runId = saveRun({
      file: RESOLVED,
      projectType: 'typescript',
      survivors: [{ line: 7, mutators: { ConditionalExpression: 1 } }],
      noCoverage: [],
    });
    const run = stubEngine(resultWithSurvivor());
    const res = await handleToolCall(makeRequest({ filePath: FILE, runId }));
    expect(res.isError).toBeUndefined();
    // Verify mode keeps its own formatter: no structuredContent payload.
    expect(res.structuredContent).toBeUndefined();
    // Scope was derived from the baseline lines (TS supports line scope).
    expect(run).toHaveBeenCalledWith(
      FILE,
      expect.objectContaining({ lineRanges: [{ start: 7, end: 7 }] }),
    );
  });

  it('rejects an unknown runId with a clear error', async () => {
    stubEngine(cleanResult());
    const res = await handleToolCall(makeRequest({ filePath: FILE, runId: 'deadbeef' }));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found or expired');
  });

  it('rejects a runId whose cached file does not match the target', async () => {
    const runId = saveRun({
      file: `${WS}/src/other.ts`,
      projectType: 'typescript',
      survivors: [{ line: 1, mutators: { Cond: 1 } }],
      noCoverage: [],
    });
    stubEngine(cleanResult());
    const res = await handleToolCall(makeRequest({ filePath: FILE, runId }));
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('was for');
  });

  it('filters suppressed mutants out of the result and reports suppressedCount', async () => {
    addSuppressions(WS, RESOLVED, [{ line: 7, mutator: 'ConditionalExpression' }], supPath);
    stubEngine(resultWithSurvivor());
    const res = await handleToolCall(makeRequest({ filePath: FILE }), {
      suppressionsPath: supPath,
    });
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.suppressedCount).toBe(1);
    expect(sc.survivors).toEqual([]);
  });

  it('writes a suppression on suppress and applies it within the same call', async () => {
    stubEngine(resultWithSurvivor());
    const res = await handleToolCall(
      makeRequest({
        filePath: FILE,
        suppress: [{ line: 7, mutator: 'ConditionalExpression', reason: 'equivalent' }],
      }),
      { suppressionsPath: supPath },
    );
    expect(res.isError).toBeUndefined();
    const sc = res.structuredContent as Record<string, unknown>;
    expect(sc.suppressedCount).toBe(1);
    const persisted = loadSuppressions(WS, supPath).get(RESOLVED);
    expect(persisted?.has('7 ConditionalExpression')).toBe(true);
  });
});
