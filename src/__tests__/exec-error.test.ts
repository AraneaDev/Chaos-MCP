import { describe, it, expect } from 'vitest';
import { runShell, runShellCommand, ExecFailureError } from '../utils/exec.js';

/**
 * Run a child process and return the captured ExecFailureError. The promise
 * must reject; if it resolves the helper throws so the failing test is loud.
 */
async function expectRejection(fn: () => Promise<unknown>): Promise<ExecFailureError> {
  try {
    await fn();
  } catch (err: unknown) {
    if (err instanceof ExecFailureError) return err;
    throw err;
  }
  throw new Error('expected runShell() to reject, but it resolved');
}

/**
 * Regression test for audit finding C1: {@link runShell} must report the
 * numeric exit code of a non-zero child process via the `exit` field of the
 * {@link ExecFailureError}. Prior to the fix, the helper read
 * `err.status` (which is undefined on Node's spawn error object), causing
 * `error.exit` to ALWAYS be `null` and silently breaking every engine's
 * exit-code branch (Stryker exit-1 detection, baseline-failure vs survivor
 * distinction in Mutmut, etc.).
 */
describe('runShell error propagation (C1 regression)', () => {
  it('captures numeric exit code 42 from a child process', async () => {
    const caught = await expectRejection(() => runShell('node', ['-e', 'process.exit(42)']));
    expect(caught).toBeDefined();
    expect(caught.exit).toBe(42);
    expect(caught.signal).toBeNull();
  });

  it('captures exit code 1 from a failed child', async () => {
    const caught = await expectRejection(() => runShell('node', ['-e', 'process.exit(1)']));
    expect(caught).toBeDefined();
    expect(caught.exit).toBe(1);
  });

  it('captures exit code 0 path (success does not throw)', async () => {
    const result = await runShell('node', ['-e', 'process.exit(0)']);
    expect(result.exit).toBe(0);
  });

  it('returns null exit + ENOENT code for missing binaries', async () => {
    const caught = await expectRejection(() =>
      runShell('definitely-not-a-real-binary-xyz-12345', []),
    );
    expect(caught).toBeDefined();
    expect(caught.exit).toBeNull();
    expect(caught.code).toBe('ENOENT');
  });

  it('captures code as string when err.code is a signal name string (not number)', async () => {
    // When execFile returns err.code as a string (signal name, e.g. 'SIGKILL'),
    // the exitCode gate `typeof errnoError.code === 'number'` returns false,
    // exit stays null, and the error.code field is derived from result.exit ?? 'SIGNAL'.
    // This exercises the branch where code is a non-numeric signal string.
    const caught = await expectRejection(() =>
      runShell('node', ['-e', 'process.kill(process.pid, "SIGKILL")']),
    );
    expect(caught).toBeDefined();
    // The child is killed by SIGKILL — exit is null (no numeric code),
    // signal is 'SIGKILL' (or null if the signal was delivered before execFile recorded it).
    // The important thing is that code is a string like 'SIGNAL', not null or undefined.
    expect(typeof caught.code).toBe('string');
  });

  it('sets the ExecFailureError name to "ExecFailureError"', async () => {
    // Kills the StringLiteral mutant on `this.name = 'ExecFailureError'`.
    const caught = await expectRejection(() => runShell('node', ['-e', 'process.exit(3)']));
    expect(caught.name).toBe('ExecFailureError');
  });
});

/**
 * Real (unmocked) subprocess tests that pin down the child_process option
 * object — `encoding: 'utf-8'` and the `maxBuffer` arithmetic. These cannot be
 * exercised through the mocked-callback suites because the mock never honours
 * the options; only a real spawn does. Chaos-MCP flagged these as surviving.
 */
describe('runShell / runShellCommand real I/O options', () => {
  it('runShell decodes stdout as a UTF-8 string (not a Buffer)', async () => {
    const result = await runShell('node', ['-e', 'process.stdout.write("hello")']);
    // encoding '' (mutant) would yield a Buffer, failing the strict equality.
    expect(result.stdout).toBe('hello');
    expect(typeof result.stdout).toBe('string');
  });

  it('runShellCommand decodes stdout as a UTF-8 string (not a Buffer)', async () => {
    const result = await runShellCommand('node -e "process.stdout.write(\'hi there\')"');
    expect(result.stdout).toBe('hi there');
    expect(typeof result.stdout).toBe('string');
  });

  it('runShell accepts output larger than a mutated (shrunken) maxBuffer', async () => {
    // The real cap is 10*1024*1024; any arithmetic mutant collapses it to ~10
    // bytes, which would reject 1 KB of output with a maxBuffer error.
    const result = await runShell('node', ['-e', 'process.stdout.write("x".repeat(1000))']);
    expect(result.exit).toBe(0);
    expect(result.stdout.length).toBe(1000);
  });

  it('runShellCommand accepts output larger than a mutated (shrunken) maxBuffer', async () => {
    const result = await runShellCommand('node -e "process.stdout.write(\'y\'.repeat(1000))"');
    expect(result.exit).toBe(0);
    expect(result.stdout.length).toBe(1000);
  });
});
