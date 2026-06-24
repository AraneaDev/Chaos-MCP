import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';

/**
 * End-to-end CLI test that spawns the built `chaos-mcp` binary with the
 * `--version` flag and asserts:
 *   - exit code 0
 *   - stdout contains the synced `chaos-mcp v${version}` string
 *   - stderr is empty (no banner / warning noise on --version)
 *   - wall-clock time < 2s (catches regressions where arg-parsing
 *     moves AFTER the MCP server lifecycle — `--version` would then
 *     still print + exit, but only AFTER a stdio server started)
 *
 * Complements `version-sync.test.ts` (constant canary) by exercising
 * the actual CLI surface — a future regression in postbuild shebang
 * restoration, `bin` wiring, or the `--version` code path itself is
 * caught here.
 *
 * Requires `npm run build` to have produced `./build/index.js`.
 */

describe('CLI --version flag', () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const entry = join(__dirname, '..', '..', 'build', 'index.js');
  let expectedVersion: string;

  beforeAll(() => {
    if (!existsSync(entry)) {
      throw new Error(
        `Build output not found at ${entry}. Run "npm run build" before running CLI tests.`,
      );
    }
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8')) as {
      version: string;
    };
    expectedVersion = pkg.version;
  });

  it('prints the synced version on stdout, exits 0, quiet stderr, <2s wall-clock', async () => {
    const start = performance.now();
    const result = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
      elapsedMs: number;
    }>((resolve, reject) => {
      const child = spawn('node', [entry, '--version'], {
        // stdin is intentionally 'ignore' so the binary cannot hang
        // waiting for input; --version prints + exits unconditionally.
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(
          new Error(
            `chaos-mcp --version timed out after 5s; stdout="${stdout.trim()}", stderr="${stderr.trim()}"`,
          ),
        );
      }, 5000);

      // Use 'close' instead of 'exit': 'close' fires after stdio
      // streams have closed (all output read by the parent); 'exit'
      // can fire before stdout/stderr are fully drained.
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          stdout,
          stderr,
          code,
          elapsedMs: performance.now() - start,
        });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`chaos-mcp v${expectedVersion}`);
    // --version path should be silent on stderr; non-empty stderr
    // would indicate an accidental console.error. `.trim()` absorbs
    // trailing whitespace from stdio-closure stitching; substantive
    // stderr content (e.g. an actual `DeprecationWarning: X` line)
    // will still trip the assertion by design — fail-loud on Node
    // version bumps rather than silently flake.
    expect(result.stderr.trim()).toBe('');
    // --version must short-circuit BEFORE the MCP server lifecycle.
    // Real CLI startup is ~50–300ms; 2s is a generous ceiling that
    // still catches the regression where --version was moved past
    // server-start.
    expect(result.elapsedMs).toBeLessThan(2000);
  });
});
