import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';

// Mock engines
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
    existsSync: vi.fn().mockReturnValue(false),
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

// Mock logger for verbose logging tests
vi.mock('../utils/logger.js', () => ({
  enableVerbose: vi.fn(),
  isVerbose: vi.fn().mockReturnValue(false),
  log: vi.fn(),
  warn: vi.fn(),
}));

import { handleToolCall } from '../index.js';
import { TypeScriptEngine } from '../engines/typescript.js';
import { GoEngine } from '../engines/go.js';
import { detectEnvironment } from '../utils/project-detector.js';
import { createSandbox } from '../utils/sandbox.js';
import { runShellCommand } from '../utils/exec.js';
import { isVerbose, log } from '../utils/logger.js';
import { existsSync } from 'fs';

const MockTSEngine = vi.mocked(TypeScriptEngine);
const MockGoEngine = vi.mocked(GoEngine);
const mockDetectEnv = vi.mocked(detectEnvironment);
const mockCreateSandbox = vi.mocked(createSandbox);
const mockRunShellCommand = vi.mocked(runShellCommand);
const mockIsVerbose = vi.mocked(isVerbose);
const mockLog = vi.mocked(log);
const mockExistsSync = vi.mocked(existsSync);

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
  beforeEach(() => {
    vi.clearAllMocks();

    // Reset logger mock to silent default (prevents leak from verbose tests)
    mockIsVerbose.mockReturnValue(false);
    // Reset existsSync mock to false (prevents leak from Go/Rust prebuild tests)
    mockExistsSync.mockReturnValue(false);

    // Default sandbox mock
    mockCreateSandbox.mockReturnValue({
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

    MockTSEngine.mockImplementation(
      () =>
        ({
          run: mockRun,
        }) as unknown as TypeScriptEngine,
    );

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    const nestedRoot = `${process.cwd()}/packages/app`;
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      workspaceRoot: nestedRoot,
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'packages/app/src/x.ts',
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBeUndefined();
    expect(mockRun).toHaveBeenCalledWith('src/x.ts', expect.objectContaining({}));
    expect(mockCreateSandbox).toHaveBeenCalledWith('src/x.ts', nestedRoot, undefined);
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      timeoutMs: 60000,
    });
    await handleToolCall(request);

    expect(mockRun).toHaveBeenCalledWith(
      'src/math.ts',
      expect.objectContaining({ timeoutMs: 60000 }),
    );
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

  it('drops mutatorAllowlist from RunOptions (unsupported in StrykerJS v9)', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      mutatorAllowlist: ['ConditionalExpression', 'ArithmeticOperator'],
    });
    await handleToolCall(request);

    const opts = mockRun.mock.calls[0][1];
    expect(opts.mutatorAllowlist).toBeUndefined();
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
    mockCreateSandbox.mockReturnValue({
      workDir: '/tmp/chaos-mcp-sandbox',
      targetFile: 'src/bad.ts',
      cleanup: mockCleanup,
    });

    MockTSEngine.mockImplementation(
      () =>
        ({
          run: vi.fn().mockRejectedValue(new Error('Stryker crashed')),
        }) as unknown as TypeScriptEngine,
    );

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

  it('dispatches .go files to GoEngine', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/main.go',
      totalMutants: 3,
      killed: 3,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockGoEngine.mockImplementation(() => ({ run: mockRun }) as unknown as GoEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'go',
      testRunner: 'go test',
      detectedRunner: 'go test',
      workspaceRoot: '/workspace',
    });

    // go.mod is absent by default (mockExistsSync returns false), so no smart
    // prebuild triggers — no need to mock runShellCommand here.

    const request = makeRequest('audit_code_resilience', { filePath: 'src/main.go' });
    const response = await handleToolCall(request);

    expect(response.isError).toBeUndefined();
    expect(mockRun).toHaveBeenCalledWith('src/main.go', expect.any(Object));
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

    MockRustEngine.mockImplementation(
      () => ({ run: mockRun }) as unknown as typeof RustEngine.prototype,
    );

    mockDetectEnv.mockReturnValue({
      projectType: 'rust',
      testRunner: 'cargo test',
      detectedRunner: 'cargo test',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
        timeoutMs: 60000, // from args (overrides config)
        mutatorDenylist: ['StringLiteral'], // from config (no arg override)
      }),
    );
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      workspaceRoot: '/workspace',
    });

    const config = { defaultTimeoutMs: 60000 };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({ timeoutMs: 60000 }),
    );
  });

  it('throws for unrecognized tool names', async () => {
    const request = makeRequest('unknown_tool', { filePath: 'test.ts' });
    await expect(handleToolCall(request)).rejects.toThrow('Method unrecognized: unknown_tool');
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

  it('passes ignorePatterns to createSandbox and RunOptions', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      ignorePatterns: ['.test.ts', 'fixtures/'],
    });
    await handleToolCall(request);

    // createSandbox should receive ignorePatterns as 3rd arg
    expect(mockCreateSandbox).toHaveBeenCalledWith('src/math.ts', '/workspace', [
      '.test.ts',
      'fixtures/',
    ]);
    // RunOptions should also contain ignorePatterns
    expect(mockRun).toHaveBeenCalledWith(
      'src/math.ts',
      expect.objectContaining({ ignorePatterns: ['.test.ts', 'fixtures/'] }),
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
        { line: 42, replacement: 'ConditionalExpression', description: 'Mutation survived.' },
      ],
    });

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
    // Survivors are bundled by line: "42: ConditionalExpression"
    expect(text).toContain('42: ConditionalExpression');
    // Should NOT be JSON
    expect(text.startsWith('{')).toBe(false);
  });

  it('returns error when concurrency is not an integer (H5 regression)', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      lineScope: { start: 50, end: 10 },
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain('lineScope must be');
  });

  it('returns error when ignorePatterns contains non-string elements (M7 regression)', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
      { line: 42, replacement: 'ConditionalExpression', description: 'Logical mutation survived.' },
      { line: 42, replacement: 'ConditionalExpression', description: 'Logical mutation survived.' },
      { line: 42, replacement: 'LogicalOperator', description: 'Logical mutation survived.' },
      {
        line: 99,
        replacement: 'StringLiteral',
        description: 'No test reached this line (NoCoverage). Consider adding tests.',
      },
    ],
  };

  function mockSurvivorRun() {
    MockTSEngine.mockImplementation(
      () => ({ run: vi.fn().mockResolvedValue(survivorResult) }) as unknown as TypeScriptEngine,
    );
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      workspaceRoot: '/workspace',
    });
  }

  it('bundles survivors by line with deduplicated mutator counts (JSON)', async () => {
    mockSurvivorRun();
    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts' }),
    );
    const parsed = JSON.parse((response.content[0] as { text: string }).text);

    expect(parsed.summary).toEqual({ total: 10, killed: 6, survived: 4 });
    // One grouped entry for line 42 (not three repeated entries).
    expect(parsed.survivors).toEqual([
      { line: 42, mutators: { ConditionalExpression: 2, LogicalOperator: 1 } },
    ]);
    // NoCoverage mutant is split out (with its mutator), not mixed into survivors.
    expect(parsed.noCoverage).toEqual([{ line: 99, mutators: { StringLiteral: 1 } }]);
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

  it('renders bundled survivors in text format', async () => {
    mockSurvivorRun();
    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/math.ts', outputFormat: 'text' }),
    );
    const text = (response.content[0] as { text: string }).text;

    expect(text).toContain('42: ConditionalExpression×2, LogicalOperator');
    expect(text).toContain('No-coverage mutants (line: mutators):');
    expect(text).toContain('99: StringLiteral');
  });

  it('reports a NoCoverage mutant and a covered survivor on the SAME line separately', async () => {
    // Real case (go.ts/rust.ts): an unreachable `|| []` ArrayDeclaration is
    // NoCoverage while a live `.filter` MethodExpression on the same line is a
    // survivor. The line must NOT be reported as wholly uncovered.
    MockTSEngine.mockImplementation(
      () =>
        ({
          run: vi.fn().mockResolvedValue({
            target: 'src/x.ts',
            totalMutants: 5,
            killed: 3,
            survived: 2,
            mutationScore: '60.00%',
            vulnerabilities: [
              {
                line: 113,
                replacement: 'MethodExpression',
                description: 'Logical mutation survived.',
              },
              {
                line: 113,
                replacement: 'ArrayDeclaration',
                description: 'No test reached this line (NoCoverage). Consider adding tests.',
              },
            ],
          }),
        }) as unknown as TypeScriptEngine,
    );
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      workspaceRoot: '/workspace',
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/x.ts' }),
    );
    const parsed = JSON.parse((response.content[0] as { text: string }).text);

    expect(parsed.survivors).toEqual([{ line: 113, mutators: { MethodExpression: 1 } }]);
    expect(parsed.noCoverage).toEqual([{ line: 113, mutators: { ArrayDeclaration: 1 } }]);
  });

  // ─── prebuildCommand tests ──────────────────────────────────────────────────

  it('returns error when prebuildCommand is not a string', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
    expect(mockRunShellCommand).toHaveBeenCalledWith('npm run build', {
      cwd: '/tmp/chaos-mcp-sandbox',
      timeoutMs: undefined,
    });
    expect(mockRun).toHaveBeenCalled();
  });

  it('rejects an explicit prebuildCommand unless allowPrebuild is enabled', async () => {
    const mockCleanup = vi.fn();
    mockCreateSandbox.mockReturnValue({
      workDir: '/tmp/chaos-mcp-sandbox',
      targetFile: 'src/math.ts',
      cleanup: mockCleanup,
    });
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    // 10000ms total budget − 4000ms spent on prebuild = 6000ms left for the engine.
    expect(mockRun.mock.calls[0][1].timeoutMs).toBe(6000);
    dateSpy.mockRestore();
  });

  it('validates tool args before provisioning the sandbox', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
    MockPyEngine.mockImplementation(
      () => ({ run: mockRun }) as unknown as typeof PythonEngine.prototype,
    );
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
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
    mockCreateSandbox.mockReturnValue({
      workDir: '/tmp/chaos-mcp-sandbox',
      targetFile: 'src/math.ts',
      cleanup: mockCleanup,
    });

    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);

    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      workspaceRoot: '/workspace',
    });

    const config = {
      defaultTimeoutMs: 300000,
      stryker: { timeoutMs: 60000 },
    };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/app.ts' });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith(
      'src/app.ts',
      expect.objectContaining({ timeoutMs: 60000 }),
    );
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
        timeoutMs: 15000, // from args (overrides everything)
        concurrency: 4, // from stryker engine config
      }),
    );
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

    MockRustEngine.mockImplementation(
      () => ({ run: mockRun }) as unknown as typeof RustEngine.prototype,
    );
    mockDetectEnv.mockReturnValue({
      projectType: 'rust',
      testRunner: 'cargo test',
      detectedRunner: 'cargo test',
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
      expect.objectContaining({ timeoutMs: 600000 }),
    );
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

    MockPyEngine.mockImplementation(
      () => ({ run: mockRun }) as unknown as typeof PythonEngine.prototype,
    );
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
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
      expect.objectContaining({ timeoutMs: 300000 }),
    );
  });

  it('uses mutmut engine config timeoutMs for Python files', async () => {
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

    MockPyEngine.mockImplementation(
      () => ({ run: mockRun }) as unknown as typeof PythonEngine.prototype,
    );
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      workspaceRoot: '/workspace',
    });

    const config = {
      mutmut: { timeoutMs: 120000 },
    };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/calc.py' });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith(
      'src/calc.py',
      expect.objectContaining({ timeoutMs: 120000 }),
    );
  });

  it('uses mutmut engine config testRunner override for Python files', async () => {
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

    MockPyEngine.mockImplementation(
      () => ({ run: mockRun }) as unknown as typeof PythonEngine.prototype,
    );
    mockDetectEnv.mockReturnValue({
      projectType: 'python',
      testRunner: 'pytest',
      detectedRunner: 'pytest',
      workspaceRoot: '/workspace',
    });

    const config = {
      mutmut: { testRunner: 'python -m unittest' },
    };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/calc.py' });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith(
      'src/calc.py',
      expect.objectContaining({ testRunner: 'python -m unittest' }),
    );
  });

  it('uses go engine config timeout for Go files', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/main.go',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockGoEngine.mockImplementation(() => ({ run: mockRun }) as unknown as GoEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'go',
      testRunner: 'go test',
      detectedRunner: 'go test',
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
      go: { timeoutMs: 180000 },
    };

    const request = makeRequest('audit_code_resilience', { filePath: 'src/main.go' });
    await handleToolCall(request, config);

    expect(mockRun).toHaveBeenCalledWith(
      'src/main.go',
      expect.objectContaining({ timeoutMs: 180000 }),
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockPyEngine.mockImplementation(
      () => ({ run: mockRun }) as unknown as typeof PythonEngine.prototype,
    );
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

    MockPyEngine.mockImplementation(
      () => ({ run: mockRun }) as unknown as typeof PythonEngine.prototype,
    );
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

    MockPyEngine.mockImplementation(
      () => ({ run: mockRun }) as unknown as typeof PythonEngine.prototype,
    );
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

    expect(mockRunShellCommand).toHaveBeenCalledWith('pip install -e .', {
      cwd: '/tmp/chaos-mcp-sandbox',
      timeoutMs: undefined,
    });
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

    MockPyEngine.mockImplementation(
      () => ({ run: mockRun }) as unknown as typeof PythonEngine.prototype,
    );
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

  // ─── Go/Rust smart prebuild tests ──────────────────────────────────────

  it('uses go mod download as default prebuild for Go projects', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/main.go',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockGoEngine.mockImplementation(() => ({ run: mockRun }) as unknown as GoEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'go',
      testRunner: 'go test',
      detectedRunner: 'go test',
      workspaceRoot: '/workspace',
    });

    // go.mod must exist for smart prebuild to trigger
    mockExistsSync.mockImplementation((p) => String(p).endsWith('go.mod'));

    mockRunShellCommand.mockResolvedValue({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/main.go' });
    await handleToolCall(request);

    expect(mockRunShellCommand).toHaveBeenCalledWith('go mod download', {
      cwd: '/tmp/chaos-mcp-sandbox',
      timeoutMs: undefined,
    });
    expect(mockRun).toHaveBeenCalled();
  });

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

    MockRustEngine.mockImplementation(
      () => ({ run: mockRun }) as unknown as typeof RustEngine.prototype,
    );
    mockDetectEnv.mockReturnValue({
      projectType: 'rust',
      testRunner: 'cargo test',
      detectedRunner: 'cargo test',
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

    expect(mockRunShellCommand).toHaveBeenCalledWith('cargo check', {
      cwd: '/tmp/chaos-mcp-sandbox',
      timeoutMs: undefined,
    });
    expect(mockRun).toHaveBeenCalled();
  });

  it('explicit prebuildCommand overrides smart default for Go projects', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/main.go',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockGoEngine.mockImplementation(() => ({ run: mockRun }) as unknown as GoEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'go',
      testRunner: 'go test',
      detectedRunner: 'go test',
      workspaceRoot: '/workspace',
    });

    // go.mod exists but explicit prebuild overrides
    mockExistsSync.mockImplementation((p) => String(p).endsWith('go.mod'));

    mockRunShellCommand.mockResolvedValue({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/main.go',
      prebuildCommand: 'go build ./...',
    });
    await handleToolCall(request, { allowPrebuild: true });

    // Explicit command wins over auto-default
    expect(mockRunShellCommand).toHaveBeenCalledWith('go build ./...', {
      cwd: '/tmp/chaos-mcp-sandbox',
      timeoutMs: undefined,
    });
    expect(mockRun).toHaveBeenCalled();
  });

  it('skips smart prebuild for Go when go.mod is absent', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/main.go',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockGoEngine.mockImplementation(() => ({ run: mockRun }) as unknown as GoEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'go',
      testRunner: 'go test',
      detectedRunner: 'go test',
      workspaceRoot: '/workspace',
    });

    // go.mod does NOT exist — smart prebuild skipped
    mockExistsSync.mockReturnValue(false);

    const request = makeRequest('audit_code_resilience', { filePath: 'src/main.go' });
    await handleToolCall(request);

    // No prebuild should be called
    expect(mockRunShellCommand).not.toHaveBeenCalled();
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

    MockRustEngine.mockImplementation(
      () => ({ run: mockRun }) as unknown as typeof RustEngine.prototype,
    );
    mockDetectEnv.mockReturnValue({
      projectType: 'rust',
      testRunner: 'cargo test',
      detectedRunner: 'cargo test',
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

    MockPyEngine.mockImplementation(
      () => ({ run: mockRun }) as unknown as typeof PythonEngine.prototype,
    );
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

    MockPyEngine.mockImplementation(
      () => ({ run: mockRun }) as unknown as typeof PythonEngine.prototype,
    );
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

  // ─── mutatorAllowlist (unsupported in StrykerJS v9 — always dropped) ────

  it('drops a config-provided mutatorAllowlist so it never reaches the engine', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/app.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      lineScope: { start: 0, end: 10 },
    });
    const response = await handleToolCall(request);

    expect(response.isError).toBe(true);
    expect((response.content[0] as { text: string }).text).toContain('lineScope must be');
    expect(mockRun).not.toHaveBeenCalled();
  });

  // ─── outputFormat invalid value falls to undefined ────────────────────

  it('outputFormat with invalid value falls to JSON default (undefined)', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.ts',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      workspaceRoot: '/workspace',
    });

    const request = makeRequest('audit_code_resilience', {
      filePath: 'src/math.ts',
      outputFormat: 'xml',
    });
    await handleToolCall(request);

    // outputFormat should be undefined in RunOptions (invalid val rejected)
    expect(mockRun).toHaveBeenCalledWith(
      'src/math.ts',
      expect.objectContaining({ outputFormat: undefined }),
    );
  });

  // ─── Go/Rust auto prebuild verbose logging ──────────────────────────────

  it('logs [auto (go)] when smart prebuild kicks in for Go projects with verbose', async () => {
    mockIsVerbose.mockReturnValue(true);

    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/main.go',
      totalMutants: 0,
      killed: 0,
      survived: 0,
      mutationScore: '100.00%',
      vulnerabilities: [],
    });

    MockGoEngine.mockImplementation(() => ({ run: mockRun }) as unknown as GoEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'go',
      testRunner: 'go test',
      detectedRunner: 'go test',
      workspaceRoot: '/workspace',
    });

    mockExistsSync.mockImplementation((p) => String(p).endsWith('go.mod'));
    mockRunShellCommand.mockResolvedValue({
      stdout: '',
      stderr: '',
      exit: 0,
      signal: null,
    });

    const request = makeRequest('audit_code_resilience', { filePath: 'src/main.go' });
    await handleToolCall(request);

    // Go has no packageManager so autoLabel falls back to projectType 'go'
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('[auto (go)]'));
    expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('go mod download'));
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockPyEngine.mockImplementation(
      () => ({ run: mockRun }) as unknown as typeof PythonEngine.prototype,
    );
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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

    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
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
    MockTSEngine.mockImplementation(() => ({ run: mockRun }) as unknown as TypeScriptEngine);
    mockDetectEnv.mockReturnValue({
      projectType: 'typescript',
      testRunner: 'vitest',
      detectedRunner: 'vitest',
      workspaceRoot: '/workspace',
    });

    const response = await handleToolCall(
      makeRequest('audit_code_resilience', { filePath: 'src/deep/nested/math.ts' }),
    );
    expect(response.isError).toBeUndefined();
    expect(mockRun).toHaveBeenCalled();
  });
});
