/**
 * Handler-level coverage for Task 7: the audit's resource-governance wiring.
 *
 * `createResourceContext` (core/resource-context.ts) is stubbed rather than
 * exercised for real, so these tests can drive its watchdog deterministically
 * (no real memory probing, no timers) and stay decoupled from the machine
 * running the suite. Follows the mocking style already used in handler.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from '../core/tool-context.js';
import { ResourceExhaustedError } from '../utils/resources/errors.js';

vi.mock('../engines/typescript.js', () => ({
  TypeScriptEngine: vi.fn(),
}));
vi.mock('../engines/python.js', () => ({
  PythonEngine: vi.fn(),
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
    existsSync: vi.fn(() => false),
    realpathSync: vi.fn((p: string) => p),
  };
});

vi.mock('../utils/logger.js', () => ({
  enableVerbose: vi.fn(),
  isVerbose: vi.fn(() => false),
  log: vi.fn(),
  warn: vi.fn(),
}));

// The module under test for this file: every test controls the resource
// context returned to the handler, rather than exercising the real probe.
vi.mock('../core/resource-context.js', () => ({
  createResourceContext: vi.fn(),
}));

import { handleToolCall } from '../index.js';
import { TypeScriptEngine } from '../engines/typescript.js';
import { detectEnvironment } from '../utils/project-detector.js';
import { createSandbox } from '../utils/sandbox.js';
import { createResourceContext } from '../core/resource-context.js';

const MockTSEngine = vi.mocked(TypeScriptEngine);
const mockDetectEnv = vi.mocked(detectEnvironment);
const mockCreateSandbox = vi.mocked(createSandbox);
const mockCreateResourceContext = vi.mocked(createResourceContext);

const GIB = 1024 ** 3;

function makeRequest(args: Record<string, unknown>): CallToolRequest {
  return {
    method: 'tools/call',
    params: { name: 'audit_code_resilience', arguments: args },
  };
}

/** A resource context whose watchdog never trips, for the "normal" tests. */
function stubResources() {
  return {
    budget: { fileConcurrency: 1, perFileWorkers: 2, overBudget: false },
    watchdog: {
      register: vi.fn((_controller: AbortController) => ({ release: vi.fn() })),
      admit: vi.fn().mockResolvedValue('admitted'),
      tick: vi.fn(),
      stop: vi.fn(),
      trips: 0,
    },
    innerEnv: {},
    workerCostBytes: 300 * 1024 ** 2,
    report: () => ({
      availableAtStartBytes: 4 * GIB,
      limitBytes: 8 * GIB,
      source: 'host' as const,
      fileConcurrency: 1,
      perFileWorkers: 2,
      overBudget: false,
      watchdogTrips: 0,
    }),
    dispose: vi.fn(),
  };
}

describe('audit_code_resilience resource governance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSandbox.mockResolvedValue({
      workDir: '/tmp/chaos-mcp-sandbox',
      targetFile: '',
      cleanup: vi.fn(),
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });
  });

  it('includes a resources block in the payload', async () => {
    const resources = stubResources();
    mockCreateResourceContext.mockReturnValue(
      resources as unknown as ReturnType<typeof createResourceContext>,
    );

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 2,
      killed: 2,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    const response = await handleToolCall(makeRequest({ filePath: 'src/math.ts' }));

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent).toMatchObject({
      resources: {
        source: 'host',
        fileConcurrency: 1,
        perFileWorkers: 2,
        overBudget: false,
        watchdogTrips: 0,
      },
    });
    // The watchdog slot and sampler are released once the run is done.
    expect(resources.watchdog.register).toHaveBeenCalledTimes(1);
    expect(resources.dispose).toHaveBeenCalledTimes(1);
  });

  it('reports a memory stop as the resource-exhausted message, not a cancel', async () => {
    const resources = stubResources();
    // The watchdog aborts the run's OWN controller (not the request's ctx.signal)
    // the moment it is registered, exactly as a real trip would mid-run.
    resources.watchdog.register = vi.fn((controller: AbortController) => {
      controller.abort(new ResourceExhaustedError(100 * 1024 ** 2, 512 * 1024 ** 2));
      return { release: vi.fn() };
    });
    mockCreateResourceContext.mockReturnValue(
      resources as unknown as ReturnType<typeof createResourceContext>,
    );

    // The engine sees its child killed by the abort and misreports it the same
    // way a real aborted child does: as a generic failure, not an AbortError.
    const mockRun = vi.fn().mockRejectedValue(new Error('engine exited with code null'));
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    const response = await handleToolCall(makeRequest({ filePath: 'src/math.ts' }));

    expect(response.isError).toBe(true);
    const text = (response.content[0] as { text: string }).text;
    expect(text).toMatch(/^Stopped to avoid exhausting memory/);
    expect(text).not.toBe('Operation cancelled.');
    expect(resources.dispose).toHaveBeenCalledTimes(1);
  });

  it('reports a memory stop DURING sandbox creation as the resource-exhausted message (IMPORTANT 5)', async () => {
    const resources = stubResources();
    // The watchdog aborts the run's controller the moment it is registered —
    // which now happens BEFORE createSandbox is even called, proving the
    // sandbox-creation phase is inside the governed window.
    resources.watchdog.register = vi.fn((controller: AbortController) => {
      controller.abort(new ResourceExhaustedError(100 * 1024 ** 2, 512 * 1024 ** 2));
      return { release: vi.fn() };
    });
    mockCreateResourceContext.mockReturnValue(
      resources as unknown as ReturnType<typeof createResourceContext>,
    );
    // createSandbox observes the already-aborted signal and rejects, the way
    // fs.cp does when its AbortSignal fires mid-copy.
    mockCreateSandbox.mockRejectedValueOnce(new Error('sandbox copy failed'));

    const response = await handleToolCall(makeRequest({ filePath: 'src/math.ts' }));

    expect(response.isError).toBe(true);
    const text = (response.content[0] as { text: string }).text;
    expect(text).toMatch(/^Stopped to avoid exhausting memory/);
    expect(text).not.toContain('Chaos Engine Halted');
    expect(resources.dispose).toHaveBeenCalledTimes(1);
  });

  it('still reports a user cancel as "Operation cancelled."', async () => {
    const resources = stubResources();
    mockCreateResourceContext.mockReturnValue(
      resources as unknown as ReturnType<typeof createResourceContext>,
    );

    const controller = new AbortController();
    const mockRun = vi.fn().mockImplementation(async () => {
      // The caller cancels the REQUEST'S signal (not the watchdog's), the same
      // way an MCP client cancel reaches a mid-flight engine run.
      controller.abort();
      throw new Error('engine exited with code null');
    });
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    const ctx: ToolContext = { signal: controller.signal };
    const response = await handleToolCall(makeRequest({ filePath: 'src/math.ts' }), undefined, ctx);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toBe('Operation cancelled.');
    expect(resources.dispose).toHaveBeenCalledTimes(1);
  });
});
