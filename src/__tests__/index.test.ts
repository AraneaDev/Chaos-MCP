import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// Partial mock: the real implementations still run (the shutdown path must
// genuinely clean sandboxes up), but wrapping them makes the handoff assertable
// — the sandbox module exposes no getter for its signal-exit flag.
vi.mock('../utils/sandbox/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sandbox/registry.js')>();
  return {
    ...actual,
    setSandboxSignalExit: vi.fn(actual.setSandboxSignalExit),
    cleanupAllSandboxes: vi.fn(actual.cleanupAllSandboxes),
  };
});

import { startServer, APP_VERSION, installShutdownHandlers } from '../index.js';
import { setSandboxSignalExit, cleanupAllSandboxes } from '../utils/sandbox/registry.js';

const mockSetSandboxSignalExit = vi.mocked(setSandboxSignalExit);
const mockCleanupAllSandboxes = vi.mocked(cleanupAllSandboxes);

/**
 * These tests drive the server in-process, so it must not claim the worker's
 * signal handlers: real handlers left armed here fire when vitest tears the
 * worker down, running a shutdown (and a process.exit) after the environment
 * is gone. A real server takes the default.
 */
const NO_SIGNAL_HANDLERS = { installShutdownHandlers: false } as const;
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

  it('installs signal handlers by default, and skips them only when told to', async () => {
    // Every other case here passes NO_SIGNAL_HANDLERS so the vitest worker keeps
    // its own handlers — which means nothing exercises the DEFAULT, the one a
    // real server takes. Calling with no options object at all also covers the
    // optional chain: `options.installShutdownHandlers` on undefined throws.
    const seen: string[] = [];
    const onSpy = vi.spyOn(process, 'on').mockImplementation(((event: string) => {
      seen.push(event);
      return process;
    }) as never);
    try {
      await startServer();
      expect(seen).toContain('SIGTERM');
      expect(seen).toContain('SIGINT');

      seen.length = 0;
      await startServer(undefined, { installShutdownHandlers: false });
      expect(seen).not.toContain('SIGTERM');
    } finally {
      onSpy.mockRestore();
    }
  });

  it('constructs the MCP server with the chaos-mcp name and synced version', async () => {
    await startServer(undefined, NO_SIGNAL_HANDLERS);
    expect(sdk.serverCtor).toHaveBeenCalledWith(
      { name: 'chaos-mcp', version: APP_VERSION },
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );
  });

  it('registers the tools/list handler returning all three tool definitions', async () => {
    await startServer(undefined, NO_SIGNAL_HANDLERS);
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
    await startServer(config, NO_SIGNAL_HANDLERS);
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
    await startServer(config, NO_SIGNAL_HANDLERS);
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
    await startServer(config, NO_SIGNAL_HANDLERS);
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
    await startServer(undefined, NO_SIGNAL_HANDLERS);
    const handler = sdk.setRequestHandler.mock.calls.find(
      (c) => c[0] === ListResourcesRequestSchema,
    )?.[1];
    expect(handler).toBeTypeOf('function');
    const result = await (handler as () => Promise<unknown>)();
    expect(result).toEqual({ resources: listResources() });
  });

  it('registers the resources/read handler returning contents for a known URI', async () => {
    await startServer(undefined, NO_SIGNAL_HANDLERS);
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
    await startServer(undefined, NO_SIGNAL_HANDLERS);
    const handler = sdk.setRequestHandler.mock.calls.find(
      (c) => c[0] === ListPromptsRequestSchema,
    )?.[1];
    expect(handler).toBeTypeOf('function');
    const result = await (handler as () => Promise<unknown>)();
    expect(result).toEqual({ prompts: listPrompts() });
  });

  it('registers the prompts/get handler delegating to getPrompt', async () => {
    await startServer(undefined, NO_SIGNAL_HANDLERS);
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
    await startServer(undefined, NO_SIGNAL_HANDLERS);
    expect(sdk.transportCtor).toHaveBeenCalledTimes(1);
    expect(sdk.connect).toHaveBeenCalledTimes(1);
  });
});

describe('direct-run guard (isDirectRun)', () => {
  const origArgv1 = process.argv[1];
  const sourceEntry = realpathSync(fileURLToPath(new URL('../index.ts', import.meta.url)));
  const tempDirs: string[] = [];

  async function loadIndexWith(argv1: string): Promise<typeof import('../cli.js').runCli> {
    vi.resetModules();
    process.argv[1] = argv1;
    const { runCli } = await import('../cli.js');
    vi.mocked(runCli).mockClear();
    await import('../index.js');
    return runCli;
  }

  afterEach(() => {
    process.argv[1] = origArgv1;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('invokes runCli with the app version and server factory when run directly', async () => {
    const runCli = await loadIndexWith(sourceEntry);
    expect(vi.mocked(runCli)).toHaveBeenCalledTimes(1);
    // Pin the injected dependency object (the `{ appVersion, startServer }` literal).
    expect(vi.mocked(runCli)).toHaveBeenCalledWith(
      expect.objectContaining({ appVersion: APP_VERSION, startServer: expect.any(Function) }),
    );
  });

  it('invokes runCli through a symlink that resolves to the module', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chaos-index-'));
    tempDirs.push(dir);
    const link = join(dir, 'chaos-mcp');
    symlinkSync(sourceEntry, link);
    const runCli = await loadIndexWith(link);
    expect(vi.mocked(runCli)).toHaveBeenCalledTimes(1);
  });

  it('does not invoke runCli for a nonexistent path with a matching basename', async () => {
    const runCli = await loadIndexWith('/some/path/index.js');
    expect(vi.mocked(runCli)).not.toHaveBeenCalled();
  });

  it('does not invoke runCli for a different existing index.js', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chaos-index-'));
    tempDirs.push(dir);
    const unrelated = join(dir, 'index.js');
    writeFileSync(unrelated, '');
    const indirect = await loadIndexWith(unrelated);
    expect(vi.mocked(indirect)).not.toHaveBeenCalled();
  });
});

/**
 * The sandbox module registers signal handlers so temp directories are never
 * leaked, and those used to call `process.exit` themselves — which tore the
 * stdio transport down mid-write and dropped whatever JSON-RPC response was in
 * flight, because nothing got a chance to close it. Shutdown belongs to
 * whoever owns the process, so the server claims it: close the transport, then
 * remove the sandboxes, then exit.
 */
describe('installShutdownHandlers', () => {
  const signals = ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM'] as const;
  let registered: Partial<Record<string, () => void>>;
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(() => {
    registered = {};
    vi.spyOn(process, 'on').mockImplementation(((event: string, handler: () => void) => {
      if ((signals as readonly string[]).includes(event)) registered[event] = handler;
      return process;
    }) as never);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Hand signal-driven exit back to the sandbox module for other tests.
    setSandboxSignalExit(true);
  });

  it('registers a handler for every termination signal', () => {
    installShutdownHandlers({ close: () => Promise.resolve() });
    for (const signal of signals) expect(registered[signal]).toBeTypeOf('function');
  });

  it('closes the transport before removing sandboxes and exiting', async () => {
    const order: string[] = [];
    const close = vi.fn(() => {
      order.push('close');
      return Promise.resolve();
    });
    installShutdownHandlers({ close });
    registered.SIGTERM?.();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());
    expect(order).toEqual(['close']);
    // 128 + 15 for SIGTERM, so a signal kill is not reported as a clean exit.
    expect(exitSpy).toHaveBeenCalledWith(143);
  });

  it('exits with the conventional code for each signal', async () => {
    installShutdownHandlers({ close: () => Promise.resolve() });
    for (const [signal, code] of [
      ['SIGHUP', 129],
      ['SIGINT', 130],
      ['SIGQUIT', 131],
    ] as const) {
      exitSpy.mockClear();
      // Re-register so the once-only `shuttingDown` latch does not swallow it.
      installShutdownHandlers({ close: () => Promise.resolve() });
      registered[signal]?.();
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(code));
    }
  });

  it('still exits when the transport close rejects', async () => {
    installShutdownHandlers({ close: () => Promise.reject(new Error('socket gone')) });
    registered.SIGTERM?.();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(143));
  });

  it('takes signal-driven exit away from the sandbox module', async () => {
    // The sandbox module registers its own signal handlers and, by default,
    // calls process.exit from them. Left enabled, it races this handler to the
    // exit and the transport is torn down mid-write, losing any in-flight
    // JSON-RPC response — the exact bug this handoff exists to prevent.
    mockSetSandboxSignalExit.mockClear();
    installShutdownHandlers({ close: () => Promise.resolve() });
    expect(mockSetSandboxSignalExit).toHaveBeenCalledWith(false);
  });

  it('removes sandboxes on the way out', async () => {
    mockCleanupAllSandboxes.mockClear();
    installShutdownHandlers({ close: () => Promise.resolve() });
    registered.SIGTERM?.();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());
    expect(mockCleanupAllSandboxes).toHaveBeenCalled();
  });

  it('exits on the failsafe timer when close() never settles', async () => {
    // A wedged transport must not keep the process alive forever. Nothing else
    // here can see the failsafe: every other case resolves or rejects close(),
    // so the timer is always cleared before it can fire.
    vi.useFakeTimers();
    try {
      installShutdownHandlers({ close: () => new Promise<void>(() => undefined) });
      registered.SIGTERM?.();
      expect(exitSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2_000);

      expect(exitSpy).toHaveBeenCalledWith(143);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a second signal so a double Ctrl-C cannot re-enter shutdown', async () => {
    const close = vi.fn(() => Promise.resolve());
    installShutdownHandlers({ close });
    registered.SIGINT?.();
    registered.SIGINT?.();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());
    expect(close).toHaveBeenCalledTimes(1);
  });
});
