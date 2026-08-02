import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';

/**
 * End-to-end CLI test that spawns the built `chaos-mcp` binary with the
 * `--help` flag and asserts:
 *   - exit code 0
 *   - stdout references the synced `chaos-mcp v${version}` banner
 *   - stdout mentions both `--help` and `--version` flag names (a
 *     structural sanity check that HELP_TEXT still documents itself)
 *   - stderr is empty (no banner noise on --help)
 *   - the process exits on its own (catches regressions where arg-parsing
 *     moves AFTER the MCP server lifecycle — `--help` would still print,
 *     but the stdio server would hold the event loop open and the spawn
 *     would never close)
 *
 * Mirrors cli-version.test.ts structurally (`close`-drained Promise,
 * stderr-quiet, hang guard). Validates different content.
 *
 * Requires `npm run build` to have produced `./build/index.js`.
 */

/** SIGKILL deadline for the spawn; also the hang-guard ceiling asserted below. */
const SPAWN_TIMEOUT_MS = 5000;

describe('CLI --help flag', () => {
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

  it('prints help on stdout with synced version, exits 0, quiet stderr, without hanging', async () => {
    const start = performance.now();
    const result = await new Promise<{
      stdout: string;
      stderr: string;
      code: number | null;
      elapsedMs: number;
    }>((resolve, reject) => {
      const child = spawn('node', [entry, '--help'], {
        // stdin is intentionally 'ignore' so the binary cannot hang
        // waiting for input; --help prints + exits unconditionally.
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
            `chaos-mcp --help timed out after ${SPAWN_TIMEOUT_MS}ms; stdout="${stdout.trim()}", stderr="${stderr.trim()}"`,
          ),
        );
      }, SPAWN_TIMEOUT_MS);

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
    // Help text must reference the synced version — catches HELP_TEXT
    // drift relative to APP_VERSION (regression: edited HELP_TEXT but
    // forgot to update APP_VERSION, or vice versa).
    expect(result.stdout).toContain(`chaos-mcp v${expectedVersion}`);
    // Structural sanity: help text still documents its own flag names.
    expect(result.stdout).toContain('--help');
    expect(result.stdout).toContain('--version');
    // --help path should be silent on stderr; non-empty stderr would
    // indicate an accidental console.error or a deprecation trace
    // slipping through. `.trim()` absorbs trailing whitespace but
    // substantive stderr content (e.g. real deprecation warnings)
    // still trips the assertion by design — fail-loud on Node bumps.
    expect(result.stderr.trim()).toBe('');
    // --help must short-circuit BEFORE the MCP server lifecycle. The
    // regression this guards against is a HANG (the stdio server holds the
    // event loop, so the spawn never closes), which the SIGKILL above
    // already catches — this bound just states it as an assertion.
    //
    // It is deliberately NOT a performance benchmark. A 2s ceiling used to
    // live here and failed on a loaded machine: cold Node startup was
    // measured at 2.1–4.8s while six test processes ran concurrently, which
    // is exactly the condition mutation testing creates. Matches the
    // rationale already recorded in cli-smoke.test.ts.
    expect(result.elapsedMs).toBeLessThan(SPAWN_TIMEOUT_MS);
  });
});
