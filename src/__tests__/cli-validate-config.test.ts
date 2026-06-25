import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, writeFileSync, unlinkSync, mkdtempSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

/**
 * End-to-end CLI test for the --validate-config flag.
 *
 * Spawns the built `chaos-mcp` binary against temp config files with known
 * issues and verifies exit codes:
 *   - Valid config → exit 0
 *   - Config with warnings → exit 1
 *   - Config with warnings + --strict → exit 2
 *
 * Requires `npm run build` to have produced `./build/index.js`.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENTRY = join(__dirname, '..', '..', 'build', 'index.js');

/** Spawn the binary with flags and collect exit code, stderr, and elapsed time. */
function spawnValidate(flags: string[]): Promise<{
  code: number | null;
  stderr: string;
  elapsedMs: number;
}> {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn('node', [ENTRY, ...flags], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    // Drain stdout
    child.stdout?.resume();

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`chaos-mcp ${flags.join(' ')} timed out after 5s`));
    }, 5000);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stderr, elapsedMs: performance.now() - start });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('CLI --validate-config flag', () => {
  let validConfigPath: string;
  let warningConfigPath: string;

  beforeAll(() => {
    if (!existsSync(ENTRY)) {
      throw new Error(
        `Build output not found at ${ENTRY}. Run "npm run build" before running CLI tests.`,
      );
    }

    // Create a valid config temp file
    validConfigPath = join(tmpdir(), `chaos-mcp-valid-${randomUUID()}.json`);
    writeFileSync(
      validConfigPath,
      JSON.stringify({ defaultTimeoutMs: 120000, stryker: { concurrency: 4 } }),
    );

    // Create a config with warnings (unknown keys, empty engine section)
    warningConfigPath = join(tmpdir(), `chaos-mcp-warn-${randomUUID()}.json`);
    writeFileSync(
      warningConfigPath,
      JSON.stringify({
        defaultTimeoutMs: 300000,
        bogusKey: 'will-be-ignored',
        stryker: { timeoutMs: 0, unknownStrykerKey: true },
      }),
    );
  });

  afterAll(() => {
    try {
      unlinkSync(validConfigPath);
    } catch {
      /* best-effort */
    }
    try {
      unlinkSync(warningConfigPath);
    } catch {
      /* best-effort */
    }
  });

  it('exits 0 for a valid config', async () => {
    const { code, stderr } = await spawnValidate([
      '--validate-config',
      '--config',
      validConfigPath,
    ]);
    expect(code).toBe(0);
    expect(stderr).toContain('no warnings');
  });

  it('exits 1 when config has warnings', async () => {
    const { code, stderr } = await spawnValidate([
      '--validate-config',
      '--config',
      warningConfigPath,
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain('bogusKey');
    expect(stderr).toContain('unknownStrykerKey');
  });

  it('exits 2 when --strict is set and config has warnings', async () => {
    const { code, stderr } = await spawnValidate([
      '--validate-config',
      '--strict',
      '--config',
      warningConfigPath,
    ]);
    expect(code).toBe(2);
    expect(stderr).toContain('bogusKey');
  });

  it('exits 0 when --strict is set but config is valid', async () => {
    const { code } = await spawnValidate([
      '--validate-config',
      '--strict',
      '--config',
      validConfigPath,
    ]);
    expect(code).toBe(0);
  });

  it('exits 1 when config file is missing (treated as a warning)', async () => {
    const { code } = await spawnValidate([
      '--validate-config',
      '--config',
      '/tmp/nonexistent-chaos-config.json',
    ]);
    // Missing config is not a fatal error for validate-config
    expect(code).toBe(1);
  });

  // ── Edge case tests ────────────────────────────────────────────────────

  it('exits 1 when config file is malformed JSON', async () => {
    const malformedPath = join(tmpdir(), `chaos-mcp-badjson-${randomUUID()}.json`);
    writeFileSync(malformedPath, '{ not valid json }');
    try {
      const { code, stderr } = await spawnValidate([
        '--validate-config',
        '--config',
        malformedPath,
      ]);
      expect(code).toBe(1);
      expect(stderr).toContain('warnings');
    } finally {
      try {
        unlinkSync(malformedPath);
      } catch {
        /* best-effort */
      }
    }
  });

  it('exits 1 when --config points to a directory instead of a file', async () => {
    const { code, stderr } = await spawnValidate([
      '--validate-config',
      '--config',
      tmpdir(), // /tmp is a directory, not a file
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain('warnings');
  });

  it('exits 1 when --config has no value (falls back to default path)', async () => {
    // When --config is the last argument, the value is undefined and
    // loadConfig/validateConfig use the default path (cwd/chaos-mcp.config.json).
    // To guarantee this file doesn't exist, we chdir into a fresh temp directory
    // before running the command, then restore the original cwd.
    const tempDir = mkdtempSync(join(tmpdir(), 'chaos-mcp-noconfig-'));
    const originalCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const { code, stderr } = await spawnValidate(['--validate-config', '--config']);
      // Missing default config file is a warning → exit 1
      expect(code).toBe(1);
      expect(stderr).toContain('warnings');
    } finally {
      process.chdir(originalCwd);
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  });
});
