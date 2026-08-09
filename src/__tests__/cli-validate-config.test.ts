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

  it('exits 0 when config has warnings but --strict is not set', async () => {
    // Warnings are advisory: they name keys that will be ignored, not a broken
    // config. Failing on them without --strict contradicted the documented
    // meaning of --strict and broke any CI job that used this flag as a lint.
    const { code, stderr } = await spawnValidate([
      '--validate-config',
      '--config',
      warningConfigPath,
    ]);
    expect(code).toBe(0);
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

  it('exits 1 when an EXPLICITLY named config file is missing', async () => {
    const { code } = await spawnValidate([
      '--validate-config',
      '--config',
      '/tmp/nonexistent-chaos-config.json',
    ]);
    // The operator named this path themselves, so a typo in it must not read
    // as success. (A missing config at the DEFAULT path is exit 0 — see below.)
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
      expect(stderr).toContain('Config error:');
      expect(stderr).toContain('Failed to parse config file');
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
    // Unreadable (EISDIR on read), which is a hard error regardless of --strict.
    expect(code).toBe(1);
    expect(stderr).toContain('Config error:');
  });

  it('warns and exits 0 for a mutatorAllowlist, then exits 2 with --strict (Task 14 / M1)', async () => {
    // mutatorAllowlist is accepted by the parser and stored on StrykerConfig,
    // but buildRunOptions deliberately never sources it (StrykerJS v9 cannot
    // express an allowlist), so it silently does nothing. --validate-config
    // must say so instead of reporting a clean config.
    const allowlistConfigPath = join(tmpdir(), `chaos-mcp-allowlist-${randomUUID()}.json`);
    writeFileSync(
      allowlistConfigPath,
      JSON.stringify({ stryker: { mutatorAllowlist: ['ConditionalExpression'] } }),
    );
    try {
      const plain = await spawnValidate(['--validate-config', '--config', allowlistConfigPath]);
      expect(plain.code).toBe(0);
      expect(plain.stderr).toContain('stryker.mutatorAllowlist');
      expect(plain.stderr).toContain('NOT SUPPORTED');

      const strict = await spawnValidate([
        '--validate-config',
        '--strict',
        '--config',
        allowlistConfigPath,
      ]);
      expect(strict.code).toBe(2);
    } finally {
      try {
        unlinkSync(allowlistConfigPath);
      } catch {
        /* best-effort */
      }
    }
  });

  it('exits 0 when --config has no value (falls back to the default path)', async () => {
    // When --config is the last argument, the value is undefined and
    // loadConfig/validateConfig use the default path (cwd/chaos-mcp.config.json).
    // To guarantee this file doesn't exist, we chdir into a fresh temp directory
    // before running the command, then restore the original cwd.
    const tempDir = mkdtempSync(join(tmpdir(), 'chaos-mcp-noconfig-'));
    const originalCwd = process.cwd();
    try {
      process.chdir(tempDir);
      const { code, stderr } = await spawnValidate(['--validate-config', '--config']);
      // No file at the DEFAULT path just means "running on defaults" — the
      // flag was dropped with a warning, so no explicit path was named.
      expect(code).toBe(0);
      expect(stderr).toContain('Config not found');
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
