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

import { handleToolCall } from '../index.js';
import { TypeScriptEngine } from '../engines/typescript.js';
import { GoEngine } from '../engines/go.js';
import { detectEnvironment } from '../utils/project-detector.js';
import { createSandbox } from '../utils/sandbox.js';

const MockTSEngine = vi.mocked(TypeScriptEngine);
const MockGoEngine = vi.mocked(GoEngine);
const mockDetectEnv = vi.mocked(detectEnvironment);
const mockCreateSandbox = vi.mocked(createSandbox);

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

  it('passes mutatorAllowlist to RunOptions', async () => {
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

    expect(mockRun).toHaveBeenCalledWith(
      'src/math.ts',
      expect.objectContaining({
        mutatorAllowlist: ['ConditionalExpression', 'ArithmeticOperator'],
      }),
    );
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

    const request = makeRequest('audit_code_resilience', { filePath: 'src/main.go' });
    const response = await handleToolCall(request);

    expect(response.isError).toBeUndefined();
    expect(mockRun).toHaveBeenCalledWith('src/main.go', expect.any(Object));
  });

  it('dispatches .rs files to RustEngine', async () => {
    const mockRun = vi.fn().mockResolvedValue({
      target: 'src/math.go',
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

    const request = makeRequest('audit_code_resilience', { filePath: 'src/math.go' });
    const response = await handleToolCall(request);

    expect(response.isError).toBeUndefined();
    expect(mockRun).toHaveBeenCalledWith(
      'src/math.go',
      expect.objectContaining({ testRunner: 'go test' }),
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
    expect(text).toContain('Line 42');
    // Should NOT be JSON
    expect(text.startsWith('{')).toBe(false);
  });

  it('returns error when concurrency is not an integer (H5 regression)', async () => {
    const mockRun = vi.fn();
    MockTSEngine.mockImplementation(() => ({ run: mockRun } as unknown as TypeScriptEngine));
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
    MockTSEngine.mockImplementation(() => ({ run: mockRun } as unknown as TypeScriptEngine));
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
    MockTSEngine.mockImplementation(() => ({ run: mockRun } as unknown as TypeScriptEngine));
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
    MockTSEngine.mockImplementation(() => ({ run: mockRun } as unknown as TypeScriptEngine));
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
});
