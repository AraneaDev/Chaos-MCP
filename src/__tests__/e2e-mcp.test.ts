import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, ChildProcess } from 'child_process';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  existsSync,
  statSync,
  readFileSync,
  readdirSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createHash, Hash } from 'crypto';

const E2E_ENABLED = process.env.E2E === '1';
const it_e2e = E2E_ENABLED ? it : it.skip;

/**
 * Optional end-to-end integration test that:
 * 1. Spawns the actual chaos-mcp MCP server as a child process
 * 2. Creates a tiny test fixture project in a tmpdir
 * 3. Sends a real `audit_code_resilience` MCP request through JSON-RPC
 * 4. Asserts the server responds with a structured result (not a crash)
 * 5. Asserts the host fixture on disk was NOT modified (sandbox isolation)
 * 6. Cleans up
 *
 * Run with `E2E=1 npm test`. Skipped in default CI runs because it spawns
 * a long-running child process and may be slow / depend on system-wide tooling.
 */

// ─── JSON-RPC helpers ────────────────────────────────────────────────────────

function buildRequest(id: number, method: string, params?: Record<string, unknown>): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

function readResponse(child: ChildProcess, timeoutMs = 30000): Promise<Record<string, unknown>> {
  return new Promise((resolveInner, rejectInner) => {
    const timer = setTimeout(() => {
      child.stdout?.removeAllListeners('data');
      rejectInner(new Error(`Timed out waiting for server response after ${timeoutMs}ms`));
    }, timeoutMs);
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          clearTimeout(timer);
          child.stdout?.removeListener('data', onData);
          resolveInner(parsed);
          return;
        } catch {
          // Partial — wait for more data
        }
      }
    };
    child.stdout?.on('data', onData);
  });
}

// ─── Fixture helpers ─────────────────────────────────────────────────────────

interface FixtureContext {
  rootDir: string;
  srcDir: string;
  /** SHA-256 hash of every source/test file in the fixture at creation time */
  preHash: string;
  remove: () => void;
}

/**
 * Build a minimal TypeScript fixture project: package.json + src/calc.ts +
 * src/calc.test.ts, no node_modules, no @stryker-mutator installed.
 * We expect the MCP server to respond with an error ("Stryker not installed")
 * rather than a successful mutation run — the goal of this test is to verify
 * the full pipeline (handler → sandbox → engine → error propagation → cleanup)
 * works end-to-end without crashing, AND that the host fixture is untouched.
 */
function createFixture(): FixtureContext {
  const rootDir = mkdtempSync(join(tmpdir(), 'chaos-mcp-e2e-'));
  const srcDir = join(rootDir, 'src');

  writeFileSync(
    join(rootDir, 'package.json'),
    JSON.stringify(
      {
        name: 'chaos-mcp-e2e-fixture',
        version: '1.0.0',
        scripts: { test: 'vitest run' },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(srcDir, 'calc.ts'),
    `export function add(a: number, b: number): number {
  if (a > 100) return b;     // intentional mutation-survivor trap
  return a + b;
}
`,
  );

  writeFileSync(
    join(srcDir, 'calc.test.ts'),
    `import { describe, it, expect } from 'vitest';
import { add } from './calc.js';

describe('add', () => {
  it('handles small inputs', () => {
    expect(add(1, 2)).toBe(3);
    expect(add(0, 0)).toBe(0);
  });
});
`,
  );

  // Snapshot the fixture content so we can verify isolation afterward
  const preHash = hashFixture(rootDir);

  return {
    rootDir,
    srcDir,
    preHash,
    remove: () => {
      try {
        rmSync(rootDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    },
  };
}

function hashFixture(rootDir: string): string {
  const hasher = createHash('sha256');
  walkForHash(rootDir, hasher);
  return hasher.digest('hex');
}

function walkForHash(dir: string, hasher: Hash): void {    for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkForHash(fullPath, hasher);
    } else {
      hasher.update(entry.name);
      hasher.update(readFileSync(fullPath));
    }
  }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('chaos-mcp end-to-end (E2E)', () => {
  let fixture: FixtureContext;
  let server: ChildProcess;

  beforeAll(() => {
    if (!E2E_ENABLED) return;
    fixture = createFixture();

    const entry = resolve(process.cwd(), 'build', 'index.js');
    if (!existsSync(entry)) {
      throw new Error(`Build output not found at ${entry}. Run "npm run build" first.`);
    }

    server = spawn('node', [entry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: fixture.rootDir,
      env: { ...process.env, NODE_ENV: 'test' },
    });
  });

  afterAll(() => {
    if (!E2E_ENABLED) return;
    if (server && !server.killed) {
      server.kill('SIGTERM');
    }
    if (fixture) fixture.remove();
  });

  it_e2e(
    'runs the full audit_code_resilience pipeline without crashing the server',
    async () => {
      // Initialise the MCP session
      server.stdin?.write(
        buildRequest(1, 'initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'e2e-test', version: '1.0.0' },
        }),
      );
      server.stdin?.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
      );
      const initResponse = await readResponse(server);
      expect(initResponse.id).toBe(1);

      // Send a tools/call against the fixture's file
      server.stdin?.write(
        buildRequest(2, 'tools/call', {
          name: 'audit_code_resilience',
          arguments: { filePath: 'src/calc.ts' },
        }),
      );
      const response = await readResponse(server, 60000);

      // Either a successful mutation report or an informative error —
      // NOT a schema rejection, NOT a server crash.
      expect(response.id).toBe(2);
      expect(response.result).toBeDefined();
      const isError = (response.result as { isError?: boolean }).isError === true;
      const text = ((response.result as { content?: { text?: string }[] }).content ?? [])[0]?.text;

      if (isError) {
        // Expected path: Stryker isn't installed in the fixture's workspace,
        // so the server should return a clear "tool not installed" / "test
        // runner not detected" error. We just refuse crashes/random errors.
        expect(text).toBeDefined();
        const errorText = text ?? '';
        expect(errorText.length).toBeGreaterThan(0);
        // The error must contain something actionable, not a stack-trace dump.
        expect(errorText.length).toBeLessThan(2000);
      } else {
        // Surprising-but-valid path: a real mutation report.
        expect(text).toBeDefined();
        // Should be valid JSON
        const reportText = text ?? '';
        expect(() => JSON.parse(reportText)).not.toThrow();
      }
    },
    90000,
  );

  it_e2e('sandbox isolation: host fixture unchanged after audit_code_resilience', () => {
    // Hash the fixture again and compare. If the mutation engine accidentally
    // wrote to the host tree (was supposed to copy to a tmpdir), the hash differs.
    const postHash = hashFixture(fixture.rootDir);
    expect(postHash).toBe(fixture.preHash);
  });

  it_e2e('sandbox cleanup: no leftover temp directories from chaos-mcp-*', () => {
    // After the run, the OS tmpdir should not contain any chaos-mcp-* sandbox
    // directories — verifies that the cleanup path runs even on errors.
    const entries = readdirSync(tmpdir());
    const leaked = entries.filter(
      (name) => name.startsWith('chaos-mcp-') && statSync(join(tmpdir(), name)).isDirectory(),
    );
    expect(leaked).toEqual([]);
  });
});
