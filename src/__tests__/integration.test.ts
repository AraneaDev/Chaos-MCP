import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

/**
 * End-to-end integration test that:
 * 1. Starts the chaos-mcp MCP server as a child process
 * 2. Sends an MCP `tools/list` request via stdin
 * 3. Parses the JSON-RPC response and verifies the tool schema
 *
 * Does NOT run actual mutation testing (requires Stryker/mutmut installed
 * in a target project) — validates the server lifecycle and protocol compliance.
 */

// JSON-RPC helpers
function buildRequest(id: number, method: string, params?: Record<string, unknown>): string {
  return (
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    }) + '\n'
  );
}

/** Start the chaos-mcp server and wait for it to be ready. */
function startServer(): ChildProcess {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const entry = join(__dirname, '..', '..', 'build', 'index.js');

  if (!existsSync(entry)) {
    throw new Error(
      `Build output not found at ${entry}. Run "npm run build" before running integration tests.`,
    );
  }

  const child = spawn('node', [entry], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'test' },
  });

  return child;
}

/** Read one JSON-RPC response line from stdout. */
function readResponse(child: ChildProcess, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for server response'));
    }, timeoutMs);

    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      // JSON-RPC messages are newline-delimited
      const lines = buf.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          clearTimeout(timer);
          child.stdout?.removeListener('data', onData);
          resolve(parsed);
          return;
        } catch {
          // Incomplete — wait for more data
          break;
        }
      }
    };

    child.stdout?.on('data', onData);
  });
}

describe('chaos-mcp integration', () => {
  let server: ChildProcess;

  beforeAll(() => {
    server = startServer();
  });

  afterAll(() => {
    if (server && !server.killed) {
      server.kill('SIGTERM');
    }
  });

  it('responds to initialize request', async () => {
    const initReq = buildRequest(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });

    server.stdin?.write(initReq);

    // Send initialized notification (required by MCP)
    const initializedNotif = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    server.stdin?.write(initializedNotif + '\n');

    const response = await readResponse(server);

    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();
    expect(response.result?.serverInfo?.name).toBe('chaos-mcp');
    expect(response.result?.capabilities?.tools).toBeDefined();
  });

  it('lists available tools via tools/list', async () => {
    const toolsReq = buildRequest(2, 'tools/list');
    server.stdin?.write(toolsReq);

    const response = await readResponse(server);

    expect(response.id).toBe(2);
    expect(response.result?.tools).toBeDefined();
    expect(Array.isArray(response.result?.tools)).toBe(true);
    expect(response.result?.tools).toHaveLength(3);

    const tools = response.result?.tools as Record<string, unknown>[];
    const toolNames = tools.map((t) => t.name);
    expect(toolNames).toContain('audit_code_resilience');
    expect(toolNames).toContain('triage_test_coverage');
    expect(toolNames).toContain('estimate_audit');

    const tool = tools.find((t) => t.name === 'audit_code_resilience');
    expect(tool).toBeDefined();
    expect(tool?.name).toBe('audit_code_resilience');
    expect(tool?.description).toContain('mutation testing');
    expect(tool?.inputSchema?.properties?.filePath).toBeDefined();
    expect(tool?.inputSchema?.properties?.timeoutMs).toBeDefined();
    expect(tool?.inputSchema?.properties?.lineScope).toBeDefined();
    expect(tool?.inputSchema?.properties?.mutatorAllowlist).toBeDefined();
    expect(tool?.inputSchema?.properties?.mutatorDenylist).toBeDefined();
    expect(tool?.inputSchema?.properties?.concurrency).toBeDefined();
    expect(tool?.inputSchema?.properties?.dryRun).toBeDefined();
    expect(tool?.inputSchema?.properties?.outputFormat).toBeDefined();
    expect(tool?.inputSchema?.properties?.incremental).toBeDefined();
    expect(tool?.inputSchema?.properties?.ignorePatterns).toBeDefined();
    expect(tool?.inputSchema?.additionalProperties).toBe(false);
    expect(tool?.inputSchema?.required).toContain('filePath');
  });

  it('returns error for unsupported file extension (audit_code_resilience)', async () => {
    const callReq = buildRequest(3, 'tools/call', {
      name: 'audit_code_resilience',
      arguments: { filePath: 'main.rb' },
    });
    server.stdin?.write(callReq);

    const response = await readResponse(server);

    expect(response.id).toBe(3);
    expect(response.result?.isError).toBe(true);
    const textContent = response.result?.content?.[0]?.text as string;
    expect(textContent).toContain('Extension unsupported');
    expect(textContent).toContain('main.rb');
  });

  it('accepts dryRun, outputFormat, incremental, and ignorePatterns in tools/call', async () => {
    // Send a tools/call with all new schema options. The server should
    // accept them (not reject as unknown args) and attempt to process.
    // Since no real test suite exists, we expect either an error response
    // (sandbox/engine failure) or a successful run — but NOT a schema
    // validation rejection.
    const callReq = buildRequest(10, 'tools/call', {
      name: 'audit_code_resilience',
      arguments: {
        filePath: 'src/utils/math.ts',
        dryRun: true,
        outputFormat: 'text',
        incremental: true,
        ignorePatterns: ['.test.ts', 'fixtures/'],
        concurrency: 2,
      },
    });
    server.stdin?.write(callReq);

    const response = await readResponse(server, 10000);

    expect(response.id).toBe(10);
    // We should get a result (either success or error), not a JSON-RPC error
    // about unknown parameters. The server should accept all schema fields.
    expect(response.result).toBeDefined();
    // It will likely be an isError=true response since there's no real
    // Stryker setup, but the key assertion is that the server accepted
    // the request and tried to process it (didn't reject at the schema level).
    const textContent = response.result?.content?.[0]?.text as string;
    expect(textContent).toBeDefined();
    // Should NOT contain a schema validation error mentioning unknown fields
    expect(textContent).not.toMatch(/unknown.*parameter|unexpected.*argument/i);
  });

  it('returns sandbox provisioning error for nonexistent file', async () => {
    const callReq = buildRequest(4, 'tools/call', {
      name: 'audit_code_resilience',
      arguments: { filePath: 'nonexistent/file.ts' },
    });
    server.stdin?.write(callReq);

    const response = await readResponse(server);

    expect(response.id).toBe(4);
    expect(response.result?.isError).toBe(true);
    const textContent = response.result?.content?.[0]?.text as string;
    expect(textContent).toContain('Chaos Engine Halted');
  });

  it('handles unknown tool name gracefully', async () => {
    const callReq = buildRequest(5, 'tools/call', {
      name: 'nonexistent_tool',
      arguments: {},
    });
    server.stdin?.write(callReq);

    const response = await readResponse(server);

    expect(response.id).toBe(5);
    // MCP wraps method-not-found errors in the result
    expect(response.error || response.result?.isError).toBeTruthy();
  });
});
