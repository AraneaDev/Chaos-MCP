import { describe, it, expect } from 'vitest';
import { runShell, ExecFailureError } from '../utils/exec.js';

/**
 * Run a child process and return the captured ExecFailureError. The promise
 * must reject; if it resolves the helper throws so the failing test is loud.
 */
async function expectRejection(
  fn: () => Promise<unknown>,
): Promise<ExecFailureError> {
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
    const caught = await expectRejection(() =>
      runShell('node', ['-e', 'process.exit(42)']),
    );
    expect(caught).toBeDefined();
    expect(caught.exit).toBe(42);
    expect(caught.signal).toBeNull();
  });

  it('captures exit code 1 from a failed child', async () => {
    const caught = await expectRejection(() =>
      runShell('node', ['-e', 'process.exit(1)']),
    );
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

  it('classifies a configured-timeout end as code=TIMEOUT (Live-audit L3)', async () => {
    // Drive the production code path: runShell with a short timeoutMs and a
    // long-running child. execFile internally calls child.kill(), so the
    // resulting error has killed=true and the wrapper classifies it as TIMEOUT.
    //
    // Note: the L3 fix has a second arm (external kills with killed=false
    // must NOT be classified as TIMEOUT). End-to-end coverage of that arm
    // requires mocking child_process.execFile to deliver a synthetic
    // (signal=SIGTERM, killed=false) error; deferred until we have reason
    // to invest in the mock harness.
    const caught = await expectRejection(() =>
      runShell('node', ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 200 }),
    );
    expect(caught.code).toBe('TIMEOUT');
    expect(caught.exit).toBeNull();
  });
});
