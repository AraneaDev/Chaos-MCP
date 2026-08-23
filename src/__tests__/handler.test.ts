import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { firstText } from './helpers/content.js';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// Mock engines
vi.mock('../engines/typescript.js', () => ({
  TypeScriptEngine: vi.fn(),
}));
vi.mock('../engines/python.js', () => ({
  PythonEngine: vi.fn(),
}));
vi.mock('../engines/rust.js', () => ({
  RustEngine: vi.fn(),
}));

// Mock detectEnvironment
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
vi.mock('../utils/sandbox.js', () => ({
  createSandbox: vi.fn(),
}));

// Mock fs.existsSync for go.mod / Cargo.toml guards in smart prebuild
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    realpathSync: vi.fn((p: string) => p),
  };
});

// Python pre-flight: these tests use a synthetic '/workspace' that has no files
// on disk, so the real workspace scan would always report "no Python tests".
// Default it to true; the pre-flight itself is covered in test-file.test.ts and
// by the dedicated case below.
vi.mock('../core/test-file.js', async () => {
  const actual =
    await vi.importActual<typeof import('../core/test-file.js')>('../core/test-file.js');
  return {
    ...actual,
    // The default lives in the `vi.fn(impl)` constructor rather than a chained
    // `.mockReturnValue(...)`: `restoreMocks` wipes chained configuration but
    // preserves the implementation the factory supplied, so this default
    // survives into every test instead of decaying to `undefined`.
    workspaceHasPythonTests: vi.fn(() => ({ found: true, depthLimited: false })),
  };
});

// Mock runShellCommand for prebuildCommand tests
vi.mock('../utils/exec.js', async () => {
  const actual = await vi.importActual<typeof import('../utils/exec.js')>('../utils/exec.js');
  return {
    ...actual,
    runShellCommand: vi.fn(),
  };
});

vi.mock('../utils/git-diff.js', () => ({
  computeChangedRanges: vi.fn(),
}));

// Scope resolution is DELEGATED, not stubbed: every other test in this file needs the
// real short-circuits (no-changes, runId-not-found, verify baselines). The wrapper only
// exists so the options object the handler hands it can be inspected — see the
// 'forwards cancellation and budget to scope resolution' block at the end of the file.
vi.mock('../audit/scope.js', async () => {
  const actual = await vi.importActual<typeof import('../audit/scope.js')>('../audit/scope.js');
  return { ...actual, computeScope: vi.fn(actual.computeScope) };
});

// Mock logger for verbose logging tests
vi.mock('../audit/suppression-io.js', async () => {
  const actual = await vi.importActual<typeof import('../audit/suppression-io.js')>(
    '../audit/suppression-io.js',
  );
  return { ...actual, applyAndCountSuppressions: vi.fn(actual.applyAndCountSuppressions) };
});

vi.mock('../utils/logger.js', () => ({
  enableVerbose: vi.fn(),
  isVerbose: vi.fn(() => false),
  log: vi.fn(),
  warn: vi.fn(),
}));

import { handleToolCall } from '../index.js';
import { validateToolArgs } from '../handler.js';
import { mapCreateSandboxError } from '../core/tool-result.js';
import { TypeScriptEngine } from '../engines/typescript.js';
import { RustEngine } from '../engines/rust.js';
import { detectEnvironment } from '../utils/project-detector.js';
import { createSandbox } from '../utils/sandbox.js';
import { runShellCommand } from '../utils/exec.js';
import { isVerbose, log } from '../utils/logger.js';
import { existsSync } from 'fs';
import { computeChangedRanges } from '../utils/git-diff.js';
import { applyAndCountSuppressions } from '../audit/suppression-io.js';
import { workspaceHasPythonTests } from '../core/test-file.js';
import { computeScope } from '../audit/scope.js';
import { AuditDeadline } from '../utils/deadline.js';

const MockTSEngine = vi.mocked(TypeScriptEngine);
const MockRustEngine = vi.mocked(RustEngine);
const mockDetectEnv = vi.mocked(detectEnvironment);
const mockCreateSandbox = vi.mocked(createSandbox);
const mockRunShellCommand = vi.mocked(runShellCommand);
const mockIsVerbose = vi.mocked(isVerbose);
const mockLog = vi.mocked(log);
const mockExistsSync = vi.mocked(existsSync);
const mockComputeChangedRanges = vi.mocked(computeChangedRanges);
const mockApplySuppressions = vi.mocked(applyAndCountSuppressions);
const mockComputeScope = vi.mocked(computeScope);

function makeRequest(name: string, args: Record<string, unknown>): CallToolRequest {
  return {
    method: 'tools/call',
    params: {
      name,
      arguments: args,
    },
  };
}

describe('handleToolCall', () => {
  // Pin process.cwd() so the workspace re-anchoring (relative(workspaceRoot,
  // resolvedFile)) is deterministic regardless of where CI checks the repo out.
  // The mocked workspaceRoot is '/workspace'; on a runner whose checkout lives
  // UNDER /workspace (e.g. Forgejo's /workspace/<owner>/<repo>), the real cwd
  // would make '/workspace' an ancestor and change the re-anchored targetFile,
  // breaking the 'src/math.ts' assertions. Pinning cwd to '/workspace' makes the
  // re-anchoring resolve to the file's workspace-relative path on every runner.
  // `restoreMocks: true` un-installs this spy before every test, so it has to be
  // re-installed per test rather than once at describe-collection time.
  let cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace');
  afterAll(() => cwdSpy.mockRestore());

  beforeEach(() => {
    vi.clearAllMocks();
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/workspace');

    // `restoreMocks` already returns `isVerbose` and `existsSync` to the silent
    // /false defaults their `vi.mock()` factories declare, so the verbose and
    // Go/Rust-prebuild cases can no longer leak into later tests.

    // Default sandbox mock
    mockCreateSandbox.mockResolvedValue({
      workDir: '/tmp/chaos-mcp-sandbox',
      targetFile: '',
      cleanup: vi.fn(),
    });
  });

  it('dispatches .ts files to TypeScriptEngine with RunOptions', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 2,
      killed: 2,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return {
        run: mockRun,
      } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/math.ts' });
    const response = await handleToolCall(request);

    expect(response.isError).toBeUndefined();
    expect(mockRun).toHaveBeenCalledWith(
      'src/math.ts',
      expect.objectContaining({
        testRunner: 'vitest',
        workDir: '/tmp/chaos-mcp-sandbox',
      }),
    );
  });

  it('runs the engine + sandbox with the target relative to a nested workspace root', async () => {
    // Monorepo case: cwd is the repo root, but the detected workspace root is a
    // package subdirectory. The engine and sandbox must receive the path
    // relative to that root (src/x.ts), not the cwd-relative path.
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/x.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    const nestedRoot = `${process.cwd()}/packages/app`;
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: nestedRoot,
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'packages/app/src/x.ts',
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBeUndefined();
    expect(mockRun).toHaveBeenCalledWith('src/x.ts', expect.objectContaining({}));
    expect(mockCreateSandbox).toHaveBeenCalledWith(
      'src/x.ts',
      nestedRoot,
      undefined,
      expect.objectContaining({ signal: undefined }),
    );
  });

  it('passes timeoutMs to RunOptions', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      timeoutMs: 60000,
    });
    await handleToolCall(request);

    expect(mockRun).toHaveBeenCalledWith(
      'src/math.ts',
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(mockRun.mock.calls[0][1].timeoutMs).toBeGreaterThanOrEqual(57000);
    expect(mockRun.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(58000);
  });

  it('passes lineScope to RunOptions', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      lineScope: { start: 10, end: 50 },
    });
    await handleToolCall(request);

    expect(mockRun).toHaveBeenCalledWith(
      'src/math.ts',
      expect.objectContaining({ lineScope: { start: 10, end: 50 } }),
    );
  });

  it('rejects a non-empty mutatorAllowlist (audit L1: StrykerJS has no allowlist)', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      mutatorAllowlist: ['ConditionalExpression', 'ArithmeticOperator'],
    });
    const response = await handleToolCall(request);

    // Silent drop used to mask a real config error. Now rejected up-front.
    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain(
      'is not supported by StrykerJS',
    );
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('filters non-string values from mutatorDenylist', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      mutatorDenylist: ['StringLiteral', 42, null, 'BooleanLiteral'],
    });
    await handleToolCall(request);

    expect(mockRun).toHaveBeenCalledWith(
      'src/math.ts',
      expect.objectContaining({ mutatorDenylist: ['StringLiteral', 'BooleanLiteral'] }),
    );
  });

  it('returns error for unsupported file extensions', async () => {
    const request = makeRequest('audit_code_resilience', { filePath: 'main.rb' });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain('Extension unsupported');
  });

  it('returns sandbox provisioning error when createSandbox throws', async () => {
    mockCreateSandbox.mockImplementation(() => {
      throw new Error('Target file not found');
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/missing.ts' });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain(
      'Failed to provision sandbox isolation',
    );
  });

  it('cleans up sandbox after engine throws', async () => {
    const mockCleanup = vi.fn();
    mockCreateSandbox.mockResolvedValue({
      workDir: '/tmp/chaos-mcp-sandbox',
      targetFile: 'src/bad.ts',
      cleanup: mockCleanup,
    });

    MockTSEngine.mockImplementation(function () {
      return {
        run: vi.fn().mockRejectedValue(new Error('Stryker crashed')),
      } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/bad.ts' });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toBe(
      'Chaos Engine Halted: Stryker crashed',
    );
    expect(mockCleanup).toHaveBeenCalledOnce();
  });

  it('dispatches .rs files to RustEngine', async () => {
    const { RustEngine } = await import('../engines/rust.js');
    const MockRustEngine = vi.mocked(RustEngine);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/main.rs',
      totalMutants: 3,
      killed: 3,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockRustEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof RustEngine.prototype;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'rust',
      testRunner: 'cargo test',
      detectedRunner: 'cargo test',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    // Cargo.toml is absent by default (mockExistsSync returns false), so no smart
    // prebuild triggers — no need to mock runShellCommand here.

    const request = makeRequest('audit_code_resilience', { filePath: 'src/main.rs' });
    const response = await handleToolCall(request);

    expect(response.isError).toBeUndefined();
    expect(mockRun).toHaveBeenCalledWith(
      'src/main.rs',
      expect.objectContaining({ testRunner: 'cargo test' }),
    );
  });

  it('merges config defaults with tool call arguments (args override config)', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = {
      defaultTimeoutMs: 120000,
      mutatorDenylist: ['StringLiteral'],
    };

    // Tool call overrides timeout but not denylist
    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/app.ts',
      timeoutMs: 60000,
    });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({
        timeoutMs: expect.any(Number), // remaining args budget after setup/reserve
        mutatorDenylist: ['StringLiteral'], // from config (no arg override)
      }),
    );
    expect(mockRun.mock.calls[0][1].timeoutMs).toBeGreaterThanOrEqual(57000);
    expect(mockRun.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(58000);
  });

  it('uses config defaultTimeoutMs when args do not provide one', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { defaultTimeoutMs: 60000 };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(mockRun.mock.calls[0][1].timeoutMs).toBeGreaterThanOrEqual(57000);
    expect(mockRun.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(58000);
  });

  it('returns a toolError for unrecognized tool names (audit I1)', async () => {
    const request = makeRequest('unknown_tool', { filePath: 'test.ts' });
    const res = await handleToolCall(request);
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain('Unknown tool: unknown_tool');
  });

  // ─── dryRun / incremental / concurrency / ignorePatterns wiring tests ─────

  it('passes dryRun: true to RunOptions', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      dryRun: true,
    });
    await handleToolCall(request);

    expect(mockRun).toHaveBeenCalledWith('src/math.ts', expect.objectContaining({ dryRun: true }));
  });

  it('passes incremental: true to RunOptions', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      incremental: true,
    });
    await handleToolCall(request);

    expect(mockRun).toHaveBeenCalledWith(
      'src/math.ts',
      expect.objectContaining({ incremental: true }),
    );
  });

  it('passes concurrency to RunOptions', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      concurrency: 4,
    });
    await handleToolCall(request);

    expect(mockRun).toHaveBeenCalledWith(
      'src/math.ts',
      expect.objectContaining({ concurrency: 4 }),
    );
  });

  it('passes ignorePatterns to createSandbox only — never to the engine', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      ignorePatterns: ['.test.ts', 'fixtures/'],
    });
    await handleToolCall(request);

    // createSandbox should receive ignorePatterns as 3rd arg
    expect(mockCreateSandbox).toHaveBeenCalledWith(
      'src/math.ts',
      '/workspace',
      ['.test.ts', 'fixtures/'],
      expect.objectContaining({ signal: undefined }),
    );
    // ...and NOT to the engine. ignorePatterns governs what the sandbox copy
    // excludes; no engine has ever read it, so carrying it on RunOptions only
    // advertised a filter that did not exist.
    const runOptions = mockRun.mock.calls[0][1] as Record<string, unknown>;
    expect(runOptions).not.toHaveProperty('ignorePatterns');
  });

  // Regression (C1 follow-up): the AbortSignal from the MCP request context must
  // be forwarded verbatim into the createSandbox options so a mid-copy MCP
  // cancel propagates into the sandbox. We pin the exact signal object (===),
  // not just objectContaining, so the test fails if a future refactor
  // accidentally closes over the wrong controller.
  it('forwards ctx.signal into createSandbox so an MCP client cancel propagates', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const controller = new AbortController();
    const request = makeRequest('audit_code_resilience', { filePath: 'src/math.ts' });
    await handleToolCall(request, undefined, { signal: controller.signal });

    expect(mockCreateSandbox).toHaveBeenCalledWith(
      'src/math.ts',
      '/workspace',
      undefined,
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('forwards config.sandbox.dependencies into createSandbox options', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { sandbox: { dependencies: 'copy' as const } };
    const request = makeRequest('audit_code_resilience', { filePath: 'src/math.ts' });
    await handleToolCall(request, config);

    expect(mockCreateSandbox).toHaveBeenCalledWith(
      'src/math.ts',
      '/workspace',
      undefined,
      expect.objectContaining({ dependencies: 'copy' }),
    );
  });

  it('passes config concurrency when args do not provide one', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { concurrency: 8 };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith('src/app.ts', expect.objectContaining({ concurrency: 8 }));
  });

  // ─── outputFormat tests ─────────────────────────────────────────────────

  it('returns text format when outputFormat is "text"', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 3,
      killed: 2,
      survived: 1,
      mutationScore: '66.67%',
      vulnerabilities: [
        { line: 42, mutator: 'ConditionalExpression', description: 'Mutation survived.' },
      ],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      outputFormat: 'text',
    });
    const response = await handleToolCall(request);

    const text = (response.content[0] as { text: string }).text;
    expect(text).toContain('Chaos-MCP Audit Report');
    expect(text).toContain('Mutation score: 66.67%');
    // Survivors are bundled by line, enriched by default: "[high] ConditionalExpression"
    expect(text).toContain('[high] ConditionalExpression');
    // Should NOT be JSON
    expect(text.startsWith('{')).toBe(false);
  });

  it('returns error when concurrency is not an integer (H5 regression)', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      concurrency: 2.5,
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain(
      'concurrency must be an integer',
    );
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('returns error when concurrency is above the cap of 64 (H5 regression)', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      concurrency: 100000,
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain('between 1 and 64');
  });

  it('returns error when lineScope has start > end (M5 regression)', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      lineScope: { start: 50, end: 10 },
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    // (H5 added start/end upper bound — message now names 'lineScope.end' specifically.)
    expect((response.content[0] as { text: string }).text).toContain(
      'lineScope.end must be an integer between lineScope.start and',
    );
  });

  it('returns error when ignorePatterns contains non-string elements (M7 regression)', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      ignorePatterns: ['.test.ts', 123, null] as unknown as string[],
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain(
      'ignorePatterns must be an array of strings',
    );
  });

  it('returns JSON format by default', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/math.ts' });
    const response = await handleToolCall(request);

    const text = (response.content[0] as { text: string }).text;
    expect(text.startsWith('{')).toBe(true);
    const parsed = JSON.parse(text);
    expect(parsed.target).toBe('src/math.ts');
  });

  // ─── compact output (token-efficient bundling) ───────────────────────────

  const survivorResult = {
    target: 'src/math.ts',
    totalMutants: 10,
    killed: 6,
    survived: 4,
    mutationScore: '60.00%',
    vulnerabilities: [
      { line: 42, mutator: 'ConditionalExpression', description: 'Logical mutation survived.' },
      { line: 42, mutator: 'ConditionalExpression', description: 'Logical mutation survived.' },
      { line: 42, mutator: 'LogicalOperator', description: 'Logical mutation survived.' },
      {
        line: 99,
        mutator: 'StringLiteral',
        description: 'No test reached this line (NoCoverage). Consider adding tests.',
      },
    ],
  };

  function mockSurvivorRun() {
    MockTSEngine.mockImplementation(function () {
      return { run: vi.fn().mockResolvedValue(survivorResult) } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });
  }

  it('bundles survivors by line with deduplicated mutator counts (JSON)', async () => {
    mockSurvivorRun();
    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts' }),
    );
    const parsed = JSON.parse((response.content[0] as { text: string }).text);

    // Enrich-by-default: summary now carries worstSeverity (ConditionalExpression → high).
    expect(parsed.summary).toEqual({ total: 10, killed: 6, survived: 4, worstSeverity: 'high' });
    // One grouped entry for line 42 (not three repeated entries); enriched with severity.
    expect(parsed.survivors).toEqual([
      expect.objectContaining({
        line: 42,
        mutators: { ConditionalExpression: 2, LogicalOperator: 1 },
        severity: 'high',
      }),
    ]);
    // NoCoverage mutant is split out (with its mutator), not mixed into survivors; enriched.
    expect(parsed.noCoverage).toEqual([
      expect.objectContaining({ line: 99, mutators: { StringLiteral: 1 }, severity: 'low' }),
    ]);
  });

  it('emits single-line JSON with no repeated boilerplate descriptions', async () => {
    mockSurvivorRun();
    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts' }),
    );
    const text = (response.content[0] as { text: string }).text;

    expect(text).not.toContain('\n'); // compact single line
    // The boilerplate explanation appears once (in `note`), never per-mutant.
    expect(text.match(/Logical mutation survived/g)).toBeNull();
  });

  // ─── structuredContent + enrich-by-default (Task 8) ─────────────────────

  it('returns structuredContent with severity-ranked survivors by default (no enrich arg)', async () => {
    mockSurvivorRun();
    const res = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts' }),
    );

    // structuredContent is present and carries severity information.
    expect(res.structuredContent).toBeDefined();
    const sc = res.structuredContent as Record<string, unknown>;
    const summary = sc.summary as { worstSeverity?: string };
    const survivors = sc.survivors as { severity?: string }[];
    expect(summary.worstSeverity).toBe('high');
    expect(survivors[0].severity).toBe('high');

    // content[0].text (JSON mode) must equal the structuredContent payload.
    const parsed = JSON.parse((res.content[0] as { text: string }).text);
    expect(parsed).toEqual(res.structuredContent);
  });

  it('omits structuredContent.worstSeverity and severity fields when enrich is false', async () => {
    mockSurvivorRun();
    const res = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts', enrich: false }),
    );

    // enrich:false disables enrichment; survivors should have no severity field.
    const sc = res.structuredContent as Record<string, unknown>;
    const summary = sc.summary as { worstSeverity?: string };
    const survivors = sc.survivors as { severity?: string }[];
    expect(summary.worstSeverity).toBeUndefined();
    expect(survivors[0].severity).toBeUndefined();
  });

  it('renders bundled survivors in text format', async () => {
    mockSurvivorRun();
    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts', outputFormat: 'text' }),
    );
    const text = (response.content[0] as { text: string }).text;

    // Enrich-by-default: severity badge appears in text output.
    expect(text).toContain('[high] ConditionalExpression×2, LogicalOperator');
    expect(text).toContain('No-coverage mutants (line: mutators):');
    expect(text).toContain('[low] StringLiteral');
  });

  it('reports a NoCoverage mutant and a covered survivor on the SAME line separately', async () => {
    // Real case (go.ts/rust.ts): an unreachable `|| []` ArrayDeclaration is
    // NoCoverage while a live `.filter` MethodExpression on the same line is a
    // survivor. The line must NOT be reported as wholly uncovered.
    MockTSEngine.mockImplementation(function () {
      return {
        run: vi.fn().mockResolvedValue({
          target: 'src/x.ts',
          totalMutants: 5,
          killed: 3,
          survived: 2,
          mutationScore: '60.00%',
          vulnerabilities: [
            {
              line: 113,
              mutator: 'MethodExpression',
              description: 'Logical mutation survived.',
            },
            {
              line: 113,
              mutator: 'ArrayDeclaration',
              description: 'No test reached this line (NoCoverage). Consider adding tests.',
            },
          ],
        }),
      } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/x.ts' }),
    );
    const parsed = JSON.parse((response.content[0] as { text: string }).text);

    // Enrich-by-default: survivors carry severity fields.
    expect(parsed.survivors).toEqual([
      expect.objectContaining({ line: 113, mutators: { MethodExpression: 1 }, severity: 'medium' }),
    ]);
    expect(parsed.noCoverage).toEqual([
      expect.objectContaining({
        line: 113,
        mutators: { ArrayDeclaration: 1 },
        severity: 'medium',
      }),
    ]);
  });

  // ─── prebuildCommand tests ──────────────────────────────────────────────────

  it('returns error when prebuildCommand is not a string', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      prebuildCommand: 123 as unknown as string,
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain(
      'prebuildCommand must be a non-empty string',
    );
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('returns error when prebuildCommand is an empty string', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      prebuildCommand: '   ',
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain(
      'prebuildCommand must be a non-empty string',
    );
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('runs prebuildCommand in sandbox before engine.run()', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    mockRunShellCommand.mockResolvedValue({
      stdout: 'build success',
      stderr: '',
      exit: 0,
      signal: null,
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      prebuildCommand: 'npm run build',
    });
    const response = await handleToolCall(request, { allowPrebuild: true });

    expect(response.isError).toBeUndefined();
    // Prebuild must run in sandbox cwd before engine
    expect(mockRunShellCommand).toHaveBeenCalledWith(
      'npm run build',
      expect.objectContaining({ cwd: '/tmp/chaos-mcp-sandbox', killTree: true }),
    );
    // The prebuild inherits what is LEFT of the audit budget, not a fresh one:
    // 300_000 default minus the 2_000 cleanup reserve, minus whatever the audit
    // has already spent. Asserting the exact 298_000 turned this into a clock
    // benchmark — under load the elapsed time is non-zero and the equality
    // fails (observed while six suites ran concurrently). The upper bound is
    // what carries the meaning: a prebuild handed the full 300_000 would have
    // skipped the reserve deduction entirely.
    const prebuildTimeoutMs = mockRunShellCommand.mock.calls[0][1]?.timeoutMs;
    expect(prebuildTimeoutMs).toBeLessThanOrEqual(298_000);
    expect(prebuildTimeoutMs).toBeGreaterThan(240_000);
    expect(mockRun).toHaveBeenCalled();
  });

  it('rejects an explicit prebuildCommand unless allowPrebuild is enabled', async () => {
    const mockCleanup = vi.fn();
    mockCreateSandbox.mockResolvedValue({
      workDir: '/tmp/chaos-mcp-sandbox',
      targetFile: 'src/math.ts',
      cleanup: mockCleanup,
    });
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      prebuildCommand: 'rm -rf /',
    });
    // No config → prebuild not allowed.
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain('allowPrebuild');
    expect(mockRunShellCommand).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
    expect(mockCleanup).toHaveBeenCalledOnce();
  });

  it('deducts prebuild elapsed time from the engine run timeout', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    // Advance a fake clock by 4s while the prebuild "runs".
    let now = 1000;
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    mockRunShellCommand.mockImplementation(async () => {
      now += 4000;
      return { stdout: '', stderr: '', exit: 0, signal: null };
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      timeoutMs: 10000,
      prebuildCommand: 'npm run build',
    });
    await handleToolCall(request, { allowPrebuild: true });

    // 10000ms total − 2000ms cleanup reserve − 4000ms prebuild = 4000ms.
    expect(mockRun.mock.calls[0][1].timeoutMs).toBe(4000);
    dateSpy.mockRestore();
  });

  it('validates tool args before provisioning the sandbox', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      concurrency: 999, // out of range → must be rejected before any copy
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    // No expensive sandbox copy should happen for invalid input.
    expect(mockCreateSandbox).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('reports "no Python test files" instead of blaming a failing suite', async () => {
    const { PythonEngine } = await import('../engines/python.js');
    const MockPyEngine = vi.mocked(PythonEngine);
    const mockRun = vi.fn();
    MockPyEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof PythonEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      workspaceRoot: '/workspace',
      packageManager: 'pip',
    });
    vi.mocked(workspaceHasPythonTests).mockReturnValueOnce({ found: false, depthLimited: false });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/calc.py' });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    const text = (response.content[0] as { text: string }).text;
    expect(text).toContain('No Python test files were found in /workspace');
    expect(text).not.toContain('Fix the failing tests first');
    // The escape hatch for unconventional test layouts must be named, not just implied.
    expect(text).toContain('cosmicray.testSelection');
    // Never reaches cosmic-ray: no sandbox copy, no baseline run.
    expect(mockCreateSandbox).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('proceeds with the audit when the Python test scan is depth-limited (inconclusive)', async () => {
    const { PythonEngine } = await import('../engines/python.js');
    const MockPyEngine = vi.mocked(PythonEngine);
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/calc.py',
      totalMutants: 1,
      killed: 1,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    MockPyEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof PythonEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      workspaceRoot: '/workspace',
      packageManager: 'pip',
    });
    vi.mocked(workspaceHasPythonTests).mockReturnValueOnce({ found: false, depthLimited: true });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/calc.py' });
    const response = await handleToolCall(request);

    expect(response.isError).toBeUndefined();
    const text = (response.content[0] as { text: string }).text;
    expect(text).not.toContain('No Python test files were found');
    // An inconclusive scan must not block: the audit proceeds to the engine.
    expect(mockRun).toHaveBeenCalledOnce();
  });

  it('appends a note when StrykerJS-only options are passed to a non-TS engine', async () => {
    const { PythonEngine } = await import('../engines/python.js');
    const MockPyEngine = vi.mocked(PythonEngine);
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/calc.py',
      totalMutants: 1,
      killed: 1,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    MockPyEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof PythonEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      workspaceRoot: '/workspace',
      packageManager: 'pip',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/calc.py',
      lineScope: { start: 1, end: 10 },
      mutatorDenylist: ['StringLiteral'],
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBeUndefined();
    // The primary result is content[0]; the note is a separate trailing block so
    // it never corrupts the JSON/text payload.
    const note = response.content[1] as { text: string } | undefined;
    expect(note).toBeDefined();
    expect(note?.text).toContain('ignored');
    expect(note?.text).toContain('lineScope');
    expect(note?.text).toContain('mutatorDenylist');
  });

  it('does not append an ignored-options note for a TypeScript engine', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 1,
      killed: 1,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      lineScope: { start: 1, end: 10 },
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBeUndefined();
    expect(response.content).toHaveLength(1);
  });

  it('returns error and cleans up sandbox when prebuildCommand fails', async () => {
    const mockCleanup = vi.fn();
    mockCreateSandbox.mockResolvedValue({
      workDir: '/tmp/chaos-mcp-sandbox',
      targetFile: 'src/math.ts',
      cleanup: mockCleanup,
    });

    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    mockRunShellCommand.mockRejectedValue(new Error('Build failed: syntax error in src/math.ts'));

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      prebuildCommand: 'npm run build',
    });
    const response = await handleToolCall(request, { allowPrebuild: true });

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain(
      'Prebuild command failed in sandbox',
    );
    expect((response.content[0] as { text: string }).text).toContain('syntax error');
    // Engine must NOT be called
    expect(mockRun).not.toHaveBeenCalled();
    // Sandbox must be cleaned up even on prebuild failure
    expect(mockCleanup).toHaveBeenCalledOnce();
  });

  // ─── diff-aware (A2) no-change short-circuit + verify (A3) routing ───────────

  it('short-circuits a no-change diff with a synthetic empty result (JSON)', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });
    mockComputeChangedRanges.mockResolvedValue({ kind: 'no-changes' });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts', diffBase: 'HEAD' }),
    );

    expect(response.isError).toBeUndefined();
    // Nothing changed → neither the sandbox nor the engine is provisioned.
    expect(mockCreateSandbox).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
    // The synthetic result carries no vulnerabilities (kills the `[] → [...]`
    // ArrayDeclaration mutant on the empty result).
    const parsed = JSON.parse((response.content[0] as { text: string }).text);
    expect(parsed.survivors ?? []).toEqual([]);
    expect(parsed.noCoverage ?? []).toEqual([]);
    // JSON mode: text block == structuredContent, and structuredContent is present (Fix 1).
    expect(response.structuredContent).toBeDefined();
    const sc = response.structuredContent as Record<string, unknown>;
    expect(sc.summary).toBeDefined();
    expect(JSON.parse((response.content[0] as { text: string }).text)).toEqual(
      response.structuredContent,
    );
  });

  // REWRITTEN (Finding 7): this used to assert the text block contained
  // "100.00%". That was the defect, not the contract — `nothingToMutateResult`
  // hard-codes `mutationScore: '100.00%'` for a run that generated ZERO
  // mutants, and the reader saw a perfect kill rate for a file nothing was ever
  // run against. `displayMutationScore` now substitutes "n/a" for every
  // zero-mutant result, so the assertion pins the honest score plus the scope
  // note that explains it. Everything else the test legitimately checked (text
  // branch rather than JSON, report header, and that no engine ran) is kept.
  it('renders the no-change short-circuit in text format with an honest "n/a" score', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });
    mockComputeChangedRanges.mockResolvedValue({ kind: 'no-changes' });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', {
        filePath: 'src/math.ts',
        diffBase: 'HEAD',
        outputFormat: 'text',
      }),
    );

    const text = (response.content[0] as { text: string }).text;
    // Text branch, not JSON (kills `outputFormat === 'text' → false` / `'text' → ""`).
    expect(text.startsWith('{')).toBe(false);
    expect(text).toContain('Chaos-MCP Audit Report');
    // Zero mutants were generated, so there is no percentage to report and the
    // raw "100.00%" must never reach the reader.
    expect(text).toContain('Mutation score: n/a (0/0 killed, 0 survived)');
    expect(text).not.toContain('100.00%');
    // …and the scope note says why the number is missing, so "n/a" is never
    // left unexplained.
    expect(text).toContain('No changed lines in');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('formats a verify-mode delta as text when outputFormat is "text"', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 1,
      killed: 1,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', {
        filePath: 'src/math.ts',
        baseline: { survivors: [{ line: 42, mutators: { ConditionalExpression: 1 } }] },
        outputFormat: 'text',
      }),
    );

    // Verify-mode text formatter, not JSON (kills `args.outputFormat === 'text' → false`).
    const text = (response.content[0] as { text: string }).text;
    expect(text.startsWith('{')).toBe(false);
  });

  it('formats a verify-mode delta as JSON by default', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 1,
      killed: 1,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', {
        filePath: 'src/math.ts',
        baseline: { survivors: [{ line: 42, mutators: { ConditionalExpression: 1 } }] },
      }),
    );

    expect((response.content[0] as { text: string }).text.startsWith('{')).toBe(true);
  });

  it('returns a prebuild failure verbatim, not re-wrapped by the outer catch', async () => {
    mockCreateSandbox.mockResolvedValue({
      workDir: '/tmp/chaos-mcp-sandbox',
      targetFile: 'src/math.ts',
      cleanup: vi.fn(),
    });
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });
    mockRunShellCommand.mockRejectedValue(new Error('boom'));

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', {
        filePath: 'src/math.ts',
        prebuildCommand: 'npm run build',
      }),
      { allowPrebuild: true },
    );

    const text = (response.content[0] as { text: string }).text;
    expect(response.isError).toBe(true);
    expect(text).toContain('Prebuild command failed in sandbox');
    // The specific prebuild error is returned directly; the `startsWith(...)`
    // check at line 749 must route it AWAY from the generic outer-catch wrapper
    // (kills `startsWith → false` / `startsWith → endsWith` / emptied block).
    expect(text).not.toContain('Chaos Engine Halted');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('lists ONLY the StrykerJS-only options actually passed in the ignored-options note', async () => {
    const { PythonEngine } = await import('../engines/python.js');
    const MockPyEngine = vi.mocked(PythonEngine);
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/calc.py',
      totalMutants: 1,
      killed: 1,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    MockPyEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof PythonEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      workspaceRoot: '/workspace',
      packageManager: 'pip',
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', {
        filePath: 'src/calc.py',
        lineScope: { start: 1, end: 10 },
      }),
    );

    const note = (response.content[1] as { text: string }).text;
    expect(note).toContain('lineScope');
    // Options the caller did NOT pass must be absent — kills the dropped `.filter`
    // and the `args[opt] !== undefined → true` mutants (which list all 7).
    expect(note).not.toContain('concurrency');
    expect(note).not.toContain('dryRun');
    expect(note).not.toContain('perMutantTimeoutMs');
  });

  it('does NOT flag concurrency as ignored for Rust (cargo-mutants honours -j) (audit M1)', async () => {
    const { RustEngine } = await import('../engines/rust.js');
    const MockRustEngine = vi.mocked(RustEngine);
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/lib.rs',
      totalMutants: 1,
      killed: 1,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    MockRustEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof RustEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'rust',
      testRunner: 'cargo',
      detectedRunner: 'cargo',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/lib.rs', concurrency: 4 }),
    );
    // concurrency IS honoured by cargo-mutants, so there is no ignored-options note.
    expect(response.content[1]).toBeUndefined();
  });

  it('DOES flag concurrency as ignored for Python (cosmic-ray discards it) (audit M1)', async () => {
    const { PythonEngine } = await import('../engines/python.js');
    const MockPyEngine = vi.mocked(PythonEngine);
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/calc.py',
      totalMutants: 1,
      killed: 1,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    MockPyEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof PythonEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      workspaceRoot: '/workspace',
      packageManager: 'pip',
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/calc.py', concurrency: 4 }),
    );
    const note = (response.content[1] as { text: string }).text;
    expect(note).toContain('concurrency');
  });

  // ─── perMutantTimeoutMs tests ──────────────────────────────────────────────

  it('passes perMutantTimeoutMs to RunOptions', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      perMutantTimeoutMs: 10000,
    });
    await handleToolCall(request);

    expect(mockRun).toHaveBeenCalledWith(
      'src/math.ts',
      expect.objectContaining({ perMutantTimeoutMs: 10000 }),
    );
  });

  it('returns error when perMutantTimeoutMs is not a positive number', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      perMutantTimeoutMs: -1,
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain(
      'perMutantTimeoutMs must be a positive number',
    );
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('uses config perMutantTimeoutMs when args do not provide one', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { perMutantTimeoutMs: 8000 };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/math.ts' });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith(
      'src/math.ts',
      expect.objectContaining({ perMutantTimeoutMs: 8000 }),
    );
  });

  // ─── Engine-specific config merge tests ─────────────────────────────────

  it('uses stryker engine timeout over global defaultTimeoutMs', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = {
      defaultTimeoutMs: 300000,
      stryker: { timeoutMs: 60000 },
    };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      await handleToolCall(request, config);

      expect(mockRun).toHaveBeenCalledWith(
        'src/app.ts',
        expect.objectContaining({ timeoutMs: 58000 }),
      );
    } finally {
      now.mockRestore();
    }
  });

  it('uses stryker engine perMutantTimeoutMs over global perMutantTimeoutMs', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = {
      perMutantTimeoutMs: 5000,
      stryker: { perMutantTimeoutMs: 10000 },
    };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({ perMutantTimeoutMs: 10000 }),
    );
  });

  it('tool args override stryker engine config (args win)', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = {
      defaultTimeoutMs: 300000,
      stryker: { timeoutMs: 60000, concurrency: 4 },
    };

    // Tool call overrides timeoutMs but leaves concurrency from config
    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/app.ts',
      timeoutMs: 15000,
    });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({
        timeoutMs: expect.any(Number), // remaining args budget after setup/reserve
        concurrency: 4, // from stryker engine config
      }),
    );
    expect(mockRun.mock.calls[0][1].timeoutMs).toBeGreaterThanOrEqual(12000);
    expect(mockRun.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(13000);
  });

  it('uses rust engine timeout for .rs files', async () => {
    const { RustEngine } = await import('../engines/rust.js');
    const MockRustEngine = vi.mocked(RustEngine);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/main.rs',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockRustEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof RustEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'rust',
      testRunner: 'cargo test',
      detectedRunner: 'cargo test',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    mockRunShellCommand.mockResolvedValue({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    });

    const config = {
      defaultTimeoutMs: 300000,
      rust: { timeoutMs: 600000 },
      stryker: { timeoutMs: 60000 },
    };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/main.rs' });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith(
      'src/main.rs',
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(mockRun.mock.calls[0][1].timeoutMs).toBeGreaterThanOrEqual(597000);
    expect(mockRun.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(598000);
  });

  it('stryker engine config does not affect Python runs', async () => {
    const { PythonEngine } = await import('../engines/python.js');
    const MockPyEngine = vi.mocked(PythonEngine);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/calc.py',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockPyEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof PythonEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = {
      defaultTimeoutMs: 300000,
      stryker: { timeoutMs: 60000, concurrency: 8 },
    };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/calc.py' });
    await handleToolCall(request, config);

    // Should use global timeout (no engine config), NOT the stryker section
    expect(mockRun).toHaveBeenCalledWith(
      'src/calc.py',
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(mockRun.mock.calls[0][1].timeoutMs).toBeGreaterThanOrEqual(297000);
    expect(mockRun.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(298000);
  });

  it('uses cosmicray engine config timeoutMs for Python files', async () => {
    const { PythonEngine } = await import('../engines/python.js');
    const MockPyEngine = vi.mocked(PythonEngine);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/calc.py',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockPyEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof PythonEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = {
      cosmicray: { timeoutMs: 120000 },
    };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/calc.py' });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith(
      'src/calc.py',
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(mockRun.mock.calls[0][1].timeoutMs).toBeGreaterThanOrEqual(117000);
    expect(mockRun.mock.calls[0][1].timeoutMs).toBeLessThanOrEqual(118000);
  });

  it('uses cosmicray engine config testRunner override for Python files', async () => {
    const { PythonEngine } = await import('../engines/python.js');
    const MockPyEngine = vi.mocked(PythonEngine);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/calc.py',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockPyEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof PythonEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = {
      cosmicray: { testRunner: 'python -m unittest' },
    };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/calc.py' });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith(
      'src/calc.py',
      expect.objectContaining({ testRunner: 'python -m unittest' }),
    );
  });

  it('stryker engine config dryRun flows through to RunOptions', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { stryker: { dryRun: true } };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith('src/app.ts', expect.objectContaining({ dryRun: true }));
  });

  it('stryker engine config incremental flows through to RunOptions', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { stryker: { incremental: true } };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({ incremental: true }),
    );
  });

  it('stryker engine config mutatorDenylist merges with global defaults', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = {
      mutatorDenylist: ['StringLiteral'],
      stryker: { mutatorDenylist: ['BooleanLiteral'] },
    };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    // stryker engine config takes precedence over global
    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({ mutatorDenylist: ['BooleanLiteral'] }),
    );
  });

  // ─── Global testRunner override test ────────────────────────────────────

  it('global cfg.testRunner overrides env.testRunner', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { testRunner: 'jest' };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    // env.testRunner was 'vitest', but config.testRunner should override it
    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({ testRunner: 'jest' }),
    );
  });

  it('stryker engine config testRunner overrides env and global (H7 regression)', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { testRunner: 'jest', stryker: { testRunner: 'mocha' } };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    // stryker.testRunner should beat global testRunner
    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({ testRunner: 'mocha' }),
    );
  });

  it('config concurrency with float is rejected and falls to undefined (H6 regression)', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    // Config has float concurrency — should be rejected, falling to undefined
    const config = { concurrency: 2.5 };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    // concurrency should be undefined (float rejected)
    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({ concurrency: undefined }),
    );
  });

  it('config concurrency above 64 is rejected and falls to undefined (H6 regression)', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { concurrency: 999 };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    // concurrency should be undefined (cap exceeded)
    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({ concurrency: undefined }),
    );
  });

  it('config perMutantTimeoutMs with zero is rejected and falls to undefined (H6 regression)', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { perMutantTimeoutMs: 0 };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    // perMutantTimeoutMs should be undefined (non-positive rejected)
    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({ perMutantTimeoutMs: undefined }),
    );
  });

  it('config perMutantTimeoutMs with negative value is rejected and falls to undefined (H6 regression)', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { perMutantTimeoutMs: -500 };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    // perMutantTimeoutMs should be undefined (negative rejected)
    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({ perMutantTimeoutMs: undefined }),
    );
  });

  it('config perMutantTimeoutMs with valid value flows through', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { perMutantTimeoutMs: 8000 };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({ perMutantTimeoutMs: 8000 }),
    );
  });

  it('stryker engine config perMutantTimeoutMs with valid value flows through', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { stryker: { perMutantTimeoutMs: 12000 } };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({ perMutantTimeoutMs: 12000 }),
    );
  });

  it('stryker engine config concurrency with valid value flows through', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { stryker: { concurrency: 8 } };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    // concurrency from stryker engine config should flow through
    expect(mockRun).toHaveBeenCalledWith('src/app.ts', expect.objectContaining({ concurrency: 8 }));
  });

  // ─── Smart prebuild from packageManager tests ───────────────────────────

  it('does NOT auto-run an installer for Python uv projects', async () => {
    const { PythonEngine } = await import('../engines/python.js');
    const MockPyEngine = vi.mocked(PythonEngine);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/calc.py',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockPyEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof PythonEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      workspaceRoot: '/workspace',
      packageManager: 'uv',
    });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/calc.py' });
    await handleToolCall(request);

    expect(mockRunShellCommand).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalled();
  });

  it('does NOT auto-run an installer for Python poetry projects', async () => {
    const { PythonEngine } = await import('../engines/python.js');
    const MockPyEngine = vi.mocked(PythonEngine);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/calc.py',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockPyEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof PythonEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      workspaceRoot: '/workspace',
      packageManager: 'poetry',
    });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/calc.py' });
    await handleToolCall(request);

    expect(mockRunShellCommand).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalled();
  });

  it('runs an explicit prebuildCommand for Python projects when allowed', async () => {
    const { PythonEngine } = await import('../engines/python.js');
    const MockPyEngine = vi.mocked(PythonEngine);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/calc.py',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockPyEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof PythonEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      workspaceRoot: '/workspace',
      packageManager: 'uv',
    });

    mockRunShellCommand.mockResolvedValue({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/calc.py',
      prebuildCommand: 'pip install -e .',
    });
    await handleToolCall(request, { allowPrebuild: true });

    expect(mockRunShellCommand).toHaveBeenCalledWith(
      'pip install -e .',
      expect.objectContaining({
        cwd: '/tmp/chaos-mcp-sandbox',
        timeoutMs: expect.any(Number),
        killTree: true,
      }),
    );
    expect(mockRunShellCommand.mock.calls[0][1]?.timeoutMs).toBeGreaterThanOrEqual(297000);
    expect(mockRun).toHaveBeenCalled();
  });

  it('skips prebuild for Python pip projects (no smart default)', async () => {
    const { PythonEngine } = await import('../engines/python.js');
    const MockPyEngine = vi.mocked(PythonEngine);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/calc.py',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockPyEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof PythonEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      workspaceRoot: '/workspace',
      packageManager: 'pip',
    });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/calc.py' });
    await handleToolCall(request);

    // No prebuild for pip
    expect(mockRunShellCommand).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalled();
  });

  // ─── Rust smart prebuild tests ─────────────────────────────────────────

  it('uses cargo check as default prebuild for Rust projects', async () => {
    const { RustEngine } = await import('../engines/rust.js');
    const MockRustEngine = vi.mocked(RustEngine);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/main.rs',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockRustEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof RustEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'rust',
      testRunner: 'cargo test',
      detectedRunner: 'cargo test',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    // Cargo.toml must exist for smart prebuild to trigger
    mockExistsSync.mockImplementation((p) => String(p).endsWith('Cargo.toml'));

    mockRunShellCommand.mockResolvedValue({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/main.rs' });
    await handleToolCall(request);

    expect(mockRunShellCommand).toHaveBeenCalledWith(
      'cargo check',
      expect.objectContaining({
        cwd: '/tmp/chaos-mcp-sandbox',
        timeoutMs: expect.any(Number),
        killTree: true,
      }),
    );
    expect(mockRunShellCommand.mock.calls[0][1]?.timeoutMs).toBeGreaterThanOrEqual(297000);
    expect(mockRun).toHaveBeenCalled();
  });

  it('skips smart prebuild for Rust when Cargo.toml is absent', async () => {
    const { RustEngine } = await import('../engines/rust.js');
    const MockRustEngine = vi.mocked(RustEngine);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/main.rs',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockRustEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof RustEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'rust',
      testRunner: 'cargo test',
      detectedRunner: 'cargo test',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    // Cargo.toml does NOT exist — smart prebuild skipped
    mockExistsSync.mockReturnValue(false);

    const request = makeRequest('audit_code_resilience', { filePath: 'src/main.rs' });
    await handleToolCall(request);

    // No prebuild should be called
    expect(mockRunShellCommand).not.toHaveBeenCalled();
    expect(mockRun).toHaveBeenCalled();
  });

  // ─── Prebuild verbose logging tests ────────────────────────────────────

  it('does NOT log a Python auto-prebuild (no installer is auto-run)', async () => {
    mockIsVerbose.mockReturnValue(true);

    const { PythonEngine } = await import('../engines/python.js');
    const MockPyEngine = vi.mocked(PythonEngine);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/calc.py',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockPyEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof PythonEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      workspaceRoot: '/workspace',
      packageManager: 'uv',
    });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/calc.py' });
    await handleToolCall(request);

    expect(mockRunShellCommand).not.toHaveBeenCalled();
    expect(mockLog).not.toHaveBeenCalledWith(expect.stringContaining('[auto (uv)]'));
  });

  it('logs [explicit] when args provide prebuildCommand', async () => {
    mockIsVerbose.mockReturnValue(true);

    const { PythonEngine } = await import('../engines/python.js');
    const MockPyEngine = vi.mocked(PythonEngine);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/calc.py',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockPyEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof PythonEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      workspaceRoot: '/workspace',
      packageManager: 'uv',
    });

    mockRunShellCommand.mockResolvedValue({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/calc.py',
      prebuildCommand: 'pip install -e .',
    });
    await handleToolCall(request, { allowPrebuild: true });

    // Should log with explicit source (overrides auto default)
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('[explicit]'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('pip install -e .'));
  });

  // ─── formatResultAsText no-vulnerabilities branch ──────────────────────

  it('returns text format with success message when no vulnerabilities', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 5,
      killed: 5,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      outputFormat: 'text',
    });
    const response = await handleToolCall(request);

    const text = (response.content[0] as { text: string }).text;
    expect(text).toContain('Chaos-MCP Audit Report');
    expect(text).toContain('Mutation score: 100.00%');
    expect(text).toContain('No surviving mutants');
    expect(text).not.toContain('Line ');
  });

  // ─── Outer catch in handleToolCall ─────────────────────────────────────

  it('returns Chaos Engine Halted when detectEnvironment throws', async () => {
    mockDetectEnv.mockImplementation(() => {
      throw new Error('ENOENT: no such file');
    });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/math.ts' });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toBe(
      'Chaos Engine Halted: ENOENT: no such file',
    );
  });

  it('returns Chaos Engine Halted with non-Error throw', async () => {
    mockDetectEnv.mockImplementation(() => {
      throw 'raw string error';
    });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/math.ts' });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toBe(
      'Chaos Engine Halted: raw string error',
    );
  });

  // ─── mutatorAllowlist (unsupported by StrykerJS — always dropped) ────

  it('drops a config-provided mutatorAllowlist so it never reaches the engine', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { stryker: { mutatorAllowlist: ['ArithmeticOperator'] } };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    const response = await handleToolCall(request, config);

    expect(response.isError).toBeUndefined();
    expect(mockRun.mock.calls[0][1].mutatorAllowlist).toBeUndefined();
  });

  // ─── lineScope edge cases ──────────────────────────────────────────────

  it('returns error when lineScope is null', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      lineScope: null,
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain('lineScope must be');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('returns error when lineScope is an array', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      lineScope: [10, 50],
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain('lineScope must be');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('returns error when lineScope has non-integer start', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      lineScope: { start: 1.5, end: 10 },
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain('lineScope must be');
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('returns error when lineScope has start < 1', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      lineScope: { start: 0, end: 10 },
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    // (H5 added start upper bound; error names 'lineScope.start' specifically.)
    expect((response.content[0] as { text: string }).text).toContain(
      'lineScope.start must be an integer between 1 and',
    );
    expect(mockRun).not.toHaveBeenCalled();
  });

  // ─── outputFormat invalid value is rejected (audit L4) ────────────────

  it('outputFormat with an invalid value returns a toolError instead of coercing', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      outputFormat: 'xml',
    });
    const res = await handleToolCall(request);

    // A non-enum outputFormat is rejected before the engine runs (L4).
    expect(res.isError).toBe(true);
    expect(firstText(res)).toContain('outputFormat must be one of "text" or "json"');
    expect(mockRun).not.toHaveBeenCalled();
  });

  // ─── Rust auto prebuild verbose logging ──────────────────────────────

  it('logs [auto (rust)] when smart prebuild kicks in for Rust projects with verbose', async () => {
    mockIsVerbose.mockReturnValue(true);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/main.rs',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockRustEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as RustEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'rust',
      testRunner: 'cargo test',
      detectedRunner: 'cargo test',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    mockExistsSync.mockImplementation((p) => String(p).endsWith('Cargo.toml'));
    mockRunShellCommand.mockResolvedValue({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/main.rs' });
    await handleToolCall(request);

    // Rust has no packageManager so autoLabel falls back to projectType 'rust'
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('[auto (rust)]'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('cargo check'));
  });

  // ─── handleToolCall verbose logging branches ──────────────────────────

  it('logs config.defaultTimeoutMs in verbose mode', async () => {
    mockIsVerbose.mockReturnValue(true);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { defaultTimeoutMs: 250000 };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/math.ts' });
    await handleToolCall(request, config);

    expect(mockLog).toHaveBeenCalledWith('  config.timeoutMs: 250000');
  });

  it('logs config.mutatorDenylist in verbose mode', async () => {
    mockIsVerbose.mockReturnValue(true);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { mutatorDenylist: ['StringLiteral', 'BooleanLiteral'] };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/math.ts' });
    await handleToolCall(request, config);

    expect(mockLog).toHaveBeenCalledWith('  config.mutatorDenylist: StringLiteral, BooleanLiteral');
  });

  it('logs config.perMutantTimeoutMs in verbose mode', async () => {
    mockIsVerbose.mockReturnValue(true);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const config = { perMutantTimeoutMs: 9876 };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/math.ts' });
    await handleToolCall(request, config);

    expect(mockLog).toHaveBeenCalledWith('  config.perMutantTimeoutMs: 9876');
  });

  it('logs engCfg (stryker) section in verbose mode', async () => {
    mockIsVerbose.mockReturnValue(true);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const strykerCfg = { timeoutMs: 60000, concurrency: 4 };
    const config = { stryker: strykerCfg };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/math.ts' });
    await handleToolCall(request, config);

    expect(mockLog).toHaveBeenCalledWith(
      '  engineConfig (typescript):',
      JSON.stringify(strykerCfg),
    );
  });

  it('logs packageManager in verbose mode when present', async () => {
    mockIsVerbose.mockReturnValue(true);

    const { PythonEngine } = await import('../engines/python.js');
    const MockPyEngine = vi.mocked(PythonEngine);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/calc.py',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockPyEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as typeof PythonEngine.prototype;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      workspaceRoot: '/workspace',
      packageManager: 'poetry',
    });

    // Auto-prebuild triggers 'poetry install' for poetry projects; mock the shell call so engine reaches run()
    mockRunShellCommand.mockResolvedValue({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/calc.py' });
    await handleToolCall(request);

    expect(mockLog).toHaveBeenCalledWith('  packageManager: poetry');
  });

  it('logs "Prebuild command completed successfully" in verbose mode', async () => {
    mockIsVerbose.mockReturnValue(true);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    mockRunShellCommand.mockResolvedValue({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      prebuildCommand: 'npm run build',
    });
    await handleToolCall(request, { allowPrebuild: true });

    expect(mockLog).toHaveBeenCalledWith('Prebuild command completed successfully');
  });

  it('does NOT log config fields in verbose mode when config is empty', async () => {
    mockIsVerbose.mockReturnValue(true);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/math.ts' });
    await handleToolCall(request, {}); // empty config

    // config.* fields should NOT appear when config is empty
    const allLogCalls = mockLog.mock.calls.map((c) => String(c[0] ?? '')).join('\n');
    expect(allLogCalls).not.toContain('config.timeoutMs');
    expect(allLogCalls).not.toContain('config.mutatorDenylist');
    expect(allLogCalls).not.toContain('config.perMutantTimeoutMs');
    expect(allLogCalls).not.toContain('engineConfig');
  });

  // ─── filePath input-validation guards (security boundary) ─────────────────

  it('rejects a missing filePath with a clear error', async () => {
    const response = await handleToolCall(makeRequest('audit_code_resilience', {}));
    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain('filePath is required');
  });

  it('rejects an empty-string filePath', async () => {
    const response = await handleToolCall(makeRequest('audit_code_resilience', { filePath: '' }));
    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain('non-empty string');
  });

  it('rejects a non-string filePath', async () => {
    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 123 as unknown as string }),
    );
    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain('filePath is required');
  });

  it('rejects a filePath that escapes the workspace cwd (C2)', async () => {
    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: '../../etc/passwd' }),
    );
    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain(
      'must resolve within the workspace',
    );
  });

  it('accepts a filePath equal to a nested workspace path (boundary, not an escape)', async () => {
    // A normal in-workspace path must NOT trip the escape guard — proves the
    // isPathInside check is not inverted.
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/deep/nested/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/deep/nested/math.ts' }),
    );
    expect(response.isError).toBeUndefined();
    expect(mockRun).toHaveBeenCalled();
  });

  describe('diffBase dispatch', () => {
    const tsEnv = {
      projectType: 'typescript' as const,
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    };

    it('errors when the workspace is not a git repo', async () => {
      mockDetectEnv.mockReturnValue(tsEnv);
      mockComputeChangedRanges.mockResolvedValue({ kind: 'not-a-repo' });
      const res = await handleToolCall(
        makeRequest('audit_code_resilience', { filePath: 'src/x.ts', diffBase: 'HEAD' }),
      );
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toMatch(/git work tree/i);
    });

    it('errors for an unresolvable ref', async () => {
      mockDetectEnv.mockReturnValue(tsEnv);
      mockComputeChangedRanges.mockResolvedValue({ kind: 'bad-ref', ref: 'nope' });
      const res = await handleToolCall(
        makeRequest('audit_code_resilience', { filePath: 'src/x.ts', diffBase: 'nope' }),
      );
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toMatch(/nope/);
    });

    it('short-circuits with an empty scoped result when nothing changed (engine not run)', async () => {
      const mockRun = vi.fn();
      MockTSEngine.mockImplementation(function () {
        return { run: mockRun } as unknown as TypeScriptEngine;
      });
      mockDetectEnv.mockReturnValue(tsEnv);
      mockComputeChangedRanges.mockResolvedValue({ kind: 'no-changes' });
      const res = await handleToolCall(
        makeRequest('audit_code_resilience', { filePath: 'src/x.ts', diffBase: 'HEAD' }),
      );
      expect(res.isError).toBeUndefined();
      const json = JSON.parse((res.content[0] as { text: string }).text);
      expect(json.summary.total).toBe(0);
      expect(json.scopeNote).toMatch(/no changed lines/i);
      expect(mockRun).not.toHaveBeenCalled();
    });

    it('ranges → TypeScript: propagates lineRanges to the engine', async () => {
      const mockRun = vi.fn().mockResolvedValue({
        target: 'src/x.ts',
        totalMutants: 1,
        killed: 1,
        survived: 0,
        mutationScore: '100.00%',
        vulnerabilities: [],
      });
      MockTSEngine.mockImplementation(function () {
        return { run: mockRun } as unknown as TypeScriptEngine;
      });
      mockDetectEnv.mockReturnValue(tsEnv);
      mockComputeChangedRanges.mockResolvedValue({
        kind: 'ranges',
        ranges: [{ start: 3, end: 5 }],
      });

      await handleToolCall(
        makeRequest('audit_code_resilience', { filePath: 'src/x.ts', diffBase: 'HEAD' }),
      );

      expect(mockRun).toHaveBeenCalled();
      const runOpts = mockRun.mock.calls[0][1] as { lineRanges?: { start: number; end: number }[] };
      expect(runOpts.lineRanges).toEqual([{ start: 3, end: 5 }]);
    });

    it('ranges → non-TypeScript: runs whole file and attaches a scopeNote', async () => {
      const mockRun = vi.fn().mockResolvedValue({
        target: 'src/x.rs',
        totalMutants: 1,
        killed: 1,
        survived: 0,
        mutationScore: '100.00%',
        vulnerabilities: [],
      });
      MockRustEngine.mockImplementation(function () {
        return { run: mockRun } as unknown as RustEngine;
      });
      mockDetectEnv.mockReturnValue({
        projectType: 'rust',
        testRunner: 'cargo test',
        detectedRunner: 'cargo test',
        packageManager: '',
        workspaceRoot: '/workspace',
      });
      mockComputeChangedRanges.mockResolvedValue({
        kind: 'ranges',
        ranges: [{ start: 1, end: 2 }],
      });

      const res = await handleToolCall(
        makeRequest('audit_code_resilience', { filePath: 'src/x.rs', diffBase: 'HEAD' }),
      );

      expect(mockRun).toHaveBeenCalled();
      const json = JSON.parse((res.content[0] as { text: string }).text);
      expect(json.scopeNote).toMatch(/not supported for rust/i);
      // The Rust engine receives NO line scoping (whole-file run).
      const runOpts = mockRun.mock.calls[0][1] as { lineRanges?: unknown };
      expect(runOpts.lineRanges).toBeUndefined();
    });

    it('untracked file → runs whole file with an explanatory scopeNote and no line scoping', async () => {
      const mockRun = vi.fn().mockResolvedValue({
        target: 'src/x.ts',
        totalMutants: 1,
        killed: 1,
        survived: 0,
        mutationScore: '100.00%',
        vulnerabilities: [],
      });
      MockTSEngine.mockImplementation(function () {
        return { run: mockRun } as unknown as TypeScriptEngine;
      });
      mockDetectEnv.mockReturnValue(tsEnv);
      mockComputeChangedRanges.mockResolvedValue({ kind: 'untracked' });

      const res = await handleToolCall(
        makeRequest('audit_code_resilience', { filePath: 'src/x.ts', diffBase: 'HEAD' }),
      );

      expect(mockRun).toHaveBeenCalled();
      const runOpts = mockRun.mock.calls[0][1] as { lineRanges?: unknown };
      expect(runOpts.lineRanges).toBeUndefined();
      const json = JSON.parse((res.content[0] as { text: string }).text);
      expect(json.scopeNote).toMatch(/untracked/i);
    });
  });

  describe('baseline verify mode', () => {
    const tsEnv = {
      projectType: 'typescript' as const,
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    };

    it('scopes the re-run to baseline lines and returns a verify delta', async () => {
      const mockRun = vi.fn().mockResolvedValue({
        target: 'src/x.ts',
        totalMutants: 4,
        killed: 3,
        survived: 1,
        mutationScore: '75.00%',
        vulnerabilities: [{ line: 88, mutator: 'ArithmeticOperator', description: 'survived' }],
      });
      MockTSEngine.mockImplementation(function () {
        return { run: mockRun } as unknown as TypeScriptEngine;
      });
      mockDetectEnv.mockReturnValue(tsEnv);

      const res = await handleToolCall(
        makeRequest('audit_code_resilience', {
          filePath: 'src/x.ts',
          baseline: {
            survivors: [{ line: 42, mutators: { ConditionalExpression: 1 } }],
            noCoverage: [{ line: 88, mutators: { ArithmeticOperator: 1 } }],
          },
        }),
      );

      // Whole-file re-run: this used to assert one single-line range per
      // baseline line. Stryker only generates a mutant whose ENTIRE span fits
      // the range, so that scoping silently excluded every multi-line mutant
      // from the re-run, and computeVerifyDelta — which infers "killed" from
      // absence — reported each of them as `nowKilled`. The baseline is now a
      // post-run filter instead of a mutate scope.
      const runOpts = mockRun.mock.calls[0][1] as { lineRanges?: { start: number; end: number }[] };
      expect(runOpts.lineRanges).toBeUndefined();

      const json = JSON.parse((res.content[0] as { text: string }).text);
      expect(json.mode).toBe('verify');
      expect(json.killedCount).toBe(1);
      expect(json.nowKilled).toEqual([{ line: 42, mutator: 'ConditionalExpression' }]);
      expect(json.stillSurviving).toEqual([{ line: 88, mutator: 'ArithmeticOperator' }]);
    });

    it('non-TS verify runs whole-file (no lineRanges) and still computes the delta', async () => {
      const mockRun = vi.fn().mockResolvedValue({
        target: 'src/x.rs',
        totalMutants: 2,
        killed: 2,
        survived: 0,
        mutationScore: '100.00%',
        vulnerabilities: [],
      });
      MockRustEngine.mockImplementation(function () {
        return { run: mockRun } as unknown as RustEngine;
      });
      mockDetectEnv.mockReturnValue({
        projectType: 'rust',
        testRunner: 'cargo test',
        detectedRunner: 'cargo test',
        packageManager: '',
        workspaceRoot: '/workspace',
      });

      const res = await handleToolCall(
        makeRequest('audit_code_resilience', {
          filePath: 'src/x.rs',
          baseline: { survivors: [{ line: 7, mutators: { RustMut: 1 } }] },
        }),
      );

      const runOpts = mockRun.mock.calls[0][1] as { lineRanges?: unknown };
      expect(runOpts.lineRanges).toBeUndefined();
      const json = JSON.parse((res.content[0] as { text: string }).text);
      expect(json.mode).toBe('verify');
      expect(json.killedCount).toBe(1);
      expect(json.nowKilled).toEqual([{ line: 7, mutator: 'RustMut' }]);
    });

    // ── Finding 2, end to end ──
    it('does not claim "now killed" when the verify re-run stopped early', async () => {
      // Verify is deliberately whole-file on every engine, so a batched TS
      // re-run plans the MAXIMUM number of batches and is the run most likely
      // to be truncated. `formatVerifyOutput` never read `complete`, so a
      // baseline mutant sitting in a batch that never ran came back as proof
      // the caller's fix worked.
      const mockRun = vi.fn().mockResolvedValue({
        target: 'src/x.ts',
        totalMutants: 4,
        killed: 4,
        survived: 0,
        mutationScore: '100.00%',
        vulnerabilities: [],
        complete: false,
        batchesCompleted: 2,
        batchesPlanned: 7,
        stoppedReason: 'time_budget_exhausted',
      });
      MockTSEngine.mockImplementation(function () {
        return { run: mockRun } as unknown as TypeScriptEngine;
      });
      mockDetectEnv.mockReturnValue(tsEnv);

      const res = await handleToolCall(
        makeRequest('audit_code_resilience', {
          filePath: 'src/x.ts',
          baseline: { survivors: [{ line: 42, mutators: { ConditionalExpression: 1 } }] },
        }),
      );

      const sc = res.structuredContent as Record<string, unknown>;
      expect(sc.mode).toBe('verify');
      expect(sc.killedCount).toBe(0);
      expect(sc.nowKilled).toEqual([]);
      expect(sc.notReChecked).toEqual([{ line: 42, mutator: 'ConditionalExpression' }]);
      // The partial provenance reaches structuredContent, not just the text
      // block — a client reading only the structured payload could not
      // otherwise tell a whole-file re-run from a truncated one.
      expect(sc.complete).toBe(false);
      expect(sc.batchesCompleted).toBe(2);
      expect(sc.batchesPlanned).toBe(7);
      expect(sc.stoppedReason).toBe('time_budget_exhausted');
      expect(sc.note as string).toContain('PARTIAL RE-RUN');
      // Text and JSON are two projections of one payload.
      expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual(sc);
    });

    // ── Finding 8, end to end ──
    it('emits the promised gate when minScore is supplied in verify mode', async () => {
      // `{ filePath, runId|baseline, minScore }` validates cleanly — nothing
      // makes minScore mutually exclusive with the verify inputs — and the
      // schema promises "the result reports gate.passed=false (never an
      // error)". Verify mode emitted no `gate` key at all, so
      // `if (!result.gate.passed)` threw a TypeError and
      // `result.gate?.passed === true` read it as a FAILURE.
      const mockRun = vi.fn().mockResolvedValue({
        target: 'src/x.ts',
        totalMutants: 4,
        killed: 3,
        survived: 1,
        mutationScore: '75.00%',
        vulnerabilities: [{ line: 42, mutator: 'ConditionalExpression', description: 'survived' }],
      });
      MockTSEngine.mockImplementation(function () {
        return { run: mockRun } as unknown as TypeScriptEngine;
      });
      mockDetectEnv.mockReturnValue(tsEnv);

      const res = await handleToolCall(
        makeRequest('audit_code_resilience', {
          filePath: 'src/x.ts',
          baseline: { survivors: [{ line: 42, mutators: { ConditionalExpression: 1 } }] },
          minScore: 80,
        }),
      );

      const sc = res.structuredContent as Record<string, unknown>;
      expect(sc.mode).toBe('verify');
      // The baseline mutant is still alive, so the gate fails — and it is a
      // graded result, never an error.
      expect(sc.gate).toEqual({ minScore: 80, passed: false });
      expect(res.isError).toBeUndefined();
      expect(JSON.parse((res.content[0] as { text: string }).text)).toEqual(sc);
    });

    it('renders the verify gate in the TEXT projection too', async () => {
      const mockRun = vi.fn().mockResolvedValue({
        target: 'src/x.ts',
        totalMutants: 4,
        killed: 4,
        survived: 0,
        mutationScore: '100.00%',
        vulnerabilities: [],
      });
      MockTSEngine.mockImplementation(function () {
        return { run: mockRun } as unknown as TypeScriptEngine;
      });
      mockDetectEnv.mockReturnValue(tsEnv);

      const res = await handleToolCall(
        makeRequest('audit_code_resilience', {
          filePath: 'src/x.ts',
          baseline: { survivors: [{ line: 42, mutators: { ConditionalExpression: 1 } }] },
          minScore: 80,
          outputFormat: 'text',
        }),
      );

      const text = (res.content[0] as { text: string }).text;
      expect(text).toContain('Gate: passed (minScore 80)');
    });

    it('fails the verify gate closed when the re-run was partial', async () => {
      // Findings 2 + 8 together: the delta looks spotless because the mutants
      // were never generated, and a CI gate must not go green on that.
      const mockRun = vi.fn().mockResolvedValue({
        target: 'src/x.ts',
        totalMutants: 4,
        killed: 4,
        survived: 0,
        mutationScore: '100.00%',
        vulnerabilities: [],
        complete: false,
        batchesCompleted: 1,
        batchesPlanned: 6,
        stoppedReason: 'time_budget_exhausted',
      });
      MockTSEngine.mockImplementation(function () {
        return { run: mockRun } as unknown as TypeScriptEngine;
      });
      mockDetectEnv.mockReturnValue(tsEnv);

      const res = await handleToolCall(
        makeRequest('audit_code_resilience', {
          filePath: 'src/x.ts',
          baseline: { survivors: [{ line: 42, mutators: { ConditionalExpression: 1 } }] },
          minScore: 80,
        }),
      );

      expect((res.structuredContent as Record<string, unknown>).gate).toEqual({
        minScore: 80,
        passed: false,
        reason: 'partial_audit',
      });
    });

    it('omits the gate from a verify response when no minScore was supplied', async () => {
      const mockRun = vi.fn().mockResolvedValue({
        target: 'src/x.ts',
        totalMutants: 4,
        killed: 4,
        survived: 0,
        mutationScore: '100.00%',
        vulnerabilities: [],
      });
      MockTSEngine.mockImplementation(function () {
        return { run: mockRun } as unknown as TypeScriptEngine;
      });
      mockDetectEnv.mockReturnValue(tsEnv);

      const res = await handleToolCall(
        makeRequest('audit_code_resilience', {
          filePath: 'src/x.ts',
          baseline: { survivors: [{ line: 42, mutators: { ConditionalExpression: 1 } }] },
        }),
      );

      expect(res.structuredContent as Record<string, unknown>).not.toHaveProperty('gate');
    });
  });

  it('halts when the absolute deadline expires during scope resolution', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(20_000);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/app.ts', timeoutMs: 10_000 }),
    );

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain('scope resolution');
    expect(mockCreateSandbox).not.toHaveBeenCalled();
    now.mockRestore();
  });

  it('halts when the absolute deadline expires during sandbox provisioning', async () => {
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(20_000);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/app.ts', timeoutMs: 10_000 }),
    );

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain('sandbox provisioning');
    expect(mockCreateSandbox).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it('rejects a near-zero engine budget before mutation execution', async () => {
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(7_501);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/app.ts', timeoutMs: 10_000 }),
    );

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain('before mutation execution');
    now.mockRestore();
  });

  it('allows the minimum 1000ms engine budget boundary', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    const now = vi
      .spyOn(Date, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(7_000);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/app.ts', timeoutMs: 10_000 }),
    );

    expect(response.isError).toBeUndefined();
    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({ timeoutMs: 1_000 }),
    );
    now.mockRestore();
  });
});

describe('phase3 validators', () => {
  const ok = (args: Record<string, unknown>) => validateToolArgs(args) === null;
  const errText = (args: Record<string, unknown>) =>
    (validateToolArgs(args)?.content?.[0] as { text?: string } | undefined)?.text ?? '';

  it('accepts a valid runId alone', () => {
    expect(ok({ filePath: 'a.ts', runId: 'a1b2c3d4' })).toBe(true);
  });
  it('rejects empty runId', () => {
    expect(errText({ filePath: 'a.ts', runId: '' })).toContain('runId');
  });
  it('rejects runId with baseline/diffBase/lineScope', () => {
    expect(errText({ filePath: 'a.ts', runId: 'x', diffBase: 'HEAD' })).toContain(
      'mutually exclusive',
    );
    expect(errText({ filePath: 'a.ts', runId: 'x', baseline: { survivors: [] } })).toContain(
      'mutually exclusive',
    );
    expect(errText({ filePath: 'a.ts', runId: 'x', lineScope: { start: 1, end: 2 } })).toContain(
      'mutually exclusive',
    );
  });
  it('accepts valid suppress / unsuppress', () => {
    expect(ok({ filePath: 'a.ts', suppress: [{ line: 1, mutator: 'X', reason: 'eq' }] })).toBe(
      true,
    );
    expect(ok({ filePath: 'a.ts', unsuppress: [{ line: 1, mutator: 'X' }] })).toBe(true);
  });
  it('rejects malformed suppress entries', () => {
    expect(errText({ filePath: 'a.ts', suppress: [{ line: 0, mutator: 'X' }] })).toContain(
      'suppress',
    );
    expect(errText({ filePath: 'a.ts', suppress: [{ line: 1, mutator: '' }] })).toContain(
      'suppress',
    );
    expect(errText({ filePath: 'a.ts', suppress: 'nope' })).toContain('suppress');
  });
  it('rejects empty suppress array', () => {
    expect(errText({ filePath: 'a.ts', suppress: [] })).toContain('suppress');
  });
  it('rejects malformed unsuppress entries', () => {
    expect(errText({ filePath: 'a.ts', unsuppress: [{ line: 0, mutator: 'X' }] })).toContain(
      'unsuppress',
    );
    expect(errText({ filePath: 'a.ts', unsuppress: 'nope' })).toContain('unsuppress');
  });
});

describe('validateToolArgs minScore', () => {
  it('rejects out-of-range minScore', () => {
    const res = validateToolArgs({ filePath: 'a.ts', minScore: 150 });
    expect((res?.content?.[0] as { text?: string })?.text ?? '').toMatch(/minScore/);
  });

  it('accepts a valid minScore', () => {
    expect(validateToolArgs({ filePath: 'a.ts', minScore: 80 })).toBeNull();
  });
});

describe('mapCreateSandboxError', () => {
  const text = (result: ReturnType<typeof mapCreateSandboxError>): string => firstText(result);

  it('maps a real provisioning failure to the halted message, naming the file and the cause', () => {
    const result = mapCreateSandboxError(new Error('ENOSPC: no space left'), 'src/math.ts');
    expect(result.isError).toBe(true);
    expect(text(result)).toBe(
      'Chaos Engine Halted: Failed to provision sandbox isolation for src/math.ts: ' +
        'ENOSPC: no space left. Ensure the file exists and the workspace is accessible.',
    );
  });

  it('stringifies a non-Error rejection rather than dropping the cause', () => {
    // Engines and fs shims can reject with a bare string; `error.message` on it
    // would be undefined and erase the only diagnostic the caller gets.
    expect(text(mapCreateSandboxError('plain string reason', 'src/math.ts'))).toContain(
      'plain string reason',
    );
  });

  it('collapses an aborted request to the single shared cancel message', () => {
    // Every cancel path must surface the SAME string so a caller can branch on
    // it without parsing which layer noticed the abort first.
    const controller = new AbortController();
    controller.abort();
    const result = mapCreateSandboxError(new Error('whatever'), 'src/math.ts', {
      signal: controller.signal,
    });
    expect(text(result)).toBe('Operation cancelled.');
    expect(result.isError).toBe(true);
  });

  it('treats an AbortError as a cancel even with no context signal', () => {
    // The signal can flip between the throw and the catch, leaving only the
    // error's own name as evidence.
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    expect(text(mapCreateSandboxError(abortError, 'src/math.ts'))).toBe('Operation cancelled.');
  });

  it('does not treat a non-aborted context signal as a cancel', () => {
    // Pins `signal.aborted === true`: merely passing a live signal must not
    // swallow a genuine provisioning failure as a cancellation.
    const controller = new AbortController();
    const result = mapCreateSandboxError(new Error('EACCES'), 'src/math.ts', {
      signal: controller.signal,
    });
    expect(text(result)).toContain('Chaos Engine Halted');
    expect(text(result)).toContain('EACCES');
  });
});

/**
 * The three abort short-circuits are numbered in handler.ts because each one guards a
 * different expensive stage. A mutation audit found #2 (line 209) and #3 (line 253)
 * both survive being forced to false, and their 'Operation cancelled.' messages survive
 * being blanked — only #1 was covered.
 *
 * Aborting up front cannot test #2 or #3: short-circuit #1 catches it and the later
 * guards are never reached. Each test therefore aborts INSIDE a mock that runs in the
 * window the guard protects, so only that guard can catch it. Asserting what did NOT
 * run is what pins the stage down — a guard that fires too late would still return the
 * same message.
 */
describe('handleToolCall cancellation short-circuits', () => {
  const tsEnv = {
    projectType: 'typescript' as const,
    testRunner: 'vitest',
    detectedRunner: 'vitest',
    packageManager: '',
    workspaceRoot: '/workspace',
  };

  it('honours cancellation raised during scope resolution, before provisioning a sandbox', async () => {
    const controller = new AbortController();
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    // detectEnvironment runs after short-circuit #1 and before #2.
    mockDetectEnv.mockImplementation(() => {
      controller.abort();
      return tsEnv;
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts' }),
      undefined,
      { signal: controller.signal },
    );

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain('Operation cancelled.');
    // Short-circuit #2 exists precisely to avoid paying for a sandbox copy.
    expect(mockCreateSandbox).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('honours cancellation raised during sandbox provisioning, before running the engine', async () => {
    const controller = new AbortController();
    const mockRun = vi.fn();
    const cleanup = vi.fn();
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue(tsEnv);
    // Sandbox provisioning runs after short-circuit #2 and before #3.
    mockCreateSandbox.mockImplementation(async () => {
      controller.abort();
      return { workDir: '/tmp/chaos-mcp-sandbox', targetFile: '', cleanup };
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts' }),
      undefined,
      { signal: controller.signal },
    );

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain('Operation cancelled.');
    expect(mockCreateSandbox).toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
    // handler.ts:252 promises the finally-block still cleans up on this path.
    expect(cleanup).toHaveBeenCalled();
  });
});

/**
 * The defensive paths a mutation audit found unprotected in handler.ts. The existing
 * suite drives the happy path through all of them, which is why line coverage looked
 * healthy while every one of these mutated freely.
 */
describe('handleToolCall defensive paths', () => {
  // This is a separate top-level describe, so the sandbox default and the pinned cwd
  // from the main `handleToolCall` block do not apply here — they have to be restated.
  let cwdSpy2: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    cwdSpy2 = vi.spyOn(process, 'cwd').mockReturnValue('/workspace');
    mockCreateSandbox.mockResolvedValue({
      workDir: '/tmp/chaos-mcp-sandbox',
      targetFile: '',
      cleanup: vi.fn(),
    });
  });
  afterEach(() => cwdSpy2.mockRestore());

  const tsEnv = {
    projectType: 'typescript' as const,
    testRunner: 'vitest',
    detectedRunner: 'vitest',
    packageManager: '',
    workspaceRoot: '/workspace',
  };

  const cleanResult = (over: Record<string, unknown> = {}) => ({
    target: 'src/math.ts',
    totalMutants: 2,
    killed: 2,
    survived: 0,
    mutationScore: '100.00%',
    vulnerabilities: [],
    ...over,
  });

  it('emits the completion milestone on a successful short-circuit', async () => {
    const reportProgress = vi.fn();
    mockDetectEnv.mockReturnValue(tsEnv);
    mockComputeChangedRanges.mockResolvedValue({ kind: 'no-changes' });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts', diffBase: 'HEAD' }),
      undefined,
      { reportProgress },
    );

    expect(response.isError).toBeUndefined();
    expect(reportProgress).toHaveBeenCalledWith(4, 4, 'complete');
  });

  it('does not claim completion when the short-circuit is an error', async () => {
    // "No changes" is a success — the question was answered. A runId that is not in the
    // cache is not, and reporting 4/4 complete for it tells the caller the work finished.
    const reportProgress = vi.fn();
    mockDetectEnv.mockReturnValue(tsEnv);

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts', runId: 'deadbeef' }),
      undefined,
      { reportProgress },
    );

    expect(response.isError).toBe(true);
    expect(reportProgress).not.toHaveBeenCalledWith(4, 4, 'complete');
  });

  it('appends the scope note to one the engine already set, rather than replacing it', async () => {
    // The engine's note says the run was PARTIAL. Overwriting it drops that fact from the
    // text output, which prints this one field — the caller then reads a partial run as
    // whole-file. Rust + diffBase produces a scope note of its own, so both exist here.
    const mockRun = vi
      .fn()
      .mockResolvedValue(cleanResult({ scopeNote: 'Partial audit: completed 3 of 7 batches.' }));
    MockRustEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as RustEngine;
    });
    mockDetectEnv.mockReturnValue({ ...tsEnv, projectType: 'rust', testRunner: 'cargo' });
    mockComputeChangedRanges.mockResolvedValue({
      kind: 'ranges',
      ranges: [{ start: 1, end: 5 }],
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/x.rs', diffBase: 'HEAD' }),
    );

    const note = (response.structuredContent as { scopeNote?: string }).scopeNote ?? '';
    expect(note).toContain('Partial audit: completed 3 of 7 batches.');
    expect(note.length).toBeGreaterThan('Partial audit: completed 3 of 7 batches.'.length);
  });

  it('leaves the engine note alone when the run has no scope note of its own', async () => {
    // The other arm. Forced true, the append runs with an undefined scope note and
    // corrupts the engine's own text.
    const mockRun = vi
      .fn()
      .mockResolvedValue(cleanResult({ scopeNote: 'Partial audit: completed 3 of 7 batches.' }));
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue(tsEnv);

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts' }),
    );

    expect((response.structuredContent as { scopeNote?: string }).scopeNote).toBe(
      'Partial audit: completed 3 of 7 batches.',
    );
  });

  it('returns the suppression phase failure instead of continuing to format a report', async () => {
    // Cancelling DURING the engine run lands after abort short-circuit #3, so the
    // suppression phase is the first thing to notice. Its failure must be returned, not
    // swallowed — continuing would report a run the caller stopped as if it completed.
    const controller = new AbortController();
    const mockRun = vi.fn().mockImplementation(() => {
      controller.abort();
      return Promise.resolve(cleanResult());
    });
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue(tsEnv);

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts' }),
      undefined,
      { signal: controller.signal },
    );

    expect(response.isError).toBe(true);
    // Exact, not `toContain`. If the failure is swallowed, the cancelled CallToolResult
    // is assigned into `auditResults` and its text is EMBEDDED in the formatted payload
    // — so a substring check still matches while the run reports as if it completed.
    expect((response.content[0] as { text: string }).text).toBe('Operation cancelled.');
    expect(response.structuredContent).toBeUndefined();
  });
});

describe('handleToolCall progress reporting is optional', () => {
  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue('/workspace');
  });

  it('does not throw when a context supplies no reportProgress', async () => {
    // `ctx?.reportProgress?.()` — the SECOND `?.` matters. A caller may pass a context
    // carrying only a signal, and calling an absent reporter would abort the whole run
    // at the moment it tried to announce success.
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });
    mockComputeChangedRanges.mockResolvedValue({ kind: 'no-changes' });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts', diffBase: 'HEAD' }),
      undefined,
      {},
    );

    expect(response.isError).toBeUndefined();
  });
});

describe('handleToolCall returns a suppression write failure verbatim', () => {
  beforeEach(() => {
    vi.spyOn(process, 'cwd').mockReturnValue('/workspace');
    mockCreateSandbox.mockResolvedValue({
      workDir: '/tmp/chaos-mcp-sandbox',
      targetFile: '',
      cleanup: vi.fn(),
    });
  });

  it('stops rather than formatting a report the suppressions never reached', async () => {
    // A write failure, NOT a cancellation. Under cancellation this branch cannot be
    // distinguished — the outer isCancel catch produces the same response whether the
    // phase returns early or the formatting later throws — so only a non-cancel failure
    // shows whether the result is actually returned. Swallowing it would report a
    // successful audit while the caller's suppressions silently failed to save.
    mockApplySuppressions.mockResolvedValue({
      ok: false,
      result: {
        content: [{ type: 'text', text: 'Failed to update suppression list: disk on fire' }],
        isError: true,
      },
    });
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 1,
      killed: 1,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });
    MockTSEngine.mockImplementation(function () {
      return { run: mockRun } as unknown as TypeScriptEngine;
    });
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      packageManager: '',
      workspaceRoot: '/workspace',
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts' }),
    );

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toBe(
      'Failed to update suppression list: disk on fire',
    );
    expect(response.structuredContent).toBeUndefined();
  });
});

/**
 * Scope resolution runs BEFORE the sandbox exists and makes git calls of its own, so it
 * is handed the request's abort signal and what is left of the audit's wall-clock budget.
 * A mutation audit found that whole options object can be emptied without a single test
 * noticing: the run would look cancellable while git ran to completion, and the git calls
 * would get an unbounded timeout while spending from a clock everything else is measured
 * against. This repo already shipped 5157ab0 for a cancellation bug of exactly that
 * shape, and the sibling gap at triage/discover-targets.ts:83 was closed the same way —
 * by asserting the options argument WHOLE rather than asserting the call happened.
 *
 * The verbose dump below is in the same block because it is the other thing this stage
 * of the handler does that nothing observed: the existing suite only ever drives it with
 * verbosity forced ON, so the guard could be deleted and stay green.
 */
describe('handleToolCall forwards cancellation and budget to scope resolution', () => {
  // Separate top-level describe: the sandbox default and the pinned cwd from the main
  // `handleToolCall` block do not reach here and have to be restated.
  let cwdSpy3: ReturnType<typeof vi.spyOn>;

  const tsEnv = {
    projectType: 'typescript' as const,
    testRunner: 'vitest',
    detectedRunner: 'vitest',
    packageManager: '',
    workspaceRoot: '/workspace',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    cwdSpy3 = vi.spyOn(process, 'cwd').mockReturnValue('/workspace');
    mockCreateSandbox.mockResolvedValue({
      workDir: '/tmp/chaos-mcp-sandbox',
      targetFile: '',
      cleanup: vi.fn(),
    });
    mockDetectEnv.mockReturnValue(tsEnv);
    MockTSEngine.mockImplementation(function () {
      return {
        run: vi.fn().mockResolvedValue({
          target: 'src/math.ts',
          totalMutants: 2,
          killed: 2,
          survived: 0,
          mutationScore: '100.00%',
          vulnerabilities: [],
        }),
      } as unknown as TypeScriptEngine;
    });
  });

  afterEach(() => cwdSpy3.mockRestore());

  it('hands computeScope the request signal and a live deadline, not an empty context', async () => {
    const controller = new AbortController();

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts' }),
      undefined,
      { signal: controller.signal },
    );

    expect(response.isError).toBeUndefined();
    // Emptying this object is the surviving mutation. Asserting the call happened, or
    // even that the signal alone arrived, leaves half of it unpinned — so the argument
    // is compared as a whole: exactly these two keys, both populated.
    const gitCtx = mockComputeScope.mock.calls[0]?.[6];
    expect(gitCtx).toEqual({ signal: controller.signal, deadline: expect.any(AuditDeadline) });
  });

  it("gives scope resolution the run's own budget rather than a fresh clock", async () => {
    // The git calls spend from the SAME wall-clock the rest of the audit is measured
    // against; a deadline minted here (or a missing one) would let scoping burn the whole
    // timeout and still report time remaining to the engine afterwards. 30s is the
    // caller's number, not a default, so a deadline built from anything else shows up.
    await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts', timeoutMs: 30_000 }),
    );

    const deadline = mockComputeScope.mock.calls[0]?.[6]?.deadline;
    expect(deadline?.budgetMs).toBe(30_000);
    // Already ticking: the budget handed over is what is LEFT, not a full reset.
    expect(deadline?.remainingMs()).toBeGreaterThan(0);
    expect(deadline?.remainingMs()).toBeLessThanOrEqual(30_000);
  });

  it('stays silent about the run context at the default verbosity', async () => {
    // `if (isVerbose())` survives being forced to true because every existing verbose
    // assertion turns verbosity ON first. Without this case the guard could be dropped
    // and stderr would carry the target path, workspace root and sandbox path of every
    // audit on a server nobody asked to be verbose.
    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts' }),
    );

    expect(response.isError).toBeUndefined();
    const contextLines = mockLog.mock.calls
      .map((c) => String(c[0] ?? ''))
      .filter(
        (m) =>
          m.startsWith('Tool call:') ||
          m.startsWith('  filePath:') ||
          m.startsWith('  projectType:') ||
          m.startsWith('  workspaceRoot:') ||
          m.startsWith('  sandboxDir:'),
      );
    expect(contextLines).toEqual([]);
  });

  it('dumps the resolved run context once verbosity is on', async () => {
    // The other arm, asserted on the lines logAuditContext emits unconditionally, so the
    // pairing above cannot be satisfied by a handler that simply never logs.
    mockIsVerbose.mockReturnValue(true);

    await handleToolCall(makeRequest('audit_code_resilience', { filePath: 'src/math.ts' }));

    expect(mockLog).toHaveBeenCalledWith('Tool call: audit_code_resilience');
    expect(mockLog).toHaveBeenCalledWith('  filePath: src/math.ts');
    // The SANDBOX path, not the workspace path: this dump is written after provisioning
    // and is the only place the caller can see where the mutants actually ran.
    expect(mockLog).toHaveBeenCalledWith('  sandboxDir: /tmp/chaos-mcp-sandbox');
  });
});
