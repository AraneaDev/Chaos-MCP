import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

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

vi.mock('../tool-schema.js', () => ({ TOOL_DEFINITION: { name: 'audit_code_resilience' } }));
vi.mock('../handler.js', () => ({ handleToolCall: vi.fn(() => Promise.resolve({ content: [] })) }));
vi.mock('../cli.js', () => ({ runCli: vi.fn() }));

import { startServer, APP_VERSION } from '../index.js';
import { TOOL_DEFINITION } from '../tool-schema.js';
import { handleToolCall } from '../handler.js';

describe('startServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.connect.mockResolvedValue(undefined);
  });

  it('constructs the MCP server with the chaos-mcp name and synced version', async () => {
    await startServer();
    expect(sdk.serverCtor).toHaveBeenCalledWith(
      { name: 'chaos-mcp', version: APP_VERSION },
      { capabilities: { tools: {} } },
    );
  });

  it('registers the tools/list handler returning the single tool definition', async () => {
    await startServer();
    const handler = sdk.setRequestHandler.mock.calls.find(
      (c) => c[0] === ListToolsRequestSchema,
    )?.[1];
    expect(handler).toBeTypeOf('function');
    const result = await (handler as () => Promise<unknown>)();
    expect(result).toEqual({ tools: [TOOL_DEFINITION] });
  });

  it('registers the tools/call handler delegating to handleToolCall with the config', async () => {
    const config = { defaultTimeoutMs: 4242 };
    await startServer(config);
    const handler = sdk.setRequestHandler.mock.calls.find(
      (c) => c[0] === CallToolRequestSchema,
    )?.[1];
    expect(handler).toBeTypeOf('function');
    const request = { params: { name: 'audit_code_resilience', arguments: {} } };
    await (handler as (req: unknown) => Promise<unknown>)(request);
    expect(handleToolCall).toHaveBeenCalledWith(request, config);
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
});
