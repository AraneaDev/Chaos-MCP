import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

// Shared spies for the mocked MCP SDK server, hoisted so the vi.mock factory
// (which is hoisted above imports) can close over them.
const sdk = vi.hoisted(() => ({
  serverCtor: vi.fn(),
  setRequestHandler: vi.fn(),
  connect: vi.fn(() => Promise.resolve()),
  transportCtor: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    setRequestHandler = sdk.setRequestHandler;
    connect = sdk.connect;
    constructor(info: unknown, opts: unknown) {
      sdk.serverCtor(info, opts);
    }
  },
}));

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(() => {
    sdk.transportCtor();
  }),
}));

vi.mock('../tool-schema.js', () => ({
  TOOL_DEFINITION: { name: 'audit_code_resilience' },
  TRIAGE_TOOL_DEFINITION: { name: 'triage_test_coverage' },
  ESTIMATE_TOOL_DEFINITION: { name: 'estimate_audit' },
}));
vi.mock('../handler.js', () => ({ handleToolCall: vi.fn(() => Promise.resolve({ content: [] })) }));
vi.mock('../triage-handler.js', () => ({
  handleTriageCall: vi.fn(() => Promise.resolve({ content: [] })),
}));
vi.mock('../estimate-handler.js', () => ({
  handleEstimateCall: vi.fn(() => Promise.resolve({ content: [] })),
}));
vi.mock('../cli.js', () => ({ runCli: vi.fn() }));

// Fixed ctx returned by makeToolContext; used to assert handlers receive it.
const FIXED_CTX = { signal: undefined };
vi.mock('../tool-context.js', () => ({
  makeToolContext: vi.fn(() => FIXED_CTX),
}));

// Minimal stubs so the resource/prompt modules can be imported without touching
// the real engine registry or file system.
vi.mock('../resources.js', () => ({
  listResources: vi.fn(() => [
    {
      uri: 'chaos://languages',
      name: 'Supported languages',
      description: '',
      mimeType: 'application/json',
    },
    {
      uri: 'chaos://config-schema',
      name: 'Config schema',
      description: '',
      mimeType: 'application/json',
    },
    {
      uri: 'chaos://capabilities',
      name: 'Capabilities overview',
      description: '',
      mimeType: 'text/markdown',
    },
  ]),
  readResource: vi.fn((uri: string) => ({ uri, mimeType: 'application/json', text: '{}' })),
}));

vi.mock('../prompts.js', () => ({
  listPrompts: vi.fn(() => [
    { name: 'harden_file', description: 'Harden a file.', arguments: [] },
    { name: 'triage_changes', description: 'Triage changed files.', arguments: [] },
  ]),
  getPrompt: vi.fn((_name: string, _args: Record<string, string>) => ({
    description: 'Harden src/foo.ts against surviving mutants.',
    messages: [{ role: 'user', content: { type: 'text', text: 'Harden src/foo.ts' } }],
  })),
}));

import { startServer, APP_VERSION } from '../index.js';
import {
  TOOL_DEFINITION,
  TRIAGE_TOOL_DEFINITION,
  ESTIMATE_TOOL_DEFINITION,
} from '../tool-schema.js';
import { handleToolCall } from '../handler.js';
import { handleTriageCall } from '../triage-handler.js';
import { handleEstimateCall } from '../estimate-handler.js';
import { makeToolContext } from '../tool-context.js';
import { listResources, readResource } from '../resources.js';
import { listPrompts, getPrompt } from '../prompts.js';

describe('startServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.connect.mockResolvedValue(undefined);
  });

  it('constructs the MCP server with the chaos-mcp name and synced version', async () => {
    await startServer();
    expect(sdk.serverCtor).toHaveBeenCalledWith(
      { name: 'chaos-mcp', version: APP_VERSION },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );
  });

  it('registers the tools/list handler returning all three tool definitions', async () => {
    await startServer();
    const handler = sdk.setRequestHandler.mock.calls.find(
      (c) => c[0] === ListToolsRequestSchema,
    )?.[1];
    expect(handler).toBeTypeOf('function');
    const result = await (handler as () => Promise<unknown>)();
    expect(result).toEqual({
      tools: [TOOL_DEFINITION, TRIAGE_TOOL_DEFINITION, ESTIMATE_TOOL_DEFINITION],
    });
  });

  it('registers the tools/call handler delegating to handleToolCall with the config and ctx', async () => {
    const config = { defaultTimeoutMs: 4242 };
    await startServer(config);
    const handler = sdk.setRequestHandler.mock.calls.find(
      (c) => c[0] === CallToolRequestSchema,
    )?.[1];
    expect(handler).toBeTypeOf('function');
    const request = { params: { name: 'audit_code_resilience', arguments: {} } };
    const extra = { signal: undefined };
    await (handler as (req: unknown, extra: unknown) => Promise<unknown>)(request, extra);
    expect(makeToolContext).toHaveBeenCalledWith(request, extra);
    expect(handleToolCall).toHaveBeenCalledWith(request, config, FIXED_CTX);
    expect(handleTriageCall).not.toHaveBeenCalled();
  });

  it('routes triage_test_coverage to handleTriageCall with the config and ctx', async () => {
    const config = { defaultMaxFiles: 7 };
    await startServer(config);
    const handler = sdk.setRequestHandler.mock.calls.find(
      (c) => c[0] === CallToolRequestSchema,
    )?.[1];
    expect(handler).toBeTypeOf('function');
    const request = { params: { name: 'triage_test_coverage', arguments: { paths: ['src'] } } };
    const extra = { signal: undefined };
    await (handler as (req: unknown, extra: unknown) => Promise<unknown>)(request, extra);
    expect(makeToolContext).toHaveBeenCalledWith(request, extra);
    expect(handleTriageCall).toHaveBeenCalledWith(request, config, FIXED_CTX);
    expect(handleToolCall).not.toHaveBeenCalled();
  });

  it('routes estimate_audit to handleEstimateCall with the config and ctx', async () => {
    const config = { defaultTimeoutMs: 30_000 };
    await startServer(config);
    const handler = sdk.setRequestHandler.mock.calls.find(
      (c) => c[0] === CallToolRequestSchema,
    )?.[1];
    expect(handler).toBeTypeOf('function');
    const request = { params: { name: 'estimate_audit', arguments: { filePath: 'src/math.ts' } } };
    const extra = { signal: undefined };
    await (handler as (req: unknown, extra: unknown) => Promise<unknown>)(request, extra);
    expect(makeToolContext).toHaveBeenCalledWith(request, extra);
    expect(handleEstimateCall).toHaveBeenCalledWith(request, config, FIXED_CTX);
    expect(handleToolCall).not.toHaveBeenCalled();
    expect(handleTriageCall).not.toHaveBeenCalled();
  });

  it('registers the resources/list handler returning all three resources', async () => {
    await startServer();
    const handler = sdk.setRequestHandler.mock.calls.find(
      (c) => c[0] === ListResourcesRequestSchema,
    )?.[1];
    expect(handler).toBeTypeOf('function');
    const result = await (handler as () => Promise<unknown>)();
    expect(result).toEqual({ resources: listResources() });
  });

  it('registers the resources/read handler returning contents for a known URI', async () => {
    await startServer();
    const handler = sdk.setRequestHandler.mock.calls.find(
      (c) => c[0] === ReadResourceRequestSchema,
    )?.[1];
    expect(handler).toBeTypeOf('function');
    const request = { params: { uri: 'chaos://languages' } };
    const result = await (handler as (req: unknown) => Promise<unknown>)(request);
    expect(readResource).toHaveBeenCalledWith('chaos://languages');
    expect(result).toEqual({ contents: [readResource('chaos://languages')] });
  });

  it('registers the prompts/list handler returning all two prompts', async () => {
    await startServer();
    const handler = sdk.setRequestHandler.mock.calls.find(
      (c) => c[0] === ListPromptsRequestSchema,
    )?.[1];
    expect(handler).toBeTypeOf('function');
    const result = await (handler as () => Promise<unknown>)();
    expect(result).toEqual({ prompts: listPrompts() });
  });

  it('registers the prompts/get handler delegating to getPrompt', async () => {
    await startServer();
    const handler = sdk.setRequestHandler.mock.calls.find(
      (c) => c[0] === GetPromptRequestSchema,
    )?.[1];
    expect(handler).toBeTypeOf('function');
    const request = { params: { name: 'harden_file', arguments: { filePath: 'src/foo.ts' } } };
    const result = await (handler as (req: unknown) => Promise<unknown>)(request);
    expect(getPrompt).toHaveBeenCalledWith('harden_file', { filePath: 'src/foo.ts' });
    expect(result).toEqual(getPrompt('harden_file', { filePath: 'src/foo.ts' }));
  });

  it('connects the server over a stdio transport', async () => {
    await startServer();
    expect(sdk.transportCtor).toHaveBeenCalledTimes(1);
    expect(sdk.connect).toHaveBeenCalledTimes(1);
  });
});

describe('direct-run guard (isDirectRun)', () => {
  const origArgv1 = process.argv[1];

  async function loadIndexWith(argv1: string): Promise<typeof import('../cli.js').runCli> {
    vi.resetModules();
    process.argv[1] = argv1;
    const { runCli } = await import('../cli.js');
    vi.mocked(runCli).mockClear();
    await import('../index.js');
    return runCli;
  }

  it('invokes runCli with the app version and server factory when run directly', async () => {
    const runCli = await loadIndexWith('/some/path/index.js');
    expect(vi.mocked(runCli)).toHaveBeenCalledTimes(1);
    // Pin the injected dependency object (the `{ appVersion, startServer }` literal).
    expect(vi.mocked(runCli)).toHaveBeenCalledWith(
      expect.objectContaining({ appVersion: APP_VERSION, startServer: expect.any(Function) }),
    );
    process.argv[1] = origArgv1;
  });

  it('invokes runCli when argv[1] ends with /index.ts (ts-node/tsx)', async () => {
    const runCli = await loadIndexWith('/some/path/index.ts');
    expect(vi.mocked(runCli)).toHaveBeenCalledTimes(1);
    process.argv[1] = origArgv1;
  });

  it('does NOT invoke runCli when argv[1] is some other entrypoint', async () => {
    const runCli = await loadIndexWith('/some/path/vitest-worker.js');
    expect(vi.mocked(runCli)).not.toHaveBeenCalled();
    process.argv[1] = origArgv1;
  });

  it('uses the resolved path for existing direct and non-direct entrypoints', async () => {
    const direct = await loadIndexWith('/root/Chaos-MCP/build/index.js');
    expect(vi.mocked(direct)).toHaveBeenCalledTimes(1);

    const directSource = await loadIndexWith('/root/Chaos-MCP/src/index.ts');
    expect(vi.mocked(directSource)).toHaveBeenCalledTimes(1);

    const indirect = await loadIndexWith('/root/Chaos-MCP/package.json');
    expect(vi.mocked(indirect)).not.toHaveBeenCalled();
    process.argv[1] = origArgv1;
  });
});
