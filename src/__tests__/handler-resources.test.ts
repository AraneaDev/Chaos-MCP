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
    // Deliberately more than workers-only (2 x 300 MB = 600 MB) so a test can
    // tell whether the registration charged the real per-file figure
    // (fixed cost plus workers) or fell back to recomputing workers-only.
    perFileCostBytes: 900 * 1024 ** 2 + 2 * 300 * 1024 ** 2,
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

  it('registers the watchdog with the per-file figure including the fixed term, not the workers-only figure', async () => {
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
    // stubResources sets workerCostBytes x perFileWorkers to 600 MB but
    // perFileCostBytes (fixed plus workers) to 1500 MB: the registration must
    // see 1500 MB, proving it reads the exposed per-file figure rather than
    // recomputing (or ignoring) it.
    expect(resources.watchdog.register).toHaveBeenCalledWith(
      expect.anything(),
      900 * 1024 ** 2 + 2 * 300 * 1024 ** 2,
    );
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
    // The watchdog aborts the run's controller the moment it is registered,
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

  it('reports a user cancel arriving DURING sandbox creation as "Operation cancelled.", not a memory stop', async () => {
    const resources = stubResources();
    mockCreateResourceContext.mockReturnValue(
      resources as unknown as ReturnType<typeof createResourceContext>,
    );

    const controller = new AbortController();
    // createSandbox is still "copying" (its promise has not settled) when the
    // caller cancels. The governed signal handed to createSandbox is the
    // handler's OWN controller, linked to the request's signal, so aborting
    // the request signal here reaches createSandbox's `opts.signal` the same
    // way fs.cp's real abort listener would observe it mid-copy.
    mockCreateSandbox.mockImplementationOnce(
      (_targetFile: string, _workspaceRoot: string, _ignorePatterns: string[] | undefined, opts) => {
        return new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            reject(new Error('sandbox copy aborted'));
          });
          // The user's cancel lands while the copy is still in flight.
          controller.abort();
        });
      },
    );

    const ctx: ToolContext = { signal: controller.signal };
    const response = await handleToolCall(makeRequest({ filePath: 'src/math.ts' }), undefined, ctx);

    expect(response.isError).toBe(true);
    const text = (response.content[0] as { text: string }).text;
    // Must be the plain cancel text, never the resource-exhausted wording,
    // even though a resource context (and its watchdog) exists at this point.
    expect(text).toBe('Operation cancelled.\nResources: 1 files x 2 workers, 4.0 GB free (host)');
    expect(text).not.toMatch(/^Stopped to avoid exhausting memory/);
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
    // Finding B: a cancelled-but-governed run still reports the resources
    // block that was already resolved, appended after the cancel text.
    expect((response.content[0] as { text: string }).text).toBe(
      'Operation cancelled.\nResources: 1 files x 2 workers, 4.0 GB free (host)',
    );
    expect(resources.dispose).toHaveBeenCalledTimes(1);
  });
});
