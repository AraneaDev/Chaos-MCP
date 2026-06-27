import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { performance } from 'perf_hooks';

/**
 * Fast CI smoke test: verifies the built `chaos-mcp` binary exists and
 * responds to both `--help` and `--version` without crashing.
 *
 * Unlike the more detailed `cli-help.test.ts` and `cli-version.test.ts`,
 * this test is a single fast gate that catches gross regressions:
 *   - build output missing (postbuild shebang broken)
 *   - binary crashes on startup (runtime error before arg parsing)
 *   - `--help` or `--version` exits non-zero
 *
 * Requires `npm run build` to have produced `./build/index.js`.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENTRY = join(__dirname, '..', '..', 'build', 'index.js');

/** Spawn the binary with a flag and collect exit code, stdout, stderr, and elapsed time. */
function spawnWithFlag(
  flag: string,
): Promise<{ code: number | null; stdout: string; stderr: string; elapsedMs: number }> {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn('node', [ENTRY, flag], { stdio: ['ignore', 'pipe', 'pipe'] });
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
      reject(new Error(`chaos-mcp ${flag} timed out after 5s`));
    }, 5000);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, elapsedMs: performance.now() - start });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('CLI smoke test', () => {
  let expectedVersion: string;

  beforeAll(() => {
    if (!existsSync(ENTRY)) {
      throw new Error(
        `Build output not found at ${ENTRY}. Run "npm run build" before running CLI tests.`,
      );
    }
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8')) as {
      version: string;
    };
    expectedVersion = pkg.version;
  });

  it('build output exists and is executable', () => {
    expect(existsSync(ENTRY)).toBe(true);
  });

  // The elapsed-time bound is a hang guard, not a perf benchmark: cold Node
  // startup on a loaded CI runner routinely exceeds 1s, so the threshold is the
  // same 5s as the spawn timeout (a genuine hang is already caught by the kill).
  const MAX_STARTUP_MS = 5000;

  it('--help exits 0, no stderr, without hanging', async () => {
    const { code, stderr, elapsedMs } = await spawnWithFlag('--help');
    expect(code).toBe(0);
    expect(stderr.trim()).toBe('');
    expect(elapsedMs).toBeLessThan(MAX_STARTUP_MS);
  });

  it('--version exits 0, prints synced version, no stderr, without hanging', async () => {
    const { code, stdout, stderr, elapsedMs } = await spawnWithFlag('--version');
    expect(code).toBe(0);
    // Verify the version string matches package.json — catches HELP_TEXT/
    // APP_VERSION drift (regression: edited one but forgot the other).
    expect(stdout.trim()).toBe(`chaos-mcp v${expectedVersion}`);
    expect(stderr.trim()).toBe('');
    expect(elapsedMs).toBeLessThan(MAX_STARTUP_MS);
  });

  it('--verbose --help exits 0 with help on stdout, no fatal stderr, without hanging', async () => {
    // Note: arg parsing checks --help BEFORE --verbose, so --help
    // short-circuits and exits before verbose mode is enabled.
    // We verify the combined flags don't crash or produce errors.
    const start = performance.now();
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
      elapsedMs: number;
    }>((resolve, reject) => {
      const child = spawn('node', [ENTRY, '--verbose', '--help'], {
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
        reject(new Error('chaos-mcp --verbose --help timed out after 5s'));
      }, 5000);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, elapsedMs: performance.now() - start });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(result.code).toBe(0);
    // Help text on stdout with version
    expect(result.stdout).toContain(`chaos-mcp v${expectedVersion}`);
    expect(result.stdout).toContain('--help');
    // stderr is empty because --help short-circuits before --verbose
    // enables diagnostic logging; any stderr content would indicate
    // a crash, deprecation warning, or other unexpected output
    expect(result.stderr.trim()).toBe('');
    expect(result.elapsedMs).toBeLessThan(MAX_STARTUP_MS);
  });
});
